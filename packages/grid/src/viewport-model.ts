/**
 * The headless viewport model (ADR 0022): owns the mapping from "which rows
 * are on screen" to "which windows the provider must serve", plus the row
 * cache, in-flight dedup, loading/error semantics, and instrumentation.
 *
 * Engine-free, React-free, and Node-testable: the model knows
 * `GridDataProvider` (contracts.ts) and nothing about DuckDB, workers, or the
 * DOM. The renderer drives it with two calls — `load()` once, then
 * `observeViewport(first, last)` whenever the visible row range changes — and
 * reads row state with `getRow()` inside a `subscribe()`/`getVersion()`
 * subscription (shaped for React's `useSyncExternalStore`).
 *
 * Non-materialization guarantee (ADR 0003, architecture §8): the model only
 * ever requests viewport + overscan windows, split into spans of at most
 * `maxSpanRows` rows (default 1000, matching the engine's per-request cap in
 * `@assay/engine-duckdb` — the constant is deliberately duplicated, not
 * imported, so the grid stays engine-free). The cumulative request counters
 * exposed via `stats` make the guarantee observable in tests and e2e.
 */
import type { ColumnSchema, GridDataPage, GridDataProvider, GridRowSlot } from './contracts'

/** Inclusive row-index span `[start, end]`. */
interface Span {
  readonly start: number
  readonly end: number
}

/** Observable request/cache counters for the non-materialization proof. */
export interface GridViewportStats {
  /** `fetchRange` calls issued to the provider (cumulative, per data epoch). */
  readonly fetchCalls: number
  /** Sum of span lengths requested (cumulative rows asked for, not received). */
  readonly rowsRequested: number
  /** Sum of rows actually received and cached. */
  readonly rowsReceived: number
  /** Largest single span ever requested — bounded by `maxSpanRows`. */
  readonly maxSpanRows: number
  /** Rows currently held in the LRU cache (≤ `maxCachedRows`). */
  readonly cachedRows: number
  /** Spans whose last fetch failed and are surfacing errors to the renderer. */
  readonly failedSpans: number
}

export interface GridViewportOptions {
  /** Rows prefetched beyond each edge of the visible range. Default 20. */
  readonly overscanRows?: number
  /** Hard LRU bound on cached rows (UI state, never the dataset). Default 10_000. */
  readonly maxCachedRows?: number
  /** Longest contiguous span per `fetchRange` call. Default 1000. */
  readonly maxSpanRows?: number
}

const DEFAULT_OVERSCAN_ROWS = 20
const DEFAULT_MAX_CACHED_ROWS = 10_000
/**
 * Matches `MAX_RANGE_ROWS` in `@assay/engine-duckdb` (deliberately
 * duplicated: the grid must not depend on an engine package). Spans longer
 * than this are split, so the provider never receives an unbounded range.
 */
