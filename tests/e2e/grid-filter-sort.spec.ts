import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { readGridStats } from './support/grid-stats'

// Task m2-3 proof (handoff §6): the web filter/sort UI over the full stack —
// header sort toggle → GridViewportModel.setSort → DuckDbGridProvider → the
// engine's filtered/sorted windows (m2-2), and the per-column predicate
// editor → setFilters → filtered windows + filtered rowCount. The app under
// test is the real composition root served at '/' by the first webServer in
// playwright.config.ts, opened on the COMMITTED golden fixture
// customers.parquet (5 rows; income of customer 3 is NULL; DuckDB's default
// null order is NULLS LAST in both directions):
//
//   customer_id country income     signup_date
//   1           SG      52000      2025-01-04
//   2           US      61000      2025-01-11
//   3           SG      NULL       2025-02-02
//   4           DE      48000      2025-02-19
//   5           US      75000      2025-03-01
//
// Deterministic assertions: exact first-column (customer_id) cell order,
// filtered totals (model rowCount re-read), active-filter chips, sort state
// attributes, and per-epoch windowed fetch stats (the grid re-renders from
// fresh windowed fetches — never a materialized scan).
//
// Picker path (m1-5/m1-6 pattern): an init script removes the FSA global so
// the app takes the hidden-<input type="file"> fallback, which Playwright's
// filechooser event carries. Privacy (ADR 0025): the picked file name is
// never rendered.

const FIXTURES_DIR = path.join(process.cwd(), 'fixtures', 'parquet')
const FIXTURE = path.join(FIXTURES_DIR, 'customers.parquet')

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

async function openCustomersFixture(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByTestId('open-status')).toHaveText('idle', { timeout: 20_000 })
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('open-button').click()
  const chooser = await chooserPromise
  await chooser.setFiles(FIXTURE)
  // Engine boot + open + schema + count: the ready phase is fully loaded.
  await expect(page.getByTestId('open-status')).toHaveText('ready', { timeout: 20_000 })
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')
  // Privacy (ADR 0025): the picked file name is never rendered.
  await expect(page.getByTestId('table-info')).not.toContainText('customers.parquet')
}

/** Click the header sort toggle of one column. */
async function clickSort(page: Page, column: string): Promise<void> {
  await page.locator(`[data-testid="grid-sort-toggle"][data-col-name="${column}"]`).click()
}

/** Assert the header sort toggle's visible state (none/asc/desc). */
async function expectSortState(page: Page, column: string, state: string): Promise<void> {
  await expect(
    page.locator(`[data-testid="grid-sort-toggle"][data-col-name="${column}"]`),
  ).toHaveAttribute('data-sort', state)
}

/**
 * The customer_id cells of every READY grid row, in row order (the fixture's
 * 5 rows all fit one viewport window, so the virtualizer renders them all).
 * Only ready rows are matched: transient loading placeholders (whose cells
 * render '…') are excluded, and toHaveText retries until the fetch lands.
 */
function expectCustomerOrder(page: Page, ids: string[]): Promise<void> {
  return expect(
    page.locator(
      '[data-testid="grid-row"][data-status="ready"] [data-testid="grid-cell"]:nth-child(1)',
    ),
  ).toHaveText(ids)
}

/** Type a predicate into one column's filter input and press Apply. */
async function applyFilter(page: Page, column: string, predicate: string): Promise<void> {
  await page.locator(`[data-testid="filter-input"][data-col-name="${column}"]`).fill(predicate)
  await page.locator(`[data-testid="filter-apply"][data-col-name="${column}"]`).click()
}

test('column-header sort cycles asc → desc → cleared, reordering the visible rows', async ({
  page,
}) => {
  await openCustomersFixture(page)
  await expectCustomerOrder(page, ['1', '2', '3', '4', '5']) // natural order

  // asc by income: 48000, 52000, 61000, 75000, NULL — first rows change, and
  // the NULL row moves last (DuckDB's default null order).
  await clickSort(page, 'income')
  await expectSortState(page, 'income', 'asc')
  await expect(
    page.locator(
      '[data-testid="grid-row"][data-status="ready"] [data-testid="grid-cell"]:nth-child(3)',
    ),
  ).toHaveText(['48000', '52000', '61000', '75000', 'NULL'])
  await expectCustomerOrder(page, ['4', '1', '2', '5', '3'])

  // desc by income: reversed, NULL still last.
  await clickSort(page, 'income')
  await expectSortState(page, 'income', 'desc')
  await expect(
    page.locator(
      '[data-testid="grid-row"][data-status="ready"] [data-testid="grid-cell"]:nth-child(3)',
    ),
  ).toHaveText(['75000', '61000', '52000', '48000', 'NULL'])
  await expectCustomerOrder(page, ['5', '2', '1', '4', '3'])

  // Third click clears the sort (null-clear protocol) — natural order again.
  await clickSort(page, 'income')
  await expectSortState(page, 'income', 'none')
  await expectCustomerOrder(page, ['1', '2', '3', '4', '5'])

  // Sorting another column replaces the dataset-wide sort (single sort key).
  await clickSort(page, 'income')
  await clickSort(page, 'customer_id')
  await expectSortState(page, 'customer_id', 'asc')
  await expectSortState(page, 'income', 'none')
  await expectCustomerOrder(page, ['1', '2', '3', '4', '5'])

  // The header keeps showing the column names (the toggle sits beside them).
  await expect(
    page.locator('[data-testid="grid-header-cell"] [data-testid="grid-header-name"]'),
  ).toHaveText(['customer_id', 'country', 'income', 'signup_date'])
})

