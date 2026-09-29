// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { classifyVerbatimSql } from './sql-safety.js'
import type { VerbatimSqlRefusal } from './sql-safety.js'

function accepts(sql: string): boolean {
  return classifyVerbatimSql(sql).ok
}

function refusal(sql: string): VerbatimSqlRefusal | 'accepted' {
  const result = classifyVerbatimSql(sql)
  return result.ok ? 'accepted' : result.refusal
}

describe('classifyVerbatimSql: accepted read statements', () => {
  it('accepts the read allowlist', () => {
    for (const sql of [
      'SELECT 1',
      'SELECT * FROM t',
      'WITH x AS (SELECT 1) SELECT * FROM x',
      'VALUES (1), (2)',
      'FROM t',
      'TABLE t',
      'PIVOT t ON x USING sum(y)',
      '(SELECT 1)',
    ]) {
      expect(accepts(sql), sql).toBe(true)
    }
  })

  it('accepts a single trailing semicolon and trailing comments', () => {
    expect(accepts('SELECT 1;')).toBe(true)
    expect(accepts('SELECT 1; -- done')).toBe(true)
    expect(accepts('SELECT 1; /* done */')).toBe(true)
    expect(accepts('SELECT 1;;')).toBe(true)
  })

  it('is case-insensitive for leading keywords', () => {
    expect(accepts('select 1')).toBe(true)
    expect(accepts('SeLeCt 1')).toBe(true)
    expect(accepts('with x as (select 1) select * from x')).toBe(true)
  })
})

describe('classifyVerbatimSql: lexical awareness (injection probes do not flip it)', () => {
  it('ignores forbidden words inside string literals', () => {
    expect(accepts(`SELECT '; DROP TABLE t' AS "delete"`)).toBe(true)
    expect(accepts(`SELECT '-- not a comment'`)).toBe(true)
    expect(accepts(`SELECT '/* not a comment */'`)).toBe(true)
  })

  it('ignores quotes and semicolons inside quoted identifiers', () => {
    expect(accepts('SELECT "a;b" FROM t')).toBe(true)
    expect(accepts('SELECT "drop" FROM t')).toBe(true)
    expect(accepts('SELECT `a;b` FROM t')).toBe(true)
  })

  it('ignores statement separators inside comments', () => {
    expect(accepts('SELECT 1 -- ; DROP TABLE t')).toBe(true)
    expect(accepts('SELECT /* ; DROP TABLE t */ 1')).toBe(true)
    expect(accepts('SELECT /* outer /* nested ; */ still */ 1')).toBe(true)
  })

  it('ignores separators and keywords inside dollar-quoted strings', () => {
    expect(accepts('SELECT $$; DROP TABLE t$$')).toBe(true)
    expect(accepts('SELECT $tag$; DELETE FROM t$tag$')).toBe(true)
  })

  it('doubled quotes stay inside the lexeme', () => {
    expect(accepts("SELECT 'it''s; fine'")).toBe(true)
    expect(accepts('SELECT "a"";b" FROM t')).toBe(true)
  })
})

describe('classifyVerbatimSql: refusals (fail closed)', () => {
  it('refuses empty text', () => {
    expect(refusal('')).toBe('empty')
    expect(refusal('   \n -- comment only\n')).toBe('empty')
  })

  it('refuses multi-statement text', () => {
    expect(refusal('SELECT 1; SELECT 2')).toBe('multi-statement')
    expect(refusal('SELECT 1; DROP TABLE t')).toBe('multi-statement')
  })

  it('refuses a leading keyword outside the read allowlist', () => {
    expect(refusal('INSERT INTO t VALUES (1)')).toBe('not-a-read-statement')
    expect(refusal('EXPLAIN SELECT 1')).toBe('not-a-read-statement')
    expect(refusal('SHOW TABLES')).toBe('not-a-read-statement')
    // UNPIVOT requires INTO (a side-effect keyword), so it is not in the
    // allowlist — fail closed rather than special-casing the grammar.
    expect(refusal('UNPIVOT t ON a, b INTO NAME n VALUE v')).toBe('not-a-read-statement')
  })

  it('refuses forbidden keywords anywhere in a single statement', () => {
    expect(refusal('WITH x AS (DELETE FROM t RETURNING 1) SELECT * FROM x')).toBe(
      'forbidden-keyword',
    )
    expect(refusal('SELECT * INTO new_table FROM t')).toBe('forbidden-keyword')
    expect(refusal('SELECT 1 CALL f()')).toBe('forbidden-keyword')
  })

  it('refuses unterminated lexemes', () => {
    expect(refusal("SELECT 'unterminated")).toBe('unterminated-quote')
    expect(refusal('SELECT "unterminated')).toBe('unterminated-quote')
    expect(refusal('SELECT 1 /* unterminated')).toBe('unterminated-comment')
    expect(refusal('SELECT $$unterminated')).toBe('unterminated-dollar-quote')
  })

  it('refuses unbalanced parentheses (trailing garbage)', () => {
    expect(refusal('SELECT (1')).toBe('unbalanced-parens')
    expect(refusal('SELECT 1)')).toBe('unbalanced-parens')
    expect(refusal('SELECT (1))')).toBe('unbalanced-parens')
  })

  it('never throws on hostile non-string input', () => {
    for (const value of [123, null, undefined, {}, [], true]) {
      expect(() => classifyVerbatimSql(value as unknown as string)).not.toThrow()
      expect(classifyVerbatimSql(value as unknown as string).ok).toBe(false)
    }
  })
})
