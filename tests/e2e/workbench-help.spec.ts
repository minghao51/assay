import path from 'node:path'
import { expect, test } from './support/fixture'
import type { Page } from '@playwright/test'
import { DEFERRED_A11Y, assertNoCriticalOrSerious, scanA11y } from './support/a11y'
import { openFixture } from './support/fixtures'

// rd-7 (D-03) — the one global Help guide, proved in a real browser.
//
// The component pins (`apps/web/src/help/WorkbenchHelp.test.tsx`) own the copy
// gate and the App-local modal arbitration state. This spec owns the things
// only a browser can prove:
//
//  1. it is a genuine native modal — top layer, inert background, so no second
//     surface can open behind it with either pointer or keyboard;
//  2. keyboard-only operation: reach the header control by Tab, open with
//     Enter, Tab stays inside, Escape closes, focus returns to the opener;
//  3. the guide is usable at 1024×700, 1440×900 and 900×900 in BOTH schemes,
//     with no horizontal clip, and axe reports no unallowlisted critical or
//     serious violation (the shared allowlist is unchanged — it is empty);
//  4. the content's honesty claims: four input formats, Arrow as export only,
//     no offline promise for the browser app, and no user-validation claim.
//
// Privacy (ADR 0025): the suite runs on the idle frame and the committed
// synthetic customers fixture; the guide must never show a file name, path,
// row count or dataset value, and it emits no telemetry (it has no telemetry
// dependency at all — the component unit test pins that).

const CUSTOMERS_FIXTURE = path.join(process.cwd(), 'fixtures', 'parquet', 'customers.parquet')

/** The approved §4 strings this browser leg pins independently of the component. */
const HELP_TITLE = 'Workbench guide'
const FOUR_FORMATS =
  'Reads Parquet, CSV, JSONL/NDJSON and JSON; Arrow is an export format, not an input.'
const NO_OFFLINE_PROMISE =
  'the first time it opens such a file, so opening one without a network connection is not guaranteed.'

const VIEWPORTS = [
  { width: 1024, height: 700 },
  { width: 1440, height: 900 },
  { width: 900, height: 900 },
] as const

const SCHEMES = ['light', 'dark'] as const

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
      delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker
    } catch {
      // Non-configurable globals would be a Chromium change; the test then
      // fails loudly at the chooser instead of silently.
    }
  })
})

/** Wait for the idle frame (the header control exists in every phase). */
async function openIdle(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'idle', {
    timeout: 20_000,
  })
}

/**
 * Reach a testid by pressing Tab only — never `.focus()` — so the ring and the
 * real tab order are part of what is proved (the theme spec's pattern).
 */
async function tabTo(page: Page, testId: string): Promise<void> {
  for (let index = 0; index < 40; index += 1) {
    await page.keyboard.press('Tab')
    const focused = await page.evaluate(
      () => (document.activeElement as HTMLElement | null)?.dataset['testid'] ?? null,
    )
    if (focused === testId) return
  }
  throw new Error(`keyboard focus never reached [data-testid="${testId}"] within 40 tabs`)
}

/** The guide's own clipping facts (page + dialog scroll boxes). */
async function clipFacts(page: Page): Promise<{
  readonly docOverflow: number
  readonly dialogOverflow: number
  readonly bodyOverflow: number
}> {
  return page.evaluate(() => {
    const doc = document.documentElement
    const dialog = document.querySelector('[data-testid="workbench-help"]')
    const body = document.querySelector('[data-testid="workbench-help-body"]')
    if (dialog === null || body === null) throw new Error('the guide is not open')
    return {
      docOverflow: doc.scrollWidth - doc.clientWidth,
      dialogOverflow: dialog.scrollWidth - dialog.clientWidth,
      bodyOverflow: body.scrollWidth - body.clientWidth,
    }
  })
}

