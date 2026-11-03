// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { assertNoCriticalOrSerious, scanA11y, summarizeViolations } from '../e2e/support/a11y'

/**
 * uxv-1 / R-09 — the CONFIGURED-disclosure theme leg (implementation spec §6).
 *
 * Why this file exists: the stock e2e suite runs the stock build, where no
 * collector endpoint is baked in, so the first-run telemetry disclosure is
 * deliberately absent (`tests/e2e/telemetry.spec.ts` pins that absence). The
 * disclosure is therefore one of R-09's two real surfaces, and it can only be
 * driven against a build that has `ASSAY_TELEMETRY_ENDPOINT` configured. The
 * stock telemetry spec must never be pointed at such a build, and no production
 * testing hook is added: this spec runs the real app with the real build-time
 * configuration and only neutralises the NETWORK (see below).
 *
 * Network posture (privacy, ADR 0025/0037): a context route aborting
 * `https://collector.example.invalid/**` is registered BEFORE the first
 * navigation, service workers are blocked by the config, and every test gets a
 * fresh context with cleared local storage. The disclosure is therefore the
 * genuine first-run state, and no metadata can leave the machine even though
 * the runtime is configured to emit.
 *
 * What it asserts, in BOTH schemes, on the real rendered disclosure:
 *  - the surface paints exactly the resolved `--color-surface-elevated` token
 *    (the uxv-1 repair; the old `var(--color-surface-panel, #fff)` fallback
 *    painted white in dark mode);
 *  - every normal-text probe clears the 4.5:1 WCAG AA floor against its actual
 *    computed background, measured in Chromium (never JSDOM);
 *  - the axe scan stays green under the UNCHANGED empty allowlist;
 *  - the Settings dialog (the other R-09 surface) is equally readable here;
 *  - the configured runtime really ATTEMPTED at least one collector send, and
 *    every intercepted request was then aborted (nothing was delivered). Zero
 *    attempts fail the gate instead of passing it vacuously: `every(...)` is
 *    trivially true on an empty array, so the attempt count is asserted first.
 */

const COLLECTOR_ORIGIN = 'https://collector.example.invalid'

/** The AA floor for normal text (WCAG 1.4.3). */
const AA_NORMAL_TEXT = 4.5

/**
 * Normal text on the disclosure: the byte-exact §6.3 copy and both consent
 * affordances. (The two affordances are native `<button>`s painting their own
 * UA control face over the panel, so they are measured against that face; the
 * copy itself must sit on the disclosure surface.)
 */
const DISCLOSURE_TEXT_PROBES = [
  '[data-testid="telemetry-disclosure-copy"]',
  '[data-testid="telemetry-keep-on"]',
  '[data-testid="telemetry-turn-off"]',
] as const

/** Normal text on the Settings dialog (the other R-09 surface). */
const SETTINGS_TEXT_PROBES = [
  '.telemetry-settings-title',
  '.telemetry-settings-option',
  '[data-testid="settings-close"]',
] as const

interface InterceptedRequest {
  readonly url: string
  readonly method: string
  /** Set once `route.abort()` resolved — i.e. the request really was blocked. */
  readonly aborted: boolean
}

interface ContrastReading {
  readonly probe: string
  readonly color: string
  readonly background: string
  readonly ratio: number
}

/**
 * Register the collector black hole. MUST run before any navigation so no
 * request can escape, and it records what it blocked as evidence.
 */
async function blockCollector(page: Page, log: InterceptedRequest[]): Promise<void> {
  await page.route(`${COLLECTOR_ORIGIN}/**`, async (route) => {
    const entry = { url: route.request().url(), method: route.request().method() }
    try {
      await route.abort('blockedbyclient')
      log.push({ ...entry, aborted: true })
    } catch {
      log.push({ ...entry, aborted: false })
      throw new Error('collector route failed to abort — metadata could have been delivered')
    }
  })
}

/**
 * Measure real contrast in the real browser: resolve each probe's computed
 * text colour, walk up to the first opaque background, and apply the WCAG
 * relative-luminance formula to those RESOLVED values.
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

/** Resolve a colour token through the browser, so no literal is repeated here. */
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

test.beforeEach(async ({ page }) => {
  // Fresh local storage: the disclosure is a genuine first-run state, and the
  // persisted "shown" flag can never leak between tests.
  await page.addInitScript(() => {
    try {
      window.localStorage.clear()
    } catch {
      // A throwing storage is a hard failure below (the disclosure would not
      // render), not something to paper over here.
    }
  })
})

