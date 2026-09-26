// SPDX-License-Identifier: AGPL-3.0-or-later

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
 *
 * Query state (m2-1): the model owns the explicit sort/filter state that the
 * renderer displays and mirrors every accepted change to the provider via
 * `GridDataProvider.sort()/filter()` (contract stubs until now). `setSort()`
 * / `setFilters()` are the verb-named model API (coherent with
 * `load()`/`refresh()`/`retry()`; the noun getters `sort`/`filters` expose
 * the state for UI badges and are what the m2-3 header controls wire to).
 * A successful change starts a fresh data epoch: it reuses `refresh()`, so
 * cached windows are dropped, the row count is re-read (filters change
 * totals), the visible window is refetched under the new state, and the
 * generation guard discards any page still in flight from the old state.
 */
import type {
  ColumnSchema,
  FilterSpec,
  GridDataPage,
  GridDataProvider,
  GridRowSlot,
  SortSpec,
} from './contracts.js'

/** Inclusive row-index span `[start, end]`. */
interface Span {
  readonly start: number
  readonly end: number
}

/**
 * An in-flight span fetch, tagged with the data epoch it was issued under
 * (m4-3 carry-over fix, m2-1). `refresh()` bumps the generation and clears
 * the map, but an older fetch can still be awaiting the provider; when it
 * resolves, its `finally` must not delete a *newer* epoch's marker for the
 * same `start:end` key (that would make the newer span look uncovered and
 * trigger a duplicate fetch, corrupting the dedup/fetch-count honesty).
 * Tagging the marker with its epoch makes the cleanup conditional on the
 * marker still belonging to the finishing fetch. The "stale page never
 * lands" guarantee (the `generation !== this.generation` early returns) is
 * unchanged.
 */
interface InflightSpan extends Span {
  readonly generation: number
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
  /** Spans whose last fetch failed and are surfacing errors to the renderer (≤ `maxFailedSpans`). */
  readonly failedSpans: number
  /**
   * The provider-contract violation that stopped fetching (`null` = healthy).
   * A fatal error is **not** retryable — `retry()` ignores it; only
   * `refresh()`/`load()` clear it. Distinct from a transient span failure so
   * the retry path can never loop on a broken provider (AR-D3).
   */
  readonly fatalError: string | null
}

export interface GridViewportOptions {
  /** Rows prefetched beyond each edge of the visible range. Default 20. */
  readonly overscanRows?: number
  /** Hard LRU bound on cached rows (UI state, never the dataset). Default 10_000. */
  readonly maxCachedRows?: number
  /**
   * Longest contiguous span per `fetchRange` call. Default 1000.
   *
   * **Provider-clamp contract:** the model splits every uncovered run into
   * spans no longer than this, so an in-range request never exceeds
   * `maxSpanRows`. A provider **must** return exactly the requested rows for
   * an in-range request — a short or misaligned page is a contract violation
   * and surfaces as a fatal, non-retryable model error, never as a transient
   * failure (a transient classification would make `retry()` re-request the
   * same span forever). Set this at or below the provider's own per-request
   * cap (the engine's `MAX_RANGE_ROWS`).
   */
  readonly maxSpanRows?: number
  /**
   * Hard bound on remembered failed spans per epoch, oldest evicted first
   * (UI state, like the row cache — a persistently failing provider must not
   * grow the map without bound within an epoch). Default 256. `stats`
   * reports the current size. Failed spans past the bound degrade to
   * `loading` on read, never to a silent wrong row (AR-D4).
   */
  readonly maxFailedSpans?: number
}

const DEFAULT_OVERSCAN_ROWS = 20
const DEFAULT_MAX_CACHED_ROWS = 10_000
/**
 * Matches `MAX_RANGE_ROWS` in `@assay/engine-duckdb` (deliberately
 * duplicated: the grid must not depend on an engine package). Spans longer
 * than this are split, so the provider never receives an unbounded range.
 * See `GridViewportOptions.maxSpanRows` for the provider-clamp contract.
 */
const DEFAULT_MAX_SPAN_ROWS = 1000
/** Bounds `failedSpans` within an epoch (see `maxFailedSpans`). */
const DEFAULT_MAX_FAILED_SPANS = 256

/**
 * A provider returned a page that violates the `fetchRange` contract
 * (misaligned start, short row count, mismatched key channel). Distinct from
 * a transient provider failure: it is classified as fatal and never enters
 * the retryable `failedSpans` path (AR-D3).
 */
