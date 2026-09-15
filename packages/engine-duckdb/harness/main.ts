/**
 * Browser harness for the M1-4 e2e proof (tests/e2e/engine-duckdb.spec.ts).
 * The M1-2 sections keep proving lazy boot + first Arrow batch; the M1-4
 * section proves the file lifecycle:
 *
 *   open (OPFS-staged genuine FileSystemFileHandle, same trick as the
 *   data-sources harness — a real handle without any native dialog, ADR 0017
 *   disposable-cache framing) → schema() (DuckDB type strings as-is) →
 *   fetchRange() first window incl. a NULL, a middle window (offset
 *   correctness), failed-query-then-reuse, and nested type-string passthrough.
 *
 * Everything renders through the Arrow API / plain protocol fields. Privacy
 * (ADR 0001/0025): no file names are rendered anywhere in this UI — buttons
 * say "fixture", results show table ids, formats, types, and values only.
 * Not a shipped surface — it exists only in this package's `vite build`.
 */
import { DuckDbEngineClient } from '../src/index'
import type { EngineQueryResult, EngineTableHandle } from '../src/index'

const client = new DuckDbEngineClient()

const statusEl = requiredElement<HTMLElement>('[data-testid="engine-status"]')
const runSmokeButton = requiredElement<HTMLButtonElement>('#run-smoke-query')
const runRangeButton = requiredElement<HTMLButtonElement>('#run-range-query')
const openFlatButton = requiredElement<HTMLButtonElement>('#open-flat')
const schemaFlatButton = requiredElement<HTMLButtonElement>('#schema-flat')
const rangeFirstButton = requiredElement<HTMLButtonElement>('#range-first')
const rangeMiddleButton = requiredElement<HTMLButtonElement>('#range-middle')
const errorReuseButton = requiredElement<HTMLButtonElement>('#error-then-reuse')
const openNestedButton = requiredElement<HTMLButtonElement>('#open-nested')
const schemaNestedButton = requiredElement<HTMLButtonElement>('#schema-nested')

runSmokeButton.addEventListener('click', () => {
  void runSmokeQuery()
})
runRangeButton.addEventListener('click', () => {
  void runRangeQuery()
})
openFlatButton.addEventListener('click', () => {
  void openFixture('/fixtures/customers.parquet', 'flat.parquet', 'flat')
})
openNestedButton.addEventListener('click', () => {
  void openFixture('/fixtures/nested.parquet', 'nested.parquet', 'nested')
})
schemaFlatButton.addEventListener('click', () => {
  void readSchema('flat')
})
schemaNestedButton.addEventListener('click', () => {
  void readSchema('nested')
})
rangeFirstButton.addEventListener('click', () => {
  void runRangeWindow('first', 0, 5)
})
rangeMiddleButton.addEventListener('click', () => {
  void runRangeWindow('middle', 2, 4)
})
errorReuseButton.addEventListener('click', () => {
  void runFailedQueryThenReuse()
})

/** Latest open per fixture kind, so independent steps can address tables. */
const handles = new Map<string, EngineTableHandle>()

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

/**
 * Fetch the fixture bytes served from this harness's public dir, stage them
 * in the OPFS sandbox, and return the *genuine* FileSystemFileHandle (no
 * dialog, no DataTransfer synthesis — see the data-sources harness).
 */
async function stageFixtureInOpfs(
  fixtureUrl: string,
  stagedName: string,
): Promise<FileSystemFileHandle> {
  const response = await fetch(fixtureUrl)
  if (!response.ok) throw new Error(`fixture fetch failed: HTTP ${response.status}`)
  const root = await navigator.storage.getDirectory()
  const fileHandle = await root.getFileHandle(stagedName, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(await response.blob())
  await writable.close()
  return fileHandle
}

/**
 * Open one fixture through the engine: the FileSystemFileHandle satisfies the
 * `EngineFileSource` seam structurally (`{ name, getFile(): Promise<File> }`).
 * Renders table id + detected format — never the file name.
 */
async function openFixture(fixtureUrl: string, stagedName: string, key: string): Promise<void> {
  try {
    const handle = await stageFixtureInOpfs(fixtureUrl, stagedName)
    const table = await client.open(handle)
    handles.set(key, table)
    statusEl.textContent = client.status
    setText(`open-table-id-${key}`, table.id)
    setText(`open-status-${key}`, 'opened')
  } catch (error) {
    statusEl.textContent = client.status
    setText(`open-status-${key}`, `error: ${errorMessage(error)}`)
  }
}

/** DESCRIBE-backed schema: DuckDB type strings passed through unchanged. */
async function readSchema(key: string): Promise<void> {
  const table = handles.get(key)
  if (table === undefined) {
    setText(`schema-${key}`, 'error: no table opened for this fixture yet')
    return
  }
  try {
    const columns = await client.schema(table)
    setText(`schema-${key}`, columns.map((column) => `${column.name}:${column.type}`).join(', '))
    setText(`schema-count-${key}`, String(columns.length))
  } catch (error) {
    setText(`schema-${key}`, `error: ${errorMessage(error)}`)
  }
}

/**
 * Windowed fetchRange: values are read via the Arrow vector API in renderRow
 * — NULLs come back as JS null and are rendered as the literal marker `null`.
 */
async function runRangeWindow(
  key: 'first' | 'middle',
  startRow: number,
  endRow: number,
): Promise<void> {
  const table = handles.get('flat')
  if (table === undefined) {
    setText(`range-${key}-values`, 'error: open the flat fixture first')
    return
  }
  try {
    const result = await client.fetchRange(table, { startRow, endRow })
    setText(`range-${key}-values`, renderColumn(result, 'customer_id'))
    setText(`range-${key}-countries`, renderColumn(result, 'country'))
    setText(`range-${key}-income`, renderColumn(result, 'income'))
    setText(`range-${key}-num-rows`, String(result.batch.numRows))
    setText(`range-${key}-has-more`, String(result.hasMore))
  } catch (error) {
    setText(`range-${key}-values`, `error: ${errorMessage(error)}`)
  }
}

/**
 * Failed-query-then-reuse: an invalid SQL must reject with the engine error
 * (via the typed protocol), and a follow-up query must still answer — the
 * connection and worker survive an error (m1-2 reviewer-note cleanup path).
 */
async function runFailedQueryThenReuse(): Promise<void> {
  try {
    await client.query('SELECT * FROM __assay_no_such_table__')
    setText('query-error', 'no error reported (unexpected)')
  } catch (error) {
    setText('query-error', errorMessage(error))
  }
  try {
    const followUp = await client.query('SELECT 7 AS seven')
    setText('post-error-value', String(followUp.batch.getChildAt(0)?.get(0)))
  } catch (error) {
    setText('post-error-value', `error: ${errorMessage(error)}`)
  }
  statusEl.textContent = client.status // still 'ready': the engine survived
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

function renderColumn(result: EngineQueryResult, columnName: string): string {
  const index = result.batch.schema.fields.findIndex((field) => field.name === columnName)
  const column = index >= 0 ? result.batch.getChildAt(index) : null
  if (column === null) return 'missing column'
  const values: string[] = []
  for (let row = 0; row < column.length; row++) {
    const value: unknown = column.get(row)
    values.push(value === null || value === undefined ? 'null' : String(value))
  }
  return values.join('|')
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
