// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for the strict engine type-expression validator
 * (`type-expr.ts`, m4-2 fix rounds). The validator is the m4-2 review's
 * SQL-injection boundary and the second fix-round review's arity boundary: it
 * must accept exactly one complete, well-shaped DuckDB type expression and
 * reject everything else with a typed `EngineTypeError`, never letting an
 * unvalidated string reach a SQL type position.
 *
 * The accept battery pins the legitimate type space the engine emits or
 * accepts (the review checklist, nested combinations, and the exact DESCRIBE
 * strings every committed Parquet/JSONL fixture produces) so the validator
 * cannot be over-restrictive. The reject battery pins `;`, comments,
 * unbalanced/unterminated delimiters, trailing tokens, empty input, the exact
 * injection payload the reviewer proved executed, and the malformed arities
 * the fix-round review found (`DECIMAL(1,2,3)`, `DECIMAL()`, `VARCHAR()`,
 * `MAP(INTEGER)`, `STRUCT()`, `ENUM()`, …). The classification pins the
 * canonical string family the CSV guard keys off and its **shape-awareness**
 * (`TEXT`/`STRING`/`CHAR`/`BPCHAR`/`CHARACTER`/`ENUM` scalar yes; `VARCHAR[]`/
 * `VARCHAR[3]`/`LIST(VARCHAR)` no).
 */
import { describe, expect, it } from 'vitest'
import {
  EngineTypeError,
  isBlobLikeEngineType,
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
  'TEXT(5)',
  'STRING',
  'STRING(5)',
  'CHAR',
  'CHAR(2)',
  'BPCHAR',
  'CHARACTER',
  'CHARACTER VARYING',
  'CHARACTER VARYING(20)',
  'BIT VARYING',
  'BIT VARYING(3)',
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
  'FLOAT(24)',
  'REAL',
  'DOUBLE',
  'DOUBLE PRECISION',
  'DECIMAL',
  'DECIMAL(10,2)',
  'DECIMAL(10)',
  'DECIMAL(38,10)',
  'DECIMAL(1,1)',
  'DECIMAL(38,38)',
  'NUMERIC',
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
  'INTEGER[3][4]',
  'VARCHAR[3]',
  'VARCHAR(3)[]',
  'LIST(INTEGER)',
  'LIST(VARCHAR)',
  'LIST(STRUCT(a INTEGER))',
  'STRUCT(a INTEGER, b VARCHAR)',
  'STRUCT(a STRUCT(b INTEGER))',
  'STRUCT("a b" INTEGER, "weird ""quoted"" key" VARCHAR)',
  'STRUCT(a INTEGER[])',
  'MAP(VARCHAR, INTEGER)',
  'MAP(VARCHAR, INTEGER[])',
  'UNION(a INTEGER, b VARCHAR)',
  "ENUM('a','b')",
  "ENUM('it''s','b')",
  "ENUM('a')[]",
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
  // Exact DESCRIBE outputs of every committed fixture (probed with the pinned
  // DuckDB CLI 1.5.5 over fixtures/parquet/*.parquet, fixtures/csv/*.csv,
  // fixtures/jsonl/*.jsonl, fixtures/llm/*.jsonl, fixtures/nested-json/*.jsonl).
  // Pinned here so the arity validator can never over-restrict real data.
  'STRUCT("role" VARCHAR, "content" VARCHAR, tool_calls STRUCT("name" VARCHAR, args STRUCT(city VARCHAR))[])[]',
  'STRUCT(passed BOOLEAN, score DOUBLE)',
  'STRUCT("name" VARCHAR, geo STRUCT(lat DECIMAL(21,1), lon DECIMAL(21,1)), tags VARCHAR[], scores STRUCT(q1 DOUBLE, q2 INTEGER))',
  'STRUCT(tags VARCHAR[], geo STRUCT(lat DOUBLE, lon DOUBLE), scores STRUCT(q1 DOUBLE, q2 DOUBLE))',
  'STRUCT(path VARCHAR, referrer VARCHAR, selector VARCHAR, code BIGINT)',
  'DECIMAL(21,1)',
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
  // Malformed arities the fix-round review found (all independently rejected
  // by the pinned DuckDB CLI 1.5.5 too, except the two CLI-accepted
  // default-precision spellings `DECIMAL()`/`BPCHAR()` noted in type-expr.ts).
  'DECIMAL(1,2,3)',
  'DECIMAL()',
  'NUMERIC()',
  'VARCHAR()',
  'CHAR()',
  'BPCHAR()',
  'BIT()',
  'MAP(INTEGER)',
  'MAP()',
  'MAP(VARCHAR, INTEGER, BIGINT)',
  'MAP(VARCHAR)',
  'STRUCT()',
  'UNION()',
  'ENUM()',
  'LIST()',
  'LIST(INTEGER, VARCHAR)',
  'LIST(10)',
  'LIST(a INTEGER)',
  // MODIFIER bounds and shapes DuckDB rejects.
  'DECIMAL(200)',
  'DECIMAL(0)',
  'DECIMAL(39)',
  'DECIMAL(1,2)',
  'DECIMAL(38,39)',
  'DECIMAL(a)',
  'DECIMAL(10,b)',
  "DECIMAL('10')",
  'VARCHAR(TEXT)',
  'VARCHAR(10,2)',
  'STRUCT(INTEGER)',
  'STRUCT(a)',
  'UNION(a)',
  'ENUM(1)',
  'ENUM(1,2)',
  "ENUM('a',1)",
  'INTEGER[0]',
  'DATE(2)',
  'INTEGER(2)',
  'DOUBLE(2)',
  'TIMESTAMP(3,4)',
  'TIMESTAMPTZ(3)',
  'FOO(1)',
]

