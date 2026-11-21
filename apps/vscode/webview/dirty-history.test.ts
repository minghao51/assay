// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * D03b — the extracted dirty-history display, driven through its real DOM
 * surface under happy-dom.
 *
 * Pins the invariants the split must not lose:
 * - the grid editing adapter reads the controller's CURRENT snapshot,
 * - the dirty predicate reads the overlay AT THE HISTORY CURSOR (one recompute
 *   per published history object, not per cell query),
 * - the status line carries `role="alert"` exactly when the controller reports
 *   an error, and every render refreshes the grid's editing state.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { baseRowId, stateAtCursor } from '@assay/domain'
import type { OverlayBase } from '@assay/domain'
import { EditController } from '../src/pure/edit-controller'
import { DirtyHistoryView } from './dirty-history'

const BASE: OverlayBase = {
  baseAnchor: 'table-a',
  overlayAnchor: 'overlay-1',
  columns: [
    { name: 'id', type: 'BIGINT' },
    { name: 'value', type: 'DOUBLE' },
  ],
  baseRowCount: 3,
}

function scaffold(): void {
  document.body.replaceChildren()
  const root = document.createElement('div')
  root.id = 'grid-root'
  document.body.appendChild(root)
}

function controller(): EditController {
  return new EditController(BASE, {
    preflight: async () => undefined,
    activate: async () => undefined,
  })
}

describe('dirty-history view (extracted presentation controller)', () => {
  beforeEach(scaffold)

  it('creates one status line before the grid and renders the controller snapshot', () => {
    const edits = controller()
    let refreshes = 0
    const view = new DirtyHistoryView({
      base: BASE,
      controller: edits,
      grid: () => ({ refreshEditingState: () => void refreshes++ }),
    })
    view.mountStatus()
    // Idempotent: a second call reuses the existing element (one per page).
    view.mountStatus()
    const statuses = document.querySelectorAll('#edit-status')
    expect(statuses).toHaveLength(1)
    expect(statuses[0]?.nextElementSibling?.id).toBe('grid-root')

    view.render(edits.snapshot)
    const status = document.getElementById('edit-status')
    expect(status?.getAttribute('role')).toBe('status')
    expect(status?.textContent).toBe('')
    expect(refreshes).toBe(1)
  })

  it('shows the controller error with role="alert" and nothing else', async () => {
    // The entry forwards the controller's published snapshots to the view
    // (dataset.ts wires `dirtyHistory.render`); mirror that wiring here.
    const holder: { view: DirtyHistoryView | null } = { view: null }
    const edits = new EditController(
      BASE,
      {
        preflight: async () => undefined,
        activate: async () => undefined,
      },
      (snapshot) => holder.view?.render(snapshot),
    )
    const view = new DirtyHistoryView({ base: BASE, controller: edits, grid: () => null })
    holder.view = view
    view.mountStatus()
    // A row id anchored to a different base version conflicts: the controller
    // publishes an error snapshot instead of applying the op.
    await edits.commitCell(baseRowId('other-file', 0), 'value', { kind: 'number', value: 1 })
    const status = document.getElementById('edit-status')
    expect(status?.getAttribute('role')).toBe('alert')
    expect(status?.textContent).toContain('Cannot apply edit:')
    expect(edits.currentHistory.entries).toHaveLength(0)
    expect(view.editing.state()).toEqual({
      busy: false,
      dirty: false,
      canUndo: false,
      canRedo: false,
    })
  })

  it('reads the overlay at the history cursor, memoized per published history', async () => {
    const edits = controller()
    const view = new DirtyHistoryView({ base: BASE, controller: edits, grid: () => null })
    view.mountStatus()
    const row = baseRowId(BASE.baseAnchor, 1)
    expect(view.editing.isDirty(row, 'value')).toBe(false)

    await edits.commitCell(row, 'value', { kind: 'number', value: 5 })
    expect(view.editing.isDirty(row, 'value')).toBe(true)
    expect(view.editing.isDirty(row, 'id')).toBe(false)
    expect(view.editing.state().dirty).toBe(true)
    // Undo returns to the base state: not dirty, nothing to undo, redo possible.
    await edits.undo()
    expect(view.editing.isDirty(row, 'value')).toBe(false)
    expect(view.editing.state()).toEqual({
      busy: false,
      dirty: false,
      canUndo: false,
      canRedo: true,
    })
  })

  it('marks an inserted (live) row dirty on every cell', async () => {
    const edits = controller()
    const view = new DirtyHistoryView({ base: BASE, controller: edits, grid: () => null })
    view.mountStatus()
    await edits.insertRow()
    const inserted = [...stateAtCursor(BASE, edits.currentHistory).inserts.values()].find(
      (record) => record.live,
    )
    expect(inserted).toBeDefined()
    expect(view.editing.isDirty(inserted!.id, 'id')).toBe(true)
    expect(view.editing.isDirty(inserted!.id, 'value')).toBe(true)
  })
})
