// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { NULL_VALUE, describeOp } from './edit-ops'
import type { CellValue, CellValueRecord, EditOp, InsertPosition } from './edit-ops'
import type { OpApplication, OverlayBase, OverlayState } from './overlay'
import {
  effectiveRowIds,
  foldOverlay,
  initialState,
  isLiveRow,
  liveRowCount,
  overlayEdit,
  stepOverlay,
} from './overlay'
import { baseRowId, insertRowId } from './row-identity'
import type { RowId } from './row-identity'
import {
  genBase,
  genGarbageOp,
  genOpSession,
  genValueRecord,
  makeTestRng,
} from './property-testing'

// Vitest 4 no longer leaks Node's ambient globals into test files (this pure
// package's lib is ES2022-only and it has no `@types/node`), so the platform
// `structuredClone` the immutability pins use needs a local ambient
// declaration. Type-only: the runtime global still comes from Node.
declare function structuredClone<T>(value: T): T

/** Fixture base: 3 columns, 5 base rows, fixed anchors. */
function makeBase(overrides: Partial<OverlayBase> = {}): OverlayBase {
  return {
    baseAnchor: 'file-v1',
    overlayAnchor: 'session-1',
    columns: [
      { name: 'id', type: 'BIGINT' },
      { name: 'label', type: 'VARCHAR' },
      { name: 'amount', type: 'DOUBLE' },
    ],
    baseRowCount: 5,
    ...overrides,
  }
}

const row = (ordinal: number): RowId => baseRowId('file-v1', ordinal)
const ins = (seq: number): RowId => insertRowId('session-1', seq)

const CELL_SET = (rowId: RowId, column: string, value: CellValue): EditOp => ({
  kind: 'cell-set',
  rowId,
  column,
  value,
})
const INSERT = (rowId: RowId, values: CellValueRecord, position: InsertPosition): EditOp => ({
  kind: 'row-insert',
  rowId,
  position,
  values,
})
const DELETE = (rowId: RowId): EditOp => ({ kind: 'row-delete', rowId })
const RESTORE = (rowId: RowId): EditOp => ({ kind: 'row-restore', rowId })
const RENAME = (from: string, to: string): EditOp => ({ kind: 'column-rename', from, to })
const CAST = (column: string, targetType: string): EditOp => ({
  kind: 'column-cast',
  column,
  targetType,
})

describe('overlay fold — cell ops', () => {
  it('records a first cell-set and derives cell-revert as its inverse', () => {
    const base = makeBase()
    const step = stepOverlay(
      base,
      initialState(base),
      CELL_SET(row(1), 'label', { kind: 'string', value: 'x' }),
    )
    expect(step.application.outcome).toEqual({ status: 'applied', notes: [] })
    expect(step.application.inverse).toEqual([
      { kind: 'cell-revert', rowId: row(1), column: 'label' },
    ])
    expect(overlayEdit(step.state, row(1), 'label')).toEqual({ kind: 'string', value: 'x' })
  })

  it('a second cell-set wins and its inverse restores the prior edit (not the base)', () => {
    const base = makeBase()
    const first = stepOverlay(
      base,
      initialState(base),
      CELL_SET(row(2), 'amount', { kind: 'number', value: 10 }),
    )
    const second = stepOverlay(
      base,
      first.state,
      CELL_SET(row(2), 'amount', { kind: 'number', value: 20 }),
    )
    expect(second.application.inverse).toEqual([
      { kind: 'cell-set', rowId: row(2), column: 'amount', value: { kind: 'number', value: 10 } },
    ])
    expect(overlayEdit(second.state, row(2), 'amount')).toEqual({ kind: 'number', value: 20 })
  })

  it('NULL is data: setting NULL records an edit, it is never "no change"', () => {
    const base = makeBase()
    const step = stepOverlay(base, initialState(base), CELL_SET(row(0), 'label', NULL_VALUE))
    expect(step.application.outcome.status).toBe('applied')
    expect(overlayEdit(step.state, row(0), 'label')).toEqual({ kind: 'null' })
    // Overlay is base-blind by design: an edit over an untouched cell always
    // applies, because "same as base" is not knowable without base data.
    expect(overlayEdit(initialState(base), row(0), 'label')).toBeNull()
  })

  it('setting the already-edited value is a no-op with Object.is equality (NaN pin)', () => {
    const base = makeBase()
    const nanState = stepOverlay(
      base,
      initialState(base),
      CELL_SET(row(0), 'amount', { kind: 'number', value: Number.NaN }),
    ).state
    const repeat = stepOverlay(
      base,
      nanState,
      CELL_SET(row(0), 'amount', { kind: 'number', value: Number.NaN }),
    )
    expect(repeat.application.outcome).toEqual({ status: 'no-op', reason: 'cell-value-unchanged' })
    expect(repeat.state).toBe(nanState)
    // But +0 and -0 differ (Object.is), so the write applies.
    const negZero = stepOverlay(
      base,
      stepOverlay(
        base,
        initialState(base),
        CELL_SET(row(0), 'amount', { kind: 'number', value: 0 }),
      ).state,
      CELL_SET(row(0), 'amount', { kind: 'number', value: -0 }),
    )
    expect(negZero.application.outcome.status).toBe('applied')
  })

  it('cell-revert drops the edit (and the empty row map) and its inverse restores it', () => {
    const base = makeBase()
    const set = stepOverlay(
      base,
      initialState(base),
      CELL_SET(row(3), 'label', { kind: 'string', value: 'x' }),
    )
    const revert = stepOverlay(base, set.state, {
      kind: 'cell-revert',
      rowId: row(3),
      column: 'label',
    })
    expect(revert.application.outcome).toEqual({ status: 'applied', notes: [] })
    expect(revert.state.edits.has(row(3))).toBe(false)
    expect(revert.application.inverse).toEqual([
      CELL_SET(row(3), 'label', { kind: 'string', value: 'x' }),
    ])
    const revertAgain = stepOverlay(base, revert.state, {
      kind: 'cell-revert',
      rowId: row(3),
      column: 'label',
    })
    expect(revertAgain.application.outcome).toEqual({
      status: 'no-op',
      reason: 'cell-already-base',
    })
  })

  it('cell ops surface the full typed conflict set, never throw', () => {
    const base = makeBase()
    const state = foldOverlay(base, [DELETE(row(0))]).state
    const cases: Array<[EditOp, string]> = [
      [CELL_SET(row(0), 'label', { kind: 'string', value: 'x' }), 'row-deleted'],
      [
        CELL_SET(baseRowId('other-file', 0), 'label', { kind: 'string', value: 'x' }),
        'row-anchor-mismatch',
      ],
      [CELL_SET(row(99), 'label', { kind: 'string', value: 'x' }), 'unknown-row'],
      [
        CELL_SET('not-a-row-id' as RowId, 'label', { kind: 'string', value: 'x' }),
        'malformed-row-id',
      ],
      [CELL_SET(row(1), 'ghost', { kind: 'string', value: 'x' }), 'unknown-column'],
      [{ kind: 'cell-revert', rowId: row(0), column: 'label' }, 'row-deleted'],
      [{ kind: 'cell-revert', rowId: row(1), column: 'ghost' }, 'unknown-column'],
      [
        INSERT(ins(0), new Map([['ghost', { kind: 'string', value: 'x' }]]), { kind: 'end' }),
        'unknown-column',
      ],
    ]
    for (const [op, reason] of cases) {
      const step = stepOverlay(base, state, op)
      expect(step.application.outcome).toEqual({ status: 'conflict', reason })
      expect(step.state).toBe(state)
    }
  })
})

