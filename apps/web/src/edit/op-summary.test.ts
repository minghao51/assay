// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import type { EditOp } from '@assay/domain'
import { baseRowId, insertRowId } from '@assay/domain'
import { countOpsByKind, pendingChangesSummary } from './op-summary'

const BASE_ANCHOR = 'fv-1-2'
const OVERLAY_ANCHOR = 'ov-1'

const setCell: EditOp = {
  kind: 'cell-set',
  rowId: baseRowId(BASE_ANCHOR, 0),
  column: 'income',
  value: { kind: 'number', value: 1 },
}
const revertCell: EditOp = {
  kind: 'cell-revert',
  rowId: baseRowId(BASE_ANCHOR, 0),
  column: 'income',
}
const rename: EditOp = { kind: 'column-rename', from: 'a', to: 'b' }
const cast: EditOp = { kind: 'column-cast', column: 'b', targetType: 'DOUBLE' }
const insert: EditOp = {
  kind: 'row-insert',
  rowId: insertRowId(OVERLAY_ANCHOR, 0),
  position: { kind: 'end' },
  values: new Map(),
}
const deleteRow: EditOp = { kind: 'row-delete', rowId: baseRowId(BASE_ANCHOR, 1) }
const restoreRow: EditOp = { kind: 'row-restore', rowId: baseRowId(BASE_ANCHOR, 1) }
/** CO-4: undoing a row this session inserted (the domain's `uninsertRow`). */
const uninsert: EditOp = { kind: 'row-uninsert', rowId: insertRowId(OVERLAY_ANCHOR, 0) }

describe('pendingChangesSummary — deterministic, kind-only (no dataset content)', () => {
  it('reports no pending changes for an empty list', () => {
    expect(pendingChangesSummary([])).toBe('No pending changes.')
  })

  it('singularizes one change', () => {
    expect(pendingChangesSummary([setCell])).toBe('1 pending change: 1 cell edit.')
  })

  it('counts by kind in a fixed order and pluralizes', () => {
    const ops = [setCell, revertCell, rename, cast, insert, insert, deleteRow]
    expect(countOpsByKind(ops)).toEqual({
      'cell-set': 1,
      'cell-revert': 1,
      'row-insert': 2,
      'row-uninsert': 0,
      'row-delete': 1,
      'row-restore': 0,
      'column-rename': 1,
      'column-cast': 1,
      // The EW-04D kind is carried by the exhaustive count map; no web
      // surface authors it yet, so the staged summary stays at 0 here.
      'column-repair': 0,
    })
    // Fixed order: cell ops → row ops → column ops (never object order).
    expect(pendingChangesSummary(ops)).toBe(
      '7 pending changes: 1 cell edit, 1 cell revert, 2 row inserts, 1 row delete, 1 column rename, 1 column cast.',
    )
  })
})

/**
 * CO-4 (ug-23) pin: the staged line names what the USER did, not the overlay's
 * internal vocabulary. `row-uninsert` undoes a row insert, so the label is
 * `undo row insert` (`2 undo row inserts` after the `+s` pluralization); the
 * domain term `row expunge` that used to be here must never come back into
 * this user-facing string.
 */
describe('pendingChangesSummary — plain-language op labels (CO-4, ug-23)', () => {
  it('labels a single row-uninsert `undo row insert`', () => {
    expect(pendingChangesSummary([uninsert])).toBe('1 pending change: 1 undo row insert.')
  })

  it('pluralizes it without changing the decided phrase', () => {
    expect(pendingChangesSummary([uninsert, uninsert, insert])).toBe(
      '3 pending changes: 1 row insert, 2 undo row inserts.',
    )
  })

  it('keeps overlay/engine vocabulary out of every label', () => {
    const all: EditOp[] = [
      setCell,
      revertCell,
      insert,
      uninsert,
      deleteRow,
      restoreRow,
      rename,
      cast,
    ]
    const summary = pendingChangesSummary(all)
    // The regression this rider fixes, stated as a negative pin.
    expect(summary).not.toMatch(/expunge/i)
    // …and the full line, so a swap of any single label is visible here.
    expect(summary).toBe(
      '8 pending changes: 1 cell edit, 1 cell revert, 1 row insert, 1 undo row insert, 1 row delete, 1 row restore, 1 column rename, 1 column cast.',
    )
  })
})
