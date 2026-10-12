// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Main-thread client for the DuckDB engine worker.
 *
 * Laziness contract: constructing the client performs no work and touches no
 * platform APIs. The first `ensureReady()` / `query()` / `open()` boots the
 * engine inside a dedicated Web Worker (ADR 0021) — DuckDB-WASM never runs on
 * the main thread. The main thread exchanges only the typed messages defined
 * in `./protocol`; tabular results arrive as Apache Arrow IPC bytes (ADR 0020)
 * and are reconstituted here with the Arrow API.
 *
 * M1-4 file lifecycle: `open(source)` accepts an `EngineFileSource` — a
 * structural seam (`{ name, getFile(): Promise<File> }`) satisfied both by a
 * `FileSystemFileHandle` (which has exactly that shape) and by
 * `BrowserFileSource` with its `getFile()` accessor. The `File` is resolved on
 * the main thread and transported as a structured-cloneable reference; the
 * worker registers it and returns an `EngineTableHandle`, structurally
 * compatible with `@assay/engine`'s `TableHandle { kind: 'table'; id }`
 * (without importing that package). `schema()` and `fetchRange()` address the
 * table through that handle; `fetchRange` windows are validated and clamped
 * on this side too (fail fast, same semantics as the worker).
 */
import { tableFromIPC } from 'apache-arrow'
import type { Table } from 'apache-arrow'
import type { EditOp, OverlayBase } from '@assay/domain'
import { foldOverlay } from '@assay/domain'
import { EngineTypeError, validateEngineTypeExpression } from './type-expr.js'
import { assertValidOverlayTypes } from './overlay-wire.js'
import { parseValidationPlan } from './validate-plan-wire.js'
import type { EngineValidationPlan, EngineValidationResult } from './validate-plan-wire.js'
import { parseRowDiffPlan } from './diff-plan-wire.js'
import type { EngineRowDiffPlan, EngineRowDiffResult } from './diff-plan-wire.js'
import { parseEngineResponse } from './protocol.js'
import type {
  EngineColumnSchema,
  EngineExportFormat,
  EngineFilterSpec,
  EngineProfileColumn,
  EngineReadyInfo,
  EngineRequest,
  EngineSortSpec,
  EngineSuccessResponse,
} from './protocol.js'
import { validateRowWindow } from './range-window.js'
import { executePipeline } from './pipeline-runner/index.js'
import type {
  PipelineRunEngineOps,
  PipelineRunInput,
  PipelineRunOptions,
  PipelineRunResult,
} from './pipeline-runner/index.js'

/** Lifecycle of the lazy engine bootstrap. */
export type EngineStatus = 'idle' | 'booting' | 'ready' | 'failed' | 'disposed'

/**
 * Result of a query: the first Arrow record batch of the result set,
 * reconstituted on the main thread as an Arrow `Table` holding exactly that
 * one batch (zero rows when the query produced no rows).
 *
 * Honest about scope (M1-2): only the first batch is transported. `hasMore`
 * is true when the engine produced further batches after this one — those
 * batches are discarded inside the worker (the pending query is cancelled),
 * so this result is *not* the full result set whenever `hasMore` is true.
 * Full streaming arrives with a later task.
 */
export interface EngineQueryResult {
  /** Arrow table containing exactly the first record batch of the result. */
  readonly batch: Table
  /** True when the engine produced more record batches after this one. */
  readonly hasMore: boolean
}

/** Result of a `fetchRange` call — same Arrow transport as `EngineQueryResult`. */
export interface EngineRangeResult {
  /** Arrow table holding the requested (validated, clamped) window. */
  readonly batch: Table
  /** True if DuckDB split the window and a tail batch was not transported. */
  readonly hasMore: boolean
}

/**
 * Full statistics profile of a registered table (m2-5): plain JSON-able data
 * (no Arrow) — total rows plus per-column nullCount/distinctCount and the
 * kind-specific payloads (numeric stats / categorical top-k), as composed
 * and classified by the worker (see `profile-query.ts` / `profile-classify.ts`).
 */
export interface EngineDatasetProfile {
  readonly rowCount: number
  readonly columns: readonly EngineProfileColumn[]
}

/**
 * The file-source seam: a name (only the extension is interpreted) plus lazy
 * access to the `File`. `FileSystemFileHandle` satisfies this structurally;
 * `@assay/data-sources`' `BrowserFileSource` satisfies it via its `getFile()`
 * accessor. Nothing is read at seam level — the worker decides when bytes are
 * touched (local-first, ADR 0001).
 */
export interface EngineFileSource {
  readonly name: string
  getFile(): Promise<File>
}

/**
 * Opaque handle to a table registered with the engine worker. Structurally
 * compatible with `@assay/engine`'s `TableHandle` (kind 'table', string id) so
 * the grid layer (m1-5) can adapt without engine changes.
 */
export interface EngineTableHandle {
  readonly kind: 'table'
  readonly id: string
}

/**
 * Opaque handle to a staged comparison dataset (m6-2): the `engine/diff`
 * counterpart of a table handle. Structurally distinct from a grid table
 * handle so a comparison can never be mistaken for an open dataset.
 */
export interface EngineComparisonHandle {
  readonly kind: 'comparison'
  readonly id: string
  /** Columns of the staged comparison view (DESCRIBE), for plan compilation. */
  readonly schema: readonly EngineColumnSchema[]
}

/** A requested row window for `fetchRange` (half-open: `[startRow, endRow)`). */
export interface EngineRangeWindow {
  readonly startRow: number
  readonly endRow: number
  /** Optional projection; omit for all columns. Must be non-empty. */
  readonly columns?: readonly string[]
  /**
   * Optional ordered predicates, AND-composed (m2-2; grid contracts v1 — the
   * predicate is engine-SQL text, `"column" <predicate>`). Omit or pass an
   * empty array for no filters (the grid's `filter(null)` clear).
   */
  readonly filters?: readonly EngineFilterSpec[]
  /**
   * Optional ordered sort keys (m2-2). Omit or pass an empty array for natural
   * order (the grid's `sort(null)`).
   */
  readonly sort?: readonly EngineSortSpec[]
}

