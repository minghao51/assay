import { describe, expect, it } from 'vitest'
import type { CellValue, EditOp, OverlayBase, OverlayState, RowId } from '@assay/domain'
import {
  appendOp,
  baseRowId,
  cellValueEqual,
  emptyHistory,
  foldOverlay,
  insertRowId,
  NULL_VALUE,
  parseRowId,
  stateAtCursor,
} from '@assay/domain'
import { isSchemaOp, projectOverlayOps } from './overlay-projection'
import { activeOps, overlaySnapshot } from './session'

const BASE: OverlayBase = {
  baseAnchor: 'fv-9-111',
  overlayAnchor: 'ov-1',
  columns: [
    { name: 'id', type: 'BIGINT' },
    { name: 'label', type: 'VARCHAR' },
    { name: 'amount', type: 'DOUBLE' },
  ],
  baseRowCount: 2,
}

const base0 = baseRowId(BASE.baseAnchor, 0)
const base1 = baseRowId(BASE.baseAnchor, 1)
const ins0 = insertRowId(BASE.overlayAnchor, 0)
const ins1 = insertRowId(BASE.overlayAnchor, 1)

/** A valid op sequence (no conflicts) exercising every projection rule. */
const OPS: EditOp[] = [
  // Base edit, then a later revert removes it.
  { kind: 'cell-set', rowId: base0, column: 'label', value: { kind: 'string', value: 'temp' } },
  { kind: 'cell-revert', rowId: base0, column: 'label' },
  // Base edit that stays (on a column that is later cast).
  { kind: 'cell-set', rowId: base0, column: 'amount', value: { kind: 'number', value: 12 } },
  // Insert with a seeded value, edited after creation.
  {
    kind: 'row-insert',
    rowId: ins0,
    position: { kind: 'start' },
    values: new Map([['label', { kind: 'string', value: 'seed' }]]),
  },
  { kind: 'cell-set', rowId: ins0, column: 'label', value: { kind: 'string', value: 'edited' } },
  { kind: 'cell-set', rowId: ins0, column: 'amount', value: { kind: 'null' } },
  // Schema ops (valid sequence; re-key accumulated edits and insert values).
  { kind: 'column-rename', from: 'label', to: 'tag' },
  { kind: 'column-cast', column: 'amount', targetType: 'DECIMAL(10,2)' },
  { kind: 'column-rename', from: 'id', to: 'key' },
  // Second insert, edited then reverted (restores the seeded value).
  {
    kind: 'row-insert',
    rowId: ins1,
    position: { kind: 'end' },
    values: new Map([['tag', { kind: 'string', value: 'seed1' }]]),
  },
  { kind: 'cell-set', rowId: ins1, column: 'tag', value: { kind: 'string', value: 'gone' } },
  { kind: 'cell-revert', rowId: ins1, column: 'tag' },
  // Tombstones.
  { kind: 'row-delete', rowId: base1 },
  { kind: 'row-delete', rowId: ins1 },
]

function foldOps(ops: readonly EditOp[]): OverlayState {
  return foldOverlay(BASE, ops).state
}

/** Effective cell semantics of the domain fold (see overlay.ts). */
function effectiveCell(state: OverlayState, rowId: RowId, column: string): CellValue | null {
  const inserted = state.inserts.get(rowId)
  if (inserted !== undefined) {
    return state.edits.get(rowId)?.get(column) ?? inserted.values.get(column) ?? NULL_VALUE
  }
  return state.edits.get(rowId)?.get(column) ?? null
}

/** Compare two folded states on the semantics the engine composes from. */
function expectSemanticallyEqual(a: OverlayState, b: OverlayState): void {
  expect(b.columns).toEqual(a.columns)
  expect([...b.deletedBase].sort((x, y) => x - y)).toEqual([...a.deletedBase].sort((x, y) => x - y))
  const liveInsertIds = (state: OverlayState): string[] =>
    [...state.inserts.values()]
      .filter((record) => record.live)
      .map((record) => record.id)
      .sort()
  expect(liveInsertIds(b)).toEqual(liveInsertIds(a))

  const rowIds = new Set<RowId>([...a.inserts.keys(), ...b.inserts.keys(), ...a.edits.keys()])
  const columns = a.columns.map((column) => column.name)
  for (const rowId of rowIds) {
    const parsed = parseRowId(rowId)
    if (parsed?.origin === 'insert' && (!a.inserts.has(rowId) || !b.inserts.has(rowId))) continue
    for (const column of columns) {
      const left = effectiveCell(a, rowId, column)
      const right = effectiveCell(b, rowId, column)
      if (left === null || right === null) {
        expect(right, `${rowId}.${column}`).toBe(left)
      } else {
        expect(cellValueEqual(left, right), `${rowId}.${column}`).toBe(true)
      }
    }
  }
}

