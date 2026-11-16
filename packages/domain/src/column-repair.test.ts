// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `column-repair` domain tests (EW-04D §11; U5 slice). Plan validation, caps
 * and refusals, the undo-by-refold history shape (ADR 0050), and the
 * value-independent repair-chain metadata the §6.2 wrap consumes
 * (mask/liveness). The *value-level* forward composition is pinned against
 * the real engine in `packages/engine-duckdb/src/overlay-repair-query.test.ts`
 * (the differential harness); this file pins the fold.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_REPAIR_TRIM_CODE_POINTS,
  MAX_REPAIR_MAPPING_PAIRS,
  MAX_REPAIR_TRIM_CODE_POINTS,
  OP_UNDO_MODE,
  describeOp,
  trimWithCodePoints,
} from './edit-ops'
import type { CellValue, EditOp } from './edit-ops'
import { appendOp, emptyHistory, redo, stateAtCursor, undo } from './history'
import type { TransformationHistory } from './history'
import { foldOverlay, initialState, stepOverlay } from './overlay'
import type { OverlayBase } from './overlay'
import { baseRowId, insertRowId } from './row-identity'
import type { RowId } from './row-identity'

// Vitest 4 no longer leaks Node's ambient globals into test files (this pure
// package's lib is ES2022-only and it has no `@types/node`), so the platform
// `structuredClone` the immutability pin uses needs a local ambient
// declaration. Type-only: the runtime global still comes from Node.
declare function structuredClone<T>(value: T): T

const makeBase = (columns: OverlayBase['columns'], baseRowCount = 5): OverlayBase => ({
  baseAnchor: 'file-v1',
  overlayAnchor: 'session-1',
  columns,
  baseRowCount,
})

const TEXT_BASE = makeBase([
  { name: 'id', type: 'BIGINT' },
  { name: 'label', type: 'VARCHAR' },
  { name: 'tag', type: 'TEXT' },
])

const row = (ordinal: number): RowId => baseRowId('file-v1', ordinal)
const ins = (seq: number): RowId => insertRowId('session-1', seq)

const SET = (rowId: RowId, column: string, value: CellValue): EditOp => ({
  kind: 'cell-set',
  rowId,
  column,
  value,
})
const REPAIR = (column: string, mapping: ReadonlyMap<string, string>, trim?: string): EditOp => ({
  kind: 'column-repair',
  column,
  mapping,
  ...(trim !== undefined ? { trim } : {}),
})

const DEFAULT_TRIM = DEFAULT_REPAIR_TRIM_CODE_POINTS
const str = (value: string): CellValue => ({ kind: 'string', value: value })

