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
    })
    // Fixed order: cell ops → row ops → column ops (never object order).
    expect(pendingChangesSummary(ops)).toBe(
      '7 pending changes: 1 cell edit, 1 cell revert, 2 row inserts, 1 row delete, 1 column rename, 1 column cast.',
    )
  })
})
