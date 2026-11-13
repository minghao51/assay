// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GridRowSlot, GridViewportModel } from '@assay/grid'
import type { OverlayState } from '@assay/domain'
import { DataGrid } from './DataGrid'
import type { EditorReportState } from './DataGrid'

/**
 * WF-06 (S-A2-1 / IC-01) editor-state authority pins.
 *
 * `DataGrid` reports the single open editor through two channels: the
 * App-owned ref written SYNCHRONOUSLY at every transition (the gesture gate's
 * authority) and a deduped render-only notification (so the host can clear its
 * C13 notice). Both must be written at the existing handler writes — never in
 * an effect — and editing/commit/cancel behaviour must be byte-identical.
 *
 * The boolean kind is the load-bearing case: its `<select>` has NO blur
 * handler, so an implementation that relied on blur would leave the gate open.
 */

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

const SCHEMA = [
  { name: 'id', type: 'BIGINT' },
  { name: 'flag', type: 'BOOLEAN' },
  { name: 'label', type: 'VARCHAR' },
]

function controllableModel(): GridViewportModel {
  const slots = new Map<number, GridRowSlot>()
  let version = 0
  const listeners = new Set<() => void>()
  const model = {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getVersion: () => version,
    schema: SCHEMA,
    totalRows: 1,
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
    getRow: (index: number): GridRowSlot =>
      slots.get(index) ?? {
        status: 'ready',
        row: [1, true, 'alpha'],
        key: 'base:fv-1:0',
      },
    setSort: async () => {},
    setFilters: async () => {},
    observeViewport: () => {},
    retry: () => {},
  }
  version += 1
  return model as unknown as GridViewportModel
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

function cellEl(columnIndex: number): HTMLElement {
  const cells = document.querySelectorAll<HTMLElement>('[data-testid="grid-cell"]')
  const element = cells[columnIndex]
  if (element === undefined) throw new Error(`cell ${String(columnIndex)} not rendered`)
  return element
}

function mount(): {
  ref: { current: EditorReportState }
  reports: EditorReportState[]
  commit: ReturnType<typeof vi.fn>
  unmount: () => void
} {
  const ref: { current: EditorReportState } = { current: { open: false, invalid: false } }
  const reports: EditorReportState[] = []
  const commit = vi.fn<(...args: unknown[]) => void>()
  const { unmount } = render(
    <DataGrid
      model={controllableModel()}
      onNestedAction={() => {}}
      overlayState={fakeOverlay()}
      onCommitCell={(rowId, column, value) => {
        commit(rowId, column, value)
      }}
      editorStateRef={ref}
      onEditorStateChange={(state) => {
        reports.push(state)
      }}
    />,
  )
  return { ref, reports, commit, unmount }
}

beforeEach(() => {
  h.rows = [{ index: 0, key: '0', start: 0, size: 28 }]
})

afterEach(cleanup)

describe('WF-06 DataGrid — text/number/temporal editor reporting', () => {
  it('reports open synchronously on the open gesture and not again per keystroke', () => {
    const { ref, reports } = mount()
    fireEvent.doubleClick(cellEl(2))
    // Synchronous: the click handler has already written the ref.
    expect(ref.current).toEqual({ open: true, invalid: false })
    expect(reports).toEqual([{ open: true, invalid: false }])

    const input = screen.getByTestId('grid-editor-input')
    fireEvent.change(input, { target: { value: 'beta' } })
    fireEvent.change(input, { target: { value: 'beta2' } })
    expect(ref.current).toEqual({ open: true, invalid: false })
    // The render mirror is deduped: typing must not re-render the host.
    expect(reports).toHaveLength(1)
  })

  it('reports open+invalid when the commit is refused, and the editor stays open', () => {
    const { ref, reports } = mount()
    fireEvent.doubleClick(cellEl(0))
    const input = screen.getByTestId('grid-editor-input')
    fireEvent.change(input, { target: { value: 'not-a-number' } })
    fireEvent.blur(input)
    expect(ref.current).toEqual({ open: true, invalid: true })
    expect(reports).toEqual([
      { open: true, invalid: false },
      { open: true, invalid: true },
    ])
    expect(screen.queryByTestId('grid-editor-input')).not.toBeNull()
  })

  it('reports closed on Escape and on an ordinary valid commit', () => {
    const first = mount()
    fireEvent.doubleClick(cellEl(2))
    fireEvent.keyDown(screen.getByTestId('grid-editor-input'), { key: 'Escape' })
    expect(first.ref.current).toEqual({ open: false, invalid: false })
    expect(first.reports).toEqual([
      { open: true, invalid: false },
      { open: false, invalid: false },
    ])
    expect(first.commit).not.toHaveBeenCalled()

    cleanup()
    const second = mount()
    fireEvent.doubleClick(cellEl(2))
    const input = screen.getByTestId('grid-editor-input')
    fireEvent.change(input, { target: { value: 'beta' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(second.ref.current).toEqual({ open: false, invalid: false })
    expect(second.commit).toHaveBeenCalledTimes(1)
  })

  it('reports closed on unmount so a retired grid cannot leave the gate stuck open', () => {
    const { ref, reports, unmount } = mount()
    fireEvent.doubleClick(cellEl(2))
    expect(ref.current.open).toBe(true)
    unmount()
    expect(ref.current).toEqual({ open: false, invalid: false })
    expect(reports.at(-1)).toEqual({ open: false, invalid: false })
  })
})

describe('WF-06 DataGrid — boolean editor reporting (no blur handler)', () => {
  it('stays open through the placeholder option and closes on a true/false commit', () => {
    const { ref, reports, commit } = mount()
    fireEvent.doubleClick(cellEl(1))
    const select = screen.getByTestId('grid-editor-boolean') as HTMLSelectElement
    expect(ref.current).toEqual({ open: true, invalid: false })

    // The "true / false…" placeholder keeps the editor open — and there is no
    // blur handler in this subtree, so the ref write HERE is the only signal.
    fireEvent.change(select, { target: { value: '' } })
    expect(ref.current).toEqual({ open: true, invalid: false })
    expect(reports).toEqual([{ open: true, invalid: false }])

    fireEvent.change(select, { target: { value: 'false' } })
    expect(ref.current).toEqual({ open: false, invalid: false })
    expect(reports.at(-1)).toEqual({ open: false, invalid: false })
    expect(commit).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('grid-editor-boolean')).toBeNull()
  })

  it('reports closed when the boolean editor is cancelled with Escape', () => {
    const { ref } = mount()
    fireEvent.doubleClick(cellEl(1))
    fireEvent.keyDown(screen.getByTestId('grid-editor-boolean'), { key: 'Escape' })
    expect(ref.current).toEqual({ open: false, invalid: false })
  })
})
