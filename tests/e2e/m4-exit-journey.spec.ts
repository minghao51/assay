import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Download, Locator, Page } from '@playwright/test'

// Task m4-6 (handoff §6): the M4 exit-criterion journey — one continuous,
// adversarially-honest walk of the whole M4 promise over the real composition
// root served at '/' (first webServer in playwright.config.ts). The fixture is
// the committed golden customers.parquet (5 rows; income of customer 3 is
// NULL):
//
//   customer_id country income     signup_date
//   1           SG      52000      2025-01-04
//   2           US      61000      2025-01-11
//   3           SG      NULL       2025-02-02
//   4           DE      48000      2025-02-19
//   5           US      75000      2025-03-01
//
// Done-when (handoff §6, m4-6 row), clause by clause:
//   1. cold start (fresh context, no prior state) → open fixture through the
//      input-fallback filechooser pattern (m1-5);
//   2. capture the FULL pre-edit grid baseline — every cell's text, dirty/null
//      markers, headers with declared types, row/column counts — plus the
//      fixture file's sha256 from the Node side;
//   3. edit across the whole M4 surface: typed cell edit, set NULL, insert a
//      row (+ edit it), delete a row, rename a column, a SAFE cast, plus one
//      REFUSED cast mid-journey (proving a refusal appends nothing and
//      corrupts nothing), plus a formula-injection bait cell for the CSV leg;
//   4. undo EVERYTHING via the history panel and assert the grid is
//      byte-identical to the pre-edit baseline (exact same cells, order,
//      headers, types, markers, counts — no dirty markers, "No pending
//      changes.", undo disabled). This is the M4 core promise, asserted
//      totally, not spot;
//   5. re-apply a smaller edit set (one cell edit + one insert + its edit) so
//      the export legs carry edited state;
//   6. export Parquet AND CSV via the m4-5 download fallback; the success
//      line's row count matches the effective view (6);
//   7. assert the source fixture's checksum is unchanged — no edit, undo, or
//      export ever touched it (ADR 0012, asserted in-test from Node);
//   8. re-open both exports through the normal open flow and assert values
//      match the edited state (Parquet round-trips the declared types; the
//      CSV bait cell shows sanitized);
//   9. honesty sweep throughout: no in-place/overwrite claim anywhere in the
//      export UI, the source file name never renders in the app, and the
//      history/dirty indicators are exact after each phase.
//
// Picker path (m1-5/m4-5 pattern): an init script removes the FSA globals —
// `showOpenFilePicker` so opens ride the hidden-input fallback (capturable by
// Playwright's filechooser) and `showSaveFilePicker` so exports ride the
// anchor-download fallback (capturable as downloads). Privacy (ADR 0025): the
// picked file names are never asserted to render; only schema/value text is.

const FIXTURE = path.join(process.cwd(), 'fixtures', 'parquet', 'customers.parquet')

/** The fixture's DATE cells render as engine epoch-ms (m3-1 display policy). */
const EPOCH_2025_01_04 = '1735948800000'
const EPOCH_2025_03_01 = '1740787200000'

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

