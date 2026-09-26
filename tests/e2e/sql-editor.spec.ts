import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { openFixtureAndGetTableId } from './support/fixtures'

// Task m2-4 proof (handoff §6): the SQL editor + result pane over the full
// stack — editor → web-side LIMIT/OFFSET wrap (the engine `query()` op has no
// wire-level paging) → engineClient.query() → first Arrow batch → projected
// page (reusing the grid's ArrowTableLike/projectBatchToRows seam). Proves:
// (a) running a query against an opened fixture renders its contents,
// (b) paging forward changes the page and paging back restores it,
// (c) a deliberately slow query can be cancelled while in flight (UI-level
//     abandonment — the engine has no interrupt) and a follow-up query works,
// (d) engine errors surface readably and the engine stays usable.
//
// The app under test is the real composition root served at '/' by the first
// webServer in playwright.config.ts, opened on the COMMITTED golden fixtures:
// customers.parquet (5 rows, income of customer 3 NULL) and wide.parquet
// (1000 rows: id 0–999, label 'row_<id>', deterministic generator order).
//
// Picker path (m1-5/m1-6 pattern): an init script removes the FSA global so
// the app takes the hidden-<input type="file"> fallback, which Playwright's
// filechooser event carries. Privacy (ADR 0025): the pane never renders the
// picked file's name, and nothing about the SQL or results is logged.
//
// Rendering is data-only: cell assertions run against React text
// interpolation (formatCell) — SQL text, engine errors, and cells are never
// markup (ADR 0007 spirit).

const FIXTURES_DIR = path.join(process.cwd(), 'fixtures', 'parquet')
const CUSTOMERS_FIXTURE = path.join(FIXTURES_DIR, 'customers.parquet')
const WIDE_FIXTURE = path.join(FIXTURES_DIR, 'wide.parquet')

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
    } catch {
      // Non-configurable global would be a Chromium change; the fallback
      // would then be skipped and the test would fail loudly at the chooser.
    }
  })
})

/** Type a statement into the editor and press Run. */
async function runSql(page: Page, sql: string): Promise<void> {
  await page.getByTestId('sql-input').fill(sql)
  await page.getByTestId('sql-run').click()
}

/**
 * The SQL-facing view name for an opened table: the engine registers the
 * DuckDB view under its `assay_` namespace (`assay_t1`), while the UI
 * displays the bare id (`t1`). The same convention is pinned by unit tests
 * on both sides (engine-duckdb table-registry, web paged-query).
 */
function sqlTable(tableId: string): string {
  return `assay_${tableId}`
}

/** First cell of the delivered page (the fixture's deterministic order). */
function firstPageCell(page: Page, columnIndex: number) {
  return page
    .locator('[data-testid="sql-result-row"]')
    .first()
    .locator('[data-testid="sql-result-cell"]')
    .nth(columnIndex)
}

test('runs a query against the opened fixture and renders its contents as data', async ({
  page,
}) => {
  const tableId = await openFixtureAndGetTableId(page, CUSTOMERS_FIXTURE)
  // The hint points the user at both names: the id and its SQL-facing view.
  await expect(page.getByTestId('sql-table-id')).toHaveText(tableId)
  await expect(page.getByTestId('sql-table-name')).toHaveText(`"${sqlTable(tableId)}"`)

  await runSql(page, `SELECT customer_id, country, income FROM "${sqlTable(tableId)}"`)
  await expect(page.getByTestId('sql-panel')).toHaveAttribute('data-state', 'done')
  await expect(page.getByTestId('sql-status')).toHaveText('Done')

  // Headers come from the Arrow schema; cells are exact projected values —
  // including the NULL income of customer 3 (an empty cell, like the grid).
  await expect(page.getByTestId('sql-result-header')).toHaveText([
    'customer_id',
    'country',
    'income',
  ])
  await expect(page.locator('[data-testid="sql-result-row"]')).toHaveCount(5)
  await expect(
    page.locator('[data-testid="sql-result-row"] [data-testid="sql-result-cell"]:nth-child(1)'),
  ).toHaveText(['1', '2', '3', '4', '5'])
  await expect(
    page.locator('[data-testid="sql-result-row"] [data-testid="sql-result-cell"]:nth-child(2)'),
  ).toHaveText(['SG', 'US', 'SG', 'DE', 'US'])
  await expect(
    page.locator('[data-testid="sql-result-row"] [data-testid="sql-result-cell"]:nth-child(3)'),
  ).toHaveText(['52000', '61000', '', '48000', '75000'])

  // A partial page means the result set is exhausted: no next, no prev.
  await expect(page.getByTestId('sql-page-info')).toHaveText('rows 1–5')
  await expect(page.getByTestId('sql-result-exhausted')).toBeVisible()
  await expect(page.getByTestId('sql-page-next')).toBeDisabled()
  await expect(page.getByTestId('sql-page-prev')).toBeDisabled()
})

