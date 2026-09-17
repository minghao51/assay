/**
 * Worker-side engine operation executor (T2, two lanes since m2-7): owns every
 * operation the engine worker performs, serialized through TWO pending-query
 * channels (`./op-channel` — the design rationale and the measured m2-7
 * evidence live there): a query lane (user SQL, profile — heavy scans) on its
 * own connection, and a registry lane (open/schema/range/rowCount/dispose —
 * the short, latency-sensitive metadata and window traffic) on another. Each
 * lane preserves the T2 guarantees (per-connection single pending query,
 * FIFO order, per-op error isolation); across lanes the connections are
 * independent, so a long query no longer blocks the grid's windows.
 *
 * The class is the worker's former request loop, extracted behind injected
 * dependencies (`EngineExecutorDeps`) so the concurrency behavior is
 * unit-testable in Node with a fake session/connection: the fakes record
 * pending-ness and FAIL if two connection-touching operations overlap ON THE
 * SAME connection, which is exactly the duckdb-wasm 1.32 "one pending query
 * per connection" constraint this executor exists to enforce. The real worker
 * (`./worker.ts`) wires the same class to DuckDB-WASM.
 *
 * Semantics preserved from the pre-T2 worker (verbatim where noted):
 * - First-batch Arrow transport (ADR 0020): `query`/`range` stream through
 *   `conn.send()`, transport the first record batch as Arrow IPC, report
 *   `hasMore` honestly, and release the reader in `finally` before reporting.
 *   m2-7: `query`/`profile` stream through the QUERY-lane connection, the
 *   registry ops through the registry-lane connection — same transport either
 *   way (protocol unchanged; routing is worker-internal).
 * - File lifecycle (m1-4): `open` registers the picked `File` under the
 *   engine-generated table id (lazy `BROWSER_FILEREADER` reads — no upfront
 *   copy) and creates a per-format view; a failure rolls the registration
 *   back. `schema`/`range`/`rowCount`/`profile` address tables through the
 *   registry. The view is created on the registry-lane connection; DuckDB
 *   persistent views live in the database catalog, so the query lane reads
 *   them (pinned by e2e: user SQL over `assay_tN` after an open).
 * - `dispose` drops every view/file best-effort per entry and replies when
 *   done. On its lane it is just another FIFO op; since m2-7 it ALSO awaits a
 *   query-lane barrier first, so in-flight queries settle deterministically
 *   before any view is dropped (the T2 shutdown order, now across both
 *   lanes; the client's dispose timeout still bounds the wait). Anything
 *   after it sees an empty registry (clean per-request errors).
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
  EngineCategoricalTopKEntry,
  EngineColumnSchema,
  EngineFilterSpec,
  EngineNumericColumnStats,
  EngineProfileColumn,
  EngineRangeRequest,
  EngineRequest,
  EngineResponse,
} from './protocol'
import { validateRowWindow } from './range-window'
import { OpChannel } from './op-channel'
import { classifyProfileColumnType } from './profile-classify'
import { composeProfileBaseSql, composeProfileTopKSql, PROFILE_BASE_SLOT } from './profile-query'
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

/** Minimal structural view of a booted engine session (one lane pair). */
export interface EngineSessionLike {
  /** Version probe for `engine/init` (db-level, boot-time only). */
  getVersion(): Promise<string>
  /** Registry-lane connection: open/schema/range/rowCount/dispose. */
  readonly conn: EngineConnectionLike
  /** Query-lane connection: `engine/query` and `engine/profile` (m2-7). */
  readonly queryConn: EngineConnectionLike
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

/**
 * One pending-query lane: its FIFO channel (`OpChannel`) plus the connection
 * its ops run on, derived from the session. Routing (`accept`) and connection
 * choice are the same decision — both come from this object — so rerouting an
 * op class to another lane moves it onto that lane's connection too. The m2-7
 * fix round pinned this: with the connection hard-coded per handler, rerouting
 * `profile` to the registry lane would run its DESCRIBE beside a parked user
 * query on the query-lane connection — the exact T2 pending-query collision
 * (guarded by the parked-query unit drill in engine-executor.test.ts).
 */
interface OpLane {
  readonly channel: OpChannel
  readonly connection: (session: EngineSessionLike) => EngineConnectionLike
}

export class EngineOpExecutor {
  /**
   * The two pending-query lanes (m2-7): user SQL and profile scans serialize
   * on the query lane; the short registry/window ops serialize on the
   * registry lane. See `./op-channel` for the measured rationale.
   */
  private readonly queryLane: OpLane = {
    channel: new OpChannel(),
    connection: (session) => session.queryConn,
  }
  private readonly registryLane: OpLane = {
    channel: new OpChannel(),
    connection: (session) => session.conn,
  }
  private readonly registry = new TableRegistry()

