import { describe, expect, it } from 'vitest'
import { parseDuckDbType } from '../schema/parseType'
import { cellEditDraft, cellEditorKind, validateCellInput } from './typed-input'

const type = (raw: string) => parseDuckDbType(raw)

describe('cellEditorKind — total classification from the parsed type', () => {
  it('classifies numeric types (wide and safe, aliases included)', () => {
    expect(cellEditorKind(type('BIGINT'))).toBe('number')
    expect(cellEditorKind(type('INTEGER'))).toBe('number')
    expect(cellEditorKind(type('DOUBLE'))).toBe('number')
    expect(cellEditorKind(type('DECIMAL(21,1)'))).toBe('number')
  })

  it('classifies booleans, text, and temporal primitives', () => {
    expect(cellEditorKind(type('BOOLEAN'))).toBe('boolean')
    expect(cellEditorKind(type('VARCHAR'))).toBe('text')
    expect(cellEditorKind(type('TEXT'))).toBe('text')
    expect(cellEditorKind(type('DATE'))).toBe('temporal')
    expect(cellEditorKind(type('TIMESTAMP WITH TIME ZONE'))).toBe('temporal')
  })

  it('classifies composite kinds as unsupported (read-only) and unknown as text', () => {
    expect(cellEditorKind(type('STRUCT(a INTEGER)'))).toBe('unsupported')
    expect(cellEditorKind(type('VARCHAR[]'))).toBe('unsupported')
    expect(cellEditorKind(type('MAP(VARCHAR, INTEGER)'))).toBe('unsupported')
    expect(cellEditorKind(type('WEIRD_TYPE'))).toBe('text')
  })
})

describe('validateCellInput — numeric constraints', () => {
  it('accepts safe numeric text as a JS number', () => {
    expect(validateCellInput(type('INTEGER'), '42')).toEqual({
      ok: true,
      value: { kind: 'number', value: 42 },
    })
    expect(validateCellInput(type('DOUBLE'), '-1.5e3')).toEqual({
      ok: true,
      value: { kind: 'number', value: -1500 },
    })
  })

  it('keeps wide numeric types as engine-parseable text (no precision loss)', () => {
    expect(validateCellInput(type('BIGINT'), '9007199254740993')).toEqual({
      ok: true,
      value: { kind: 'text', text: '9007199254740993' },
    })
    expect(validateCellInput(type('DECIMAL(38,2)'), '1.25')).toEqual({
      ok: true,
      value: { kind: 'text', text: '1.25' },
    })
  })

  it('rejects non-numeric and empty input with a readable reason', () => {
    const nonNumeric = validateCellInput(type('INTEGER'), 'abc')
    expect(nonNumeric.ok).toBe(false)
    if (!nonNumeric.ok) expect(nonNumeric.reason).toContain('not a number')
    const empty = validateCellInput(type('BIGINT'), '')
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.reason).toContain('NULL')
  })

  it('rejects a number that overflows the double space', () => {
    const result = validateCellInput(type('DOUBLE'), '1e400')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('too large')
  })
})

describe('validateCellInput — boolean, temporal, text', () => {
  it('accepts true/false case-insensitively and rejects anything else', () => {
    expect(validateCellInput(type('BOOLEAN'), ' TRUE ')).toEqual({
      ok: true,
      value: { kind: 'boolean', value: true },
    })
    expect(validateCellInput(type('BOOLEAN'), 'false')).toEqual({
      ok: true,
      value: { kind: 'boolean', value: false },
    })
    const rejected = validateCellInput(type('BOOLEAN'), 'yes')
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.reason).toContain('true or false')
  })

  it('passes temporal values through as engine-parseable text (engine owns the type space)', () => {
    expect(validateCellInput(type('DATE'), '2026-01-02')).toEqual({
      ok: true,
      value: { kind: 'text', text: '2026-01-02' },
    })
    const empty = validateCellInput(type('DATE'), '   ')
    expect(empty.ok).toBe(false)
  })

  it('treats an empty string as a real empty string for textual columns (never NULL)', () => {
    expect(validateCellInput(type('VARCHAR'), '')).toEqual({
      ok: true,
      value: { kind: 'string', value: '' },
    })
    expect(validateCellInput(type('VARCHAR'), 'hello')).toEqual({
      ok: true,
      value: { kind: 'string', value: 'hello' },
    })
  })

  it('rejects unsupported (nested) types with a readable reason', () => {
    const result = validateCellInput(type('STRUCT(a INTEGER)'), 'x')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('Nested columns')
  })
})

describe('cellEditDraft — the honest starting text of an editor', () => {
  it('is empty for NULL and binary/nested values, ISO for dates, String otherwise', () => {
    expect(cellEditDraft(null)).toBe('')
    expect(cellEditDraft(undefined)).toBe('')
    expect(cellEditDraft(new Uint8Array([1]))).toBe('')
    expect(cellEditDraft({ a: 1 })).toBe('')
    expect(cellEditDraft(new Date('2026-01-02T03:04:05.000Z'))).toBe('2026-01-02T03:04:05.000Z')
    expect(cellEditDraft(123n)).toBe('123')
    expect(cellEditDraft('x')).toBe('x')
  })
})