test('pages forward through wide.parquet and back restores the earlier page', async ({ page }) => {
  const tableId = await openFixtureAndGetTableId(page, WIDE_FIXTURE)
  // wide.parquet stores id 0..999 in generator order; the explicit ORDER BY
  // pins the page contents (row n of page p is id 50p + n).
  await runSql(page, `SELECT id, label FROM "${sqlTable(tableId)}" ORDER BY id`)
  await expect(page.getByTestId('sql-panel')).toHaveAttribute('data-state', 'done')
  await expect(page.locator('[data-testid="sql-result-row"]')).toHaveCount(50) // one bounded page
  await expect(firstPageCell(page, 0)).toHaveText('0')
  await expect(firstPageCell(page, 1)).toHaveText('row_0')
  await expect(page.getByTestId('sql-page-info')).toHaveText('rows 1–50')
  await expect(page.getByTestId('sql-page-prev')).toBeDisabled()
  await expect(page.getByTestId('sql-result-exhausted')).toHaveCount(0)

  // Forward: each page delivers the next 50 ids in order.
  await page.getByTestId('sql-page-next').click()
  await expect(page.getByTestId('sql-panel')).toHaveAttribute('data-state', 'done')
  await expect(firstPageCell(page, 0)).toHaveText('50')
  await expect(firstPageCell(page, 1)).toHaveText('row_50')
  await expect(page.getByTestId('sql-page-info')).toHaveText('rows 51–100')

  await page.getByTestId('sql-page-next').click()
  await expect(page.getByTestId('sql-panel')).toHaveAttribute('data-state', 'done')
  await expect(firstPageCell(page, 0)).toHaveText('100')
  await expect(page.getByTestId('sql-page-info')).toHaveText('rows 101–150')

  // Back: the pages are restored in reverse, ending where the paging began.
  await page.getByTestId('sql-page-prev').click()
  await expect(page.getByTestId('sql-panel')).toHaveAttribute('data-state', 'done')
  await expect(firstPageCell(page, 0)).toHaveText('50')
  await expect(page.getByTestId('sql-page-info')).toHaveText('rows 51–100')

  await page.getByTestId('sql-page-prev').click()
  await expect(page.getByTestId('sql-panel')).toHaveAttribute('data-state', 'done')
  await expect(firstPageCell(page, 0)).toHaveText('0')
  await expect(firstPageCell(page, 1)).toHaveText('row_0')
  await expect(page.getByTestId('sql-page-info')).toHaveText('rows 1–50')
})

test('a partial final page shows the exhausted indicator and an empty result shows the empty state', async ({
  page,
}) => {
  const tableId = await openFixtureAndGetTableId(page, WIDE_FIXTURE)

  // 60 matching rows = one full page (50) + a partial final page (10).
  await runSql(page, `SELECT id FROM "${sqlTable(tableId)}" WHERE id < 60 ORDER BY id`)
  await expect(page.getByTestId('sql-panel')).toHaveAttribute('data-state', 'done')
  await expect(page.getByTestId('sql-page-info')).toHaveText('rows 1–50')
  await expect(page.getByTestId('sql-result-exhausted')).toHaveCount(0)

  await page.getByTestId('sql-page-next').click()
  await expect(page.getByTestId('sql-panel')).toHaveAttribute('data-state', 'done')
  await expect(page.locator('[data-testid="sql-result-row"]')).toHaveCount(10)
  await expect(firstPageCell(page, 0)).toHaveText('50')
  await expect(page.getByTestId('sql-page-info')).toHaveText('rows 51–60')
  await expect(page.getByTestId('sql-result-exhausted')).toBeVisible()
  await expect(page.getByTestId('sql-page-next')).toBeDisabled() // partial page ⇒ exhausted

  // Back restores the full first page; prev disables at the origin.
  await page.getByTestId('sql-page-prev').click()
  await expect(page.getByTestId('sql-panel')).toHaveAttribute('data-state', 'done')
  await expect(page.locator('[data-testid="sql-result-row"]')).toHaveCount(50)
  await expect(page.getByTestId('sql-page-prev')).toBeDisabled()

  // A query matching no rows shows the empty state (and no table at all).
  await runSql(page, `SELECT id FROM "${sqlTable(tableId)}" WHERE id > 9999`)
  await expect(page.getByTestId('sql-panel')).toHaveAttribute('data-state', 'done')
  await expect(page.getByTestId('sql-result-empty')).toBeVisible()
  await expect(page.getByTestId('sql-result')).toHaveCount(0)
  await expect(page.getByTestId('sql-page-info')).toHaveText('no rows')
  await expect(page.getByTestId('sql-page-next')).toBeDisabled()
  await expect(page.getByTestId('sql-page-prev')).toBeDisabled()
})