describe('projectOverlayOps — the engine-facing projection is semantically faithful', () => {
  it('the projected op list folds to an equivalent effective state', () => {
    const state = foldOps(OPS)
    const projected = projectOverlayOps(BASE, state, OPS.filter(isSchemaOp))
    expectSemanticallyEqual(state, foldOps(projected))
  })

  it('folds inserted-row cell edits into the insert values (the engine gap)', () => {
    const state = foldOps(OPS)
    const projected = projectOverlayOps(BASE, state, OPS.filter(isSchemaOp))
    const insert = projected.find((op) => op.kind === 'row-insert' && op.rowId === ins0) as Extract<
      EditOp,
      { kind: 'row-insert' }
    >
    expect(insert.values.get('tag')).toEqual({ kind: 'string', value: 'edited' })
    expect(insert.values.get('amount')).toEqual({ kind: 'null' })
    // The engine never has to see an inserted-row cell-set.
    expect(
      projected.some(
        (op) =>
          (op.kind === 'cell-set' || op.kind === 'cell-revert') &&
          parseRowId(op.rowId)?.origin === 'insert',
      ),
    ).toBe(false)
  })

  it('restores an inserted row’s seeded value on cell-revert (not NULL)', () => {
    const state = foldOps(OPS)
    const projected = projectOverlayOps(BASE, state, OPS.filter(isSchemaOp))
    const insert = projected.find((op) => op.kind === 'row-insert' && op.rowId === ins1) as Extract<
      EditOp,
      { kind: 'row-insert' }
    >
    expect(insert.values.get('tag')).toEqual({ kind: 'string', value: 'seed1' })
  })

  it('replays the schema-op sequence verbatim so cyclic renames cannot collide', () => {
    // label→label_a, id→label, label_a→id: a legal freeing/reuse chain a
    // positional diff would rewrite into a colliding `id→label, label→id`.
    const ops: EditOp[] = [
      { kind: 'column-rename', from: 'label', to: 'label_a' },
      { kind: 'column-rename', from: 'id', to: 'label' },
      { kind: 'column-rename', from: 'label_a', to: 'id' },
    ]
    const state = foldOps(ops)
    const projected = projectOverlayOps(BASE, state, ops.filter(isSchemaOp))
    expect(projected.filter(isSchemaOp)).toEqual(ops)
    expect(foldOps(projected).columns).toEqual(state.columns)
  })

  it('emits base edits before tombstones and dead inserts as insert+delete', () => {
    const state = foldOps(OPS)
    const projected = projectOverlayOps(BASE, state, OPS.filter(isSchemaOp))
    const baseEditIndex = projected.findIndex((op) => op.kind === 'cell-set')
    const baseDeleteIndex = projected.findIndex(
      (op) => op.kind === 'row-delete' && op.rowId === base1,
    )
    expect(baseEditIndex).toBeGreaterThanOrEqual(0)
    expect(baseDeleteIndex).toBeGreaterThan(baseEditIndex)
    const ins1Insert = projected.findIndex((op) => op.kind === 'row-insert' && op.rowId === ins1)
    const ins1Delete = projected.findIndex((op) => op.kind === 'row-delete' && op.rowId === ins1)
    expect(ins1Insert).toBeGreaterThanOrEqual(0)
    expect(ins1Delete).toBe(ins1Insert + 1)
  })
})

describe('overlaySnapshot — end to end from a transformation history', () => {
  it('folds the active prefix, then projects (the engine sees a compose-safe list)', () => {
    let history = emptyHistory()
    const ops: EditOp[] = [
      { kind: 'row-insert', rowId: ins0, position: { kind: 'end' }, values: new Map() },
      { kind: 'cell-set', rowId: ins0, column: 'label', value: { kind: 'string', value: 'x' } },
    ]
    for (const op of ops) history = appendOp(BASE, history, op).history

    const snapshot = overlaySnapshot(BASE, history)
    const insert = snapshot.ops?.find((op) => op.kind === 'row-insert') as Extract<
      EditOp,
      { kind: 'row-insert' }
    >
    expect(insert.values.get('label')).toEqual({ kind: 'string', value: 'x' })
    // The raw history still contains both entries (the projection is
    // engine-facing only; undo/redo walk the untransformed log).
    expect(activeOps(history)).toEqual(ops)

    // A mid-history cursor projects a different (smaller) state.
    const half = { ...history, cursor: 1 }
    expect(stateAtCursor(BASE, half).edits.has(ins0)).toBe(false)
    expect(overlaySnapshot(BASE, half).ops).toHaveLength(1)
  })
})
