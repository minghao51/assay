// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import {
  classifyColumnType,
  compileFilterInput,
  defaultOperatorForKind,
  escapeLikePattern,
  filterOperators,
  findOperator,
  sqlStringLiteral,
} from './filter-builder'
import type { FilterColumnKind } from './filter-builder'

/**
 * ux-4 — pure filter-builder pins. The component (FilterBar.test.tsx) drives
 * these functions through the real UI; these tests pin the classification,
 * operator catalogs, and the operator+value → `FilterSpec` predicate
 * compilation (quoting/escaping, numeric/date validation, the `other`-kind
 * fallback).
 */

function kind(rawType: string): FilterColumnKind {
  return classifyColumnType(rawType).kind
}

describe('classifyColumnType (parseType adapter)', () => {
  it('classifies the common numeric primitives (including parameterized/wide)', () => {
    for (const type of ['BIGINT', 'INTEGER', 'DOUBLE', 'DECIMAL(21,1)', 'HUGEINT', 'FLOAT']) {
      expect(kind(type), type).toBe('numeric')
    }
  })

  it('classifies textual primitives', () => {
    for (const type of ['VARCHAR', 'TEXT', 'STRING', 'CHAR', 'UUID']) {
      expect(kind(type), type).toBe('string')
    }
  })

  it('classifies temporal primitives and keeps the literal keyword', () => {
    expect(classifyColumnType('DATE')).toEqual({ kind: 'temporal', temporalKeyword: 'DATE' })
    expect(classifyColumnType('TIME')).toEqual({ kind: 'temporal', temporalKeyword: 'TIME' })
    expect(classifyColumnType('TIMESTAMP WITH TIME ZONE')).toEqual({
      kind: 'temporal',
      temporalKeyword: 'TIMESTAMP',
    })
  })

  it('classifies booleans', () => {
    expect(kind('BOOLEAN')).toBe('boolean')
    expect(kind('BOOL')).toBe('boolean')
  })

  it('folds composites, unknown, and unrecognized primitives into `other`', () => {
    for (const type of [
      'STRUCT(x INTEGER)',
      'VARCHAR[]',
      'MAP(VARCHAR, INTEGER)',
      'BLOB',
      'nonsense',
    ]) {
      expect(kind(type), type).toBe('other')
    }
  })
})

describe('operator catalogs', () => {
  it('offers the required numeric comparison set plus null checks', () => {
    expect(filterOperators('numeric').map((operator) => operator.id)).toEqual([
      'eq',
      'neq',
      'gt',
      'gte',
      'lt',
      'lte',
      'is-null',
      'is-not-null',
    ])
  })

  it('offers equality, inequality, contains, and null checks for strings', () => {
    expect(filterOperators('string').map((operator) => operator.id)).toEqual([
      'eq',
      'neq',
      'contains',
      'is-null',
      'is-not-null',
    ])
  })

  it('offers temporal comparisons and boolean literals', () => {
    expect(filterOperators('temporal').map((operator) => operator.id)).toContain('gte')
    expect(filterOperators('boolean').map((operator) => operator.id)).toEqual([
      'is-true',
      'is-false',
      'is-null',
      'is-not-null',
    ])
  })

  it('offers only null checks for `other` kinds', () => {
    expect(filterOperators('other').map((operator) => operator.id)).toEqual([
      'is-null',
      'is-not-null',
    ])
  })

  it('defaults to the first catalog operator', () => {
    expect(defaultOperatorForKind('numeric')).toBe('eq')
    expect(defaultOperatorForKind('string')).toBe('eq')
    expect(defaultOperatorForKind('boolean')).toBe('is-true')
    expect(defaultOperatorForKind('other')).toBe('is-null')
  })

  it('rejects an operator that is not in the kind catalog', () => {
    expect(findOperator('numeric', 'contains')).toBeUndefined()
  })
})

describe('compilation — numeric', () => {
  const profile = classifyColumnType('DOUBLE')

  it('compiles each comparison operator with a bare numeric literal', () => {
    expect(compileFilterInput(profile, 'eq', '50000')).toEqual({ ok: true, predicate: '= 50000' })
    expect(compileFilterInput(profile, 'neq', '50000')).toEqual({ ok: true, predicate: '<> 50000' })
    expect(compileFilterInput(profile, 'gt', '50000')).toEqual({ ok: true, predicate: '> 50000' })
    expect(compileFilterInput(profile, 'gte', '50000')).toEqual({ ok: true, predicate: '>= 50000' })
    expect(compileFilterInput(profile, 'lt', '50000')).toEqual({ ok: true, predicate: '< 50000' })
    expect(compileFilterInput(profile, 'lte', '50000')).toEqual({ ok: true, predicate: '<= 50000' })
  })

  it('accepts decimals and signs but rejects non-numbers and hex', () => {
    expect(compileFilterInput(profile, 'eq', '-1.5e3')).toEqual({ ok: true, predicate: '= -1.5e3' })
    expect(compileFilterInput(profile, 'eq', 'abc')).toEqual({
      ok: false,
      message: 'That is not a number.',
    })
    expect(compileFilterInput(profile, 'eq', '0x10')).toEqual({
      ok: false,
      message: 'That is not a number.',
    })
  })
})

