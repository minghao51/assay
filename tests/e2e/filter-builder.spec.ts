import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { openCustomersFixture, openFilterBar, openFixture } from './support/fixtures'

// ux-4 + ug-18 proof: the non-SQL filter journey over the real stack.
//
// ug-18 (findings UG-16/UG-17) replaced the per-column builder wall with ONE
// "Filter on: [column ▾] [operator ▾] [value] [Apply]" compose row, editable
// rows for the active filters, and moved the per-column SQL-fragment escape
// hatch behind its own `SQL predicates` disclosure. The collapsed summary now
// names the active columns and carries its chips (with remove buttons) BESIDE
// the toggle.
//
// customers.parquet (5 rows) is the labelled fixture for the compose journey:
//
//   customer_id country income     signup_date
//   1           SG      52000      2025-01-04
//   2           US      61000      2025-01-11
//   3           SG      NULL       2025-02-02
//   4           DE      48000      2025-02-19
//   5           US      75000      2025-03-01
//
// fixtures/csv/wide.csv (20 columns × 3 rows, synthetic) is the wide-file
// journey: col_01…col_19 are 1..19 / 2..38 / 3..57 and `note` is
// alpha/bravo/charlie.
//
// Pinned here: collapsed-by-default with the bare summary, the client-side
// rejection (no engine round-trip), numeric `>` narrowing through the compose
// row, string `contains` (compiled to an escaped LIKE), the active-row surface,
// the collapsed summary naming the columns, collapsed-chip removal, and the
// `SQL predicates` escape hatch.

const WIDE_FIXTURE = path.join(process.cwd(), 'fixtures', 'csv', 'wide.csv')
const WIDE_COLUMNS = 20

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
    } catch {
      // Non-configurable global would be a Chromium change; fail loudly later.
    }
  })
})

/**
 * The customer_id cells of every READY grid row, in row order.
 *
 * ug-11: each row's FIRST child is its 1-based row-number gutter, so schema
 * column 0 is the row's second child (`:nth-child(2)`). The assertion is the
 * same one — a per-row cell at a fixed schema position — only the structural
 * offset moved.
 */
function customerIdCells(page: Page): Locator {
  return page.locator(
    '[data-testid="grid-row"][data-status="ready"] [data-testid="grid-cell"]:nth-child(2)',
  )
}

/** Drive the one compose row (ug-18). */
async function composeFilter(
  page: Page,
  column: string,
  operator: string,
  value?: string,
): Promise<void> {
  await page.getByTestId('filter-compose-column').selectOption(column)
  await page.getByTestId('filter-compose-operator').selectOption(operator)
  if (value !== undefined) await page.getByTestId('filter-compose-value').fill(value)
  await page.getByTestId('filter-compose-apply').click()
}

/** Open the collapsed `SQL predicates` escape hatch (ug-18). */
async function openSqlPredicates(page: Page): Promise<void> {
  const disclosure = page.getByTestId('filter-sql-disclosure')
  if ((await disclosure.getAttribute('open')) === null) {
    await disclosure.locator('summary').click()
  }
  await expect(disclosure).toHaveAttribute('open', '')
}

function activeRow(page: Page, column: string): Locator {
  return page.locator(`[data-testid="filter-active-row"][data-col-name="${column}"]`)
}

