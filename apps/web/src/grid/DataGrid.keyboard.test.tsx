// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GridViewportModel } from '@assay/grid'
import type { OverlayState } from '@assay/domain'
import { DataGrid } from './DataGrid'

/**
 * S5 (au3-8) pins: the WAI-ARIA grid keyboard pattern over the virtualized
 * DOM grid.
 *
 * The grid uses a **roving tabindex on rows**: exactly one row carries
 * `tabIndex=0` (the remembered row, else the first rendered row) and every
 * other row carries `-1`; cells are always `tabIndex=-1`. Tab/Shift+Tab move
 * the browser's tab stop in/out of the grid at that row, ArrowUp/ArrowDown
 * move row focus, ArrowLeft/ArrowRight move cell focus within the focused
 * row, and Home/End jump to the row's first/last cell (Ctrl/Meta+Home/End
 * reach the grid corners). While an inline editor is open its own keys win —
 * arrows must never steal focus — and the existing Enter/Escape edit
 * semantics are untouched.
 *
 * The virtualizer is faked (no layout in happy-dom) so the rendered window is
 * deterministic and `scrollToIndex` calls are observable. The fake returns the
 * SAME array reference each render (like the real hook's stable window), so a
 * rerender does not spuriously re-run the focus effect.
 */

interface VirtualItem {
  index: number
  key: string
  start: number
  size: number
}

const h = vi.hoisted(() => ({
  rows: [] as VirtualItem[],
  scrollToIndex: vi.fn(),
}))

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    getVirtualItems: () => h.rows,
    getTotalSize: () => h.rows.length * 28,
    scrollToIndex: h.scrollToIndex,
  }),
}))

const SCHEMA: readonly { name: string; type: string }[] = [
  { name: 'id', type: 'BIGINT' },
  { name: 'name', type: 'VARCHAR' },
  { name: 'score', type: 'BIGINT' },
]

/** Single boolean column: exercises the `<select>` editor + NULL button. */
const BOOLEAN_SCHEMA: readonly { name: string; type: string }[] = [
  { name: 'flag', type: 'BOOLEAN' },
]

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
    schema: SCHEMA,
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
      fatalError: null,
    },
    getRow: (index: number) =>
      index >= 0 && index < totalRows
        ? {
            status: 'ready',
            row: [index, `name-${String(index)}`, index * 10],
            key: `base:${String(index)}`,
          }
        : { status: 'loading' },
    setSort: async () => {},
    setFilters: async () => {},
    observeViewport: () => {},
    retry: () => {},
  } as unknown as GridViewportModel
}

function fakeBooleanModel(totalRows: number): GridViewportModel {
  return {
    subscribe: () => () => {},
    getVersion: () => 0,
    schema: BOOLEAN_SCHEMA,
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
      fatalError: null,
    },
    getRow: (index: number) =>
      index >= 0 && index < totalRows
        ? {
            status: 'ready',
            row: [index % 2 === 0],
            key: `base:${String(index)}`,
          }
        : { status: 'loading' },
    setSort: async () => {},
    setFilters: async () => {},
    observeViewport: () => {},
    retry: () => {},
  } as unknown as GridViewportModel
}

function fakeOverlay(): OverlayState {
  return {
    anchors: { baseAnchor: 'b', overlayAnchor: 'o' },
    columns: [],
    edits: new Map(),
    inserts: new Map(),
    deletedBase: new Set(),
    nextInsertSeq: 0,
  } as unknown as OverlayState
}

function rowEl(index: number): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    `[data-testid="grid-row"][data-row-index="${String(index)}"]`,
  )
  if (element === null) throw new Error(`row ${String(index)} not rendered`)
  return element
}

function cellEl(rowIndex: number, columnIndex: number): HTMLElement {
  const cells = rowEl(rowIndex).querySelectorAll<HTMLElement>('[data-testid="grid-cell"]')
  const element = cells[columnIndex]
  if (element === undefined)
    throw new Error(`cell ${String(rowIndex)}:${String(columnIndex)} missing`)
  return element
}

/** Every row carrying the grid's single roving tab stop (`tabindex="0"`). */
function tabStopRows(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="grid-row"][tabindex="0"]'),
  )
}

/** Dispatch a keydown on whatever currently has focus (bubbles to the row). */
function press(key: string, options: Record<string, unknown> = {}): void {
  const target = document.activeElement
  if (target === null) throw new Error('nothing is focused')
  fireEvent.keyDown(target, { key, ...options })
}

function focusElement(element: HTMLElement): void {
  act(() => {
    element.focus()
  })
}

beforeEach(() => {
  setRenderedRows([0, 1, 2, 3, 4])
  h.scrollToIndex.mockReset()
})

afterEach(cleanup)

