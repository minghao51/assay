/**
 * Browser harness for the M1-1 e2e proof (tests/e2e/engine-duckdb.spec.ts):
 * the page loads without booting anything; clicking the button triggers the
 * lazy bootstrap and renders the smoke query result. Not a shipped surface —
 * it exists only in this package's `vite build` output.
 */
import { DuckDbEngineClient } from '../src/index'

const client = new DuckDbEngineClient()

const statusEl = requiredElement<HTMLElement>('[data-testid="engine-status"]')
const resultEl = requiredElement<HTMLElement>('[data-testid="query-result"]')
const runButton = requiredElement<HTMLButtonElement>('#run-smoke-query')

runButton.addEventListener('click', () => {
  void runSmokeQuery()
})

async function runSmokeQuery(): Promise<void> {
  statusEl.textContent = 'booting'
  try {
    const ready = await client.ensureReady()
    const result = await client.query('SELECT 42')
    statusEl.textContent = client.status
    resultEl.textContent = JSON.stringify(
      {
        duckdbVersion: ready.duckdbVersion,
        columns: result.columns,
        rowCount: result.rowCount,
        rows: result.rows,
        truncated: result.truncated,
      },
      null,
      2,
    )
  } catch (error) {
    statusEl.textContent = client.status
    resultEl.textContent = `error: ${error instanceof Error ? error.message : String(error)}`
  }
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (element === null) {
    throw new Error(`harness is missing element ${selector}`)
  }
  return element
}