describe('overlay fold — row ops', () => {
  it('row-insert applies with the overlay-assigned id, bumps the counter, and its inverse deletes', () => {
    const base = makeBase()
    const state = initialState(base)
    expect(state.nextInsertSeq).toBe(0)
    const step = stepOverlay(
      base,
      state,
      INSERT(ins(0), new Map([['label', { kind: 'string', value: 'new' }]]), { kind: 'end' }),
    )
    expect(step.application.outcome).toEqual({ status: 'applied', notes: [] })
    expect(step.state.nextInsertSeq).toBe(1)
    expect(step.state.inserts.get(ins(0))?.live).toBe(true)
    expect(step.state.inserts.get(ins(0))?.seq).toBe(0)
    expect(step.application.inverse).toEqual([{ kind: 'row-uninsert', rowId: ins(0) }])
  })

  it('duplicate insert: identical values replay as a no-op, different values conflict, spent ids conflict', () => {
    const base = makeBase()
    const values = new Map<string, CellValue>([['id', { kind: 'number', value: 1 }]])
    const first = stepOverlay(base, initialState(base), INSERT(ins(0), values, { kind: 'end' }))
    const replay = stepOverlay(base, first.state, INSERT(ins(0), values, { kind: 'end' }))
    expect(replay.application.outcome).toEqual({ status: 'no-op', reason: 'row-already-present' })
    const different = stepOverlay(
      base,
      first.state,
      INSERT(ins(0), new Map([['id', { kind: 'number', value: 2 }]]), { kind: 'end' }),
    )
    expect(different.application.outcome).toEqual({
      status: 'conflict',
      reason: 'insert-id-collision',
    })
    const tombstoned = foldOverlay(base, [
      INSERT(ins(0), values, { kind: 'end' }),
      DELETE(ins(0)),
    ]).state
    const resurrect = stepOverlay(base, tombstoned, INSERT(ins(1), values, { kind: 'end' }))
    expect(resurrect.application.outcome.status).toBe('applied')
    const ontoTombstone = stepOverlay(base, tombstoned, INSERT(ins(0), values, { kind: 'end' }))
    expect(ontoTombstone.application.outcome).toEqual({
      status: 'conflict',
      reason: 'insert-id-collision',
    })
  })

  it('insert replay treats absent ≡ explicit NULL per the materialization rule (AR-D1)', () => {
    const base = makeBase()
    // Same logical insert written two ways: omitted column vs explicit NULL.
    const omitted = new Map<string, CellValue>([['id', { kind: 'number', value: 1 }]])
    const explicit = new Map<string, CellValue>([
      ['id', { kind: 'number', value: 1 }],
      ['label', NULL_VALUE],
    ])
    const first = stepOverlay(base, initialState(base), INSERT(ins(0), omitted, { kind: 'end' }))
    const replayExplicit = stepOverlay(base, first.state, INSERT(ins(0), explicit, { kind: 'end' }))
    expect(replayExplicit.application.outcome).toEqual({
      status: 'no-op',
      reason: 'row-already-present',
    })
    // …and the mirror: explicit first, omitted replay.
    const explicitFirst = stepOverlay(
      base,
      initialState(base),
      INSERT(ins(0), explicit, { kind: 'end' }),
    )
    const replayOmitted = stepOverlay(
      base,
      explicitFirst.state,
      INSERT(ins(0), omitted, { kind: 'end' }),
    )
    expect(replayOmitted.application.outcome).toEqual({
      status: 'no-op',
      reason: 'row-already-present',
    })
    // A real value against an explicit NULL stays a genuine divergence.
    const withRealLabel = new Map<string, CellValue>([
      ['id', { kind: 'number', value: 1 }],
      ['label', { kind: 'string', value: 'x' }],
    ])
    expect(
      stepOverlay(base, first.state, INSERT(ins(0), withRealLabel, { kind: 'end' })).application
        .outcome,
    ).toEqual({ status: 'conflict', reason: 'insert-id-collision' })
    expect(
      stepOverlay(base, explicitFirst.state, INSERT(ins(0), withRealLabel, { kind: 'end' }))
        .application.outcome,
    ).toEqual({ status: 'conflict', reason: 'insert-id-collision' })
  })

  it('property (seeded): materialize(spec) ≡ materialize(spec + explicit NULLs) replays as a no-op', () => {
    for (const seed of [20260922, 77, 424242]) {
      const rng = makeTestRng(seed)
      for (let round = 0; round < 60; round++) {
        const base = genBase(rng, 'd1')
        const spec = genValueRecord(rng, base.columns)
        // Fill every absent column with an explicit NULL — the materialized
        // spelling of the same logical insert.
        const filled = new Map<string, CellValue>(Array.from(spec))
        for (const column of base.columns) {
          if (!filled.has(column.name)) filled.set(column.name, NULL_VALUE)
        }
        const first = stepOverlay(
          base,
          initialState(base),
          INSERT(insertRowId(base.overlayAnchor, 0), spec, { kind: 'end' }),
        )
        const replay = stepOverlay(
          base,
          first.state,
          INSERT(insertRowId(base.overlayAnchor, 0), filled, { kind: 'end' }),
        )
        expect(replay.application.outcome).toEqual({
          status: 'no-op',
          reason: 'row-already-present',
        })
      }
    }
  })

  it('insert ids are validated: session anchor, origin shape, canonical form, seq monotonicity', () => {
    const base = makeBase()
    const state = initialState(base)
    const cases: Array<[EditOp, string]> = [
      [
        INSERT(insertRowId('other-session', 0), new Map(), { kind: 'end' }),
        'insert-anchor-mismatch',
      ],
      [INSERT(row(0), new Map(), { kind: 'end' }), 'not-an-insert-id'],
      [INSERT('ins:session-1#007' as RowId, new Map(), { kind: 'end' }), 'malformed-row-id'],
    ]
    for (const [op, reason] of cases) {
      expect(stepOverlay(base, state, op).application.outcome).toEqual({
        status: 'conflict',
        reason,
      })
    }
    // A host that batch-allocates ahead is accepted; the counter jumps past it.
    const skip = stepOverlay(base, state, INSERT(ins(5), new Map(), { kind: 'end' }))
    expect(skip.application.outcome.status).toBe('applied')
    expect(skip.state.nextInsertSeq).toBe(6)
  })

  it('row-delete tombstones base rows (idempotent) and inserted rows alike', () => {
    const base = makeBase()
    const delBase = stepOverlay(base, initialState(base), DELETE(row(2)))
    expect(delBase.state.deletedBase).toEqual(new Set([2]))
    expect(delBase.application.inverse).toEqual([RESTORE(row(2))])
    const delAgain = stepOverlay(base, delBase.state, DELETE(row(2)))
    expect(delAgain.application.outcome).toEqual({ status: 'no-op', reason: 'row-already-deleted' })
    // Queue example: delete of an *inserted* row is a plain applied op —
    // a tombstone is exactly how deletes are represented.
    const withInsert = foldOverlay(base, [INSERT(ins(0), new Map(), { kind: 'end' })]).state
    const delInsert = stepOverlay(base, withInsert, DELETE(ins(0)))
    expect(delInsert.application.outcome).toEqual({ status: 'applied', notes: [] })
    expect(delInsert.state.inserts.get(ins(0))?.live).toBe(false)
    expect(stepOverlay(base, delInsert.state, DELETE(ins(0))).application.outcome).toEqual({
      status: 'no-op',
      reason: 'row-already-deleted',
    })
    const unknown = stepOverlay(base, initialState(base), DELETE(row(99)))
    expect(unknown.application.outcome).toEqual({ status: 'conflict', reason: 'unknown-row' })
  })

  it('row-uninsert expunges the record and reclaims top-of-stack allocation exactly', () => {
    const base = makeBase()
    const inserted = foldOverlay(base, [
      INSERT(ins(0), new Map([['id', { kind: 'number', value: 1 }]]), {
        kind: 'after',
        rowId: row(0),
      }),
      INSERT(ins(1), new Map(), { kind: 'end' }),
      CELL_SET(ins(1), 'label', { kind: 'string', value: 'x' }),
    ]).state
    // Interior expunge: record gone, allocation NOT reclaimed below live rows.
    const interior = stepOverlay(base, inserted, { kind: 'row-uninsert', rowId: ins(0) })
    expect(interior.state.inserts.has(ins(0))).toBe(false)
    expect(interior.state.nextInsertSeq).toBe(2)
    // Top-of-stack expunge: the seq is reclaimable again.
    const top = stepOverlay(base, interior.state, { kind: 'row-uninsert', rowId: ins(1) })
    expect(top.state.inserts.size).toBe(0)
    expect(top.state.nextInsertSeq).toBe(1)
    // Edits of the expunged row are gone too (a reclaimed id starts clean).
    expect(overlayEdit(top.state, ins(1), 'label')).toBeNull()
    // Its exact inverse is a small op list: re-insert + restore the edits.
    expect(top.application.inverse).toEqual([
      {
        kind: 'row-insert',
        rowId: ins(1),
        position: { kind: 'end' },
        values: new Map(),
      },
      { kind: 'cell-set', rowId: ins(1), column: 'label', value: { kind: 'string', value: 'x' } },
    ])
    let restored = top.state
    for (const inv of top.application.inverse) restored = stepOverlay(base, restored, inv).state
    expect(restored).toEqual(interior.state)
    // Unknown/foreign/shape errors are the typed conflicts, never throws.
    const state = initialState(base)
    expect(
      stepOverlay(base, state, { kind: 'row-uninsert', rowId: ins(3) }).application.outcome,
    ).toEqual({
      status: 'conflict',
      reason: 'unknown-row',
    })
    expect(
      stepOverlay(base, state, { kind: 'row-uninsert', rowId: insertRowId('other', 0) }).application
        .outcome,
    ).toEqual({
      status: 'conflict',
      reason: 'insert-anchor-mismatch',
    })
    expect(
      stepOverlay(base, state, { kind: 'row-uninsert', rowId: row(0) }).application.outcome,
    ).toEqual({
      status: 'conflict',
      reason: 'not-an-insert-id',
    })
  })

  it('row-restore is exact: values, position and cell edits survive the tombstone', () => {
    const base = makeBase()
    const ops: EditOp[] = [
      INSERT(ins(0), new Map([['label', { kind: 'string', value: 'kept' }]]), {
        kind: 'after',
        rowId: row(1),
      }),
      CELL_SET(ins(0), 'amount', { kind: 'number', value: 7 }),
      DELETE(ins(0)),
    ]
    const deleted = foldOverlay(base, ops)
    expect(deleted.state.inserts.get(ins(0))?.live).toBe(false)
    expect(liveRowCount(base, deleted.state)).toBe(base.baseRowCount)
    const restored = stepOverlay(base, deleted.state, RESTORE(ins(0)))
    expect(restored.state.inserts.get(ins(0))).toMatchObject({
      live: true,
      position: { kind: 'after', rowId: row(1) },
      seq: 0,
    })
    expect(overlayEdit(restored.state, ins(0), 'amount')).toEqual({ kind: 'number', value: 7 })
    expect(restored.application.inverse).toEqual([DELETE(ins(0))])
    expect(stepOverlay(base, restored.state, RESTORE(ins(0))).application.outcome).toEqual({
      status: 'no-op',
      reason: 'row-already-present',
    })
    // Base rows restore out of their tombstone set too.
    const baseRestore = stepOverlay(
      base,
      foldOverlay(base, [DELETE(row(4))]).state,
      RESTORE(row(4)),
    )
    expect(baseRestore.state.deletedBase.size).toBe(0)
  })

  it('uninserting a tombstoned insert restores it dead, edits intact (exact inverse list)', () => {
    const base = makeBase()
    const ops: EditOp[] = [
      INSERT(ins(0), new Map([['id', { kind: 'number', value: 9 }]]), { kind: 'end' }),
      CELL_SET(ins(0), 'label', { kind: 'string', value: 'v' }),
      DELETE(ins(0)),
      { kind: 'row-uninsert', rowId: ins(0) },
    ]
    const folded = foldOverlay(base, ops)
    expect(folded.state.inserts.has(ins(0))).toBe(false)
    const application = folded.applications[3]
    expect(application?.inverse).toEqual([
      {
        kind: 'row-insert',
        rowId: ins(0),
        position: { kind: 'end' },
        values: new Map([['id', { kind: 'number', value: 9 }]]),
      },
      { kind: 'cell-set', rowId: ins(0), column: 'label', value: { kind: 'string', value: 'v' } },
      { kind: 'row-delete', rowId: ins(0) },
    ])
    // Composing the inverse list reproduces the exact pre-expunge state.
    let state = folded.state
    for (const inverseOp of application?.inverse ?? [])
      state = stepOverlay(base, state, inverseOp).state
    expect(state).toEqual(foldOverlay(base, ops.slice(0, 3)).state)
  })
})