/** Options for `rowCount` (m2-2): a filtered count narrows the `count(*)`. */
export interface EngineRowCountOptions {
  /** Ordered predicates, AND-composed; omit/empty for the unfiltered total. */
  readonly filters?: readonly EngineFilterSpec[]
}

/**
 * The overlay a request composes over (m4-2): the immutable base metadata
 * (host tokens, base schema, base row count — the domain's `OverlayBase`)
 * plus the op list. Stateless: every call carries its overlay; the worker
 * folds and composes per request (restart-safe, pure in the request).
 * `ops` is copied shallowly on this side; cell-value Maps cross the worker
 * boundary by structured clone.
 */
export interface EngineOverlay {
  readonly base: OverlayBase
  readonly ops?: readonly EditOp[]
}

/** A requested row window over the composed effective view (m4-2). */
export interface EngineOverlayWindow {
  readonly startRow: number
  readonly endRow: number
  /** Optional projection (effective column names); omit for all columns. */
  readonly columns?: readonly string[]
  /** Optional ordered predicates over effective columns, AND-composed. */
  readonly filters?: readonly EngineFilterSpec[]
  /** Optional ordered sort keys; omit for effective order. */
  readonly sort?: readonly EngineSortSpec[]
  /** Prepend the logical row-id column (`assay_row_id`) to the projection. */
  readonly includeRowIds?: boolean
}

/** Request for `exportView` (m4-2): format plus optional overlay. Absent
 * `overlay` exports the plain base view.
 */
export interface EngineExportRequest {
  readonly format: EngineExportFormat
  readonly overlay?: EngineOverlay
}

/**
 * Request for `overlayCastCheck` (m4-4b): test whether the effective
 * `column` of the given (pre-cast) overlay state has any value that cannot
 * convert to `targetType`, before committing a `column-cast` (ADR 0012).
 */
export interface EngineOverlayCastCheck {
  readonly column: string
  readonly targetType: string
}

/**
 * Result of `overlayCastCheck`: `true` iff at least one non-NULL value of the
 * effective column cannot convert. A boolean only — never dataset values
 * (ADR 0025). All-NULL and empty columns are `false`.
 */
export interface EngineOverlayCastCheckResult {
  readonly hasNonConvertibleValues: boolean
}

/** Result of `exportView`: where the export landed plus honest counts. The
 * `path` is OPFS-relative (ADR 0017 disposable cache) and never the source
 * path; re-open it through `open()` (with a source whose `name` carries the
 * file extension) to verify content (the conformance round-trip).
 */
export interface EngineExportResult {
  readonly path: string
  readonly format: EngineExportFormat
  readonly rowCount: number
  readonly bytes: number
}

/** The slice of the `Worker` API the client relies on (kept narrow for fakes). */
export interface EngineWorkerLike {
  postMessage(request: EngineRequest): void
  terminate(): void
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void
}

/** Creates the engine worker. Injectable so tests can fake the boundary. */
export type EngineWorkerFactory = () => EngineWorkerLike

export interface DuckDbEngineClientOptions {
  workerFactory?: EngineWorkerFactory
  /**
   * How long `dispose()` waits for the worker's graceful cleanup reply before
   * terminating anyway. Tests inject a short timeout; the default is generous
   * for real (slow WASM teardown) environments.
   */
  disposeTimeoutMs?: number
}

/** The engine worker failed, crashed, or is not running. */
export class EngineWorkerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'EngineWorkerError'
  }
}

/** The worker sent a message that does not fit the protocol. */
export class EngineProtocolError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'EngineProtocolError'
  }
}

/** A SQL query failed inside the engine worker. */
export class EngineQueryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'EngineQueryError'
  }
}

/**
 * An open/schema/range operation failed inside the engine worker (unknown
 * handle, unsupported format, invalid window, …), or a request was malformed
 * on the main thread. These errors leave the engine running.
 */
export class EngineOperationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'EngineOperationError'
  }
}

/** The operation was attempted after `dispose()`. */
export class EngineDisposedError extends Error {
  constructor(message = 'engine client was disposed') {
    super(message)
    this.name = 'EngineDisposedError'
  }
}

interface PendingRequest {
  requestType: EngineRequest['type']
  resolve: (response: EngineSuccessResponse) => void
  reject: (error: Error) => void
}

/** Maps an engine-reported error to the rejection class for its request. */
function engineErrorFor(requestType: EngineRequest['type'], message: string): Error {
  if (requestType === 'engine/init') return new EngineWorkerError(message)
  if (requestType === 'engine/query') return new EngineQueryError(message)
  return new EngineOperationError(message)
}

/**
 * Structured-clone-safe `File` guard mirroring `protocol.ts`'s worker-side
 * `isFile` contract, so `open()`/`stageComparison()` can reject a non-File
 * source on this side of the boundary before the post. Node ≥ 20 (unit tests)
 * and worker realms alike provide the global, so this is an honest
 * `instanceof` rather than duck typing.
 */
function isFile(value: unknown): value is File {
  return typeof File === 'function' && value instanceof File
}

/**
 * Creates the real engine worker: this package's TS worker entry (bundled by
 * Vite). This exact construction IS the web default — the client posts exactly
 * one `engine/init` on it and nothing else. Hosts that need a different boot
 * (the VS Code webview's blob-URL bootstrap, ptv1-1) inject their own
 * `workerFactory` and post the `engine/assets` control message (see
 * `./worker-core`) before the first request. Exported (ptv1-1) so the default
 * construction is pinned headlessly in `worker-core.test.ts`: any change here
 * must keep the default web path byte-identical.
 */
