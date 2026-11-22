import { expect, test } from './support/fixture'
import type { Page } from '@playwright/test'
import { activateTask, openCustomersFixture } from './support/fixtures'
import { castColumn, cell, editCell, headerCell, openEditor, renameColumn } from './support/grid'

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
//   8. the history panel's single undo/redo pair drives the same history
//      cursor (the toolbar pair was removed in ux-3).
//
// Privacy (ADR 0025): only schema/value text is asserted; the picked file name
// and opaque row anchors are never rendered.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
    } catch {
      // Non-configurable global would be a Chromium change; fail loudly later.
    }
  })
})

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

  // rd-3b: the editing toolbar (`edit-error`, `pending-changes`) and the
  // transformation history are Change-task surfaces, so the task is activated
  // before they are read or clicked.
  await activateTask(page, 'change')
  // Undo the rename: the old name is back, the edit is intact.
  await page.getByTestId('history-undo').click()
  await expect(headerCell(page, 'country')).toBeVisible()
  await expect(cell(page, 0, 1)).toHaveText('ZZ')
  await expect(cell(page, 0, 1)).toHaveAttribute('data-dirty', 'true')

  // Undo the edit → fully clean.
  await page.getByTestId('history-undo').click()
  await expect(cell(page, 0, 1)).toHaveText('SG')
  await expect(cell(page, 0, 1)).toHaveAttribute('data-dirty', 'false')
  await expect(page.getByTestId('history-undo')).toBeDisabled()
})

test('a colliding rename is surfaced readably and leaves the schema unchanged', async ({
  page,
}) => {
  await openCustomersFixture(page)

  await renameColumn(page, 'country', 'income')

  // rd-3b: the editing toolbar (`edit-error`, `pending-changes`) and the
  // transformation history are Change-task surfaces, so the task is activated
  // before they are read or clicked.
  await activateTask(page, 'change')
  const alert = page.getByTestId('edit-error')
  await expect(alert).toBeVisible()
  await expect(alert).toContainText('already exists')
  // Nothing applied: header unchanged, history empty, undo disabled.
  await expect(headerCell(page, 'country')).toBeVisible()
  await expect(headerCell(page, 'income')).toBeVisible()
  await expect(page.getByTestId('history-empty')).toBeVisible()
  await expect(page.getByTestId('history-undo')).toBeDisabled()
})

test('column cast round-trips (values re-typed) and undo restores', async ({ page }) => {
  await openCustomersFixture(page)

  // wf-01: a DATE cell now renders its calendar day (the approved WFD-06=B
  // display), so the cast to VARCHAR is no longer visible in the CELL TEXT —
  // it is visible in the DECLARED TYPE, which is what this test pins at each
  // stage: DATE → VARCHAR (engine re-typing) → undo back to DATE.
  await expect(headerCell(page, 'signup_date')).toHaveAttribute('data-col-type', 'DATE')
  await expect(cell(page, 0, 3)).toHaveText('2025-01-04')

  await castColumn(page, 'signup_date', 'VARCHAR')

  await expect(headerCell(page, 'signup_date')).toHaveAttribute('data-col-type', 'VARCHAR')
  await expect(cell(page, 0, 3)).toHaveText('2025-01-04')

  // rd-3b: the editing toolbar (`edit-error`, `pending-changes`) and the
  // transformation history are Change-task surfaces, so the task is activated
  // before they are read or clicked.
  await activateTask(page, 'change')
  // Undo restores the declared type (and with it the DATE display).
  await page.getByTestId('history-undo').click()
  await expect(headerCell(page, 'signup_date')).toHaveAttribute('data-col-type', 'DATE')
  await expect(cell(page, 0, 3)).toHaveText('2025-01-04')
  await expect(page.getByTestId('history-undo')).toBeDisabled()
})

test('the schema panel re-keys after rename; cast-after-rename works through the panel', async ({
  page,
}) => {
  await openCustomersFixture(page)

  // Rename income → salary through the panel.
  await renameColumn(page, 'income', 'salary')
  await expect(headerCell(page, 'salary')).toBeVisible()

  // The panel (the surface hosting Rename/Cast) must follow the model's
  // asynchronous schema re-key, or the next op targets the pre-rename name.
  const panel = page.getByTestId('schema-panel')
  const salaryColumn = panel.locator('[data-testid="schema-column"][data-col-name="salary"]')
  await expect(salaryColumn).toBeVisible()
  await expect(panel.locator('[data-testid="schema-column"][data-col-name="income"]')).toHaveCount(
    0,
  )
  await expect(salaryColumn.getByTestId('schema-type-badge')).toHaveText('BIGINT')

  // Cast the *renamed* column through the panel: a stale panel would emit
  // `income` and fail with an unknown-overlay-column engine error. Here it
  // must apply cleanly, re-typing the values and the panel badge.
  await castColumn(page, 'salary', 'DOUBLE')
  await expect(headerCell(page, 'salary')).toHaveAttribute('data-col-type', 'DOUBLE')
  await expect(salaryColumn.getByTestId('schema-type-badge')).toHaveText('DOUBLE')
  await expect(page.getByTestId('edit-error')).toHaveCount(0)
  await expect(cell(page, 0, 2)).toHaveText('52000')
})

