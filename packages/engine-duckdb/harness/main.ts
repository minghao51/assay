/**
 * Browser harness for the M1-2 e2e proof (tests/e2e/engine-duckdb.spec.ts):
 * the page loads without booting anything; clicking a button triggers the
 * lazy bootstrap and renders query results **through the Arrow API** (schema
 * fields, row counts, vector values) — deliberately not as a JSON dump of
 * scalar rows. Not a shipped surface — it exists only in this package's
 * `vite build` output.
 */
import { DuckDbEngineClient } from '../src/index'
import type { EngineQueryResult } from '../src/index'

const client = new DuckDbEngineClient()

const statusEl = requiredElement<HTMLElement>('[data-testid="engine-status"]')
const runSmokeButton = requiredElement<HTMLButtonElement>('#run-smoke-query')
const runRangeButton = requiredElement<HTMLButtonElement>('#run-range-query')

runSmokeButton.addEventListener('click', () => {
  void runSmokeQuery()
})

runRangeButton.addEventListener('click', () => {
  void runRangeQuery()
})

async function runSmokeQuery(): Promise<void> {
  try {
    const ready = await client.ensureReady()
    const result = await client.query('SELECT 42 AS answer')
    statusEl.textContent = client.status
    setText('duckdb-version', ready.duckdbVersion)
    renderResult('', result)
  } catch (error) {
    statusEl.textContent = client.status
    setText('duckdb-version', `error: ${errorMessage(error)}`)
  }
}

/**
 * Multi-batch query: `range(5000)` produces more Arrow record batches than
 * the single transported first batch (hasMore=true, tail cancelled inside the
 * worker). The follow-up query proves the connection stayed usable.
 */
async function runRangeQuery(): Promise<void> {
  try {
    const result = await client.query('SELECT i FROM range(5000) AS t(i)')
    statusEl.textContent = client.status
    renderResult('-range', result)
    const followUp = await client.query('SELECT 7 AS seven')
    setText('post-cancel-value', String(followUp.batch.getChildAt(0)?.get(0)))
  } catch (error) {
    statusEl.textContent = client.status
    setText('post-cancel-value', `error: ${errorMessage(error)}`)
  }
}

/** Render a result strictly through the Arrow API (never a scalar-row dump). */
function renderResult(suffix: string, result: EngineQueryResult): void {
  setText(
    `arrow-schema${suffix}`,
    result.batch.schema.fields.map((field) => `${field.name}:${field.type}`).join(','),
  )
  setText(`arrow-num-rows${suffix}`, String(result.batch.numRows))
  setText(`arrow-value${suffix}`, String(result.batch.getChildAt(0)?.get(0)))
  setText(`query-has-more${suffix}`, String(result.hasMore))
}

function setText(testId: string, value: string): void {
  requiredElement<HTMLElement>(`[data-testid="${testId}"]`).textContent = value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (element === null) {
    throw new Error(`harness is missing element ${selector}`)
  }
  return element
}