export function defaultWorkerFactory(): EngineWorkerLike {
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
}

const DEFAULT_DISPOSE_TIMEOUT_MS = 5_000

export class DuckDbEngineClient {
  private currentStatus: EngineStatus = 'idle'
  /**
   * Permanent disposal sentinel: set the instant `dispose()` begins and never
   * cleared. `currentStatus` alone is not enough — a boot whose `engine/init`
   * reply races disposal could otherwise overwrite `'disposed'` with `'ready'`
   * and resurrect the client. Every entry point checks this first, so
   * post-dispose calls fail-first with the typed disposal error instead of
   * racing a stale boot or re-booting a disposed instance.
   */
  private disposed = false
  private worker: EngineWorkerLike | null = null
  private readonly pending = new Map<number, PendingRequest>()
  private nextRequestId = 1
  private ready: Promise<EngineReadyInfo> | null = null
  private disposal: Promise<void> | null = null
  private readonly workerFactory: EngineWorkerFactory
  private readonly disposeTimeoutMs: number

  constructor(options: DuckDbEngineClientOptions = {}) {
    this.workerFactory = options.workerFactory ?? defaultWorkerFactory
    this.disposeTimeoutMs = options.disposeTimeoutMs ?? DEFAULT_DISPOSE_TIMEOUT_MS
  }

  /** Current lifecycle state of the lazy bootstrap. */
  get status(): EngineStatus {
    return this.currentStatus
  }

  /**
   * Boot the engine worker if it is not running yet. Concurrent calls share a
   * single boot; after a failed boot (or a worker crash) the next call boots
   * a fresh worker.
   */
  async ensureReady(): Promise<EngineReadyInfo> {
    if (this.disposed || this.currentStatus === 'disposed') throw new EngineDisposedError()
    this.ready ??= this.boot()
    return this.ready
  }

  /**
   * Run a SQL query and return its first Arrow record batch (ADR 0020). See
   * `EngineQueryResult` for the exact delivery semantics — in particular,
   * `hasMore` reports (rather than discards silently) the un-transported
   * remainder of the result set.
   */
  async query(sql: string): Promise<EngineQueryResult> {
    await this.ensureReady()
    const response = await this.send({ type: 'engine/query', requestId: this.takeRequestId(), sql })
    if (response.type !== 'engine/query-result') {
      throw new EngineProtocolError(`unexpected ${response.type} response for engine/query`)
    }
    try {
      return { batch: tableFromIPC(response.batchIpc), hasMore: response.hasMore }
    } catch (cause) {
      throw new EngineProtocolError('worker sent an invalid Arrow IPC payload', { cause })
    }
  }

  /**
   * Open a picked local file in the worker and register it with DuckDB.
   * Resolves an opaque table handle; `source.getFile()` failures (e.g. the
   * handle's file was moved/deleted) propagate from the source unchanged.
   * A source whose `getFile()` does not resolve to a `File` rejects with
   * `EngineOperationError` before anything crosses the boundary (the
   * worker-side `isFile` contract mirrored client-side, au3-4).
   * Unsupported formats reject with `EngineOperationError`.
   */
  async open(source: EngineFileSource): Promise<EngineTableHandle> {
    await this.ensureReady()
    const file = await source.getFile()
    if (!isFile(file)) {
      throw new EngineOperationError('engine/open requires a File source')
    }
    const response = await this.send({
      type: 'engine/open',
      requestId: this.takeRequestId(),
      name: source.name,
      file,
    })
    if (response.type !== 'engine/open-result') {
      throw new EngineProtocolError(`unexpected ${response.type} response for engine/open`)
    }
    return { kind: 'table', id: response.tableId }
  }

  /**
   * Column name/type pairs for a registered table, exactly as DuckDB reports
   * them (nested types arrive as full SQL type strings — no mapping layer).
   */
  async schema(handle: EngineTableHandle): Promise<EngineColumnSchema[]> {
    await this.ensureReady()
    const response = await this.send({
      type: 'engine/schema',
      requestId: this.takeRequestId(),
      tableId: handle.id,
    })
    if (response.type !== 'engine/schema-result') {
      throw new EngineProtocolError(`unexpected ${response.type} response for engine/schema`)
    }
    return response.columns
  }

  /**
   * Total row count for a registered table — metadata only (`count(*)`),
   * never a data read (M1-5). Virtualized grids need a total to size the
   * scroll area without implying full-dataset materialization. With
   * `options.filters` (m2-2) the count is narrowed to the matching rows —
   * the total a filtered grid displays.
   */
  async rowCount(handle: EngineTableHandle, options?: EngineRowCountOptions): Promise<number> {
    await this.ensureReady()
    const request: EngineRequest = {
      type: 'engine/row-count',
      requestId: this.takeRequestId(),
      tableId: handle.id,
    }
    if (options?.filters !== undefined) {
      request.filters = options.filters.map((filter) => ({
        column: filter.column,
        predicate: filter.predicate,
      }))
    }
    const response = await this.send(request)
    if (response.type !== 'engine/row-count-result') {
      throw new EngineProtocolError(`unexpected ${response.type} response for engine/row-count`)
    }
    return response.rowCount
  }