describe('overlay fold — the queue’s conflict examples, ruled explicitly', () => {
  it('edit of a deleted row → conflict row-deleted (intent not honorable, never silently dropped)', () => {
    const base = makeBase()
    const state = foldOverlay(base, [DELETE(row(1))]).state
    expect(
      stepOverlay(base, state, CELL_SET(row(1), 'label', { kind: 'string', value: 'x' }))
        .application.outcome,
    ).toEqual({
      status: 'conflict',
      reason: 'row-deleted',
    })
  })

  it('rename onto an existing name → conflict rename-collision', () => {
    const base = makeBase()
    expect(
      stepOverlay(base, initialState(base), RENAME('label', 'amount')).application.outcome,
    ).toEqual({
      status: 'conflict',
      reason: 'rename-collision',
    })
  })

  it('cast of a missing column → conflict unknown-column', () => {
    const base = makeBase()
    expect(
      stepOverlay(base, initialState(base), CAST('ghost', 'BIGINT')).application.outcome,
    ).toEqual({
      status: 'conflict',
      reason: 'unknown-column',
    })
  })
})

describe('overlay fold — effective order (insert positions)', () => {
  it('emits start/end/before/after positions around base rows deterministically', () => {
    const base = makeBase({ baseRowCount: 3 })
    const ops: EditOp[] = [
      INSERT(ins(0), new Map(), { kind: 'start' }),
      INSERT(ins(1), new Map(), { kind: 'end' }),
      INSERT(ins(2), new Map(), { kind: 'after', rowId: row(0) }),
      INSERT(ins(3), new Map(), { kind: 'before', rowId: row(2) }),
    ]
    const { state } = foldOverlay(base, ops)
    expect(effectiveRowIds(base, state)).toEqual([
      ins(0),
      row(0),
      ins(2),
      row(1),
      ins(3),
      row(2),
      ins(1),
    ])
  })

  it('same-anchor inserts stack in application order; chains nest depth-first', () => {
    const base = makeBase({ baseRowCount: 1 })
    const ops: EditOp[] = [
      INSERT(ins(0), new Map(), { kind: 'after', rowId: row(0) }),
      INSERT(ins(1), new Map(), { kind: 'after', rowId: row(0) }),
      INSERT(ins(2), new Map(), { kind: 'after', rowId: ins(0) }),
    ]
    const { state } = foldOverlay(base, ops)
    expect(effectiveRowIds(base, state)).toEqual([row(0), ins(0), ins(2), ins(1)])
  })

  it('multi-before chains emit latest-closest to the anchor; multi-after emit earliest-closest (AR-D2)', () => {
    // Engine-side mirror: `insertSortKeys` in
    // `packages/engine-duckdb/src/overlay-query.ts` composes the same order
    // in SQL — a future engine pin can lift this domain pin's expectations.
    const base = makeBase({ baseRowCount: 1 })
    const ops: EditOp[] = [
      INSERT(ins(0), new Map(), { kind: 'before', rowId: row(0) }),
      INSERT(ins(1), new Map(), { kind: 'before', rowId: row(0) }),
      INSERT(ins(2), new Map(), { kind: 'before', rowId: row(0) }),
      INSERT(ins(3), new Map(), { kind: 'after', rowId: row(0) }),
      INSERT(ins(4), new Map(), { kind: 'after', rowId: row(0) }),
    ]
    const { state } = foldOverlay(base, ops)
    // Reading away from the anchor: `before` chains emit ascending sequence
    // (latest, ins(2), sits closest to row 0); `after` chains emit ascending
    // sequence too (earliest, ins(3), sits closest to row 0).
    expect(effectiveRowIds(base, state)).toEqual([ins(0), ins(1), ins(2), row(0), ins(3), ins(4)])
  })

  it('nested before-chains nest depth-first, latest-closest at each level (AR-D2)', () => {
    const base = makeBase({ baseRowCount: 1 })
    const ops: EditOp[] = [
      INSERT(ins(0), new Map(), { kind: 'before', rowId: row(0) }),
      INSERT(ins(1), new Map(), { kind: 'before', rowId: ins(0) }),
    ]
    const { state } = foldOverlay(base, ops)
    // ins(1) is before ins(0), which is before row 0: depth-first.
    expect(effectiveRowIds(base, state)).toEqual([ins(1), ins(0), row(0)])
  })

  it('degraded anchors fall to the end and the outcome says so honestly', () => {
    const base = makeBase({ baseRowCount: 2 })
    const first = stepOverlay(
      base,
      initialState(base),
      INSERT(ins(0), new Map(), { kind: 'after', rowId: row(0) }),
    )
    expect(first.application.outcome).toEqual({ status: 'applied', notes: [] })
    // Anchor to a row that does not exist: applied, with a typed note.
    const ghost = stepOverlay(
      base,
      initialState(base),
      INSERT(ins(0), new Map(), { kind: 'before', rowId: row(9) }),
    )
    expect(ghost.application.outcome).toEqual({
      status: 'applied',
      notes: ['position-anchor-not-live'],
    })
    // Anchor to a row that is later deleted: emission degrades to the end.
    const state = foldOverlay(base, [
      INSERT(ins(0), new Map(), { kind: 'after', rowId: row(0) }),
      DELETE(row(0)),
    ]).state
    expect(effectiveRowIds(base, state)).toEqual([row(1), ins(0)])
  })
})