describe('DataGrid roving tabindex (S5)', () => {
  it('keeps exactly one row as the tab stop, moving it with focus', () => {
    render(<DataGrid model={fakeModel(5)} onNestedAction={() => {}} onOpenRecord={() => {}} />)

    // Before any entry the first rendered row owns the stop.
    expect(tabStopRows()).toEqual([rowEl(0)])
    expect(rowEl(0).tabIndex).toBe(0)
    for (const index of [1, 2, 3, 4]) expect(rowEl(index).tabIndex).toBe(-1)

    // Focusing a later row moves the unique stop with it.
    focusElement(rowEl(2))
    expect(tabStopRows()).toEqual([rowEl(2)])
    expect(rowEl(0).tabIndex).toBe(-1)

    // ArrowDown moves the stop forward; ArrowUp moves it back.
    press('ArrowDown')
    expect(document.activeElement).toBe(rowEl(3))
    expect(tabStopRows()).toEqual([rowEl(3)])
    press('ArrowUp')
    expect(document.activeElement).toBe(rowEl(2))
    expect(tabStopRows()).toEqual([rowEl(2)])
  })

  it('remembers the focused row as the tab stop across blur and rerender', () => {
    const { rerender } = render(
      <DataGrid model={fakeModel(5)} onNestedAction={() => {}} onOpenRecord={() => {}} />,
    )
    focusElement(rowEl(3))
    act(() => {
      ;(document.activeElement as HTMLElement | null)?.blur()
    })
    // The stop is still the remembered row, not reset to the top.
    expect(tabStopRows()).toEqual([rowEl(3)])

    rerender(<DataGrid model={fakeModel(5)} onNestedAction={() => {}} onOpenRecord={() => {}} />)
    expect(tabStopRows()).toEqual([rowEl(3)])
    // A fresh Tab entry (focus the tab stop) lands on the remembered row.
    focusElement(tabStopRows()[0] as HTMLElement)
    expect(document.activeElement).toBe(rowEl(3))
  })

  it('moves cell focus with ArrowLeft/ArrowRight and keeps the row the tab stop', () => {
    render(<DataGrid model={fakeModel(5)} onNestedAction={() => {}} onOpenRecord={() => {}} />)
    focusElement(rowEl(0))

    press('ArrowRight')
    expect(document.activeElement).toBe(cellEl(0, 0))
    // Cell focus does not add a second tab stop: the row still owns it.
    expect(tabStopRows()).toEqual([rowEl(0)])
    expect(cellEl(0, 0).tabIndex).toBe(-1)

    press('ArrowRight')
    expect(document.activeElement).toBe(cellEl(0, 1))
    press('ArrowRight')
    expect(document.activeElement).toBe(cellEl(0, 2))
    // Clamped at the last cell.
    press('ArrowRight')
    expect(document.activeElement).toBe(cellEl(0, 2))

    press('ArrowLeft')
    expect(document.activeElement).toBe(cellEl(0, 1))
    press('ArrowLeft')
    expect(document.activeElement).toBe(cellEl(0, 0))
  })

  it('carries the focused column across rows with ArrowUp/ArrowDown', () => {
    render(<DataGrid model={fakeModel(5)} onNestedAction={() => {}} onOpenRecord={() => {}} />)
    focusElement(rowEl(0))
    press('ArrowRight')
    press('ArrowRight')
    expect(document.activeElement).toBe(cellEl(0, 1))

    press('ArrowDown')
    expect(document.activeElement).toBe(cellEl(1, 1))
    expect(tabStopRows()).toEqual([rowEl(1)])
    press('ArrowUp')
    expect(document.activeElement).toBe(cellEl(0, 1))
  })

  it('jumps to the row ends with Home/End and to the grid corners with Ctrl', () => {
    render(<DataGrid model={fakeModel(5)} onNestedAction={() => {}} onOpenRecord={() => {}} />)
    focusElement(rowEl(1))
    press('ArrowRight')
    press('ArrowRight')
    press('ArrowRight')
    expect(document.activeElement).toBe(cellEl(1, 2))

    press('Home')
    expect(document.activeElement).toBe(cellEl(1, 0))
    press('End')
    expect(document.activeElement).toBe(cellEl(1, 2))

    press('Home', { ctrlKey: true })
    expect(document.activeElement).toBe(cellEl(0, 0))
    expect(tabStopRows()).toEqual([rowEl(0)])

    press('End', { ctrlKey: true })
    expect(document.activeElement).toBe(cellEl(4, 2))
    expect(tabStopRows()).toEqual([rowEl(4)])
  })

  it('parks a focus move for a row outside the rendered window and completes it after render', () => {
    setRenderedRows([0, 1])
    const { rerender } = render(
      <DataGrid model={fakeModel(10)} onNestedAction={() => {}} onOpenRecord={() => {}} />,
    )
    focusElement(rowEl(1))
    press('ArrowDown')
    // Row 2 is not rendered yet: the request is parked and scrollToIndex is
    // asked to bring it into the window.
    expect(h.scrollToIndex).toHaveBeenCalledWith(2, { align: 'auto' })

    setRenderedRows([1, 2, 3])
    rerender(<DataGrid model={fakeModel(10)} onNestedAction={() => {}} onOpenRecord={() => {}} />)
    expect(document.activeElement).toBe(rowEl(2))
    expect(tabStopRows()).toEqual([rowEl(2)])
  })

  it('a landed move never steals focus back on later renders (clear is final)', () => {
    // Pointer focus moves elsewhere after a keyboard move landed; a later
    // window/render change must not re-run the completed request.
    setRenderedRows([0, 1])
    const { rerender } = render(
      <DataGrid model={fakeModel(10)} onNestedAction={() => {}} onOpenRecord={() => {}} />,
    )
    focusElement(rowEl(1))
    press('ArrowDown')
    setRenderedRows([1, 2, 3])
    rerender(<DataGrid model={fakeModel(10)} onNestedAction={() => {}} onOpenRecord={() => {}} />)
    expect(document.activeElement).toBe(rowEl(2))
    // The pointer takes over (focus moves without a keyboard request)…
    focusElement(rowEl(1))
    // …and a subsequent render with a new window must leave it alone.
    setRenderedRows([0, 1, 2, 3])
    rerender(<DataGrid model={fakeModel(10)} onNestedAction={() => {}} onOpenRecord={() => {}} />)
    expect(document.activeElement).toBe(rowEl(1))
  })

  it('drops a parked move whose row index left the dataset (AR-W2 bounds)', () => {
    // Filter/delete shrinks the dataset past the parked index between the
    // park and the render: the request must be dropped, so a later render
    // re-exposing that positional index cannot steal focus.
    setRenderedRows([0, 1])
    const { rerender } = render(
      <DataGrid model={fakeModel(10)} onNestedAction={() => {}} onOpenRecord={() => {}} />,
    )
    focusElement(rowEl(1))
    press('ArrowDown')
    // The dataset shrinks to 2 rows: parked row 2 no longer exists.
    rerender(<DataGrid model={fakeModel(2)} onNestedAction={() => {}} onOpenRecord={() => {}} />)
    // The pointer moves elsewhere while the dataset is small…
    focusElement(rowEl(1))
    // …then the view grows back and row 2 renders again.
    setRenderedRows([1, 2, 3])
    rerender(<DataGrid model={fakeModel(10)} onNestedAction={() => {}} onOpenRecord={() => {}} />)
    expect(document.activeElement).toBe(rowEl(1))
  })
})

