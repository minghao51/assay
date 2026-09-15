/**
 * Engine worker entry — runs DuckDB-WASM off the main thread (ADR 0002/0021).
 *
 * Bootstrapping is lazy: nothing is instantiated until the first request
 * arrives. DuckDB itself runs on its own nested worker (the async duckdb
 * bundle's architecture); this worker is a thin protocol adapter speaking the
 * typed messages from `./protocol`.
 *
 * Query results cross the boundary as Apache Arrow (ADR 0020): queries run
 * through `conn.send()` so batches stream out of DuckDB instead of
 * materializing a full JS-object result. Only the *first* record batch is
 * transported (M1-2) — it is serialized to an Arrow IPC stream and its
 * ArrayBuffer is listed in the postMessage transfer list, so the bytes move
 * to the main thread zero-copy. If further batches exist, `hasMore` is
 * reported and the pending query is cancelled to free the connection.
 *
 * M1-4 file lifecycle: `engine/open` registers the picked `File` with
 * DuckDB under the generated table id (reader protocol `BROWSER_FILEREADER`:
 * DuckDB slices the `File` lazily on demand — no upfront copy of the dataset
 * bytes, so multi-GB files stay cheap) and creates a per-format view. Tables
 * are tracked in a `TableRegistry`; `engine/dispose` drops every view and
 * file registration. Range fetches are ordinary windowed SQL (`LIMIT`/
 * `OFFSET` over the view) reusing the same first-batch Arrow transport, with
 * the window validated and clamped against `MAX_RANGE_ROWS` so the engine can
 * never be made to imply full-dataset materialization.
 *
 * Bundle choice: the `mvp` browser bundle requires no cross-origin isolation
 * (no COOP/COEP headers, no SharedArrayBuffer), which we cannot assume for
 * every serving context (app, test harness, future VS Code webview). Moving
 * to the `eh` bundle later for parallelism is a two-URL change in this file.
 */
import * as duckdb from '@duckdb/duckdb-wasm'
import { Table, tableFromIPC, tableToIPC } from 'apache-arrow'
import duckdbWorkerUrl from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url'
import duckdbWasmUrl from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url'
import { createViewSql, detectFileFormat, quotedIdentifier } from './format-view'
import { parseEngineRequest } from './protocol'
import type { EngineColumnSchema, EngineRangeRequest, EngineResponse } from './protocol'
import { validateRowWindow } from './range-window'
import { TableRegistry } from './table-registry'
import type { RegisteredTable } from './table-registry'

/**
 * Structural type for the worker global scope. The package tsconfig uses the
 * DOM lib (where `self` is typed as `Window`), so we narrow once to the
 * DedicatedWorkerGlobalScope subset this worker actually uses. The transfer
 * list is what makes the Arrow IPC transport zero-copy.
 */
interface EngineWorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
  postMessage(response: EngineResponse, transfer?: ArrayBuffer[]): void
}

const scope: EngineWorkerScope = self as unknown as EngineWorkerScope

interface EngineSession {
  readonly db: duckdb.AsyncDuckDB
  readonly conn: duckdb.AsyncDuckDBConnection
}

let session: Promise<EngineSession> | null = null
const registry = new TableRegistry()

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
        post({
          type: 'engine/ready',
          requestId: request.requestId,
          duckdbVersion: await db.getVersion(),
        })
        break
      }
      case 'engine/query': {
        const { batchIpc, hasMore } = await streamFirstBatch(request.sql)
        post({ type: 'engine/query-result', requestId: request.requestId, batchIpc, hasMore })
        break
      }
      case 'engine/open': {
        await runOpen(request.requestId, request.name, request.file)
        break
      }
      case 'engine/schema': {
        await runSchema(request.requestId, request.tableId)
        break
      }
      case 'engine/range': {
        await runRange(request)
        break
      }
      case 'engine/row-count': {
        await runRowCount(request.requestId, request.tableId)
        break
      }
      case 'engine/dispose': {
        await runDispose(request.requestId)
        break
      }
    }
  } catch (error) {
    post({ type: 'engine/error', requestId: request.requestId, message: errorMessage(error) })
  }
}

