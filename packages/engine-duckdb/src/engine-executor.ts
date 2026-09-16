/**
 * Worker-side engine operation executor (T2): owns every operation the engine
 * worker performs and serializes them through a single pending-query channel
 * (`./op-channel` — the design rationale lives there).
 *
 * The class is the worker's former request loop, extracted behind injected
 * dependencies (`EngineExecutorDeps`) so the concurrency behavior is
 * unit-testable in Node with a fake session/connection: the fake records
 * pending-ness and FAILS if two connection-touching operations overlap, which
 * is exactly the duckdb-wasm 1.32 "one pending query per connection"
 * constraint this executor exists to enforce. The real worker (`./worker.ts`)
 * wires the same class to DuckDB-WASM.
 *
 * Semantics preserved from the pre-T2 worker (verbatim where noted):
 * - First-batch Arrow transport (ADR 0020): `query`/`range` stream through
 *   `conn.send()`, transport the first record batch as Arrow IPC, report
 *   `hasMore` honestly, and release the reader in `finally` before reporting.
 * - File lifecycle (m1-4): `open` registers the picked `File` under the
 *   engine-generated table id (lazy `BROWSER_FILEREADER` reads — no upfront
 *   copy) and creates a per-format view; a failure rolls the registration
 *   back. `schema`/`range`/`rowCount` address tables through the registry.
 * - `dispose` drops every view/file best-effort per entry and replies when
 *   done. On the channel it is just another FIFO op: it runs after ops that
 *   arrived before it (in-flight work settles first, deterministically), and
 *   anything after it sees an empty registry (clean per-request errors).
 * - Error propagation: every op's failure is caught in `dispatch` and posted
 *   to its own `requestId` — an error never reaches another op's reply and
 *   never leaves the channel (or the connection) wedged.
 *
 * This module must stay free of `@duckdb/duckdb-wasm` runtime imports so it
 * can load under Node in unit tests; DuckDB specifics are injected via
 * `EngineExecutorDeps` and the structural `EngineSessionLike` types below.
 */
import { Table, tableFromIPC, tableToIPC } from 'apache-arrow'
import type { RecordBatch } from 'apache-arrow'
import { createViewSql, detectFileFormat, quotedIdentifier } from './format-view'
import { parseEngineRequest } from './protocol'
import type {
  EngineColumnSchema,
  EngineFilterSpec,
  EngineRangeRequest,
  EngineRequest,
  EngineResponse,
} from './protocol'
import { validateRowWindow } from './range-window'
import { OpChannel } from './op-channel'
import { TableRegistry } from './table-registry'
import type { RegisteredTable } from './table-registry'
import { composeRowCountSql, composeWindowSql } from './window-query'

/**
 * Minimal structural view of an Apache Arrow record-batch stream reader —
 * the slice of `arrow.AsyncRecordBatchStreamReader` the executor consumes
 * (`next` resolves batches; `cancel` releases the connection-side result).
 */
export interface EngineResultReaderLike {
  next(): Promise<IteratorResult<RecordBatch, undefined>>
  cancel(): Promise<void>
}

/**
 * Minimal structural view of a DuckDB connection: everything the executor
 * may touch. All three members are connection-scoped in duckdb-wasm — which
 * is why the executor never runs two of them concurrently (see op-channel).
 */
export interface EngineConnectionLike {
  /** Materialized query (`send` + full drain inside duckdb-wasm). */
  query(sql: string): Promise<Table>
  /** Stream a query; the pending-query slot is held until drain/cancel. */
  send(sql: string): Promise<EngineResultReaderLike>
  /** Cancel the connection's pending query (drains discarded tails). */
  cancelSent(): Promise<unknown>
}

/** Minimal structural view of a booted engine session. */
export interface EngineSessionLike {
  /** Version probe for `engine/init` (db-level, boot-time only). */
  getVersion(): Promise<string>
  readonly conn: EngineConnectionLike
}

/** Dependencies injected by the worker entry (or faked by unit tests). */
export interface EngineExecutorDeps {
  /** Lazy session boot; failures reset so the next op retries (unchanged). */
  ensureSession(): Promise<EngineSessionLike>
  /** Register the picked `File` under its engine-generated name (m1-4). */
  registerFileHandle(registeredFileName: string, file: File): Promise<void>
  /** Best-effort file deregistration (rollback + dispose). */
  dropFile(registeredFileName: string): Promise<unknown>
  /** Deliver a protocol response (with an optional zero-copy transfer list). */
  post(response: EngineResponse, transfer?: ArrayBuffer[]): void
}

