// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import type {
  CellRange,
  ColumnSchema,
  FilterSpec,
  GridDataPage,
  GridDataProvider,
  SortSpec,
} from './contracts'
import { GridViewportModel } from './viewport-model'

// Vitest 4 no longer leaks Node's ambient globals into test files (this pure
// package's lib is ES2022-only and it has no `@types/node`), so the platform
// timer the macrotask-flush helper uses needs a local ambient declaration.
// Type-only: the runtime global still comes from Node.
declare function setTimeout(handler: () => void, timeout?: number): unknown

/**
 * In-memory fake provider: deterministic rows (`[i, "cell-${i}"]`), an
 * optional failure set, and a manual mode that holds fetches until released —
 * so loading/error/dedup semantics are observable in Node without timers.
 *
 * Query state (m2-1): the fake actually honors `sort`/`filter` — its served
 * view is the base row order filtered by an interpretable mini-predicate
 * grammar (`id >= 5`, `label <> cell-7`, …) and optionally reversed for a
 * descending sort — with `rowCount()` reporting the filtered view size, so
 * sorted/filtered windows, count updates, and epoch staleness are provable
 * end to end. Accepted `sort`/`filter` pushes are logged (`sortCalls` /
 * `filterCalls`); `rejectQueryPushes` makes them throw *before* touching any
 * state, modeling an atomically-rejecting provider.
 */
class FakeProvider implements GridDataProvider {
  totalRowCount: number
  readonly fetchLog: CellRange[] = []
  failStartRows: ReadonlySet<number>
  private readonly manual: boolean
  private sortSpec: SortSpec | null = null
  private readonly filterList: FilterSpec[] = []
  /** Accepted sort pushes, in order (a `null` entry = a clear). */
  readonly sortCalls: (SortSpec | null)[] = []
  /** Accepted filter pushes, in order (`null` entries = clears). */
  readonly filterCalls: (FilterSpec | null)[] = []
  rejectQueryPushes = false
  /** When true, every span fails (a persistently failing provider, AR-D4). */
  failAllSpans = false
  /** When true, `sort`/`filter` return held promises (resolution via `releaseQueryPush`, AR-D5). */
  holdQueryPushes = false
  private pendingQueryPushes: Array<{ resolve: () => void }> = []
  private pending: Array<{
    range: CellRange
    /** Frozen at request time, like a real provider's computed page. */
    page: GridDataPage
    resolve: (page: GridDataPage) => void
    reject: (error: Error) => void
  }> = []

  constructor(
    options: {
      rowCount?: number
      manual?: boolean
      failStartRows?: ReadonlySet<number>
      failAllSpans?: boolean
    } = {},
  ) {
    this.totalRowCount = options.rowCount ?? 1000
    this.manual = options.manual ?? false
    this.failStartRows = options.failStartRows ?? new Set()
    this.failAllSpans = options.failAllSpans ?? false
  }

  async rowCount(): Promise<number> {
    // Echo the raw count while no query state is set — this keeps the
    // load()-validation tests (bogus counts) honest; under sort/filter the
    // provider reports the view size, which is what the model must absorb.
    if (this.sortSpec === null && this.filterList.length === 0) return this.totalRowCount
    return this.viewIds().length
  }

  async schema(): Promise<ColumnSchema[]> {
    return [
      { name: 'id', type: 'BIGINT' },
      { name: 'label', type: 'VARCHAR' },
    ]
  }

  async fetchRange(range: CellRange): Promise<GridDataPage> {
    this.fetchLog.push(range)
    if (this.manual) {
      // Freeze the page at request time: a real provider computes rows under
      // the state it held when asked, so a late-resolving fetch carries the
      // old state's rows — exactly what the generation guard must discard.
      const page = this.pageFor(range)
      return new Promise<GridDataPage>((resolve, reject) => {
        this.pending.push({ range, page, resolve, reject })
      })
    }
    if (this.failAllSpans || this.failStartRows.has(range.startRow)) {
      throw new Error(`provider failure at row ${String(range.startRow)}`)
    }
    return this.pageFor(range)
  }

  async sort(spec: SortSpec | null): Promise<void> {
    if (this.rejectQueryPushes) throw new Error('sort rejected by provider')
    this.sortSpec = spec
    this.sortCalls.push(spec)
    if (this.holdQueryPushes) {
      await new Promise<void>((resolve) => this.pendingQueryPushes.push({ resolve }))
    }
  }

  async filter(spec: FilterSpec | null): Promise<void> {
    if (this.rejectQueryPushes) throw new Error('filter rejected by provider')
    if (spec === null) {
      this.filterList.length = 0
    } else {
      this.filterList.push(spec)
    }
    this.filterCalls.push(spec)
    if (this.holdQueryPushes) {
      await new Promise<void>((resolve) => this.pendingQueryPushes.push({ resolve }))
    }
  }

  /** Release one held `sort`/`filter` push (FIFO by default) — AR-D5 pin control. */
  releaseQueryPush(index = 0): void {
    const [entry] = this.pendingQueryPushes.splice(index, 1)
    if (entry === undefined) throw new Error(`no pending query push at index ${String(index)}`)
    entry.resolve()
  }

  // No `updateCell`: the m4-3 contract removed the positional mutator stub
  // (editing is an overlay op addressed by logical row identity, owned by
  // the host's edit layer — see contracts.ts).

  /** Resolve (or fail) every held fetch with its request-time page. */
  releaseAll(): void {
    const held = this.pending
    this.pending = []
    for (const entry of held) {
      if (this.failAllSpans || this.failStartRows.has(entry.range.startRow)) {
        entry.reject(new Error(`provider failure at row ${String(entry.range.startRow)}`))
      } else {
        entry.resolve(entry.page)
      }
    }
  }