for (const scheme of ['light', 'dark'] as const) {
  test(`[${scheme}] configured disclosure paints the defined surface and clears AA without sending anything`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000)
    const intercepted: InterceptedRequest[] = []
    // BEFORE navigation (spec §6): nothing may reach the collector.
    await blockCollector(page, intercepted)

    await page.goto('/')

    // Non-vacuity: this really is the CONFIGURED build, so the disclosure
    // really rendered (the stock build renders none — that is telemetry.spec's
    // pin, and the reason this leg exists).
    const disclosure = page.getByTestId('telemetry-disclosure')
    await expect(disclosure).toBeVisible({ timeout: 30_000 })
    const copy = page.getByTestId('telemetry-disclosure-copy')
    await expect(copy).toBeVisible()
    expect((await copy.textContent())?.trim().length ?? 0).toBeGreaterThan(0)
    await expect(page.getByTestId('telemetry-keep-on')).toBeVisible()
    await expect(page.getByTestId('telemetry-turn-off')).toBeVisible()

    await page.emulateMedia({ colorScheme: scheme })
    // Non-vacuity: the emulated scheme really reached the page, so a dark pass
    // cannot silently re-measure the light one.
    const prefersDark = await page.evaluate(
      () => window.matchMedia('(prefers-color-scheme: dark)').matches,
    )
    expect(prefersDark, `emulated colour scheme must be ${scheme}`).toBe(scheme === 'dark')

    // 1. The surface IS the resolved scheme-aware token (the repair).
    const surface = await disclosure.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    )
    const token = await resolveToken(page, '--color-surface-elevated')
    expect(surface, `[${scheme}] disclosure surface must be --color-surface-elevated`).toBe(token)
    const declared = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--color-surface-elevated'),
    )
    expect(declared.trim(), `[${scheme}] --color-surface-elevated must be defined`).not.toBe('')

    // 2. Real measured contrast for every normal-text probe.
    const readings = await measureTextContrast(page, DISCLOSURE_TEXT_PROBES)
    for (const reading of readings) {
      console.log(
        `[theme] disclosure ${scheme} ${reading.probe}: ${reading.color} on ${reading.background} = ${reading.ratio.toFixed(2)}:1`,
      )
      expect(
        reading.ratio,
        `[${scheme}] ${reading.probe} normal text must clear the ${String(AA_NORMAL_TEXT)}:1 AA floor (measured ${reading.ratio.toFixed(2)}:1)`,
      ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
    }
    // The disclosure's own copy renders directly on the surface token.
    const copyReading = readings.find((reading) => reading.probe.includes('disclosure-copy'))
    expect(
      copyReading?.background,
      `[${scheme}] the disclosure copy must sit on the surface token, not a fallback colour`,
    ).toBe(token)

    // 3. The other R-09 surface in the same configured context: the Settings
    //    dialog is equally readable in this scheme.
    await page.getByTestId('settings-toggle').click()
    const settings = page.getByTestId('settings-dialog')
    await expect(settings).toBeVisible()
    const settingsSurface = await settings.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    )
    expect(settingsSurface, `[${scheme}] Settings dialog surface must be the same token`).toBe(
      token,
    )
    const settingsReadings = await measureTextContrast(page, SETTINGS_TEXT_PROBES)
    for (const reading of settingsReadings) {
      console.log(
        `[theme] settings ${scheme} ${reading.probe}: ${reading.color} on ${reading.background} = ${reading.ratio.toFixed(2)}:1`,
      )
      expect(
        reading.ratio,
        `[${scheme}] ${reading.probe} normal text must clear the ${String(AA_NORMAL_TEXT)}:1 AA floor (measured ${reading.ratio.toFixed(2)}:1)`,
      ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT)
    }

    // 4. Screenshots are review artifacts for the reviewer (never committed,
    //    never asserted: pixel baselines are environment-dependent).
    await testInfo.attach(`configured-disclosure-${scheme}`, {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    })

    // 5. axe, with the SAME empty allowlist the stock scans use.
    const results = await scanA11y(page)
    console.log(
      `[a11y] configured disclosure (${scheme})\n${summarizeViolations(results.violations)}`,
    )
    assertNoCriticalOrSerious(results.violations)

    // 6. Privacy: the runtime flushes on a bounded debounce, so poll for the
    //    first attempt instead of sleeping a fixed amount — a fixed sleep is
    //    both slower than needed and unbounded evidence (it can pass by luck on
    //    a slow runner or fail on a fast one). Polling stops as soon as the
    //    configured build proves it tried, and the non-vacuity/abort assertions
    //    below still do the actual proving. The stock build never gets here; a
    //    configured build must not deliver anything.
    await expect
      .poll(() => intercepted.length, {
        timeout: 15_000,
        message: `[${scheme}] the configured build must attempt at least one collector send — zero attempts would make the abort proof vacuous`,
      })
      .toBeGreaterThan(0)
    console.log(
      `[telemetry] intercepted ${String(intercepted.length)} collector request(s): ${JSON.stringify(intercepted)}`,
    )
    // Non-vacuity FIRST: the `every(...)` proofs below are trivially true on
    // an empty array, so a build that stopped attempting collector sends would
    // pass the privacy gate silently. Prove an attempt happened, then prove it
    // was blocked.
    expect(
      intercepted.length,
      `[${scheme}] the configured build must attempt at least one collector send — zero attempts would make the abort proof vacuous`,
    ).toBeGreaterThan(0)
    expect(
      intercepted.every((request) => request.url.startsWith(COLLECTOR_ORIGIN)),
      `[${scheme}] every intercepted request must target the configured collector origin`,
    ).toBe(true)
    expect(
      intercepted.every((request) => request.aborted),
      `[${scheme}] every intercepted collector request must be aborted — nothing may be delivered`,
    ).toBe(true)
  })
}
