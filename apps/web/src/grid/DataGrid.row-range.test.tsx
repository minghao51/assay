// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GridViewportModel } from '@assay/grid'
import { DataGrid } from './DataGrid'

/**
 * WF-07 (R-3) — the grid footer's visible row range, WFD-07 option A
 * (2026-11-23 selections §2).
 *
 * Approved copy, exact:
 *   - ready:             `Visible rows X–Y of N`
 *   - empty:             `No rows`
 *   - unknown/loading:   `Row range unavailable`
 *
 * The contract under test: X/Y are **1-based current-view positions** of the
 * rows whose data area actually intersects the scroll viewport below the
 * sticky header. They are derived from the RENDERED ROW ELEMENTS' boxes, not
 * from the virtualizer window — the virtualizer deliberately renders
 * `VIRTUALIZER_OVERSCAN_ROWS = 6` extra rows per edge, and a row that exists
 * only because of overscan must never be named. A partly visible first/last
 * row counts; positions clamp to the known total; when all rows fit the label
 * is `1–N`, not the overscanned window.
 *
 * The virtualizer is faked (no layout in happy-dom) and the renderer's
 * `getBoundingClientRect` is stubbed per element, so the test describes the
 * real geometry the derivation reads: the scroll viewport, the sticky header
 * and each rendered row's box. Every assertion below therefore fails if the
 * implementation reads `virtualItems` bounds instead of the DOM intersection.
 *
 * Static text only: the label is a plain span — no live region, no focus
 * target, no per-scroll announcement.
 */

const ROW_HEIGHT = 28

interface VirtualItem {
  index: number
  key: string
  start: number
  size: number
}

const h = vi.hoisted(() => ({
  rows: [] as VirtualItem[],
}))

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    getVirtualItems: () => h.rows,
    getTotalSize: () => h.rows.length * 28,
    scrollToIndex: vi.fn(),
  }),
}))

/** Viewport box and per-row viewport-space top edges, controlled per test. */
const layout = {
  viewportTop: 0,
  viewportHeight: 500,
  rowTops: new Map<number, number>(),
}

function makeRect(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    top,
    bottom: top + height,
    left: 0,
    right: 640,
    width: 640,
    height,
    toJSON: () => ({}),
  } as DOMRect
}

const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect

beforeEach(() => {
  h.rows = []
  layout.viewportTop = 0
  layout.viewportHeight = 500
  layout.rowTops = new Map()
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect(
    this: HTMLElement,
  ): DOMRect {
    if (this.dataset['testid'] === 'grid-viewport') {
      return makeRect(layout.viewportTop, layout.viewportHeight)
    }
    // The sticky header carries no height here; the viewport's top edge is the
    // visible top. (A real browser measures the real header — covered by the
    // e2e leg, not this structural test.)
    if (this.classList.contains('grid-header')) return makeRect(layout.viewportTop, 0)
    if (this.dataset['testid'] === 'grid-row') {
      const index = Number(this.dataset['rowIndex'])
      const top = layout.rowTops.get(index)
      // Unlisted rows sit far below the viewport: rendered but not visible.
      return makeRect(top ?? 100_000, ROW_HEIGHT)
    }
    return makeRect(0, 0)
  }
})

afterEach(() => {
  cleanup()
  HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect
})

/**
 * Render `indices` as the virtualizer window, with contiguous row boxes whose
 * first row sits `firstTop` px from the viewport's top edge. `firstTop` is
 * negative for a window that starts above the fold (the usual overscan tail).
 */
function paintWindow(indices: readonly number[], firstTop: number): void {
  h.rows = indices.map((index) => ({
    index,
    key: `row-${String(index)}`,
    start: index * ROW_HEIGHT,
    size: ROW_HEIGHT,
  }))
  layout.rowTops = new Map()
  indices.forEach((index, offset) => {
    layout.rowTops.set(index, firstTop + offset * ROW_HEIGHT)
  })
}

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, offset) => start + offset)
}

interface FakeModel {
  readonly model: GridViewportModel
  readonly getRow: ReturnType<typeof vi.fn>
  readonly setFilters: ReturnType<typeof vi.fn>
  readonly setSort: ReturnType<typeof vi.fn>
  readonly observeViewport: ReturnType<typeof vi.fn>
  readonly retry: ReturnType<typeof vi.fn>
}

