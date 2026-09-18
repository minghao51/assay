/**
 * Unit tests for the strict engine type-expression validator
 * (`type-expr.ts`, m4-2 fix round). The validator is the m4-2 review's
 * SQL-injection boundary: it must accept exactly one complete DuckDB type
 * expression and reject everything else with a typed `EngineTypeError`,
 * never letting an unvalidated string reach a SQL type position.
 *
 * The accept battery pins the legitimate type space the engine emits or
 * accepts (the review checklist plus nested combinations) so the validator
 * cannot be over-restrictive; the reject battery pins `;`, comments,
 * unbalanced/unterminated delimiters, trailing tokens, empty input, and the
 * exact payload the reviewer proved executed before the fix. The
 * classification pins the canonical string family the CSV guard keys off
 * (`TEXT`/`STRING`/`CHAR`/`BPCHAR`/`CHARACTER`/`ENUM`, not just `VARCHAR`).
 */
import { describe, expect, it } from 'vitest'
import {
  EngineTypeError,
  isStringLikeEngineType,
  parseEngineTypeExpression,
  validateEngineTypeExpression,
} from './type-expr'

/** The exact payload from the m4-2 review finding 1. */
const REVIEWER_PAYLOAD =
  'VARCHAR) AS "c" FROM (...) ); CREATE TABLE assay_injected AS SELECT 31337; --'

const ACCEPTED_TYPES: readonly string[] = [
  'VARCHAR',
  'VARCHAR(10)',
  'TEXT',
  'STRING',
  'CHAR',
  'CHAR(2)',
  'BPCHAR',
  'CHARACTER',
  'CHARACTER VARYING',
  'CHARACTER VARYING(20)',
  'BIT VARYING',
  'INTEGER',
  'BIGINT',
  'SMALLINT',
  'TINYINT',
  'HUGEINT',
  'UTINYINT',
  'USMALLINT',
  'UINTEGER',
  'UBIGINT',
  'FLOAT',
  'REAL',
  'DOUBLE',
  'DOUBLE PRECISION',
  'DECIMAL(10,2)',
  'NUMERIC(18,4)',
  'BOOLEAN',
  'BLOB',
  'BYTEA',
  'DATE',
  'TIME',
  'TIME(3)',
  'TIME WITH TIME ZONE',
  'TIME WITHOUT TIME ZONE',
  'TIMESTAMP',
  'TIMESTAMP(3)',
  'TIMESTAMP WITH TIME ZONE',
  'TIMESTAMP WITHOUT TIME ZONE',
  'TIMESTAMPTZ',
  'INTERVAL',
  'UUID',
  'JSON',
  'INTEGER[]',
  'BIGINT[][]',
  'VARCHAR[3]',
  'VARCHAR(3)[]',
  'LIST(INTEGER)',
  'STRUCT(a INTEGER, b VARCHAR)',
  'STRUCT(a STRUCT(b INTEGER))',
  'STRUCT("a b" INTEGER, "weird ""quoted"" key" VARCHAR)',
  'STRUCT(a INTEGER[])',
  'MAP(VARCHAR, INTEGER)',
  'MAP(VARCHAR, INTEGER[])',
  'UNION(a INTEGER, b VARCHAR)',
  "ENUM('a','b')",
  "ENUM('it''s','b')",
  'DECIMAL(10,2)[]',
  "STRUCT(k MAP(VARCHAR, BIGINT[]), e ENUM('x','y'))",
  // The real engine's nested-fixture DESCRIBE strings (m3-1 pins).
  'STRUCT(a STRUCT(b STRUCT(c BIGINT)))',
  'STRUCT(src VARCHAR, ver BIGINT)',
  'VARCHAR[]',
  'STRUCT("at" TIMESTAMP, ok BOOLEAN)[]',
  // Other engine-emittable scalars must stay composable too (an overlay-free
  // export validates the DESCRIBE-derived schema through the same composer).
  'TIMESTAMP_S',
  'TIMESTAMP_MS',
  'TIMESTAMP_NS',
  'UHUGEINT',
  'BIT',
  'BIT(3)',
  'VARINT',
  'GEOMETRY',
  'POINT',
  'UNKNOWN',
  'SQLNULL',
  'DECIMAL(38,10)',
]