describe('overlay fold — schema ops', () => {
  it('rename rekeys the schema, accumulated edits and insert values (live and tombstoned)', () => {
    const base = makeBase()
    const before = foldOverlay(base, [
      CELL_SET(row(0), 'label', { kind: 'string', value: 'edited' }),
      INSERT(ins(0), new Map([['label', { kind: 'string', value: 'inserted' }]]), { kind: 'end' }),
      DELETE(ins(0)),
    ]).state
    const renamed = stepOverlay(base, before, RENAME('label', 'title'))
    expect(renamed.application.outcome).toEqual({ status: 'applied', notes: [] })
    expect(renamed.state.columns.map((c) => c.name)).toEqual(['id', 'title', 'amount'])
    expect(overlayEdit(renamed.state, row(0), 'title')).toEqual({ kind: 'string', value: 'edited' })
    expect(overlayEdit(renamed.state, row(0), 'label')).toBeNull()
    expect(renamed.state.inserts.get(ins(0))?.values.get('title')).toEqual({
      kind: 'string',
      value: 'inserted',
    })
    expect(renamed.application.inverse).toEqual([RENAME('title', 'label')])
    const undone = stepOverlay(base, renamed.state, RENAME('title', 'label'))
    expect(undone.state).toEqual(before)
  })

  it('rename rules: identity is a no-op, collisions conflict, unknown source conflicts', () => {
    const base = makeBase()
    const state = initialState(base)
    expect(stepOverlay(base, state, RENAME('label', 'label')).application.outcome).toEqual({
      status: 'no-op',
      reason: 'rename-identity',
    })
    expect(stepOverlay(base, state, RENAME('ghost', 'x')).application.outcome).toEqual({
      status: 'conflict',
      reason: 'unknown-column',
    })
    expect(stepOverlay(base, state, RENAME('label', 'amount')).application.outcome).toEqual({
      status: 'conflict',
      reason: 'rename-collision',
    })
  })

  it('cast swaps the declared type, keeps values untouched, and inverts to cast-back', () => {
    const base = makeBase()
    const edited = foldOverlay(base, [
      CELL_SET(row(0), 'amount', { kind: 'number', value: 3 }),
    ]).state
    const cast = stepOverlay(base, edited, CAST('amount', 'DECIMAL(18,3)'))
    expect(cast.state.columns.find((c) => c.name === 'amount')?.type).toBe('DECIMAL(18,3)')
    expect(cast.application.inverse).toEqual([CAST('amount', 'DOUBLE')])
    // Cast-back restores the schema fold exactly.
    expect(stepOverlay(base, cast.state, CAST('amount', 'DOUBLE')).state).toEqual(edited)
    expect(stepOverlay(base, edited, CAST('amount', 'DOUBLE')).application.outcome).toEqual({
      status: 'no-op',
      reason: 'cast-identity',
    })
  })
})