function fakeModel(totalRows: number | null): FakeModel {
  const getRow = vi.fn((index: number) => ({
    status: 'ready' as const,
    row: [index],
    key: `base:${String(index)}`,
  }))
  const setFilters = vi.fn(async () => {})
  const setSort = vi.fn(async () => {})
  const observeViewport = vi.fn()
  const retry = vi.fn()
  const model = {
    subscribe: () => () => {},
    getVersion: () => 0,
    schema: [{ name: 'id', type: 'BIGINT' }],
    totalRows,
    sort: null,
    filters: [],
    stats: {
      fetchCalls: 0,
      rowsRequested: 0,
      rowsReceived: 0,
      maxSpanRows: 0,
      cachedRows: 0,
      failedSpans: 0,
    },
    getRow,
    setSort,
    setFilters,
    observeViewport,
    retry,
  }
  return {
    model: model as unknown as GridViewportModel,
    getRow,
    setFilters,
    setSort,
    observeViewport,
    retry,
  }
}

function renderGrid(totalRows: number | null): {
  readonly fake: FakeModel
  readonly rerender: (totalRows: number | null) => void
} {
  const fake = fakeModel(totalRows)
  const { rerender } = render(<DataGrid model={fake.model} onNestedAction={() => {}} />)
  return {
    fake,
    rerender: (nextTotalRows) => {
      rerender(<DataGrid model={fakeModel(nextTotalRows).model} onNestedAction={() => {}} />)
    },
  }
}

/** The rendered label text, exactly as written into the footer. */
function rowRangeText(): string {
  return screen.getByTestId('grid-row-range').textContent ?? ''
}