describe('column-repair — the closed-union op steps through the fold', () => {
  it('applies with inverse: [] and the undo-by-refold note (ADR 0050)', () => {
    const step = stepOverlay(
      TEXT_BASE,
      initialState(TEXT_BASE),
      REPAIR('label', new Map([['old', 'new']]), DEFAULT_TRIM),
    )
    expect(step.application.outcome).toEqual({
      status: 'applied',
      notes: ['undo-by-refold'],
    })
    expect(step.application.inverse).toEqual([])
    expect(step.state.repairs).toHaveLength(1)
    expect(step.state.repairs[0]?.mapping.get('old')).toBe('new')
  })

  it('refuses an unknown column', () => {
    const step = stepOverlay(
      TEXT_BASE,
      initialState(TEXT_BASE),
      REPAIR('ghost', new Map([['a', 'b']])),
    )
    expect(step.application.outcome).toEqual({
      status: 'conflict',
      reason: 'unknown-column',
    })
  })

  it('refuses a repair column whose declared type is not a textual repair spelling', () => {
    // `trim()` on a non-text type is a Binder Error, and the *string-like*
    // family is wider than the repairable set: ENUM/CHAR re-declare the
    // column as VARCHAR under the wrap (D16/D17 probe §4.2 constraint 1).
    for (const type of ['BIGINT', 'DOUBLE', 'DATE', 'BOOLEAN', 'BLOB']) {
      const base = makeBase([{ name: 'c', type }])
      const step = stepOverlay(base, initialState(base), REPAIR('c', new Map([['a', 'b']])))
      expect(step.application.outcome, type).toEqual({
        status: 'conflict',
        reason: 'repair-column-not-text',
      })
    }
    for (const type of ['ENUM(a, b)', 'CHAR(3)', 'BPCHAR', 'VARCHAR[]']) {
      const base = makeBase([{ name: 'c', type }])
      const step = stepOverlay(base, initialState(base), REPAIR('c', new Map([['a', 'b']])))
      expect(step.application.outcome, type).toEqual({
        status: 'conflict',
        reason: 'repair-column-not-text',
      })
    }
    // The accepted spellings step fine, case-insensitively.
    for (const type of ['VARCHAR', 'TEXT', 'STRING', 'varchar', 'text']) {
      const base = makeBase([{ name: 'c', type }])
      const step = stepOverlay(base, initialState(base), REPAIR('c', new Map([['a', 'b']])))
      expect(step.application.outcome, type).toEqual({
        status: 'applied',
        notes: ['undo-by-refold'],
      })
    }
  })

  it('refuses plans over the caps with typed value-free conflicts', () => {
    const tooManyPairs = new Map<string, string>()
    for (let i = 0; i <= MAX_REPAIR_MAPPING_PAIRS; i++) tooManyPairs.set(`k${String(i)}`, 'v')
    expect(
      stepOverlay(TEXT_BASE, initialState(TEXT_BASE), REPAIR('label', tooManyPairs)).application
        .outcome,
    ).toEqual({ status: 'conflict', reason: 'repair-mapping-cap' })
    expect(MAX_REPAIR_MAPPING_PAIRS).toBe(500)

    const tooWideTrim = 'x'.repeat(MAX_REPAIR_TRIM_CODE_POINTS + 1)
    expect(
      stepOverlay(
        TEXT_BASE,
        initialState(TEXT_BASE),
        REPAIR('label', new Map([['a', 'b']]), tooWideTrim),
      ).application.outcome,
    ).toEqual({ status: 'conflict', reason: 'repair-trim-invalid' })
    expect(MAX_REPAIR_TRIM_CODE_POINTS).toBe(16)

    // A trim set measured in code points (an astral member counts once).
    expect(
      stepOverlay(
        TEXT_BASE,
        initialState(TEXT_BASE),
        REPAIR('label', new Map([['a', 'b']]), '\u{1F600}'.repeat(MAX_REPAIR_TRIM_CODE_POINTS)),
      ).application.outcome,
    ).toEqual({ status: 'applied', notes: ['undo-by-refold'] })
    expect(
      stepOverlay(
        TEXT_BASE,
        initialState(TEXT_BASE),
        REPAIR('label', new Map([['a', 'b']]), '\uFFFD'.repeat(MAX_REPAIR_TRIM_CODE_POINTS + 1)),
      ).application.outcome,
    ).toEqual({ status: 'conflict', reason: 'repair-trim-invalid' })

    // An explicitly empty trim set is a malformed plan, not a silent no-op.
    expect(
      stepOverlay(TEXT_BASE, initialState(TEXT_BASE), REPAIR('label', new Map([['a', 'b']]), ''))
        .application.outcome,
    ).toEqual({ status: 'conflict', reason: 'repair-trim-invalid' })
  })

  it('refuses dead mapping keys: keys with trim-set edges can never match', () => {
    // The CASE operand is always the trimmed value; trim(v) never carries
    // trim-set edges, so a key that differs from its own trim-normalised
    // form is unreachable (D16/D17 probe §7.1 constraint 3, D17 test 19).
    expect(
      stepOverlay(
        TEXT_BASE,
        initialState(TEXT_BASE),
        REPAIR('label', new Map([[' alpha', 'A']]), DEFAULT_TRIM),
      ).application.outcome,
    ).toEqual({ status: 'conflict', reason: 'repair-dead-mapping-key' })
    expect(
      stepOverlay(
        TEXT_BASE,
        initialState(TEXT_BASE),
        REPAIR('label', new Map([['alpha\r\n', 'A']]), DEFAULT_TRIM),
      ).application.outcome,
    ).toEqual({ status: 'conflict', reason: 'repair-dead-mapping-key' })
    // Trim-normalised keys survive, NBSP-edged keys are not dead (NBSP is
    // not in the default set), and without a trim nothing is dead.
    expect(
      stepOverlay(
        TEXT_BASE,
        initialState(TEXT_BASE),
        REPAIR(
          'label',
          new Map([
            ['alpha', 'A'],
            ['\u00A0z\u00A0', 'NZ'],
          ]),
          DEFAULT_TRIM,
        ),
      ).application.outcome,
    ).toEqual({ status: 'applied', notes: ['undo-by-refold'] })
    expect(
      stepOverlay(TEXT_BASE, initialState(TEXT_BASE), REPAIR('label', new Map([[' alpha', 'A']])))
        .application.outcome,
    ).toEqual({ status: 'applied', notes: ['undo-by-refold'] })
  })

  it('refuses a second repair whose trim specification differs from the chain (one trim∘map per column)', () => {
    const first = stepOverlay(
      TEXT_BASE,
      initialState(TEXT_BASE),
      REPAIR('label', new Map([['a', 'b']]), DEFAULT_TRIM),
    ).state
    expect(
      stepOverlay(TEXT_BASE, first, REPAIR('label', new Map([['c', 'd']]), ' \t')).application
        .outcome,
    ).toEqual({ status: 'conflict', reason: 'repair-trim-mismatch' })
    // Absent vs present diverges the same way.
    expect(
      stepOverlay(TEXT_BASE, first, REPAIR('label', new Map([['c', 'd']]))).application.outcome,
    ).toEqual({ status: 'conflict', reason: 'repair-trim-mismatch' })
    // The same set (and a trim-less chain extended trim-less) composes on.
    const same = stepOverlay(TEXT_BASE, first, REPAIR('label', new Map([['c', 'd']]), DEFAULT_TRIM))
    expect(same.state.repairs).toHaveLength(2)
    const plainFirst = stepOverlay(
      TEXT_BASE,
      initialState(TEXT_BASE),
      REPAIR('label', new Map([['a', 'b']])),
    ).state
    expect(
      stepOverlay(TEXT_BASE, plainFirst, REPAIR('label', new Map([['c', 'd']]))).state.repairs,
    ).toHaveLength(2)
    // A different column keeps its own independent chain.
    expect(
      stepOverlay(TEXT_BASE, first, REPAIR('tag', new Map([['c', 'd']]))).state.repairs,
    ).toHaveLength(2)
  })

  it('logs a pair-free trim-less plan as the repair-identity no-op', () => {
    const step = stepOverlay(TEXT_BASE, initialState(TEXT_BASE), REPAIR('label', new Map()))
    expect(step.application.outcome).toEqual({ status: 'no-op', reason: 'repair-identity' })
    expect(step.state.repairs).toEqual([])
    // A trim-only plan is a real applied entry (its passthrough trims values).
    const trimOnly = stepOverlay(
      TEXT_BASE,
      initialState(TEXT_BASE),
      REPAIR('label', new Map(), DEFAULT_TRIM),
    )
    expect(trimOnly.application.outcome).toEqual({ status: 'applied', notes: ['undo-by-refold'] })
  })

  it('appendOp refuses conflicted repair plans and logs applied ones as one entry', () => {
    let history: TransformationHistory = emptyHistory()
    const bad = appendOp(
      TEXT_BASE,
      history,
      REPAIR('label', new Map([[' alpha', 'A']]), DEFAULT_TRIM),
    )
    expect(bad.entry).toBeNull()
    expect(bad.history).toBe(history)
    const good = appendOp(
      TEXT_BASE,
      history,
      REPAIR('label', new Map([['old', 'new']]), DEFAULT_TRIM),
    )
    expect(good.entry).not.toBeNull()
    expect(good.entry?.inverse).toEqual([])
    expect(good.outcome).toEqual({ status: 'applied', notes: ['undo-by-refold'] })
    history = good.history
    expect(history.entries).toHaveLength(1)
    expect(history.cursor).toBe(1)
  })
})