  /**
   * Resolve exactly one held fetch (FIFO by default) with its request-time
   * page — used by the m4-3 inflight-tagging regression, which must complete
   * an OLD epoch's fetch while a NEW epoch's fetch for the same span is
   * still in flight.
   */
  releaseAt(index = 0): void {
    const [entry] = this.pending.splice(index, 1)
    if (entry === undefined) throw new Error(`no pending fetch at index ${String(index)}`)
    if (this.failStartRows.has(entry.range.startRow)) {
      entry.reject(new Error(`provider failure at row ${String(entry.range.startRow)}`))
    } else {
      entry.resolve(entry.page)
    }
  }

  /** Grid row `index` of the served view → base row cells. */
  pageFor(range: CellRange): GridDataPage {
    const view = this.viewIds()
    const rows: unknown[][] = []
    for (let index = range.startRow; index < range.endRow; index++) {
      const id = view[index]
      rows.push([id, `cell-${String(id)}`])
    }
    return { startRow: range.startRow, rows }
  }

  /** Base row ids of the served view: filtered, then sorted. */
  private viewIds(): number[] {
    const ids: number[] = []
    for (let id = 0; id < this.totalRowCount; id++) {
      if (this.filterList.every((spec) => this.matches(id, spec))) ids.push(id)
    }
    if (this.sortSpec !== null && this.sortSpec.direction === 'desc') ids.reverse()
    return ids
  }

  /**
   * Mini-predicate grammar (the fake stands in for the engine's SQL):
   * `id <op> <n>` with op in >=, <=, >, <, =, <> — and `label (=|<>)
   * cell-<n>` to prove the spec's column field routes the predicate.
   * Unknown shapes throw loudly instead of silently matching everything.
   */
  private matches(id: number, spec: FilterSpec): boolean {
    const onId = /^id\s*(>=|<=|<>|=|>|<)\s*(-?\d+)$/.exec(spec.predicate)
    if (spec.column === 'id' && onId !== null) {
      const value = Number(onId[2])
      switch (onId[1]) {
        case '>=':
          return id >= value
        case '<=':
          return id <= value
        case '>':
          return id > value
        case '<':
          return id < value
        case '=':
          return id === value
        case '<>':
          return id !== value
      }
    }
    const onLabel = /^label\s*(=|<>)\s*cell-(\d+)$/.exec(spec.predicate)
    if (spec.column === 'label' && onLabel !== null) {
      return onLabel[1] === '=' ? id === Number(onLabel[2]) : id !== Number(onLabel[2])
    }
    throw new Error(`fake provider cannot interpret predicate: ${spec.predicate}`)
  }
}

/** Flush microtasks queued by promise continuations (macrotask boundary). */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(() => resolve(), 0))
}

describe('GridViewportModel — load()', () => {
  it('fetches schema and row count, then reports loaded state and bumps the version', async () => {
    const provider = new FakeProvider({ rowCount: 42 })
    const model = new GridViewportModel(provider)
    const versions: number[] = []
    model.subscribe(() => versions.push(model.getVersion()))

    expect(model.loaded).toBe(false)
    expect(model.schema).toBeNull()
    expect(model.totalRows).toBeNull()
    await model.load()

    expect(model.loaded).toBe(true)
    expect(model.totalRows).toBe(42)
    expect(model.schema).toEqual([
      { name: 'id', type: 'BIGINT' },
      { name: 'label', type: 'VARCHAR' },
    ])
    expect(versions).toEqual([1])
  })

  it('observeViewport is a deliberate no-op before load() (no count to clamp against)', async () => {
    const provider = new FakeProvider()
    const model = new GridViewportModel(provider)
    model.observeViewport(0, 50)
    await flush()
    expect(provider.fetchLog).toEqual([])
    expect(model.stats.fetchCalls).toBe(0)
  })

  it('rejects and stays unloaded when the provider reports a bogus row count', async () => {
    const provider = new FakeProvider()
    provider.totalRowCount = -5
    const model = new GridViewportModel(provider)
    await expect(model.load()).rejects.toThrow('invalid row count')
    expect(model.loaded).toBe(false)
  })

  it('getRow reports loading before load and errors outside the dataset afterwards', async () => {
    const provider = new FakeProvider({ rowCount: 10 })
    const model = new GridViewportModel(provider)
    expect(model.getRow(0)).toEqual({ status: 'loading' })
    await model.load()

    expect(model.getRow(-1)).toEqual({
      status: 'error',
      message: expect.stringContaining('outside'),
    })
    expect(model.getRow(10)).toEqual({
      status: 'error',
      message: expect.stringContaining('outside'),
    })
    expect(model.getRow(0)).toEqual({ status: 'loading' })
  })

  it('handles a zero-row dataset without issuing any fetch', async () => {
    const provider = new FakeProvider({ rowCount: 0 })
    const model = new GridViewportModel(provider)
    await model.load()
    model.observeViewport(0, 30)
    await flush()
    expect(provider.fetchLog).toEqual([])
    expect(model.getRow(0)).toEqual({ status: 'error', message: 'the dataset has no rows' })
  })

  it('load() clears the cache and bumps the epoch — stale cells are never served (AR-D6)', async () => {
    const provider = new FakeProvider({ rowCount: 1000 })
    const model = new GridViewportModel(provider, { overscanRows: 0 })
    await model.load()
    model.observeViewport(0, 9)
    await flush()
    expect(model.getRow(0)).toEqual({ status: 'ready', row: [0, 'cell-0'] })
    expect(model.stats.rowsReceived).toBe(10)

    // The provider's data changes underneath (a reloaded dataset).
    provider.pageFor = (range) => ({
      startRow: range.startRow,
      rows: Array.from({ length: range.endRow - range.startRow }, (_, i) => [
        range.startRow + i,
        `fresh-${String(range.startRow + i)}`,
      ]),
    })
    await model.load()

    // Cache dropped synchronously by load(); the stale cells are not served.
    expect(model.getRow(0)).toEqual({ status: 'loading' })
    expect(model.stats.rowsReceived).toBe(0)
    model.observeViewport(0, 9)
    await flush()
    expect(model.getRow(0)).toEqual({ status: 'ready', row: [0, 'fresh-0'] })
  })
})