describe('property: fold ∘ unfold (inverse walks restore the base projection)', () => {
  it('applying derived inverses in reverse order returns exactly the initial state, refold entries excepted', () => {
    for (const seed of [20260918, 7, 12345, 99991]) {
      const rng = makeTestRng(seed)
      for (let session = 0; session < 40; session++) {
        const base = genBase(rng, 'prop')
        const length = rng.int(0, 25)
        const { ops } = genOpSession(rng, base, length)
        const folded = foldOverlay(base, ops)
        let state = folded.state
        let appliedRepairs = 0
        for (let i = folded.applications.length - 1; i >= 0; i--) {
          const application = folded.applications[i] as OpApplication
          if (application.inverse.length === 0) {
            // The ADR 0050 narrowing of the walk invariant: an empty inverse
            // is either nothing-to-undo (no-op/conflict) or the recorded
            // exception — an applied `column-repair` entry, whose undo is the
            // exact refold at the cursor and whose applied outcome carries
            // the 'undo-by-refold' note.
            if (application.outcome.status === 'applied') {
              expect(application.op.kind).toBe('column-repair')
              expect(application.outcome.notes).toContain('undo-by-refold')
              appliedRepairs += 1
            } else {
              // No-op or conflict: nothing to undo, state must not have
              // changed. The narrowing makes 'applied' unreachable in this
              // branch — the if/else itself is the walk invariant.
            }
            continue
          }
          // Global direction, every kind: a non-empty inverse implies applied.
          expect(application.outcome.status).toBe('applied')
          // Undo never sticks for logs built by the fold: the inverse ops
          // were derived against exactly this state, so every one applies.
          for (const inverseOp of application.inverse) {
            const step = stepOverlay(base, state, inverseOp)
            expect(step.application.outcome.status).toBe('applied')
            state = step.state
          }
        }
        // Inverse walks restore every invertible field exactly; the recorded
        // refold entries survive as the repair chain — one per applied repair.
        expect({ ...state, repairs: [] }).toEqual(initialState(base))
        expect(state.repairs).toHaveLength(appliedRepairs)
      }
    }
  })
})