const DEFAULT_MAX_SPAN_ROWS = 1000

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class GridViewportModel {
  private readonly provider: GridDataProvider
  private readonly overscanRows: number
  private readonly maxCachedRows: number
  private readonly maxSpanRows: number

  private schemaColumns: ColumnSchema[] | null = null
  private totalRowCount: number | null = null
  /** LRU row cache: row index → cells. Insertion order = least- to most-recent. */
  private readonly cache = new Map<number, readonly unknown[]>()
  /** In-flight span fetches, keyed `start:end` (dedup of overlapping asks). */
  private readonly inflight = new Map<string, Span>()
  /** Failed spans (keyed like `inflight`) with the provider's error message. */
  private readonly failedSpans = new Map<string, Span & { message: string }>()
  private viewport: Span | null = null
  /**
   * Data epoch: bumped by `refresh()` so results of fetches issued before the
   * reset can never land in the fresh cache/failed map with stale ordering.
   */
  private generation = 0
  private currentFetchCalls = 0
  private currentRowsRequested = 0
  private currentRowsReceived = 0
  private currentMaxSpanRows = 0
  private version = 0
  private readonly listeners = new Set<() => void>()

  constructor(provider: GridDataProvider, options: GridViewportOptions = {}) {
    this.provider = provider
    this.overscanRows = options.overscanRows ?? DEFAULT_OVERSCAN_ROWS
    this.maxCachedRows = options.maxCachedRows ?? DEFAULT_MAX_CACHED_ROWS
    this.maxSpanRows = options.maxSpanRows ?? DEFAULT_MAX_SPAN_ROWS
    if (!Number.isInteger(this.overscanRows) || this.overscanRows < 0) {
      throw new RangeError('overscanRows must be a non-negative integer')
    }
    if (!Number.isInteger(this.maxCachedRows) || this.maxCachedRows < 1) {
      throw new RangeError('maxCachedRows must be a positive integer')
    }
    if (!Number.isInteger(this.maxSpanRows) || this.maxSpanRows < 1) {
      throw new RangeError('maxSpanRows must be a positive integer')
    }
  }

  /** Column schemas as reported by the provider (null until `load()` resolves). */
  get schema(): readonly ColumnSchema[] | null {
    return this.schemaColumns
  }

  /** Total dataset rows as reported by the provider (null until `load()` resolves). */
  get totalRows(): number | null {
    return this.totalRowCount
  }

  /** True once `load()` has delivered schema and row count. */
  get loaded(): boolean {
    return this.totalRowCount !== null && this.schemaColumns !== null
  }

  /** Snapshot of the request/cache counters (call again for fresh numbers). */
  get stats(): GridViewportStats {
    return Object.freeze({
      fetchCalls: this.currentFetchCalls,
      rowsRequested: this.currentRowsRequested,
      rowsReceived: this.currentRowsReceived,
      maxSpanRows: this.currentMaxSpanRows,
      cachedRows: this.cache.size,
      failedSpans: this.failedSpans.size,
    })
  }

  /** Subscription hook for `useSyncExternalStore` (stable identity). */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Snapshot hook for `useSyncExternalStore`: a monotonically increasing version. */
  readonly getVersion = (): number => this.version

  /**
   * Fetch schema and total row count. Must complete before
   * `observeViewport`/`refresh` do anything (they no-op / refuse otherwise).
   * Safe to call again (e.g. via `refresh()`).
   */
  async load(): Promise<void> {
    const [schema, rowCount] = await Promise.all([this.provider.schema(), this.provider.rowCount()])
    if (!Number.isSafeInteger(rowCount) || rowCount < 0) {
      throw new Error(`provider reported an invalid row count: ${String(rowCount)}`)
    }
    this.schemaColumns = schema
    this.totalRowCount = rowCount
    this.notify()
  }

  /**
   * Report the visible row range (inclusive indices, as the renderer lays
   * them out). The model expands by `overscanRows`, skips rows already cached
   * or in flight, and fetches only the missing contiguous spans (split into
   * `maxSpanRows` chunks). Before `load()` resolves this is a deliberate
   * no-op: without a row count there is no clampable range to request.
   */
  observeViewport(firstRow: number, lastRow: number): void {
    if (!Number.isSafeInteger(firstRow) || !Number.isSafeInteger(lastRow) || firstRow > lastRow) {
      throw new RangeError(`invalid viewport range: ${String(firstRow)}–${String(lastRow)}`)
    }
    if (!this.loaded) return
    const total = this.totalRowCount as number
    if (total === 0) return
    const first = Math.min(Math.max(firstRow, 0), total - 1)
    const last = Math.min(Math.max(lastRow, 0), total - 1)
    this.viewport = { start: first, end: last }

    const window = this.currentWindow()
    let runStart: number | null = null
    for (let index = window.start; index <= window.end + 1; index++) {
      const uncovered = index <= window.end && !this.isCovered(index)
      if (uncovered && runStart === null) runStart = index
      if (!uncovered && runStart !== null) {
        this.requestRun(runStart, index - 1)
        runStart = null
      }
    }
  }

  /**
   * Re-fetch every failed span that intersects the current viewport (after
   * the provider recovered, or the user asked to retry). Viewports without
   * failures are unaffected; distant failures are not retried speculatively.
   */
  retry(): void {
    if (this.viewport === null) return
    const window = this.currentWindow()
    for (const [key, span] of [...this.failedSpans]) {
      if (span.end < window.start || span.start > window.end) continue
      this.failedSpans.delete(key)
      this.requestSpan(span.start, span.end)
    }
  }

  /**
   * Drop every cached/failed row and rebuild from the provider. Fetches that
   * were in flight before `refresh()` are discarded on arrival (generation
   * guard) — after a sort/filter the row order may have changed. Stats reset
   * with the epoch so instrumentation stays per-dataset-view.
   */
  async refresh(): Promise<void> {
    this.generation += 1
    this.cache.clear()
    this.failedSpans.clear()
    this.inflight.clear()
    this.currentFetchCalls = 0
    this.currentRowsRequested = 0
    this.currentRowsReceived = 0
    this.currentMaxSpanRows = 0
    await this.load()
    if (this.viewport !== null) {
      this.observeViewport(this.viewport.start, this.viewport.end)
    }
  }

  /**
   * State of one grid row for the renderer: `ready` with cells, `loading`
   * (placeholder — uncached, in flight, or simply not yet requested), or
   * `error` with the provider's message (out-of-range indices included).
   * Reading a ready row refreshes its LRU recency.
   */
  getRow(index: number): GridRowSlot {
    if (this.totalRowCount !== null && (index < 0 || index >= this.totalRowCount)) {
      return {
        status: 'error',
        message:
          this.totalRowCount === 0
            ? 'the dataset has no rows'
            : `row index ${String(index)} is outside the dataset (0–${String(this.totalRowCount - 1)})`,
      }
    }
    const row = this.cache.get(index)
    if (row !== undefined) {
      // LRU touch: re-insert so rendering keeps visible rows most-recent.
      this.cache.delete(index)
      this.cache.set(index, row)
      return { status: 'ready', row }
    }
    const failed = this.failedSpanCovering(index)
    if (failed !== null) return { status: 'error', message: failed.message }
    return { status: 'loading' }
  }

  /** Inclusive index window actually prefetched around the current viewport. */
  private currentWindow(): Span {
    const viewport = this.viewport as Span
    const total = this.totalRowCount as number
    return {
      start: Math.max(0, viewport.start - this.overscanRows),
      end: Math.min(total - 1, viewport.end + this.overscanRows),
    }
  }

  /** A row needs no fetch when cached or inside a span already in flight. */
  private isCovered(index: number): boolean {
    if (this.cache.has(index)) return true
    for (const span of this.inflight.values()) {
      if (index >= span.start && index <= span.end) return true
    }
    return false
  }

  private failedSpanCovering(index: number): (Span & { message: string }) | null {
    for (const span of this.failedSpans.values()) {
      if (index >= span.start && index <= span.end) return span
    }
    return null
  }

  /** Split a contiguous uncovered run into ≤ `maxSpanRows` spans and fetch. */
  private requestRun(start: number, end: number): void {
    for (let spanStart = start; spanStart <= end; spanStart += this.maxSpanRows) {
      const spanEnd = Math.min(spanStart + this.maxSpanRows - 1, end)
      this.requestSpan(spanStart, spanEnd)
    }
  }

  private requestSpan(start: number, end: number): void {
    const key = `${String(start)}:${String(end)}`
    if (this.inflight.has(key)) return
    const span: Span = { start, end }
    this.inflight.set(key, span)
    void this.fetchSpan(start, end, key, this.generation)
  }

  private async fetchSpan(
    start: number,
    end: number,
    key: string,
    generation: number,
  ): Promise<void> {
    const spanRows = end - start + 1
    this.currentFetchCalls += 1
    this.currentRowsRequested += spanRows
    this.currentMaxSpanRows = Math.max(this.currentMaxSpanRows, spanRows)
    try {
      const page: GridDataPage = await this.provider.fetchRange({
        startRow: start,
        endRow: end + 1,
        startCol: 0,
        endCol: this.schemaColumns?.length ?? 0,
      })
      if (generation !== this.generation) return // stale epoch: discard silently
      if (page.startRow !== start) {
        throw new Error(
          `provider returned a page for row ${String(page.startRow)}, expected ${String(start)}`,
        )
      }
      if (page.rows.length !== spanRows) {
        throw new Error(
          `provider returned ${String(page.rows.length)} rows for a ${String(spanRows)}-row span`,
        )
      }
      for (let index = 0; index < page.rows.length; index++) {
        this.cache.set(start + index, page.rows[index])
      }
      this.currentRowsReceived += page.rows.length
      this.failedSpans.delete(key)
      this.evictIfNeeded()
    } catch (error) {
      if (generation !== this.generation) return
      this.failedSpans.set(key, { start, end, message: errorMessage(error) })
    } finally {
      this.inflight.delete(key)
      if (generation === this.generation) this.notify()
    }
  }

  /** Hard LRU bound: first evict rows outside the current window (oldest
   * first), then — only if the window itself exceeds the bound — evict
   * oldest regardless. The cache never grows past `maxCachedRows`. */
  private evictIfNeeded(): void {
    if (this.cache.size <= this.maxCachedRows) return
    const window = this.currentWindow()
    for (const index of this.cache.keys()) {
      if (this.cache.size <= this.maxCachedRows) return
      if (index < window.start || index > window.end) this.cache.delete(index)
    }
    for (const index of this.cache.keys()) {
      if (this.cache.size <= this.maxCachedRows) return
      this.cache.delete(index)
    }
  }

  private notify(): void {
    this.version += 1
    for (const listener of [...this.listeners]) listener()
  }
}