describe('GridViewportModel — window math and overscan', () => {
  it('expands the viewport by overscan and clamps to the dataset bounds', async () => {
    const provider = new FakeProvider({ rowCount: 1000 })
    const model = new GridViewportModel(provider, { overscanRows: 20 })
    await model.load()

    model.observeViewport(10, 19)
    await flush()
    expect(provider.fetchLog).toEqual([
      { startRow: 0, endRow: 40, startCol: 0, endCol: 2 }, // [max(0,10-20) .. min(999,19+20)] inclusive
    ])
  })

  it('clamps the window at the dataset end without fetching phantom rows', async () => {
    const provider = new FakeProvider({ rowCount: 1000 })
    const model = new GridViewportModel(provider, { overscanRows: 20 })
    await model.load()

    model.observeViewport(995, 999)
    await flush()
    expect(provider.fetchLog).toEqual([{ startRow: 975, endRow: 1000, startCol: 0, endCol: 2 }])
    expect(model.getRow(999)).toEqual({ status: 'ready', row: [999, 'cell-999'] })
  })

  it('serves rows with known cell values at any requested index', async () => {
    const provider = new FakeProvider({ rowCount: 1000 })
    const model = new GridViewportModel(provider)
    await model.load()
    model.observeViewport(100, 119)
    await flush()
    expect(model.getRow(117)).toEqual({ status: 'ready', row: [117, 'cell-117'] })
  })

  it('throws on inverted or non-integer viewport bounds (renderer bug, loudly)', async () => {
    const provider = new FakeProvider({ rowCount: 10 })
    const model = new GridViewportModel(provider)
    await model.load()
    expect(() => model.observeViewport(5, 4)).toThrow(RangeError)
    expect(() => model.observeViewport(1.5, 4)).toThrow(RangeError)
  })
})

describe('GridViewportModel — window cache and dedup', () => {
  it('dedups concurrent and repeated viewports into one fetch', async () => {
    const provider = new FakeProvider({ rowCount: 1000 })
    const model = new GridViewportModel(provider)
    await model.load()

    model.observeViewport(0, 29)
    model.observeViewport(0, 29) // same window, still in flight
    await flush()
    model.observeViewport(0, 29) // same window, now cached
    await flush()

    expect(provider.fetchLog).toEqual([{ startRow: 0, endRow: 50, startCol: 0, endCol: 2 }])
    expect(model.stats.fetchCalls).toBe(1)
  })

  it('fetches only the missing tail when a viewport overlaps cached rows', async () => {
    const provider = new FakeProvider({ rowCount: 1000 })
    const model = new GridViewportModel(provider)
    await model.load()

    model.observeViewport(0, 29)
    await flush()
    model.observeViewport(10, 39)
    await flush()

    expect(provider.fetchLog).toEqual([
      { startRow: 0, endRow: 50, startCol: 0, endCol: 2 }, // window [0..49]
      { startRow: 50, endRow: 60, startCol: 0, endCol: 2 }, // missing tail [50..59]
    ])
    expect(model.stats.rowsRequested).toBe(60)
    expect(model.stats.rowsReceived).toBe(60)
  })

  it('scrolling back within the (un-evicted) cache reuses rows without refetching', async () => {
    const provider = new FakeProvider({ rowCount: 1_000_000 })
    const model = new GridViewportModel(provider)
    await model.load()

    model.observeViewport(0, 29)
    await flush()
    model.observeViewport(200, 229)
    await flush()
    const statsAfterTour = model.stats
    expect(statsAfterTour.fetchCalls).toBe(2)

    model.observeViewport(0, 29) // revisit rows still cached
    await flush()
    expect(model.stats.fetchCalls).toBe(statsAfterTour.fetchCalls)
    expect(model.stats.rowsRequested).toBe(statsAfterTour.rowsRequested)
  })
})

describe('GridViewportModel — span chunking (never an unbounded range)', () => {
  it('splits wide windows into spans no longer than maxSpanRows', async () => {
    const provider = new FakeProvider({ rowCount: 1000 })
    const model = new GridViewportModel(provider, { overscanRows: 0, maxSpanRows: 4 })
    await model.load()

    model.observeViewport(0, 9)
    await flush()

    expect(provider.fetchLog).toEqual([
      { startRow: 0, endRow: 4, startCol: 0, endCol: 2 },
      { startRow: 4, endRow: 8, startCol: 0, endCol: 2 },
      { startRow: 8, endRow: 10, startCol: 0, endCol: 2 },
    ])
    expect(model.stats.maxSpanRows).toBe(4)
    expect(model.stats.rowsRequested).toBe(10)
    expect(model.stats.rowsReceived).toBe(10)
    expect(model.getRow(9)).toEqual({ status: 'ready', row: [9, 'cell-9'] })
  })
})

describe('GridViewportModel — loading semantics', () => {
  it('reports loading placeholders until a manually-released fetch lands', async () => {
    const provider = new FakeProvider({ rowCount: 1000, manual: true })
    const model = new GridViewportModel(provider)
    const versions: number[] = []
    model.subscribe(() => versions.push(model.getVersion()))

    await model.load()
    const versionAfterLoad = model.getVersion()
    model.observeViewport(0, 29)
    expect(model.getRow(5)).toEqual({ status: 'loading' })

    provider.releaseAll()
    await flush()
    expect(model.getRow(5)).toEqual({ status: 'ready', row: [5, 'cell-5'] })
    expect(model.getVersion()).toBeGreaterThan(versionAfterLoad) // renderer was notified
    expect(versions.length).toBeGreaterThanOrEqual(2)
  })

  it('stops notifying after unsubscribe', async () => {
    const provider = new FakeProvider({ rowCount: 10 })
    const model = new GridViewportModel(provider)
    let notifications = 0
    const unsubscribe = model.subscribe(() => {
      notifications += 1
    })
    await model.load()
    unsubscribe()
    model.observeViewport(0, 9)
    await flush()
    const afterUnsubscribe = notifications
    await model.refresh()
    expect(notifications).toBe(afterUnsubscribe)
  })
})

