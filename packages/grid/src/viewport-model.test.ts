import { describe, expect, it } from 'vitest'
import type { CellRange, ColumnSchema, GridDataPage, GridDataProvider } from './contracts'
import { GridViewportModel } from './viewport-model'

/**
 * In-memory fake provider: deterministic rows (`[i, "cell-${i}"]`), an
 * optional failure set, and a manual mode that holds fetches until released —
 * so loading/error/dedup semantics are observable in Node without timers.
 */
class FakeProvider implements GridDataProvider {
  totalRowCount: number
  readonly fetchLog: CellRange[] = []
  failStartRows: ReadonlySet<number>
  private readonly manual: boolean
  private pending: Array<{
    range: CellRange
    resolve: (page: GridDataPage) => void
    reject: (error: Error) => void
  }> = []

  constructor(
    options: {
      rowCount?: number
      manual?: boolean
      failStartRows?: ReadonlySet<number>
    } = {},
  ) {
    this.totalRowCount = options.rowCount ?? 1000
    this.manual = options.manual ?? false
    this.failStartRows = options.failStartRows ?? new Set()
  }

  async rowCount(): Promise<number> {
    return this.totalRowCount
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
      return new Promise<GridDataPage>((resolve, reject) => {
        this.pending.push({ range, resolve, reject })
      })
    }
    if (this.failStartRows.has(range.startRow)) {
      throw new Error(`provider failure at row ${String(range.startRow)}`)
    }
    return this.pageFor(range)
  }

  // Contract stubs: the viewport model never issues these (wiring is a later
  // task); they exist to satisfy the interface and future-proof the fake.
  async sort(): Promise<void> {}
  async filter(): Promise<void> {}
  async updateCell(): Promise<void> {}

  /** Resolve (or fail) every held fetch. */
  releaseAll(): void {
    const held = this.pending
    this.pending = []
    for (const entry of held) {
      if (this.failStartRows.has(entry.range.startRow)) {
        entry.reject(new Error(`provider failure at row ${String(entry.range.startRow)}`))
      } else {
        entry.resolve(this.pageFor(entry.range))
      }
    }
  }

  pageFor(range: CellRange): GridDataPage {
    const rows: unknown[][] = []
    for (let index = range.startRow; index < range.endRow; index++) {
      rows.push([index, `cell-${String(index)}`])
    }
    return { startRow: range.startRow, rows }
  }
}

/** Flush microtasks queued by promise continuations (macrotask boundary). */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
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
})
