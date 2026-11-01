// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GridRowSlot, GridViewportModel, SortSpec } from '@assay/grid'
import type { OverlayState } from '@assay/domain'
import { DataGrid } from './DataGrid'

/**
 * ug-19 (finding UG-19) pins: the loading-row edit gesture.
 *
 * Before ug-19 `beginEdit` returned silently when the row was not ready, so a
 * double-click or Enter on a still-loading cell did nothing at all. Now ONE
 * gesture is queued per grid (row + column + monotonic seq): the editor opens
 * through the existing validated path once the model reports that slot `ready`,
 * the gesture is dropped with a visible value-free notice when the slot settles
 * `error`, a newer gesture replaces the older one, and a dataset/structural
 * epoch change retires it instead of opening a different logical row. Ready-row
 * editing and the nested-column rejection are unchanged.
 *
 * The model here is a tiny controllable store: the test decides exactly when a
 * slot lands, so "in flight" is not a timing accident.
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
  { name: 'payload', type: 'STRUCT(a INTEGER)' },
]

const TOTAL_ROWS = 3

/**
 * A controllable grid model: slots are set explicitly and every notification
 * bumps the version, so `useSyncExternalStore` re-renders exactly when a slot
 * lands (the real model's notification shape).
 */
function controllableModel(): {
  model: GridViewportModel
  setSlot: (index: number, slot: GridRowSlot) => void
  setSort: (spec: SortSpec | null) => void
} {
  const slots = new Map<number, GridRowSlot>()
  let version = 0
  const listeners = new Set<() => void>()
  const notify = (): void => {
    version += 1
    for (const listener of listeners) listener()
  }
  const model = {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getVersion: () => version,
    schema: SCHEMA,
    totalRows: TOTAL_ROWS,
    sort: null as SortSpec | null,
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
    getRow: (index: number): GridRowSlot => slots.get(index) ?? { status: 'loading' },
    setSort: async () => {},
    setFilters: async () => {},
    observeViewport: () => {},
    retry: () => {},
  }
  return {
    model: model as unknown as GridViewportModel,
    setSlot: (index, slot) => {
      slots.set(index, slot)
      notify()
    },
    setSort: (spec) => {
      model.sort = spec
      notify()
    },
  }
}

function readyRow(index: number): GridRowSlot {
  return {
    status: 'ready',
    row: [index, `name-${String(index)}`, { a: index }],
    key: `base:${String(index)}`,
  }
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
  if (element === undefined) throw new Error(`cell ${String(rowIndex)}:${String(columnIndex)}`)
  return element
}

/** Double-click a cell (the pointer edit gesture). */
function doubleClickCell(rowIndex: number, columnIndex: number): void {
  fireEvent.doubleClick(cellEl(rowIndex, columnIndex))
}

/** Focus a cell and press Enter (the keyboard edit gesture). */
function enterCell(rowIndex: number, columnIndex: number): void {
  const cell = cellEl(rowIndex, columnIndex)
  act(() => {
    cell.focus()
  })
  fireEvent.keyDown(cell, { key: 'Enter' })
}

function editor(): HTMLInputElement | null {
  return screen.queryByTestId('grid-editor-input') as HTMLInputElement | null
}

function mount(): {
  model: ReturnType<typeof controllableModel>
  announce: ReturnType<typeof vi.fn>
} {
  const state = controllableModel()
  const announce = vi.fn()
  render(
    <DataGrid
      model={state.model}
      onNestedAction={() => {}}
      overlayState={fakeOverlay()}
      onCommitCell={() => {}}
      onEditAnnounce={announce}
    />,
  )
  return { model: state, announce }
}

/** Land a slot and let React commit the open effect. */
async function land(onLand: () => void): Promise<void> {
  await act(async () => {
    onLand()
    for (let tick = 0; tick < 4; tick += 1) await Promise.resolve()
  })
}

beforeEach(() => {
  h.rows = [0, 1, 2].map((index) => ({
    index,
    key: `row-${String(index)}`,
    start: index * 28,
    size: 28,
  }))
  h.scrollToIndex.mockReset()
})

afterEach(cleanup)