describe('GridViewportModel — error spans and retry', () => {
  it('surfaces the provider error for failed spans without poisoning cached rows', async () => {
    // Three spans ([30..39], [40..49], [50..59]); only the middle one fails.
    const provider = new FakeProvider({ rowCount: 1000, failStartRows: new Set([40]) })
    const model = new GridViewportModel(provider, { overscanRows: 0, maxSpanRows: 10 })
    await model.load()

    model.observeViewport(30, 59)
    await flush()

    expect(model.getRow(45)).toEqual({
      status: 'error',
      message: 'provider failure at row 40',
    })
    expect(model.stats.failedSpans).toBe(1)
    expect(model.getRow(35)).toEqual({ status: 'ready', row: [35, 'cell-35'] }) // earlier span healthy
    expect(model.getRow(55)).toEqual({ status: 'ready', row: [55, 'cell-55'] }) // later span healthy
  })

  it('retry() re-requests exactly the failed span once the provider recovers', async () => {
    const provider = new FakeProvider({ rowCount: 1000, failStartRows: new Set([40]) })
    const model = new GridViewportModel(provider, { overscanRows: 0, maxSpanRows: 10 })
    await model.load()
    model.observeViewport(30, 59)
    await flush()
    const callsBeforeRetry = provider.fetchLog.length

    provider.failStartRows = new Set()
    model.retry()
    await flush()

    expect(provider.fetchLog.length).toBe(callsBeforeRetry + 1)
    expect(provider.fetchLog.at(-1)).toEqual({ startRow: 40, endRow: 50, startCol: 0, endCol: 2 })
    expect(model.getRow(45)).toEqual({ status: 'ready', row: [45, 'cell-45'] })
    expect(model.stats.failedSpans).toBe(0)
  })

  it('re-requests only the failed span when the viewport is re-observed (cached neighbors stay), and recovers after the provider heals', async () => {
    // No infinite loop is possible: the renderer re-observes only when the
    // visible *range* changes (the effect is keyed on the range), never in
    // response to notifications — so a persistently failing span is retried
    // once per re-observe, not once per notify.
    const provider = new FakeProvider({ rowCount: 1000, failStartRows: new Set([40]) })
    const model = new GridViewportModel(provider, { overscanRows: 0, maxSpanRows: 10 })
    await model.load()
    model.observeViewport(30, 59)
    await flush()
    expect(model.stats.failedSpans).toBe(1)
    const callsWhileFailing = model.stats.fetchCalls

    model.observeViewport(30, 59) // re-observe: only the failed span is re-requested
    await flush()
    expect(model.stats.fetchCalls).toBe(callsWhileFailing + 1)
    expect(model.stats.failedSpans).toBe(1) // provider still failing

    provider.failStartRows = new Set()
    model.observeViewport(31, 60) // viewport change after healing
    await flush()
    expect(model.getRow(45)).toEqual({ status: 'ready', row: [45, 'cell-45'] })
    expect(model.getRow(60)).toEqual({ status: 'ready', row: [60, 'cell-60'] })
    expect(model.stats.failedSpans).toBe(0)
  })

  it('rejects pages with a wrong startRow or row count instead of misplacing rows', async () => {
    const provider = new FakeProvider({ rowCount: 1000 })
    provider.pageFor = () => ({ startRow: 999, rows: [] }) // lies about everything
    const model = new GridViewportModel(provider, { overscanRows: 0 })
    await model.load()
    model.observeViewport(0, 9)
    await flush()
    expect(model.getRow(0)).toEqual({
      status: 'error',
      message: expect.stringContaining('expected 0'),
    })
  })

  it('a short span is a fatal contract violation, never an unbounded retry (AR-D3)', async () => {
    const provider = new FakeProvider({ rowCount: 1000 })
    provider.pageFor = (range) => ({ startRow: range.startRow, rows: [[range.startRow, 'cell']] })
    const model = new GridViewportModel(provider, { overscanRows: 0, maxSpanRows: 10 })
    await model.load()
    model.observeViewport(0, 29)
    await flush()

    expect(model.stats.fatalError).toContain('short span')
    expect(model.getRow(0)).toEqual({
      status: 'error',
      message: expect.stringContaining('short span'),
    })
    // The violation never enters the retryable failed-spans path…
    expect(model.stats.failedSpans).toBe(0)
    // …and re-observing/retrying cannot loop on it.
    const callsAfterFailure = model.stats.fetchCalls
    model.retry()
    model.observeViewport(0, 29)
    await flush()
    expect(model.stats.fetchCalls).toBe(callsAfterFailure)

    // A refresh clears the fatal state and fetches normally again.
    provider.pageFor = (range) => ({
      startRow: range.startRow,
      rows: Array.from({ length: range.endRow - range.startRow }, (_, i) => [
        range.startRow + i,
        `cell-${String(range.startRow + i)}`,
      ]),
    })
    await model.refresh()
    expect(model.stats.fatalError).toBeNull()
    expect(model.getRow(0)).toEqual({ status: 'ready', row: [0, 'cell-0'] })
  })

  it('bounds failedSpans under a persistently failing provider, stats still report failures (AR-D4)', async () => {
    const provider = new FakeProvider({ rowCount: 1000, failAllSpans: true })
    const model = new GridViewportModel(provider, {
      overscanRows: 0,
      maxSpanRows: 1,
      maxFailedSpans: 3,
    })
    await model.load()
    model.observeViewport(0, 9)
    await flush()

    expect(model.stats.failedSpans).toBe(3) // capped, not 10
    expect(model.stats.failedSpans).toBeLessThanOrEqual(3)
    expect(model.stats.fatalError).toBeNull()
    // The most recent failures are still surfaced; evicted ones degrade to loading.
    expect(model.getRow(9)).toEqual({ status: 'error', message: 'provider failure at row 9' })
    expect(model.getRow(0)).toEqual({ status: 'loading' })
  })
})

