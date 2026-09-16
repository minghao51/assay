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