/**
 * Register the picked file and create its per-format view. The file is
 * registered under the generated table id, so user-controlled names never
 * enter SQL (see `table-registry.ts` / `format-view.ts`). A failure rolls the
 * registration back so a failed open leaves no phantom entry behind.
 */
async function runOpen(requestId: number, name: string, file: File): Promise<void> {
  const format = detectFileFormat(name)
  if (format === null) {
    // No file names in messages (ADR 0025) — the extension kind is enough.
    throw new Error(
      'unsupported dataset format: this engine reads .parquet, .csv, .jsonl and .json files',
    )
  }
  const { db, conn } = await ensureSession()
  const entry = registry.reserve(format)
  try {
    // Lazy reference registration: with the BROWSER_FILEREADER protocol the
    // engine reads the File through slice + FileReaderSync on demand —
    // nothing is copied until a query touches it (verified against the
    // 1.32.0 worker bundle's runtime: protocol case 2).
    await db.registerFileHandle(
      entry.registeredFileName,
      file,
      duckdb.DuckDBDataProtocol.BROWSER_FILEREADER,
      false,
    )
    await conn.query(createViewSql(entry.viewName, entry.registeredFileName, format))
    post({ type: 'engine/open-result', requestId, tableId: entry.tableId, format })
  } catch (error) {
    registry.remove(entry.tableId)
    await db.dropFile(entry.registeredFileName).catch(() => undefined)
    throw error
  }
}

/**
 * Column name/type pairs straight from DuckDB (`DESCRIBE`). Type strings are
 * passed through as-is — nested types arrive as their full SQL strings
 * (`STRUCT(...)`, `VARCHAR[]`, `DECIMAL(21,1)`, …); a mapping layer would
 * duplicate DuckDB's type system for no M1 benefit (documented M1-4 choice;
 * m1-6 renders these strings in the schema tree).
 */
async function runSchema(requestId: number, tableId: string): Promise<void> {
  const entry = requireTable(tableId)
  const { conn } = await ensureSession()
  const described = await conn.query(`DESCRIBE ${quotedIdentifier(entry.viewName)}`)
  // DESCRIBE yields all-VARCHAR columns; the casts assert that shape (Arrow's
  // generic `getChild` cannot know it).
  const names = (described.getChild('column_name')?.toArray() ?? []) as string[]
  const types = (described.getChild('column_type')?.toArray() ?? []) as string[]
  if (names.length === 0 || names.length !== types.length) {
    throw new Error('DESCRIBE returned an unexpected shape')
  }
  const columns: EngineColumnSchema[] = names.map((columnName, index) => ({
    name: columnName,
    type: types[index] ?? '',
  }))
  post({ type: 'engine/schema-result', requestId, columns })
}

/**
 * Windowed fetch: `LIMIT <count> OFFSET <start>` over the view, streamed
 * through the same first-batch Arrow transport as `query`. The window is
 * re-validated here — the main thread is untrusted — and clamped to
 * `MAX_RANGE_ROWS` (visible-window sized), so a request can never imply
 * full-dataset materialization.
 */
async function runRange(request: EngineRangeRequest): Promise<void> {
  const entry = requireTable(request.tableId)
  const window = validateRowWindow(request.startRow, request.endRow)
  if (!window.valid) {
    throw new Error(`invalid row window: ${window.reason}`)
  }
  const projection = request.columns
    ? request.columns.map((column) => quotedIdentifier(column)).join(', ')
    : '*'
  const sql =
    `SELECT ${projection} FROM ${quotedIdentifier(entry.viewName)}` +
    ` LIMIT ${window.endRow - window.startRow} OFFSET ${window.startRow}`
  const { batchIpc, hasMore } = await streamFirstBatch(sql)
  post({ type: 'engine/range-result', requestId: request.requestId, batchIpc, hasMore })
}

/**
 * Metadata-only total (`count(*)`) for a registered table (M1-5). No rows are
 * read: DuckDB answers from Parquet metadata, and only the single count value
 * crosses the boundary. The value is re-checked here so a future DuckDB type
 * change fails loudly instead of leaking a bogus total into UI state.
 */