describe('column-repair — ADR 0050 undo shape (one entry, one undo step)', () => {
  it('undo removes the value effect by refold; redo restores it; inverses stay empty', () => {
    const base = TEXT_BASE
    let history: TransformationHistory = emptyHistory()
    history = appendOp(base, history, SET(row(0), 'label', str('old'))).history
    const repair = appendOp(base, history, REPAIR('label', new Map([['old', 'new']]), DEFAULT_TRIM))
    history = repair.history
    expect(stateAtCursor(base, history).repairs).toHaveLength(1)

    const undone = undo(history)
    expect(undone.entry?.inverse).toEqual([])
    expect(undone.entry?.outcome).toEqual({ status: 'applied', notes: ['undo-by-refold'] })
    // The refold of the shortened prefix carries no repair — the value effect
    // is gone because the entry left the prefix, not because an inverse ran.
    expect(stateAtCursor(base, undone.history).repairs).toEqual([])
    expect(stateAtCursor(base, undone.history)).toEqual(
      foldOverlay(base, [SET(row(0), 'label', str('old'))]).state,
    )

    const redone = redo(undone.history)
    expect(stateAtCursor(base, redone.history).repairs).toHaveLength(1)
    expect(stateAtCursor(base, redone.history)).toEqual(stateAtCursor(base, history))
  })

  it('appending after an undo truncates the redo tail through a repair entry', () => {
    const base = TEXT_BASE
    let history: TransformationHistory = emptyHistory()
    history = appendOp(base, history, REPAIR('label', new Map([['a', 'b']]), DEFAULT_TRIM)).history
    const undone = undo(history)
    const branched = appendOp(TEXT_BASE, undone.history, SET(row(1), 'tag', str('x')))
    expect(branched.history.entries).toHaveLength(1)
    expect(branched.history.entries[0]?.op.kind).toBe('cell-set')
  })
})