describe('GridViewportModel — LRU eviction (bounded UI state)', () => {
  it('never caches more than maxCachedRows and keeps the live window', async () => {
    const provider = new FakeProvider({ rowCount: 1_000_000 })
    const model = new GridViewportModel(provider, { overscanRows: 0, maxCachedRows: 10 })
    await model.load()

    model.observeViewport(0, 9)
    await flush()
    expect(model.stats.cachedRows).toBe(10)

    model.observeViewport(100, 109)
    await flush()
    expect(model.stats.cachedRows).toBe(10)
    expect(model.getRow(105)).toEqual({ status: 'ready', row: [105, 'cell-105'] })
    expect(model.getRow(4)).toEqual({ status: 'loading' }) // evicted
  })

  it('refetches evicted rows when the viewport returns to them', async () => {
    const provider = new FakeProvider({ rowCount: 1_000_000 })
    const model = new GridViewportModel(provider, { overscanRows: 0, maxCachedRows: 10 })
    await model.load()
    model.observeViewport(0, 9)
    await flush()
    model.observeViewport(100, 109)
    await flush()
    const callsAfterEviction = model.stats.fetchCalls

    model.observeViewport(0, 9)
    await flush()
    expect(model.stats.fetchCalls).toBe(callsAfterEviction + 1)
    expect(model.getRow(0)).toEqual({ status: 'ready', row: [0, 'cell-0'] })
    expect(model.stats.cachedRows).toBeLessThanOrEqual(10)
  })
})

describe('GridViewportModel — refresh (new data epoch)', () => {
  it('clears cache and stats and refetches the current viewport', async () => {
    const provider = new FakeProvider({ rowCount: 1000 })
    const model = new GridViewportModel(provider, { overscanRows: 0 })
    await model.load()
    model.observeViewport(0, 9)
    await flush()
    expect(model.stats.fetchCalls).toBe(1)

    await model.refresh()

    expect(model.stats.fetchCalls).toBe(1) // reset with the epoch, then one new fetch
    expect(model.stats.cachedRows).toBe(10)
    expect(model.getRow(3)).toEqual({ status: 'ready', row: [3, 'cell-3'] })
    expect(provider.fetchLog).toEqual([
      { startRow: 0, endRow: 10, startCol: 0, endCol: 2 },
      { startRow: 0, endRow: 10, startCol: 0, endCol: 2 },
    ])
  })

  it('discards in-flight fetches from the previous epoch (stale ordering never lands)', async () => {
    const provider = new FakeProvider({ rowCount: 1000, manual: true })
    const model = new GridViewportModel(provider, { overscanRows: 0 })
    await model.load()
    model.observeViewport(0, 9) // epoch 0 fetch, held by the manual provider

    const refreshDone = model.refresh() // bumps generation, refetches the viewport
    await flush()
    expect(provider.fetchLog.length).toBe(2)

    // Both held fetches resolve real rows; the generation guard (each fetch
    // captured its epoch's generation) silently discards the stale epoch's
    // page on arrival, so only the fresh epoch's 10 rows are counted.
    provider.releaseAll()
    await flush()
    await refreshDone

    expect(model.getRow(0)).toEqual({ status: 'ready', row: [0, 'cell-0'] })
    expect(model.stats.rowsReceived).toBe(10) // only the fresh epoch counted
  })
})

describe('GridViewportModel — inflight markers are epoch-tagged (m4-3 carry-over)', () => {
  it("an old epoch's late completion must not delete a newer epoch's in-flight marker", async () => {
    const provider = new FakeProvider({ rowCount: 1000, manual: true })
    const model = new GridViewportModel(provider, { overscanRows: 0 })
    await model.load()

    // Epoch 0 fetch for span `0:9`, held. refresh() bumps the epoch, clears
    // the inflight map, and starts an epoch-1 fetch for the SAME span key.
    model.observeViewport(0, 9)
    const refreshDone = model.refresh()
    await flush()
    expect(provider.fetchLog.length).toBe(2)

    // Complete the OLD fetch while the NEW one is still in flight. Its
    // `finally` runs `inflight.delete('0:9')`; untagged, that deletes the
    // epoch-1 marker, so the re-observe below would issue a duplicate fetch.
    provider.releaseAt(0)
    await flush()

    model.observeViewport(0, 9)
    await flush()
    // The epoch-1 marker survived: no duplicate fetch was issued.
    expect(provider.fetchLog.length).toBe(2)

    // Releasing the epoch-1 fetch lands the fresh window; the stale page
    // never rendered (generation guard unchanged).
    provider.releaseAll()
    await flush()
    await refreshDone
    expect(model.getRow(0)).toEqual({ status: 'ready', row: [0, 'cell-0'] })
    expect(model.stats.rowsReceived).toBe(10)
  })

  it('keeps dedup honest across three rapid epoch shifts (no duplicate spans)', async () => {
    const provider = new FakeProvider({ rowCount: 1000, manual: true })
    const model = new GridViewportModel(provider, { overscanRows: 0 })
    await model.load()

    model.observeViewport(0, 9)
    const first = model.refresh()
    await flush()
    const second = model.refresh()
    await flush()
    expect(provider.fetchLog.length).toBe(3)

    // Complete the two older fetches; their markers must not remove the
    // newest epoch's marker for the same key.
    provider.releaseAt(0)
    await flush()
    provider.releaseAt(0)
    await flush()
    model.observeViewport(0, 9)
    await flush()
    expect(provider.fetchLog.length).toBe(3)

    provider.releaseAll()
    await flush()
    await Promise.all([first, second])
    expect(model.getRow(0)).toEqual({ status: 'ready', row: [0, 'cell-0'] })
  })
})