describe('parseEngineTypeExpression — accept battery', () => {
  it('accepts the legitimate DuckDB type space as one complete type expression', () => {
    for (const type of ACCEPTED_TYPES) {
      expect(() => parseEngineTypeExpression(type), type).not.toThrow()
    }
  })

  it('returns the canonical base, family, and shape for representative types', () => {
    expect(parseEngineTypeExpression('DECIMAL(10,2)')).toEqual({
      base: 'DECIMAL',
      family: 'other',
      shape: 'scalar',
    })
    expect(parseEngineTypeExpression('STRUCT(a INTEGER)')).toEqual({
      base: 'STRUCT',
      family: 'other',
      shape: 'scalar',
    })
    expect(parseEngineTypeExpression('integer[]')).toEqual({
      base: 'INTEGER',
      family: 'other',
      shape: 'array',
    })
    expect(parseEngineTypeExpression('VARCHAR[3]')).toEqual({
      base: 'VARCHAR',
      family: 'other',
      shape: 'array',
    })
    expect(parseEngineTypeExpression('LIST(VARCHAR)')).toEqual({
      base: 'LIST',
      family: 'other',
      shape: 'array',
    })
    expect(parseEngineTypeExpression('text')).toEqual({
      base: 'TEXT',
      family: 'varchar',
      shape: 'scalar',
    })
    expect(parseEngineTypeExpression('BLOB')).toEqual({
      base: 'BLOB',
      family: 'blob',
      shape: 'scalar',
    })
    expect(parseEngineTypeExpression('bytea')).toEqual({
      base: 'BYTEA',
      family: 'blob',
      shape: 'scalar',
    })
    expect(parseEngineTypeExpression('BLOB[]')).toEqual({
      base: 'BLOB',
      family: 'other',
      shape: 'array',
    })
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
    expect(() => validateEngineTypeExpression('DECIMAL(1,2,3)')).toThrow(EngineTypeError)
  })
})

describe('isStringLikeEngineType — shape-aware canonical string-family classification', () => {
  it('classifies every scalar textual alias and spelling as string-like', () => {
    for (const type of [
      'VARCHAR',
      'VARCHAR(10)',
      'TEXT',
      'TEXT(5)',
      'STRING',
      'CHAR',
      'CHAR(2)',
      'BPCHAR',
      'CHARACTER',
      'CHARACTER VARYING',
      'CHARACTER VARYING(20)',
      'NVARCHAR',
      "ENUM('a','b')",
      'varchar(3)',
    ]) {
      expect(isStringLikeEngineType(type), type).toBe(true)
    }
  })

  it('never classifies an array/list of text as a scalar string-like type (m4-2 fix round 2)', () => {
    for (const type of [
      'VARCHAR[]',
      'VARCHAR[3]',
      'TEXT[]',
      'CHAR(2)[]',
      'LIST(VARCHAR)',
      'LIST(CHAR(2))',
      'LIST(TEXT)',
      "ENUM('a','b')[]",
    ]) {
      expect(isStringLikeEngineType(type), type).toBe(false)
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
      'BLOB',
      'BYTEA',
      'BINARY',
      'VARBINARY',
      'INTEGER[]',
      'STRUCT(a INTEGER)',
      'STRUCT(a VARCHAR)',
      'MAP(VARCHAR, INTEGER)',
      'MAP(VARCHAR, VARCHAR)',
      'DECIMAL(1,2,3)',
      'VARCHAR()',
      REVIEWER_PAYLOAD,
      '',
      null,
    ]) {
      expect(isStringLikeEngineType(type), String(type)).toBe(false)
    }
  })
})

describe('isBlobLikeEngineType — scalar binary/BLOB alias classification (AR-E1)', () => {
  it('classifies every scalar DuckDB binary alias', () => {
    // DESCRIBE canonicalizes all four to `blob` at the pinned CLI 1.5.5
    // (`DESCRIBE SELECT NULL::BLOB, NULL::BYTEA, NULL::BINARY,
    // NULL::VARBINARY` → one `blob` column each); an overlay may still declare
    // the aliases verbatim, so all four classify.
    for (const type of ['BLOB', 'blob', 'BYTEA', 'BINARY', 'VARBINARY']) {
      expect(isBlobLikeEngineType(type), type).toBe(true)
    }
  })

  it('never classifies a BLOB array/list as a scalar binary (shape-aware)', () => {
    for (const type of ['BLOB[]', 'BLOB[3]', 'LIST(BLOB)']) {
      expect(isBlobLikeEngineType(type), type).toBe(false)
    }
  })

  it('classifies textual, numeric, and invalid types as not BLOB-like (total)', () => {
    for (const type of [
      'VARCHAR',
      'TEXT',
      'BIGINT',
      'DECIMAL(10,2)',
      'BIT',
      'BIT VARYING',
      REVIEWER_PAYLOAD,
      '',
      null,
    ]) {
      expect(isBlobLikeEngineType(type), String(type)).toBe(false)
    }
  })
})