  /**
   * Fetch a row window of a registered table as an Arrow table (ADR 0020).
   * The window is validated and clamped to `MAX_RANGE_ROWS` on this side
   * (fast, honest errors) and again in the worker (the boundary is untrusted)
   * — the engine never implies full-dataset materialization.
   *
   * Worker-boundary note (m3-1 pin, mirrored for m3-2/m3-3 consumers): nested
   * cells cross as Arrow's structural types — Timestamp(MICROSECOND) surfaces
   * epoch MILLISECONDS through `.get()` (see @assay/testing's
   * `normalizeArrowCell` and the nested-window-fidelity scenarios).
   */
  async fetchRange(
    handle: EngineTableHandle,
    window: EngineRangeWindow,
  ): Promise<EngineRangeResult> {
    await this.ensureReady()
    const validated = validateRowWindow(window.startRow, window.endRow)
    if (!validated.valid) {
      throw new EngineOperationError(`invalid row window: ${validated.reason}`)
    }
    const request: EngineRequest = {
      type: 'engine/range',
      requestId: this.takeRequestId(),
      tableId: handle.id,
      startRow: validated.startRow,
      endRow: validated.endRow,
    }
    if (window.columns !== undefined) {
      if (window.columns.length === 0) {
        throw new EngineOperationError('columns must not be empty when provided')
      }
      request.columns = [...window.columns]
    }
    // m2-2: filters/sort cross as copied plain arrays (the boundary is
    // untrusted on the worker side — it re-validates the shape itself).
    // Empty arrays are passed through verbatim: they mean the same as absent
    // (no WHERE clause / natural order) once composed.
    if (window.filters !== undefined) {
      request.filters = window.filters.map((filter) => ({
        column: filter.column,
        predicate: filter.predicate,
      }))
    }
    if (window.sort !== undefined) {
      request.sort = window.sort.map((key) => ({ column: key.column, direction: key.direction }))
    }
    const response = await this.send(request)
    if (response.type !== 'engine/range-result') {
      throw new EngineProtocolError(`unexpected ${response.type} response for engine/range`)
    }
    try {
      return { batch: tableFromIPC(response.batchIpc), hasMore: response.hasMore }
    } catch (cause) {
      throw new EngineProtocolError('worker sent an invalid Arrow IPC payload', { cause })
    }
  }

  /**
   * Full statistics profile of a registered table (m2-5): per-column
   * nullCount/distinctCount, numeric stats (min/max/mean/stddev/quantiles)
   * for numeric columns, categorical top-k for scalar non-numeric ones.
   * Unknown handles reject with `EngineOperationError` (engine reusable);
   * the response is plain JSON-able data, already validated by the protocol
   * parser (finite numbers or null — never NaN/±Infinity).
   */
  async profile(handle: EngineTableHandle): Promise<EngineDatasetProfile> {
    await this.ensureReady()
    const response = await this.send({
      type: 'engine/profile',
      requestId: this.takeRequestId(),
      tableId: handle.id,
    })
    if (response.type !== 'engine/profile-result') {
      throw new EngineProtocolError(`unexpected ${response.type} response for engine/profile`)
    }
    return { rowCount: response.rowCount, columns: response.columns }
  }

  /**
   * Validate an overlay's engine type expressions on this side of the
   * boundary (m4-2 fix round). The worker validates too — but a type-shaped
   * injection would otherwise make the worker silently drop the request
   * (its malformed-payload contract), hanging this caller. Failing here with
   * the typed `EngineOperationError` keeps the rejection observable and
   * prevents a single byte of the hostile type string from reaching the
   * worker. The underlying `EngineTypeError` is attached as the cause.
   */
  private requireValidOverlayTypes(overlay: EngineOverlay): void {
    try {
      assertValidOverlayTypes(overlay)
    } catch (cause) {
      const message =
        cause instanceof EngineTypeError ? cause.message : 'invalid engine type expression'
      throw new EngineOperationError(message, { cause })
    }
  }

  /**
   * Effective schema of the composed overlay (m4-2): post-rename names and
   * post-cast DuckDB types, exactly as `DESCRIBE` reports them over the
   * composed projection. A cast whose target type string the engine rejects
   * fails HERE with a readable binder error (declared-type validation);
   * value-level cast failures surface on the first materializing op.
   */
  async overlaySchema(
    handle: EngineTableHandle,
    overlay: EngineOverlay,
  ): Promise<EngineColumnSchema[]> {
    await this.ensureReady()
    this.requireValidOverlayTypes(overlay)
    const response = await this.send({
      type: 'engine/overlay-schema',
      requestId: this.takeRequestId(),
      tableId: handle.id,
      overlay: { base: overlay.base, ops: overlay.ops === undefined ? [] : [...overlay.ops] },
    })
    if (response.type !== 'engine/overlay-schema-result') {
      throw new EngineProtocolError(
        `unexpected ${response.type} response for engine/overlay-schema`,
      )
    }
    return response.columns
  }

  /**
   * Live row count of the composed overlay (m4-2) — the domain's
   * `liveRowCount` when unfiltered (deletes excluded, live inserts added);
   * with `options.filters` (m2-2 grammar over effective columns) the count
   * narrows to the matching effective rows.
   */
  async overlayRowCount(
    handle: EngineTableHandle,
    overlay: EngineOverlay,
    options?: EngineRowCountOptions,
  ): Promise<number> {
    await this.ensureReady()
    this.requireValidOverlayTypes(overlay)
    const request: EngineRequest = {
      type: 'engine/overlay-row-count',
      requestId: this.takeRequestId(),
      tableId: handle.id,
      overlay: { base: overlay.base, ops: overlay.ops === undefined ? [] : [...overlay.ops] },
    }
    if (options?.filters !== undefined) {
      request.filters = options.filters.map((filter) => ({
        column: filter.column,
        predicate: filter.predicate,
      }))
    }
    const response = await this.send(request)
    if (response.type !== 'engine/overlay-row-count-result') {
      throw new EngineProtocolError(
        `unexpected ${response.type} response for engine/overlay-row-count`,
      )
    }
    return response.rowCount
  }

