import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { openFixture } from './support/fixtures'

// q-2: light/dark theme smoke. Proves the token layer actually drives the UI:
// the same representative view (grid + open profile panel + open export
// dialog) is captured under both `prefers-color-scheme` values, and the
// computed background/text colours are asserted to differ.
//
// Determinism: the SCREENSHOTS are artifacts for human review only — pixel
// baselines are environment-dependent (font rasterisation, device scale), so
// gating CI on them would be flaky. The deterministic gate is the
// computed-style comparison below, which is stable across machines. The
// screenshots are attached to the test result (never committed, never
// asserted) so a reviewer can eyeball the two schemes.
//
// Picker path (m1-5 pattern): the init script removes the FSA globals so the
// app takes the hidden-<input type="file"> fallback. Privacy (ADR 0025): the
// fixture is a committed golden file; the picked name is never asserted
// visible.

const CUSTOMERS_FIXTURE = path.join(process.cwd(), 'fixtures', 'parquet', 'customers.parquet')

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
      delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker
    } catch {
      // Non-configurable globals would be a Chromium change; the fallback
      // would then be skipped and the test would fail loudly at the chooser.
    }
  })
})

/** Selectors whose resolved colours are compared across the two schemes. */
const PROBES = {
  body: 'body',
  gridRow: '[data-testid="grid-row"]',
  profilePanel: '[data-testid="profile-panel"]',
  exportDialog: '[data-testid="export-dialog"]',
  // uxv-1/R-09: the floating telemetry Settings surface. It is a real panel
  // over the page, so it must take the scheme's elevated surface too.
  settingsDialog: '[data-testid="settings-dialog"]',
} as const

type ProbeKey = keyof typeof PROBES

/** The computed colours of one probe element. */
interface ProbeStyles {
  readonly background: string
  readonly color: string
}

/**
 * Text elements that sit ON the telemetry Settings surface, measured for the
 * WCAG normal-text floor. These are the dialog's title, its single consent
 * label, and its Close action. (The action is a native `<button>` that paints
 * its own UA control face over the panel, so it is measured against THAT face
 * — the ratio, not the surface identity, is the bar for it.)
 */
const SETTINGS_TEXT_PROBES = [
  '.telemetry-settings-title',
  '.telemetry-settings-option',
  '[data-testid="settings-close"]',
] as const

/** One measured text-on-surface pair. */
interface ContrastReading {
  readonly probe: string
  /** The text colour the browser resolved (`rgb(...)`). */
  readonly color: string
  /** The first opaque ancestor background the text really sits on. */
  readonly background: string
  /** The WCAG 2.x contrast ratio, computed from those two resolved colours. */
  readonly ratio: number
}

/** The AA floor for normal text (WCAG 1.4.3). */
const AA_NORMAL_TEXT = 4.5

/**
 * Measure real contrast in a real browser: read each probe's computed text
 * colour, walk up to the first opaque background, and apply the WCAG relative
 * luminance formula to the RESOLVED values (never to literals repeated in the
 * test). Held inside `page.evaluate` so it runs against the rendered page.
 */
async function measureTextContrast(
  page: Page,
  selectors: readonly string[],
): Promise<ContrastReading[]> {
  return page.evaluate((probeSelectors: readonly string[]) => {
    type Rgba = [number, number, number, number]
    const parse = (value: string): Rgba | null => {
      const match =
        /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i.exec(
          value.trim(),
        )
      if (match === null) return null
      return [
        Number(match[1]),
        Number(match[2]),
        Number(match[3]),
        match[4] === undefined ? 1 : Number(match[4]),
      ]
    }
    const channel = (raw: number): number => {
      const s = raw / 255
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
    }
    const luminance = (rgba: Rgba): number =>
      0.2126 * channel(rgba[0]) + 0.7152 * channel(rgba[1]) + 0.0722 * channel(rgba[2])
    const ratio = (a: Rgba, b: Rgba): number => {
      const la = luminance(a)
      const lb = luminance(b)
      return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
    }
    const opaqueBackground = (element: Element): Rgba => {
      let node: Element | null = element
      while (node !== null) {
        const parsed = parse(getComputedStyle(node).backgroundColor)
        if (parsed !== null && parsed[3] > 0) return parsed
        node = node.parentElement
      }
      const bodyBackground = parse(getComputedStyle(document.body).backgroundColor)
      if (bodyBackground === null) throw new Error('body background is not resolvable')
      return bodyBackground
    }
    return probeSelectors.map((selector) => {
      const element = document.querySelector(selector)
      if (element === null) throw new Error(`contrast probe missing: ${selector}`)
      const style = getComputedStyle(element)
      const color = parse(style.color)
      if (color === null) throw new Error(`probe colour is not resolvable: ${selector}`)
      const background = opaqueBackground(element)
      return {
        probe: selector,
        color: style.color,
        background: `rgb(${String(background[0])}, ${String(background[1])}, ${String(background[2])})`,
        ratio: ratio(color, background),
      }
    })
  }, selectors)
}