describe('property: inverses are true inverses', () => {
  it('fold(prefix + op + inverse(op)) ≡ fold(prefix) for every applied op', () => {
    for (const seed of [424242, 314, 271828]) {
      const rng = makeTestRng(seed)
      for (let session = 0; session < 25; session++) {
        const base = genBase(rng, 'inv')
        const length = rng.int(1, 20)
        const { ops, states } = genOpSession(rng, base, length)
        const { applications } = foldOverlay(base, ops)
        for (let i = 0; i < ops.length; i++) {
          const application = applications[i] as OpApplication
          if (application.inverse.length === 0) continue
          expect(application.outcome.status).toBe('applied')
          // ADR 0050 boundary: when the prefix already carries an applied
          // repair on the SAME column, the inverse walk of a later value-op
          // would re-derive that repair's per-row masking — which is a
          // function of the prefix (the op list), not of a local (state, op)
          // transition, so the inverse-materialized state can legitimately
          // differ from the refold in `maskedRows` only (documented on
          // `RepairStepRecord.maskedRows`). Undo's authority is the refold;
          // the shipped path never materializes inverses. Skip exactly that
          // class — same column identity (index), value-op kinds only.
          const op = ops[i] as EditOp
          const opColumn = op.kind === 'cell-set' || op.kind === 'cell-revert' ? op.column : null
          if (opColumn !== null) {
            const stateBefore = states[i] as OverlayState
            const columnIndex = stateBefore.columns.findIndex((c) => c.name === opColumn)
            if (
              columnIndex >= 0 &&
              stateBefore.repairs.some((record) => record.columnIndex === columnIndex)
            ) {
              continue
            }
          }
          const withInverse = [...ops.slice(0, i + 1), ...application.inverse]
          expect(foldOverlay(base, withInverse).state).toEqual(states[i])
        }
      }
    }
  })
})