  /**
   * Fetch a row window of the composed effective view (m4-2): edits visible,
   * deletes excluded, inserts at their anchored positions (the domain's
   * `effectiveRowIds` order, reproduced exactly). The window is validated
   * and clamped on this side and again in the worker, like `fetchRange`.
   * With `includeRowIds`, the result's first column (`assay_row_id`) carries
   * logical row ids — how m4-3's grid targets edits at rows.
   */
  async fetchOverlayRange(
    handle: EngineTableHandle,
    overlay: EngineOverlay,
    window: EngineOverlayWindow,
  ): Promise<EngineRangeResult> {
    await this.ensureReady()
    this.requireValidOverlayTypes(overlay)
    const validated = validateRowWindow(window.startRow, window.endRow)
    if (!validated.valid) {
      throw new EngineOperationError(`invalid row window: ${validated.reason}`)
    }
    const request: EngineRequest = {
      type: 'engine/overlay-range',
      requestId: this.takeRequestId(),
      tableId: handle.id,
      overlay: { base: overlay.base, ops: overlay.ops === undefined ? [] : [...overlay.ops] },
      startRow: validated.startRow,
      endRow: validated.endRow,
    }
    if (window.columns !== undefined) {
      if (window.columns.length === 0) {
        throw new EngineOperationError('columns must not be empty when provided')
      }
      request.columns = [...window.columns]
    }
    if (window.filters !== undefined) {
      request.filters = window.filters.map((filter) => ({
        column: filter.column,
        predicate: filter.predicate,
      }))
    }
    if (window.sort !== undefined) {
      request.sort = window.sort.map((key) => ({ column: key.column, direction: key.direction }))
    }
    if (window.includeRowIds !== undefined) {
      request.includeRowIds = window.includeRowIds
    }
    const response = await this.send(request)
    if (response.type !== 'engine/overlay-range-result') {
      throw new EngineProtocolError(`unexpected ${response.type} response for engine/overlay-range`)
    }
    try {
      return { batch: tableFromIPC(response.batchIpc), hasMore: response.hasMore }
    } catch (cause) {
      throw new EngineProtocolError('worker sent an invalid Arrow IPC payload', { cause })
    }
  }

  /**
   * Validate-before-commit cast check (m4-4b, ADR 0012): over the given
   * **pre-cast** overlay state, report whether any non-NULL value of the
   * effective `column` cannot convert to `targetType`. The target type is
   * validated on this side with the engine's strict type validator (an
   * invalid spelling rejects with the typed `EngineOperationError` before
   * anything is posted), and `column` must be a known effective column of
   * the folded overlay (also a typed `EngineOperationError`). The answer is a
   * boolean only — dataset values never cross the boundary.
   */
  async overlayCastCheck(
    handle: EngineTableHandle,
    overlay: EngineOverlay,
    check: EngineOverlayCastCheck,
  ): Promise<EngineOverlayCastCheckResult> {
    await this.ensureReady()
    this.requireValidOverlayTypes(overlay)
    try {
      validateEngineTypeExpression(check.targetType)
    } catch (cause) {
      const message =
        cause instanceof EngineTypeError ? cause.message : 'invalid engine type expression'
      throw new EngineOperationError(message, { cause })
    }
    this.requireKnownOverlayColumn(overlay, check.column)
    const response = await this.send({
      type: 'engine/overlay-cast-check',
      requestId: this.takeRequestId(),
      tableId: handle.id,
      overlay: { base: overlay.base, ops: overlay.ops === undefined ? [] : [...overlay.ops] },
      column: check.column,
      targetType: check.targetType,
    })
    if (response.type !== 'engine/overlay-cast-check-result') {
      throw new EngineProtocolError(
        `unexpected ${response.type} response for engine/overlay-cast-check`,
      )
    }
    return { hasNonConvertibleValues: response.hasNonConvertibleValues }
  }

  /**
   * The effective column check behind `overlayCastCheck` (m4-4b): fold the
   * overlay on this side and reject an unknown column with the typed
   * operation error, so a doomed request is never posted. The worker composes
   * (and re-validates) independently; this is the fast, observable failure.
   * Column names are schema, never dataset values (ADR 0025).
   */
  private requireKnownOverlayColumn(overlay: EngineOverlay, column: string): void {
    const { state } = foldOverlay(overlay.base, overlay.ops ?? [])
    if (!state.columns.some((candidate) => candidate.name === column)) {
      throw new EngineOperationError(`unknown overlay column: ${column}`)
    }
  }

  /**
   * Export/rewrite op (m4-2): materialize the effective view (base +
   * overlay; absent `overlay` = the plain base view) into OPFS scratch space
   * under a generated path — a NEW file, never the source (ADR 0012/0017).
   * Deterministic per-format options are pinned in v1 (see
   * `overlay-query.ts`); CSV exports are formula-injection-sanitized. Re-open
   * the result through `open()` for the round-trip (give the source a name
   * with the exported extension so the engine picks the right reader).
   */
  async exportView(
    handle: EngineTableHandle,
    request: EngineExportRequest,
  ): Promise<EngineExportResult> {
    await this.ensureReady()
    if (request.overlay !== undefined) this.requireValidOverlayTypes(request.overlay)
    const response = await this.send({
      type: 'engine/export',
      requestId: this.takeRequestId(),
      tableId: handle.id,
      format: request.format,
      ...(request.overlay === undefined
        ? {}
        : {
            overlay: {
              base: request.overlay.base,
              ops: request.overlay.ops === undefined ? [] : [...request.overlay.ops],
            },
          }),
    })
    if (response.type !== 'engine/export-result') {
      throw new EngineProtocolError(`unexpected ${response.type} response for engine/export`)
    }
    return {
      path: response.path,
      format: response.format,
      rowCount: response.rowCount,
      bytes: response.bytes,
    }
  }

