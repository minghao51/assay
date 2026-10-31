import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { openCustomersFixture } from './support/fixtures'
import { cell, waitForReadyRow } from './support/grid'

/**
 * ug-5 (UG-11) end-to-end pin: Ctrl+C on a focused, non-editing grid cell
 * copies the **display value** into the real browser clipboard and announces
 * a value-free result through the app's single polite live region.
 *
 * The spec uses the committed `customers.parquet` golden fixture (5 rows):
 *
 *   customer_id country income     signup_date
 *   1           SG      52000      2025-01-04
 *   2           US      61000      2025-01-11
 *   3           SG      NULL       2025-02-02
 *   …
 *
 * Four legs, matching the contract:
 * 1. a non-empty cell copies its rendered text (`SG`) and announces
 *    `Value copied.`;
 * 2. a NULL cell writes nothing, leaves the clipboard untouched, and
 *    announces the empty-cell message;
 * 3. with the inline editor open, Ctrl+C inside the editor belongs to the
 *    browser: the selected draft is copied, NOT the cell display value, and
 *    the grid announces nothing (native copy is never intercepted); the
 *    editor stays open, and Escape cancels with no state change;
 * 4. copying mutates nothing — the cell text, dirty flag and history are
 *    unchanged (ADR 0012: staged edits only).
 *
 * Privacy (ADR 0025): the copy is user-initiated and local; the assertions
 * only read back the value the user asked to copy. The live region is pinned
 * value-free, and no telemetry path is involved.
 */

/** Read the browser clipboard (permissions are granted for this file). */
function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText())
}

test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

test.beforeEach(async ({ page }) => {
  // Take the hidden-`<input type="file">` fallback (m1-5 pattern), like the
  // other fixture-opening grid specs.
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
    } catch {
      // Non-configurable global would be a Chromium change; fail loudly later.
    }
  })
})

test('Ctrl+C copies the focused cell value; an open editor keeps native copy', async ({ page }) => {
  await openCustomersFixture(page)
  await waitForReadyRow(page, 0)

  const live = page.getByTestId('edit-live-region')
  await expect(live).toHaveAttribute('aria-live', 'polite')

  // 1. Focus a known non-empty cell and copy its display text.
  await cell(page, 0, 1).focus()
  await expect(cell(page, 0, 1)).toBeFocused()
  await page.keyboard.press('Control+C')
  await expect(live).toHaveText('Value copied.')
  await expect.poll(() => readClipboard(page)).toBe('SG')

  // 2. A NULL cell writes nothing and explains the no-op (clipboard keeps
  // the previous value — the app did not write an empty string).
  await waitForReadyRow(page, 2)
  await cell(page, 2, 2).focus()
  await expect(page.getByTestId('grid-cell-null')).toBeVisible()
  await page.keyboard.press('Control+C')
  await expect(live).toHaveText('Nothing to copy — this cell is empty.')
  expect(await readClipboard(page)).toBe('SG')

  // 3. With the editor open the browser owns Ctrl+C: the selected draft is
  // copied, never the cell display value ('52000'), and the grid does not
  // announce a copy or steal focus.
  await waitForReadyRow(page, 0)
  await expect(cell(page, 0, 2)).toHaveText('52000')
  await cell(page, 0, 2).focus()
  await page.keyboard.press('Enter')
  const editor = page.getByTestId('grid-editor-input')
  await expect(editor).toBeFocused()
  await editor.fill('draft-1234')
  await editor.press('Control+a')
  expect(
    await editor.evaluate((el) => el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0)),
  ).toBe('draft-1234')
  await editor.press('Control+C')
  await expect.poll(() => readClipboard(page)).toBe('draft-1234')
  await expect(live).toHaveText('Nothing to copy — this cell is empty.')
  await expect(editor).toBeFocused()

  // 4. Escape cancels the editor; copying changed no cell, dirty flag or
  // history (the draft was never committed).
  await editor.press('Escape')
  await expect(page.getByTestId('grid-cell-editor')).toHaveCount(0)
  await expect(cell(page, 0, 2)).toHaveText('52000')
  await expect(cell(page, 0, 2)).toHaveAttribute('data-dirty', 'false')
  await expect(page.getByTestId('history-undo')).toBeDisabled()
})