/**
 * Resolve a colour token to the exact colour the browser paints, by letting
 * the browser itself resolve it on a throwaway probe element (`#rrggbb` tokens
 * normalise to `rgb(...)`, so the comparison is literal-free).
 */
async function resolveToken(page: Page, token: string): Promise<string> {
  return page.evaluate((cssCustomProperty: string) => {
    const probe = document.createElement('span')
    probe.style.color = `var(${cssCustomProperty})`
    document.body.append(probe)
    const resolved = getComputedStyle(probe).color
    probe.remove()
    return resolved
  }, token)
}

/** Read the computed background/text colour of every probe. */
async function readStyles(page: Page): Promise<Record<ProbeKey, ProbeStyles>> {
  return page.evaluate((probes: Record<ProbeKey, string>) => {
    const out = {} as Record<ProbeKey, ProbeStyles>
    for (const key of Object.keys(probes) as ProbeKey[]) {
      const element = document.querySelector(probes[key])
      if (element === null) throw new Error(`theme probe missing: ${probes[key]}`)
      const style = getComputedStyle(element)
      out[key] = { background: style.backgroundColor, color: style.color }
    }
    return out
  }, PROBES)
}

/** Open the representative view: grid ready, profile panel populated, export dialog open. */
async function openRepresentativeView(page: Page): Promise<void> {
  await openFixture(page, CUSTOMERS_FIXTURE, { assertFileNameHidden: true })
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')

  // Profile panel (q-15: the shared open-section step expanded it); populate it.
  await expect(page.getByTestId('profile-toggle')).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByTestId('profile-panel')).toBeVisible()
  await page.getByTestId('profile-run').click()
  await expect(page.getByTestId('profile-columns')).toBeVisible({ timeout: 60_000 })

  // Export dialog open (the modal surface, q-3).
  await page.getByTestId('export-open').click()
  await expect(page.getByTestId('export-dialog')).toBeVisible()

  // uxv-1/R-09: the telemetry Settings dialog open (the floating surface the
  // token repair is about), so the scheme comparison below covers it too.
  await page.getByTestId('settings-toggle').click()
  await expect(page.getByTestId('settings-dialog')).toBeVisible()
}

/** Open Settings on the idle or ready app and wait for its real dialog. */
async function openSettingsDialog(page: Page): Promise<void> {
  await page.getByTestId('settings-toggle').click()
  const dialog = page.getByTestId('settings-dialog')
  await expect(dialog).toBeVisible()
  await expect(page.getByTestId('settings-toggle')).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByTestId('telemetry-toggle')).toBeVisible()
}

