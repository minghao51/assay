// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { parseCellDraft, supportsCellDraft } from './cell-input'

describe('parseCellDraft', () => {
  it('preserves wide integer drafts exactly for engine-side range checks', () => {
    expect(parseCellDraft('BIGINT', '9007199254740993')).toEqual({
      ok: true,
      value: { kind: 'text', text: '9007199254740993' },
    })
  })

  it('keeps empty text distinct from explicit NULL and rejects empty numeric drafts', () => {
    expect(parseCellDraft('VARCHAR', '')).toEqual({
      ok: true,
      value: { kind: 'string', value: '' },
    })
    expect(parseCellDraft('INTEGER', '')).toMatchObject({ ok: false })
    expect(parseCellDraft('DECIMAL(18,2)', 'not-a-number')).toMatchObject({ ok: false })
  })

  it('keeps Arrow decimal and 128-bit integer word-array representations read-only', () => {
    // Arrow Decimal(18,2) may return Uint32Array words, not a scalar decimal.
    const arrowDecimalWords = new Uint32Array([12345, 0, 0, 0])
    const arrowDecimalValue = { words: arrowDecimalWords }
    expect(arrowDecimalValue.words).toBeInstanceOf(Uint32Array)
    expect(String(arrowDecimalValue)).toBe('[object Object]')
    for (const type of ['DECIMAL(18,2)', 'NUMERIC(18,2)', 'HUGEINT', 'UHUGEINT']) {
      expect(supportsCellDraft(type), type).toBe(false)
      expect(parseCellDraft(type, String(arrowDecimalValue)).ok, type).toBe(false)
    }
    expect(supportsCellDraft('BIGINT')).toBe(true)
    expect(parseCellDraft('BIGINT', '9007199254740993').ok).toBe(true)
  })

  it('refuses binary, temporal, and unfamiliar scalar codecs', () => {
    for (const type of ['BLOB', 'DATE', 'TIMESTAMP', 'INTERVAL', 'GEOMETRY', 'ENUM']) {
      expect(supportsCellDraft(type), type).toBe(false)
      expect(parseCellDraft(type, 'unchanged preview').ok, type).toBe(false)
    }
  })

  it('accepts only explicit boolean literals and declines nested values', () => {
    expect(parseCellDraft('BOOLEAN', 'false')).toEqual({
      ok: true,
      value: { kind: 'boolean', value: false },
    })
    expect(parseCellDraft('BOOLEAN', 'maybe')).toMatchObject({ ok: false })
    expect(supportsCellDraft('STRUCT(a INTEGER)')).toBe(false)
    expect(supportsCellDraft('INTEGER[]')).toBe(false)
    expect(supportsCellDraft('INTEGER[3]')).toBe(false)
  })

  it('uses finite numeric values only for floating-point types', () => {
    expect(parseCellDraft('DOUBLE', '1.25')).toEqual({
      ok: true,
      value: { kind: 'number', value: 1.25 },
    })
    expect(parseCellDraft('DOUBLE', '1e999')).toMatchObject({ ok: false })
  })
})
