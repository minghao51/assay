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
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  EngineTypeError,
  isBlobLikeEngineType,
  isStringLikeEngineType,
  parseEngineTypeExpression,
  validateEngineTypeExpression,
} from './type-expr'

const DUCKDB_CLI = process.env['DUCKDB'] ?? '/tmp/duckdb'
const hasDuckDbCli = existsSync(DUCKDB_CLI)

/** Run one statement through the pinned CLI, returning its stdout. */
function cli(sql: string): string {
  return execFileSync(DUCKDB_CLI, ['-csv', '-noheader', '-c', sql], { encoding: 'utf8' })
}

/** Run one statement that must fail, returning the CLI's stderr. */
function cliFailure(sql: string): string {
  try {
    cli(sql)
  } catch (error) {
    return String((error as { stderr?: string }).stderr ?? '')
  }
  throw new Error('expected the pinned CLI to reject the statement')
}

/** The exact payload from the m4-2 review finding 1. */
const REVIEWER_PAYLOAD =
  'VARCHAR) AS "c" FROM (...) ); CREATE TABLE assay_injected AS SELECT 31337; --'

const ACCEPTED_TYPES: readonly string[] = [
  'VARCHAR',
  'VARCHAR(10)',
  'VARCHAR(0)',
  'VARCHAR(2147483647)',
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
  'BIT(10)',
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
  // Optional-integer-modifier literals DuckDB cannot even parse as a type
  // modifier (the 1.5.5 parser reads the value as a signed 32-bit literal):
  // `SELECT 1::VARCHAR(999999999999)` is a Parser Error, so these must be
  // refused at validation instead of reaching SQL. A negative value is already
  // unreachable through the grammar (the lexer rejects `-`).
  'VARCHAR(999999999999)',
  'VARCHAR(2147483648)',
  'VARCHAR(99999999999999999999)',
  'TEXT(999999999999)',
  'VARCHAR(-1)',
  // Spellings outside the supported materialization: DuckDB 1.5.5 has no
  // VARBIT or BIT VARYING (both are Catalog Errors), so they are refused at
  // validation while BIT/BIT(n) and CHARACTER VARYING stay accepted.
  'VARBIT',
  'VARBIT(10)',
  'BIT VARYING',
  'BIT VARYING(3)',
  'BIT VARYING(10)',
  'DATE(2)',
  'INTEGER(2)',
  'DOUBLE(2)',
  'TIMESTAMP(3,4)',
  'TIMESTAMPTZ(3)',
  'FOO(1)',
]

describe('parseEngineTypeExpression — modifier bounds (defect 1)', () => {
  it('bounds the optional integer modifier to a DuckDB-expressible int32 literal', () => {
    // Pre-fix these were accepted, composed into a SQL type position and died
    // late in the engine's parser; the refusal now happens at validation.
    for (const type of ['VARCHAR(999999999999)', 'VARCHAR(2147483648)', 'TEXT(999999999999)']) {
      expect(() => parseEngineTypeExpression(type), type).toThrow(/between 0 and 2147483647/)
    }
    // Both ends of the expressible range stay accepted (CLI-pinned below).
    expect(() => parseEngineTypeExpression('VARCHAR(0)')).not.toThrow()
    expect(() => parseEngineTypeExpression('VARCHAR(2147483647)')).not.toThrow()
    // A negative modifier is unreachable through the grammar: the lexer has no
    // sign and rejects `-` as a disallowed character.
    expect(() => parseEngineTypeExpression('VARCHAR(-1)')).toThrow(/disallowed character/)
  })
})

describe('parseEngineTypeExpression — unsupported materializations (defect 2)', () => {
  it('refuses VARBIT and BIT VARYING outside the supported materialization', () => {
    // Structural validity is not enough: these spellings pass the grammar but
    // name a type this engine can never materialize, so the validator refuses
    // them in the module's typed-refusal voice rather than letting the
    // catalog error arrive after SQL composition.
    for (const type of ['VARBIT', 'VARBIT(10)', 'BIT VARYING', 'BIT VARYING(3)']) {
      expect(() => parseEngineTypeExpression(type), type).toThrow(
        /outside the supported materialization/,
      )
    }
    expect(() => parseEngineTypeExpression('VARBIT')).toThrow(/use BIT/)
    expect(() => parseEngineTypeExpression('BIT VARYING')).toThrow(/use BIT/)
    // The supported spellings are unchanged.
    for (const type of ['BIT', 'BIT(10)', 'CHARACTER VARYING', 'CHARACTER VARYING(20)']) {
      expect(() => parseEngineTypeExpression(type), type).not.toThrow()
    }
  })
})

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

/**
 * Real-engine agreement for the two validator boundaries (pinned CLI 1.5.5,
 * ADR 0038). Skipped only when the binary is absent, as the other agreement
 * suites do; where it exists these pins must run.
 */
describe.skipIf(!hasDuckDbCli)('type-expression agreement with the pinned DuckDB CLI', () => {
  it('pins the CLI dialect', () => {
    expect(execFileSync(DUCKDB_CLI, ['--version'], { encoding: 'utf8' })).toMatch(/v1\.5\./)
  })

  it('VARCHAR(<huge>) was a late engine failure, now refused before SQL (defect 1)', () => {
    // The pre-fix path accepted the expression and interpolated it into a SQL
    // type position; the failure belonged to the engine's parser, not to
    // validation:
    expect(cliFailure('SELECT 1::VARCHAR(999999999999)')).toMatch(/Parser Error/)
    expect(cliFailure('SELECT 1::VARCHAR(999999999999)')).toMatch(/syntax error/)
    // Expressible modifiers are accepted by the engine, so 0..2147483647 is
    // the honest bound:
    expect(cli('SELECT 1::VARCHAR(0)').trim()).toBe('1')
    expect(cli('SELECT 1::VARCHAR(2147483647)').trim()).toBe('1')
    // Post-fix the same spelling never composes: validation throws first.
    expect(() => parseEngineTypeExpression('VARCHAR(999999999999)')).toThrow(
      /between 0 and 2147483647/,
    )
  })

  it('VARBIT and BIT VARYING do not exist in the engine; BIT and CHARACTER VARYING do', () => {
    // Pre-fix these spellings passed validation and the Catalog Error arrived
    // after SQL composition:
    expect(cliFailure('SELECT 1::VARBIT')).toMatch(/Catalog Error/)
    expect(cliFailure('SELECT 1::VARBIT')).toMatch(/VARBIT does not exist/)
    expect(cliFailure('SELECT 1::BIT VARYING(10)')).toMatch(/Catalog Error/)
    expect(cliFailure('SELECT 1::BIT VARYING(10)')).toMatch(/does not exist/)
    // What the engine really has stays accepted:
    expect(cli("SELECT '101'::BIT(10)").trim()).toBe('101')
    expect(cli("SELECT '1'::BIT").trim()).toBe('1')
    expect(cli("SELECT 'abc'::CHARACTER VARYING").trim()).toBe('abc')
    // Post-fix the unsupported spellings never compose: validation throws.
    for (const type of ['VARBIT', 'VARBIT(10)', 'BIT VARYING', 'BIT VARYING(10)']) {
      expect(() => parseEngineTypeExpression(type), type).toThrow(
        /outside the supported materialization/,
      )
    }
  })
})