  /**
   * Validation execution (m5-2, query lane): execute a compiled m5-1
   * `ValidationPlan` (`@assay/validation`'s output — the parameter is the
   * engine's structural wire mirror, which the compiler's plan assigns to
   * directly) against the table's **effective view**: base + the given
   * overlay, or the plain base view when `overlay` is absent. Because the
   * plan executes over the composed relation, an M4 edit that fixes or
   * violates a rule flips that rule's verdict — re-validate after editing
   * for a fresh verdict.
   *
   * The plan is shape-validated on this side too (fast, observable failure
   * for a malformed plan — the worker re-validates at the boundary); the
   * result carries per-rule `{ruleId, failCount, failPercent, sampleFailures}`
   * in plan order, the effective row count, and the total verdict. Sample
   * values are report content: bounded, engine-clamped, never logged or
   * telemetried (ADR 0025).
   */
  async validate(
    handle: EngineTableHandle,
    plan: EngineValidationPlan,
    overlay?: EngineOverlay,
  ): Promise<EngineValidationResult> {
    await this.ensureReady()
    const wirePlan = parseValidationPlan(plan)
    if (wirePlan === null) {
      throw new EngineOperationError('malformed validation plan')
    }
    if (overlay !== undefined) this.requireValidOverlayTypes(overlay)
    const response = await this.send({
      type: 'engine/validate',
      requestId: this.takeRequestId(),
      tableId: handle.id,
      plan: wirePlan,
      ...(overlay === undefined
        ? {}
        : {
            overlay: { base: overlay.base, ops: overlay.ops === undefined ? [] : [...overlay.ops] },
          }),
    })
    if (response.type !== 'engine/validate-result') {
      throw new EngineProtocolError(`unexpected ${response.type} response for engine/validate`)
    }
    return response.result
  }

  /**
   * Stage a comparison dataset file for a row diff (m6-2, checkpoint C3):
   * registers the file in the worker's comparison scratch slot (never the
   * source path) and materializes a comparison view. Returns an opaque
   * comparison handle; a later {@link diff} binds it as the plan's side B.
   * Only one comparison is staged at a time — re-staging replaces the
   * previous one, so repeated staging cannot leak views or registrations.
   * A source whose `getFile()` does not resolve to a `File` rejects with
   * `EngineOperationError` before anything crosses the boundary (au3-4).
   * Unsupported extensions reject with `EngineOperationError`.
   */
  async stageComparison(source: EngineFileSource): Promise<EngineComparisonHandle> {
    await this.ensureReady()
    const file = await source.getFile()
    if (!isFile(file)) {
      throw new EngineOperationError('engine/diff-stage requires a File source')
    }
    const response = await this.send({
      type: 'engine/diff-stage',
      requestId: this.takeRequestId(),
      name: source.name,
      file,
    })
    if (response.type !== 'engine/diff-stage-result') {
      throw new EngineProtocolError(`unexpected ${response.type} response for engine/diff-stage`)
    }
    return { kind: 'comparison', id: response.comparisonId, schema: response.columns }
  }

  /**
   * Row-diff execution (m6-2, query lane): execute a compiled m6-1
   * `RowDiffPlan` (`@assay/diff`'s output — the parameter is the engine's
   * structural wire mirror, which the compiler's plan assigns to directly)
   * against the table's **effective view** (base + the given overlay, or the
   * plain base view when absent) as side A, and the staged comparison as
   * side B.
   *
   * The plan is shape-validated on this side too (fast, observable failure
   * for a malformed plan — the worker re-validates at the boundary); the
   * result carries the two effective row counts and one entry per aspect
   * (`added`/`removed`/`changed`) with the exact count and bounded samples.
   * A-side samples carry grid-resolvable logical row keys; B-side samples
   * carry the report-only `b:<ordinal>` form (checkpoint C3). Row keys and
   * changed-column names are report content — never logged (ADR 0025).
   */
  async diff(
    handle: EngineTableHandle,
    comparison: EngineComparisonHandle,
    plan: EngineRowDiffPlan,
    overlay?: EngineOverlay,
  ): Promise<EngineRowDiffResult> {
    await this.ensureReady()
    const wirePlan = parseRowDiffPlan(plan)
    if (wirePlan === null) {
      throw new EngineOperationError('malformed row-diff plan')
    }
    if (overlay !== undefined) this.requireValidOverlayTypes(overlay)
    const response = await this.send({
      type: 'engine/diff',
      requestId: this.takeRequestId(),
      tableId: handle.id,
      comparisonId: comparison.id,
      plan: wirePlan,
      ...(overlay === undefined
        ? {}
        : {
            overlay: { base: overlay.base, ops: overlay.ops === undefined ? [] : [...overlay.ops] },
          }),
    })
    if (response.type !== 'engine/diff-result') {
      throw new EngineProtocolError(`unexpected ${response.type} response for engine/diff`)
    }
    return response.result
  }

