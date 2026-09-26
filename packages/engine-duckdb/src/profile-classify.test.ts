// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for the m2-5 profile column classifier: pure string → kind
 * decisions pinned against the DuckDB 1.5.5 DESCRIBE spellings (verified via
 * the DuckDB CLI against the golden fixtures), plus the never-throws
 * degradation contract for unknown/hostile type strings.
 */
import { describe, expect, it } from 'vitest'
import { classifyProfileColumnType } from './profile-classify'

describe('classifyProfileColumnType (m2-5)', () => {
  it('classifies integer/decimal/float type strings as numeric', () => {
    expect(classifyProfileColumnType('BIGINT')).toBe('numeric')
    expect(classifyProfileColumnType('INTEGER')).toBe('numeric')
    expect(classifyProfileColumnType('SMALLINT')).toBe('numeric')
    expect(classifyProfileColumnType('TINYINT')).toBe('numeric')
    expect(classifyProfileColumnType('HUGEINT')).toBe('numeric')
    expect(classifyProfileColumnType('UBIGINT')).toBe('numeric')
    expect(classifyProfileColumnType('DOUBLE')).toBe('numeric')
    expect(classifyProfileColumnType('FLOAT')).toBe('numeric')
    expect(classifyProfileColumnType('REAL')).toBe('numeric')
    // Parametrized decimal: the base type is matched after stripping parens
    // (the exact spelling wide.parquet's value_maybe_null reports).
    expect(classifyProfileColumnType('DECIMAL(21,1)')).toBe('numeric')
    expect(classifyProfileColumnType('DECIMAL')).toBe('numeric')
    expect(classifyProfileColumnType('NUMERIC(10,2)')).toBe('numeric')
  })

  it('classifies strings, booleans, and temporal types as categorical', () => {
    expect(classifyProfileColumnType('VARCHAR')).toBe('categorical')
    expect(classifyProfileColumnType('BOOLEAN')).toBe('categorical')
    expect(classifyProfileColumnType('BOOL')).toBe('categorical')
    expect(classifyProfileColumnType('UUID')).toBe('categorical')
    // Temporal (documented m2-5 call): categorical top-k over the rendered
    // text; nullCount/distinctCount carry the rest.
    expect(classifyProfileColumnType('DATE')).toBe('categorical')
    expect(classifyProfileColumnType('TIMESTAMP')).toBe('categorical')
    expect(classifyProfileColumnType('TIMESTAMP WITH TIME ZONE')).toBe('categorical')
    expect(classifyProfileColumnType('TIME')).toBe('categorical')
  })

  it('classifies nested and exotic types as other (graceful degradation)', () => {
    // The exact strings the golden fixtures report.
    expect(
      classifyProfileColumnType(
        'STRUCT("name" VARCHAR, geo STRUCT(lat DECIMAL(21,1), lon DECIMAL(21,1)))',
      ),
    ).toBe('other')
    expect(classifyProfileColumnType('VARCHAR[]')).toBe('other')
    expect(classifyProfileColumnType('STRUCT(passed BOOLEAN, score DOUBLE)')).toBe('other')
    expect(classifyProfileColumnType('JSON')).toBe('other')
    expect(classifyProfileColumnType('BLOB')).toBe('other')
    expect(classifyProfileColumnType('MAP(VARCHAR, BIGINT)')).toBe('other')
    expect(classifyProfileColumnType('UNION(a INTEGER, b VARCHAR)')).toBe('other')
    expect(classifyProfileColumnType('INTEGER[]')).toBe('other')
    // Parameterized-base list (DuckDB 1.5.5 renders exactly this in DESCRIBE):
    // the `[]` suffix must win over paren-stripping — reducing to `DECIMAL`
    // would misclassify a LIST as numeric and its `avg()` binder error would
    // escape `profile()`. Regression pin for exactly that string.
    expect(classifyProfileColumnType('DECIMAL(21,1)[]')).toBe('other')
  })

  it('classifies fixed-size arrays as other (m3-1; DESCRIBE spellings verified against DuckDB 1.5.5)', () => {
    // DESCRIBE renders these exact strings for CREATE TABLE t(a INTEGER[2], …):
    expect(classifyProfileColumnType('INTEGER[2]')).toBe('other')
    expect(classifyProfileColumnType('VARCHAR[4]')).toBe('other')
    expect(classifyProfileColumnType('DECIMAL(21,1)[3]')).toBe('other')
    expect(classifyProfileColumnType('STRUCT(x INTEGER)[2]')).toBe('other')
    expect(classifyProfileColumnType('BIGINT[1000000]')).toBe('other')
    // Multi-dimensional arrays are arrays too.
    expect(classifyProfileColumnType('INTEGER[2][3]')).toBe('other')
    expect(classifyProfileColumnType('INTEGER[][]')).toBe('other')
    // Dimension text *inside* parens is not a top-level dimension, but the
    // container base already degrades:
    expect(classifyProfileColumnType('MAP(INTEGER[2], VARCHAR)')).toBe('other')
    expect(classifyProfileColumnType('STRUCT(a INTEGER[2], b VARCHAR[4])')).toBe('other')
  })

  it('keeps scalar classifications that merely look array-adjacent (m3-1 near-misses)', () => {
    // Parameterized scalars must stay scalar — the array rule fires only on a
    // top-level bracket:
    expect(classifyProfileColumnType('DECIMAL(21,1)')).toBe('numeric')
    expect(classifyProfileColumnType('NUMERIC(10,2)')).toBe('numeric')
    expect(classifyProfileColumnType('INTEGER')).toBe('numeric')
    expect(classifyProfileColumnType('VARCHAR')).toBe('categorical')
    expect(classifyProfileColumnType('TIMESTAMP WITH TIME ZONE')).toBe('categorical')
    // A quoted identifier containing bracket-looking text is not an array:
    expect(classifyProfileColumnType('"INT[2]"')).toBe('other') // unknown, but NOT numeric
    expect(classifyProfileColumnType('"DECIMAL(21,1)[3]"')).toBe('other')
  })

  it('degrades hostile fixed-size-array near-misses to other without throwing (m3-1)', () => {
    // Truncated / unbalanced dimension syntax must never reach the numeric
    // path (the old substring check could be slipped past; the structural
    // scan fails closed):
    expect(classifyProfileColumnType('INTEGER[2')).toBe('other') // unbalanced [
    expect(classifyProfileColumnType('INTEGER]2[')).toBe('other') // stray closer
    expect(classifyProfileColumnType('DECIMAL(21,1))[3]')).toBe('other') // extra closer
    expect(classifyProfileColumnType('INTEGER[')).toBe('other')
    expect(classifyProfileColumnType('INTEGER [ 2 ]')).toBe('other')
    expect(classifyProfileColumnType('INTEGER[0]')).toBe('other')
    expect(classifyProfileColumnType('INTEGER[-1]')).toBe('other')
    expect(classifyProfileColumnType('DECIMAL(21,1) [3]')).toBe('other')
    expect(classifyProfileColumnType('[2]')).toBe('other')
    expect(classifyProfileColumnType('"UNTERMINATED[2]')).toBe('other')
  })

  it('never throws: empty, unknown, and hostile strings degrade to other', () => {
    expect(classifyProfileColumnType('')).toBe('other')
    expect(classifyProfileColumnType('   ')).toBe('other')
    expect(classifyProfileColumnType('SOMETHING_FUTURE')).toBe('other')
    // Truncated garbage still classifies by its base token (no throw); any
    // unrecognized input lands on `other`.
    expect(classifyProfileColumnType('STRUCT(')).toBe('other')
    expect(classifyProfileColumnType('" ; DROP TABLE users; --')).toBe('other')
  })
})
