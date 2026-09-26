import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Download, Page } from '@playwright/test'
import { openFixture } from './support/fixtures'
import {
  castColumn,
  cell,
  editCell,
  headerCell,
  openEditor,
  renameColumn,
  row,
} from './support/grid'
import { sha256File } from './support/hash'

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

/**
 * The ENTIRE expected CSV export, byte for byte (review finding: the previous
 * partial checks ignored the final newline, row order, quoting, dates, and
 * whole cells). Provenance: derived from the known effective rows of the
 * re-edit leg below — header `customer_id,country,income,signup_date`; row 0
 * income edited to 123456; row 1 country NULL; row 3 country = the bait,
 * sanitized by the engine's in-SELECT apostrophe guard; row 4 = the
 * delete-undone customer 5; row 5 = the inserted all-NULL-but-ZZ row — under
 * the engine's pinned COPY options (packages/engine-duckdb/src/overlay-query.ts
 * `EXPORT_FORMAT_OPTIONS.csv`: `FORMAT CSV, HEADER true, DELIMITER ',', QUOTE
 * '"', ESCAPE '"'`), which render DATE as ISO, NULL as an empty field, and
 * quote nothing here (no cell contains a delimiter, quote, or newline).
 * Cross-checked ONCE in a scratch run (DuckDB CLI v1.5.5 via /tmp/duckdb,
 * identical COPY options and guard form) — same bytes, final newline
 * included. The trailing empty element yields the final `\n` byte.
 */
const EXPECTED_CSV_BYTES = [
  'customer_id,country,income,signup_date',
  '1,SG,123456,2025-01-04',
  '2,,61000,2025-01-11',
  '3,SG,,2025-02-02',
  "4,'=SUM(A1:A2),48000,2025-02-19",
  '5,US,75000,2025-03-01',
  ',ZZ,,',
  '',
].join('\n')

/**
 * Wording banned anywhere in the export surface (ADR 0012: copy, never
 * rewrite). Asserted before the dialog opens AND after each success result
 * renders (review finding: the ban used to run only before any result
 * existed, so forbidden wording in a success line escaped the journey).
 */
const BANNED_EXPORT_WORDING = /overwrit|in place|in-place/i

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

/** Wait until every visible row has its data (the window fetch landed). */
async function settleGrid(page: Page, totalRows: number): Promise<void> {
  await expect(page.getByTestId('grid-total-rows')).toHaveText(String(totalRows))
  await expect(page.locator('[data-testid="grid-row"][data-status="ready"]')).toHaveCount(totalRows)
  await expect(page.locator('[data-testid="grid-row"][data-status="loading"]')).toHaveCount(0)
  await expect(page.locator('[data-testid="grid-row"][data-status="error"]')).toHaveCount(0)
}