test('a cast to the current type is an honest no-op surfaced with its outcome', async ({
  page,
}) => {
  await openCustomersFixture(page)

  await castColumn(page, 'income', 'BIGINT')

  // rd-3b: the editing toolbar (`edit-error`, `pending-changes`) and the
  // transformation history are Change-task surfaces, so the task is activated
  // before they are read or clicked.
  await activateTask(page, 'change')
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

  // rd-3b: the editing toolbar (`edit-error`, `pending-changes`) and the
  // transformation history are Change-task surfaces, so the task is activated
  // before they are read or clicked.
  await activateTask(page, 'change')
  await expect(page.getByTestId('column-op-error')).toContainText('not a valid column type')
  await expect(headerCell(page, 'income')).toHaveAttribute('data-col-type', 'BIGINT')
  await expect(page.getByTestId('history-empty')).toBeVisible()
  await expect(page.getByTestId('history-undo')).toBeDisabled()
})

test('a structurally valid but engine-rejected cast rolls back and alerts recoverably', async ({
  page,
}) => {
  await openCustomersFixture(page)

  // `TIMESTAMP(10)` passes the client's structural validator (one integer
  // modifier), so it reaches the engine, which rejects it at schema
  // materialization (precision above the supported 9). This is the failure
  // class the m4-3 rollback+alert path must own for schema ops.
  await castColumnCustom(page, 'income', 'TIMESTAMP(10)')

  // rd-3b: the editing toolbar (`edit-error`, `pending-changes`) and the
  // transformation history are Change-task surfaces, so the task is activated
  // before they are read or clicked.
  await activateTask(page, 'change')
  const alert = page.getByTestId('edit-error')
  await expect(alert).toBeVisible()
  await expect(alert).toContainText('rejected')
  // Recoverable + rolled back: header unchanged, no history entry, undo off,
  // every row ready (never stuck loading).
  await expect(headerCell(page, 'income')).toHaveAttribute('data-col-type', 'BIGINT')
  await expect(page.getByTestId('history-empty')).toBeVisible()
  await expect(page.getByTestId('history-undo')).toBeDisabled()
  await expect(page.locator('[data-testid="grid-row"][data-status="ready"]')).toHaveCount(5)
  await expect(page.locator('[data-testid="grid-row"][data-status="loading"]')).toHaveCount(0)
  await expect(cell(page, 0, 2)).toHaveText('52000')
})

test('a cast whose NON-FIRST-ROW values cannot convert is refused before commit (m4-4 fix)', async ({
  page,
}) => {
  await openCustomersFixture(page)

  // The reviewer's case: make row 0 convertible (so the old bounded 1-row
  // probe passed and the broken cast committed), while rows 1–4 still cannot
  // convert. Value-level validation must happen BEFORE the op is appended.
  await editCell(page, 0, 1, '123')
  await expect(cell(page, 0, 1)).toHaveText('123')

  await castColumn(page, 'country', 'INTEGER')

  // rd-3b: the editing toolbar (`edit-error`, `pending-changes`) and the
  // transformation history are Change-task surfaces, so the task is activated
  // before they are read or clicked.
  await activateTask(page, 'change')
  const alert = page.getByTestId('edit-error')
  await expect(alert).toBeVisible()
  await expect(alert).toContainText('cannot convert')
  await expect(alert).toContainText('No cast was applied')
  // No cast committed: history holds exactly the one cell edit, the declared
  // type is unchanged, and every row keeps rendering (never the old all-`!`
  // state with a `Retry 1 failed window` footer that could never recover).
  await expect(page.getByTestId('history-item')).toHaveCount(1)
  await expect(page.getByTestId('history-cursor')).toHaveText('Step 1 of 1 applied')
  await expect(headerCell(page, 'country')).toHaveAttribute('data-col-type', 'VARCHAR')
  await expect(page.locator('[data-testid="grid-row"][data-status="ready"]')).toHaveCount(5)
  await expect(page.locator('[data-testid="grid-row"][data-status="loading"]')).toHaveCount(0)
  await expect(page.locator('[data-testid="grid-row"][data-status="error"]')).toHaveCount(0)
  await expect(cell(page, 1, 1)).toHaveText('US')

  // A subsequent valid cast still works and clears the refusal. The cast
  // control lives in Schema (Explore), so the task is switched back first.
  await activateTask(page, 'explore')
  await castColumn(page, 'income', 'DOUBLE')
  await expect(headerCell(page, 'income')).toHaveAttribute('data-col-type', 'DOUBLE')
  await expect(page.getByTestId('edit-error')).toHaveCount(0)
  await expect(page.getByTestId('history-item')).toHaveCount(2)
})