test('compose-row filter journey: numeric, categorical contains, editable rows, escape hatch', async ({
  page,
}) => {
  await openCustomersFixture(page)

  // Collapsed by default, with a bare summary and no body in the DOM.
  const toggle = page.getByTestId('filter-toggle')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(toggle).toHaveText('Filters')
  await expect(page.getByTestId('filter-body')).toHaveCount(0)

  await openFilterBar(page)
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByTestId('filter-body')).toBeVisible()

  // ug-18: ONE compose row, and none of the old per-column builder wall.
  await expect(page.getByTestId('filter-compose')).toHaveCount(1)
  await expect(page.getByTestId('filter-compose-column')).toHaveCount(1)
  await expect(page.getByTestId('filter-compose-operator')).toHaveCount(1)
  await expect(page.getByTestId('filter-compose-apply')).toHaveCount(1)
  await expect(page.getByTestId('filter-builder-column')).toHaveCount(0)
  await expect(page.getByTestId('filter-builder-operator')).toHaveCount(0)

  // Client-side rejection: a value-requiring operator with no value shows
  // readable copy inline and never changes the view.
  await composeFilter(page, 'income', 'gt')
  await expect(page.getByTestId('filter-builder-error')).toHaveText(
    'Enter a value for this operator.',
  )
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')

  // Numeric compose: income > 50000.
  await composeFilter(page, 'income', 'gt', '50000')
  await expect(page.getByTestId('grid-total-rows')).toHaveText('3')
  await expect(customerIdCells(page)).toHaveText(['1', '2', '5'])
  await expect(page.locator('[data-testid="filter-chip"][data-col-name="income"] code')).toHaveText(
    'income > 50000',
  )
  await expect(toggle).toHaveText('Filters · 1 active: income')
  // The active filter has its own editable row, pre-filled with the predicate.
  await expect(activeRow(page, 'income')).toHaveCount(1)
  await expect(
    page.locator('[data-testid="filter-active-predicate"][data-col-name="income"]'),
  ).toHaveValue('> 50000')

  // Categorical compose: country contains "U" (compiled to an escaped LIKE),
  // composing with the numeric filter.
  await composeFilter(page, 'country', 'contains', 'U')
  await expect(page.getByTestId('grid-total-rows')).toHaveText('2')
  await expect(customerIdCells(page)).toHaveText(['2', '5'])
  await expect(toggle).toHaveText('Filters · 2 active: income, country')
  await expect(
    page.locator('[data-testid="filter-chip"][data-col-name="country"] code'),
  ).toHaveText("country LIKE '%U%' ESCAPE '\\'")

  // The active row edits the predicate in place (SQL-fragment semantics).
  await page
    .locator('[data-testid="filter-active-predicate"][data-col-name="income"]')
    .fill('> 70000')
  await page.locator('[data-testid="filter-active-apply"][data-col-name="income"]').click()
  await expect(page.getByTestId('grid-total-rows')).toHaveText('1')
  await expect(customerIdCells(page)).toHaveText(['5'])

  // Removing one active row keeps the other filter.
  await page.locator('[data-testid="filter-active-remove"][data-col-name="income"]').click()
  await expect(page.getByTestId('grid-total-rows')).toHaveText('2')
  await expect(toggle).toHaveText('Filters · 1 active: country')

  // The SQL escape hatch is collapsed by default and still compiles fragments
  // (the preserved m2-3 path); it replaces the same column's filter.
  await expect(page.getByTestId('filter-sql-disclosure')).not.toHaveAttribute('open', '')
  await openSqlPredicates(page)
  await page.locator('[data-testid="filter-input"][data-col-name="country"]').fill("= 'SG'")
  await page.locator('[data-testid="filter-apply"][data-col-name="country"]').click()
  await expect(page.getByTestId('grid-total-rows')).toHaveText('2')
  await expect(customerIdCells(page)).toHaveText(['1', '3'])
  await expect(toggle).toHaveText('Filters · 1 active: country')

  // Clearing the last filter returns the summary to the bare label.
  await page.locator('[data-testid="filter-active-remove"][data-col-name="country"]').click()
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')
  await expect(customerIdCells(page)).toHaveText(['1', '2', '3', '4', '5'])
  await expect(toggle).toHaveText('Filters')
  await expect(page.getByTestId('filter-empty')).toBeVisible()
})

test('wide.csv: compose filter, collapsed chips beside the toggle, chip removal while collapsed', async ({
  page,
}) => {
  await openFixture(page, WIDE_FIXTURE)
  await expect(page.getByTestId('grid-total-rows')).toHaveText('3')
  await expect(page.getByTestId('grid-header-cell')).toHaveCount(WIDE_COLUMNS)

  // No per-column wall even on a 20-column file (UG-16): one compose row.
  await openFilterBar(page)
  await expect(page.getByTestId('filter-compose')).toHaveCount(1)
  await expect(page.getByTestId('filter-builder-column')).toHaveCount(0)
  await expect(page.getByTestId('filter-columns')).toHaveCount(1) // inside the disclosure

  // col_10 is 10 / 20 / 30 across the three rows.
  await composeFilter(page, 'col_10', 'gt', '20')
  await expect(page.getByTestId('grid-total-rows')).toHaveText('1')
  const toggle = page.getByTestId('filter-toggle')
  await expect(toggle).toHaveText('Filters · 1 active: col_10')

  // Collapse: the summary names the column and the chip (with its remove
  // button) sits BESIDE the toggle — never inside the button.
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(toggle).toHaveText('Filters · 1 active: col_10')
  const headerChips = page.getByTestId('filter-chips-header')
  await expect(headerChips).toBeVisible()
  const chip = headerChips.locator('[data-testid="filter-chip"][data-col-name="col_10"]')
  await expect(chip).toBeVisible()
  await expect(chip.locator('code')).toHaveText('col_10 > 20')
  await expect(toggle.locator('[data-testid="filter-chip"]')).toHaveCount(0)
  await expect(
    page.getByTestId('filter-chips-header').locator('[data-testid="filter-chip-remove"]'),
  ).toHaveCount(1)

  // Removing the collapsed chip clears the filter and restores the summary.
  await chip.getByTestId('filter-chip-remove').click()
  await expect(page.getByTestId('grid-total-rows')).toHaveText('3')
  await expect(toggle).toHaveText('Filters')
  await expect(page.getByTestId('filter-chips-header')).toHaveCount(0)

  // The escape hatch survives on the wide file too.
  await openFilterBar(page)
  await openSqlPredicates(page)
  await page.locator('[data-testid="filter-input"][data-col-name="col_02"]').fill('>= 6')
  await page.locator('[data-testid="filter-apply"][data-col-name="col_02"]').click()
  await expect(page.getByTestId('grid-total-rows')).toHaveText('1')
  await expect(toggle).toHaveText('Filters · 1 active: col_02')
})