test('cancels a running slow query (abandonment) and a follow-up query still works', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await openFixtureAndGetTableId(page, CUSTOMERS_FIXTURE)

  // A deliberately slow aggregate: a 400M-pair product summed per pair.
  // Measured in this browser build while authoring: ~2.8 s end-to-end (native
  // multi-threaded DuckDB needs ~0.3 s; the app's single-threaded mvp WASM
  // bundle is far slower) — reliably long enough that the pane is
  // demonstrably in flight when Cancel lands. (It returns its one row only
  // after computing everything, so the engine stays busy until the FIFO slot
  // frees — exactly the abandonment scenario.)
  await runSql(page, 'SELECT sum(a.i * b.i) FROM range(20000) AS a(i), range(20000) AS b(i)')
  await expect(page.getByTestId('sql-panel')).toHaveAttribute('data-state', 'running')
  await expect(page.getByTestId('sql-cancel')).toBeEnabled()

  // q-5: the pane's own `running` state (asserted just above; the engine op is
  // dispatched synchronously before that state renders) is the observable that
  // the query is in flight, so the fixed 300 ms settle is gone. Cancel still
  // lands while the ~2.8 s aggregate computes, and the `cancelled` assertion
  // below fails if it did not.
  await page.getByTestId('sql-cancel').click()

  // Cancelled is a first-class pane state — with the honest semantics note:
  // the engine has no interrupt, the abandoned query keeps running
  // worker-side, and its late result never renders.
  await expect(page.getByTestId('sql-panel')).toHaveAttribute('data-state', 'cancelled')
  await expect(page.getByTestId('sql-status')).toHaveText('Cancelled')
  await expect(page.getByTestId('sql-cancel-note')).toBeVisible()
  await expect(page.getByTestId('sql-error')).toHaveCount(0)
  await expect(page.getByTestId('sql-cancel')).toBeDisabled()
  await expect(page.getByTestId('sql-run')).toBeEnabled() // the pane accepts a new run

  // The follow-up queues behind the abandoned query on the worker's FIFO,
  // then answers normally — allow generous time.
  await runSql(page, 'SELECT 41 + 1 AS answer')
  await expect(page.getByTestId('sql-panel')).toHaveAttribute('data-state', 'running')
  await expect(page.getByTestId('sql-panel')).toHaveAttribute('data-state', 'done', {
    timeout: 90_000,
  })
  await expect(page.getByTestId('sql-result-header')).toHaveText(['answer'])
  await expect(page.locator('[data-testid="sql-result-cell"]')).toHaveText('42')
})

test('invalid SQL surfaces a readable engine error and the pane (and engine) stay usable', async ({
  page,
}) => {
  const tableId = await openFixtureAndGetTableId(page, CUSTOMERS_FIXTURE)

  // A binder error: the engine's own message text surfaces in the alert.
  // (Message quality is the duckdb-wasm mvp bundle's emscripten-layer yield
  // for pending-query failures — the pane's contract is surfacing whatever
  // the engine reports as text, non-empty, never swallowed.)
  await runSql(page, `SELECT nope FROM "${sqlTable(tableId)}"`)
  await expect(page.getByTestId('sql-panel')).toHaveAttribute('data-state', 'error')
  await expect(page.getByTestId('sql-error')).toBeVisible()
  await expect(page.getByTestId('sql-error')).not.toHaveText('')
  await expect(page.getByTestId('sql-status')).toHaveText('Failed')
  await expect(page.getByTestId('sql-result')).toHaveCount(0) // no stale page

  // A multi-statement string cannot be wrapped — the engine rejects the wrap
  // and the error surfaces readably (documented composePageQuery behavior).
  await runSql(page, 'SELECT 1; SELECT 2')
  await expect(page.getByTestId('sql-panel')).toHaveAttribute('data-state', 'error')
  await expect(page.getByTestId('sql-error')).not.toHaveText('')

  // A failed run must not break the next: the engine and pane recover.
  await runSql(page, 'SELECT 6 * 7 AS answer')
  await expect(page.getByTestId('sql-panel')).toHaveAttribute('data-state', 'done')
  await expect(page.getByTestId('sql-error')).toHaveCount(0)
  await expect(page.locator('[data-testid="sql-result-cell"]')).toHaveText('42')
})
