import { expect, test } from './support/fixture'
import { clickAndGetJson, openFlatFixture } from './support/fixtures'

// Task m2-2 (handoff §6): filtered/sorted windows over REAL DuckDB-WASM on a
// golden fixture. The harness (packages/engine-duckdb) opens customers.parquet
// through a staged genuine FileSystemFileHandle and drives the client's m2-2
// surface — fetchRange with filters/sort, rowCount with filters, and the
// invalid-predicate error path — rendering every result as JSON evidence read
// through the Arrow API. The expected values below are the known contents of
// the golden fixture (5 rows; income of customer 3 is NULL; DuckDB's default
// null order is NULLS LAST in both directions).
//
// Conformance-level semantics (filter/sort/clamp/injection) run in
// tests/e2e/engine-conformance.spec.ts via the @assay/testing suite; this spec
// proves the same surface directly, on the fixture, through the harness UI.
// Harness served from packages/engine-duckdb by the second webServer in
// playwright.config.ts; port env-overridable for parallel worktree batches
// (default 4179).
interface WindowEvidence {
  rows?: number
  customerIds?: string[]
  incomes?: (string | null)[]
  hasMore?: boolean
  error?: string
  rejected?: boolean
  rowCountAfterReuse?: number
  fatal?: string
}

test('filtered window: income > 50000 returns exactly the matching rows (NULL excluded)', async ({
  page,
}) => {
  await openFlatFixture(page)
  const evidence = await clickAndGetJson<WindowEvidence>(
    page,
    'Filtered window: income > 50000',
    'filtered-window-result',
  )
  expect(evidence.error).toBeUndefined()
  expect(evidence.rows).toBe(3)
  expect(evidence.hasMore).toBe(false)
  expect(evidence.customerIds).toEqual(['1', '2', '5'])
  expect(evidence.incomes).toEqual(['52000', '61000', '75000'])
})

test('sorted window: income desc orders with the NULL last (DuckDB default null order)', async ({
  page,
}) => {
  await openFlatFixture(page)
  const evidence = await clickAndGetJson<WindowEvidence>(
    page,
    'Sorted window: income desc',
    'sorted-window-result',
  )
  expect(evidence.error).toBeUndefined()
  expect(evidence.rows).toBe(5)
  expect(evidence.incomes).toEqual(['75000', '61000', '52000', '48000', null])
})

test('filter + sort compose: country = US, income desc returns exactly the matching order', async ({
  page,
}) => {
  await openFlatFixture(page)
  const evidence = await clickAndGetJson<WindowEvidence>(
    page,
    "Filter + sort window: country = 'US', income desc",
    'filter-sort-window-result',
  )
  expect(evidence.error).toBeUndefined()
  expect(evidence.rows).toBe(2)
  expect(evidence.customerIds).toEqual(['5', '2'])
  expect(evidence.incomes).toEqual(['75000', '61000'])
})

test('filtered rowCount: count(*) narrows to the matching rows', async ({ page }) => {
  await openFlatFixture(page)
  await page.getByRole('button', { name: 'Filtered rowCount: income > 50000' }).click()
  await expect(page.getByTestId('filtered-row-count-result')).toHaveText('3')
})

test('invalid predicate rejects with an engine error and the engine stays reusable', async ({
  page,
}) => {
  await openFlatFixture(page)
  const evidence = await clickAndGetJson<WindowEvidence>(
    page,
    'Invalid predicate, then filtered rowCount again',
    'predicate-error-result',
  )
  // The invalid predicate rejected with the engine's own error text (never
  // empty, never the harness's marker). The engine then answered the benign
  // filtered count — full reuse after the failure.
  expect(evidence.rejected).toBe(true)
  expect(evidence.error).toBeTruthy()
  expect(evidence.error).not.toBe('')
  expect(evidence.rowCountAfterReuse).toBe(3)
  expect(evidence.fatal).toBeUndefined()
  await expect(page.getByTestId('engine-status')).toHaveText('ready')
})
