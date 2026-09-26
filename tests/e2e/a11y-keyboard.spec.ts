import path from 'node:path'
import { expect, test } from '@playwright/test'
import { cell } from './support/grid'

// q-3 (PT-Q a11y polish pack, AR-W10): the keyboard and live-region contract
// for the two interactive surfaces the audit flagged.
//
//  1. ExportDialog is a real modal dialog: `aria-modal`, initial focus, a
//     Tab/Shift+Tab trap that cycles inside while open, Escape-to-close, and
//     focus returned to the trigger afterward.
//  2. Grid edit commit and client-side rejection announce through the SINGLE
//     `aria-live="polite"` region (`edit-live-region`); the rejection reason
//     is value-free (never the typed draft or a cell value, ADR 0025).
//  3. An end-to-end keyboard-only journey — open → edit → export — with every
//     activation performed through the keyboard.
//
// The picker path is the usual hidden-`<input type="file">` fallback.
// Privacy (ADR 0025): the suite runs on the committed synthetic fixture; the
// live-region assertions prove no typed value leaks into the announcement.

const FIXTURE = path.join(process.cwd(), 'fixtures', 'parquet', 'customers.parquet')

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
      delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker
    } catch {
      // Non-configurable globals would be a Chromium change; the test then
      // fails loudly at the chooser/download rather than silently.
    }
  })
})

test('ExportDialog is a modal dialog: initial focus, Tab trap, Escape, focus return', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.getByTestId('open-status')).toHaveText('idle', { timeout: 20_000 })
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('open-button').click()
  await (await chooserPromise).setFiles(FIXTURE)
  await expect(page.getByTestId('open-status')).toHaveText('ready', { timeout: 20_000 })

  const trigger = page.getByTestId('export-open')
  await trigger.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByTestId('export-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveAttribute('role', 'dialog')
  await expect(dialog).toHaveAttribute('aria-modal', 'true')

  // Initial focus lands inside the dialog (the checked format radio).
  await expect(page.getByTestId('export-format-parquet')).toBeFocused()

  // Shift+Tab from the first control wraps to the last (Close)…
  await page.keyboard.press('Shift+Tab')
  await expect(page.getByTestId('export-close')).toBeFocused()
  // …and Tab from the last wraps back to the first.
  await page.keyboard.press('Tab')
  await expect(page.getByTestId('export-format-parquet')).toBeFocused()

  // Every forward Tab stays inside the open dialog.
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab')
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true)
  }

  // Escape closes and returns focus to the trigger that opened it.
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

test('grid edit commit and rejection announce through one polite, value-free live region', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.getByTestId('open-status')).toHaveText('idle', { timeout: 20_000 })
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('open-button').click()
  await (await chooserPromise).setFiles(FIXTURE)
  await expect(page.getByTestId('open-status')).toHaveText('ready', { timeout: 20_000 })
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')

  const live = page.getByTestId('edit-live-region')
  await expect(live).toHaveAttribute('aria-live', 'polite')

  // Commit path: a cell edit lands and the region announces it.
  await cell(page, 0, 2).focus()
  await page.keyboard.press('Enter')
  const editor = page.getByTestId('grid-editor-input')
  await editor.press('Control+a')
  await page.keyboard.type('60000')
  await editor.press('Enter')
  await expect(cell(page, 0, 2)).toHaveText('60000')
  await expect(live).toHaveText('Edit committed.')

  // Reject path: a non-numeric draft keeps the editor open and announces the
  // value-free reason. The typed draft must never appear in the region.
  await cell(page, 1, 2).focus()
  await page.keyboard.press('Enter')
  const rejected = page.getByTestId('grid-editor-input')
  await rejected.fill('not-a-number')
  await rejected.press('Enter')
  await expect(page.getByTestId('grid-edit-error')).toHaveText('That is not a number.')
  await expect(live).toHaveText('That is not a number.')
  await expect(live).not.toContainText('not-a-number')
})

test('keyboard-only journey: open → edit → export', async ({ page }) => {
  test.setTimeout(120_000)

  // Open by keyboard through the real picker path.
  await page.goto('/')
  await expect(page.getByTestId('open-status')).toHaveText('idle', { timeout: 20_000 })
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('open-button').focus()
  await page.keyboard.press('Enter')
  await (await chooserPromise).setFiles(FIXTURE)
  await expect(page.getByTestId('open-status')).toHaveText('ready', { timeout: 20_000 })
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')

  // Edit by keyboard: focus a cell, Enter opens the editor, select-all + type
  // + Enter commits. No pointer event in the whole journey.
  await cell(page, 0, 2).focus()
  await page.keyboard.press('Enter')
  const editor = page.getByTestId('grid-editor-input')
  await editor.press('Control+a')
  await page.keyboard.type('60000')
  await editor.press('Enter')
  await expect(cell(page, 0, 2)).toHaveText('60000')
  await expect(page.getByTestId('edit-live-region')).toHaveText('Edit committed.')

  // Export by keyboard: Enter opens the dialog, ArrowDown picks CSV, Tab
  // reaches the confirm button, Enter exports, Escape closes.
  await page.getByTestId('export-open').focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByTestId('export-dialog')
  await expect(dialog).toBeVisible()
  await expect(page.getByTestId('export-format-parquet')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByTestId('export-format-csv')).toBeChecked()
  await page.keyboard.press('Tab')
  await expect(page.getByTestId('export-confirm')).toBeFocused()
  const downloadPromise = page.waitForEvent('download')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('export-result')).toContainText('Exported 5 rows as CSV')
  await downloadPromise
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('export-open')).toBeFocused()
})
