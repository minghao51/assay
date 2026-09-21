import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { readGridStats } from './support/grid-stats'

// Task m4-3 proof (handoff §6): real cell editing + row ops + dirty state over
// the m4-1 domain overlay and the m4-2 engine surface. The app under test is
// the real composition root served at '/' by the first webServer in
// playwright.config.ts, opened on the committed golden fixture
// customers.parquet (5 rows; income of customer 3 is NULL):
//
//   customer_id country income     signup_date
//   1           SG      52000      2025-01-04
//   2           US      61000      2025-01-11
//   3           SG      NULL       2025-02-02
//   4           DE      48000      2025-02-19
//   5           US      75000      2025-03-01
//
// Requested pins (done-when):
//   1. edit → visibility → undo → clean (an edited cell shows the edit, is
//      marked dirty, and after undo shows the base value and is clean again);
//   2. typed-constraint rejections are readable and leave state unchanged;
//      a rejection the engine (not the client) makes — a bad DATE, an
//      out-of-range BIGINT — surfaces readably, rolls the overlay back, and
//      leaves the grid recoverable (fix round);
//   3. NULL is a distinct affordance and a distinct rendering (never an empty
//      string, an unset editor, or an error);
//   4. insert/delete row journeys;
//   5. temporal cells open with a human-readable, engine-round-trippable
//      draft, so double-click + Enter unchanged cannot brick the grid (fix
//      round);
//   6. rapid epoch changes never leave a stale/in-flight window rendered.
//
// Privacy (ADR 0025): the picked file name and the opaque row anchors are
// never rendered; values are asserted as text only.

const FIXTURE = path.join(process.cwd(), 'fixtures', 'parquet', 'customers.parquet')

test.beforeEach(async ({ page }) => {
  // Take the hidden-<input type="file"> fallback (m1-5 pattern).
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
    } catch {
      // Non-configurable global would be a Chromium change; fail loudly later.
    }
  })
})

async function openCustomersFixture(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByTestId('open-status')).toHaveText('idle', { timeout: 20_000 })
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('open-button').click()
  const chooser = await chooserPromise
  await chooser.setFiles(FIXTURE)
  await expect(page.getByTestId('open-status')).toHaveText('ready', { timeout: 20_000 })
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')
  await expect(page.getByTestId('table-info')).not.toContainText('customers.parquet')
}

function row(page: Page, index: number): Locator {
  return page.locator(`[data-testid="grid-row"][data-row-index="${String(index)}"]`)
}

function cell(page: Page, rowIndex: number, columnIndex: number): Locator {
  return row(page, rowIndex).getByTestId('grid-cell').nth(columnIndex)
}

/** Ids (customer_id, column 0) of every READY row, in row order. */
function expectCustomerOrder(page: Page, ids: string[]): Promise<void> {
  return expect(
    page.locator(
      '[data-testid="grid-row"][data-status="ready"] [data-testid="grid-cell"]:nth-child(1)',
    ),
  ).toHaveText(ids)
}

/** Wait until a rendered row has its data (the window fetch landed). */
async function waitForReadyRow(page: Page, rowIndex: number): Promise<void> {
  await expect(row(page, rowIndex)).toHaveAttribute('data-status', 'ready')
}

/** Double-click a ready cell and wait for its inline editor. */
async function openEditor(page: Page, rowIndex: number, columnIndex: number): Promise<void> {
  await waitForReadyRow(page, rowIndex)
  await cell(page, rowIndex, columnIndex).dblclick()
  await expect(page.getByTestId('grid-cell-editor')).toBeVisible()
}

test('edit → visibility → undo → redo → undo → clean (the exit pin)', async ({ page }) => {
  await openCustomersFixture(page)
  const income = cell(page, 0, 2)
  await expect(income).toHaveText('52000')
  await expect(income).toHaveAttribute('data-dirty', 'false')

  // Commit an edit: it becomes visible immediately and the cell is dirty.
  await openEditor(page, 0, 2)
  const editor = page.getByTestId('grid-editor-input')
  await expect(editor).toHaveValue('52000')
  await editor.fill('99999')
  await editor.press('Enter')
  await expect(page.getByTestId('grid-cell-editor')).toHaveCount(0)
  await expect(income).toHaveText('99999')
  await expect(income).toHaveAttribute('data-dirty', 'true')
  await expect(row(page, 0)).toHaveAttribute('data-dirty', 'true')
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5') // a cell edit is not a row change

  // Undo → the base value stands again and the grid is clean (the pure fold
  // of the empty prefix is the initial state).
  await page.getByTestId('edit-undo').click()
  await expect(income).toHaveText('52000')
  await expect(income).toHaveAttribute('data-dirty', 'false')
  await expect(row(page, 0)).toHaveAttribute('data-dirty', 'false')
  await expect(page.getByTestId('edit-undo')).toBeDisabled()

  // Redo re-applies the logged op; undo again returns to clean.
  await page.getByTestId('edit-redo').click()
  await expect(income).toHaveText('99999')
  await expect(income).toHaveAttribute('data-dirty', 'true')
  await page.getByTestId('edit-undo').click()
  await expect(income).toHaveText('52000')
  await expect(income).toHaveAttribute('data-dirty', 'false')
  await expect(page.getByTestId('edit-redo')).toBeEnabled()
})

