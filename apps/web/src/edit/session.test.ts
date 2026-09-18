import { describe, expect, it } from 'vitest'
import type { OverlayBase } from '@assay/domain'
import { appendOp, baseRowId, emptyHistory, insertRowId, stateAtCursor, undo } from '@assay/domain'
import { activeOps, editOutcomeMessage, overlaySnapshot } from './session'

const BASE: OverlayBase = {
  baseAnchor: 'fv-5-1000',
  overlayAnchor: 'ov-1',
  columns: [
    { name: 'id', type: 'BIGINT' },
    { name: 'label', type: 'VARCHAR' },
  ],
  baseRowCount: 2,
}

describe('activeOps / overlaySnapshot — the engine-facing history projection', () => {
  it('projects exactly the prefix left of the cursor, in order', () => {
    const first = appendOp(BASE, emptyHistory(), {
      kind: 'cell-set',
      rowId: baseRowId(BASE.baseAnchor, 0),
      column: 'label',
      value: { kind: 'string', value: 'a' },
    })
    const second = appendOp(BASE, first.history, {
      kind: 'cell-set',
      rowId: baseRowId(BASE.baseAnchor, 1),
      column: 'label',
      value: { kind: 'string', value: 'b' },
    })
    expect(activeOps(second.history)).toHaveLength(2)

    // Undoing is a cursor move: the engine-facing ops shrink with it.
    const undone = undo(second.history)
    expect(activeOps(undone.history)).toHaveLength(1)
    expect(overlaySnapshot(BASE, undone.history)).toEqual({
      base: BASE,
      ops: [
        {
          kind: 'cell-set',
          rowId: baseRowId(BASE.baseAnchor, 0),
          column: 'label',
          value: { kind: 'string', value: 'a' },
        },
      ],
    })
  })

  it('after undoing every entry the snapshot is empty and the fold equals the initial state', () => {
    const insertedId = insertRowId(BASE.overlayAnchor, 0)
    const appended = appendOp(BASE, emptyHistory(), {
      kind: 'row-insert',
      rowId: insertedId,
      position: { kind: 'end' },
      values: new Map(),
    })
    const undone = undo(appended.history)
    const snapshot = overlaySnapshot(BASE, undone.history)
    expect(snapshot.ops).toEqual([])
    // Undo→clean: the pure fold of the empty prefix carries no edits/inserts.
    const state = stateAtCursor(BASE, undone.history)
    expect(state.edits.size).toBe(0)
    expect(state.inserts.size).toBe(0)
    expect(state.deletedBase.size).toBe(0)
  })
})

describe('editOutcomeMessage — surface typed outcomes, never swallow', () => {
  it('returns null for an applied op', () => {
    expect(editOutcomeMessage({ status: 'applied', notes: [] })).toBeNull()
  })

  it('describes no-op and conflict outcomes in plain text', () => {
    expect(editOutcomeMessage({ status: 'no-op', reason: 'cell-value-unchanged' })).toContain(
      'already has that value',
    )
    expect(editOutcomeMessage({ status: 'conflict', reason: 'row-deleted' })).toContain(
      'was deleted',
    )
    expect(editOutcomeMessage({ status: 'conflict', reason: 'row-anchor-mismatch' })).toContain(
      'different file version',
    )
  })
})