test('numeric filter narrows the visible rows and the total row count, refetched windowed', async ({
  page,
}) => {
  await openCustomersFixture(page)

  // The convention hint is part of the UI (v1 grammar documented in place).
  await expect(page.getByTestId('filter-hint')).toContainText('("column" <predicate>)')

  await applyFilter(page, 'income', '> 50000')
  await expect(page.getByTestId('grid-total-rows')).toHaveText('3') // model re-read the filtered total
  await expect(page.getByTestId('grid')).toHaveAttribute('aria-rowcount', '4') // + header row
  await expectCustomerOrder(page, ['1', '2', '5'])
  await expect(page.locator('[data-testid="filter-chip"] code')).toHaveText(['income > 50000'])
  await expect(
    page.locator('[data-testid="filter-chip-remove"][data-col-name="income"]'),
  ).toBeVisible()

  // Fresh epoch: the grid re-rendered from new windowed fetches under the
  // filter — exactly the 3 matching rows requested (never a rescan), each
  // span within the engine's window cap.
  const stats = await readGridStats(page)
  expect(stats.fetches).toBeGreaterThanOrEqual(1)
  expect(stats.requested).toBe(3)
  expect(stats.maxSpan).toBeLessThanOrEqual(1000)

  // Removing the chip clears the filter via the model: count restored, all
  // rows back in natural order, empty-state hint shown again.
  await page.locator('[data-testid="filter-chip-remove"][data-col-name="income"]').click()
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')
  await expectCustomerOrder(page, ['1', '2', '3', '4', '5'])
  await expect(page.getByTestId('filter-empty')).toBeVisible()
  const cleared = await readGridStats(page)
  expect(cleared.requested).toBe(5)
})

test('apply then clear a filter restores the unfiltered count and rows', async ({ page }) => {
  await openCustomersFixture(page)

  await applyFilter(page, 'country', "= 'SG'")
  await expect(page.getByTestId('grid-total-rows')).toHaveText('2')
  await expectCustomerOrder(page, ['1', '3'])
  await expect(page.locator('[data-testid="filter-chip"]')).toHaveCount(1)

  // Clear by emptying the column's input (the documented "empty = no filter").
  await applyFilter(page, 'country', '')
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')
  await expectCustomerOrder(page, ['1', '2', '3', '4', '5'])
  await expect(page.getByTestId('filter-empty')).toBeVisible()
})

test('filter + sort compose: country = US with income desc orders the matches', async ({
  page,
}) => {
  await openCustomersFixture(page)

  // Two desc clicks: asc then desc. Then the filter narrows to US rows.
  await clickSort(page, 'income')
  await clickSort(page, 'income')
  await expectSortState(page, 'income', 'desc')
  await applyFilter(page, 'country', "= 'US'")

  await expect(page.getByTestId('grid-total-rows')).toHaveText('2')
  await expectCustomerOrder(page, ['5', '2']) // 75000 before 61000
  await expect(
    page.locator(
      '[data-testid="grid-row"][data-status="ready"] [data-testid="grid-cell"]:nth-child(3)',
    ),
  ).toHaveText(['75000', '61000'])
  await expect(page.locator('[data-testid="filter-chip"] code')).toHaveText(["country = 'US'"])
})

test('an invalid predicate surfaces the engine error and keeps the previous filter state', async ({
  page,
}) => {
  await openCustomersFixture(page)

  // `oops` is not valid SQL on its own — the engine rejects the fragment
  // when the model's refresh re-reads the filtered total; the UI restores
  // the previous (empty) list and shows the engine's message as text.
  await applyFilter(page, 'income', '> oops')
  await expect(page.getByTestId('filter-error')).toBeVisible()
  await expect(page.getByTestId('filter-error')).not.toHaveText('')
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5') // unchanged
  await expectCustomerOrder(page, ['1', '2', '3', '4', '5']) // restored
  await expect(page.getByTestId('filter-empty')).toBeVisible()

  // The engine stays reusable: fixing the predicate recovers immediately.
  await applyFilter(page, 'income', '> 50000')
  await expect(page.getByTestId('filter-error')).toHaveCount(0)
  await expect(page.getByTestId('grid-total-rows')).toHaveText('3')
  await expectCustomerOrder(page, ['1', '2', '5'])
})
