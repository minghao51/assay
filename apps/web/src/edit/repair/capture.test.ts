// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import type { OverlayBase, TransformationHistory } from '@assay/domain'
import { appendOp, baseRowId, emptyHistory, stateAtCursor } from '@assay/domain'
import { captureIsStale, repairCaptureTag, schemaSignature, type RepairCaptureTag } from './capture'

/**
 * EW-04I — the captured revision and its staleness rule (EW-04D §2, U2).
 *
 * The point of these tests is the *field set*: every captured fact must be
 * independently load-bearing (a change to any one makes the preview stale),
 * and the things EW-04D says must NOT invalidate — grid sorting, filtering and
 * paging — are provably absent from the tag, because the tag has no filter/sort
 * state to capture.
 */

const BASE: OverlayBase = {
  baseAnchor: 'fv-5-1000',
  overlayAnchor: 'ov-1',
  columns: [
    { name: 'id', type: 'BIGINT' },
    { name: 'country', type: 'VARCHAR' },
  ],
  baseRowCount: 5,
}

const EMPTY: TransformationHistory = emptyHistory()
const STATE = stateAtCursor(BASE, EMPTY)

function tag(): RepairCaptureTag {
  const captured = repairCaptureTag(BASE, EMPTY, STATE, 0, 'country')
  if (captured === null) throw new Error('fixture column missing')
  return captured
}

describe('repairCaptureTag — what a preview is tagged with', () => {
  it('captures anchors, cursor, revision, the column and the schema signature', () => {
    expect(tag()).toEqual({
      baseAnchor: 'fv-5-1000',
      overlayAnchor: 'ov-1',
      cursor: 0,
      historyRevision: 0,
      column: 'country',
      columnType: 'VARCHAR',
      schemaSignature: 'id:BIGINT\u0000country:VARCHAR',
    })
    expect(schemaSignature(STATE)).toBe('id:BIGINT\u0000country:VARCHAR')
  })

  it('returns null for a column the effective schema does not have', () => {
    expect(repairCaptureTag(BASE, EMPTY, STATE, 0, 'nope')).toBeNull()
  })
})

describe('captureIsStale — each captured fact independently invalidates', () => {
  it('a null current tag is stale (the session is gone)', () => {
    expect(captureIsStale(tag(), null)).toBe(true)
  })

  it('an unchanged session is not stale', () => {
    expect(captureIsStale(tag(), tag())).toBe(false)
  })

  it('a different file version, editing session, cursor or revision is stale', () => {
    const base = tag()
    expect(captureIsStale(base, { ...base, baseAnchor: 'fv-6-1000' })).toBe(true)
    expect(captureIsStale(base, { ...base, overlayAnchor: 'ov-2' })).toBe(true)
    expect(captureIsStale(base, { ...base, cursor: 1 })).toBe(true)
    expect(captureIsStale(base, { ...base, historyRevision: 1 })).toBe(true)
  })

  it('a rename/cast (schema or target-type change) is stale', () => {
    const base = tag()
    expect(captureIsStale(base, { ...base, column: 'nation' })).toBe(true)
    expect(captureIsStale(base, { ...base, columnType: 'TEXT' })).toBe(true)
    expect(
      captureIsStale(base, { ...base, schemaSignature: 'id:BIGINT\u0000nation:VARCHAR' }),
    ).toBe(true)
  })

  it('a value edit that leaves the schema alone is still stale (the revision)', () => {
    // The effective schema is identical before and after a cell edit, and the
    // cursor moved — so the capture that only the revision catches is the
    // two-renders case: same cursor after an append+undo, same schema, still
    // not the same view.
    const appended = appendOp(BASE, EMPTY, {
      kind: 'cell-set',
      rowId: baseRowId(BASE.baseAnchor, 0),
      column: 'country',
      value: { kind: 'string', value: 'SG' },
    })
    expect(appended.outcome.status).toBe('applied')
    const editedState = stateAtCursor(BASE, appended.history)
    const afterEdit = repairCaptureTag(BASE, appended.history, editedState, 1, 'country')
    expect(afterEdit).not.toBeNull()
    expect(captureIsStale(tag(), afterEdit)).toBe(true)
    // Schema unchanged — only the cursor and the revision moved.
    expect(afterEdit?.schemaSignature).toBe(tag().schemaSignature)

    // And with the cursor back at 0 (an undo) the SAME schema and cursor are
    // only distinguishable by the revision, which is why it is in the tag.
    const undone = { entries: appended.history.entries, cursor: 0 }
    const afterUndo = repairCaptureTag(BASE, undone, stateAtCursor(BASE, undone), 2, 'country')
    expect(afterUndo).not.toBeNull()
    expect(afterUndo?.cursor).toBe(tag().cursor)
    expect(afterUndo?.schemaSignature).toBe(tag().schemaSignature)
    expect(captureIsStale(tag(), afterUndo)).toBe(true)
  })

  it('carries no grid filter/sort/paging state — those can never invalidate', () => {
    // The tag's own key set IS the proof: nothing about the viewport is
    // captured, so re-sorting/re-filtering/paging cannot change the comparison.
    expect(Object.keys(tag()).sort()).toEqual([
      'baseAnchor',
      'column',
      'columnType',
      'cursor',
      'historyRevision',
      'overlayAnchor',
      'schemaSignature',
    ])
  })
})