test('typed constraints: a non-numeric input is rejected readably and leaves state unchanged', async ({
  page,
}) => {
  await openCustomersFixture(page)

  await openEditor(page, 0, 2) // income is BIGINT
  const editor = page.getByTestId('grid-editor-input')
  await editor.fill('abc')
  await editor.press('Enter')

  // Readable rejection, editor stays open, overlay untouched (the cell's
  // data-dirty stays false — the draft is not committed; the gridcell text
  // is currently the editor's own content, so the base value is asserted
  // after cancelling).
  await expect(page.getByTestId('grid-edit-error')).toBeVisible()
  await expect(page.getByTestId('grid-edit-error')).toContainText('not a number')
  await expect(page.getByTestId('grid-cell-editor')).toBeVisible()
  await expect(cell(page, 0, 2)).toHaveAttribute('data-dirty', 'false')

  // Escape cancels the editor; nothing changed and the alert cleared.
  await editor.press('Escape')
  await expect(page.getByTestId('grid-cell-editor')).toHaveCount(0)
  await expect(cell(page, 0, 2)).toHaveText('52000')
  await expect(cell(page, 0, 2)).toHaveAttribute('data-dirty', 'false')

  // A wide numeric accepts exact 64-bit text (the domain `text` kind).
  await openEditor(page, 0, 2)
  await page.getByTestId('grid-editor-input').fill('9007199254740993')
  await page.getByTestId('grid-editor-input').press('Enter')
  await expect(cell(page, 0, 2)).toHaveText('9007199254740993')

  // m4-4 carry-over: re-committing an unchanged draft is a cancel, not a
  // spurious no-op step — the editor closes, the value is untouched, and no
  // alert appears (the no-op surface is pinned in column-ops.spec.ts via a
  // cast-identity op instead).
  await openEditor(page, 0, 2)
  await page.getByTestId('grid-editor-input').fill('9007199254740993')
  await page.getByTestId('grid-editor-input').press('Enter')
  await expect(page.getByTestId('grid-cell-editor')).toHaveCount(0)
  await expect(cell(page, 0, 2)).toHaveText('9007199254740993')
  await expect(page.getByTestId('grid-edit-error')).toHaveCount(0)
})

test('engine rejection: an invalid typed value alerts, rolls back, and leaves the grid recoverable', async ({
  page,
}) => {
  await openCustomersFixture(page)

  // Double-click the DATE column (signup_date, column 3). The client cannot
  // know `not-a-date` is invalid (temporal values defer to the engine), so the
  // engine's own message must surface and the commit must be recoverable.
  await openEditor(page, 0, 3)
  const editor = page.getByTestId('grid-editor-input')
  await expect(editor).toHaveValue('2025-01-04')
  await editor.fill('not-a-date')
  await editor.press('Enter')

  // Readable alert as text. The mvp bundle masks the underlying cast failure
  // as an opaque `_setThrew` glue error; the app translates that (and any
  // empty message) into a plain summary rather than showing glue.
  const alert = page.getByTestId('edit-error')
  await expect(alert).toBeVisible()
  await expect(alert).toContainText('rejected')
  await expect(alert).toContainText("the column's type rejected the value")
  await expect(alert).not.toContainText('_setThrew')

  // Recoverable: the previous effective view is restored — every row ready,
  // nothing left perpetually loading, and the edit is not in the history.
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')
  await expect(page.locator('[data-testid="grid-row"][data-status="ready"]')).toHaveCount(5)
  await expect(page.locator('[data-testid="grid-row"][data-status="loading"]')).toHaveCount(0)
  await expect(cell(page, 0, 3)).toHaveAttribute('data-dirty', 'false')
  await expect(page.getByTestId('edit-undo')).toBeDisabled()

  // A subsequent valid edit still works and clears the alert.
  await openEditor(page, 0, 2)
  await page.getByTestId('grid-editor-input').fill('12345')
  await page.getByTestId('grid-editor-input').press('Enter')
  await expect(cell(page, 0, 2)).toHaveText('12345')
  await expect(page.getByTestId('edit-error')).toHaveCount(0)
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')
})

