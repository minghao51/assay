// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GridViewportModel } from '@assay/grid'
import { DataGrid } from './DataGrid'

/**
 * ug-12 (UG-26) — the focus half of a jump-to-row request.
 *
 * After the existing rAF scroll, an interactive grid lands DOM focus and the
 * single roving tab stop (`tabIndex=0`) on the requested row, so the panel
 * button that fired the jump cannot keep focus. A row the virtualizer has not
 * rendered — or a read-only, non-interactive grid whose rows are not focusable
 * — is a silent no-op, never a throw.
 *
 * The virtualizer is faked (no layout in happy-dom scrolled geometry), and its
 * rendered window is mutable so each test picks exactly which rows exist.
 */

interface VirtualItem {
  index: number
  key: string
  start: number
  size: number
}

const h = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
  rows: [] as VirtualItem[],
}))

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    getVirtualItems: () => h.rows,
    getTotalSize: () => h.rows.length * 28,
    scrollToIndex: h.scrollToIndex,
  }),
}))

function setRenderedRows(indices: readonly number[]): void {
  h.rows = indices.map((index) => ({
    index,
    key: `row-${String(index)}`,
    start: index * 28,
    size: 28,
  }))
}

function fakeModel(totalRows: number): GridViewportModel {
  return {
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
    getRow: () => ({ status: 'loading' }),
    setSort: async () => {},
    setFilters: async () => {},
    observeViewport: () => {},
    retry: () => {},
  } as unknown as GridViewportModel
}

function rowEl(index: number): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    `[data-testid="grid-row"][data-row-index="${String(index)}"]`,
  )
  if (element === null) throw new Error(`row ${String(index)} not rendered`)
  return element
}

afterEach(() => {
  cleanup()
  h.scrollToIndex.mockReset()
  h.rows = []
})

describe('DataGrid jump-to-row focus (ug-12)', () => {
  it('lands DOM focus and the single roving tab stop on the requested row', async () => {
    setRenderedRows([0, 1, 2])
    render(
      <DataGrid
        model={fakeModel(3)}
        onNestedAction={() => {}}
        onOpenRecord={() => {}}
        scrollRequest={{ rowIndex: 2, seq: 1 }}
      />,
    )

    // The scroll still happens first (align start, deterministic).
    expect(h.scrollToIndex).toHaveBeenCalledWith(2, { align: 'start' })

    // One rAF later the row is focused and owns the only tab stop.
    await waitFor(() => {
      expect(document.activeElement).toBe(rowEl(2))
    })
    expect(rowEl(2).tabIndex).toBe(0)
    expect(document.querySelectorAll('[data-testid="grid-row"][tabindex="0"]')).toHaveLength(1)
  })

  it('does not throw when the virtualizer has not rendered the target row', async () => {
    // No rendered rows at all: the rAF lookup finds nothing. Focus stays
    // wherever it was; the jump must not throw and must not steal focus.
    setRenderedRows([])
    render(
      <DataGrid
        model={fakeModel(3)}
        onNestedAction={() => {}}
        onOpenRecord={() => {}}
        scrollRequest={{ rowIndex: 2, seq: 1 }}
      />,
    )

    expect(h.scrollToIndex).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(document.querySelector('[data-testid="grid-row"]')).toBeNull()
    })
    expect(document.activeElement).toBe(document.body)
  })

  it('leaves a non-interactive (read-only) grid untouched and does not throw', async () => {
    setRenderedRows([2])
    render(
      <DataGrid
        model={fakeModel(3)}
        onNestedAction={() => {}}
        scrollRequest={{ rowIndex: 2, seq: 1 }}
      />,
    )

    // Read-only rows are not tab stops (`tabIndex` absent) and are never
    // focused; the requested row remains a render-only surface.
    await waitFor(() => {
      expect(rowEl(2).getAttribute('tabindex')).toBeNull()
    })
    expect(document.activeElement).toBe(document.body)
  })
})
