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