test('theme: light and dark schemes resolve distinct token values', async ({ page }, testInfo) => {
  test.setTimeout(180_000)
  await openRepresentativeView(page)

  // Screenshots are LOCAL-ONLY review artifacts, never asserted: pixel
  // baselines are environment-dependent, so they are not a CI gate. Writing
  // them under test-results/ (gitignored) keeps them inspectable after a
  // local run; the attachments below ride along in the report. The
  // deterministic gate is the computed-style comparison that follows.
  const screenshotDir = path.join(process.cwd(), 'test-results', 'q-2-theme')
  if (!process.env['CI']) await mkdir(screenshotDir, { recursive: true })
  const capture = async (scheme: 'light' | 'dark'): Promise<void> => {
    const shot = await page.screenshot({ fullPage: true })
    await testInfo.attach(`theme-${scheme}`, { body: shot, contentType: 'image/png' })
    if (!process.env['CI']) {
      await page.screenshot({ path: path.join(screenshotDir, `${scheme}.png`), fullPage: true })
    }
  }

  await page.emulateMedia({ colorScheme: 'light' })
  const light = await readStyles(page)
  await capture('light')

  await page.emulateMedia({ colorScheme: 'dark' })
  const dark = await readStyles(page)
  await capture('dark')

  // The whole point of the token layer: both schemes resolve, and they differ.
  for (const key of Object.keys(PROBES) as ProbeKey[]) {
    expect(dark[key].background, `${key} background must change with the scheme`).not.toBe(
      light[key].background,
    )
    expect(dark[key].color, `${key} text must change with the scheme`).not.toBe(light[key].color)
  }
  expect(dark.body.color, 'body text must change with the scheme').not.toBe(light.body.color)

  // Value-exact light theme (the original literals) + the dark overrides.
  expect(light.body.background).toBe('rgb(255, 255, 255)') // #fff
  expect(light.body.color).toBe('rgb(26, 26, 26)') // #1a1a1a
  expect(dark.body.background).toBe('rgb(23, 25, 28)') // #17191c
  expect(dark.body.color).toBe('rgb(232, 234, 237)') // #e8eaed
})

// uxv-1 / R-09: the theme-completeness proof for the telemetry surfaces.
//
// The defect this replaces was an UNDEFINED surface token:
// `.telemetry-settings-dialog, .telemetry-disclosure` painted
// `var(--color-surface-panel, #fff)`, and `--color-surface-panel` was declared
// nowhere, so the `#fff` fallback won in BOTH schemes and the panels stayed
// white in dark mode (light body text on white). The assertions below are
// driven and browser-measured: open the real dialog, resolve the real token,
// and require the panel's painted background to BE that token's colour with
// normal text at or above 4.5:1 in both schemes. A hard-coded fallback, an
// undefined token, or a stray colour literal therefore fails here.
test('theme: telemetry Settings surface takes the defined elevated token and clears AA in both schemes', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000)
  await page.goto('/')
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'idle', {
    timeout: 20_000,
  })
  await openSettingsDialog(page)

  const visit = async (scheme: 'light' | 'dark'): Promise<ContrastReading[]> => {
    await page.emulateMedia({ colorScheme: scheme })
    // Non-vacuity: the emulated scheme really reached the page, so the dark
    // pass cannot silently re-measure the light one.
    const prefersDark = await page.evaluate(
      () => window.matchMedia('(prefers-color-scheme: dark)').matches,
    )
    expect(prefersDark, `emulated colour scheme must be ${scheme}`).toBe(scheme === 'dark')

    const surface = await page.getByTestId('settings-dialog').evaluate((element) => {
      return getComputedStyle(element).backgroundColor
    })
    // The surface must be exactly the scheme's elevated token: an undefined
    // token (`--color-surface-panel`) resolved through a `#fff` fallback would
    // not equal the token colour in dark mode.
    const token = await resolveToken(page, '--color-surface-elevated')
    expect(surface, `[${scheme}] Settings dialog surface must be --color-surface-elevated`).toBe(
      token,
    )
    // The token is declared, not inherited from the UA default.
    const declared = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--color-surface-elevated'),
    )
    expect(declared.trim(), `[${scheme}] --color-surface-elevated must be defined`).not.toBe('')

    const readings = await measureTextContrast(page, SETTINGS_TEXT_PROBES)
    const shot = await page.screenshot()
    await testInfo.attach(`telemetry-settings-${scheme}`, {
      body: shot,
      contentType: 'image/png',
    })
    for (const reading of readings) {
      console.log(
        `[theme] settings ${scheme} ${reading.probe}: ${reading.color} on ${reading.background} = ${reading.ratio.toFixed(2)}:1`,
      )
      expect(
        reading.ratio,
        `[${scheme}] ${reading.probe} normal text must clear the ${String(AA_NORMAL_TEXT)}:1 AA floor (measured ${reading.ratio.toFixed(2)}:1)`,
      ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
    }
    return readings
  }

  const light = await visit('light')
  const dark = await visit('dark')

  // Both schemes really were measured, and the surface really is scheme-aware
  // (the fallback defect made both schemes identical white).
  expect(light.length).toBe(SETTINGS_TEXT_PROBES.length)
  expect(dark.length).toBe(SETTINGS_TEXT_PROBES.length)
  expect(light[0]?.background).not.toBe(dark[0]?.background)
})