class ProviderContractError extends Error {}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Renderer-bug guard: a sort spec must name a column and a direction. */
function assertSortSpec(spec: SortSpec): void {
  if (typeof spec.column !== 'string' || spec.column.length === 0) {
    throw new TypeError(`sort spec must name a column, got ${String(spec.column)}`)
  }
  if (spec.direction !== 'asc' && spec.direction !== 'desc') {
    throw new TypeError(`sort direction must be 'asc' or 'desc', got ${String(spec.direction)}`)
  }
}

/**
 * Renderer-bug guard: a filter spec must name a column and carry a string
 * predicate. Predicate *content* is engine-defined SQL text (ADR 0029) — the
 * model never interprets it; the provider validates and may reject.
 */
function assertFilterSpec(spec: FilterSpec): void {
  if (typeof spec.column !== 'string' || spec.column.length === 0) {
    throw new TypeError(`filter spec must name a column, got ${String(spec.column)}`)
  }
  if (typeof spec.predicate !== 'string') {
    throw new TypeError('filter predicate must be a string')
  }
}

export class GridViewportModel {
  private readonly provider: GridDataProvider
  private readonly overscanRows: number
  private readonly maxCachedRows: number
  private readonly maxSpanRows: number
  private readonly maxFailedSpans: number

  private schemaColumns: ColumnSchema[] | null = null
  private totalRowCount: number | null = null
  /** Active sort, exactly as last accepted by the provider (null = none). */
  private sortState: SortSpec | null = null
  /** Active filters, in model order — the order pushed to the provider. */
  private filterState: FilterSpec[] = []
  /** LRU row cache: row index → cells. Insertion order = least- to most-recent. */
  private readonly cache = new Map<number, readonly unknown[]>()
  /**
   * Opaque row identity per cached row (m4-3): the provider's key channel,
   * kept in lock-step with `cache` (same insert/evict/clear points) so a
   * ready slot can expose `key` for the host's logical-row edit layer. The
   * model never interprets the string.
   */
  private readonly rowKeys = new Map<number, string>()
  /** In-flight span fetches, keyed `start:end`, epoch-tagged (dedup of asks). */
  private readonly inflight = new Map<string, InflightSpan>()
  /** Failed spans (keyed like `inflight`) with the provider's error message. Bounded by `maxFailedSpans`. */
  private readonly failedSpans = new Map<string, Span & { message: string }>()
  /**
   * A provider-contract violation stopped fetching (`null` = healthy). Not
   * retryable; cleared by `load()`/`refresh()` (AR-D3).
   */
  private fatalError: string | null = null
  /**
   * Query-state request counter and serialization queue (AR-D5): mutations
   * (`setSort`/`setFilters`) apply their provider pushes strictly in request
   * order, and the latest request's exposed state always wins — a superseded
   * call never clobbers it or leaves the provider half-updated.
   */
  private querySeq = 0
  private queryQueue: Promise<void> = Promise.resolve()
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
    this.maxFailedSpans = options.maxFailedSpans ?? DEFAULT_MAX_FAILED_SPANS
    if (!Number.isInteger(this.overscanRows) || this.overscanRows < 0) {
      throw new RangeError('overscanRows must be a non-negative integer')
    }
    if (!Number.isInteger(this.maxCachedRows) || this.maxCachedRows < 1) {
      throw new RangeError('maxCachedRows must be a positive integer')
    }
    if (!Number.isInteger(this.maxSpanRows) || this.maxSpanRows < 1) {
      throw new RangeError('maxSpanRows must be a positive integer')
    }
    if (!Number.isInteger(this.maxFailedSpans) || this.maxFailedSpans < 1) {
      throw new RangeError('maxFailedSpans must be a positive integer')
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

  /**
   * Active sort as last accepted by the provider (null = dataset order).
   * Mirrors the state the renderer should display; only changes once the
   * provider has accepted a `setSort()`.
   */
  get sort(): SortSpec | null {
    return this.sortState
  }

  /**
   * Active filter list in model order (empty = unfiltered). Predicates are
   * engine-defined SQL text (ADR 0029) — displayed verbatim, never executed
   * here. Only changes once the provider has accepted a `setFilters()`.
   */
  get filters(): readonly FilterSpec[] {
    return this.filterState
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
      fatalError: this.fatalError,
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
   *
   * A `load()` is a fresh data epoch: it drops every cached/failed row and
   * in-flight marker, clears the request counters, and bumps the generation
   * so a page issued before it can never land (AR-D6) — a reloaded dataset
   * must never serve the previous load's cells. The caller re-observes the
   * viewport afterwards (as `refresh()` does).
   */
  async load(): Promise<void> {
    this.generation += 1
    this.cache.clear()
    this.rowKeys.clear()
    this.failedSpans.clear()
    this.inflight.clear()
    this.fatalError = null
    this.currentFetchCalls = 0
    this.currentRowsRequested = 0
    this.currentRowsReceived = 0
    this.currentMaxSpanRows = 0
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
    // A fatal contract violation is not retryable — retrying would re-request
    // the same broken span forever (AR-D3). Only load()/refresh() clear it.
    if (this.viewport === null || this.fatalError !== null) return
    const window = this.currentWindow()
    for (const [key, span] of [...this.failedSpans]) {
      if (span.end < window.start || span.start > window.end) continue
      this.failedSpans.delete(key)
      this.requestSpan(span.start, span.end)
    }
  }

  /**
   * Set or clear the dataset-wide sort (`null` clears). Records the state
   * only after the provider accepts; an accepted change starts a fresh data
   * epoch via `refresh()` — cached windows are dropped, the visible window
   * is refetched under the new ordering, and pages still in flight from the
   * old state are discarded on arrival by the generation guard (row order
   * may have changed under them). Stats reset with the epoch.
   *
   * **Sequence guard (AR-D5):** overlapping calls apply their provider
   * pushes in request order and the **last requested** state wins — a
   * superseded call neither assigns `sortState` nor starts a refresh, so the
   * exposed state can never disagree with what `fetchRange` serves.
   */
  async setSort(spec: SortSpec | null): Promise<void> {
    if (spec !== null) assertSortSpec(spec)
    const seq = ++this.querySeq
    return this.enqueueQuery(async () => {
      if (seq !== this.querySeq) return // superseded before it ran
      await this.provider.sort(spec)
      if (seq !== this.querySeq) return // superseded while the provider applied it
      this.sortState = spec
      await this.refresh()
    })
  }

  /**
   * Replace the whole filter list (`[]` clears all). Pushes `filter(null)`
   * then each spec in order, so the provider's list is deterministically
   * rebuilt to match the model's (see `GridDataProvider.filter`). Records
   * the state only after every push is accepted; an accepted change starts
   * a fresh data epoch via `refresh()` — cached windows are dropped, the
   * provider's row count is re-read (filters change totals), and the
   * visible window is refetched under the new state with the generation
   * guard discarding stale in-flight pages. A mid-sequence provider
   * rejection leaves the model state (and cache) untouched; the next
   * successful `setFilters` re-syncs the provider from scratch.
   *
   * **Sequence guard (AR-D5):** overlapping calls are serialized so their
   * provider pushes apply in request order, and the **last requested** list
   * wins — a superseded call neither assigns `filterState` nor starts a
   * refresh, so the exposed list can never disagree with what `fetchRange`
   * serves.
   */
  async setFilters(specs: readonly FilterSpec[]): Promise<void> {
    if (!Array.isArray(specs)) {
      throw new TypeError(`filters must be an array, got ${String(specs)}`)
    }
    const list = [...specs]
    for (const spec of list) assertFilterSpec(spec)
    const seq = ++this.querySeq
    return this.enqueueQuery(async () => {
      if (seq !== this.querySeq) return // superseded before it ran
      await this.provider.filter(null)
      for (const spec of list) await this.provider.filter(spec)
      if (seq !== this.querySeq) return // superseded while the provider applied it
      this.filterState = list
      await this.refresh()
    })
  }

  /**
   * Serialize one query-state mutation behind the previous one (AR-D5), so
   * provider pushes apply strictly in request order. The queue never
   * rejects (a failed mutation must not poison later ones); the caller's
   * own promise still surfaces the rejection.
   */
  private enqueueQuery(run: () => Promise<void>): Promise<void> {
    const next = this.queryQueue.then(run, run)
    this.queryQueue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  /**
   * Drop every cached/failed row and rebuild from the provider. Fetches that
   * were in flight before `refresh()` are discarded on arrival (generation
   * guard) — after a sort/filter change (or an external data edit) the row
   * order may have changed. Query state (`sort`/`filters`) is *not* reset:
   * refresh re-reads the dataset under the state the provider still holds.
   * Stats reset with the epoch so instrumentation stays per-dataset-view.
   */
  async refresh(): Promise<void> {
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
      const key = this.rowKeys.get(index)
      return key === undefined ? { status: 'ready', row } : { status: 'ready', row, key }
    }
    // A fatal provider-contract violation surfaces on every uncached row
    // (it stopped all fetching); it is not retryable (AR-D3).
    if (this.fatalError !== null) return { status: 'error', message: this.fatalError }
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
    // A fatal provider-contract violation stops all fetching until the next
    // epoch (AR-D3): no new spans, so no retry loop can form.
    if (this.fatalError !== null) return
    const key = `${String(start)}:${String(end)}`
    const existing = this.inflight.get(key)
    // A marker from the *current* epoch means this span is already being
    // fetched; a marker from an older epoch can never survive `refresh()`
    // (it clears the map), so an existing current-epoch marker is the only
    // case that dedups. Defensive generation check keeps the invariant even
    // if a future caller adds a non-clearing epoch transition.
    if (existing !== undefined && existing.generation === this.generation) return
    this.inflight.set(key, { start, end, generation: this.generation })
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
        throw new ProviderContractError(
          `provider returned a page for row ${String(page.startRow)}, expected ${String(start)}`,
        )
      }
      if (page.rows.length !== spanRows) {
        throw new ProviderContractError(
          `provider returned ${String(page.rows.length)} rows for a ${String(spanRows)}-row span (a provider must not return a short span for an in-range request — see maxSpanRows)`,
        )
      }
      if (page.rowKeys !== undefined && page.rowKeys.length !== spanRows) {
        throw new ProviderContractError(
          `provider returned ${String(page.rowKeys.length)} row keys for a ${String(spanRows)}-row span`,
        )
      }
      for (const [index, row] of page.rows.entries()) {
        this.cache.set(start + index, row)
        const key = page.rowKeys?.[index]
        // Keep the identity map aligned with the cache: a page without the
        // key channel leaves the row without an identity (the host's edit
        // affordances then decline), never a key from a previous epoch.
        if (key === undefined) this.rowKeys.delete(start + index)
        else if (typeof key !== 'string') {
          throw new ProviderContractError(
            `provider returned a non-string row key at ${String(start + index)}`,
          )
        } else this.rowKeys.set(start + index, key)
      }
      this.currentRowsReceived += page.rows.length
      this.failedSpans.delete(key)
      this.evictIfNeeded()
    } catch (error) {
      if (generation !== this.generation) return
      if (error instanceof ProviderContractError) {
        // Contract violation: fatal, not transient. Never enters failedSpans
        // (which retry()/re-observe would re-request forever).
        this.fatalError = error.message
      } else {
        this.recordFailedSpan(key, { start, end, message: errorMessage(error) })
      }
    } finally {
      // Conditional cleanup (m4-3): only the marker this fetch installed may
      // be removed. A newer epoch's marker for the same span survives an old
      // fetch's late completion, so dedup and `isCovered` stay honest.
      const marker = this.inflight.get(key)
      if (marker !== undefined && marker.generation === generation) {
        this.inflight.delete(key)
      }
      if (generation === this.generation) this.notify()
    }
  }

  /**
   * Record one failed span, bounding the map at `maxFailedSpans` by evicting
   * the oldest entry first (insertion order). A persistently failing
   * provider must not grow `failedSpans` without bound within an epoch
   * (AR-D4); `stats.failedSpans` still reports the live count.
   */
  private recordFailedSpan(key: string, span: Span & { message: string }): void {
    this.failedSpans.set(key, span)
    while (this.failedSpans.size > this.maxFailedSpans) {
      const oldest = this.failedSpans.keys().next().value
      if (oldest === undefined) break
      this.failedSpans.delete(oldest)
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
      if (index < window.start || index > window.end) {
        this.cache.delete(index)
        this.rowKeys.delete(index)
      }
    }
    for (const index of this.cache.keys()) {
      if (this.cache.size <= this.maxCachedRows) return
      this.cache.delete(index)
      this.rowKeys.delete(index)
    }
  }

  private notify(): void {
    this.version += 1
    for (const listener of [...this.listeners]) listener()
  }
}