describe('GridViewportModel — opaque row-key channel (m4-3)', () => {
  it('carries page rowKeys onto ready slots and clears them with the cache', async () => {
    const provider = new FakeProvider({ rowCount: 1000, manual: true })
    provider.pageFor = (range) => ({
      startRow: range.startRow,
      rows: Array.from({ length: range.endRow - range.startRow }, (_, i) => [
        range.startRow + i,
        `cell-${String(range.startRow + i)}`,
      ]),
      rowKeys: Array.from(
        { length: range.endRow - range.startRow },
        (_, i) => `base:anchor#${String(range.startRow + i)}`,
      ),
    })
    const model = new GridViewportModel(provider, { overscanRows: 0 })
    await model.load()
    model.observeViewport(0, 4)
    provider.releaseAll()
    await flush()

    expect(model.getRow(2)).toEqual({
      status: 'ready',
      row: [2, 'cell-2'],
      key: 'base:anchor#2',
    })

    const refreshDone = model.refresh()
    await flush()
    // refresh clears the cache synchronously; while the refetch is held the
    // slot is a loading placeholder with no key from the previous epoch.
    expect(model.getRow(2)).toEqual({ status: 'loading' })

    provider.releaseAll()
    await flush()
    await refreshDone
    expect(model.getRow(2)).toEqual({
      status: 'ready',
      row: [2, 'cell-2'],
      key: 'base:anchor#2',
    })
  })

  it('rejects a page whose rowKeys length disagrees with its rows', async () => {
    const provider = new FakeProvider({ rowCount: 1000 })
    provider.pageFor = () => ({ startRow: 0, rows: [[0, 'cell-0']], rowKeys: ['a', 'b'] })
    const model = new GridViewportModel(provider, { overscanRows: 0 })
    await model.load()
    model.observeViewport(0, 0)
    await flush()
    expect(model.getRow(0)).toEqual({
      status: 'error',
      message: expect.stringContaining('row keys'),
    })
  })
})

describe('GridViewportModel — sort state (m2-1)', () => {
  it('setSort records explicit state, refetches the visible window, and changes contents', async () => {
    const provider = new FakeProvider({ rowCount: 1000 })
    const model = new GridViewportModel(provider, { overscanRows: 0 })
    await model.load()
    model.observeViewport(0, 9)
    await flush()
    expect(model.getRow(0)).toEqual({ status: 'ready', row: [0, 'cell-0'] })

    await model.setSort({ column: 'id', direction: 'desc' })
    await flush()

    expect(model.sort).toEqual({ column: 'id', direction: 'desc' })
    // The same visible window was refetched under the new ordering…
    expect(provider.fetchLog).toEqual([
      { startRow: 0, endRow: 10, startCol: 0, endCol: 2 },
      { startRow: 0, endRow: 10, startCol: 0, endCol: 2 },
    ])
    // …so the previously cached index 0 now serves the sorted-first row.
    expect(model.getRow(0)).toEqual({ status: 'ready', row: [999, 'cell-999'] })
    expect(provider.sortCalls).toEqual([{ column: 'id', direction: 'desc' }])
  })

  it('setSort(null) clears the sort and restores dataset order', async () => {
    const provider = new FakeProvider({ rowCount: 1000 })
    const model = new GridViewportModel(provider, { overscanRows: 0 })
    await model.load()
    model.observeViewport(0, 9)
    await flush()
    await model.setSort({ column: 'id', direction: 'desc' })
    await flush()
    expect(model.getRow(0)).toEqual({ status: 'ready', row: [999, 'cell-999'] })

    await model.setSort(null)
    await flush()

    expect(model.sort).toBeNull()
    expect(provider.sortCalls.at(-1)).toBeNull()
    expect(model.getRow(0)).toEqual({ status: 'ready', row: [0, 'cell-0'] })
  })

  it('sort state survives refresh() (refresh re-reads data under the held query state)', async () => {
    const provider = new FakeProvider({ rowCount: 1000 })
    const model = new GridViewportModel(provider, { overscanRows: 0 })
    await model.load()
    model.observeViewport(0, 9)
    await flush()
    await model.setSort({ column: 'id', direction: 'desc' })

    await model.refresh()

    expect(model.sort).toEqual({ column: 'id', direction: 'desc' })
    expect(model.totalRows).toBe(1000)
    expect(model.getRow(0)).toEqual({ status: 'ready', row: [999, 'cell-999'] })
  })

  it('setSort before load() builds the epoch (pinned: refresh() is the one rebuild path)', async () => {
    const provider = new FakeProvider({ rowCount: 1000 })
    const model = new GridViewportModel(provider)
    await model.setSort({ column: 'id', direction: 'desc' })

    expect(model.sort).toEqual({ column: 'id', direction: 'desc' })
    expect(model.loaded).toBe(true)
    model.observeViewport(0, 9)
    await flush()
    expect(model.getRow(0)).toEqual({ status: 'ready', row: [999, 'cell-999'] })
  })
})

