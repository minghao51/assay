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
} as const

type ProbeKey = keyof typeof PROBES

interface ProbeStyles {
  readonly background: string
  readonly color: string
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
  }
  expect(dark.body.color, 'body text must change with the scheme').not.toBe(light.body.color)

  // Value-exact light theme (the original literals) + the dark overrides.
  expect(light.body.background).toBe('rgb(255, 255, 255)') // #fff
  expect(light.body.color).toBe('rgb(26, 26, 26)') // #1a1a1a
  expect(dark.body.background).toBe('rgb(23, 25, 28)') // #17191c
  expect(dark.body.color).toBe('rgb(232, 234, 237)') // #e8eaed
})
