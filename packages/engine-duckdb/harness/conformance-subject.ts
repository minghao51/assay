/**
 * The engine-duckdb adapter for the data-engine conformance suite in
 * `@assay/testing` (T1; docs/engineering/05-repository-structure.md §4).
 *
 * Dependency direction: implementations import the testing package — never
 * the reverse — so the suite stays engine-agnostic and a later engine
 * (engine-parquet) can run the same scenarios by providing its own subject.
 *
 * Host-specific behavior lives here, not in the suite:
 * - staging: good fixture, runtime-built wide CSV, and suite-corrupted bytes
 *   are staged into the origin's OPFS sandbox (ADR 0017 disposable-cache
 *   framing) and opened through their genuine FileSystemFileHandle — the
 *   same trick as the M1-4 sections of `main.ts`.
 * - SQL hooks: DuckDB-specific queries for the error, smoke, registry-probe,
 *   and mid-stream-failure scenarios.
 *
 * Privacy (ADR 0001/0025): details and facts produced here contain ids,
 * counts, and flags — never dataset contents or file names.
 */
import {
  DuckDbEngineClient,
  EngineDisposedError,
  EngineOperationError,
  EngineQueryError,
  MAX_RANGE_ROWS,
} from '../src/index'
import type {
  ConformanceBatchResult,
  ConformanceEngineClient,
  ConformanceErrorMatchers,
  ConformanceFileSource,
  EngineConformanceSubject,
} from '@assay/testing'

/** The customers.parquet golden fixture, as the DuckDB DESCRIBE reports it. */
const GOOD_DATASET = {
  rowCount: 5,
  columns: [
    { name: 'customer_id', type: 'BIGINT', values: ['1', '2', '3', '4', '5'] },
    { name: 'country', type: 'VARCHAR', values: ['SG', 'US', 'SG', 'DE', 'US'] },
    { name: 'income', type: 'BIGINT', values: ['52000', '61000', null, '48000', '75000'] },
    // DATE renders engine-specifically through Arrow (Temporal-typed), so the
    // suite asserts only its name/type here; values are checked for the rest.
    { name: 'signup_date', type: 'DATE' },
  ],
} as const

/** Rows of the runtime-built wide CSV; must exceed the window cap (suite precondition). */
const WIDE_ROW_COUNT = 1500

/**
 * The window cap the engine enforces — imported from the engine package so
 * the suite's clamp assertions cannot drift from the real limit.
 */
const MAX_WINDOW_ROWS = MAX_RANGE_ROWS

const FAILING_SQL = 'SELECT * FROM __assay_no_such_table__'
const SMOKE_SQL = 'SELECT 42 AS answer'
const SMOKE_VALUE = '42'

/**
 * Mid-stream failure mechanism (deterministic): DuckDB evaluates vectorized
 * chunks of 2048 rows. The CASE yields `i` for every row of the first chunk
 * (rows 0–2047), so the worker's `streamFirstBatch` successfully receives and
 * transports batch one; pulling the *second* chunk raises `error()` inside
 * the engine — the worker's reader-cleanup path runs (`reader.cancel()` in
 * `finally`) and the typed query error reaches the client. The scenario then
 * proves the connection was released: the smoke query must still answer.
 */
const MID_STREAM_FAILURE_SQL =
  "SELECT CASE WHEN i < 2048 THEN i ELSE error('assay conformance mid-stream failure') END AS v FROM range(5000) AS t(i)"

const ERRORS: ConformanceErrorMatchers = {
  operation: (error) => error instanceof EngineOperationError,
  query: (error) => error instanceof EngineQueryError,
  disposed: (error) => error instanceof EngineDisposedError,
}

/** Stage bytes in the OPFS sandbox; the handle satisfies `EngineFileSource`. */
async function stageBytesInOpfs(bytes: Uint8Array, name: string): Promise<FileSystemFileHandle> {
  const root = await navigator.storage.getDirectory()
  const handle = await root.getFileHandle(name, { create: true })
  const writable = await handle.createWritable()
  // The stream wants an ArrayBuffer-backed view (the suite's `Uint8Array` is
  // deliberately ArrayBufferLike so Node subjects can stage `Buffer`s); copy
  // once — these bytes are fixture-sized test data.
  const chunk = new Uint8Array(bytes.byteLength)
  chunk.set(bytes)
  await writable.write(chunk)
  await writable.close()
  return handle
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`fixture fetch failed: HTTP ${String(response.status)}`)
  return new Uint8Array(await response.arrayBuffer())
}

/** Runtime-built wide CSV (`id` header + `wideRowCount` integer rows). */
function buildWideCsv(rowCount: number): Uint8Array {
  const lines = ['id']
  for (let row = 0; row < rowCount; row++) lines.push(String(row))
  return new TextEncoder().encode(lines.join('\n') + '\n')
}

/** A genuine `FileSystemFileHandle` satisfies the suite's source seam. */
function asFileSource(handle: FileSystemFileHandle): ConformanceFileSource {
  return handle
}

export interface DuckDbConformanceSubjectOptions {
  /** URL the good Parquet fixture is served from (harness public dir). */
  goodFixtureUrl: string
}

export function createDuckDbConformanceSubject(
  options: DuckDbConformanceSubjectOptions,
): EngineConformanceSubject {
  const goodParquetBytes = async (): Promise<Uint8Array> => fetchBytes(options.goodFixtureUrl)
  return {
    name: 'engine-duckdb',
    createClient: () => asConformanceClient(new DuckDbEngineClient()),
    isIdle: (client) => client.status === 'idle',
    isReady: (client) => client.status === 'ready',
    errors: ERRORS,
    dataset: GOOD_DATASET,
    maxWindowRows: MAX_WINDOW_ROWS,
    wideRowCount: WIDE_ROW_COUNT,
    stageGoodFile: async () => {
      const bytes = await goodParquetBytes()
      return asFileSource(await stageBytesInOpfs(bytes, 'assay-conformance-good.parquet'))
    },
    stageWideFile: async () => {
      const csv = buildWideCsv(WIDE_ROW_COUNT)
      return asFileSource(await stageBytesInOpfs(csv, 'assay-conformance-wide.csv'))
    },
    goodParquetBytes,
    stageBytes: async (bytes, name) => asFileSource(await stageBytesInOpfs(bytes, name)),
    failingSql: () => FAILING_SQL,
    midStreamFailureSql: () => MID_STREAM_FAILURE_SQL,
    smokeSql: () => SMOKE_SQL,
    smokeSqlValue: SMOKE_VALUE,
    // Registry probe: DuckDB holds one non-internal view per successful open
    // (the rollback scenario asserts 0 after a failed open, 1 after recovery).
    registeredTableCount: async (client) => {
      const result: ConformanceBatchResult = await client.query(
        'SELECT count(*)::BIGINT AS n FROM duckdb_views() WHERE internal = false',
      )
      const vector = result.batch.getChildAt(0)
      if (vector === null) return null
      const value: unknown = vector.get(0)
      const count = typeof value === 'bigint' ? Number(value) : value
      return typeof count === 'number' ? count : null
    },
  }
}

function asConformanceClient(client: DuckDbEngineClient): ConformanceEngineClient {
  return client
}
