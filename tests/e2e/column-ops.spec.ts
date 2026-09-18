import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'

// Task m4-4 proof (handoff §6): column rename/cast UI over the m4-1 op model +
// the m4-2 overlay engine, the transformation-history panel with selective
// undo/redo, and the m4-3 carry-overs folded into this task (temporal
// unchanged-draft cancel; honest double-failure attribution is pinned by the
// happy-dom App component test `App.column-ops.test.tsx`).
//
// Fixture: customers.parquet (5 rows) —
//   customer_id country income     signup_date
//   1           SG      52000      2025-01-04
//   2           US      61000      2025-01-11
//   3           SG      NULL       2025-02-02
//   4           DE      48000      2025-02-19
//   5           US      75000      2025-03-01
//
// Requested pins:
//   1. rename round-trip: the affordance → effective grid header + values →
//      edits/insert values re-key under the new name → undo restores the old
//      name and values;
//   2. collision honesty: a rename onto an existing name is a readable typed
//      conflict and changes nothing;
//   3. cast round-trip: a target from the engine type space re-types the
//      values in the grid, undo restores;
//   4. cast failure class (a): invalid spelling refused pre-compose, no op;
//   5. cast failure class (b): a structurally valid but engine-rejected type
//      (schema materialization) and a legal cast whose values fail on a window
//      read both roll back, alert readably, and leave the grid recoverable;
//   6. history panel lists ops with human-readable descriptions + outcomes;
//   7. selective undo (cursor move) leaves a consistent grid (values + dirty
//      state) and redo moves forward; a rewind's redo tail is surfaced before
//      truncation and a new op truncates it;
//   8. panel undo/redo drives exactly the same history as the toolbar buttons.
//
// Privacy (ADR 0025): only schema/value text is asserted; the picked file name
// and opaque row anchors are never rendered.

const FIXTURE = path.join(process.cwd(), 'fixtures', 'parquet', 'customers.parquet')

