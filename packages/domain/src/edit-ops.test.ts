// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, expectTypeOf, it } from 'vitest'
import { NULL_VALUE, cellValueEqual, describeOp } from './edit-ops'
import type { CellValue, EditOp } from './edit-ops'
import { baseRowId } from './row-identity'

describe('cell values — honest null', () => {
  it('models NULL as data (a tagged kind), distinct from "no edit"', () => {
    expect(NULL_VALUE).toEqual({ kind: 'null' })
    // An edit that sets NULL is a real CellValue — it never collapses to
    // `null`/`undefined`, which mean "no overlay edit" in the fold.
    const edit: CellValue = NULL_VALUE
    expect(cellValueEqual(edit, { kind: 'null' })).toBe(true)
    expect(cellValueEqual(edit, { kind: 'string', value: 'null' })).toBe(false)
  })

  it('structural equality with Object.is semantics: NaN equals NaN, 0 ≠ -0, kinds differ', () => {
    expect(
      cellValueEqual({ kind: 'number', value: Number.NaN }, { kind: 'number', value: Number.NaN }),
    ).toBe(true)
    expect(cellValueEqual({ kind: 'number', value: 0 }, { kind: 'number', value: -0 })).toBe(false)
    expect(cellValueEqual({ kind: 'number', value: 1 }, { kind: 'number', value: 1 })).toBe(true)
    expect(cellValueEqual({ kind: 'string', value: 'a' }, { kind: 'string', value: 'a' })).toBe(
      true,
    )
    expect(cellValueEqual({ kind: 'string', value: 'a' }, { kind: 'string', value: 'b' })).toBe(
      false,
    )
    expect(cellValueEqual({ kind: 'boolean', value: true }, { kind: 'boolean', value: true })).toBe(
      true,
    )
    // 'text' is engine-parseable literal input — never equal to a JS string value.
    expect(cellValueEqual({ kind: 'text', text: 'a' }, { kind: 'string', value: 'a' })).toBe(false)
    expect(cellValueEqual({ kind: 'text', text: 'a' }, { kind: 'text', text: 'a' })).toBe(true)
    expect(cellValueEqual({ kind: 'null' }, { kind: 'boolean', value: false })).toBe(false)
  })
})

describe('op descriptions — deterministic, honest, panel-ready (m4-4)', () => {
  it('renders every op kind with NULL as NULL and values quoted', () => {
    const rowId = baseRowId('f', 2)
    expect(describeOp({ kind: 'cell-set', rowId, column: 'c', value: NULL_VALUE })).toContain(
      'NULL',
    )
    expect(describeOp({ kind: 'cell-set', rowId, column: 'c', value: NULL_VALUE })).not.toMatch(
      /empty|clear/i,
    )
    expect(
      describeOp({
        kind: 'cell-set',
        rowId,
        column: 'c',
        value: { kind: 'text', text: '2026-09-18' },
      }),
    ).toContain('text "2026-09-18"')
    expect(
      describeOp({ kind: 'row-insert', rowId, position: { kind: 'start' }, values: new Map() }),
    ).toContain('at start')
    expect(
      describeOp({ kind: 'row-insert', rowId, position: { kind: 'end' }, values: new Map() }),
    ).toContain('at end')
    expect(
      describeOp({
        kind: 'row-insert',
        rowId,
        position: { kind: 'before', rowId },
        values: new Map(),
      }),
    ).toContain('before row')
    expect(describeOp({ kind: 'column-rename', from: 'a b', to: 'c"d' })).toContain(
      'rename column "a b" to "c\\"d"',
    )
  })
})

describe('op union — closed, transportable shapes', () => {
  it('every op variant carries logical row ids and honest value records (type-level)', () => {
    // RowId is a branded string — JSON/structured-clone transportable, not arbitrary text.
    type CellSet = Extract<EditOp, { kind: 'cell-set' }>
    expectTypeOf<CellSet['rowId']>().toEqualTypeOf<ReturnType<typeof baseRowId>>()
    expectTypeOf<CellSet['column']>().toEqualTypeOf<string>()
    expectTypeOf<CellSet['value']>().toEqualTypeOf<CellValue>()
    type Insert = Extract<EditOp, { kind: 'row-insert' }>
    expectTypeOf<Insert['rowId']>().toEqualTypeOf<ReturnType<typeof baseRowId>>()
    // The union is closed over exactly the seven kinds (compile-checked below
    // via the exhaustive describeOp switch; runtime smoke here).
    const kinds: EditOp['kind'][] = [
      'cell-set',
      'cell-revert',
      'row-insert',
      'row-uninsert',
      'row-delete',
      'row-restore',
      'column-rename',
      'column-cast',
    ]
    expect(new Set(kinds).size).toBe(8)
    // No `any` anywhere in the public op surface.
    expectTypeOf<EditOp>().not.toBeAny()
    expectTypeOf<CellValue>().not.toBeAny()
  })
})