  /**
   * Execute a validated P1/p2 pipeline (p-3; p2-4 gates): compile the IR (or
   * take a compiled plan), then execute every node in topological order —
   * sources through the engine's registration path bound to the node
   * relation, data nodes per their ADR 0033 mode (`view`/`ephemeral` session
   * view, `table` DuckDB table, `export` Parquet artifact), and gate nodes
   * through the M5/M6 machinery with host-supplied compilers. One explicit
   * user-triggered run (ADR 0032): no scheduling, retries, or run state; a
   * re-run recreates relations, never appends.
   *
   * The heavy engine calls (registration/materialization/export/validate/
   * diff) are query-lane ops (ADR 0040), so a run cannot starve the grid's
   * registry-lane windows; gate execution additionally resolves its input
   * relations through the cheap registry-lane handle/schema probe. The p-2
   * read-only SQL gate is enforced here before any engine call and again
   * worker-side. See the runner module for the full outcome/refusal contract.
   */
  async runPipeline(
    input: PipelineRunInput,
    options: PipelineRunOptions = {},
  ): Promise<PipelineRunResult> {
    await this.ensureReady()
    /**
     * One registry handle per relation per run (p2-4): gate compilation and
     * execution need the relation's schema/effective view, and registering
     * once avoids accumulating handles across a multi-gate run.
     */
    const handles = new Map<string, EngineTableHandle>()
    const handleFor = async (relation: string): Promise<EngineTableHandle> => {
      const existing = handles.get(relation)
      if (existing !== undefined) return existing
      const handle = await this.registerPipelineRelation(relation)
      handles.set(relation, handle)
      return handle
    }
    const ops: PipelineRunEngineOps = {
      registerSource: async (relation, source) => {
        const file = await source.getFile()
        if (!isFile(file)) {
          throw new EngineOperationError('pipeline source requires a File')
        }
        const response = await this.send({
          type: 'engine/pipeline-source',
          requestId: this.takeRequestId(),
          relation,
          name: source.name,
          file,
        })
        if (response.type !== 'engine/pipeline-source-result') {
          throw new EngineProtocolError(
            `unexpected ${response.type} response for engine/pipeline-source`,
          )
        }
        return response.rowCount
      },
      materialize: async (relation, sql, materialization) => {
        const response = await this.send({
          type: 'engine/pipeline-execute',
          requestId: this.takeRequestId(),
          relation,
          materialization,
          sql,
        })
        if (response.type !== 'engine/pipeline-execute-result') {
          throw new EngineProtocolError(
            `unexpected ${response.type} response for engine/pipeline-execute`,
          )
        }
        return response.rowCount
      },
      exportRelation: async (relation, sql, path) => {
        const response = await this.send({
          type: 'engine/pipeline-execute',
          requestId: this.takeRequestId(),
          relation,
          materialization: 'export',
          sql,
          path,
        })
        if (
          response.type !== 'engine/pipeline-execute-result' ||
          response.path === undefined ||
          response.bytes === undefined
        ) {
          throw new EngineProtocolError(
            `unexpected ${response.type} response for engine/pipeline-execute`,
          )
        }
        return { path: response.path, rowCount: response.rowCount, bytes: response.bytes }
      },
      schemaOf: async (relation) => {
        const handle = await handleFor(relation)
        const columns = await this.schema(handle)
        return columns.map((column) => ({ name: column.name, type: column.type }))
      },
      validate: async (relation, plan) => {
        const handle = await handleFor(relation)
        return this.validate(handle, plan)
      },
      diff: async (inputRelation, againstRelation, plan) => {
        const wirePlan = parseRowDiffPlan(plan)
        if (wirePlan === null) {
          throw new EngineOperationError('malformed row-diff plan')
        }
        const response = await this.send({
          type: 'engine/pipeline-diff',
          requestId: this.takeRequestId(),
          inputRelation,
          againstRelation,
          plan: wirePlan,
        })
        if (response.type !== 'engine/pipeline-diff-result') {
          throw new EngineProtocolError(
            `unexpected ${response.type} response for engine/pipeline-diff`,
          )
        }
        return response.result
      },
    }
    return executePipeline(input, options, ops)
  }

  /**
   * Open an EXISTING pipeline relation (a node's materialized view in this
   * session) as a dataset handle (p2-1), so the grid-native registry ops
   * (`schema`/`fetchRange`/`rowCount`) and `exportView` address it by handle
   * — no SQL-result detour through `query()`. The relation must already exist
   * in this session (the pipeline run created it); an unknown relation rejects
   * with the engine's operation category, value-free (ADR 0025). Registry
   * lane: bookkeeping plus a cheap existence probe, no data scan.
   */
  async registerPipelineRelation(relation: string): Promise<EngineTableHandle> {
    await this.ensureReady()
    const response = await this.send({
      type: 'engine/pipeline-handle',
      requestId: this.takeRequestId(),
      relation,
    })
    if (response.type !== 'engine/pipeline-handle-result') {
      throw new EngineProtocolError(
        `unexpected ${response.type} response for engine/pipeline-handle`,
      )
    }
    return { kind: 'table', id: response.tableId }
  }

  /**
   * Gracefully dispose: ask the worker to drop every registered view/file,
   * wait briefly for the reply (or the worker's death), then terminate the
   * worker — the hard guarantee that the whole engine instance, including
   * everything registered, is reclaimed. Fails all pending work. Terminal,
   * idempotent; safe before the first boot.
   */
  async dispose(): Promise<void> {
    if (this.disposed || this.currentStatus === 'disposed') return
    this.disposal ??= this.runDisposal()
    await this.disposal
  }

  private async runDisposal(): Promise<void> {
    // Terminal immediately: in-flight and new main-thread calls reject with
    // `EngineDisposedError` while the worker finishes its graceful cleanup.
    // The sentinel is set first and never cleared, so a boot that races this
    // call cannot flip the client back to `'ready'` (see `boot`).
    this.disposed = true
    this.currentStatus = 'disposed'
    this.failAllPending(new EngineDisposedError())
    const worker = this.worker
    if (worker !== null) {
      try {
        await Promise.race([
          this.send({ type: 'engine/dispose', requestId: this.takeRequestId() }, worker),
          new Promise((resolve) => setTimeout(resolve, this.disposeTimeoutMs)),
        ])
      } catch {
        // Best-effort: a dead worker rejects here (or its crash already ran);
        // terminate() below is the hard cleanup guarantee.
      }
      worker.terminate()
    }
    if (this.worker === worker) this.worker = null
    // Re-fail after termination: the graceful `engine/dispose` request (and
    // any entry that raced past the first sweep) must not be left pending on
    // a terminated worker. Nothing can settle late.
    this.failAllPending(new EngineDisposedError())
    this.ready = null
  }