/** Commit NULL into a cell through the dedicated affordance (never '' or unset). */
async function setCellNull(page: Page, rowIndex: number, columnIndex: number): Promise<void> {
  await openEditor(page, rowIndex, columnIndex)
  await page.getByTestId('grid-editor-null').click()
  await expect(page.getByTestId('grid-cell-editor')).toHaveCount(0)
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

// --- Serialization-sensitivity self-check ---------------------------------------

/** Patch row `i` of a snapshot (structural clone; the input is untouched). */
function patchRow(
  snapshot: GridSnapshot,
  i: number,
  patch: (row: RowSnapshot) => RowSnapshot,
): GridSnapshot {
  return { ...snapshot, rows: snapshot.rows.map((r, j) => (j === i ? patch(r) : r)) }
}

/** Patch cell `ci` of row `ri` (structural clone; the input is untouched). */
function patchCell(
  snapshot: GridSnapshot,
  ri: number,
  ci: number,
  patch: (cell: CellSnapshot) => CellSnapshot,
): GridSnapshot {
  return patchRow(snapshot, ri, (r) => ({
    ...r,
    cells: r.cells.map((c, j) => (j === ci ? patch(c) : c)),
  }))
}

/**
 * One probe per CAPTURED field: a structural clone of the snapshot with
 * exactly that one field changed. This is the journey's
 * serialization-sensitivity self-check (review finding): if any captured
 * field stops contributing to `serializeGrid`, that field's probe serializes
 * identically to the original and the journey fails — so the final
 * byte-identical undo claim is total over the capture, not spot.
 */
const SERIALIZATION_SENSITIVITY_PROBES: readonly {
  readonly field: string
  readonly perturb: (snapshot: GridSnapshot) => GridSnapshot
}[] = [
  {
    field: 'headers[].name',
    perturb: (s) => ({
      ...s,
      headers: s.headers.map((h, i) => (i === 0 ? { ...h, name: `${h.name}~` } : h)),
    }),
  },
  {
    field: 'headers[].type',
    perturb: (s) => ({
      ...s,
      headers: s.headers.map((h, i) => (i === 0 ? { ...h, type: `${h.type}~` } : h)),
    }),
  },
  {
    field: 'rows[].index',
    perturb: (s) => patchRow(s, 0, (r) => ({ ...r, index: r.index + 1000 })),
  },
  {
    field: 'rows[].status',
    perturb: (s) => patchRow(s, 0, (r) => ({ ...r, status: `${r.status}~` })),
  },
  {
    field: 'rows[].dirty',
    perturb: (s) => patchRow(s, 0, (r) => ({ ...r, dirty: r.dirty === '' ? '~' : '' })),
  },
  {
    field: 'rows[].inserted',
    perturb: (s) => patchRow(s, 0, (r) => ({ ...r, inserted: r.inserted === '' ? '~' : '' })),
  },
  {
    field: 'cells[].col',
    perturb: (s) => patchCell(s, 0, 0, (c) => ({ ...c, col: `${c.col}~` })),
  },
  {
    field: 'cells[].text',
    perturb: (s) => patchCell(s, 0, 0, (c) => ({ ...c, text: `${c.text}~` })),
  },
  {
    field: 'cells[].dirty',
    perturb: (s) => patchCell(s, 0, 0, (c) => ({ ...c, dirty: c.dirty === '' ? '~' : '' })),
  },
  {
    field: 'cells[].nullMarker',
    // Baseline row 2, cell 2 = customer 3's income, which IS NULL, so the
    // marker is non-null and the flip below always changes the value.
    perturb: (s) =>
      patchCell(s, 2, 2, (c) => ({ ...c, nullMarker: c.nullMarker === null ? '~' : null })),
  },
  { field: 'totalRows', perturb: (s) => ({ ...s, totalRows: `${s.totalRows}~` }) },
  { field: 'columnCount', perturb: (s) => ({ ...s, columnCount: `${s.columnCount}~` }) },
]

/**
 * Prove the serialization is sensitive to EVERY captured dimension, right at
 * the baseline. Two assertions per probe: the probe really changes the
 * snapshot (no vacuous probes), and `serializeGrid` really notices. The
 * probe inventory is pinned, so a newly captured field without a probe fails
 * here too — the guard cannot silently stop being total.
 */
function assertSerializationSensitivity(snapshot: GridSnapshot): void {
  expect(SERIALIZATION_SENSITIVITY_PROBES.map((p) => p.field)).toEqual([
    'headers[].name',
    'headers[].type',
    'rows[].index',
    'rows[].status',
    'rows[].dirty',
    'rows[].inserted',
    'cells[].col',
    'cells[].text',
    'cells[].dirty',
    'cells[].nullMarker',
    'totalRows',
    'columnCount',
  ])
  for (const { field, perturb } of SERIALIZATION_SENSITIVITY_PROBES) {
    const perturbed = perturb(snapshot)
    expect(perturbed, `sensitivity probe ${field} must change the snapshot`).not.toEqual(snapshot)
    expect(
      serializeGrid(perturbed),
      `serializeGrid must be sensitive to the captured field ${field}`,
    ).not.toBe(serializeGrid(snapshot))
  }
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
  await expect(page.getByTestId('open-status')).toHaveText('idle', { timeout: 20_000 })
  await expect(page.getByTestId('edit-insert-row')).toHaveCount(0)
  await expect(page.getByTestId('history-empty')).toHaveCount(0)

  // --- 2. Open the fixture through the input-fallback filechooser. ---
  await openFixture(page, FIXTURE)
  await settleGrid(page, 5)
  // Privacy (ADR 0025): the picked file's name never renders.
  await expect(page.locator('main')).not.toContainText('customers.parquet')

  // Node side: the source's checksum, captured before ANY interaction.
  const sourceShaBefore = sha256File(FIXTURE)

  // Full pre-edit baseline (every cell, header, marker, count).
  await settleGrid(page, 5)
  const baselineSnapshot = await captureGrid(page)
  // Sensitivity self-check (review finding): prove every captured dimension —
  // cell text, dirty and NULL markers, header names and types, row
  // index/status/dirty/inserted markers, the counts — actually contributes to
  // serializeGrid, so the byte-identical claim after the undo leg is total
  // over the capture, not spot.
  assertSerializationSensitivity(baselineSnapshot)
  const baseline = serializeGrid(baselineSnapshot)
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
  // Sensitivity delta 1/8: the serialization MOVED with the edit — the cell
  // text and dirty marker contribute to the live serialization.
  const afterOp1 = serializeGrid(await captureGrid(page))
  expect(afterOp1).not.toBe(baseline)

  // op2: set a cell NULL through the dedicated affordance.
  await setCellNull(page, 1, 1) // country of customer 2
  await expect(cell(page, 1, 1)).toHaveAttribute('data-null', 'true')
  await expect(cell(page, 1, 1)).toHaveText('NULL')
  await settleGrid(page, 5)
  // Sensitivity delta 2/8: the NULL marker contributes.
  const afterOp2 = serializeGrid(await captureGrid(page))
  expect(afterOp2).not.toBe(afterOp1)

  // op3: insert a row (appended, all NULL, marked inserted).
  await page.getByTestId('edit-insert-row').click()
  await settleGrid(page, 6)
  await expect(row(page, 5)).toHaveAttribute('data-inserted', 'true')
  await expect(row(page, 5)).toHaveAttribute('data-dirty', 'true')
  // Sensitivity delta 3/8: row status/inserted markers and the row count
  // contribute.
  const afterOp3 = serializeGrid(await captureGrid(page))
  expect(afterOp3).not.toBe(afterOp2)

  // op4: edit the inserted row (so exports carry its values).
  await editCell(page, 5, 1, 'ZZ')
  await expect(cell(page, 5, 1)).toHaveText('ZZ')
  // Sensitivity delta 4/8: the inserted row's cell text contributes.
  const afterOp4 = serializeGrid(await captureGrid(page))
  expect(afterOp4).not.toBe(afterOp3)

  // op5: delete a base row (customer 5, the last base row).
  await row(page, 4).getByTestId('grid-row-delete').click()
  await settleGrid(page, 5)
  await expect(cell(page, 4, 0)).toHaveText('NULL') // the inserted row moved up
  // Sensitivity delta 5/8: the delete contributes (count and shifted cells).
  const afterOp5 = serializeGrid(await captureGrid(page))
  expect(afterOp5).not.toBe(afterOp4)

  // op6: rename a column.
  await renameColumn(page, 'country', 'nation')
  await expect(headerCell(page, 'nation')).toBeVisible()
  await expect(headerCell(page, 'country')).toHaveCount(0)
  await settleGrid(page, 5)
  await expect(page.getByTestId('grid-column-count')).toHaveText('4')
  // Sensitivity delta 6/8: the header NAME contributes.
  const afterOp6 = serializeGrid(await captureGrid(page))
  expect(afterOp6).not.toBe(afterOp5)

  // op7: a SAFE cast (BIGINT → DOUBLE) — the journey must continue through it.
  await castColumn(page, 'income', 'DOUBLE')
  await expect(headerCell(page, 'income')).toHaveAttribute('data-col-type', 'DOUBLE')
  await expect(page.getByTestId('edit-error')).toHaveCount(0)
  await settleGrid(page, 5)
  await expect(cell(page, 0, 2)).toHaveText('123456') // same value, re-typed column
  // Sensitivity delta 7/8: the header TYPE contributes — in isolation here,
  // no cell text changed with the re-type.
  const afterOp7 = serializeGrid(await captureGrid(page))
  expect(afterOp7).not.toBe(afterOp6)

  // A REFUSED cast mid-journey: VARCHAR values cannot convert to INTEGER.
  // Nothing may be appended, nothing may change — refusals must not corrupt
  // the history the undo leg is about to trust.
  // Full-integrity snapshot immediately BEFORE the refusal: the whole
  // serialized grid, not one spot cell (review warning).
  const beforeRefusal = serializeGrid(await captureGrid(page))
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
  // …and byte-identical ACROSS the refusal (alert present, history count 7
  // above, and the full serialization unchanged).
  expect(serializeGrid(await captureGrid(page))).toBe(beforeRefusal)

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
  expect(edited).not.toBe(afterOp7) // sensitivity delta 8/8: the bait edit contributes

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
  // The FULL rendered truncation warning (review finding): the panel must
  // not just count the undone tail but warn that a new edit discards it.
  await expect(page.getByTestId('history-redo-tail')).toContainText(
    '8 later steps are undone — a new edit will discard them.',
  )
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
  // Full warning text at the rewind point, too — 6 undone steps, same
  // discard warning (review finding).
  await expect(page.getByTestId('history-redo-tail')).toContainText(
    '6 later steps are undone — a new edit will discard them.',
  )
  await expect(cell(page, 0, 2)).toHaveText('123456')
  await expect(cell(page, 0, 2)).toHaveAttribute('data-dirty', 'true')
  await expect(cell(page, 1, 1)).toHaveAttribute('data-null', 'true')
  await expect(cell(page, 3, 1)).toHaveText('DE') // bait still undone
  await settleGrid(page, 5)

  // A fresh cell edit truncates the redo tail (the panel said so first).
  await editCell(page, 3, 1, '=SUM(A1:A2)')
  await expect(page.getByTestId('history-redo-tail')).toHaveCount(0)
  // …and with the tail gone, the rendered warning is gone with it — not just
  // its element (review finding).
  await expect(page.getByTestId('history-panel')).not.toContainText('will discard')
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
  await expect(dialog).not.toContainText(BANNED_EXPORT_WORDING)
  await expect(page.getByTestId('export-view-rows')).toHaveText('6 rows')

  const parquetDownload = await exportFormat(page, 'parquet')
  await expect(page.getByTestId('export-result')).toContainText('Exported 6 rows as Parquet')
  await expect(page.getByTestId('export-result')).toContainText('The opened file is unchanged')
  await expect(page.getByTestId('export-reopen-hint')).toContainText('choose the file you wrote')
  // The ban re-runs NOW that a success result has actually rendered (review
  // finding: it used to run only before any result existed) — against the
  // whole dialog AND the whole main region, while the Parquet success line
  // and its "unchanged" promise are what's showing.
  await expect(dialog).not.toContainText(BANNED_EXPORT_WORDING)
  await expect(page.locator('main')).not.toContainText(BANNED_EXPORT_WORDING)
  const parquetPath = await saveDownload(parquetDownload)
  // The bytes are really Parquet (the magic the open flow will read).
  expect(readFileSync(parquetPath).subarray(0, 4).toString('latin1')).toBe('PAR1')

  const csvDownload = await exportFormat(page, 'csv')
  await expect(page.getByTestId('export-result')).toContainText('Exported 6 rows as CSV')
  await expect(page.getByTestId('export-result')).toContainText(
    'your browser is downloading it as a new file',
  )
  // Explicit on BOTH successes (review finding): the CSV line carries the
  // same unchanged-source promise as the Parquet line.
  await expect(page.getByTestId('export-result')).toContainText('The opened file is unchanged')
  // …and the ban holds with a second success rendered — the CSV success line
  // is the one showing now, and the dialog + main stay clean.
  await expect(dialog).not.toContainText(BANNED_EXPORT_WORDING)
  await expect(page.locator('main')).not.toContainText(BANNED_EXPORT_WORDING)
  const csvPath = await saveDownload(csvDownload)
  await page.getByTestId('export-close').click()
  await expect(dialog).toHaveCount(0)

  // Node side: the CSV copy is pinned BYTE FOR BYTE against the known
  // effective rows (review finding): exact quoting, row order, ISO dates,
  // every cell of every row, and the final newline. This subsumes the old
  // partial checks — including "bait sanitized, never raw": the raw form
  // differs byte-wise from the pinned sanitized one.
  expect(readFileSync(csvPath, 'utf8')).toBe(EXPECTED_CSV_BYTES)

  // --- 7. The source was never touched by any edit, undo, or export. ---
  expect(sha256File(FIXTURE)).toBe(sourceShaBefore)

  // --- 8. Re-open the Parquet export through the normal open flow. ---
  await openFixture(page, parquetPath)
  await settleGrid(page, 6)
  // Privacy: neither the source fixture's name nor the exported file's OWN
  // basename (the `assay-export.parquet` download under its generated temp
  // name) renders anywhere (review finding: only the fixture name was
  // checked, so rendering path.basename(parquetPath) would have escaped).
  await expect(page.locator('main')).not.toContainText('customers.parquet')
  await expect(page.locator('main')).not.toContainText(path.basename(parquetPath))
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
  // The CSV export's own basename is absent too (review finding).
  await expect(page.locator('main')).not.toContainText(path.basename(csvPath))
  await expect(page.getByTestId('grid-column-count')).toHaveText('4')
  await expect(cell(page, 0, 2)).toHaveText('123456') // edited income
  // The sanitized value is the literal text the CSV carries (leading
  // apostrophe) — never the raw formula.
  await expect(cell(page, 3, 1)).toHaveText("'=SUM(A1:A2)")
  await expect(cell(page, 5, 1)).toHaveText('ZZ') // the inserted row
  await expect(page.getByTestId('history-empty')).toBeVisible()

  // Final honesty sweep: the whole journey never rendered the source's name
  // nor either exported file's own basename.
  await expect(page.locator('main')).not.toContainText('customers.parquet')
  await expect(page.locator('main')).not.toContainText(path.basename(parquetPath))
  await expect(page.locator('main')).not.toContainText(path.basename(csvPath))
})
