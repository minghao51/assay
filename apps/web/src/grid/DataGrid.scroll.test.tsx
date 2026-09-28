// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GridViewportModel } from '@assay/grid'
import { DataGrid } from './DataGrid'

/**
 * AR-W2 pin: a jump-to-row request is an immediate gesture consumed exactly
 * once. Before the fix the effect re-ran on every `totalRows` change and the
 * request was never marked consumed, so a later filter/insert/delete
 * re-scrolled the grid to the old index (contradicting the prop contract).
 *
 * The virtualizer is faked (no layout in happy-dom) so `scrollToIndex` calls
 * are directly observable; the fake is a NEW object each render, so the
 * effect would re-run every render without the consumed guard.
 */

const h = vi.hoisted(() => ({ scrollToIndex: vi.fn() }))

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    getVirtualItems: () => [],
    getTotalSize: () => 0,
    scrollToIndex: h.scrollToIndex,
  }),
}))

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

afterEach(() => {
  cleanup()
  h.scrollToIndex.mockReset()
})

describe('DataGrid scrollRequest consumption (AR-W2)', () => {
  it('consumes a request once; a totalRows change never re-fires it', () => {
    const { rerender } = render(
      <DataGrid
        model={fakeModel(5)}
        onNestedAction={() => {}}
        scrollRequest={{ rowIndex: 2, seq: 1 }}
      />,
    )
    expect(h.scrollToIndex).toHaveBeenCalledTimes(1)
    expect(h.scrollToIndex).toHaveBeenCalledWith(2, { align: 'start' })

    // A filter/insert/delete changes totalRows with the SAME request seq.
    rerender(
      <DataGrid
        model={fakeModel(9)}
        onNestedAction={() => {}}
        scrollRequest={{ rowIndex: 2, seq: 1 }}
      />,
    )
    expect(h.scrollToIndex).toHaveBeenCalledTimes(1)

    // A genuinely new gesture (new seq) is still consumed.
    rerender(
      <DataGrid
        model={fakeModel(9)}
        onNestedAction={() => {}}
        scrollRequest={{ rowIndex: 4, seq: 2 }}
      />,
    )
    expect(h.scrollToIndex).toHaveBeenCalledTimes(2)
    expect(h.scrollToIndex).toHaveBeenLastCalledWith(4, { align: 'start' })
  })

  it('does not consume an out-of-range request before the row count allows it', () => {
    const { rerender } = render(
      <DataGrid
        model={fakeModel(0)}
        onNestedAction={() => {}}
        scrollRequest={{ rowIndex: 2, seq: 1 }}
      />,
    )
    expect(h.scrollToIndex).not.toHaveBeenCalled()

    rerender(
      <DataGrid
        model={fakeModel(5)}
        onNestedAction={() => {}}
        scrollRequest={{ rowIndex: 2, seq: 1 }}
      />,
    )
    expect(h.scrollToIndex).toHaveBeenCalledTimes(1)
  })
})