describe('GridViewportModel — filter state (m2-1)', () => {
  it('setFilters filters windows, updates the exposed total, and pushes clear-then-specs', async () => {
    const provider = new FakeProvider({ rowCount: 1000 })
    const model = new GridViewportModel(provider, { overscanRows: 0 })
    await model.load()
    model.observeViewport(0, 9)
    await flush()
    expect(model.getRow(0)).toEqual({ status: 'ready', row: [0, 'cell-0'] }) // cached pre-filter

    await model.setFilters([{ column: 'id', predicate: 'id >= 995' }])
    await flush()

    expect(model.filters).toEqual([{ column: 'id', predicate: 'id >= 995' }])
    expect(provider.filterCalls).toEqual([null, { column: 'id', predicate: 'id >= 995' }])
    expect(model.totalRows).toBe(5) // provider re-reported the count under filters
    // The cached index 0 must not survive the epoch: the view's first row is 995.
    expect(model.getRow(0)).toEqual({ status: 'ready', row: [995, 'cell-995'] })
    expect(model.getRow(4)).toEqual({ status: 'ready', row: [999, 'cell-999'] })
    expect(model.getRow(5)).toEqual({
      status: 'error',
      message: expect.stringContaining('outside'),
    })
  })

  it('setFilters([]) clears every filter and restores the full count', async () => {
    const provider = new FakeProvider({ rowCount: 1000 })
    const model = new GridViewportModel(provider, { overscanRows: 0 })
    await model.load()
    model.observeViewport(0, 9)
    await flush()
    await model.setFilters([{ column: 'id', predicate: 'id >= 995' }])
    await flush()
    const callsBeforeClear = provider.filterCalls.length

    await model.setFilters([])
    await flush()

    expect(model.filters).toEqual([])
    expect(provider.filterCalls.length).toBe(callsBeforeClear + 1)
    expect(provider.filterCalls.at(-1)).toBeNull()
    expect(model.totalRows).toBe(1000)
    expect(model.getRow(0)).toEqual({ status: 'ready', row: [0, 'cell-0'] })
  })

  it('composes multiple filters (AND), routes predicates by column, and composes with sort', async () => {
    const provider = new FakeProvider({ rowCount: 1000 })
    const model = new GridViewportModel(provider, { overscanRows: 0 })
    await model.load()
    model.observeViewport(0, 9)
    await flush()

    await model.setFilters([
      { column: 'id', predicate: 'id >= 990' },
      { column: 'label', predicate: 'label <> cell-992' },
    ])
    await flush()

    expect(model.totalRows).toBe(9) // 990–999 minus 992
    expect(model.getRow(0)).toEqual({ status: 'ready', row: [990, 'cell-990'] })
    expect(model.getRow(2)).toEqual({ status: 'ready', row: [993, 'cell-993'] }) // 992 skipped

    await model.setSort({ column: 'id', direction: 'desc' })
    await flush()

    expect(model.totalRows).toBe(9)
    expect(model.getRow(0)).toEqual({ status: 'ready', row: [999, 'cell-999'] })
    expect(model.getRow(8)).toEqual({ status: 'ready', row: [990, 'cell-990'] })
  })

  it('filtering while scrolled deep clamps the refetch into the new bounds', async () => {
    const provider = new FakeProvider({ rowCount: 1000 })
    const model = new GridViewportModel(provider, { overscanRows: 0 })
    await model.load()
    model.observeViewport(990, 999)
    await flush()
    expect(model.getRow(999)).toEqual({ status: 'ready', row: [999, 'cell-999'] })

    await model.setFilters([{ column: 'id', predicate: 'id <= 4' }])
    await flush()

    expect(model.totalRows).toBe(5)
    // The stale deep viewport (990–999) clamps to the filtered bounds; the
    // refetch serves the surviving tail row and index 999 is simply outside.
    expect(model.getRow(4)).toEqual({ status: 'ready', row: [4, 'cell-4'] })
    expect(model.getRow(999)).toEqual({
      status: 'error',
      message: expect.stringContaining('outside'),
    })
  })
})

describe('GridViewportModel — stale-page guard across query epochs (m2-1)', () => {
  it('a sort issued while a fetch is in flight discards the late old-state page', async () => {
    const provider = new FakeProvider({ rowCount: 1000, manual: true })
    const model = new GridViewportModel(provider, { overscanRows: 0 })
    await model.load()
    model.observeViewport(0, 9) // epoch-0 fetch (unsorted ids 0..9), held

    const sortDone = model.setSort({ column: 'id', direction: 'desc' }) // new epoch, refetch held
    await flush()
    expect(provider.fetchLog.length).toBe(2)

    // Both held fetches now resolve. The epoch-0 page still carries the OLD
    // ordering (0..9, frozen at request time, like a real provider's page) —
    // the generation guard must never let it land.
    provider.releaseAll()
    await flush()
    await sortDone

    expect(model.getRow(0)).toEqual({ status: 'ready', row: [999, 'cell-999'] })
    expect(model.stats.rowsReceived).toBe(10) // only the fresh epoch's rows counted
  })

  it('a filter issued while a fetch is in flight discards the late unfiltered page', async () => {
    const provider = new FakeProvider({ rowCount: 1000, manual: true })
    const model = new GridViewportModel(provider, { overscanRows: 0 })
    await model.load()
    model.observeViewport(0, 9) // epoch-0 fetch (unfiltered ids 0..9), held

    const filterDone = model.setFilters([{ column: 'id', predicate: 'id >= 995' }])
    await flush()
    expect(provider.fetchLog.length).toBe(2)

    provider.releaseAll()
    await flush()
    await filterDone

    // The late unfiltered page (ids 0..9) is discarded; the fresh epoch
    // serves the filtered view and the count was re-read under it.
    expect(model.getRow(0)).toEqual({ status: 'ready', row: [995, 'cell-995'] })
    expect(model.totalRows).toBe(5)
    expect(model.stats.rowsReceived).toBe(5)
  })
})