describe('property: identity stability under the overlay', () => {
  it('insert ids are unique and insert-origin, live row counts stay consistent, base ids never collide', () => {
    for (const seed of [8888, 61, 4096]) {
      const rng = makeTestRng(seed)
      for (let session = 0; session < 30; session++) {
        const base = genBase(rng, 'ids')
        const length = rng.int(1, 25)
        const { ops, states } = genOpSession(rng, base, length)
        for (const state of states) {
          const ids = [...state.inserts.keys()]
          expect(new Set(ids).size).toBe(ids.length)
          const liveIds = effectiveRowIds(base, state)
          expect(new Set(liveIds).size).toBe(liveIds.length)
          expect(liveRowCount(base, state)).toBe(liveIds.length)
          for (const id of ids) expect(id.startsWith('ins:')).toBe(true)
          for (let ordinal = 0; ordinal < base.baseRowCount; ordinal++) {
            expect(ids).not.toContain(baseRowId(base.baseAnchor, ordinal))
          }
          // The overlay’s counter never rewinds below any allocated seq.
          for (const id of ids) {
            const parsed = /^ins:(.*)#(\d+)$/.exec(id)
            if (parsed && parsed[1] === base.overlayAnchor) {
              expect(state.nextInsertSeq).toBeGreaterThan(Number(parsed[2]))
            }
          }
        }
        // Determinism: refolding the same ops yields the identical state.
        expect(foldOverlay(base, ops).state).toEqual(states[states.length - 1])
      }
    }
  })
})

describe('property: the fold is total, typed, and pure', () => {
  it('garbage ops never throw, only mutate on applied, and use closed reason sets', () => {
    const NO_OP_REASONS = new Set([
      'cell-value-unchanged',
      'cell-already-base',
      'row-already-deleted',
      'row-already-present',
      'rename-identity',
      'cast-identity',
    ])
    const CONFLICT_REASONS = new Set([
      'malformed-row-id',
      'not-an-insert-id',
      'row-anchor-mismatch',
      'insert-anchor-mismatch',
      'unknown-row',
      'row-deleted',
      'unknown-column',
      'rename-collision',
      'insert-id-collision',
      'state-anchor-mismatch',
    ])
    for (const seed of [5150, 2, 31337]) {
      const rng = makeTestRng(seed)
      for (let round = 0; round < 200; round++) {
        const base = genBase(rng, 'fuzz')
        let state = initialState(base)
        for (let i = 0; i < 10; i++) {
          const op = genGarbageOp(rng)
          const snapshot = structuredClone(state)
          const step = stepOverlay(base, state, op)
          const outcome = step.application.outcome
          if (outcome.status === 'applied') {
            expect(outcome.notes.every((n) => n === 'position-anchor-not-live')).toBe(true)
            expect(step.state).not.toBe(state)
          } else if (outcome.status === 'no-op') {
            expect(NO_OP_REASONS.has(outcome.reason)).toBe(true)
            expect(step.state).toBe(state)
          } else {
            expect(CONFLICT_REASONS.has(outcome.reason)).toBe(true)
            expect(step.state).toBe(state)
            expect(step.application.inverse).toEqual([])
          }
          expect(step.state).toEqual(snapshot)
          state = step.state
        }
      }
    }
  })

  it('folding never mutates the ops it interprets', () => {
    const rng = makeTestRng(1970)
    for (let round = 0; round < 20; round++) {
      const base = genBase(rng, 'pure')
      const { ops } = genOpSession(rng, base, 15, 0.05)
      const snapshot = structuredClone(ops)
      foldOverlay(base, ops)
      expect(ops).toEqual(snapshot)
    }
  })

  it('isLiveRow and cellValueEqual agree with the fold at every step', () => {
    const rng = makeTestRng(555)
    for (let round = 0; round < 20; round++) {
      const base = genBase(rng, 'live')
      const { states } = genOpSession(rng, base, 15)
      for (const state of states) {
        for (let ordinal = 0; ordinal < base.baseRowCount; ordinal++) {
          const id = baseRowId(base.baseAnchor, ordinal)
          expect(isLiveRow(base, state, id)).toBe(!state.deletedBase.has(ordinal))
        }
        for (const [id, record] of state.inserts) {
          expect(isLiveRow(base, state, id)).toBe(record.live)
        }
      }
    }
  })
})