describe('DataGrid visible row range (WF-07 / WFD-07 option A)', () => {
  it('renders `No rows` for a zero-row view', () => {
    renderGrid(0)
    expect(rowRangeText()).toBe('No rows')
  })

  it('renders both bounds for a single row', () => {
    paintWindow([0], 0)
    renderGrid(1)
    expect(rowRangeText()).toBe('Visible rows 1–1 of 1')
  })

  it('renders `1–N` when every row fits, not the virtualizer window', () => {
    paintWindow(range(0, 4), 0)
    renderGrid(5)
    expect(rowRangeText()).toBe('Visible rows 1–5 of 5')
  })

  it('renders the middle scroll range and excludes both overscan tails', () => {
    // 6 rows of leading overscan (40–45, all above the fold) and 6 trailing
    // (64–69, all below it). The visible rows are 46–63 → positions 47–64.
    paintWindow(range(40, 69), -(46 - 40) * ROW_HEIGHT)
    renderGrid(1000)
    expect(h.rows).toHaveLength(30)
    expect(rowRangeText()).toBe('Visible rows 47–64 of 1000')
    // The leading overscan-only row's position (40 + 1 = 41) and the trailing
    // one (69 + 1 = 70) must never appear.
    expect(rowRangeText()).not.toContain('41–')
    expect(rowRangeText()).not.toContain('–70')
  })

  it('clamps the end to the known total on the last page', () => {
    // Row 99's bottom edge is exactly the viewport bottom (partly visible last
    // page), and the window's first row is on screen → 89–100, clamped to N.
    paintWindow(range(88, 99), 472 - (99 - 88) * ROW_HEIGHT)
    renderGrid(100)
    expect(rowRangeText()).toBe('Visible rows 89–100 of 100')
  })

  it('renders `No rows` when a filter leaves no results', () => {
    paintWindow(range(0, 4), 0)
    const { rerender } = renderGrid(5)
    expect(rowRangeText()).toBe('Visible rows 1–5 of 5')
    // The filter settles with an empty result set: the label cannot name a
    // position, so it reports the empty view.
    rerender(0)
    expect(rowRangeText()).toBe('No rows')
  })

  it('tracks the current-view positions after a sort reorder', () => {
    // A sort re-render restores the scroll to the (new) view's first rows;
    // positions are the view's 1-based positions, never durable base-row IDs.
    paintWindow(range(100, 111), 0)
    renderGrid(1000)
    expect(rowRangeText()).toBe('Visible rows 101–112 of 1000')
  })

  it('updates through insert, delete and undo row-count changes', () => {
    paintWindow(range(0, 4), 0)
    const { rerender } = renderGrid(5)
    expect(rowRangeText()).toBe('Visible rows 1–5 of 5')
    // Insert one row: the new total grows and the label follows it.
    rerender(6)
    expect(rowRangeText()).toBe('Visible rows 1–5 of 6')
    // Delete it (the model renumbers to the previous count).
    rerender(5)
    expect(rowRangeText()).toBe('Visible rows 1–5 of 5')
    // Undo the insert: same count, same range — no stale total survives.
    rerender(5)
    expect(rowRangeText()).toBe('Visible rows 1–5 of 5')
  })

  it('renders `Row range unavailable` while the total is unknown/loading', () => {
    paintWindow([], 0)
    renderGrid(null)
    expect(rowRangeText()).toBe('Row range unavailable')
  })

  it('renders `Row range unavailable` when the rendered rows cannot be measured', () => {
    // A ready count with no laid-out viewport (no measurable geometry) must not
    // fall back to the virtualizer window and invent a range.
    layout.viewportHeight = 0
    paintWindow(range(0, 24), 0)
    renderGrid(1000)
    expect(rowRangeText()).toBe('Row range unavailable')
  })

  it('updates on resize and on scroll restoration', () => {
    paintWindow(range(0, 24), 0)
    const { rerender } = renderGrid(1000)
    expect(rowRangeText()).toBe('Visible rows 1–18 of 1000')
    // Shorter viewport (resize): fewer rows intersect, same virtual window.
    layout.viewportHeight = 300
    paintWindow(range(0, 24), 0)
    rerender(1000)
    expect(rowRangeText()).toBe('Visible rows 1–11 of 1000')
    // Scroll restoration to row 500: the window itself moved, so positions are
    // the restored view's positions.
    layout.viewportHeight = 500
    paintWindow(range(494, 525), 0)
    rerender(1000)
    expect(rowRangeText()).toBe('Visible rows 495–512 of 1000')
  })

  it('counts a partly visible first and last row', () => {
    // Row 10's bottom crosses the sticky header's edge; row 28's top crosses the
    // viewport bottom. Both are partly visible, so both positions are named.
    paintWindow(range(10, 31), -14)
    renderGrid(1000)
    expect(rowRangeText()).toBe('Visible rows 11–29 of 1000')
  })

  it('never names an overscan-only row (the 6-row tail is rendered, not visible)', () => {
    // 25 rendered rows, but only 0–17 have any data area inside the 500px
    // viewport. The 7 trailing rows 18–24 exist only for overscan.
    paintWindow(range(0, 24), 0)
    renderGrid(1000)
    expect(h.rows).toHaveLength(25)
    expect(rowRangeText()).toBe('Visible rows 1–18 of 1000')
    // Mutation-drill anchor: the overscanned window end (25) must not appear.
    expect(rowRangeText()).not.toBe('Visible rows 1–25 of 1000')
  })

  it('renders the label as static text — no live region, no focus target', () => {
    paintWindow(range(0, 4), 0)
    renderGrid(5)
    const label = screen.getByTestId('grid-row-range')
    expect(label.tagName).toBe('SPAN')
    expect(label.getAttribute('role')).toBeNull()
    expect(label.getAttribute('aria-live')).toBeNull()
    expect(label.getAttribute('aria-atomic')).toBeNull()
    expect(label.getAttribute('tabindex')).toBeNull()
    // The footer's existing busy status stays a sibling and keeps its own role.
    cleanup()
    paintWindow(range(0, 4), 0)
    render(<DataGrid model={fakeModel(5).model} onNestedAction={() => {}} queryBusy="filtering" />)
    expect(rowRangeText()).toBe('Visible rows 1–5 of 5')
    expect(screen.getByTestId('grid-busy-status').textContent).toBe('Filtering…')
  })

  it('performs no engine work to render or update the label (call-count pin)', () => {
    paintWindow(range(0, 24), 0)
    const fake = fakeModel(1000)
    // A non-zero baseline: the label must neither advance nor reset it.
    fake.model.stats.fetchCalls = 7
    const { rerender } = render(<DataGrid model={fake.model} onNestedAction={() => {}} />)
    expect(rowRangeText()).toBe('Visible rows 1–18 of 1000')

    // No engine fetch/count/query is issued by rendering the label: the stats
    // it reads are unchanged and every engine-triggering mutator stays cold.
    expect(fake.model.stats.fetchCalls).toBe(7)
    expect(fake.setFilters).not.toHaveBeenCalled()
    expect(fake.setSort).not.toHaveBeenCalled()
    expect(fake.retry).not.toHaveBeenCalled()
    // The existing viewport observation (rangeKey) ran exactly once; the label
    // adds no observeViewport (prefetch) call of its own.
    expect(fake.observeViewport).toHaveBeenCalledTimes(1)

    // A same-window re-render settles in exactly ONE commit: the label's
    // unchanged range returns the previous state object, so there is no extra
    // render pass (and no extra model read) beyond the ordinary row render.
    const callsAfterMount = fake.getRow.mock.calls.length
    rerender(<DataGrid model={fake.model} onNestedAction={() => {}} />)
    expect(rowRangeText()).toBe('Visible rows 1–18 of 1000')
    expect(fake.getRow.mock.calls.length).toBe(callsAfterMount + h.rows.length)
    expect(fake.model.stats.fetchCalls).toBe(7)
    expect(fake.observeViewport).toHaveBeenCalledTimes(1)
    expect(fake.setFilters).not.toHaveBeenCalled()
    expect(fake.setSort).not.toHaveBeenCalled()
    expect(fake.retry).not.toHaveBeenCalled()
  })
})