describe('compilation — string quoting and LIKE escaping', () => {
  const profile = classifyColumnType('VARCHAR')

  it('single-quotes equality values and doubles embedded quotes', () => {
    expect(compileFilterInput(profile, 'eq', 'US')).toEqual({ ok: true, predicate: "= 'US'" })
    expect(compileFilterInput(profile, 'neq', "O'Brien")).toEqual({
      ok: true,
      predicate: "<> 'O''Brien'",
    })
  })

  it('keeps untrusted markup as an ordinary string literal (never HTML)', () => {
    expect(compileFilterInput(profile, 'eq', '<b>x</b>')).toEqual({
      ok: true,
      predicate: "= '<b>x</b>'",
    })
  })

  it('compiles contains to a LIKE with the metacharacters escaped', () => {
    expect(compileFilterInput(profile, 'contains', 'US')).toEqual({
      ok: true,
      predicate: "LIKE '%US%' ESCAPE '\\'",
    })
    expect(compileFilterInput(profile, 'contains', '50%')).toEqual({
      ok: true,
      predicate: "LIKE '%50\\%%' ESCAPE '\\'",
    })
    expect(compileFilterInput(profile, 'contains', 'a_b')).toEqual({
      ok: true,
      predicate: "LIKE '%a\\_b%' ESCAPE '\\'",
    })
    expect(compileFilterInput(profile, 'contains', "O'Brien")).toEqual({
      ok: true,
      predicate: "LIKE '%O''Brien%' ESCAPE '\\'",
    })
  })

  it('escapes LIKE metacharacters in order (backslash first)', () => {
    expect(escapeLikePattern('a\\b')).toBe('a\\\\b')
    expect(sqlStringLiteral("it's")).toBe("'it''s'")
  })
})

describe('compilation — temporal', () => {
  it('compiles date comparisons with DATE literals', () => {
    const profile = classifyColumnType('DATE')
    expect(compileFilterInput(profile, 'eq', '2025-01-04')).toEqual({
      ok: true,
      predicate: "= DATE '2025-01-04'",
    })
    expect(compileFilterInput(profile, 'gte', '2025-01-04')).toEqual({
      ok: true,
      predicate: ">= DATE '2025-01-04'",
    })
    expect(compileFilterInput(profile, 'lte', '2025-01-04')).toEqual({
      ok: true,
      predicate: "<= DATE '2025-01-04'",
    })
  })

  it('rejects malformed and impossible dates client-side', () => {
    const profile = classifyColumnType('DATE')
    for (const value of ['2025-1-4', '2025-02-30', 'not-a-date', '2025-01-04T00:00']) {
      const result = compileFilterInput(profile, 'eq', value)
      expect(result.ok, value).toBe(false)
      if (!result.ok) expect(result.message).toBe('Enter a date as YYYY-MM-DD.')
    }
  })

  it('compiles timestamp and time values with their typed literals', () => {
    expect(
      compileFilterInput(classifyColumnType('TIMESTAMP'), 'eq', '2025-01-04 12:00:00'),
    ).toEqual({ ok: true, predicate: "= TIMESTAMP '2025-01-04 12:00:00'" })
    expect(compileFilterInput(classifyColumnType('TIME'), 'eq', '12:00')).toEqual({
      ok: true,
      predicate: "= TIME '12:00'",
    })
    expect(compileFilterInput(classifyColumnType('TIME'), 'eq', '25:00').ok).toBe(false)
  })
})

describe('compilation — boolean and null', () => {
  it('compiles boolean literals without a value', () => {
    const profile = classifyColumnType('BOOLEAN')
    expect(compileFilterInput(profile, 'is-true', '')).toEqual({ ok: true, predicate: '= TRUE' })
    expect(compileFilterInput(profile, 'is-false', '')).toEqual({ ok: true, predicate: '= FALSE' })
  })

  it('compiles null checks for every kind without a value', () => {
    for (const type of ['DOUBLE', 'VARCHAR', 'DATE', 'BOOLEAN', 'STRUCT(x INTEGER)']) {
      const profile = classifyColumnType(type)
      expect(compileFilterInput(profile, 'is-null', ''), type).toEqual({
        ok: true,
        predicate: 'IS NULL',
      })
      expect(compileFilterInput(profile, 'is-not-null', ''), type).toEqual({
        ok: true,
        predicate: 'IS NOT NULL',
      })
    }
  })
})

describe('client-side rejections', () => {
  it('rejects a value-requiring operator with an empty value', () => {
    expect(compileFilterInput(classifyColumnType('VARCHAR'), 'eq', '   ')).toEqual({
      ok: false,
      message: 'Enter a value for this operator.',
    })
  })

  it('rejects an operator outside the column kind catalog', () => {
    expect(compileFilterInput(classifyColumnType('DOUBLE'), 'contains', 'x')).toEqual({
      ok: false,
      message: 'Choose an operator for this column.',
    })
    expect(compileFilterInput(classifyColumnType('STRUCT(x INTEGER)'), 'eq', 'x')).toEqual({
      ok: false,
      message: 'Choose an operator for this column.',
    })
  })
})
