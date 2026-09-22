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
import type { OverlayBase, OverlayState } from '@assay/domain'
import { foldOverlay, initialState } from '@assay/domain'
import { createViewSql, detectFileFormat, quotedIdentifier } from './format-view.js'
import {
  composeOverlayCastCheckSql,
  composeOverlayCountSql,
  composeOverlayExportSql,
  composeOverlayExportSelectSql,
  composeOverlaySchemaSql,
  composeOverlayWindowSql,
  exportFileExtension,
} from './overlay-query.js'
import type { OverlayComposition } from './overlay-query.js'
import { parseEngineRequestEnvelope } from './protocol.js'
import type {
  EngineCategoricalTopKEntry,
  EngineColumnSchema,
  EngineDiffRequest,
  EngineExportRequest,
  EngineFilterSpec,
  EngineNumericColumnStats,
  EngineOverlayCastCheckRequest,
  EngineOverlayPayload,
  EngineOverlayRangeRequest,
  EngineProfileColumn,
  EngineRangeRequest,
  EngineRequest,
  EngineResponse,
  EngineValidateRequest,
} from './protocol.js'
import { validateRowWindow } from './range-window.js'
import { OpChannel } from './op-channel.js'
import { classifyProfileColumnType } from './profile-classify.js'
import { composeProfileBaseSql, composeProfileTopKSql, PROFILE_BASE_SLOT } from './profile-query.js'
import { TableRegistry } from './table-registry.js'
import type { RegisteredTable } from './table-registry.js'
import {
  buildSampleFailures,
  composeValidationCountSql,
  composeValidationRowKeySql,
  composeValidationRuleQuery,
  composeValidationViewDropSql,
  composeValidationViewSql,
  failPercentFromCounts,
  readValidationRowCount,
  readValidationRuleRows,
  readValidationRowKeys,
  readValidationSummaryRows,
  validationEffectiveSampleLimit,
  validationFailCountExcess,
  VALIDATION_BEGIN_SQL,
  VALIDATION_ROLLBACK_SQL,
} from './validate-query.js'
import type { ValidationSampleRow } from './validate-query.js'
import { assertValidationPlanRelationBinding } from './validate-plan-wire.js'
import type { EngineValidationResult, EngineValidationRuleResult } from './validate-plan-wire.js'
import { composeRowCountSql, composeWindowSql } from './window-query.js'
import { ComparisonRegistry } from './comparison-registry.js'
import { assertRowDiffPlanBinding } from './diff-plan-wire.js'
import type { EngineRowDiffAspect, EngineRowDiffResult } from './diff-plan-wire.js'
import {
  buildDiffAspectSamples,
  composeDiffAspectQuery,
  composeDiffComparisonViewSql,
  composeDiffCountSql,
  composeDiffARowKeySql,
  composeDiffViewDropSql,
  diffEffectiveSampleLimit,
  readDiffARowKeys,
  readDiffAspectRows,
  readDiffRowCount,
  readDiffTotalsRows,
  rowDiffCountExcess,
  ROW_DIFF_BEGIN_SQL,
  ROW_DIFF_ROLLBACK_SQL,
} from './diff-query.js'
import type { RowDiffSampleRow } from './diff-query.js'

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
  /**
   * Read a file DuckDB wrote into its virtual filesystem (m4-2 export:
   * `COPY … TO` lands there; the bytes then move to OPFS scratch space).
   */
  copyExportBytes(registeredFileName: string): Promise<Uint8Array>
  /**
   * Persist export bytes into OPFS scratch space under the generated
   * destination path (ADR 0017 disposable-cache framing — never the source
   * path). Injected because the executor must stay Node-testable.
   */
  writeExportFile(path: string, bytes: Uint8Array): Promise<void>
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
  /** Single-slot staged comparison registry (m6-2, C3). */
  private readonly comparisons = new ComparisonRegistry()
  /** Monotonic export sequence: generated, collision-free destination names. */
  private nextExportSeq = 1

  constructor(private readonly deps: EngineExecutorDeps) {}

  /**
   * Entry point for raw worker messages. Parsing happens synchronously at
   * arrival so the enqueue order matches message order (FIFO per lane).
   *
   * A well-formed request routes to its op class's lane and serializes there.
   * A **malformed but recognised** overlay/export message (a numeric
   * `requestId` plus an `engine/overlay-*`/`engine/export` type whose payload
   * failed structural validation) is answered immediately with exactly one
   * typed `engine/error` — it never touches a connection, and it can never be
   * silently dropped and hang the caller (m4-2 fix round 2). Truly
   * unrecognised messages (unknown `type`, or no correlatable `requestId`)
   * are still ignored, exactly as before: there is nothing to answer them to.
   */
  accept(data: unknown): void {
    const envelope = parseEngineRequestEnvelope(data)
    if (envelope.status === 'ignored') {
      return
    }
    if (envelope.status === 'malformed') {
      // No connection work, so this is posted directly (never queued behind a
      // lane): the caller gets its typed rejection as soon as the message is
      // parsed. The message names the request type only — never the payload.
      this.post({
        type: 'engine/error',
        requestId: envelope.malformed.requestId,
        message: `malformed ${envelope.malformed.requestType} request`,
      })
      return
    }
    const request = envelope.request
    // Route to the op class's lane and serialize there: no two operations
    // are pending on the lane's connection at once. The lane also supplies
    // that connection, so routing and connection choice are one decision.
    // The task's own errors are caught inside `dispatch` and posted to its
    // caller; the lane tail settles regardless (op-channel.ts).
    // m4-2: exports join user SQL + profile on the query lane — a long
    // COPY is exactly the heavy, user-initiated class that must never
    // block the grid's windows (ADR 0040); the dispose barrier covers it.
    // m4-4b: the cast-conversion check is a worst-case full-column
    // `TRY_CAST` scan (the all-convertible common case), so it is
    // query-class too — routing it to the registry lane would reintroduce
    // exactly the head-of-line blocking ADR 0040 exists to prevent.
    // m5-2: validation may scan whole datasets per planned rule — the same
    // heavy class; it queues behind queries/profile, never behind windows.
    const lane =
      request.type === 'engine/query' ||
      request.type === 'engine/profile' ||
      request.type === 'engine/export' ||
      request.type === 'engine/overlay-cast-check' ||
      request.type === 'engine/validate' ||
      request.type === 'engine/diff-stage' ||
      request.type === 'engine/diff'
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
        case 'engine/overlay-schema': {
          await this.runOverlaySchema(request.requestId, request.tableId, request.overlay, lane)
          break
        }
        case 'engine/overlay-row-count': {
          await this.runOverlayRowCount(
            request.requestId,
            request.tableId,
            request.overlay,
            lane,
            request.filters,
          )
          break
        }
        case 'engine/overlay-range': {
          await this.runOverlayRange(request, lane)
          break
        }
        case 'engine/overlay-cast-check': {
          await this.runOverlayCastCheck(request, lane)
          break
        }
        case 'engine/validate': {
          await this.runValidate(request, lane)
          break
        }
        case 'engine/diff-stage': {
          await this.runDiffStage(request.requestId, request.name, request.file, lane)
          break
        }
        case 'engine/diff': {
          await this.runDiff(request, lane)
          break
        }
        case 'engine/export': {
          await this.runExport(request, lane)
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

  // -----------------------------------------------------------------------
  // Edit-overlay surface (m4-2) — stateless composition over the base view
  // -----------------------------------------------------------------------

  /**
   * Fold the request's op list against its base metadata (the domain's
   * `foldOverlay` — the single source of truth for what a log means) and
   * return the composition input. Stateless: nothing is cached between
   * requests; the composed SQL is a pure function of (base view, ops).
   */
  private compositionOf(overlay: EngineOverlayPayload): {
    base: OverlayBase
    state: OverlayState
  } {
    const { state } = foldOverlay(overlay.base, overlay.ops)
    return { base: overlay.base, state }
  }

  /**
   * Effective schema (m4-2): `DESCRIBE` over the composed projection —
   * post-rename names, post-cast DuckDB types. A cast to a type string the
   * engine rejects fails here with a readable binder error (declared-type
   * validation); the engine stays reusable (ordinary per-op error path).
   * Registry lane: the grid reads the schema on every rename/cast —
   * metadata-class traffic (ADR 0040).
   */
  private async runOverlaySchema(
    requestId: number,
    tableId: string,
    overlay: EngineOverlayPayload,
    lane: OpLane,
  ): Promise<void> {
    const entry = this.requireTable(tableId)
    const conn = lane.connection(await this.deps.ensureSession())
    const { base, state } = this.compositionOf(overlay)
    const sql = composeOverlaySchemaSql({ base, state, viewName: entry.viewName })
    const described = await conn.query(sql)
    const names = (described.getChild('column_name')?.toArray() ?? []) as string[]
    const types = (described.getChild('column_type')?.toArray() ?? []) as string[]
    if (names.length === 0 || names.length !== types.length) {
      throw new Error('DESCRIBE returned an unexpected shape')
    }
    this.post({
      type: 'engine/overlay-schema-result',
      requestId,
      columns: names.map((columnName, index) => ({ name: columnName, type: types[index] ?? '' })),
    })
  }

  /**
   * Live row count over the composed effective view (m4-2), optionally
   * filtered with the m2-2 grammar over effective columns. Unfiltered this
   * reproduces the domain's `liveRowCount` exactly (tombstoned base rows
   * excluded, live inserts added) — pinned by the conformance suite.
   * Registry lane: the editing grid re-counts on every row op (ADR 0040).
   */
  private async runOverlayRowCount(
    requestId: number,
    tableId: string,
    overlay: EngineOverlayPayload,
    lane: OpLane,
    filters?: EngineFilterSpec[],
  ): Promise<void> {
    const entry = this.requireTable(tableId)
    const conn = lane.connection(await this.deps.ensureSession())
    const { base, state } = this.compositionOf(overlay)
    const { batchIpc } = await this.streamFirstBatch(
      conn,
      composeOverlayCountSql({ base, state, viewName: entry.viewName }, filters),
    )
    const value = tableFromIPC(batchIpc).getChildAt(0)?.get(0)
    const rowCount = typeof value === 'bigint' ? Number(value) : value
    if (typeof rowCount !== 'number' || !Number.isSafeInteger(rowCount) || rowCount < 0) {
      throw new Error('count(*) returned an unexpected shape')
    }
    this.post({ type: 'engine/overlay-row-count-result', requestId, rowCount })
  }

  /**
   * Window over the composed effective view (m4-2): edits visible, deletes
   * excluded, inserts at anchored positions (the domain's `effectiveRowIds`
   * order, reproduced by the composed sort key). Same window validation and
   * first-batch transport as `runRange`. Registry lane: grid-class scroll
   * traffic (ADR 0040) — overlay windows queue behind nothing but each other.
   */
  private async runOverlayRange(request: EngineOverlayRangeRequest, lane: OpLane): Promise<void> {
    const entry = this.requireTable(request.tableId)
    const window = validateRowWindow(request.startRow, request.endRow)
    if (!window.valid) {
      throw new Error(`invalid row window: ${window.reason}`)
    }
    const conn = lane.connection(await this.deps.ensureSession())
    const { base, state } = this.compositionOf(request.overlay)
    const sql = composeOverlayWindowSql({
      viewName: entry.viewName,
      base,
      state,
      columns: request.columns,
      filters: request.filters,
      sort: request.sort,
      limit: window.endRow - window.startRow,
      offset: window.startRow,
      includeRowIds: request.includeRowIds,
    })
    const { batchIpc, hasMore } = await this.streamFirstBatch(conn, sql)
    this.post({
      type: 'engine/overlay-range-result',
      requestId: request.requestId,
      batchIpc,
      hasMore,
    })
  }

  /**
   * Validate-before-commit cast check (m4-4b, ADR 0012): fold the request's
   * overlay (the **pre-cast** state), compose the early-exit existence check
   * over the raw edit/insert/tombstone/rename-aware value arms, and report
   * whether any non-NULL value of the column fails `TRY_CAST`. The composed
   * arms apply the target conversion to each raw source value, exactly as the
   * committed cast does — a bad value anywhere, not just row 0, is found.
   * Query lane (ADR 0040): the all-convertible case scans the whole column,
   * exactly the heavy query-class work that must never block grid windows.
   * `SELECT 1` returns no dataset values (only the boolean crosses the
   * boundary).
   */
  private async runOverlayCastCheck(
    request: EngineOverlayCastCheckRequest,
    lane: OpLane,
  ): Promise<void> {
    const entry = this.requireTable(request.tableId)
    const conn = lane.connection(await this.deps.ensureSession())
    const { base, state } = this.compositionOf(request.overlay)
    const sql = composeOverlayCastCheckSql(
      { base, state, viewName: entry.viewName },
      request.column,
      request.targetType,
    )
    // `LIMIT 1` guarantees at most one row; anything else is an engine
    // deviation and fails this op loudly rather than reporting a guess.
    const result = await conn.query(sql)
    if (result.numRows > 1) {
      throw new Error('overlay cast check returned an unexpected shape')
    }
    this.post({
      type: 'engine/overlay-cast-check-result',
      requestId: request.requestId,
      hasNonConvertibleValues: result.numRows > 0,
    })
  }

  /**
   * Validation execution (m5-2, query lane per ADR 0040): execute a compiled
   * m5-1 `ValidationPlan` against the table's **effective view** — the m4-2
   * composed relation (base + overlay; absent `overlay` = the plain base
   * view) — so an edit/insert/delete that fixes or violates a rule flips that
   * rule's verdict (the conformance overlay-interaction pins exercise all
   * four directions).
   *
   * The plan's SQL is executed byte-identically: the executor materializes
   * the composed effective view under the plan's own binding name (see
   * `validate-query.ts` for the shape and the row-key channel), runs each
   * rule query plus the summary, then drops the view. The whole sequence is
   * ONE query-lane FIFO op, so create → run → drop can never interleave with
   * another query-lane op on this connection; the view is dropped in
   * `finally`, and a failed create/drop sequence leaves no object behind.
   *
   * Boundary posture (the m4-2 strictness, applied to plans): the wire shape
   * was validated at the envelope; here the plan must pass the two
   * containment belts of the m5-2 fix round BEFORE any SQL runs —
   *
   * - **Belt 1, the static gate** (`assertValidationPlanRelationBinding`):
   *   no shadowing of registered views; every rule query and the summary a
   *   single `SELECT` statement; the relation bound in a compiler FROM
   *   position at least once (CREATE/CTAS payloads, multi-statement strings,
   *   and relation-free SQL are typed rejections here).
   * - **Belt 2, the containment transaction**: the whole execution below
   *   runs inside a transaction that is ALWAYS rolled back in the cleanup
   *   path (DuckDB DDL is transactional — the reviewer's
   *   `CREATE TABLE review_injected AS SELECT 1` canary cannot persist even
   *   if a future gate evasion slipped belt 1).
   *
   * The binding view is dropped inside the transaction too — and ONLY when
   * THIS operation created it (review round 2, item 2: the unconditional
   * `DROP VIEW IF EXISTS` previously deleted a pre-existing user view after
   * a failed create). Per-rule fail counts must agree with the summary (the
   * plan contract's no-divergence invariant) and must not exceed the
   * effective row count (m5-2 round-3 fix, item 3: a count larger than the
   * dataset cannot be compiler output — it is ONE typed error, never an
   * out-of-contract response the client would have to discard), samples are
   * bounded by `min(plan K, the engine hard max)` (m5-2 round-3 fix: the
   * wire accepts any safe K ≥ 1 and the executed rule query is CLAMPED —
   * see `composeValidationRuleQuery` — never refused), and row keys resolve
   * through the composed view (samples carry logical row keys, never bare
   * positions).
   *
   * Cleanup ordering (m5-2 round-3 fix, W2): the DROP-when-owned + ROLLBACK
   * containment cleanup ALWAYS completes BEFORE the success response is
   * posted, so a client can never observe success before containment
   * finished; a cleanup failure becomes a typed engine error (never
   * silently swallowed). On the failure path the op's own typed error
   * surfaces (the cleanup still runs; its failure cannot be double-reported
   * without masking the primary error or attaching raw causes, both worse —
   * the op still fails loudly and the connection's next op fails cleanly).
   *
   * Engine errors surface as privacy-safe failure classes only (review
   * round 2, item 6): DuckDB's own messages can embed offending values or
   * plan text, so every engine-touching step is mapped through
   * {@link validationStep} to a fixed, value-free message; errors thrown by
   * this module's own shape checks are already privacy-safe (fixed strings
   * plus a ruleId, which the wire pins to the m5-0 rule-id grammar) and
   * pass through.
   */
  private async runValidate(request: EngineValidateRequest, lane: OpLane): Promise<void> {
    const entry = this.requireTable(request.tableId)
    const conn = lane.connection(await this.deps.ensureSession())
    const plan = request.plan
    // Executor-side K sanity (m5-2 round-3 fix: the wire accepts any safe
    // K ≥ 1 and this method CLAMPS it to the engine hard max — an over-max
    // K plan EXECUTES; only a K outside the safe ≥ 1 domain is a typed
    // error, and the wire envelope already rejects it before this runs).
    if (!Number.isSafeInteger(plan.sampleLimit) || plan.sampleLimit < 1) {
      throw new Error('validation plan sampleLimit must be a safe integer of at least 1')
    }
    const sampleLimit = validationEffectiveSampleLimit(plan.sampleLimit)
    assertValidationPlanRelationBinding(
      plan,
      this.registry.list().map((registered) => registered.viewName),
    )

    const composition: OverlayComposition =
      request.overlay === undefined
        ? await this.validationStep('the validation target could not be described', () =>
            this.baseViewComposition(conn, entry.viewName),
          )
        : {
            viewName: entry.viewName,
            base: request.overlay.base,
            state: this.compositionOf(request.overlay).state,
          }

    // Belt 2 — containment. If the BEGIN itself fails, nothing was started
    // and the typed error propagates directly; every path out of the try
    // below issues the ROLLBACK.
    await this.validationStep('the validation containment transaction could not be started', () =>
      conn.query(VALIDATION_BEGIN_SQL),
    )
    let viewCreated = false
    let cleanupError: Error | null = null
    let runResult: EngineValidationResult | null = null
    try {
      await this.validationStep('the validation binding view could not be materialized', () =>
        conn.query(composeValidationViewSql(composition, plan.relation)),
      )
      viewCreated = true
      const rowCount = await this.validationStep(
        'the validation row-count query failed to execute',
        async () =>
          readValidationRowCount(await conn.query(composeValidationCountSql(plan.relation))),
      )

      // Per-rule queries in plan order: failCount + clamped samples. The
      // executed query is the plan's EXACT SQL wrapped once as
      // `SELECT * FROM (<rule sql>) LIMIT min(K, hard max)` (m5-2 round-3
      // fix): the inner SQL stays byte-identical, the outer LIMIT bounds the
      // returned rows, and the inner window still reports the rule's FULL
      // violation count on every returned row (the window scan is inherent
      // to failCount and is not bounded by the clamp).
      const perRule: {
        readonly ruleId: string
        readonly outcome: string
        readonly failCount: number
        readonly samples: ValidationSampleRow[]
      }[] = []
      const ordinals = new Set<number>()
      for (const rule of plan.rules) {
        const rows = await this.validationStep(
          `validation rule '${rule.ruleId}' failed to execute`,
          async () =>
            readValidationRuleRows(
              await conn.query(composeValidationRuleQuery(rule.sql, sampleLimit)),
              rule.outcome,
            ),
        )
        // Result sanity (m5-2 round-3 fix, item 3; m5-4 refinement): the
        // reported count must fit the rule's OUTCOME bound — row-samples
        // counts are bounded by the effective row count; dataset-fact
        // counts by ONE (a boolean fact holds or fails, never "fails
        // twice" — `dataset.min-rows ≥ 1` over an empty dataset honestly
        // reports 1 over 0 rows and is a violation, not an error). A count
        // past the outcome's bound cannot come from compiler output — it
        // is a foreign/non-compiler plan. One typed error here, never an
        // out-of-contract result (failPercent > 100) that the protocol
        // would have to discard and a client would hang on. Bound and
        // message come from the shared seam, so the CLI mirrors this check
        // by construction instead of re-deriving it.
        const excess = validationFailCountExcess(rows.failCount, rowCount, rule.outcome)
        if (excess !== null) {
          throw new Error(`validation rule '${rule.ruleId}' ${excess}`)
        }
        if (rows.samples.length > sampleLimit) {
          throw new Error(`rule '${rule.ruleId}' returned more samples than the engine's bound`)
        }
        for (const sample of rows.samples) {
          if (sample.ordinal >= rowCount) {
            throw new Error(`rule '${rule.ruleId}' sampled an ordinal past the effective row count`)
          }
          ordinals.add(sample.ordinal)
        }
        perRule.push({
          ruleId: rule.ruleId,
          outcome: rule.outcome,
          failCount: rows.failCount,
          samples: [...rows.samples],
        })
      }

      // Row keys for every sampled ordinal, one scan of the composed view —
      // samples carry logical row keys (m4-3 grammar), never bare positions.
      const keys =
        ordinals.size > 0
          ? await this.validationStep('the validation row-key query failed to execute', async () =>
              readValidationRowKeys(
                await conn.query(
                  composeValidationRowKeySql(
                    plan.relation,
                    [...ordinals].sort((a, b) => a - b),
                  ),
                ),
              ),
            )
          : new Map<number, string>()

      // Summary agreement (the plan contract: per-rule ≡ summary is
      // structural; the engine still asserts it so a diverging plan fails
      // loudly instead of reporting counts that disagree with themselves).
      const summary = await this.validationStep(
        'the validation summary query failed to execute',
        async () => readValidationSummaryRows(await conn.query(plan.summarySql)),
      )
      if (summary.size !== plan.rules.length) {
        throw new Error('validation summary did not report exactly one row per planned rule')
      }

      const rules: EngineValidationRuleResult[] = perRule.map((rule) => {
        const summaryCount = summary.get(rule.ruleId)
        if (summaryCount === undefined) {
          throw new Error(`validation summary is missing rule '${rule.ruleId}'`)
        }
        if (summaryCount !== rule.failCount) {
          throw new Error(
            `validation summary disagrees with the per-rule count for '${rule.ruleId}'`,
          )
        }
        return {
          ruleId: rule.ruleId,
          outcome: rule.outcome,
          failCount: rule.failCount,
          failPercent: failPercentFromCounts(rule.failCount, rowCount),
          sampleFailures: buildSampleFailures(rule.samples, keys),
        }
      })

      const result: EngineValidationResult = {
        valid: rules.every((rule) => rule.failCount === 0),
        rowCount,
        rules,
      }
      // Stashed, not posted: the response goes out only after the cleanup
      // in the finally block completed (W2).
      runResult = result
    } finally {
      // Containment cleanup — ALWAYS both steps, in order, before any
      // success is posted (m5-2 round-3 fix, W2): drop the binding view ONLY
      // when this operation created it (a failed create must never drop a
      // pre-existing user view — review round 2, item 2), then ROLLBACK the
      // transaction (belt 2). A failed step does not skip the other: the
      // rollback undoes the whole transaction regardless.
      cleanupError = await this.cleanupValidateConnection(conn, viewCreated, plan.relation)
    }

    // Reached only when execution AND cleanup both succeeded: the success
    // response is posted AFTER containment completed, so a client can never
    // observe success before the view is dropped and the transaction rolled
    // back (W2) — and a cleanup failure surfaces as its own typed error
    // instead of a success (never silently swallowed).
    if (cleanupError !== null) throw cleanupError
    if (runResult === null) {
      throw new Error('the validation op completed without a result')
    }
    this.post({
      type: 'engine/validate-result',
      requestId: request.requestId,
      result: runResult,
    })
  }

  /**
   * The validate op's containment cleanup (m5-2 round-3 fix, W2): DROP the
   * binding view when this operation created it, then ROLLBACK — both steps
   * always attempted in order, the first failure returned as a typed,
   * privacy-safe error (raw engine text dropped; a failed drop must not
   * skip the rollback). `null` means containment fully completed. On the
   * failure path of {@link runValidate} the op's own typed error surfaces
   * (see the runValidate doc); this method still runs to completion so the
   * connection is left as clean as the engine allows.
   */
  private async cleanupValidateConnection(
    conn: EngineConnectionLike,
    viewCreated: boolean,
    bindingName: string,
  ): Promise<Error | null> {
    let dropError: Error | null = null
    if (viewCreated) {
      try {
        await conn.query(composeValidationViewDropSql(bindingName))
      } catch {
        // Recorded, never silently swallowed — but the rollback still runs:
        // it undoes the whole transaction regardless of the drop's fate.
        dropError = new Error('the validation binding view could not be dropped')
      }
    }
    try {
      await conn.query(VALIDATION_ROLLBACK_SQL)
    } catch {
      return new Error('the validation containment transaction could not be rolled back')
    }
    return dropError
  }

  /**
   * Map one engine-touching step of the validate op to a privacy-safe
   * failure class (review round 2, item 6): DuckDB conversion/binder errors
   * can embed offending VALUES or plan text, and validation messages leave
   * the worker, so the raw engine error is dropped (never attached as a
   * cause) and replaced by the fixed, value-free class message. Errors
   * thrown by this module's own shape checks are privacy-safe by
   * construction (fixed strings plus rule ids) and pass through unchanged —
   * they never originate inside a `conn.query` promise.
   */
  private async validationStep<T>(failureClass: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch {
      throw new Error(failureClass)
    }
  }

  /**
   * Stage a comparison dataset for a row diff (m6-2, checkpoint C3): detect
   * the reader format from the file name, register the picked `File` with
   * DuckDB under an engine-generated comparison name (lazy reader — no
   * upfront copy), and create the comparison scratch view. Never the source
   * path (ADR 0012/0017); user file names never enter SQL (ADR 0025).
   *
   * Single-slot replacement (idempotent-safe): any previously staged
   * comparison is dropped — view then file — before the new registration, so
   * re-staging a reference cannot accumulate views or file registrations.
   * A failed registration/view creation rolls the reservation back
   * best-effort, exactly like `runOpen`. Because the previous entry is
   * cleared before the new reservation, a failed re-stage leaves NO staged
   * comparison — it does not roll back to the prior slot.
   *
   * Query lane: staging a large file and creating a view over it is the
   * heavy, user-initiated class (ADR 0040) — it queues behind running
   * queries, never behind the grid's windows.
   */
  private async runDiffStage(
    requestId: number,
    name: string,
    file: File,
    lane: OpLane,
  ): Promise<void> {
    const format = detectFileFormat(name)
    if (format === null) {
      throw new Error(
        'unsupported comparison format: this engine reads .parquet, .csv, .jsonl and .json files',
      )
    }
    const conn = lane.connection(await this.deps.ensureSession())
    const previous = this.comparisons.clear()
    if (previous !== null) {
      await conn
        .query(`DROP VIEW IF EXISTS ${quotedIdentifier(previous.viewName)}`)
        .catch(() => undefined)
      await this.deps.dropFile(previous.registeredFileName).catch(() => undefined)
    }
    const reservation = this.comparisons.reserve(format)
    let confirmed = false
    try {
      await this.validationStep('the comparison file could not be registered', () =>
        this.deps.registerFileHandle(reservation.registeredFileName, file),
      )
      await this.validationStep('the comparison view could not be created', () =>
        conn.query(createViewSql(reservation.viewName, reservation.registeredFileName, format)),
      )
      this.comparisons.confirm(reservation)
      confirmed = true
      const columns = await this.describeView(conn, reservation.viewName)
      this.post({
        type: 'engine/diff-stage-result',
        requestId,
        comparisonId: reservation.comparisonId,
        columns,
      })
    } finally {
      if (!confirmed) {
        // Best-effort rollback of the half-created comparison (the catalog
        // entry and the file registration are both engine-generated names).
        await conn
          .query(`DROP VIEW IF EXISTS ${quotedIdentifier(reservation.viewName)}`)
          .catch(() => undefined)
        await this.deps.dropFile(reservation.registeredFileName).catch(() => undefined)
      }
    }
  }

  /**
   * Row-diff execution (m6-2, query lane per ADR 0040): execute a compiled
   * m6-1 `RowDiffPlan` with side A bound to the table's **effective view**
   * (the m4-2 composed relation; absent `overlay` = the plain base view) and
   * side B bound to the staged comparison view addressed by `comparisonId`.
   *
   * The plan's SQL is executed byte-identically: the executor materializes
   * both binding views under the plan's own relation names (side A through
   * the m5-2 composed-view helper — baked `assay_overlay_ord` is the A-side
   * row-key channel; side B as a thin pass-through over the staged view),
   * runs the three aspect queries plus the totals query, resolves every
   * sampled A-side ordinal to its logical row key, then drops the views. The
   * whole sequence is ONE query-lane FIFO op, so create → run → drop can
   * never interleave with another query-lane op; both views are dropped in
   * `finally`, and the containment transaction (`BEGIN…ROLLBACK`, the m5-2
   * belt 2) is always rolled back.
   *
   * Boundary posture: the wire shape was validated at the envelope; here the
   * plan must pass belt 1 (`assertRowDiffPlanBinding`) BEFORE any SQL runs —
   * no shadowing of registered views, per-aspect single compiler-shaped
   * SELECTs, the compiler's exact FROM renderings of BOTH relations with the
   * fixed range aliases, and the compiler-shaped three-arm totals UNION ALL.
   *
   * Result sanity (the m5-4 analog, made explicit in `diff-query.ts`): each
   * aspect's reported count must fit its bound (`added ≤ rowCount(B)`,
   * `removed ≤ rowCount(A)`, `changed ≤ rowCount(A) × rowCount(B)` — keys may
   * be non-unique and NULL keys group, so an A row can pair with several B
   * rows); the per-aspect counts must agree with the totals query (the m6-1
   * no-divergence invariant, asserted not assumed); samples are bounded by
   * `min(plan K, hard max)`. The bounds are a corruption/foreign-signal net
   * (every legal plan is inside them) and the totals agreement is the second
   * net for an inflated count that stays inside a bound — a violation is one
   * typed error, never an out-of-contract result.
   *
   * An engine error is mapped through the fixed, value-free failure classes
   * (the m5-2 `validationStep` discipline): DuckDB errors can embed values
   * or plan text, so they never leave the worker. A-side sample keys carry
   * the host's base anchor token; that token is report content returned to
   * its owner, but is never interpolated into an error message or log (ADR
   * 0025).
   */
  private async runDiff(request: EngineDiffRequest, lane: OpLane): Promise<void> {
    const entryA = this.requireTable(request.tableId)
    const comparison = this.comparisons.get(request.comparisonId)
    if (comparison === null) {
      throw new Error('unknown comparison handle')
    }
    const conn = lane.connection(await this.deps.ensureSession())
    const plan = request.plan
    if (!Number.isSafeInteger(plan.sampleLimit) || plan.sampleLimit < 1) {
      throw new Error('row-diff plan sampleLimit must be a safe integer of at least 1')
    }
    const sampleLimit = diffEffectiveSampleLimit(plan.sampleLimit)
    assertRowDiffPlanBinding(plan, [
      ...this.registry.list().map((registered) => registered.viewName),
      ...this.comparisons.viewNames(),
    ])

    const composition: OverlayComposition =
      request.overlay === undefined
        ? await this.validationStep('the row-diff side A could not be described', () =>
            this.baseViewComposition(conn, entryA.viewName),
          )
        : {
            viewName: entryA.viewName,
            base: request.overlay.base,
            state: this.compositionOf(request.overlay).state,
          }

    await this.validationStep('the row-diff containment transaction could not be started', () =>
      conn.query(ROW_DIFF_BEGIN_SQL),
    )
    let aViewCreated = false
    let bViewCreated = false
    let cleanupError: Error | null = null
    let runResult: EngineRowDiffResult | null = null
    try {
      await this.validationStep('the row-diff side A binding view could not be materialized', () =>
        conn.query(composeValidationViewSql(composition, plan.relationA)),
      )
      aViewCreated = true
      await this.validationStep('the row-diff side B binding view could not be materialized', () =>
        conn.query(composeDiffComparisonViewSql(plan.relationB, comparison.viewName)),
      )
      bViewCreated = true

      const rowCountA = await this.validationStep(
        'the row-diff side A count query failed to execute',
        async () => readDiffRowCount(await conn.query(composeValidationCountSql(plan.relationA))),
      )
      const rowCountB = await this.validationStep(
        'the row-diff side B count query failed to execute',
        async () => readDiffRowCount(await conn.query(composeDiffCountSql(plan.relationB))),
      )

      const aspectOrder: readonly EngineRowDiffAspect[] = ['added', 'removed', 'changed']
      const aspectSqls: Readonly<Record<EngineRowDiffAspect, string>> = {
        added: plan.addedSql,
        removed: plan.removedSql,
        changed: plan.changedSql,
      }
      const rowsByAspect = new Map<EngineRowDiffAspect, readonly RowDiffSampleRow[]>()
      const counts = new Map<EngineRowDiffAspect, number>()
      const aOrdinals = new Set<number>()
      for (const aspect of aspectOrder) {
        const rows = await this.validationStep(
          `row-diff ${aspect} query failed to execute`,
          async () =>
            readDiffAspectRows(
              await conn.query(composeDiffAspectQuery(aspectSqls[aspect], sampleLimit)),
              aspect,
            ),
        )
        const excess = rowDiffCountExcess(aspect, rows.count, rowCountA, rowCountB)
        if (excess !== null) {
          throw new Error(`row-diff ${aspect} ${excess}`)
        }
        if (rows.rows.length > sampleLimit) {
          throw new Error(`row-diff ${aspect} returned more samples than the engine's bound`)
        }
        for (const sample of rows.rows) {
          if (sample.side === 'A') {
            if (sample.ordinal >= rowCountA) {
              throw new Error(
                `row-diff ${aspect} sampled an A-side ordinal past the effective row count`,
              )
            }
            aOrdinals.add(sample.ordinal)
          } else if (sample.ordinal >= rowCountB) {
            throw new Error(
              `row-diff ${aspect} sampled a B-side ordinal past the comparison row count`,
            )
          }
        }
        counts.set(aspect, rows.count)
        rowsByAspect.set(aspect, rows.rows)
      }

      const aKeys =
        aOrdinals.size > 0
          ? await this.validationStep(
              'the row-diff side A row-key query failed to execute',
              async () =>
                readDiffARowKeys(
                  await conn.query(
                    composeDiffARowKeySql(
                      plan.relationA,
                      [...aOrdinals].sort((a, b) => a - b),
                    ),
                  ),
                ),
            )
          : new Map<number, string>()

      const totals = await this.validationStep(
        'the row-diff totals query failed to execute',
        async () => readDiffTotalsRows(await conn.query(plan.totalsSql)),
      )

      const aspects: EngineRowDiffResult['aspects'] = aspectOrder.map((aspect) => {
        const rows = rowsByAspect.get(aspect) ?? []
        const count = counts.get(aspect) ?? 0
        const totalCount = totals.get(aspect)
        if (totalCount === undefined) {
          throw new Error(`row-diff totals query is missing the ${aspect} aspect`)
        }
        if (totalCount !== count) {
          throw new Error(`row-diff totals query disagrees with the ${aspect} count`)
        }
        return { aspect, count, samples: buildDiffAspectSamples(rows, aspect, aKeys) }
      })

      runResult = { rowCountA, rowCountB, aspects }
    } finally {
      // Containment cleanup: drop whichever binding views this op created,
      // then ROLLBACK — both steps always attempted in order, before any
      // success is posted (the m5-2 W2 ordering).
      cleanupError = await this.cleanupDiffConnection(
        conn,
        aViewCreated,
        bViewCreated,
        plan.relationA,
        plan.relationB,
      )
    }

    if (cleanupError !== null) throw cleanupError
    if (runResult === null) {
      throw new Error('the row-diff op completed without a result')
    }
    this.post({
      type: 'engine/diff-result',
      requestId: request.requestId,
      result: runResult,
    })
  }

  /**
   * The row-diff containment cleanup (the m5-2 `cleanupValidateConnection`
   * analog): drop each binding view this op created, then ROLLBACK. A
   * failed drop is reported (never silently swallowed) but does not skip
   * the rollback; a failed rollback is the returned error.
   */
  private async cleanupDiffConnection(
    conn: EngineConnectionLike,
    aViewCreated: boolean,
    bViewCreated: boolean,
    relationA: string,
    relationB: string,
  ): Promise<Error | null> {
    let dropError: Error | null = null
    if (aViewCreated) {
      try {
        await conn.query(composeDiffViewDropSql(relationA))
      } catch {
        dropError = new Error('the row-diff side A binding view could not be dropped')
      }
    }
    if (bViewCreated) {
      try {
        await conn.query(composeDiffViewDropSql(relationB))
      } catch {
        if (dropError === null) {
          dropError = new Error('the row-diff side B binding view could not be dropped')
        }
      }
    }
    try {
      await conn.query(ROW_DIFF_ROLLBACK_SQL)
    } catch {
      return new Error('the row-diff containment transaction could not be rolled back')
    }
    return dropError
  }

  /**
   * Export/rewrite op (m4-2; query lane — a long-running user-initiated
   * materialization that must never block the grid's windows, ADR 0040):
   * materializes the effective view (base + overlay; absent overlay = the
   * plain base view) into a NEW file. The source file is never touched: the
   * COPY writes an engine-generated name in DuckDB's virtual filesystem,
   * the bytes move to OPFS scratch space (`assay-exports/…`, ADR 0017
   * disposable-cache framing), and the response carries that generated path
   * so the host can re-open/verify the export (round-trip).
   *
   * Per-format: parquet/csv/jsonl/json go through `COPY` with the pinned
   * deterministic options (CSV with the formula-injection guard);
   * `arrow` streams the identical SELECT and assembles an Arrow IPC *file*
   * worker-side (DuckDB-WASM's bundled build has no Arrow COPY writer).
   * The reported rowCount comes from the COPY's count relation, with an
   * explicit count fallback (honest numbers over shape-guessing), or the
   * streamed batch total for arrow.
   */
  private async runExport(request: EngineExportRequest, lane: OpLane): Promise<void> {
    const entry = this.requireTable(request.tableId)
    const conn = lane.connection(await this.deps.ensureSession())
    const seq = this.nextExportSeq++
    const stem = `assay-export-${String(seq)}`
    const composition: OverlayComposition =
      request.overlay === undefined
        ? await this.baseViewComposition(conn, entry.viewName)
        : {
            viewName: entry.viewName,
            base: request.overlay.base,
            state: this.compositionOf(request.overlay).state,
          }

    let bytes: Uint8Array
    let rowCount: number
    if (request.format === 'arrow') {
      const drained = await this.drainAllBatches(
        conn,
        composeOverlayExportSelectSql(composition, 'arrow'),
      )
      rowCount = drained.rowCount
      bytes = tableToIPC(new Table(drained.batches))
    } else {
      const copySql = composeOverlayExportSql(composition, request.format, stem)
      if (copySql === null) {
        throw new Error(`unsupported export format: ${request.format}`)
      }
      const copyResult = await conn.query(copySql)
      const copyCount = readCopyRowCount(copyResult)
      if (copyCount !== null) {
        rowCount = copyCount
      } else {
        // Defensive fallback: an explicit count over the same select —
        // never guess a total from an unexpected COPY result shape.
        const counted = await conn.query(composeOverlayCountSql(composition))
        const value = counted.getChildAt(0)?.get(0)
        const n = typeof value === 'bigint' ? Number(value) : value
        if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) {
          throw new Error('export row count returned an unexpected shape')
        }
        rowCount = n
      }
      try {
        bytes = await this.deps.copyExportBytes(stem)
      } finally {
        await this.deps.dropFile(stem).catch(() => undefined)
      }
    }
    const path = `assay-exports/${stem}.${exportFileExtension(request.format)}`
    await this.deps.writeExportFile(path, bytes)
    this.post({
      type: 'engine/export-result',
      requestId: request.requestId,
      path,
      format: request.format,
      rowCount,
      bytes: bytes.byteLength,
    })
  }

  /**
   * Base metadata for an overlay-free export: DESCRIBE supplies the columns
   * (the composition projects them verbatim, plus the CSV guard for csv),
   * and the empty state adds nothing. Tokens are irrelevant here (no edits,
   * no inserts, no deletes), and `baseRowCount` 0 is safe because an empty
   * state never references base ordinals.
   */
  private async baseViewComposition(
    conn: EngineConnectionLike,
    viewName: string,
  ): Promise<OverlayComposition> {
    const columns = await this.describeView(conn, viewName)
    const base = { baseAnchor: '', overlayAnchor: '', columns, baseRowCount: 0 }
    const state: OverlayState = initialState(base)
    return { viewName, base, state }
  }

  /**
   * Stream a query to its LAST batch (m4-2 export): the export surface is
   * explicitly a full materialization, so — unlike `streamFirstBatch` — every
   * batch is drained. Cleanup mirrors the first-batch discipline: the reader
   * is always released in `finally`, before anything is reported.
   */
  private async drainAllBatches(
    conn: EngineConnectionLike,
    sql: string,
  ): Promise<{ batches: RecordBatch[]; rowCount: number }> {
    const reader = await conn.send(sql)
    const batches: RecordBatch[] = []
    try {
      for (;;) {
        const next = await reader.next()
        if (next.done) break
        if (next.value !== undefined) batches.push(next.value)
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }
    if (batches.length === 0) {
      throw new Error('export produced no record batches')
    }
    return { batches, rowCount: batches.reduce((sum, batch) => sum + batch.numRows, 0) }
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
    // m6-2: the single staged comparison (if any) is dropped with the rest.
    const staged = this.comparisons.clear()
    if (staged !== null) {
      await conn
        .query(`DROP VIEW IF EXISTS ${quotedIdentifier(staged.viewName)}`)
        .catch(() => undefined)
      await this.deps.dropFile(staged.registeredFileName).catch(() => undefined)
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
    if (
      response.type === 'engine/query-result' ||
      response.type === 'engine/range-result' ||
      response.type === 'engine/overlay-range-result'
    ) {
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
 * The COPY statement's count relation (one row, one BIGINT "Count" cell) —
 * or `null` when the result does not carry it (a defensive fallback counts
 * explicitly rather than trusting an unexpected shape).
 */
function readCopyRowCount(result: Table): number | null {
  if (result.numRows !== 1) return null
  const value: unknown = result.getChildAt(0)?.get(0)
  const n = typeof value === 'bigint' ? Number(value) : value
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null
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
