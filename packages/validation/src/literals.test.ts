// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import {
  quoteIdentifier,
  sqlBooleanLiteral,
  sqlIntegerLiteral,
  sqlNumberLiteral,
  sqlStringLiteral,
} from './literals'

/**
 * Hostile-input pins for the SQL literal/identifier helpers (m5-1) — the
 * composition contract with the engine (see `literals.ts`). Every value
 * that reaches plan SQL passes through these functions, so their behavior
 * on hostile content *is* the injection boundary: quotes, SQL
 * comment/quote syntax, `$$` dollar-quoting, backslashes, unicode,
 * newlines, NUL-adjacent oddities. The pins freeze exact bytes, not just
 * "doesn't contain a semicolon"-style heuristics.
 */

describe('quoteIdentifier — hostile inputs', () => {
  it.each([
    ['plain', '"plain"'],
    ['', '""'],
    ['a"b', '"a""b"'],
    ['"', '""""'],
    ['already quoted', '"already quoted"'],
    ['"; DROP TABLE users; --', '"""; DROP TABLE users; --"'],
    ["'single' quotes", '"\'single\' quotes"'],
    ['new\nline', '"new\nline"'],
    ['ünï cödé 🎉', '"ünï cödé 🎉"'],
    ['tab\there', '"tab\there"'],
    ['back\\slash', '"back\\slash"'],
    ['$dollar$quoted$', '"$dollar$quoted$"'],
    ['-- comment', '"-- comment"'],
    ['/* block */', '"/* block */"'],
  ])('quotes %.30q byte-exactly', (input, expected) => {
    expect(quoteIdentifier(input)).toBe(expected)
  })

  it('never throws and never strips content (totality over arbitrary strings)', () => {
    for (const input of ['\u0000', '\uD800', '"'.repeat(50), 'x'.repeat(10_000)]) {
      expect(() => quoteIdentifier(input)).not.toThrow()
      const quoted = quoteIdentifier(input)
      expect(quoted.startsWith('"')).toBe(true)
      expect(quoted.endsWith('"')).toBe(true)
      // unquoting recovers the input exactly (content is preserved verbatim)
      expect(quoted.slice(1, -1).replaceAll('""', '"')).toBe(input)
    }
  })
})

describe('sqlStringLiteral — hostile inputs', () => {
  it.each([
    ['plain', "'plain'"],
    ['', "''"],
    ["it's", "'it''s'"],
    ["'", "''''"],
    ["a'b'c", "'a''b''c'"],
    // DuckDB does not process backslash escapes in regular single-quoted
    // strings — the backslash stays a literal byte (documented contract).
    ['a\\b', "'a\\b'"],
    ["\\'; DROP TABLE x; --", "'\\''; DROP TABLE x; --'"],
    ['$dollar$ $tag$ body $tag$$dollar$', "'$dollar$ $tag$ body $tag$$dollar$'"],
    ['-- line comment', "'-- line comment'"],
    ['/* block comment */', "'/* block comment */'"],
    ['line1\nline2', "'line1\nline2'"],
    ['ünï cödé 🎉', "'ünï cödé 🎉'"],
    ["'; DELETE FROM rules; SELECT '", "'''; DELETE FROM rules; SELECT '''"],
  ])('quotes %.40q byte-exactly', (input, expected) => {
    expect(sqlStringLiteral(input)).toBe(expected)
  })

  it('never throws and unquote∘quote is the identity (totality over arbitrary strings)', () => {
    for (const input of ['\u0000', '\uD800', "'".repeat(40), 'y'.repeat(10_000)]) {
      expect(() => sqlStringLiteral(input)).not.toThrow()
      const quoted = sqlStringLiteral(input)
      expect(quoted.startsWith("'")).toBe(true)
      expect(quoted.endsWith("'")).toBe(true)
      expect(quoted.slice(1, -1).replaceAll("''", "'")).toBe(input)
    }
  })
})

describe('sqlNumberLiteral — exact shortest renderings', () => {
  it.each([
    [0, '0'],
    [-0, '0'], // m5-0 canonicalizes ±0 to one contract value
    [0.25, '0.25'],
    [-1.5, '-1.5'],
    [99.5, '99.5'],
    [1, '1'],
    [-7, '-7'],
    [1e21, '1e+21'], // ECMAScript's exact-shortest spelling; DuckDB parses it
    [1 / 3, '0.3333333333333333'],
    [9007199254740992, '9007199254740992'], // 2^53, the m5-0 exactness ceiling
    [Number.MAX_VALUE, '1.7976931348623157e+308'],
    [Number.MIN_VALUE, '5e-324'],
  ])('%s → %s', (value, expected) => {
    expect(sqlNumberLiteral(value)).toBe(expected)
  })

  it('renderings round-trip to the exact value m5-0 verified', () => {
    for (const value of [0.25, -1.5, 99.5, 1e21, 1 / 3, 2 ** 53, 0.1, 1.1, 12345.6789]) {
      expect(Number(sqlNumberLiteral(value))).toBe(value)
    }
  })

  it('asserts the finite precondition (unreachable via compileContract, which pre-rejects)', () => {
    expect(() => sqlNumberLiteral(Number.NaN)).toThrow(/non-finite/)
    expect(() => sqlNumberLiteral(Number.POSITIVE_INFINITY)).toThrow(/non-finite/)
    expect(() => sqlNumberLiteral(Number.NEGATIVE_INFINITY)).toThrow(/non-finite/)
  })
})

describe('sqlIntegerLiteral — safe integers only', () => {
  it.each([
    [0, '0'],
    [20, '20'],
    [1_000_000, '1000000'],
    [Number.MAX_SAFE_INTEGER, '9007199254740991'],
    [-5, '-5'],
  ])('%s → %s', (value, expected) => {
    expect(sqlIntegerLiteral(value)).toBe(expected)
  })

  it('asserts the safe-integer precondition', () => {
    expect(() => sqlIntegerLiteral(1.5)).toThrow(/safe integer/)
    expect(() => sqlIntegerLiteral(2 ** 53)).toThrow(/safe integer/)
    expect(() => sqlIntegerLiteral(Number.NaN)).toThrow(/safe integer/)
  })
})

describe('sqlBooleanLiteral', () => {
  it('renders the SQL keywords', () => {
    expect(sqlBooleanLiteral(true)).toBe('TRUE')
    expect(sqlBooleanLiteral(false)).toBe('FALSE')
  })
})