for (const { width, height } of VIEWPORTS) {
  for (const scheme of SCHEMES) {
    test(`rd-7 help: ${String(width)}×${String(height)} ${scheme} — native modal, keyboard only, axe, no clip`, async ({
      page,
    }) => {
      test.setTimeout(120_000)
      await page.setViewportSize({ width, height })
      await page.emulateMedia({ colorScheme: scheme })
      await openIdle(page)

      // Non-vacuity: the emulated scheme really reached the page.
      expect(
        await page.evaluate(() => window.matchMedia('(prefers-color-scheme: dark)').matches),
        `emulated colour scheme must be ${scheme}`,
      ).toBe(scheme === 'dark')

      // Keyboard only: Tab to the header control, Enter opens the guide.
      await tabTo(page, 'help-open')
      await page.keyboard.press('Enter')

      const dialog = page.getByTestId('workbench-help')
      await expect(dialog).toBeVisible()
      // A native modal: `showModal()` is what makes the page behind it inert,
      // and `<dialog>` carries the implicit `dialog` role with the approved
      // title as its accessible name.
      expect(
        await dialog.evaluate((element) => (element as HTMLDialogElement).matches(':modal')),
      ).toBe(true)
      expect(await dialog.evaluate((element) => element.getAttribute('aria-labelledby'))).toBe(
        'workbench-help-title',
      )
      await expect(page.getByRole('dialog', { name: HELP_TITLE })).toBeVisible()

      // Initial focus is inside the guide (its own title, a reading start).
      expect(
        await dialog.evaluate((element) => element.contains(document.activeElement)),
        'initial focus must be inside the guide',
      ).toBe(true)

      // Tab and Shift+Tab stay inside the modal.
      for (let index = 0; index < 6; index += 1) {
        await page.keyboard.press('Tab')
        expect(
          await dialog.evaluate((element) => element.contains(document.activeElement)),
          `Tab ${String(index + 1)} must stay inside the guide`,
        ).toBe(true)
      }
      for (let index = 0; index < 3; index += 1) {
        await page.keyboard.press('Shift+Tab')
        expect(
          await dialog.evaluate((element) => element.contains(document.activeElement)),
          `Shift+Tab ${String(index + 1)} must stay inside the guide`,
        ).toBe(true)
      }

      // The Close control is reachable and visible at this viewport.
      await expect(page.getByTestId('help-close')).toBeInViewport()

      // Axe: the shared scanner, the unchanged (empty) allowlist.
      const results = await scanA11y(page)
      assertNoCriticalOrSerious(results.violations, DEFERRED_A11Y)

      // No horizontal clip, at the dialog, its scrolling body, or the page.
      const clip = await clipFacts(page)
      expect(clip.docOverflow, 'the page must not scroll horizontally').toBeLessThanOrEqual(0)
      expect(clip.dialogOverflow, 'the guide must not clip horizontally').toBeLessThanOrEqual(1)
      expect(clip.bodyOverflow, 'the guide body must not clip horizontally').toBeLessThanOrEqual(1)

      // Escape closes and returns focus to the opening control.
      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await expect(page.getByTestId('help-open')).toBeFocused()

      // The guide's own text is the approved copy, and it carries no value.
      // Re-open by keyboard alone (Escape left focus ON the header control, and
      // the assertion above proves it), then close through the Close control so
      // both close paths are exercised at this viewport.
      await page.keyboard.press('Enter')
      await expect(dialog).toBeVisible()
      const text = (await dialog.innerText()).replaceAll(/\s+/g, ' ')
      expect(text).toContain(HELP_TITLE)
      expect(text).toContain(FOUR_FORMATS)
      expect(text).toContain(NO_OFFLINE_PROMISE)
      expect(text).toContain('extensions.duckdb.org')
      expect(text).not.toContain(path.basename(CUSTOMERS_FIXTURE))
      expect(text, 'no user-validation claim (D-02)').not.toMatch(
        /validated with users|intuitive|user-tested|usability stud/i,
      )
      // Close with the pointer at the control's real coordinates (the second
      // close path). Park the pointer first: the guide opens under the mouse,
      // so a captured hover must not decide where the press lands.
      await page.mouse.move(0, 0)
      const closeBox = await page.evaluate(() => {
        const close = document.querySelector('[data-testid="help-close"]')
        if (close === null) throw new Error('the Close control is missing')
        const rect = close.getBoundingClientRect()
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      })
      await page.mouse.click(closeBox.x, closeBox.y)
      await expect(dialog).toHaveCount(0)
      await expect(page.getByTestId('help-open')).toBeFocused()
    })
  }
}

