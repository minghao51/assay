import { describe, expect, it } from 'vitest'
import { classifyColumnType, describeUnbindableType } from './schema'

/**
 * Classifier pins (m5-1): the documented family table over engine type
 * strings. Classification is exact and case-sensitive — DESCRIBE
 * spellings only, honest rejection for everything else (the m5-2
 * engine agreement test pins that real DESCRIBE output matches the
 * recognized spellings).
 */

describe('classifyColumnType — recognized canonical spellings', () => {
  it.each([
    // numeric
    ['TINYINT', 'numeric'],
    ['SMALLINT', 'numeric'],
    ['INTEGER', 'numeric'],
    ['BIGINT', 'numeric'],
    ['HUGEINT', 'numeric'],
    ['UTINYINT', 'numeric'],
    ['USMALLINT', 'numeric'],
    ['UINTEGER', 'numeric'],
    ['UBIGINT', 'numeric'],
    ['UHUGEINT', 'numeric'],
    ['FLOAT', 'numeric'],
    ['DOUBLE', 'numeric'],
    ['DECIMAL', 'numeric'], // the bare m5-0 vocabulary spelling
    // textual
    ['VARCHAR', 'textual'],
    // boolean / temporal
    ['BOOLEAN', 'boolean'],
    ['DATE', 'temporal'],
    ['TIME', 'temporal'],
    ['TIME WITH TIME ZONE', 'temporal'],
    ['TIMESTAMP', 'temporal'],
    ['TIMESTAMP WITH TIME ZONE', 'temporal'],
    // DuckDB 1.5.5 DESCRIBE sub-second-resolution spellings (AR-V4)
    ['TIMESTAMP_S', 'temporal'],
    ['TIMESTAMP_MS', 'temporal'],
    ['TIMESTAMP_NS', 'temporal'],
    // uuid / json / blob
    ['UUID', 'uuid'],
    ['JSON', 'json'],
    ['BLOB', 'blob'],
  ])('%s → %s', (type, family) => {
    expect(classifyColumnType(type)).toBe(family)
  })
})

describe('classifyColumnType — parameterized forms classified honestly', () => {
  it.each([
    ['DECIMAL(10,2)', 'numeric'],
    ['DECIMAL(1,0)', 'numeric'],
    ['DECIMAL(38,38)', 'numeric'],
    ['DECIMAL(38,10)', 'numeric'],
    ['VARCHAR(3)', 'textual'],
    ['VARCHAR(0)', 'textual'],
  ])('%s → %s', (type, family) => {
    expect(classifyColumnType(type)).toBe(family)
  })

  it.each([
    'DECIMAL(10)', // scale is mandatory in DESCRIBE output
    'DECIMAL(0,0)', // precision below the engine's documented range
    'DECIMAL(39,0)', // precision above DuckDB's 38
    'DECIMAL(5,9)', // scale > precision
    'DECIMAL(a,b)', // non-numeric parameters
    'DECIMAL(10, 2)', // spaces are not the canonical spelling
    'DECIMAL()', // empty parameters
    'VARCHAR(-1)',
    'VARCHAR()',
    'VARCHAR(3', // unterminated modifier
  ])('%s → other (fail-closed)', (type) => {
    expect(classifyColumnType(type)).toBe('other')
  })
})

describe('classifyColumnType — arrays, nested types, unknown spellings', () => {
  it.each([
    'INTEGER[]',
    'VARCHAR[]',
    'DECIMAL(10,2)[]',
    'INTEGER[][]',
    'STRUCT(a INTEGER)',
    'MAP(VARCHAR, INTEGER)',
    'UNION(a INTEGER, b VARCHAR)',
    'ENUM(a, b)',
    // Recognized DESCRIBE spellings with no bindable value family in v1 (AR-V4).
    'INTERVAL',
    'BIT',
    'FOO',
    'varchar', // case-sensitive: aliases/lowercase are not canonical output
    'TEXT', // an alias, never engine output — refused like the m5-0 vocabulary
    'INT',
    '',
  ])('%s → other', (type) => {
    expect(classifyColumnType(type)).toBe('other')
  })
})

describe('describeUnbindableType — honest rejection classes', () => {
  it('names arrays, nested types, recognized-unbindable and unknown spellings distinctly', () => {
    expect(describeUnbindableType('INTEGER[]')).toBe("array type 'INTEGER[]'")
    expect(describeUnbindableType('STRUCT(a INTEGER)')).toBe("nested type 'STRUCT(a INTEGER)'")
    expect(describeUnbindableType('FOO')).toBe("unknown engine type spelling 'FOO'")
    // Recognized DESCRIBE output is never called an unknown spelling (AR-V4).
    expect(describeUnbindableType('INTERVAL')).toBe(
      "recognized engine type 'INTERVAL' (no bindable value family in v1)",
    )
    expect(describeUnbindableType('BIT')).toBe(
      "recognized engine type 'BIT' (no bindable value family in v1)",
    )
  })
})
