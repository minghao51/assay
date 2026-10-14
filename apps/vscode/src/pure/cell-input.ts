// SPDX-License-Identifier: AGPL-3.0-or-later

import type { CellValue } from '@assay/domain'

export type CellDraftResult =
  | { readonly ok: true; readonly value: CellValue }
  | { readonly ok: false; readonly message: string }

const LOSSLESS_TEXT_TYPES = /^(VARCHAR|TEXT|STRING|CHAR|BPCHAR|NVARCHAR|JSON|UUID)(\b|\s|\()/
// Arrow decimal and 128-bit integer vectors may expose word-array objects rather
// than a lossless scalar string; keep these types read-only until codecs cover them.
const LOSSLESS_NUMERIC_TYPES =
  /^(TINYINT|SMALLINT|INTEGER|INT|BIGINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT)(\b|\s|\()/
const LOSSLESS_FLOAT_TYPES = /^(FLOAT|REAL|DOUBLE)(\b|\s|\()/
const UNSUPPORTED_COMPOSITE = /^(STRUCT|MAP|UNION)\s*\(/
const ARRAY_TYPE = /\[[^\]]*\]$/

/** Parse only scalar drafts whose displayed representation has a lossless codec. */
export function parseCellDraft(type: string, draft: string): CellDraftResult {
  const normalized = type.trim().toUpperCase()
  if (!supportsCellDraft(normalized)) {
    return { ok: false, message: 'This scalar type has no lossless editor in this view.' }
  }
  if (/^(BOOLEAN|BOOL|LOGICAL)(\b|\s|\()/.test(normalized)) {
    const value = draft.trim().toLowerCase()
    if (value === 'true') return { ok: true, value: { kind: 'boolean', value: true } }
    if (value === 'false') return { ok: true, value: { kind: 'boolean', value: false } }
    return { ok: false, message: 'Enter true or false, or choose NULL.' }
  }
  if (LOSSLESS_TEXT_TYPES.test(normalized))
    return { ok: true, value: { kind: 'string', value: draft } }
  if (LOSSLESS_FLOAT_TYPES.test(normalized)) {
    const value = draft.trim()
    if (value === '' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
      return { ok: false, message: 'Enter a finite number, or choose NULL.' }
    }
    const numeric = Number(value)
    return Number.isFinite(numeric)
      ? { ok: true, value: { kind: 'number', value: numeric } }
      : { ok: false, message: 'That number is outside the supported range.' }
  }
  if (draft.trim() === '')
    return { ok: false, message: 'Empty text is not NULL; choose NULL explicitly.' }
  if (LOSSLESS_NUMERIC_TYPES.test(normalized)) {
    const value = draft.trim()
    if (!/^[+-]?(?:\d+|\d+\.\d*|\.\d+)$/.test(value)) {
      return { ok: false, message: 'Enter a valid numeric literal, or choose NULL.' }
    }
    return { ok: true, value: { kind: 'text', text: value } }
  }
  return { ok: false, message: 'This scalar type has no lossless editor in this view.' }
}

/** Only types whose displayed scalar representation can be parsed losslessly. */
export function supportsCellDraft(type: string): boolean {
  const normalized = type.trim().toUpperCase()
  if (UNSUPPORTED_COMPOSITE.test(normalized) || ARRAY_TYPE.test(normalized)) return false
  return (
    /^(BOOLEAN|BOOL|LOGICAL)(\b|\s|\()/.test(normalized) ||
    LOSSLESS_TEXT_TYPES.test(normalized) ||
    LOSSLESS_NUMERIC_TYPES.test(normalized) ||
    LOSSLESS_FLOAT_TYPES.test(normalized)
  )
}