test('rd-7 help: the four formats, Arrow-as-export and the locality limit are stated; nothing else is claimed', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 700 })
  await openIdle(page)
  await page.getByTestId('help-open').click()
  const dialog = page.getByTestId('workbench-help')
  await expect(dialog).toBeVisible()

  // The approved §4 strings, byte-exactly, section by section.
  await expect(page.getByTestId('help-what-this-is')).toHaveText(
    'Inspect, check, change and deliver a dataset without leaving this machine. Nothing is uploaded; the file you open is never modified. Changes are staged in this session and exported as a new copy.',
  )
  await expect(page.getByTestId('help-task-explore')).toHaveText(
    'Explore — Understand what is in the file: fields, filters, query and statistics.',
  )
  await expect(page.getByTestId('help-task-check')).toHaveText(
    'Check — Find quality issues or explain differences between two versions.',
  )
  await expect(page.getByTestId('help-task-change')).toHaveText(
    'Change — Make a reversible repair, review staged operations and deliver a copy.',
  )
  await expect(page.getByTestId('help-task-prepare')).toHaveText(
    'Prepare — Run deterministic steps and inspect gate and delivery evidence.',
  )
  await expect(page.getByTestId('help-task-note')).toHaveText(
    'Choose a task to see the sections it uses. Grid and Record stay available in every task.',
  )
  await expect(page.getByTestId('help-formats')).toHaveText(
    "Reads Parquet, CSV, JSONL/NDJSON and JSON; Arrow is an export format, not an input. This browser app may download DuckDB's Parquet or JSON reader from extensions.duckdb.org the first time it opens such a file, so opening one without a network connection is not guaranteed. The desktop app ships those readers locally.",
  )
  await expect(page.getByTestId('help-keyboard')).toHaveText(
    'The task strip is a radio group: arrow keys move between tasks, Home and End jump to the first and last. Section links move focus to the section. In the grid, arrows move the focused cell and Enter opens the editor. Esc closes a dialog.',
  )
  // The DuckDB host is a real code span, not plain text.
  await expect(page.getByTestId('help-formats').locator('code')).toHaveText('extensions.duckdb.org')

  // Honesty: no offline promise for THIS app, and no validation claim anywhere.
  const text = await dialog.innerText()
  expect(text).not.toMatch(/works offline|offline[- ]only|fully offline|no network needed/i)
  expect(text).not.toMatch(/validated|intuitive|user-tested|usability/i)
  // No links out, no forms, no images.
  await expect(dialog.locator('a, img, iframe, form, input')).toHaveCount(0)
})

test('rd-7 help: Export open ⇒ the Help control is unreachable and no second dialog opens', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await openFixture(page, CUSTOMERS_FIXTURE, { task: 'change', assertFileNameHidden: true })

  // Baseline: nothing else is open, so the control is reachable.
  await expect(page.getByTestId('help-open')).toBeEnabled()

  // Export owns the modal.
  const exportOpener = page.getByTestId('export-open')
  await exportOpener.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('export-dialog')).toBeVisible()

  // The Header control is disabled — not merely ignored — and a synthetic
  // activation still cannot open a second dialog (the handler guard).
  const helpOpener = page.getByTestId('help-open')
  await expect(helpOpener).toBeDisabled()
  await helpOpener.dispatchEvent('click')
  await expect(page.getByTestId('workbench-help')).toHaveCount(0)
  // A real pointer press at its centre is also inert.
  const box = await helpOpener.boundingBox()
  expect(box, 'the disabled control must still have a box').not.toBeNull()
  if (box !== null) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  await expect(page.getByTestId('workbench-help')).toHaveCount(0)
  await expect(page.getByTestId('export-dialog')).toBeVisible()

  // Closing Export returns focus to ITS opener and re-enables the guide.
  await page.getByTestId('export-close').click()
  await expect(page.getByTestId('export-dialog')).toHaveCount(0)
  await expect(exportOpener).toBeFocused()
  await expect(helpOpener).toBeEnabled()
})

