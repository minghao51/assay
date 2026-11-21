// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { appendOp, baseRowId, emptyHistory, insertRowId, stateAtCursor } from '@assay/domain'
import type { OverlayBase, RowId } from '@assay/domain'
import type { EditControllerSnapshot } from './edit-controller'
import { describeEditStatus, editingControlState, isDirtyCell } from './dirty-history-view'

const base: OverlayBase = {
  baseAnchor: 'table-a',
  overlayAnchor: 'overlay-1',
  columns: [
    { name: 'id', type: 'BIGINT' },
    { name: 'value', type: 'DOUBLE' },
  ],
  baseRowCount: 3,
}

function snapshot(overrides: Partial<EditControllerSnapshot> = {}): EditControllerSnapshot {
  return {
    history: emptyHistory(),
    busy: false,
    error: null,
    revision: 0,
    ...overrides,
  }
}

describe('dirty-history view', () => {
  it('derives the toolbar state from the history cursor', () => {
    expect(editingControlState(snapshot())).toEqual({
      busy: false,
      dirty: false,
      canUndo: false,
      canRedo: false,
    })
    const history = {
      entries: [{ op: { kind: 'cell-set' } }, { op: { kind: 'cell-set' } }],
      cursor: 1,
    } as unknown as EditControllerSnapshot['history']
    expect(editingControlState(snapshot({ history }))).toEqual({
      busy: false,
      dirty: true,
      canUndo: true,
      canRedo: true,
    })
    // At the tip: redo is unavailable.
    expect(
      editingControlState(snapshot({ history: { ...history, cursor: 2 }, busy: true })),
    ).toEqual({ busy: true, dirty: true, canUndo: true, canRedo: false })
    // At the base state (cursor 0) with entries ahead: dirty is false, redo true.
    expect(editingControlState(snapshot({ history: { ...history, cursor: 0 } }))).toEqual({
      busy: false,
      dirty: false,
      canUndo: false,
      canRedo: true,
    })
  })

  it('renders the status line with the error role exactly when an error exists', () => {
    expect(describeEditStatus(snapshot())).toEqual({ text: '', role: 'status' })
    expect(describeEditStatus(snapshot({ busy: true }))).toEqual({
      text: 'Checking edit…',
      role: 'status',
    })
    expect(describeEditStatus(snapshot({ revision: 2 }))).toEqual({
      text: 'Edit applied.',
      role: 'status',
    })
    // The error text WINS over busy/revision and flips the role to alert.
    expect(describeEditStatus(snapshot({ revision: 2, busy: true, error: 'rejected' }))).toEqual({
      text: 'rejected',
      role: 'alert',
    })
  })

  it('marks a cell dirty for a live insert or an overlay edit, and nothing else', () => {
    const baseAnchor = 'table-a'
    const rowOne: RowId = baseRowId(baseAnchor, 1)
    const insertedId: RowId = insertRowId('overlay-1', 1)
    const empty = stateAtCursor(base, emptyHistory())
    expect(isDirtyCell(empty, rowOne, 'value')).toBe(false)

    const edited = appendOp(base, emptyHistory(), {
      kind: 'cell-set',
      rowId: rowOne,
      column: 'value',
      value: { kind: 'number', value: 5 },
    })
    const editedState = stateAtCursor(base, edited.history)
    expect(isDirtyCell(editedState, rowOne, 'value')).toBe(true)
    // An untouched column of an edited row is NOT dirty (row-level dirtiness is
    // the grid's own concern; the predicate answers per cell).
    expect(isDirtyCell(editedState, rowOne, 'id')).toBe(false)

    const inserted = appendOp(base, edited.history, {
      kind: 'row-insert',
      rowId: insertedId,
      position: { kind: 'end' },
      values: new Map(),
    })
    const insertedState = stateAtCursor(base, inserted.history)
    // A live insert is dirty on every cell, including ones it never set.
    expect(isDirtyCell(insertedState, insertedId, 'id')).toBe(true)
    expect(isDirtyCell(insertedState, insertedId, 'value')).toBe(true)
    // A tombstoned (non-live) insert record is not dirty by liveness alone.
    const reverted = appendOp(base, inserted.history, {
      kind: 'row-delete',
      rowId: insertedId,
    })
    expect(isDirtyCell(stateAtCursor(base, reverted.history), insertedId, 'id')).toBe(false)
  })
})