describe('column-repair — the §6.2 metadata the wrap reads (mask/liveness)', () => {
  it('snapshots liveness at the repair position', () => {
    const base = TEXT_BASE
    const ops: EditOp[] = [
      { kind: 'row-delete', rowId: row(1) },
      {
        kind: 'row-insert',
        rowId: ins(0),
        position: { kind: 'end' },
        values: new Map([['label', str('ins-before')]]),
      },
      REPAIR('label', new Map([['old', 'new']]), DEFAULT_TRIM),
      {
        kind: 'row-insert',
        rowId: ins(1),
        position: { kind: 'end' },
        values: new Map([['label', str('ins-after')]]),
      },
      { kind: 'row-restore', rowId: row(1) },
    ]
    const { state } = foldOverlay(base, ops)
    const record = state.repairs[0] as NonNullable<(typeof state.repairs)[number]>
    expect(record.deadOrdinalsAtApply).toEqual(new Set([1]))
    expect(record.liveInsertIdsAtApply).toEqual(new Set([ins(0)]))
    // Restores/deletes after the repair never rewrite the snapshot.
    expect(record.deadOrdinalsAtApply.has(1)).toBe(true)
  })

  it('only applied value-ops mask; logged no-ops never do', () => {
    const base = TEXT_BASE
    const repair = REPAIR('label', new Map([['old', 'new']]), DEFAULT_TRIM)
    // An applied set after the repair masks that row.
    const applied = foldOverlay(base, [repair, SET(row(2), 'label', str('old'))]).state
    expect(applied.repairs[0]?.maskedRows).toEqual(new Set([row(2)]))
    // A no-op set (the edit already carries that exact value) appends but
    // masks nothing (round-4 correction; the no-op-blind rule is falsified).
    const noOp = foldOverlay(base, [
      SET(row(2), 'label', str('old')),
      repair,
      SET(row(2), 'label', str('old')),
    ]).state
    expect(noOp.repairs[0]?.maskedRows).toEqual(new Set())
    // A no-op revert (no edit to drop) masks nothing either.
    const noOpRevert = foldOverlay(base, [
      repair,
      { kind: 'cell-revert', rowId: row(3), column: 'label' },
    ]).state
    expect(noOpRevert.repairs[0]?.maskedRows).toEqual(new Set())
  })

  it('applied reverts mask; masking follows the column across renames; other columns never mask', () => {
    const base = TEXT_BASE
    const repair = REPAIR('label', new Map([['old', 'new']]), DEFAULT_TRIM)
    const reverted = foldOverlay(base, [
      SET(row(2), 'label', str('x')),
      repair,
      { kind: 'cell-revert', rowId: row(2), column: 'label' },
    ]).state
    expect(reverted.repairs[0]?.maskedRows).toEqual(new Set([row(2)]))

    const renamed = foldOverlay(base, [
      repair,
      { kind: 'column-rename', from: 'label', to: 'label_v2' },
      SET(row(2), 'label_v2', str('old')),
    ]).state
    expect(renamed.repairs[0]?.maskedRows).toEqual(new Set([row(2)]))
    expect(renamed.repairs[0]?.columnIndex).toBe(1)

    const otherColumn = foldOverlay(base, [repair, SET(row(2), 'tag', str('old'))]).state
    expect(otherColumn.repairs[0]?.maskedRows).toEqual(new Set())
  })

  it('repairs survive in the chain when an inserted row is expunged; inserts restore exactly', () => {
    const base = TEXT_BASE
    const ops: EditOp[] = [
      {
        kind: 'row-insert',
        rowId: ins(0),
        position: { kind: 'end' },
        values: new Map([['label', str('v')]]),
      },
      REPAIR('label', new Map([['v', 'w']]), DEFAULT_TRIM),
      { kind: 'row-uninsert', rowId: ins(0) },
    ]
    const { state } = foldOverlay(base, ops)
    expect(state.inserts.has(ins(0))).toBe(false)
    expect(state.repairs).toHaveLength(1)
    expect(state.repairs[0]?.liveInsertIdsAtApply).toEqual(new Set([ins(0)]))
  })

  it('keeps the repair chain through renames and casts; schema ops never reorder the index', () => {
    const base = TEXT_BASE
    const ops: EditOp[] = [
      REPAIR('label', new Map([['a', 'b']]), DEFAULT_TRIM),
      { kind: 'column-rename', from: 'label', to: 'label_v2' },
      { kind: 'column-cast', column: 'label_v2', targetType: 'TEXT' },
    ]
    const { state } = foldOverlay(base, ops)
    expect(state.repairs).toHaveLength(1)
    expect(state.repairs[0]?.columnIndex).toBe(1)
    expect(state.repairs[0]?.typeAtApply).toBe('VARCHAR')
    expect(state.columns[1]).toEqual({ name: 'label_v2', type: 'TEXT' })
  })

  it('the state is never mutated in place by the masking update', () => {
    const base = TEXT_BASE
    const repair = REPAIR('label', new Map([['old', 'new']]), DEFAULT_TRIM)
    const before = foldOverlay(base, [repair]).state
    const snapshot = structuredClone(before)
    const after = foldOverlay(base, [repair, SET(row(0), 'label', str('old'))]).state
    expect(before).toEqual(snapshot)
    expect(after.repairs[0]?.maskedRows).toEqual(new Set([row(0)]))
    expect(before.repairs[0]?.maskedRows).toEqual(new Set())
  })
})