test('temporal editing: a human-readable draft round-trips, and Enter-unchanged does not brick', async ({
  page,
}) => {
  await openCustomersFixture(page)

  // The editor opens with `2025-01-04` (the engine's epoch-ms value formatted
  // honestly), not the raw `1735948800000` that would fail `CAST(... AS DATE)`.
  await openEditor(page, 0, 3)
  const editor = page.getByTestId('grid-editor-input')
  await expect(editor).toHaveValue('2025-01-04')

  // Enter unchanged commits the same date as engine-parseable text: the cast
  // succeeds, the editor closes, and the grid stays healthy (no alert, no
  // perpetual loading).
  await editor.press('Enter')
  await expect(page.getByTestId('grid-cell-editor')).toHaveCount(0)
  await expect(page.locator('[data-testid="grid-row"][data-status="ready"]')).toHaveCount(5)
  await expect(page.locator('[data-testid="grid-row"][data-status="loading"]')).toHaveCount(0)
  await expect(page.getByTestId('edit-error')).toHaveCount(0)
  // Display formatting is out of m4-3 scope, so the cell still shows the
  // engine's epoch representation — but it is a ready cell, not an error.
  await expect(cell(page, 0, 3)).toHaveText('1735948800000')
})

test('NULL is a distinct affordance and rendering, never an empty string', async ({ page }) => {
  await openCustomersFixture(page)
  const country = cell(page, 0, 1)

  // Set NULL through the dedicated button.
  await openEditor(page, 0, 1)
  await page.getByTestId('grid-editor-null').click()
  await expect(page.getByTestId('grid-cell-editor')).toHaveCount(0)
  await expect(country).toHaveAttribute('data-null', 'true')
  await expect(country.getByTestId('grid-cell-null')).toHaveText('NULL')
  await expect(country).toHaveAttribute('data-dirty', 'true')
  await expect(country).toHaveText('NULL')

  // Undo → the base string is back and the cell is not NULL.
  await page.getByTestId('edit-undo').click()
  await expect(country).toHaveText('SG')
  await expect(country).not.toHaveAttribute('data-null', 'true')
  await expect(country.getByTestId('grid-cell-null')).toHaveCount(0)

  // An EMPTY STRING is a real value: it renders as an empty cell with no NULL
  // marker — visually and structurally distinct from NULL.
  await openEditor(page, 0, 1)
  await page.getByTestId('grid-editor-input').fill('')
  await page.getByTestId('grid-editor-input').press('Enter')
  await expect(country).toHaveText('')
  await expect(country.getByTestId('grid-cell-null')).toHaveCount(0)
  await expect(country).not.toHaveAttribute('data-null', 'true')
  await expect(country).toHaveAttribute('data-dirty', 'true')

  // Escape on a fresh editor leaves the value untouched (cancel ≠ commit).
  await openEditor(page, 0, 1)
  await page.getByTestId('grid-editor-input').fill('XX')
  await page.getByTestId('grid-editor-input').press('Escape')
  await expect(country).toHaveText('')
})

test('insert and delete row journeys are reversible', async ({ page }) => {
  await openCustomersFixture(page)

  // Insert: a new overlay row appears at the end (v1 placement), all NULL,
  // marked inserted.
  await page.getByTestId('edit-insert-row').click()
  await expect(page.getByTestId('grid-total-rows')).toHaveText('6')
  const insertedRow = row(page, 5)
  await expect(insertedRow).toHaveAttribute('data-inserted', 'true')
  await expect(insertedRow).toHaveAttribute('data-dirty', 'true')
  await expect(insertedRow.getByTestId('grid-cell').nth(0)).toHaveText('NULL')
  await expect(insertedRow.getByTestId('grid-cell').nth(1)).toHaveText('NULL')

  // The inserted row is editable like any other.
  await openEditor(page, 5, 1)
  await page.getByTestId('grid-editor-input').fill('ZZ')
  await page.getByTestId('grid-editor-input').press('Enter')
  await expect(row(page, 5).getByTestId('grid-cell').nth(1)).toHaveText('ZZ')

  // Delete another row: it leaves the effective view immediately.
  await row(page, 0).getByTestId('grid-row-delete').click()
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')
  await expectCustomerOrder(page, ['2', '3', '4', '5', 'NULL']) // id 1 gone; inserted row has NULL id

  // Undo the delete: the base row returns, in place.
  await page.getByTestId('edit-undo').click()
  await expect(page.getByTestId('grid-total-rows')).toHaveText('6')
  await expectCustomerOrder(page, ['1', '2', '3', '4', '5', 'NULL'])

  // Undo the edit, then the insert → fully clean again.
  await page.getByTestId('edit-undo').click() // undo the ZZ edit
  await expect(row(page, 5).getByTestId('grid-cell').nth(1)).toHaveText('NULL')
  await page.getByTestId('edit-undo').click() // undo the insert
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')
  await expectCustomerOrder(page, ['1', '2', '3', '4', '5'])
  await expect(row(page, 0)).toHaveAttribute('data-dirty', 'false')
  await expect(page.getByTestId('edit-undo')).toBeDisabled()
})