describe('DataGrid edit-mode keyboard immunity (S5)', () => {
  it('lets an open editor consume arrows and keeps Enter/Escape semantics', () => {
    render(
      <DataGrid
        model={fakeModel(5)}
        onNestedAction={() => {}}
        onOpenRecord={() => {}}
        overlayState={fakeOverlay()}
        onCommitCell={() => {}}
      />,
    )

    focusElement(cellEl(0, 0))
    expect(document.activeElement).toBe(cellEl(0, 0))
    // Enter on a focused cell still opens the inline editor (unchanged).
    press('Enter')
    const editor = screen.getByTestId('grid-editor-input')
    expect(document.activeElement).toBe(editor)

    // Arrows inside the editor must not move grid focus.
    press('ArrowRight')
    expect(document.activeElement).toBe(editor)
    press('ArrowDown')
    expect(document.activeElement).toBe(editor)
    press('ArrowLeft')
    expect(document.activeElement).toBe(editor)

    // Escape still cancels and closes the editor (unchanged).
    press('Escape')
    expect(screen.queryByTestId('grid-editor-input')).toBeNull()
  })

  it('contains editor-internal Enter/Escape on the boolean editor and its NULL button', () => {
    const onOpenRecord = vi.fn()
    render(
      <DataGrid
        model={fakeBooleanModel(5)}
        onNestedAction={() => {}}
        onOpenRecord={onOpenRecord}
        overlayState={fakeOverlay()}
        onCommitCell={() => {}}
      />,
    )

    // Enter on the focused boolean cell opens the `<select>` editor.
    focusElement(cellEl(0, 0))
    press('Enter')
    const select = screen.getByTestId('grid-editor-boolean')
    expect(document.activeElement).toBe(select)

    // Enter inside the open editor must not reach the row's inspector gesture
    // (round-1 regression: the boolean editor let Enter bubble, so it opened
    // the record inspector instead of staying in the editor).
    press('Enter')
    expect(onOpenRecord).not.toHaveBeenCalled()
    expect(screen.queryByTestId('grid-editor-boolean')).not.toBeNull()

    // Escape still cancels the boolean editor through its own handler.
    press('Escape')
    expect(screen.queryByTestId('grid-editor-boolean')).toBeNull()
    expect(onOpenRecord).not.toHaveBeenCalled()

    // The NULL button lives inside `.grid-cell-editor` too: a keydown delivered
    // there is contained, never routed to the inspector.
    focusElement(cellEl(0, 0))
    press('Enter')
    const nullButton = screen.getByTestId('grid-editor-null')
    focusElement(nullButton)
    press('Enter')
    expect(onOpenRecord).not.toHaveBeenCalled()
    expect(screen.queryByTestId('grid-editor-boolean')).not.toBeNull()
    press('Escape')
    expect(onOpenRecord).not.toHaveBeenCalled()
    // Escape on the NULL button is not the editor's cancel affordance; the
    // editor stays open rather than the gesture leaking to the grid.
    expect(screen.queryByTestId('grid-editor-boolean')).not.toBeNull()
  })
})