const REJECTED_TYPES: readonly string[] = [
  REVIEWER_PAYLOAD,
  'BIGINT) ; CREATE TABLE assay_injected AS SELECT 31337; --',
  '',
  '   ',
  'VARCHAR;',
  'VARCHAR ; DROP TABLE users',
  'VARCHAR -- comment',
  'VARCHAR /* comment */',
  'VARCHAR)',
  '(VARCHAR',
  'INTEGER[3',
  'INTEGER[]]',
  "VARCHAR('unterminated",
  '"VARCHAR unt',
  'VARCHAR foo',
  'VARCHAR VARCHAR',
  'SELECT 1',
  'DECIMAL(10,2))',
  'STRUCT(a INTEGER',
  'ENUM(',
  'MAP(,)',
  'INTEGER[abc]',
  '1VARCHAR',
  'VARCHAR\n; DROP TABLE x',
  'VARCHAR&INTEGER',
  'VARCHAR\\INTEGER',
  'VARCHAR|INTEGER',
  'VARCHAR%INTEGER',
]

describe('parseEngineTypeExpression — accept battery', () => {
  it('accepts the legitimate DuckDB type space as one complete type expression', () => {
    for (const type of ACCEPTED_TYPES) {
      expect(() => parseEngineTypeExpression(type), type).not.toThrow()
    }
  })

  it('returns the canonical base and family for representative types', () => {
    expect(parseEngineTypeExpression('DECIMAL(10,2)')).toEqual({ base: 'DECIMAL', family: 'other' })
    expect(parseEngineTypeExpression('STRUCT(a INTEGER)')).toEqual({
      base: 'STRUCT',
      family: 'other',
    })
    expect(parseEngineTypeExpression('integer[]')).toEqual({ base: 'INTEGER', family: 'other' })
    expect(parseEngineTypeExpression('text')).toEqual({ base: 'TEXT', family: 'varchar' })
  })
})

describe('parseEngineTypeExpression — reject battery (typed EngineTypeError)', () => {
  it('rejects the reviewer payload and every injection-shaped spelling', () => {
    for (const type of REJECTED_TYPES) {
      let thrown: unknown
      try {
        parseEngineTypeExpression(type)
      } catch (error) {
        thrown = error
      }
      expect(thrown, type).toBeInstanceOf(EngineTypeError)
    }
  })

  it('rejects non-strings', () => {
    for (const value of [null, undefined, 42, {}, [], true]) {
      expect(() => parseEngineTypeExpression(value)).toThrow(EngineTypeError)
    }
  })

  it('exposes validateEngineTypeExpression as the throwing side-effect form', () => {
    expect(() => validateEngineTypeExpression('VARCHAR')).not.toThrow()
    expect(() => validateEngineTypeExpression(REVIEWER_PAYLOAD)).toThrow(EngineTypeError)
  })
})

describe('isStringLikeEngineType — canonical string-family classification', () => {
  it('classifies every textual alias and spelling as string-like', () => {
    for (const type of [
      'VARCHAR',
      'VARCHAR(10)',
      'TEXT',
      'STRING',
      'CHAR',
      'CHAR(2)',
      'BPCHAR',
      'CHARACTER',
      'CHARACTER VARYING',
      'CHARACTER VARYING(20)',
      "ENUM('a','b')",
      'varchar(3)',
    ]) {
      expect(isStringLikeEngineType(type), type).toBe(true)
    }
  })

  it('classifies non-textual and invalid types as not string-like (total)', () => {
    for (const type of [
      'BIGINT',
      'DECIMAL(10,2)',
      'DATE',
      'TIMESTAMP WITH TIME ZONE',
      'JSON',
      'UUID',
      'INTEGER[]',
      'STRUCT(a INTEGER)',
      'MAP(VARCHAR, INTEGER)',
      REVIEWER_PAYLOAD,
      '',
      null,
    ]) {
      expect(isStringLikeEngineType(type), String(type)).toBe(false)
    }
  })
})