export class EngineOpExecutor {
  /** The single pending-query channel every operation is serialized through. */
  private readonly channel = new OpChannel()
  private readonly registry = new TableRegistry()

  constructor(private readonly deps: EngineExecutorDeps) {}

  /**
   * Entry point for raw worker messages. Parsing happens synchronously at
   * arrival so the enqueue order matches message order (FIFO); messages that
   * are not part of the protocol are ignored (no `requestId` to reply to).
   */
  accept(data: unknown): void {
    const request = parseEngineRequest(data)
    if (request === null) {
      return
    }
    // Serialize: no two operations are pending on the shared connection at
    // once. The task's own errors are caught inside `dispatch` and posted to
    // its caller; the channel tail settles regardless (op-channel.ts).
    void this.channel.run(() => this.dispatch(request))
  }

  private async dispatch(request: EngineRequest): Promise<void> {
    try {
      switch (request.type) {
        case 'engine/init': {
          const session = await this.deps.ensureSession()
          this.post({
            type: 'engine/ready',
            requestId: request.requestId,
            duckdbVersion: await session.getVersion(),
          })
          break
        }

        case 'engine/query': {
          const { batchIpc, hasMore } = await this.streamFirstBatch(request.sql)
          this.post({
            type: 'engine/query-result',
            requestId: request.requestId,
            batchIpc,
            hasMore,
          })
          break
        }
        case 'engine/open': {
          await this.runOpen(request.requestId, request.name, request.file)
          break
        }
        case 'engine/schema': {
          await this.runSchema(request.requestId, request.tableId)
          break
        }
        case 'engine/range': {
          await this.runRange(request)
          break
        }
        case 'engine/row-count': {
          await this.runRowCount(request.requestId, request.tableId, request.filters)
          break
        }
        case 'engine/dispose': {
          await this.runDispose(request.requestId)
          break
        }
      }
    } catch (error) {
      // Errors belong to this operation's caller only; the channel moves on.
      this.post({
        type: 'engine/error',
        requestId: request.requestId,
        message: errorMessage(error),
      })
    }
  }