describe('overlay fold — the state is bound to its anchors (AR-D8)', () => {
  it('initialState records the base/overlay anchors', () => {
    const base = makeBase()
    expect(initialState(base).anchors).toEqual({
      baseAnchor: 'file-v1',
      overlayAnchor: 'session-1',
    })
  })

  it('a state folded against another base/session is a typed conflict, never a silent cross-application', () => {
    const base = makeBase()
    const foreignBase = makeBase({ baseAnchor: 'file-v2', overlayAnchor: 'session-1' })
    const foreignSession = makeBase({ baseAnchor: 'file-v1', overlayAnchor: 'session-2' })
    const state = foldOverlay(base, [DELETE(row(0))]).state
    for (const other of [foreignBase, foreignSession]) {
      const step = stepOverlay(other, state, DELETE(row(1)))
      expect(step.application.outcome).toEqual({
        status: 'conflict',
        reason: 'state-anchor-mismatch',
      })
      expect(step.state).toBe(state) // untouched
    }
    // The matching base still applies.
    expect(stepOverlay(base, state, DELETE(row(1))).application.outcome.status).toBe('applied')
  })
})

describe('overlay fold — mechanical guarantees', () => {
  it('non-applied steps return the identical state reference; applied steps do not', () => {
    const base = makeBase()
    const state = initialState(base)
    const conflict = stepOverlay(base, state, CELL_SET(row(99), 'id', { kind: 'number', value: 1 }))
    expect(conflict.state).toBe(state)
    const applied = stepOverlay(base, state, CELL_SET(row(0), 'id', { kind: 'number', value: 1 }))
    expect(applied.state).not.toBe(state)
  })

  it('describes ops honestly — NULL is NULL, never "empty"', () => {
    expect(describeOp(CELL_SET(row(1), 'label', NULL_VALUE))).toBe(
      'set "label" on row base:file-v1#1 to NULL',
    )
    expect(describeOp(CELL_SET(row(1), 'label', { kind: 'string', value: 'a"b' }))).toBe(
      'set "label" on row base:file-v1#1 to "a\\"b"',
    )
    expect(describeOp({ kind: 'cell-revert', rowId: row(0), column: 'amount' })).toBe(
      'revert "amount" on row base:file-v1#0 to base value',
    )
    expect(describeOp(INSERT(ins(3), new Map(), { kind: 'after', rowId: row(2) }))).toBe(
      'insert row ins:session-1#3 after row base:file-v1#2',
    )
    expect(describeOp(DELETE(row(4)))).toBe('delete row base:file-v1#4')
    expect(describeOp(RENAME('a', 'b'))).toBe('rename column "a" to "b"')
    expect(describeOp(CAST('amount', 'BIGINT'))).toBe('cast column "amount" to BIGINT')
    // Deterministic (renderable in a history panel, loggable as plain text).
    expect(describeOp(CELL_SET(row(0), 'id', { kind: 'number', value: 5 }))).toBe(
      describeOp(CELL_SET(row(0), 'id', { kind: 'number', value: 5 })),
    )
  })

  it('an unknown op kind is a compile-time exhaustiveness error, and existing kinds are closed', () => {
    // Type-level pin: every op kind is handled by the fold (compile would
    // fail otherwise); runtime check that all kinds flow through stepOverlay.
    const base = makeBase()
    const kinds = new Set([
      'cell-set',
      'cell-revert',
      'row-insert',
      'row-uninsert',
      'row-delete',
      'row-restore',
      'column-rename',
      'column-cast',
    ])
    expect(kinds.size).toBe(8)
    // Smoke: one op per kind steps without throwing.
    const ops: EditOp[] = [
      CELL_SET(row(0), 'id', { kind: 'number', value: 9 }),
      { kind: 'cell-revert', rowId: row(0), column: 'id' },
      INSERT(ins(0), new Map(), { kind: 'end' }),
      { kind: 'row-uninsert', rowId: ins(0) },
      DELETE(row(0)),
      RESTORE(row(0)),
      RENAME('label', 'name'),
      CAST('name', 'TEXT'),
    ]
    for (const op of ops) expect(() => stepOverlay(base, initialState(base), op)).not.toThrow()
  })
})
