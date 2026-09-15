import { expect, test } from '@playwright/test'

// Task M1-2 proof (handoff §6 #2): `query()` returns the first Apache Arrow
// record batch to the main thread (ADR 0020) over the typed postMessage
// protocol (ADR 0021). DuckDB-WASM cannot run under Node vitest — this e2e
// is the authoritative proof. The harness renders results strictly through
// the Arrow API (schema fields, batch row counts, vector reads) so these
// assertions exercise real Arrow reconstitution, not JSON string comparison.
// Harness served from packages/engine-duckdb by the second webServer in
// playwright.config.ts.
const HARNESS_URL = 'http://localhost:4179/'

test('engine-duckdb boots lazily in a worker and query() returns the first Arrow batch', async ({
  page,
}) => {
  await page.goto(HARNESS_URL)

  // Laziness: loading the page must not boot the engine.
  await expect(page.getByTestId('engine-status')).toHaveText('idle')

  await page.getByRole('button', { name: 'Boot engine and run SELECT 42 AS answer' }).click()

  // The real DuckDB engine answered; the result was reconstituted on the main
  // thread as an Arrow table and read back through the Arrow API.
  await expect(page.getByTestId('engine-status')).toHaveText('ready')
  await expect(page.getByTestId('duckdb-version')).toContainText(/v\d+\.\d+/)
  await expect(page.getByTestId('arrow-schema')).toHaveText('answer:Int32')
  await expect(page.getByTestId('arrow-num-rows')).toHaveText('1')
  await expect(page.getByTestId('arrow-value')).toHaveText('42')
  await expect(page.getByTestId('query-has-more')).toHaveText('false')
})

test('multi-batch result reports hasMore and the engine stays usable after the tail is cancelled', async ({
  page,
}) => {
  await page.goto(HARNESS_URL)
  await page.getByRole('button', { name: /range\(5000\)/ }).click()

  // DuckDB streams range(5000) in 2048-row Arrow batches: the first batch is
  // transported, hasMore reports the discarded tail honestly, and the worker
  // cancelled the pending query — the follow-up SELECT must still answer 7.
  await expect(page.getByTestId('engine-status')).toHaveText('ready')
  await expect(page.getByTestId('arrow-schema-range')).toHaveText('i:Int64')
  await expect(page.getByTestId('arrow-num-rows-range')).toHaveText('2048')
  await expect(page.getByTestId('query-has-more-range')).toHaveText('true')
  await expect(page.getByTestId('post-cancel-value')).toHaveText('7')
})
