import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { openCustomersFixture, openFilterBar } from './support/fixtures'

// ux-4 proof: the non-SQL filter-builder journey over the real stack. Opens
// the committed customers.parquet fixture through the picker path, drives the
// type-aware builder (numeric `>` / string `contains`) to predicates on the
// unchanged `FilterSpec` v1 grammar, and clears via the chips.
//
//   customer_id country income     signup_date
//   1           SG      52000      2025-01-04
//   2           US      61000      2025-01-11
//   3           SG      NULL       2025-02-02
//   4           DE      48000      2025-02-19
//   5           US      75000      2025-03-01
//
// Pinned here: collapsed-by-default + the `model.filters` summary count, the
// client-side rejection (no engine round-trip), numeric `>` narrowing, string
// `contains` (compiled to an escaped LIKE), and chip-clear returning the full
// count. The SQL-fragment escape hatch stays pinned by grid-filter-sort.spec.ts
// and the validation "Show only failing rows" bridge by
// validation-report-export.spec.ts.

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

function builderOperator(page: Page, column: string): Locator {
  return page.locator(`[data-testid="filter-builder-operator"][data-col-name="${column}"]`)
}

function builderValue(page: Page, column: string): Locator {
  return page.locator(`[data-testid="filter-builder-value"][data-col-name="${column}"]`)
}

function builderApply(page: Page, column: string): Locator {
  return page.locator(`[data-testid="filter-builder-apply"][data-col-name="${column}"]`)
}

test('non-SQL filter-builder journey: numeric, categorical contains, clear via chip', async ({
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

  // Client-side rejection: a value-requiring operator with no value shows
  // readable copy inline and never changes the view.
  await builderOperator(page, 'income').selectOption('gt')
  await builderApply(page, 'income').click()
  await expect(
    page.locator('[data-testid="filter-builder-error"][data-col-name="income"]'),
  ).toHaveText('Enter a value for this operator.')
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')

  // Numeric builder: income > 50000.
  await builderValue(page, 'income').fill('50000')
  await builderApply(page, 'income').click()
  await expect(page.getByTestId('grid-total-rows')).toHaveText('3')
  await expect(customerIdCells(page)).toHaveText(['1', '2', '5'])
  await expect(page.locator('[data-testid="filter-chip"][data-col-name="income"] code')).toHaveText(
    'income > 50000',
  )
  await expect(toggle).toHaveText('Filters · 1 active')

  // Categorical builder: country contains "U" (compiled to an escaped LIKE),
  // composing with the numeric filter.
  await builderOperator(page, 'country').selectOption('contains')
  await builderValue(page, 'country').fill('U')
  await builderApply(page, 'country').click()
  await expect(page.getByTestId('grid-total-rows')).toHaveText('2')
  await expect(customerIdCells(page)).toHaveText(['2', '5'])
  await expect(toggle).toHaveText('Filters · 2 active')
  await expect(
    page.locator('[data-testid="filter-chip"][data-col-name="country"] code'),
  ).toHaveText("country LIKE '%U%' ESCAPE '\\'")

  // Clear via the chips: each removal restores the count, and the summary
  // returns to the bare label when the last filter goes.
  await page.locator('[data-testid="filter-chip-remove"][data-col-name="country"]').click()
  await expect(page.getByTestId('grid-total-rows')).toHaveText('3')
  await expect(toggle).toHaveText('Filters · 1 active')
  await page.locator('[data-testid="filter-chip-remove"][data-col-name="income"]').click()
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')
  await expect(customerIdCells(page)).toHaveText(['1', '2', '3', '4', '5'])
  await expect(toggle).toHaveText('Filters')
  await expect(page.getByTestId('filter-empty')).toBeVisible()
})