test('casting to DECIMAL(10,2) renders readable decimals, not <16 bytes> (m4-4 warning)', async ({
  page,
}) => {
  await openCustomersFixture(page)

  await castColumn(page, 'income', 'DECIMAL(10,2)')

  await expect(headerCell(page, 'income')).toHaveAttribute('data-col-type', 'DECIMAL(10,2)')
  await expect(cell(page, 0, 2)).toHaveText('52000.00')
  await expect(cell(page, 1, 2)).toHaveText('61000.00')
  await expect(cell(page, 3, 2)).toHaveText('48000.00')
  await expect(cell(page, 4, 2)).toHaveText('75000.00')
  // The schema panel badge follows the cast (subscription freshness).
  await expect(
    page
      .getByTestId('schema-panel')
      .locator('[data-testid="schema-column"][data-col-name="income"]')
      .getByTestId('schema-type-badge'),
  ).toHaveText('DECIMAL(10,2)')
  // Row 2's income is NULL → the dedicated null marker, distinct from a
  // byte summary.
  await expect(cell(page, 2, 2)).toHaveAttribute('data-null', 'true')
  await expect(cell(page, 2, 2)).toHaveText('NULL')
  // The old `<16 bytes>` summary is gone from every rendered cell.
  await expect(page.getByTestId('grid-cell').filter({ hasText: 'bytes' })).toHaveCount(0)

  // rd-3b: the editing toolbar (`edit-error`, `pending-changes`) and the
  // transformation history are Change-task surfaces, so the task is activated
  // before they are read or clicked.
  await activateTask(page, 'change')
  // Undo restores the BIGINT rendering exactly.
  await page.getByTestId('history-undo').click()
  await expect(headerCell(page, 'income')).toHaveAttribute('data-col-type', 'BIGINT')
  await expect(cell(page, 0, 2)).toHaveText('52000')
})

test('a legal cast whose values cannot convert rolls back and alerts recoverably', async ({
  page,
}) => {
  await openCustomersFixture(page)

  // The engine accepts `INTEGER` as a type (schema + count succeed) but the
  // country values ('SG', 'US', …) cannot convert. The pre-commit cast check
  // refuses it before an op is appended (m4-4 fix; previously a partial
  // window probe was relied on here).
  await castColumn(page, 'country', 'INTEGER')

  // rd-3b: the editing toolbar (`edit-error`, `pending-changes`) and the
  // transformation history are Change-task surfaces, so the task is activated
  // before they are read or clicked.
  await activateTask(page, 'change')
  const alert = page.getByTestId('edit-error')
  await expect(alert).toBeVisible()
  await expect(alert).toContainText('No cast was applied')
  await expect(headerCell(page, 'country')).toHaveAttribute('data-col-type', 'VARCHAR')
  await expect(page.getByTestId('history-empty')).toBeVisible()
  await expect(page.getByTestId('history-undo')).toBeDisabled()
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

  // rd-3b: the editing toolbar (`edit-error`, `pending-changes`) and the
  // transformation history are Change-task surfaces, so the task is activated
  // before they are read or clicked.
  await activateTask(page, 'change')
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

  // rd-3b: the editing toolbar (`edit-error`, `pending-changes`) and the
  // transformation history are Change-task surfaces, so the task is activated
  // before they are read or clicked.
  await activateTask(page, 'change')
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

test('history-panel undo/redo drive the transformation history', async ({ page }) => {
  await openCustomersFixture(page)
  // rd-3b: the editing toolbar (`edit-error`, `pending-changes`) and the
  // transformation history are Change-task surfaces, so the task is activated
  // before they are read or clicked.
  await activateTask(page, 'change')

  await editCell(page, 0, 2, '11111')
  await expect(page.getByTestId('history-undo')).toBeEnabled()

  // Undo moves the cursor back one step.
  await page.getByTestId('history-undo').click()
  await expect(cell(page, 0, 2)).toHaveText('52000')
  await expect(page.getByTestId('history-undo')).toBeDisabled()
  await expect(page.getByTestId('history-redo')).toBeEnabled()

  // Redo moves the same cursor forward.
  await page.getByTestId('history-redo').click()
  await expect(cell(page, 0, 2)).toHaveText('11111')
  await expect(page.getByTestId('history-redo')).toBeDisabled()
  await expect(page.getByTestId('history-undo')).toBeEnabled()

  // A fresh undo-then-redo round trip lands on the same state.
  await page.getByTestId('history-undo').click()
  await page.getByTestId('history-redo').click()
  await expect(cell(page, 0, 2)).toHaveText('11111')
  await expect(page.getByTestId('history-redo')).toBeDisabled()
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
  // rd-3b: the editing toolbar (`edit-error`, `pending-changes`) and the
  // transformation history are Change-task surfaces, so the task is activated
  // before they are read or clicked.
  await activateTask(page, 'change')
  await expect(page.getByTestId('pending-changes')).toHaveText('No pending changes.')
  await expect(page.getByTestId('history-undo')).toBeDisabled()
  await expect(page.getByTestId('history-empty')).toBeVisible()
})
