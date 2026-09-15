/**
 * Engine worker entry — runs DuckDB-WASM off the main thread (ADR 0002/0021).
 *
 * Bootstrapping is lazy: nothing is instantiated until the first request
 * arrives. DuckDB itself runs on its own nested worker (the async duckdb
 * bundle's architecture); this worker is a thin protocol adapter speaking the
 * typed messages from `./protocol`.
 *
 * Bundle choice: the `mvp` browser bundle requires no cross-origin isolation
 * (no COOP/COEP headers, no SharedArrayBuffer), which we cannot assume for
 * every serving context (app, test harness, future VS Code webview). Moving
 * to the `eh` bundle later for parallelism is a two-URL change in this file.
 */
import * as duckdb from '@duckdb/duckdb-wasm'
import duckdbWorkerUrl from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url'
import duckdbWasmUrl from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url'
import { MAX_RESULT_ROWS, parseEngineRequest } from './protocol'
import type { EngineQueryResult, EngineResponse, QueryCell } from './protocol'

/**
 * Structural type for the worker global scope. The package tsconfig uses the
 * DOM lib (where `self` is typed as `Window`), so we narrow once to the
 * DedicatedWorkerGlobalScope subset this worker actually uses.
 */
interface EngineWorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
  postMessage(response: EngineResponse): void
}

const scope: EngineWorkerScope = self as unknown as EngineWorkerScope

interface EngineSession {
  readonly db: duckdb.AsyncDuckDB
  readonly conn: duckdb.AsyncDuckDBConnection
}

let session: Promise<EngineSession> | null = null

/** Lazy bootstrap: first use instantiates DuckDB; failures reset for a retry. */
function ensureSession(): Promise<EngineSession> {
  if (session === null) {
    session = bootSession().catch((error: unknown) => {
      session = null
      throw error
    })
  }
  return session
}

async function bootSession(): Promise<EngineSession> {
  // Classic worker: duckdb's prebuilt glue script (it sets globalThis.onmessage).
  const duckdbWorker = new Worker(duckdbWorkerUrl)
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), duckdbWorker)
  try {
    await db.instantiate(duckdbWasmUrl)
    const conn = await db.connect()
    return { db, conn }
  } catch (error) {
    // Never leave a half-instantiated engine behind.
    await db.terminate().catch(() => undefined)
    throw error
  }
}

scope.addEventListener('message', (event) => {
  void handleRequest(event.data)
})

async function handleRequest(data: unknown): Promise<void> {
  const request = parseEngineRequest(data)
  if (request === null) {
    // Foreign message: not our protocol; there is no requestId to reply to.
    return
  }
  try {
    switch (request.type) {
      case 'engine/init': {
        const { db } = await ensureSession()
        scope.postMessage({
          type: 'engine/ready',
          requestId: request.requestId,
          duckdbVersion: await db.getVersion(),
        })
        break
      }
      case 'engine/query': {
        const { conn } = await ensureSession()
        const table = await conn.query(request.sql)
        scope.postMessage({
          type: 'engine/query-result',
          requestId: request.requestId,
          result: toQueryResult(table),
        })
        break
      }
    }
  } catch (error) {
    scope.postMessage({
      type: 'engine/error',
      requestId: request.requestId,
      message: errorMessage(error),
    })
  }
}

/**
 * Structural slice of Apache Arrow's `Table`. The concrete Arrow binding
 * stays an implementation detail behind the engine boundary (ADR 0020).
 */
interface ArrowTableLike {
  readonly numRows: number
  readonly schema: { readonly fields: ReadonlyArray<{ readonly name: string }> }
  slice(begin: number, end: number): ArrowTableLike
  toArray(): Array<Record<string, unknown>>
}

function toQueryResult(table: ArrowTableLike): EngineQueryResult {
  const columns = table.schema.fields.map((field) => field.name)
  const truncated = table.numRows > MAX_RESULT_ROWS
  const limited = truncated ? table.slice(0, MAX_RESULT_ROWS) : table
  const rows = limited.toArray().map((record) => columns.map((name) => toCell(record[name])))
  return { columns, rowCount: table.numRows, rows, truncated }
}

/** Scalars pass through; anything nested (lists, structs, …) renders as text. */
function toCell(value: unknown): QueryCell {
  if (value === null || value === undefined) return null
  switch (typeof value) {
    case 'boolean':
    case 'number':
    case 'bigint':
    case 'string':
      return value
    default:
      return String(value)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