  /**
   * Register the picked file and create its per-format view. The file is
   * registered under the generated table id, so user-controlled names never
   * enter SQL (see `table-registry.ts` / `format-view.ts`). A failure rolls
   * the registration back so a failed open leaves no phantom entry behind.
   */
  private async runOpen(requestId: number, name: string, file: File): Promise<void> {
    const format = detectFileFormat(name)
    if (format === null) {
      // No file names in messages (ADR 0025) — the extension kind is enough.
      throw new Error(
        'unsupported dataset format: this engine reads .parquet, .csv, .jsonl and .json files',
      )
    }
    const { conn } = await this.deps.ensureSession()
    const entry = this.registry.reserve(format)
    try {
      // Lazy reference registration: with the BROWSER_FILEREADER protocol the
      // engine reads the File through slice + FileReaderSync on demand —
      // nothing is copied until a query touches it (verified against the
      // 1.32.0 worker bundle's runtime: protocol case 2). The real protocol
      // constant is injected by the worker entry (deps.registerFileHandle).
      await this.deps.registerFileHandle(entry.registeredFileName, file)
      await conn.query(createViewSql(entry.viewName, entry.registeredFileName, format))
      this.post({ type: 'engine/open-result', requestId, tableId: entry.tableId, format })
    } catch (error) {
      this.registry.remove(entry.tableId)
      await this.deps.dropFile(entry.registeredFileName).catch(() => undefined)
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
  private async runSchema(requestId: number, tableId: string): Promise<void> {
    const entry = this.requireTable(tableId)
    const { conn } = await this.deps.ensureSession()
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
    this.post({ type: 'engine/schema-result', requestId, columns })
  }

  /**
   * Windowed fetch over the view, streamed through the same first-batch Arrow
   * transport as `query`, composed by `composeWindowSql` (m2-2):
   * `SELECT … [WHERE <filters>] [ORDER BY <sort>] LIMIT <count> OFFSET <start>`.
   * The window is re-validated here — the main thread is untrusted — and
   * clamped to `MAX_RANGE_ROWS` (visible-window sized), so a request can never
   * imply full-dataset materialization; the clamp applies with filters present
   * too (a filtered result is windowed exactly like an unfiltered one).
   * Predicates are engine-SQL text (grid contracts v1): they run only against
   * the registered view and only ever reach the engine as SQL text — an
   * invalid predicate rejects this op with the engine's own error message and
   * leaves the engine untouched (see `window-query.ts` for composition rules).
   */
  private async runRange(request: EngineRangeRequest): Promise<void> {
    const entry = this.requireTable(request.tableId)
    const window = validateRowWindow(request.startRow, request.endRow)
    if (!window.valid) {
      throw new Error(`invalid row window: ${window.reason}`)
    }
    const sql = composeWindowSql({
      viewName: entry.viewName,
      columns: request.columns,
      filters: request.filters,
      sort: request.sort,
      limit: window.endRow - window.startRow,
      offset: window.startRow,
    })
    const { batchIpc, hasMore } = await this.streamFirstBatch(sql)
    this.post({ type: 'engine/range-result', requestId: request.requestId, batchIpc, hasMore })
  }

  /**
   * Metadata-only total (`count(*)`) for a registered table (M1-5), optionally
   * narrowed by filters (m2-2 — the filtered count a grid needs when filters
   * change totals). No rows are read beyond what the count's WHERE clause
   * scans: DuckDB answers unfiltered counts from Parquet metadata, and only
   * the single count value crosses the boundary. The value is re-checked here
   * so a future DuckDB type change fails loudly instead of leaking a bogus
   * total into UI state.
   */
  private async runRowCount(
    requestId: number,
    tableId: string,
    filters?: EngineFilterSpec[],
  ): Promise<void> {
    const entry = this.requireTable(tableId)
    const { batchIpc } = await this.streamFirstBatch(
      composeRowCountSql({ viewName: entry.viewName, filters }),
    )
    const value = tableFromIPC(batchIpc).getChildAt(0)?.get(0)
    const rowCount = typeof value === 'bigint' ? Number(value) : value
    if (typeof rowCount !== 'number' || !Number.isSafeInteger(rowCount) || rowCount < 0) {
      throw new Error('count(*) returned an unexpected shape')
    }
    this.post({ type: 'engine/row-count-result', requestId, rowCount })
  }

  /**
   * Drop every view and file registration (best-effort per entry: one failure
   * must not block the others). The client terminates the worker afterwards,
   * which reclaims the whole engine instance regardless — this graceful path
   * exists so a future non-terminal close can reuse the same cleanup.
   *
   * On the channel this is an ordinary FIFO op: in-flight operations enqueued
   * before it settle first (each with its own result or error), so shutdown
   * is deterministic — the registry is empty once this runs, and later
   * requests fail with clean per-request errors instead of racing cleanup.
   */
  private async runDispose(requestId: number): Promise<void> {
    const { conn } = await this.deps.ensureSession()
    for (const entry of this.registry.clear()) {
      await conn
        .query(`DROP VIEW IF EXISTS ${quotedIdentifier(entry.viewName)}`)
        .catch(() => undefined)
      await this.deps.dropFile(entry.registeredFileName).catch(() => undefined)
    }
    this.post({ type: 'engine/disposed', requestId })
  }

  private requireTable(tableId: string): RegisteredTable {
    const entry = this.registry.get(tableId)
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
   * error can never leave the connection occupied. The caller (the channel)
   * guarantees no other operation was pending on the connection meanwhile.
   */
  private async streamFirstBatch(sql: string): Promise<{ batchIpc: Uint8Array; hasMore: boolean }> {
    const { conn } = await this.deps.ensureSession()
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

  private post(response: EngineResponse): void {
    // Zero-copy: when the IPC bytes own their whole ArrayBuffer (the writer's
    // joined output normally does), transfer the buffer instead of cloning it.
    // Ownership moves to the main thread; we never touch the bytes again.
    const transfer: ArrayBuffer[] = []
    if (response.type === 'engine/query-result' || response.type === 'engine/range-result') {
      const buffer = transferableBuffer(response.batchIpc)
      if (buffer !== null) transfer.push(buffer)
    }
    this.deps.post(response, transfer)
  }
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