describe('DataGrid loading-row edit gesture (ug-19)', () => {
  it('queues a double-click on a loading row and opens the editor once it lands ready', async () => {
    const { model } = mount()

    doubleClickCell(1, 1)
    // No editor yet, and no error copy: the gesture is pending, not rejected.
    expect(editor()).toBeNull()
    expect(screen.queryByTestId('grid-edit-error')).toBeNull()

    await land(() => {
      model.setSlot(1, readyRow(1))
    })

    // The editor opened on the CAPTURED row/column with the ready cell's draft.
    const input = screen.getByTestId('grid-editor-input')
    expect((input as HTMLInputElement).value).toBe('name-1')
    expect(input.getAttribute('aria-label')).toBe('Edit name on row 1')
    expect(screen.queryByTestId('grid-edit-error')).toBeNull()
  })

  it('queues the Enter gesture on a focused loading cell the same way', async () => {
    const { model } = mount()

    enterCell(2, 1)
    expect(editor()).toBeNull()

    await land(() => {
      model.setSlot(2, readyRow(2))
    })
    expect((screen.getByTestId('grid-editor-input') as HTMLInputElement).value).toBe('name-2')
  })

  it('drops the gesture visibly when the slot settles error (byte-exact value-free notice)', async () => {
    const { model, announce } = mount()

    doubleClickCell(1, 1)
    await land(() => {
      model.setSlot(1, { status: 'error', message: 'DuckDB failed on window 1:2' })
    })

    expect(editor()).toBeNull()
    const notice = screen.getByTestId('grid-edit-error')
    expect(notice.textContent).toBe('That row could not be loaded, so the edit did not open.')
    // The raw provider message never reaches the notice, and the same
    // value-free copy goes through the app's single polite region.
    expect(notice.textContent).not.toContain('window')
    expect(announce.mock.calls).toEqual([
      ['That row could not be loaded, so the edit did not open.'],
    ])
  })

  it('replaces the pending gesture with a newer one', async () => {
    const { model } = mount()

    doubleClickCell(1, 1)
    doubleClickCell(2, 1)

    // The older row landing must NOT open anything: its gesture was replaced.
    await land(() => {
      model.setSlot(1, readyRow(1))
    })
    expect(editor()).toBeNull()

    await land(() => {
      model.setSlot(2, readyRow(2))
    })
    expect(screen.getByTestId('grid-editor-input').getAttribute('aria-label')).toBe(
      'Edit name on row 2',
    )
  })

  it('clears the pending gesture on a structural epoch change', async () => {
    const { model } = mount()

    doubleClickCell(1, 1)
    // A sort starts a fresh data epoch: the captured position now names a
    // different record, so the gesture is retired (never opened elsewhere).
    await land(() => {
      model.setSort({ column: 'id', direction: 'desc' })
    })

    await land(() => {
      model.setSlot(1, readyRow(1))
    })
    expect(editor()).toBeNull()
    expect(screen.queryByTestId('grid-edit-error')).toBeNull()
  })

  it('retires the gesture when the model (dataset) is replaced', async () => {
    const first = controllableModel()
    const announce = vi.fn()
    const props = {
      onNestedAction: () => {},
      overlayState: fakeOverlay(),
      onCommitCell: () => {},
      onEditAnnounce: announce,
    }
    const { rerender } = render(<DataGrid model={first.model} {...props} />)

    doubleClickCell(1, 1)
    const second = controllableModel()
    rerender(<DataGrid model={second.model} {...props} />)

    // The OLD dataset's row landing after the swap must open nothing.
    await land(() => {
      first.setSlot(1, readyRow(1))
    })
    expect(editor()).toBeNull()
  })

  it('leaves ready-row editing unchanged (immediate open, nothing queued)', async () => {
    const { model } = mount()
    await land(() => {
      model.setSlot(0, readyRow(0))
    })

    doubleClickCell(0, 1)
    expect((screen.getByTestId('grid-editor-input') as HTMLInputElement).value).toBe('name-0')
  })

  it('keeps the existing readable rejection for a nested column', () => {
    const { model } = mount()
    act(() => {
      model.setSlot(0, readyRow(0))
    })

    doubleClickCell(0, 2)
    expect(editor()).toBeNull()
    expect(screen.getByTestId('grid-edit-error').textContent).toBe(
      'Column "payload" is not editable (nested type).',
    )
  })
})
