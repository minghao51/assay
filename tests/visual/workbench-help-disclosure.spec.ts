// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * rd-7 (D-03) — the Help ↔ FIRST-RUN TELEMETRY DISCLOSURE arbitration, proved in
 * a real browser on the CONFIGURED build.
 *
 * Why this spec lives in the configured leg: the stock e2e suite runs the stock
 * build, where no collector endpoint is baked in, so the first-run disclosure is
 * deliberately absent (`tests/e2e/telemetry.spec.ts` pins that absence) and the
 * Help↔disclosure pair can never render there. The stock suite proves
 * Help↔Export and Help↔Settings; the jsdom component test proves the App-level
 * state (a disabled opener); this file is the browser proof for the third and
 * last owned surface, against the real configured app.
 *
 * Network posture — copied from `telemetry-disclosure-theme.spec.ts` rather than
 * invented: a context route aborting `https://collector.example.invalid/**` is
 * registered BEFORE the first navigation, service workers are blocked by the
 * config, every test gets a fresh context, and local storage is cleared at
 * document start so the disclosure is the genuine first-run state. Nothing is
 * delivered anywhere, and the intercepted sends are asserted to have been
 * aborted (zero ATTEMPTS also fails, so the evidence is never vacuous).
 *
 * What it asserts, on the real configured build:
 *  1. the disclosure is visible, `help-open` is DISABLED, and no
 *     `workbench-help` element exists in the DOM;
 *  2. keyboard Tab cannot reach the disabled control — named precisely as two
 *     separate facts: the attribute is `disabled`, AND the page behind the
 *     native modal is inert, so sequential navigation never leaves the dialog;
 *  3. dismissing the disclosure enables `help-open`;
 *  4. opening Help shows the guide with focus inside it, and the disclosure does
 *     NOT return;
 *  5. closing the guide returns focus to `help-open`, its own opener.
 */

const COLLECTOR_ORIGIN = 'https://collector.example.invalid'

interface InterceptedRequest {
  readonly url: string
  readonly method: string
  /** Set once `route.abort()` resolved — i.e. the request really was blocked. */
  readonly aborted: boolean
}

/** The current focus owner as seen from the page. */
interface FocusReport {
  readonly testId: string | null
  readonly insideDisclosure: boolean
  readonly insideGuide: boolean
}

/** Read the focused element and which owned surface contains it. */
async function activeFocus(page: Page): Promise<FocusReport> {
  return page.evaluate(() => {
    const active = document.activeElement
    const element = active instanceof HTMLElement ? active : null
    const disclosure = document.querySelector('[data-testid="telemetry-disclosure"]')
    const guide = document.querySelector('[data-testid="workbench-help"]')
    return {
      testId: element?.getAttribute('data-testid') ?? null,
      insideDisclosure: disclosure !== null && active !== null && disclosure.contains(active),
      insideGuide: guide !== null && active !== null && guide.contains(active),
    }
  })
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

test('rd-7 help: the first-run disclosure owns the modal — Help is blocked, then usable once dismissed', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const intercepted: InterceptedRequest[] = []
  // BEFORE navigation: nothing may reach the collector.
  await blockCollector(page, intercepted)

  await page.goto('/')

  // Non-vacuity: this really is the CONFIGURED build, so the disclosure really
  // rendered (the stock build renders none — that is why this leg exists).
  const disclosure = page.getByTestId('telemetry-disclosure')
  await expect(disclosure).toBeVisible({ timeout: 30_000 })
  expect(
    await disclosure.evaluate((element) => element.matches(':modal')),
    'the disclosure must be a real native modal (top layer)',
  ).toBe(true)

  const helpOpener = page.getByTestId('help-open')

  // (1) The guide is closed and its opener is disabled while the disclosure
  //     owns the modal. Both facts are asserted separately: the attribute, and
  //     the absence of the doc.
  await expect(helpOpener).toBeVisible()
  await expect(helpOpener).toBeDisabled()
  await expect(page.getByTestId('workbench-help')).toHaveCount(0)

  // (2) Keyboard Tab cannot reach the disabled control. Two distinct, precisely
  //     named facts: the attribute is `disabled` (so it is not a tab stop), and
  //     the page behind a native modal is INERT, so sequential navigation never
  //     leaves the disclosure at all.
  const tabPath: FocusReport[] = []
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press('Tab')
    tabPath.push(await activeFocus(page))
  }
  expect(
    tabPath.every((step) => step.testId !== 'help-open'),
    `Tab must never focus the disabled Help control (path: ${JSON.stringify(tabPath)})`,
  ).toBe(true)
  expect(
    tabPath.every((step) => step.insideDisclosure),
    `Tab must stay inside the modal disclosure while it is open (path: ${JSON.stringify(tabPath)})`,
  ).toBe(true)
  // Shift+Tab is symmetric.
  await page.keyboard.press('Shift+Tab')
  expect(
    (await activeFocus(page)).testId,
    'Shift+Tab must not reach the disabled Help control either',
  ).not.toBe('help-open')

  // A synthetic activation of the disabled control still cannot open a second
  // surface (the handler guard, independent of the UA's inertness).
  await helpOpener.dispatchEvent('click')
  await expect(page.getByTestId('workbench-help')).toHaveCount(0)
  await expect(disclosure).toBeVisible()

  // (3) Dismissing the disclosure enables the opener. `Keep anonymous usage on`
  //     is the neutral choice: no preference is written, nothing is sent.
  await page.mouse.move(0, 0)
  await page.getByTestId('telemetry-keep-on').click()
  await expect(page.getByTestId('telemetry-disclosure')).toHaveCount(0)
  await expect(helpOpener).toBeEnabled()

  // (4) Opening the guide shows it with focus inside, and the disclosure does
  //     NOT come back (one owned surface at a time, in both directions).
  await helpOpener.click()
  const guide = page.getByTestId('workbench-help')
  await expect(guide).toBeVisible()
  expect(
    await guide.evaluate((element) => element.matches(':modal')),
    'the guide must be a real native modal (top layer)',
  ).toBe(true)
  expect(
    await guide.evaluate((element) => element.contains(document.activeElement)),
    'focus must move inside the guide when it opens',
  ).toBe(true)
  await expect(page.getByTestId('telemetry-disclosure')).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: 'Workbench guide' })).toBeVisible()

  // The guide's own text is the approved copy (spot-checked here; the exact
  // strings are pinned by the stock suite and the component test).
  await expect(page.getByTestId('help-what-this-is')).toContainText(
    'Nothing is uploaded; the file you open is never modified.',
  )

  // (5) Closing the guide returns focus to its own opener, and the disclosure
  //     still does not return.
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('workbench-help')).toHaveCount(0)
  await expect(helpOpener).toBeFocused()
  await expect(page.getByTestId('telemetry-disclosure')).toHaveCount(0)

  // Network evidence: the configured runtime really ATTEMPTED at least one
  // collector send (the disclosure/keep-on path and the buffered boot events),
  // and every intercepted request was aborted. The runtime debounces flushes by
  // 2 s, so this waits for the attempt instead of sleeping a guessed interval;
  // the attempt count is asserted first so `every(...)` cannot pass vacuously.
  await expect
    .poll(() => intercepted.length, {
      timeout: 20_000,
      message: 'the configured build must attempt at least one collector send',
    })
    .toBeGreaterThan(0)
  expect(
    intercepted.every((request) => request.aborted),
    `every collector request must be aborted (got ${JSON.stringify(intercepted)})`,
  ).toBe(true)
})