  constructor(private readonly deps: EngineExecutorDeps) {}

  /**
   * Entry point for raw worker messages. Parsing happens synchronously at
   * arrival so the enqueue order matches message order (FIFO per lane);
   * messages that are not part of the protocol are ignored (no `requestId`
   * to reply to).
   */
  accept(data: unknown): void {
    const request = parseEngineRequest(data)
    if (request === null) {
      return
    }
    // Route to the op class's lane and serialize there: no two operations
    // are pending on the lane's connection at once. The lane also supplies
    // that connection, so routing and connection choice are one decision.
    // The task's own errors are caught inside `dispatch` and posted to its
    // caller; the lane tail settles regardless (op-channel.ts).
    const lane =
      request.type === 'engine/query' || request.type === 'engine/profile'
        ? this.queryLane
        : this.registryLane
    void lane.channel.run(() => this.dispatch(request, lane))
  }

  private async dispatch(request: EngineRequest, lane: OpLane): Promise<void> {
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
          // Query lane: user SQL shares its lane only with other queries and
          // profile scans — never with the grid's windows.
          const session = await this.deps.ensureSession()
          const { batchIpc, hasMore } = await this.streamFirstBatch(
            lane.connection(session),
            request.sql,
          )
          this.post({
            type: 'engine/query-result',
            requestId: request.requestId,
            batchIpc,
            hasMore,
          })
          break
        }
        case 'engine/open': {
          await this.runOpen(request.requestId, request.name, request.file, lane)
          break
        }
        case 'engine/schema': {
          await this.runSchema(request.requestId, request.tableId, lane)
          break
        }
        case 'engine/range': {
          await this.runRange(request, lane)
          break
        }
        case 'engine/row-count': {
          await this.runRowCount(request.requestId, request.tableId, lane, request.filters)
          break
        }
        case 'engine/profile': {
          await this.runProfile(request.requestId, request.tableId, lane)
          break
        }
        case 'engine/dispose': {
          await this.runDispose(request.requestId, lane)
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
  private async runOpen(requestId: number, name: string, file: File, lane: OpLane): Promise<void> {
    const format = detectFileFormat(name)
    if (format === null) {
      // No file names in messages (ADR 0025) — the extension kind is enough.
      throw new Error(
        'unsupported dataset format: this engine reads .parquet, .csv, .jsonl and .json files',
      )
    }
    const conn = lane.connection(await this.deps.ensureSession())
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
  private async runSchema(requestId: number, tableId: string, lane: OpLane): Promise<void> {
    const entry = this.requireTable(tableId)
    const conn = lane.connection(await this.deps.ensureSession())
    const columns = await this.describeView(conn, entry.viewName)
    this.post({ type: 'engine/schema-result', requestId, columns })
  }

  /**
   * DESCRIBE-backed column list for a registered view — the shared
   * name/type source for `schema` and `profile` (m2-5), so a profile's type
   * strings can never drift from the schema surface.
   */
  private async describeView(
    conn: EngineConnectionLike,
    viewName: string,
  ): Promise<EngineColumnSchema[]> {
    const described = await conn.query(`DESCRIBE ${quotedIdentifier(viewName)}`)
    // DESCRIBE yields all-VARCHAR columns; the casts assert that shape (Arrow's
    // generic `getChild` cannot know it).
    const names = (described.getChild('column_name')?.toArray() ?? []) as string[]
    const types = (described.getChild('column_type')?.toArray() ?? []) as string[]
    if (names.length === 0 || names.length !== types.length) {
      throw new Error('DESCRIBE returned an unexpected shape')
    }
    return names.map((columnName, index) => ({
      name: columnName,
      type: types[index] ?? '',
    }))
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
  private async runRange(request: EngineRangeRequest, lane: OpLane): Promise<void> {
    const entry = this.requireTable(request.tableId)
    const window = validateRowWindow(request.startRow, request.endRow)
    if (!window.valid) {
      throw new Error(`invalid row window: ${window.reason}`)
    }
    const conn = lane.connection(await this.deps.ensureSession())
    const sql = composeWindowSql({
      viewName: entry.viewName,
      columns: request.columns,
      filters: request.filters,
      sort: request.sort,
      limit: window.endRow - window.startRow,
      offset: window.startRow,
    })
    const { batchIpc, hasMore } = await this.streamFirstBatch(conn, sql)
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
    lane: OpLane,
    filters?: EngineFilterSpec[],
  ): Promise<void> {
    const entry = this.requireTable(tableId)
    const conn = lane.connection(await this.deps.ensureSession())
    const { batchIpc } = await this.streamFirstBatch(
      conn,
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
   * Full statistics profile of a registered table (m2-5), composed by
   * `profile-query.ts` (see the module doc for the scan budget):
   *
   * 1. DESCRIBE (metadata only) → classify each column from its DuckDB type
   *    string (`profile-classify.ts` — numeric / categorical / other).
   * 2. ONE combined aggregate query — a single scan for row count,
   *    nullCount/distinctCount of every column, and (numeric columns)
   *    min/max/mean/stddev plus the p50/p90/p95/p99 quantiles as ONE
   *    DOUBLE[4] aggregate per column (one values buffer per column).
   * 3. One top-k query per categorical column (bounded ≤ k rows; NULLs
   *    excluded — `nullCount` carries them; ties by value ascending).
   *
   * Results are strictly bounded (one row; ≤ k rows per categorical column),
   * so the reads use `conn.query` (materialized) instead of the first-batch
   * streaming transport — no cancellation surface is needed. Everything runs
   * inside ONE query-lane op (m2-7: profile shares the query lane — it is a
   * heavy scan like user SQL, and must never sit on the registry lane where
   * it would block the grid's windows for its whole scan) on the connection
   * that lane provides (`OpLane` — routing and connection are one decision):
   * the sequential awaits never overlap on the query connection (per-lane T2
   * invariant), and any failure rejects this op with the engine's own error,
   * leaving the engine reusable.
   *
   * Graceful degradation: `other`-kind columns (nested/exotic types) carry
   * only name/type/nullCount/distinctCount — an exotic type can never fail
   * the profile (classifier contract).
   */
  private async runProfile(requestId: number, tableId: string, lane: OpLane): Promise<void> {
    const entry = this.requireTable(tableId)
    const conn = lane.connection(await this.deps.ensureSession())
    const schema = await this.describeView(conn, entry.viewName)
    const specs = schema.map((column) => ({
      name: column.name,
      kind: classifyProfileColumnType(column.type),
    }))

    const base = composeProfileBaseSql({ viewName: entry.viewName, columns: specs })
    const baseRow = await conn.query(base.sql)
    if (baseRow.numRows !== 1) {
      throw new Error('profile aggregate returned an unexpected shape')
    }
    const readSlot = (index: number): unknown => baseRow.getChildAt(index)?.get(0)
    const rowCount = readCount(readSlot(0))

    const columns: EngineProfileColumn[] = schema.map((column, index) => {
      const kind = specs[index]!.kind
      const offset = base.offsets[index]!
      const nonNull = readCount(readSlot(offset + PROFILE_BASE_SLOT.nonNull))
      const profileColumn: EngineProfileColumn = {
        name: column.name,
        type: column.type,
        kind,
        nullCount: rowCount - nonNull,
        distinctCount: readCount(readSlot(offset + PROFILE_BASE_SLOT.distinct)),
      }
      if (kind === 'numeric') {
        profileColumn.numeric = {
          min: readStat(readSlot(offset + PROFILE_BASE_SLOT.min)),
          max: readStat(readSlot(offset + PROFILE_BASE_SLOT.max)),
          mean: readStat(readSlot(offset + PROFILE_BASE_SLOT.mean)),
          stddev: readStat(readSlot(offset + PROFILE_BASE_SLOT.stddev)),
          quantiles: readQuantiles(readSlot(offset + PROFILE_BASE_SLOT.quantiles)),
        }
      }
      return profileColumn
    })

    // One bounded grouped scan per categorical column (projection pushdown
    // reads only that column). NULLs are excluded from top-k values; ties
    // break by value ascending (both documented in profile-query.ts).
    for (let index = 0; index < columns.length; index++) {
      if (specs[index]!.kind !== 'categorical') continue
      const topK = await this.readTopK(conn, entry.viewName, specs[index]!.name)
      columns[index]!.categorical = { topK }
    }

    this.post({ type: 'engine/profile-result', requestId, rowCount, columns })
  }

  /** Run one categorical column's top-k query and read its ≤ k rows. */
  private async readTopK(
    conn: EngineConnectionLike,
    viewName: string,
    column: string,
  ): Promise<EngineCategoricalTopKEntry[]> {
    const result = await conn.query(composeProfileTopKSql({ viewName, column }))
    const values = result.getChildAt(0)
    const counts = result.getChildAt(1)
    if (values === null || counts === null) {
      throw new Error('profile top-k query returned an unexpected shape')
    }
    const topK: EngineCategoricalTopKEntry[] = []
    for (let row = 0; row < values.length; row++) {
      const value: unknown = values.get(row)
      if (typeof value !== 'string') {
        // CAST(... AS VARCHAR) renders every non-null value as text; anything
        // else means the engine deviated from the composed contract.
        throw new Error('profile top-k value was not rendered text')
      }
      topK.push({ value, count: readCount(counts.get(row)) })
    }
    return topK
  }

  /**
   * Drop every view and file registration (best-effort per entry: one failure
   * must not block the others). The client terminates the worker afterwards,
   * which reclaims the whole engine instance regardless — this graceful path
   * exists so a future non-terminal close can reuse the same cleanup.
   *
   * On its lane (registry, m2-7) this is an ordinary FIFO op, and since m2-7
   * it first awaits a query-lane barrier: in-flight queries (and profile
   * scans) enqueued before it settle first, each with its own result or
   * error, so shutdown stays deterministic — the registry is empty once the
   * drops run, no view is removed under a running query, and later requests
   * fail with clean per-request errors instead of racing cleanup. (Queries
   * that arrive after the barrier may still race the drops worker-side — the
   * client rejects those itself before the dispose message is ever sent; a
   * straggler would get its own clean engine error. The client's dispose
   * timeout bounds the barrier wait and terminates the worker regardless.)
   */
  private async runDispose(requestId: number, lane: OpLane): Promise<void> {
    // Query-lane barrier: resolves once every enqueued query/profile op has
    // settled. It cannot deadlock — the query lane never awaits the registry
    // lane.
    await this.queryLane.channel.run(async () => undefined)
    const conn = lane.connection(await this.deps.ensureSession())
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
   * error can never leave the connection occupied. The caller (the lane)
   * guarantees no other operation was pending on THIS connection meanwhile
   * (m2-7: the other lane's connection is independent).
   */
  private async streamFirstBatch(
    conn: EngineConnectionLike,
    sql: string,
  ): Promise<{ batchIpc: Uint8Array; hasMore: boolean }> {
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

/**
 * A count slot (non-null count, distinct count, row count) as a safe
 * non-negative integer. BIGINT arrives as BigInt; anything else is an engine
 * deviation and fails this op loudly instead of leaking a bogus stat.
 */
function readCount(value: unknown): number {
  const n = typeof value === 'bigint' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) {
    throw new Error('profile aggregate returned an unexpected shape')
  }
  return n
}

/**
 * A numeric statistic slot: finite JS number or null (an all-null column, or
 * an undefined stat like stddev over a single value — DuckDB answers NULL).
 * Non-finite results (NaN/±Infinity from extreme magnitudes) map to null so
 * the profile stays finite-number-or-null JSON data (protocol invariant).
 */
function readStat(value: unknown): number | null {
  const n = typeof value === 'bigint' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

/**
 * The DOUBLE[4] quantile slot (p50, p90, p95, p99 — the composer's fixed
 * position order). An all-null column yields a NULL cell → all-`null`
 * quantiles. A malformed list fails the op loudly (never silent zeros).
 */
function readQuantiles(value: unknown): EngineNumericColumnStats['quantiles'] {
  if (value === null || value === undefined) {
    return { p50: null, p90: null, p95: null, p99: null }
  }
  const list = Array.from(value as Iterable<unknown>)
  if (list.length !== 4) {
    throw new Error('profile quantile aggregate returned an unexpected shape')
  }
  return {
    p50: readStat(list[0]),
    p90: readStat(list[1]),
    p95: readStat(list[2]),
    p99: readStat(list[3]),
  }
}