test('rd-7 help: Settings open ⇒ Help is blocked the same way, and each close returns its own focus', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 700 })
  await openIdle(page)

  const settingsToggle = page.getByTestId('settings-toggle')
  await settingsToggle.click()
  await expect(page.getByTestId('settings-dialog')).toBeVisible()
  await expect(page.getByTestId('help-open')).toBeDisabled()
  await page.getByTestId('help-open').dispatchEvent('click')
  await expect(page.getByTestId('workbench-help')).toHaveCount(0)

  // Settings closes back onto its own opener. Park the pointer first so the
  // open panel's captured hover cannot decide what receives the click.
  await page.mouse.move(0, 0)
  await page.getByTestId('settings-close').click()
  await expect(page.getByTestId('settings-dialog')).toBeHidden()
  await expect(settingsToggle).toBeFocused()
  await expect(page.getByTestId('help-open')).toBeEnabled()

  // And Help, opened from the re-enabled control, is the only surface open.
  await page.getByTestId('help-open').click()
  await expect(page.getByTestId('workbench-help')).toBeVisible()
  await expect(page.getByTestId('settings-dialog')).toBeHidden()
  await expect(page.getByTestId('export-dialog')).toHaveCount(0)
})

test('rd-7 help: with the guide open, pointer and keyboard cannot reach the background controls', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await openFixture(page, CUSTOMERS_FIXTURE, { task: 'change', assertFileNameHidden: true })

  const helpOpener = page.getByTestId('help-open')
  await helpOpener.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByTestId('workbench-help')
  await expect(dialog).toBeVisible()

  // 1. A background control cannot be focused while the modal is open.
  const backgroundTookFocus = await page.evaluate(() => {
    const toggle = document.querySelector<HTMLElement>('[data-testid="settings-toggle"]')
    if (toggle === null) throw new Error('the background Settings toggle is missing')
    toggle.focus()
    return document.activeElement === toggle
  })
  expect(backgroundTookFocus, 'the page behind a native modal must not be focusable').toBe(false)
  expect(
    await dialog.evaluate((element) => element.contains(document.activeElement)),
    'focus must still be inside the guide',
  ).toBe(true)

  // 2. A real pointer press on the Settings toggle is swallowed by the top layer.
  const settingsBox = await page.getByTestId('settings-toggle').boundingBox()
  expect(settingsBox).not.toBeNull()
  if (settingsBox !== null) {
    await page.mouse.click(
      settingsBox.x + settingsBox.width / 2,
      settingsBox.y + settingsBox.height / 2,
    )
  }
  await expect(page.getByTestId('settings-dialog')).toBeHidden()
  await expect(dialog).toBeVisible()

  // 3. Same for the Export control: it cannot open a second dialog.
  const exportOpener = page.getByTestId('export-open')
  await exportOpener.scrollIntoViewIfNeeded()
  const exportBox = await exportOpener.boundingBox()
  expect(exportBox).not.toBeNull()
  if (exportBox !== null) {
    await page.mouse.click(exportBox.x + exportBox.width / 2, exportBox.y + exportBox.height / 2)
  }
  await expect(page.getByTestId('export-dialog')).toHaveCount(0)
  await expect(dialog).toBeVisible()
  await exportOpener.dispatchEvent('click')
  await expect(page.getByTestId('export-dialog')).toHaveCount(0)

  // 4. The guide is still keyboard-usable and Escape closes it onto the opener.
  await expect(page.getByTestId('help-close')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(helpOpener).toBeFocused()
})