  private async boot(): Promise<EngineReadyInfo> {
    try {
      const worker = this.workerFactory()
      this.worker = worker
      worker.addEventListener('message', this.handleMessage)
      worker.addEventListener('error', this.handleError)
      this.currentStatus = 'booting'
      const response = await this.send({
        type: 'engine/init',
        requestId: this.takeRequestId(),
      })
      if (response.type !== 'engine/ready') {
        throw new EngineProtocolError(`unexpected ${response.type} response for engine/init`)
      }
      // Fail-first: if `dispose()` began while `engine/init` was in flight, the
      // client is permanently disposed — never advance to `'ready'` (that was
      // the dispose-racing-boot resurrection bug). The boot settles with the
      // typed disposal error instead.
      if (this.disposed) throw new EngineDisposedError()
      this.currentStatus = 'ready'
      return { duckdbVersion: response.duckdbVersion }
    } catch (error) {
      this.failAllPending(new EngineWorkerError('engine boot failed', { cause: error }))
      if (this.disposed) {
        // `dispose()` owns the worker now: it will terminate after its own
        // graceful handshake, so do not tear down here (an early terminate
        // would abort that handshake and force the disposal timeout).
        this.ready = null
      } else {
        // Boot failed on its own: tear down so the next call boots afresh.
        this.worker?.terminate()
        this.worker = null
        this.ready = null
        this.currentStatus = 'failed'
      }
      throw error
    }
  }

  private send(
    request: EngineRequest,
    workerOverride?: EngineWorkerLike,
  ): Promise<EngineSuccessResponse> {
    // AR-E3: re-check the lifecycle status here, not only in `ensureReady()`.
    // A public op can pass `ensureReady()` and then await host work (e.g.
    // `source.getFile()`) while `dispose()` starts; without this check it
    // would add a fresh pending entry and post to a terminated worker, never
    // to settle. The internal graceful-dispose send passes `workerOverride`
    // and is deliberately allowed through.
    if (workerOverride === undefined && (this.disposed || this.currentStatus === 'disposed')) {
      return Promise.reject(new EngineDisposedError())
    }
    const worker = workerOverride ?? this.worker
    if (worker === null) {
      return Promise.reject(new EngineWorkerError('engine worker is not running'))
    }
    return new Promise<EngineSuccessResponse>((resolve, reject) => {
      // AR-E3 (au3-4): the pending entry is inserted before the post so a reply
      // that somehow races the post is never dropped, but the post is guarded:
      // if `postMessage` rejects the payload (structured clone, e.g. an
      // uncloneable `File`), the entry is deleted immediately and the op
      // rejects with a typed, value-free operation error. A failed post must
      // never leave a stale pending entry for an unrelated crash()/dispose()
      // sweep to collect, and the raw clone TypeError (which may name payload
      // content) never crosses the boundary.
      this.pending.set(request.requestId, {
        requestType: request.type,
        resolve,
        reject,
      })
      try {
        worker.postMessage(request)
      } catch {
        this.pending.delete(request.requestId)
        reject(
          new EngineOperationError(
            `engine request ${request.type} could not be posted to the worker`,
          ),
        )
      }
    })
  }

  private takeRequestId(): number {
    return this.nextRequestId++
  }

  private readonly handleMessage = (event: MessageEvent<unknown>): void => {
    const response = parseEngineResponse(event.data)
    if (response === null) {
      // m5-2 round-3 fix, item 3: a message that is recognisably a response
      // to a pending request but failed shape validation REJECTS that
      // pending promise with a typed protocol error — a misbehaving worker
      // can never leave an op (validate or any other) hanging forever. A
      // message that does not claim a pending requestId stays ignorable
      // (a foreign script sharing the worker, a late/duplicate reply).
      this.rejectPendingOnMalformedResponse(event.data)
      return
    }
    const pending = this.pending.get(response.requestId)
    if (pending === undefined) {
      // Late or duplicate reply (e.g. after a crash + re-boot) — nothing to do.
      return
    }
    this.pending.delete(response.requestId)
    if (response.type === 'engine/error') {
      pending.reject(engineErrorFor(pending.requestType, response.message))
    } else {
      pending.resolve(response)
    }
  }

  /**
   * Reject the pending request a malformed response claims to answer, if
   * any (m5-2 round-3 fix, item 3): the envelope identity (`requestId` + a
   * known-protocol `engine/…` type string) is matched against the pending
   * map; a match is rejected with one typed {@link EngineProtocolError} and
   * removed, so the awaited op fails honestly instead of hanging. Anything
   * without a pending match is not ours — the pre-existing ignore contract
   * (foreign scripts, late replies) is unchanged.
   */
  private rejectPendingOnMalformedResponse(data: unknown): void {
    if (typeof data !== 'object' || data === null) return
    const record = data as Record<string, unknown>
    const type = record['type']
    if (typeof type !== 'string' || !type.startsWith('engine/')) return
    const requestId = record['requestId']
    if (typeof requestId !== 'number' || !Number.isSafeInteger(requestId)) return
    const pending = this.pending.get(requestId)
    if (pending === undefined) return
    this.pending.delete(requestId)
    pending.reject(
      new EngineProtocolError(
        `the engine worker sent a malformed response for ${pending.requestType}`,
      ),
    )
  }

  private readonly handleError = (event: ErrorEvent): void => {
    // The worker itself died. Fail everything pending; an in-flight boot
    // rejects in its own catch and resets the client.
    this.crash(event.message || 'engine worker crashed')
  }

  private crash(reason: string): void {
    this.failAllPending(new EngineWorkerError(reason))
    this.worker?.terminate()
    this.worker = null
    this.ready = null
    if (!this.disposed) this.currentStatus = 'failed'
  }

  private failAllPending(reason: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(reason)
    }
    this.pending.clear()
  }
}