describe('column-repair — surface pins', () => {
  it('describeOp is deterministic and value-free for the plan payload (ADR 0025)', () => {
    const withBoth = describeOp(
      REPAIR(
        'label',
        new Map([
          ['alpha', 'A'],
          ['beta', 'B'],
        ]),
        DEFAULT_TRIM,
      ),
    )
    expect(withBoth).toBe('repair column "label" (2 mapping pairs, edge trim)')
    const trimOnly = describeOp(REPAIR('tag', new Map(), DEFAULT_TRIM))
    expect(trimOnly).toBe('repair column "tag" (0 mapping pairs, edge trim)')
    const mappingOnly = describeOp(REPAIR('label', new Map([['k', 'v']])))
    expect(mappingOnly).toBe('repair column "label" (1 mapping pairs)')
    // No mapping entry or trim character may leak into the description.
    for (const text of [withBoth, trimOnly, mappingOnly]) {
      expect(text).not.toContain('alpha')
      expect(text).not.toContain('\u0020\u0009')
    }
  })

  it('OP_UNDO_MODE declares every kind; only column-repair is refoldable', () => {
    const kinds: EditOp['kind'][] = [
      'cell-set',
      'cell-revert',
      'row-insert',
      'row-uninsert',
      'row-delete',
      'row-restore',
      'column-rename',
      'column-cast',
      'column-repair',
    ]
    for (const kind of kinds) expect(OP_UNDO_MODE[kind]).toBeDefined()
    for (const kind of kinds) {
      expect(OP_UNDO_MODE[kind], kind).toBe(kind === 'column-repair' ? 'refold' : 'inverse')
    }
  })

  it('trimWithCodePoints is edge-only, repeated, interior-untouched, code-point exact', () => {
    expect(trimWithCodePoints('  alpha  x ', DEFAULT_TRIM)).toBe('alpha  x')
    expect(trimWithCodePoints('x\r\n', DEFAULT_TRIM)).toBe('x')
    expect(trimWithCodePoints('\u00A0x\u00A0', DEFAULT_TRIM)).toBe('\u00A0x\u00A0')
    expect(trimWithCodePoints('   ', DEFAULT_TRIM)).toBe('')
    expect(trimWithCodePoints('', DEFAULT_TRIM)).toBe('')
    // Interior members are kept; astral members strip as whole code points.
    expect(trimWithCodePoints('\t\na\r ', DEFAULT_TRIM)).toBe('a')
    expect(trimWithCodePoints('\u{1F600}x\u{1F600}', '\u{1F600}')).toBe('x')
    expect(trimWithCodePoints('alpha', DEFAULT_TRIM)).toBe('alpha')
  })
})
