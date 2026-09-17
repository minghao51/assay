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
import { parseEngineResponse } from './protocol'
import type {
  EngineColumnSchema,
  EngineFilterSpec,
  EngineProfileColumn,
  EngineReadyInfo,
  EngineRequest,
  EngineSortSpec,
  EngineSuccessResponse,
} from './protocol'
import { validateRowWindow } from './range-window'

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

/** Creates the real engine worker: this package's TS worker entry (bundled by Vite). */
function defaultWorkerFactory(): EngineWorkerLike {
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
}

const DEFAULT_DISPOSE_TIMEOUT_MS = 5_000

export class DuckDbEngineClient {
  private currentStatus: EngineStatus = 'idle'
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
    if (this.currentStatus === 'disposed') throw new EngineDisposedError()
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
   * Unsupported formats reject with `EngineOperationError`.
   */
  async open(source: EngineFileSource): Promise<EngineTableHandle> {
    await this.ensureReady()
    const file = await source.getFile()
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
   * Gracefully dispose: ask the worker to drop every registered view/file,
   * wait briefly for the reply (or the worker's death), then terminate the
   * worker — the hard guarantee that the whole engine instance, including
   * everything registered, is reclaimed. Fails all pending work. Terminal,
   * idempotent; safe before the first boot.
   */
  async dispose(): Promise<void> {
    if (this.currentStatus === 'disposed') return
    this.disposal ??= this.runDisposal()
    await this.disposal
  }

  private async runDisposal(): Promise<void> {
    // Terminal immediately: in-flight and new main-thread calls reject with
    // `EngineDisposedError` while the worker finishes its graceful cleanup.
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
      this.currentStatus = 'ready'
      return { duckdbVersion: response.duckdbVersion }
    } catch (error) {
      // Boot failed: tear down so the next call attempts a fresh boot.
      this.failAllPending(new EngineWorkerError('engine boot failed', { cause: error }))
      this.worker?.terminate()
      this.worker = null
      this.ready = null
      if (this.currentStatus !== 'disposed') this.currentStatus = 'failed'
      throw error
    }
  }

  private send(
    request: EngineRequest,
    workerOverride?: EngineWorkerLike,
  ): Promise<EngineSuccessResponse> {
    const worker = workerOverride ?? this.worker
    if (worker === null) {
      return Promise.reject(new EngineWorkerError('engine worker is not running'))
    }
    return new Promise<EngineSuccessResponse>((resolve, reject) => {
      this.pending.set(request.requestId, {
        requestType: request.type,
        resolve,
        reject,
      })
      worker.postMessage(request)
    })
  }

  private takeRequestId(): number {
    return this.nextRequestId++
  }

  private readonly handleMessage = (event: MessageEvent<unknown>): void => {
    const response = parseEngineResponse(event.data)
    if (response === null) {
      // Not our protocol (e.g. a foreign script sharing the worker) — ignore.
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
    if (this.currentStatus !== 'disposed') this.currentStatus = 'failed'
  }

  private failAllPending(reason: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(reason)
    }
    this.pending.clear()
  }
}