test.beforeEach(async ({ page }) => {
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
  await expect(page.getByTestId('open-status')).toHaveText('idle')
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('open-button').click()
  const chooser = await chooserPromise
  await chooser.setFiles(FIXTURE)
  await expect(page.getByTestId('open-status')).toHaveText('ready')
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')
  await expect(page.getByTestId('table-info')).not.toContainText('customers.parquet')
}

function row(page: Page, index: number): Locator {
  return page.locator(`[data-testid="grid-row"][data-row-index="${String(index)}"]`)
}

function cell(page: Page, rowIndex: number, columnIndex: number): Locator {
  return row(page, rowIndex).getByTestId('grid-cell').nth(columnIndex)
}

function headerCell(page: Page, name: string): Locator {
  return page.locator(`[data-testid="grid-header-cell"][data-col-name="${name}"]`)
}

async function waitForReadyRow(page: Page, rowIndex: number): Promise<void> {
  await expect(row(page, rowIndex)).toHaveAttribute('data-status', 'ready')
}

async function openEditor(page: Page, rowIndex: number, columnIndex: number): Promise<void> {
  await waitForReadyRow(page, rowIndex)
  await cell(page, rowIndex, columnIndex).dblclick()
  await expect(page.getByTestId('grid-cell-editor')).toBeVisible()
}

async function editCell(
  page: Page,
  rowIndex: number,
  columnIndex: number,
  value: string,
): Promise<void> {
  await openEditor(page, rowIndex, columnIndex)
  await page.getByTestId('grid-editor-input').fill(value)
  await page.getByTestId('grid-editor-input').press('Enter')
  await expect(page.getByTestId('grid-cell-editor')).toHaveCount(0)
}

/** Open the per-column rename editor and commit a new name. */
async function renameColumn(page: Page, from: string, to: string): Promise<void> {
  const panel = page.getByTestId('schema-panel')
  await panel.locator(`[data-testid="column-rename-open"][data-col-name="${from}"]`).click()
  const input = panel.locator('[data-testid="column-rename-input"]')
  await input.fill(to)
  await input.press('Enter')
}

/** Open the per-column cast editor, choose a common target, and commit. */
async function castColumn(page: Page, column: string, target: string): Promise<void> {
  const panel = page.getByTestId('schema-panel')
  await panel.locator(`[data-testid="column-cast-open"][data-col-name="${column}"]`).click()
  await panel.locator('[data-testid="column-cast-select"]').selectOption(target)
  await panel.locator('[data-testid="column-cast-commit"]').click()
}

/** Open the per-column cast editor, enter a custom spelling, and commit. */
async function castColumnCustom(page: Page, column: string, target: string): Promise<void> {
  const panel = page.getByTestId('schema-panel')
  await panel.locator(`[data-testid="column-cast-open"][data-col-name="${column}"]`).click()
  await panel.locator('[data-testid="column-cast-select"]').selectOption('__custom__')
  await panel.locator('[data-testid="column-cast-custom"]').fill(target)
  await panel.locator('[data-testid="column-cast-commit"]').click()
}

test('column rename round-trips through the grid and re-keys edits; undo restores', async ({
  page,
}) => {
  await openCustomersFixture(page)

  // An edit made before the rename must follow the column to its new name.
  await editCell(page, 0, 1, 'ZZ')
  await expect(cell(page, 0, 1)).toHaveText('ZZ')
  await expect(cell(page, 0, 1)).toHaveAttribute('data-dirty', 'true')

  await renameColumn(page, 'country', 'nation')

  await expect(headerCell(page, 'nation')).toBeVisible()
  await expect(headerCell(page, 'country')).toHaveCount(0)
  await expect(headerCell(page, 'nation')).toHaveAttribute('data-col-type', 'VARCHAR')
  // The edit re-keyed: it is still visible (and dirty) under the new name.
  await expect(cell(page, 0, 1)).toHaveText('ZZ')
  await expect(cell(page, 0, 1)).toHaveAttribute('data-dirty', 'true')

  // Undo the rename: the old name is back, the edit is intact.
  await page.getByTestId('edit-undo').click()
  await expect(headerCell(page, 'country')).toBeVisible()
  await expect(cell(page, 0, 1)).toHaveText('ZZ')
  await expect(cell(page, 0, 1)).toHaveAttribute('data-dirty', 'true')

  // Undo the edit → fully clean.
  await page.getByTestId('edit-undo').click()
  await expect(cell(page, 0, 1)).toHaveText('SG')
  await expect(cell(page, 0, 1)).toHaveAttribute('data-dirty', 'false')
  await expect(page.getByTestId('edit-undo')).toBeDisabled()
})

test('a colliding rename is surfaced readably and leaves the schema unchanged', async ({
  page,
}) => {
  await openCustomersFixture(page)

  await renameColumn(page, 'country', 'income')

  const alert = page.getByTestId('edit-error')
  await expect(alert).toBeVisible()
  await expect(alert).toContainText('already exists')
  // Nothing applied: header unchanged, history empty, undo disabled.
  await expect(headerCell(page, 'country')).toBeVisible()
  await expect(headerCell(page, 'income')).toBeVisible()
  await expect(page.getByTestId('history-empty')).toBeVisible()
  await expect(page.getByTestId('edit-undo')).toBeDisabled()
})

test('column cast round-trips (values re-typed) and undo restores', async ({ page }) => {
  await openCustomersFixture(page)

  // DATE cells cross the boundary as epoch-ms numbers (m3-1), so the cast to
  // VARCHAR is visibly a re-typing: the same date renders as ISO text.
  await expect(headerCell(page, 'signup_date')).toHaveAttribute('data-col-type', 'DATE')
  await expect(cell(page, 0, 3)).toHaveText('1735948800000')

  await castColumn(page, 'signup_date', 'VARCHAR')

  await expect(headerCell(page, 'signup_date')).toHaveAttribute('data-col-type', 'VARCHAR')
  await expect(cell(page, 0, 3)).toHaveText('2025-01-04')

  // Undo restores the declared type and the epoch rendering.
  await page.getByTestId('edit-undo').click()
  await expect(headerCell(page, 'signup_date')).toHaveAttribute('data-col-type', 'DATE')
  await expect(cell(page, 0, 3)).toHaveText('1735948800000')
  await expect(page.getByTestId('edit-undo')).toBeDisabled()
})

test('a cast to the current type is an honest no-op surfaced with its outcome', async ({
  page,
}) => {
  await openCustomersFixture(page)

  await castColumn(page, 'income', 'BIGINT')

  const alert = page.getByTestId('edit-error')
  await expect(alert).toBeVisible()
  await expect(alert).toContainText('No change')
  await expect(alert).toContainText('already has that type')
  // The no-op is logged as an honest entry (m4-1) and rendered with its
  // outcome — never silently swallowed.
  await expect(page.getByTestId('history-item')).toHaveCount(1)
  await expect(page.getByTestId('history-outcome')).toHaveText('no-op: cast-identity')
  await expect(headerCell(page, 'income')).toHaveAttribute('data-col-type', 'BIGINT')
})

test('an invalid cast spelling is refused before composing an op', async ({ page }) => {
  await openCustomersFixture(page)

  await castColumnCustom(page, 'income', 'MAP(INTEGER)')

  await expect(page.getByTestId('column-op-error')).toContainText('not a valid column type')
  await expect(headerCell(page, 'income')).toHaveAttribute('data-col-type', 'BIGINT')
  await expect(page.getByTestId('history-empty')).toBeVisible()
  await expect(page.getByTestId('edit-undo')).toBeDisabled()
})

test('a structurally valid but engine-unknown cast rolls back and alerts recoverably', async ({
  page,
}) => {
  await openCustomersFixture(page)

  // `VARBIT` passes the client's structural validator, so it reaches the
  // engine, which rejects it at schema materialization (DESCRIBE). This is the
  // failure class the m4-3 rollback+alert path must own for schema ops.
  await castColumnCustom(page, 'income', 'VARBIT')

  const alert = page.getByTestId('edit-error')
  await expect(alert).toBeVisible()
  await expect(alert).toContainText('rejected')
  // Recoverable + rolled back: header unchanged, no history entry, undo off,
  // every row ready (never stuck loading).
  await expect(headerCell(page, 'income')).toHaveAttribute('data-col-type', 'BIGINT')
  await expect(page.getByTestId('history-empty')).toBeVisible()
  await expect(page.getByTestId('edit-undo')).toBeDisabled()
  await expect(page.locator('[data-testid="grid-row"][data-status="ready"]')).toHaveCount(5)
  await expect(page.locator('[data-testid="grid-row"][data-status="loading"]')).toHaveCount(0)
  await expect(cell(page, 0, 2)).toHaveText('52000')
})

test('a legal cast whose values cannot convert rolls back and alerts recoverably', async ({
  page,
}) => {
  await openCustomersFixture(page)

  // The engine accepts `INTEGER` as a type (schema + count succeed) but the
  // country values ('SG', 'US', …) cannot convert — this only fails on a
  // materializing window read, which the m4-4 value probe forces.
  await castColumn(page, 'country', 'INTEGER')

  const alert = page.getByTestId('edit-error')
  await expect(alert).toBeVisible()
  await expect(alert).toContainText('rejected')
  await expect(headerCell(page, 'country')).toHaveAttribute('data-col-type', 'VARCHAR')
  await expect(page.getByTestId('history-empty')).toBeVisible()
  await expect(page.getByTestId('edit-undo')).toBeDisabled()
  await expect(page.locator('[data-testid="grid-row"][data-status="ready"]')).toHaveCount(5)
  await expect(page.locator('[data-testid="grid-row"][data-status="loading"]')).toHaveCount(0)
  await expect(cell(page, 0, 1)).toHaveText('SG')

  // A subsequent valid edit still works and clears the alert.
  await editCell(page, 0, 2, '12345')
  await expect(cell(page, 0, 2)).toHaveText('12345')
  await expect(page.getByTestId('edit-error')).toHaveCount(0)
})

test('history panel lists ops and selective undo leaves a consistent grid', async ({ page }) => {
  await openCustomersFixture(page)

  await editCell(page, 0, 2, '11111')
  await editCell(page, 1, 2, '22222')
  await editCell(page, 3, 2, '33333')

  // The panel lists human-readable descriptions (row text + values) and outcomes.
  await expect(page.getByTestId('history-item')).toHaveCount(3)
  const first = page.locator('[data-testid="history-entry"][data-index="0"]')
  await expect(first).toContainText('set "income"')
  await expect(first).toContainText('11111')
  await expect(first.getByTestId('history-outcome')).toHaveText('applied')
  await expect(page.getByTestId('history-cursor')).toHaveText('Step 3 of 3 applied')

  // Selective undo: jump to the state after step 1 (cursor = 1), which must
  // leave a consistent grid — only row 0 edited, the rest at base values.
  await first.click()
  await expect(page.getByTestId('history-cursor')).toHaveText('Step 1 of 3 applied')
  await expect(cell(page, 0, 2)).toHaveText('11111')
  await expect(cell(page, 0, 2)).toHaveAttribute('data-dirty', 'true')
  await expect(cell(page, 1, 2)).toHaveText('61000')
  await expect(cell(page, 1, 2)).toHaveAttribute('data-dirty', 'false')
  await expect(cell(page, 3, 2)).toHaveText('48000')
  await expect(cell(page, 3, 2)).toHaveAttribute('data-dirty', 'false')
  await expect(page.getByTestId('pending-changes')).toContainText('1 pending change')
  await expect(page.locator('[data-testid="history-entry"][data-index="1"]')).toHaveAttribute(
    'data-applied',
    'false',
  )

  // Redo forward by clicking the last step — all three edits are applied again.
  await page.locator('[data-testid="history-entry"][data-index="2"]').click()
  await expect(page.getByTestId('history-cursor')).toHaveText('Step 3 of 3 applied')
  await expect(cell(page, 3, 2)).toHaveText('33333')
  await expect(cell(page, 3, 2)).toHaveAttribute('data-dirty', 'true')
})

test('a rewind surfaces its redo tail before a new op truncates it', async ({ page }) => {
  await openCustomersFixture(page)

  await editCell(page, 0, 2, '11111')
  await editCell(page, 1, 2, '22222')
  await expect(page.getByTestId('history-redo-tail')).toHaveCount(0)

  // Rewind to just after step 1: the tail is visible with an explicit warning.
  await page.locator('[data-testid="history-entry"][data-index="0"]').click()
  await expect(page.getByTestId('history-redo-tail')).toContainText('1 later step is undone')
  await expect(page.getByTestId('history-redo-tail')).toContainText('a new edit will discard it')
  await expect(cell(page, 1, 2)).toHaveText('61000')

  // A new op truncates the tail (m4-1 branch truncation) — the dropped step is
  // gone from the panel and the grid reflects only the surviving branch.
  await editCell(page, 3, 2, '44444')
  await expect(page.getByTestId('history-redo-tail')).toHaveCount(0)
  await expect(page.getByTestId('history-item')).toHaveCount(2)
  await expect(page.getByTestId('history-cursor')).toHaveText('Step 2 of 2 applied')
  await expect(page.locator('[data-testid="history-entry"][data-index="1"]')).toContainText('44444')
  await expect(cell(page, 1, 2)).toHaveText('61000')
  await expect(page.getByTestId('history-redo')).toBeDisabled()
})

test('panel undo/redo drives the same history as the toolbar buttons', async ({ page }) => {
  await openCustomersFixture(page)

  await editCell(page, 0, 2, '11111')
  await expect(page.getByTestId('edit-undo')).toBeEnabled()
  await expect(page.getByTestId('history-undo')).toBeEnabled()

  // Panel undo == toolbar undo (same cursor step).
  await page.getByTestId('history-undo').click()
  await expect(cell(page, 0, 2)).toHaveText('52000')
  await expect(page.getByTestId('edit-undo')).toBeDisabled()
  await expect(page.getByTestId('history-undo')).toBeDisabled()
  await expect(page.getByTestId('edit-redo')).toBeEnabled()
  await expect(page.getByTestId('history-redo')).toBeEnabled()

  // Toolbar redo moves the same cursor forward.
  await page.getByTestId('edit-redo').click()
  await expect(cell(page, 0, 2)).toHaveText('11111')
  await expect(page.getByTestId('history-redo')).toBeDisabled()
  await expect(page.getByTestId('history-undo')).toBeEnabled()

  // And panel redo matches the toolbar's disabled state at the end.
  await page.getByTestId('history-undo').click()
  await page.getByTestId('history-redo').click()
  await expect(cell(page, 0, 2)).toHaveText('11111')
  await expect(page.getByTestId('edit-redo')).toBeDisabled()
})

test('temporal Enter-unchanged is a cancel, not a spurious dirty edit (m4-3 carry-over a)', async ({
  page,
}) => {
  await openCustomersFixture(page)

  // Double-click the DATE cell and commit the prefilled draft unchanged.
  await openEditor(page, 0, 3)
  const editor = page.getByTestId('grid-editor-input')
  await expect(editor).toHaveValue('2025-01-04')
  await editor.press('Enter')

  await expect(page.getByTestId('grid-cell-editor')).toHaveCount(0)
  // The cell is NOT dirty and no step was logged: open+Enter cancelled.
  await expect(cell(page, 0, 3)).toHaveAttribute('data-dirty', 'false')
  await expect(page.getByTestId('pending-changes')).toHaveText('No pending changes.')
  await expect(page.getByTestId('edit-undo')).toBeDisabled()
  await expect(page.getByTestId('history-empty')).toBeVisible()
})