/** Node-side sha256 of a file — the source's immutable identity for the journey. */
function sha256(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

async function openFixture(page: Page, fixturePath: string): Promise<void> {
  await page.goto('/')
  await expect(page.getByTestId('open-status')).toHaveText('idle')
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('open-button').click()
  const chooser = await chooserPromise
  await chooser.setFiles(fixturePath)
  await expect(page.getByTestId('open-status')).toHaveText('ready')
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

/** Wait until every visible row has its data (the window fetch landed). */
async function settleGrid(page: Page, totalRows: number): Promise<void> {
  await expect(page.getByTestId('grid-total-rows')).toHaveText(String(totalRows))
  await expect(page.locator('[data-testid="grid-row"][data-status="ready"]')).toHaveCount(totalRows)
  await expect(page.locator('[data-testid="grid-row"][data-status="loading"]')).toHaveCount(0)
  await expect(page.locator('[data-testid="grid-row"][data-status="error"]')).toHaveCount(0)
}

/** Double-click a ready cell and wait for its inline editor. */
async function openEditor(page: Page, rowIndex: number, columnIndex: number): Promise<void> {
  await expect(row(page, rowIndex)).toHaveAttribute('data-status', 'ready')
  await cell(page, rowIndex, columnIndex).dblclick()
  await expect(page.getByTestId('grid-cell-editor')).toBeVisible()
}

/** Commit a typed value into a cell through the inline editor. */
async function editCell(
  page: Page,
  rowIndex: number,
  columnIndex: number,
  value: string,
): Promise<void> {
  await openEditor(page, rowIndex, columnIndex)
  const editor = page.getByTestId('grid-editor-input')
  await editor.fill(value)
  await editor.press('Enter')
  await expect(page.getByTestId('grid-cell-editor')).toHaveCount(0)
}

/** Commit NULL into a cell through the dedicated affordance (never '' or unset). */
async function setCellNull(page: Page, rowIndex: number, columnIndex: number): Promise<void> {
  await openEditor(page, rowIndex, columnIndex)
  await page.getByTestId('grid-editor-null').click()
  await expect(page.getByTestId('grid-cell-editor')).toHaveCount(0)
}

/** Rename a column through the schema panel. */
async function renameColumn(page: Page, from: string, to: string): Promise<void> {
  const panel = page.getByTestId('schema-panel')
  await panel.locator(`[data-testid="column-rename-open"][data-col-name="${from}"]`).click()
  const input = panel.locator('[data-testid="column-rename-input"]')
  await input.fill(to)
  await input.press('Enter')
}

/** Cast a column through the schema panel's target select. */
async function castColumn(page: Page, column: string, target: string): Promise<void> {
  const panel = page.getByTestId('schema-panel')
  await panel.locator(`[data-testid="column-cast-open"][data-col-name="${column}"]`).click()
  await panel.locator('[data-testid="column-cast-select"]').selectOption(target)
  await panel.locator('[data-testid="column-cast-commit"]').click()
}

// --- The byte-identical baseline ------------------------------------------------

/** One rendered cell: column key, text, dirty and NULL markers. */
interface CellSnapshot {
  readonly col: string
  readonly text: string
  readonly dirty: string
  readonly nullMarker: string | null
}

/** One rendered row: identity/status markers plus every cell. */
interface RowSnapshot {
  readonly index: number
  readonly status: string
  readonly dirty: string
  readonly inserted: string
  readonly cells: readonly CellSnapshot[]
}

/** The full rendered grid: headers (name + declared type) and every row. */
interface GridSnapshot {
  readonly headers: readonly { readonly name: string; readonly type: string }[]
  readonly rows: readonly RowSnapshot[]
  readonly totalRows: string
  readonly columnCount: string
}

/**
 * Capture the complete rendered grid. This is the journey's baseline: after
 * undo-everything the SAME capture must serialize byte-identically — same
 * cells, same order, same header names AND declared types, same dirty/null
 * markers, same counts.
 */
async function captureGrid(page: Page): Promise<GridSnapshot> {
  const headers = await page.locator('[data-testid="grid-header-cell"]').evaluateAll((els) =>
    els.map((el) => {
      const el2 = el as HTMLElement
      return { name: el2.dataset['colName'] ?? '', type: el2.dataset['colType'] ?? '' }
    }),
  )
  const rows = await page.locator('[data-testid="grid-row"]').evaluateAll((els) =>
    els
      .map((el) => {
        const el2 = el as HTMLElement
        return {
          index: Number(el2.dataset['rowIndex']),
          status: el2.dataset['status'] ?? '',
          dirty: el2.dataset['dirty'] ?? '',
          inserted: el2.dataset['inserted'] ?? '',
          cells: Array.from(el2.querySelectorAll('[data-testid="grid-cell"]')).map((c) => {
            const c2 = c as HTMLElement
            return {
              col: c2.dataset['colName'] ?? '',
              text: c2.textContent ?? '',
              dirty: c2.dataset['dirty'] ?? '',
              nullMarker: c2.querySelector('[data-testid="grid-cell-null"]')?.textContent ?? null,
            }
          }),
        }
      })
      .sort((a, b) => a.index - b.index),
  )
  return {
    headers,
    rows,
    totalRows: await page.getByTestId('grid-total-rows').innerText(),
    columnCount: await page.getByTestId('grid-column-count').innerText(),
  }
}

/** Canonical byte form of a snapshot (fixed key order → deterministic string). */
function serializeGrid(snapshot: GridSnapshot): string {
  return JSON.stringify(snapshot)
}

/** Export one format through the dialog, capturing the fallback download. */
async function exportFormat(page: Page, format: string): Promise<Download> {
  await page.getByTestId(`export-format-${format}`).check()
  const downloadPromise = page.waitForEvent('download')
  await page.getByTestId('export-confirm').click()
  return downloadPromise
}

/**
 * Playwright's `download.path()` is a generated temp name without the
 * suggested extension; the engine detects a file's format from the extension,
 * so persist the download under its suggested name (in a temp dir) before
 * reading or re-opening it.
 */
async function saveDownload(download: Download): Promise<string> {
  const target = path.join(
    tmpdir(),
    `assay-m4-6-${String(Date.now())}-${download.suggestedFilename()}`,
  )
  await download.saveAs(target)
  return target
}

test('M4 exit journey: edit everything, undo to a byte-identical grid, export, and the source never moved', async ({
  page,
}) => {
  test.setTimeout(300_000)

  // --- 1. Cold start: a fresh context with no prior state renders idle. ---
  await page.goto('/')
  await expect(page.getByTestId('open-status')).toHaveText('idle')
  await expect(page.getByTestId('edit-insert-row')).toHaveCount(0)
  await expect(page.getByTestId('history-empty')).toHaveCount(0)

  // --- 2. Open the fixture through the input-fallback filechooser. ---
  await openFixture(page, FIXTURE)
  await settleGrid(page, 5)
  // Privacy (ADR 0025): the picked file's name never renders.
  await expect(page.locator('main')).not.toContainText('customers.parquet')

  // Node side: the source's checksum, captured before ANY interaction.
  const sourceShaBefore = sha256(FIXTURE)

  // Full pre-edit baseline (every cell, header, marker, count).
  await settleGrid(page, 5)
  const baseline = serializeGrid(await captureGrid(page))
  // Sanity: the baseline is the documented fixture, clean and reversible-ready.
  expect(baseline).toContain('"totalRows":"5"')
  expect(baseline).toContain('"name":"customer_id","type":"BIGINT"')
  expect(baseline).toContain('"name":"signup_date","type":"DATE"')
  expect(page.getByTestId('pending-changes')).toHaveText('No pending changes.')
  await expect(page.getByTestId('edit-undo')).toBeDisabled()
  await expect(page.getByTestId('history-empty')).toBeVisible()

  // --- 3. Edit across the whole M4 surface (8 applied ops). ---
  // op1: a typed cell edit (BIGINT income).
  await editCell(page, 0, 2, '123456')
  await expect(cell(page, 0, 2)).toHaveText('123456')
  await expect(cell(page, 0, 2)).toHaveAttribute('data-dirty', 'true')
  await settleGrid(page, 5)

  // op2: set a cell NULL through the dedicated affordance.
  await setCellNull(page, 1, 1) // country of customer 2
  await expect(cell(page, 1, 1)).toHaveAttribute('data-null', 'true')
  await expect(cell(page, 1, 1)).toHaveText('NULL')
  await settleGrid(page, 5)

  // op3: insert a row (appended, all NULL, marked inserted).
  await page.getByTestId('edit-insert-row').click()
  await settleGrid(page, 6)
  await expect(row(page, 5)).toHaveAttribute('data-inserted', 'true')
  await expect(row(page, 5)).toHaveAttribute('data-dirty', 'true')

  // op4: edit the inserted row (so exports carry its values).
  await editCell(page, 5, 1, 'ZZ')
  await expect(cell(page, 5, 1)).toHaveText('ZZ')

  // op5: delete a base row (customer 5, the last base row).
  await row(page, 4).getByTestId('grid-row-delete').click()
  await settleGrid(page, 5)
  await expect(cell(page, 4, 0)).toHaveText('NULL') // the inserted row moved up

  // op6: rename a column.
  await renameColumn(page, 'country', 'nation')
  await expect(headerCell(page, 'nation')).toBeVisible()
  await expect(headerCell(page, 'country')).toHaveCount(0)
  await settleGrid(page, 5)
  await expect(page.getByTestId('grid-column-count')).toHaveText('4')

  // op7: a SAFE cast (BIGINT → DOUBLE) — the journey must continue through it.
  await castColumn(page, 'income', 'DOUBLE')
  await expect(headerCell(page, 'income')).toHaveAttribute('data-col-type', 'DOUBLE')
  await expect(page.getByTestId('edit-error')).toHaveCount(0)
  await settleGrid(page, 5)
  await expect(cell(page, 0, 2)).toHaveText('123456') // same value, re-typed column

  // A REFUSED cast mid-journey: VARCHAR values cannot convert to INTEGER.
  // Nothing may be appended, nothing may change — refusals must not corrupt
  // the history the undo leg is about to trust.
  await castColumn(page, 'nation', 'INTEGER')
  const refusal = page.getByTestId('edit-error')
  await expect(refusal).toBeVisible()
  await expect(refusal).toContainText('Cannot cast "nation" to INTEGER')
  await expect(refusal).toContainText('No cast was applied')
  await expect(headerCell(page, 'nation')).toHaveAttribute('data-col-type', 'VARCHAR')
  await expect(page.getByTestId('history-item')).toHaveCount(7)
  await expect(page.getByTestId('history-cursor')).toHaveText('Step 7 of 7 applied')
  await expect(page.getByTestId('edit-undo')).toBeEnabled()
  await expect(cell(page, 0, 1)).toHaveText('SG') // grid untouched by the refusal

  // op8: the formula-injection bait cell (for the CSV leg). A new op also
  // proves the grid is still healthy after the refusal, and clears the alert.
  await editCell(page, 3, 1, '=SUM(A1:A2)') // nation of customer 4
  await expect(cell(page, 3, 1)).toHaveText('=SUM(A1:A2)')
  await expect(page.getByTestId('edit-error')).toHaveCount(0)
  await settleGrid(page, 5)

  // The fully-edited shape: 8 applied steps, every indicator exact.
  await expect(page.getByTestId('history-item')).toHaveCount(8)
  await expect(page.getByTestId('history-cursor')).toHaveText('Step 8 of 8 applied')
  await expect(page.getByTestId('history-redo')).toBeDisabled()
  await expect(page.getByTestId('edit-redo')).toBeDisabled()
  await expect(page.getByTestId('pending-changes')).toHaveText(
    '8 pending changes: 4 cell edits, 1 row insert, 1 row delete, 1 column rename, 1 column cast.',
  )
  const editedSnapshot = await captureGrid(page)
  const edited = serializeGrid(editedSnapshot)
  expect(edited).toContain('"name":"nation","type":"VARCHAR"')
  expect(edited).toContain('"name":"income","type":"DOUBLE"')
  expect(edited).toContain('=SUM(A1:A2)')
  expect(edited).not.toBe(baseline)

  // --- 4. Undo EVERYTHING via the history panel. ---
  // Row counts after each undo (from cursor 8 down to 0), as each op reverses.
  const rowsAfterEachUndo = [5, 5, 5, 6, 6, 5, 5, 5]
  for (let expectedCursor = 7; expectedCursor >= 0; expectedCursor--) {
    await page.getByTestId('edit-undo').click()
    await expect(page.getByTestId('history-cursor')).toHaveText(
      `Step ${String(expectedCursor)} of 8 applied`,
    )
    await settleGrid(page, rowsAfterEachUndo[7 - expectedCursor])
  }
  await expect(page.getByTestId('edit-undo')).toBeDisabled()
  await expect(page.getByTestId('edit-redo')).toBeEnabled()
  await expect(page.getByTestId('history-redo-tail')).toContainText('8 later steps are undone')
  await expect(page.getByTestId('pending-changes')).toHaveText('No pending changes.')

  // THE M4 CORE PROMISE, asserted totally: the grid is byte-identical to the
  // pre-edit baseline — every cell text, order, header name AND declared
  // type, every dirty/null marker, the row and column counts.
  const afterUndo = serializeGrid(await captureGrid(page))
  expect(afterUndo).toBe(baseline)
  // Privacy never lapsed: still no source file name anywhere in the app.
  await expect(page.locator('main')).not.toContainText('customers.parquet')

  // --- 5. Redo/re-edit leg: a smaller edit set for the export legs. ---
  // Selective cursor move back to "after step 2" (income edit + NULL applied;
  // everything else stays undone in the redo tail).
  await page.locator('[data-testid="history-entry"][data-index="1"]').click()
  await expect(page.getByTestId('history-cursor')).toHaveText('Step 2 of 8 applied')
  await expect(page.getByTestId('history-redo-tail')).toContainText('6 later steps are undone')
  await expect(cell(page, 0, 2)).toHaveText('123456')
  await expect(cell(page, 0, 2)).toHaveAttribute('data-dirty', 'true')
  await expect(cell(page, 1, 1)).toHaveAttribute('data-null', 'true')
  await expect(cell(page, 3, 1)).toHaveText('DE') // bait still undone
  await settleGrid(page, 5)

  // A fresh cell edit truncates the redo tail (the panel said so first).
  await editCell(page, 3, 1, '=SUM(A1:A2)')
  await expect(page.getByTestId('history-redo-tail')).toHaveCount(0)
  await expect(page.getByTestId('history-item')).toHaveCount(3)
  await expect(page.getByTestId('history-cursor')).toHaveText('Step 3 of 3 applied')

  // Plus one insert and its cell edit — the brief's minimum re-edit set.
  await page.getByTestId('edit-insert-row').click()
  await settleGrid(page, 6)
  await editCell(page, 5, 1, 'ZZ')
  await expect(page.getByTestId('history-item')).toHaveCount(5)
  await expect(page.getByTestId('history-cursor')).toHaveText('Step 5 of 5 applied')
  await expect(page.getByTestId('pending-changes')).toHaveText(
    '5 pending changes: 4 cell edits, 1 row insert.',
  )

  // The re-edited effective view: original schema (rename/cast stay undone),
  // row 0 income edited, row 1 country NULL, row 3 bait, inserted ZZ row.
  await settleGrid(page, 6)
  const reEdited = serializeGrid(await captureGrid(page))
  expect(reEdited).toContain('"name":"country","type":"VARCHAR"')
  expect(reEdited).toContain('"name":"income","type":"BIGINT"')
  expect(reEdited).toContain('=SUM(A1:A2)')
  expect(reEdited).toContain('"text":"ZZ"')

  // --- 6. Export Parquet and CSV from the edited state. ---
  await page.getByTestId('export-open').click()
  const dialog = page.getByTestId('export-dialog')
  await expect(dialog).toBeVisible()
  // Honesty: copy, never rewrite (ADR 0012); the effective count, not a lie.
  await expect(page.getByTestId('export-copy-notice')).toContainText('new file')
  await expect(page.getByTestId('export-copy-notice')).toContainText(
    'The opened file is not changed',
  )
  await expect(dialog).not.toContainText(/overwrit|in place|in-place/i)
  await expect(page.getByTestId('export-view-rows')).toHaveText('6 rows')

  const parquetDownload = await exportFormat(page, 'parquet')
  await expect(page.getByTestId('export-result')).toContainText('Exported 6 rows as Parquet')
  await expect(page.getByTestId('export-result')).toContainText('The opened file is unchanged')
  await expect(page.getByTestId('export-reopen-hint')).toContainText('choose the file you wrote')
  const parquetPath = await saveDownload(parquetDownload)
  // The bytes are really Parquet (the magic the open flow will read).
  expect(readFileSync(parquetPath).subarray(0, 4).toString('latin1')).toBe('PAR1')

  const csvDownload = await exportFormat(page, 'csv')
  await expect(page.getByTestId('export-result')).toContainText('Exported 6 rows as CSV')
  await expect(page.getByTestId('export-result')).toContainText(
    'your browser is downloading it as a new file',
  )
  const csvPath = await saveDownload(csvDownload)
  await page.getByTestId('export-close').click()
  await expect(dialog).toHaveCount(0)

  // Node side: the CSV copy really holds the edited state, bait sanitized.
  const csvLines = readFileSync(csvPath, 'utf8').trimEnd().split('\n')
  expect(csvLines).toHaveLength(7) // header + 6 rows
  expect(csvLines[0]).toBe('customer_id,country,income,signup_date')
  expect(csvLines.some((line) => line.includes("'=SUM(A1:A2)"))).toBe(true) // sanitized
  expect(csvLines.some((line) => line.includes(',=SUM(A1:A2)'))).toBe(false) // never raw
  expect(csvLines.some((line) => line.startsWith('1,SG,123456,'))).toBe(true) // edited cell
  expect(csvLines.some((line) => line.startsWith('2,,61000,'))).toBe(true) // NULL country
  expect(csvLines.some((line) => line === ',ZZ,,')).toBe(true) // inserted row
  expect(csvLines.some((line) => line.startsWith('5,US,75000,'))).toBe(true) // delete undone

  // --- 7. The source was never touched by any edit, undo, or export. ---
  expect(sha256(FIXTURE)).toBe(sourceShaBefore)

  // --- 8. Re-open the Parquet export through the normal open flow. ---
  await openFixture(page, parquetPath)
  await settleGrid(page, 6)
  // Privacy: the re-opened export's own name renders nowhere either.
  await expect(page.locator('main')).not.toContainText('customers.parquet')
  // Parquet round-trips the declared column types exactly…
  await expect(headerCell(page, 'customer_id')).toHaveAttribute('data-col-type', 'BIGINT')
  await expect(headerCell(page, 'country')).toHaveAttribute('data-col-type', 'VARCHAR')
  await expect(headerCell(page, 'income')).toHaveAttribute('data-col-type', 'BIGINT')
  await expect(headerCell(page, 'signup_date')).toHaveAttribute('data-col-type', 'DATE')
  // …and the values match the edited state.
  await expect(cell(page, 0, 2)).toHaveText('123456') // edited income
  await expect(cell(page, 0, 3)).toHaveText(EPOCH_2025_01_04) // DATE re-renders as epoch
  await expect(cell(page, 1, 1)).toHaveAttribute('data-null', 'true') // the NULL edit
  await expect(cell(page, 3, 1)).toHaveText('=SUM(A1:A2)') // bait raw in Parquet
  await expect(cell(page, 4, 0)).toHaveText('5') // delete stays undone
  await expect(cell(page, 4, 2)).toHaveText('75000')
  await expect(cell(page, 4, 3)).toHaveText(EPOCH_2025_03_01)
  await expect(cell(page, 5, 1)).toHaveText('ZZ') // the inserted row round-trips
  await expect(row(page, 5)).not.toHaveAttribute('data-inserted') // a new base version
  // A re-opened file is a fresh session: clean indicators, no overlay.
  await expect(page.getByTestId('history-empty')).toBeVisible()
  await expect(page.getByTestId('pending-changes')).toHaveText('No pending changes.')
  await expect(cell(page, 0, 2)).toHaveAttribute('data-dirty', 'false')

  // --- 9. Re-open the CSV export; the bait cell comes back sanitized. ---
  await openFixture(page, csvPath)
  await settleGrid(page, 6)
  await expect(page.locator('main')).not.toContainText('customers.parquet')
  await expect(page.getByTestId('grid-column-count')).toHaveText('4')
  await expect(cell(page, 0, 2)).toHaveText('123456') // edited income
  // The sanitized value is the literal text the CSV carries (leading
  // apostrophe) — never the raw formula.
  await expect(cell(page, 3, 1)).toHaveText("'=SUM(A1:A2)")
  await expect(cell(page, 5, 1)).toHaveText('ZZ') // the inserted row
  await expect(page.getByTestId('history-empty')).toBeVisible()

  // Final honesty sweep: the whole journey never rendered the source's name.
  await expect(page.locator('main')).not.toContainText('customers.parquet')
})