async function runRowCount(requestId: number, tableId: string): Promise<void> {
  const entry = requireTable(tableId)
  const { batchIpc } = await streamFirstBatch(
    `SELECT count(*)::BIGINT AS row_count FROM ${quotedIdentifier(entry.viewName)}`,
  )
  const value = tableFromIPC(batchIpc).getChildAt(0)?.get(0)
  const rowCount = typeof value === 'bigint' ? Number(value) : value
  if (typeof rowCount !== 'number' || !Number.isSafeInteger(rowCount) || rowCount < 0) {
    throw new Error('count(*) returned an unexpected shape')
  }
  post({ type: 'engine/row-count-result', requestId, rowCount })
}

/**
 * Drop every view and file registration (best-effort per entry: one failure
 * must not block the others). The client terminates the worker afterwards,
 * which reclaims the whole engine instance regardless — this graceful path
 * exists so a future non-terminal close can reuse the same cleanup.
 */
async function runDispose(requestId: number): Promise<void> {
  const { db, conn } = await ensureSession()
  for (const entry of registry.clear()) {
    await conn
      .query(`DROP VIEW IF EXISTS ${quotedIdentifier(entry.viewName)}`)
      .catch(() => undefined)
    await db.dropFile(entry.registeredFileName).catch(() => undefined)
  }
  post({ type: 'engine/disposed', requestId })
}

function requireTable(tableId: string): RegisteredTable {
  const entry = registry.get(tableId)
  if (entry === null) {
    throw new Error(`unknown table handle: ${tableId}`)
  }
  return entry
}

/**
 * Execute the query and transport the first record batch as an Arrow IPC
 * stream. A second `next()` peek determines `hasMore` honestly; when the
 * result continues past the first batch, the remaining batches are dropped
 * and the pending query is cancelled so the connection stays usable for
 * follow-up queries.
 *
 * Cleanup ordering (m1-2 reviewer notes): the reader is always released in
 * `finally` — on success, on the empty-stream error, and when a mid-stream
 * `next()` rejects — *before* anything is reported to the main thread, so an
 * error can never leave the connection occupied.
 */
async function streamFirstBatch(sql: string): Promise<{ batchIpc: Uint8Array; hasMore: boolean }> {
  const { conn } = await ensureSession()
  const reader = await conn.send(sql)
  let hasMore = false
  try {
    const first = await reader.next()
    if (first.value === undefined) {
      // DuckDB always emits a batch for a result (a 0-row batch still carries
      // the schema), so an empty stream here means the engine lied to us.
      throw new Error('query produced no record batches')
    }
    const peek = await reader.next()
    hasMore = !peek.done
    return { batchIpc: tableToIPC(new Table(first.value)), hasMore }
  } finally {
    // The cancel promises are awaited (with the error swallowed and noted):
    // a cancel failure must not mask the original error or the result.
    await reader.cancel().catch(() => undefined)
    if (hasMore) {
      // Free the connection; the discarded tail is reported via `hasMore`.
      await conn.cancelSent().catch(() => undefined)
    }
  }
}

function post(response: EngineResponse): void {
  // Zero-copy: when the IPC bytes own their whole ArrayBuffer (the writer's
  // joined output normally does), transfer the buffer instead of cloning it.
  // Ownership moves to the main thread; we never touch the bytes again.
  const transfer: ArrayBuffer[] = []
  if (response.type === 'engine/query-result' || response.type === 'engine/range-result') {
    const buffer = transferableBuffer(response.batchIpc)
    if (buffer !== null) transfer.push(buffer)
  }
  scope.postMessage(response, transfer)
}

/** The underlying buffer, when it is exactly owned and transferable. */
function transferableBuffer(bytes: Uint8Array): ArrayBuffer | null {
  const { buffer, byteOffset, byteLength } = bytes
  // SharedArrayBuffer cannot go into a transfer list (structured clone).
  if (!(buffer instanceof ArrayBuffer)) return null
  return byteOffset === 0 && byteLength === buffer.byteLength ? buffer : null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
