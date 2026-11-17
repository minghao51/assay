// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import type { CellValue, EditOp } from './edit-ops'
import { DEFAULT_REPAIR_TRIM_CODE_POINTS, OP_UNDO_MODE } from './edit-ops'
import type { OverlayBase } from './overlay'
import { foldOverlay } from './overlay'
import { appendOp, emptyHistory, redo, stateAtCursor, undo } from './history'
import type { TransformationHistory } from './history'
import { baseRowId, insertRowId } from './row-identity'
import type { RowId } from './row-identity'
import { genBase, genOp, makeTestRng } from './property-testing'

// Vitest 4 no longer leaks Node's ambient globals into test files (this pure
// package's lib is ES2022-only and it has no `@types/node`), so the platform
// `structuredClone` the immutability pins use needs a local ambient
// declaration. Type-only: the runtime global still comes from Node.
declare function structuredClone<T>(value: T): T

function makeBase(overrides: Partial<OverlayBase> = {}): OverlayBase {
  return {
    baseAnchor: 'file-v1',
    overlayAnchor: 'session-1',
    columns: [
      { name: 'id', type: 'BIGINT' },
      { name: 'label', type: 'VARCHAR' },
    ],
    baseRowCount: 4,
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

/**
 * A P1 repair arm (ADR 0050 decision 3): a valid `column-repair` on a live
 * textual column of the current state, with the non-commuting P8 mapping
 * pool, so the walk below exercises repair entries through append/undo/redo.
 * The shared `genOp` now carries its own repair arm (this row's fix commit);
 * this local arm is kept as the walk's dedicated high-frequency repair
 * source — the two pools differ (the shared arm adds trim-spec-mismatch
 * conflicts and identity no-ops across all properties).
 */
function genRepairArm(
  state: import('./overlay').OverlayState,
  rng: ReturnType<typeof makeTestRng>,
): EditOp {
  const textual = state.columns.filter((column) =>
    ['VARCHAR', 'TEXT', 'STRING'].includes(column.type.toUpperCase()),
  )
  const column = textual.length > 0 ? rng.pick(textual).name : 'label'
  const pool: ReadonlyArray<readonly [string, string]> = [
    ['old', 'middle'],
    ['middle', 'final'],
    ['old', 'new'],
    ['a', 'b'],
  ]
  const mapping = new Map<string, string>()
  const pairs = rng.int(1, 3)
  for (let i = 0; i < pairs; i++) {
    const [from, to] = pool[rng.int(0, pool.length - 1)] as readonly [string, string]
    mapping.set(from, to)
  }
  return {
    kind: 'column-repair',
    column,
    ...(rng.bool(0.7) ? { trim: DEFAULT_REPAIR_TRIM_CODE_POINTS } : {}),
    mapping,
  }
}
const INSERT = (rowId: RowId): EditOp => ({
  kind: 'row-insert',
  rowId,
  position: { kind: 'end' },
  values: new Map<string, CellValue>(),
})
const DELETE = (rowId: RowId): EditOp => ({ kind: 'row-delete', rowId })

describe('history — cursor boundaries', () => {
  it('an empty history cannot undo or redo and never changes', () => {
    const history = emptyHistory()
    expect(history.entries).toEqual([])
    expect(history.cursor).toBe(0)
    expect(undo(history).entry).toBeNull()
    expect(redo(history).entry).toBeNull()
    expect(undo(history).history).toBe(history)
    expect(redo(history).history).toBe(history)
  })

  it('undo to start and redo to end pin their edges honestly', () => {
    const base = makeBase()
    let history = emptyHistory()
    for (const op of [
      CELL_SET(row(0), 'id', { kind: 'number', value: 1 }),
      INSERT(ins(0)),
      DELETE(row(1)),
    ]) {
      history = appendOp(base, history, op).history
    }
    expect(history.cursor).toBe(3)
    // Redo at the end: nothing to re-apply.
    expect(redo(history).entry).toBeNull()
    expect(redo(history).history).toBe(history)
    // Walk back to the start; one more undo is a no-op.
    let steps = 0
    while (history.cursor > 0) {
      const result = undo(history)
      expect(result.entry).not.toBeNull()
      history = result.history
      steps++
    }
    expect(steps).toBe(3)
    expect(undo(history).entry).toBeNull()
    // Walk forward again; redo at the end stops exactly at entries.length.
    let redone = 0
    while (redo(history).entry !== null) {
      history = redo(history).history
      redone++
      if (redone > 10) throw new Error('redo walked past the end')
    }
    expect(redone).toBe(3)
    expect(history.cursor).toBe(history.entries.length)
  })
})

describe('history — append semantics', () => {
  it('appends applied ops with their derived inverse and advances the cursor', () => {
    const base = makeBase()
    const history = emptyHistory()
    const result = appendOp(
      base,
      history,
      CELL_SET(row(2), 'label', { kind: 'string', value: 'x' }),
    )
    expect(result.entry).not.toBeNull()
    expect(result.entry?.inverse).toEqual([{ kind: 'cell-revert', rowId: row(2), column: 'label' }])
    expect(result.history.entries.length).toBe(1)
    expect(result.history.cursor).toBe(1)
    expect(history.entries.length).toBe(0) // input untouched
  })

  it('appends no-op entries (inverse null) so undo/redo skip materializing them', () => {
    const base = makeBase()
    let history = appendOp(
      base,
      emptyHistory(),
      CELL_SET(row(0), 'id', { kind: 'number', value: 5 }),
    ).history
    history = appendOp(base, history, CELL_SET(row(0), 'id', { kind: 'number', value: 5 })).history
    const entry = history.entries[1]
    expect(entry?.outcome).toEqual({ status: 'no-op', reason: 'cell-value-unchanged' })
    expect(entry?.inverse).toEqual([])
    const step = undo(history)
    expect(step.entry?.outcome.status).toBe('no-op') // caller materializes nothing
    expect(step.history.cursor).toBe(1)
  })

  it('refuses conflicted ops: same history reference, no entry, typed conflict out', () => {
    const base = makeBase()
    const history = appendOp(base, emptyHistory(), DELETE(row(1))).history
    const before = history
    const result = appendOp(
      base,
      history,
      CELL_SET(row(1), 'label', { kind: 'string', value: 'x' }),
    )
    expect(result.entry).toBeNull()
    expect(result.outcome).toEqual({ status: 'conflict', reason: 'row-deleted' })
    expect(result.history).toBe(history)
    expect(history).toBe(before)
    expect(history.entries.length).toBe(1)
  })
})

describe('history — undo/redo payloads and the fold contract', () => {
  it('undo returns the entry being undone (with its inverse); redo returns the entry being re-applied', () => {
    const base = makeBase()
    let history = emptyHistory()
    const op = CELL_SET(row(3), 'label', { kind: 'string', value: 'x' })
    history = appendOp(base, history, op).history
    const undone = undo(history)
    expect(undone.entry?.op).toEqual(op)
    expect(undone.entry?.inverse).toEqual([{ kind: 'cell-revert', rowId: row(3), column: 'label' }])
    const redone = redo(undone.history)
    expect(redone.entry?.op).toEqual(op)
    expect(redone.entry?.outcome.status).toBe('applied')
    expect(redone.history.cursor).toBe(1)
  })

  it('stateAtCursor always equals the fold of the active prefix', () => {
    const base = makeBase()
    let history = emptyHistory()
    const ops = [
      CELL_SET(row(0), 'id', { kind: 'number', value: 1 }),
      INSERT(ins(0)),
      DELETE(row(2)),
      CELL_SET(ins(0), 'label', { kind: 'string', value: 'v' }),
    ]
    for (const op of ops) {
      history = appendOp(base, history, op).history
      const active = history.entries.slice(0, history.cursor).map((e) => e.op)
      expect(stateAtCursor(base, history)).toEqual(foldOverlay(base, active).state)
    }
    history = undo(history).history
    history = undo(history).history
    const active = history.entries.slice(0, history.cursor).map((e) => e.op)
    expect(stateAtCursor(base, history)).toEqual(foldOverlay(base, active).state)
  })
})

describe('history — undo → new op → redo is branch truncation (the ruling)', () => {
  it('appending after undo drops the redo tail; redo then reports nothing', () => {
    const base = makeBase()
    let history = emptyHistory()
    history = appendOp(base, history, CELL_SET(row(0), 'id', { kind: 'number', value: 1 })).history
    history = appendOp(base, history, CELL_SET(row(1), 'id', { kind: 'number', value: 2 })).history
    history = undo(history).history // cursor 1; entry #2 (id=2) is redoable
    const branched = appendOp(
      base,
      history,
      CELL_SET(row(1), 'label', { kind: 'string', value: 'new' }),
    )
    expect(branched.entry).not.toBeNull()
    // Truncation: the abandoned tail is gone from the active log.
    expect(branched.history.entries.length).toBe(2)
    expect(branched.history.cursor).toBe(2)
    expect(redo(branched.history).entry).toBeNull()
    // The dropped entry was the stale one, not the new one.
    expect(branched.history.entries[1]?.op).toEqual(
      CELL_SET(row(1), 'label', { kind: 'string', value: 'new' }),
    )
  })

  it('truncation never mutates: the pre-branch history object stays intact', () => {
    const base = makeBase()
    let history = emptyHistory()
    history = appendOp(base, history, CELL_SET(row(0), 'id', { kind: 'number', value: 1 })).history
    history = appendOp(base, history, CELL_SET(row(1), 'id', { kind: 'number', value: 2 })).history
    const undone = undo(history)
    const branched = appendOp(base, undone.history, INSERT(ins(9)))
    // The undo'd history still holds both entries (a persistent structure —
    // a caller may keep or fork from it); the new one dropped the tail.
    expect(undone.history.entries.length).toBe(2)
    expect(history.entries.length).toBe(2)
    expect(branched.history.entries.length).toBe(2)
    expect(branched.history.entries[0]).toBe(history.entries[0]) // shared prefix by reference
  })
})

describe('history — immutability and purity', () => {
  it('no operation mutates the input history (deep snapshot pin)', () => {
    const base = makeBase()
    let history = emptyHistory()
    for (const op of [
      CELL_SET(row(0), 'id', { kind: 'number', value: 1 }),
      INSERT(ins(0)),
      DELETE(row(0)),
      DELETE(row(0)),
    ]) {
      const snapshot = structuredClone(history)
      const result = appendOp(base, history, op)
      // The history handed to appendOp is byte-for-byte what it was before.
      expect(history).toEqual(snapshot)
      history = result.history
    }
    const beforeUndo = structuredClone(history)
    const undone = undo(history)
    expect(history).toEqual(beforeUndo)
    expect(undone.history).not.toBe(history)
    const beforeRedo = structuredClone(undone.history)
    const redone = redo(undone.history)
    expect(undone.history).toEqual(beforeRedo)
    expect(redone.history.cursor).toBe(beforeRedo.cursor + 1)
  })
})

describe('property: history walks', () => {
  it('random append/undo/redo sessions keep cursor, fold, and state invariants', () => {
    for (const seed of [2026, 88, 404]) {
      const rng = makeTestRng(seed)
      for (let session = 0; session < 30; session++) {
        const base = genBase(rng, 'hist')
        let history: TransformationHistory = emptyHistory()
        for (let stepCount = 0; stepCount < 25; stepCount++) {
          const roll = rng.float()
          if (roll < 0.6) {
            const currentState = stateAtCursor(base, history)
            // P1 repair arm: ~1 in 6 appends is a column-repair, so every
            // invariant below is exercised with repair entries in the log.
            const op = rng.bool(1 / 6)
              ? genRepairArm(currentState, rng)
              : genOp(rng, base, currentState, rng.bool(0.1))
            const snapshot = structuredClone(history)
            const result = appendOp(base, history, op)
            expect(history).toEqual(snapshot) // input never mutated
            history = result.history
            expect(history.cursor).toBeLessThanOrEqual(history.entries.length)
            expect(history.cursor).toBeGreaterThanOrEqual(0)
            if (result.entry !== null) expect(history.cursor).toBe(history.entries.length)
          } else if (roll < 0.8) {
            const step = undo(history)
            if (history.cursor > 0) {
              expect(step.entry).not.toBeNull()
              // The ADR 0050 narrowed walk invariant, via the explicit
              // per-kind undo-mode table (acceptance resolution 2):
              // inverse-mode entries keep `empty inverse ⇔ not applied`;
              // refold-mode entries are applied with an empty inverse and
              // the 'undo-by-refold' note — and nothing else may have an
              // empty inverse while applied.
              const entry = step.entry as NonNullable<typeof step.entry>
              const mode = OP_UNDO_MODE[entry.op.kind]
              if (mode === 'inverse') {
                expect(entry.inverse.length === 0).toBe(entry.outcome.status !== 'applied')
              } else {
                if (entry.outcome.status === 'applied') {
                  expect(entry.inverse).toEqual([])
                  expect(entry.outcome.notes).toContain('undo-by-refold')
                } else {
                  expect(entry.inverse).toEqual([])
                }
              }
              // Global direction, every kind: a non-empty inverse implies
              // the op was applied (there is never something to undo for a
              // no-op or a conflict).
              if (entry.inverse.length > 0) expect(entry.outcome.status).toBe('applied')
            } else {
              expect(step.entry).toBeNull()
              expect(step.history).toBe(history)
            }
            history = step.history
          } else {
            const step = redo(history)
            if (history.cursor < history.entries.length) expect(step.entry).not.toBeNull()
            else {
              expect(step.entry).toBeNull()
              expect(step.history).toBe(history)
            }
            history = step.history
          }
          // The fold contract holds at every point of the walk.
          const active = history.entries.slice(0, history.cursor).map((e) => e.op)
          expect(stateAtCursor(base, history)).toEqual(foldOverlay(base, active).state)
        }
      }
    }
  })

  it('undo-all returns to the initial state; redo-all returns to the final state', () => {
    for (const seed of [7, 199, 20481]) {
      const rng = makeTestRng(seed)
      for (let session = 0; session < 25; session++) {
        const base = genBase(rng, 'walk')
        const initial = stateAtCursor(base, emptyHistory())
        let history: TransformationHistory = emptyHistory()
        for (let i = 0, n = rng.int(1, 18); i < n; i++) {
          history = appendOp(
            base,
            history,
            genOp(rng, base, stateAtCursor(base, history), rng.bool(0.1)),
          ).history
        }
        const finalState = stateAtCursor(base, history)
        const finalHistory = history
        while (undo(history).entry !== null) history = undo(history).history
        expect(history.cursor).toBe(0)
        expect(stateAtCursor(base, history)).toEqual(initial)
        while (redo(history).entry !== null) history = redo(history).history
        expect(stateAtCursor(base, history)).toEqual(finalState)
        expect(history).toEqual(finalHistory)
      }
    }
  })

  it('undo visits entries in exact reverse of the active prefix', () => {
    for (const seed of [3, 14, 159]) {
      const rng = makeTestRng(seed)
      for (let session = 0; session < 20; session++) {
        const base = genBase(rng, 'rev')
        let history: TransformationHistory = emptyHistory()
        const appended: EditOp[] = []
        for (let i = 0, n = rng.int(1, 12); i < n; i++) {
          const op = genOp(rng, base, stateAtCursor(base, history), rng.bool(0.1))
          const result = appendOp(base, history, op)
          if (result.entry !== null) {
            history = result.history
            appended.push(op)
          }
        }
        const visited: EditOp[] = []
        let step = undo(history)
        while (step.entry !== null) {
          visited.push(step.entry.op)
          history = step.history
          step = undo(history)
        }
        expect(visited).toEqual([...appended].reverse())
      }
    }
  })
})
