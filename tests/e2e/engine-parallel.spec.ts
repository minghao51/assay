import { expect, test } from '@playwright/test'

// Task T2 (handoff §6): worker-side operation serialization. This spec fires
// four operations CONCURRENTLY against the real DuckDB-WASM worker in
// Chromium — a query, a fetchRange window, a rowCount, and a deliberately
// failing query — then disposes. duckdb-wasm 1.32 polls ONE pending query per
// connection, so without the worker's single pending-query channel these
// calls could collide (misattributed batches, opaque `_setThrew` errors).
// The asserted contract: every op settles correctly on its own (results match
// the fixture; the failure reaches only its own caller), and the graceful
// dispose completes afterwards.
//
// Harness served from packages/engine-duckdb by the second webServer in
// playwright.config.ts; port env-overridable for parallel worktree batches
// (default 4179).
const HARNESS_URL = `http://localhost:${process.env['ASSAY_E2E_PORT_ENGINE'] ?? 4179}/`

/** Structural mirror of the harness's ParallelSettlements JSON. */
interface ParallelSettlements {
  queryValue?: string
  queryError?: string
  rangeRows?: number
  rangeFirstValue?: string
  rangeError?: string
  rowCount?: number
  rowCountError?: string
  failingRejected?: boolean
  failingMessage?: string
  disposed?: boolean
  fatal?: string
}

test('four concurrent engine calls settle correctly and dispose completes last', async ({
  page,
}) => {
  test.setTimeout(120_000) // engine boot + open + four concurrent ops
  await page.goto(HARNESS_URL)

  // Laziness: loading the page must not boot the engine.
  await expect(page.getByTestId('engine-status')).toHaveText('idle')

  // Seed a registered table for the handle-addressed ops (fetchRange/rowCount).
  await page.getByRole('button', { name: 'Open flat fixture via engine' }).click()
  await expect(page.getByTestId('open-status-flat')).toHaveText('opened', { timeout: 60_000 })
  await expect(page.getByTestId('open-table-id-flat')).toHaveText('t1')

  // Fire the concurrent burst + dispose; the harness renders the settlements.
  await page.getByRole('button', { name: 'Run 4 concurrent engine calls, then dispose' }).click()
  const element = page.getByTestId('parallel-result')
  await expect(element).not.toHaveText('not run', { timeout: 60_000 })
  const settlements = JSON.parse((await element.textContent())!) as ParallelSettlements

  // No fatal harness error, and every op settled on its own:
  expect(settlements.fatal, 'harness reported a fatal error').toBeUndefined()

  // The query returned its own value (not an error, not another op's data).
  expect(settlements.queryValue, 'query settled with its own value').toBe('42')
  expect(settlements.queryError).toBeUndefined()

  // The fetchRange window matches the fixture (5 rows, first id = 1).
  expect(settlements.rangeRows, 'fetchRange settled with the fixture window').toBe(5)
  expect(settlements.rangeFirstValue).toBe('1')
  expect(settlements.rangeError).toBeUndefined()

  // The rowCount is the fixture total.
  expect(settlements.rowCount, 'rowCount settled with the fixture total').toBe(5)
  expect(settlements.rowCountError).toBeUndefined()

  // The failing query rejected with a real error message — one op's failure
  // never leaked into (or wedged) the others.
  expect(settlements.failingRejected, 'the failing query rejected').toBe(true)
  expect(settlements.failingMessage, 'the failing query carried an error message').toBeTruthy()

  // Dispose completed gracefully after every concurrent op had settled.
  expect(settlements.disposed, 'graceful dispose completed').toBe(true)
  await expect(page.getByTestId('engine-status')).toHaveText('disposed')
})