test('inspector freshness under edits: re-reads the same logical row, never a stale snapshot', async ({
  page,
}) => {
  await openCustomersFixture(page)

  // Open the inspector for row 0 (m3-3 click gesture), then edit a cell of the
  // very row it is inspecting. The pinned m4-3 policy: a value-only overlay
  // change re-reads the same logical row (the old snapshot never renders as
  // current); a later delete closes the panel (a structural shift).
  await waitForReadyRow(page, 0)
  await row(page, 0).click()
  const panel = page.getByTestId('record-inspector')
  await expect(panel).toBeVisible()
  const countryValue = panel.locator(
    "li[data-node-key='country'] > span.record-leaf > span[data-testid='record-node-value']",
  )
  await expect(countryValue).toHaveText('"SG"')

  await openEditor(page, 0, 1)
  await page.getByTestId('grid-editor-input').fill('ZZ')
  await page.getByTestId('grid-editor-input').press('Enter')
  // Reloaded from the fresh epoch — the edited value, not the stale 'SG'.
  await expect(page.getByTestId('record-inspector')).toBeVisible()
  await expect(countryValue).toHaveText('"ZZ"')

  // Deleting the inspected row changes the row count → the inspector closes.
  await waitForReadyRow(page, 0)
  await row(page, 0).getByTestId('grid-row-delete').click()
  await expect(page.getByTestId('record-inspector')).toHaveCount(0)
  await expect(page.getByTestId('grid-total-rows')).toHaveText('4')
})

test('rapid epoch changes settle consistently — no stale/in-flight window renders', async ({
  page,
}) => {
  await openCustomersFixture(page)

  // Interleave sort and filter changes without waiting between them: each
  // accepted change starts a fresh data epoch and the generation guard must
  // discard any page still in flight from the previous one. The final state
  // must reflect ONLY the last query, with no lingering loading placeholders.
  await page.locator('[data-testid="grid-sort-toggle"][data-col-name="income"]').click()
  await page.locator('[data-testid="filter-input"][data-col-name="country"]').fill("= 'US'")
  await page.locator('[data-testid="filter-apply"][data-col-name="country"]').click()
  await page.locator('[data-testid="grid-sort-toggle"][data-col-name="income"]').click() // desc

  await expect(page.getByTestId('grid-total-rows')).toHaveText('2')
  await expectCustomerOrder(page, ['5', '2']) // US by income desc
  await expect(
    page.locator(
      '[data-testid="grid-row"][data-status="ready"] [data-testid="grid-cell"]:nth-child(3)',
    ),
  ).toHaveText(['75000', '61000'])
  // The settled grid has no loading/error rows in the visible window and the
  // per-epoch fetch accounting is bounded (one window, never a rescan storm).
  await expect(page.locator('[data-testid="grid-row"][data-status="loading"]')).toHaveCount(0)
  const stats = await readGridStats(page)
  expect(stats.fetches).toBeGreaterThanOrEqual(1)
  expect(stats.requested).toBeLessThanOrEqual(10)

  // Clearing everything returns to natural order with all rows ready.
  await page.locator('[data-testid="filter-chip-remove"][data-col-name="country"]').click()
  await page.locator('[data-testid="grid-sort-toggle"][data-col-name="income"]').click() // clear
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')
  await expectCustomerOrder(page, ['1', '2', '3', '4', '5'])
  await expect(page.locator('[data-testid="grid-row"][data-status="loading"]')).toHaveCount(0)
})