describe('GridViewportModel — provider rejections leave state and cache untouched (m2-1)', () => {
  it('a rejected setSort changes neither model state nor cached rows nor epochs', async () => {
    const provider = new FakeProvider({ rowCount: 1000 })
    const model = new GridViewportModel(provider, { overscanRows: 0 })
    await model.load()
    model.observeViewport(0, 9)
    await flush()
    expect(model.getRow(0)).toEqual({ status: 'ready', row: [0, 'cell-0'] })
    const fetchesBefore = provider.fetchLog.length

    provider.rejectQueryPushes = true
    await expect(model.setSort({ column: 'id', direction: 'desc' })).rejects.toThrow(
      'sort rejected',
    )

    expect(model.sort).toBeNull()
    expect(provider.sortCalls).toEqual([])
    expect(provider.fetchLog.length).toBe(fetchesBefore) // no new epoch, no refetch
    expect(model.getRow(0)).toEqual({ status: 'ready', row: [0, 'cell-0'] }) // cache intact
  })

  it('a rejected setFilters keeps the previous filter state serving', async () => {
    const provider = new FakeProvider({ rowCount: 1000 })
    const model = new GridViewportModel(provider, { overscanRows: 0 })
    await model.load()
    model.observeViewport(0, 9)
    await flush()
    await model.setFilters([{ column: 'id', predicate: 'id >= 995' }])
    await flush()
    expect(model.totalRows).toBe(5)
    const fetchesBefore = provider.fetchLog.length

    provider.rejectQueryPushes = true
    await expect(model.setFilters([{ column: 'id', predicate: 'id <= 10' }])).rejects.toThrow(
      'filter rejected',
    )

    expect(model.filters).toEqual([{ column: 'id', predicate: 'id >= 995' }])
    expect(model.totalRows).toBe(5)
    expect(provider.fetchLog.length).toBe(fetchesBefore)
    expect(model.getRow(0)).toEqual({ status: 'ready', row: [995, 'cell-995'] })
  })
})

describe('GridViewportModel — sort/filter spec validation (m2-1)', () => {
  it('rejects malformed sort specs before touching the provider', async () => {
    const provider = new FakeProvider({ rowCount: 10 })
    const model = new GridViewportModel(provider)
    await model.load()
    await expect(model.setSort({ column: '', direction: 'asc' })).rejects.toThrow(TypeError)
    await expect(
      model.setSort({ column: 'id', direction: 'up' } as unknown as SortSpec),
    ).rejects.toThrow(TypeError)
    expect(provider.sortCalls).toEqual([])
  })

  it('rejects malformed filter lists before touching the provider', async () => {
    const provider = new FakeProvider({ rowCount: 10 })
    const model = new GridViewportModel(provider)
    await model.load()
    await expect(model.setFilters(undefined as unknown as FilterSpec[])).rejects.toThrow(TypeError)
    await expect(model.setFilters([{ column: '', predicate: 'id >= 1' }])).rejects.toThrow(
      TypeError,
    )
    await expect(
      model.setFilters([{ column: 'id', predicate: 5 as unknown as string }]),
    ).rejects.toThrow(TypeError)
    expect(provider.filterCalls).toEqual([])
  })
})

describe('GridViewportModel — construction validation', () => {
  const provider = new FakeProvider()

  it('rejects a negative overscan', () => {
    expect(() => new GridViewportModel(provider, { overscanRows: -1 })).toThrow(RangeError)
  })
  it('rejects a zero or negative cache bound', () => {
    expect(() => new GridViewportModel(provider, { maxCachedRows: 0 })).toThrow(RangeError)
  })
  it('rejects a zero or negative span cap', () => {
    expect(() => new GridViewportModel(provider, { maxSpanRows: 0 })).toThrow(RangeError)
  })
  it('rejects a zero or negative failed-span bound', () => {
    expect(() => new GridViewportModel(provider, { maxFailedSpans: 0 })).toThrow(RangeError)
  })
})

describe('GridViewportModel — overlapping query-state mutations (AR-D5)', () => {
  it('setSort: the last requested state wins even when the older provider push resolves last', async () => {
    const provider = new FakeProvider({ rowCount: 1000 })
    provider.holdQueryPushes = true
    const model = new GridViewportModel(provider, { overscanRows: 0 })
    await model.load()
    model.observeViewport(0, 9)
    await flush()

    const asc: SortSpec = { column: 'id', direction: 'asc' }
    const desc: SortSpec = { column: 'id', direction: 'desc' }
    const first = model.setSort(asc)
    await flush()
    // The first call's provider push is in flight; request the second.
    provider.holdQueryPushes = false
    const second = model.setSort(desc)
    await flush()
    // Release the OLDER push last: the superseded call must not clobber desc.
    provider.releaseQueryPush(0)
    await Promise.all([first, second])
    await flush()

    expect(model.sort).toEqual(desc)
    expect(provider.sortCalls.at(-1)).toEqual(desc) // the provider serves what the model exposes
    expect(model.getRow(0)).toEqual({ status: 'ready', row: [999, 'cell-999'] })
  })

  it('setFilters: the last requested list wins and the provider serves it', async () => {
    const provider = new FakeProvider({ rowCount: 1000 })
    provider.holdQueryPushes = true
    const model = new GridViewportModel(provider, { overscanRows: 0 })
    await model.load()
    model.observeViewport(0, 9)
    await flush()

    const firstList: FilterSpec[] = [{ column: 'id', predicate: 'id >= 995' }]
    const secondList: FilterSpec[] = [{ column: 'id', predicate: 'id <= 4' }]
    const first = model.setFilters(firstList)
    await flush()
    provider.holdQueryPushes = false
    const second = model.setFilters(secondList)
    await flush()
    provider.releaseQueryPush(0) // release the older call's `filter(null)` push
    await Promise.all([first, second])
    await flush()

    expect(model.filters).toEqual(secondList)
    expect(provider.filterCalls.at(-1)).toEqual(secondList[0])
    expect(model.totalRows).toBe(5)
    expect(model.getRow(0)).toEqual({ status: 'ready', row: [0, 'cell-0'] })
  })
})
