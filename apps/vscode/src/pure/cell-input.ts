// SPDX-License-Identifier: AGPL-3.0-or-later

import type { CellValue } from '@assay/domain'

export type CellDraftResult =
  | { readonly ok: true; readonly value: CellValue }
  | { readonly ok: false; readonly message: string }

/** Parse only scalar drafts; DuckDB remains the authority for type casts/ranges. */
export function parseCellDraft(type: string, draft: string): CellDraftResult {
  const normalized = type.trim().toUpperCase()
  if (/^(STRUCT|MAP|UNION)\s*\(/.test(normalized) || /\[[^\]]*\]$/.test(normalized)) {
    return { ok: false, message: 'Nested values are not editable in this view.' }
  }
  if (normalized === 'BOOLEAN' || normalized === 'BOOL' || normalized === 'LOGICAL') {
    const value = draft.trim().toLowerCase()
    if (value === 'true') return { ok: true, value: { kind: 'boolean', value: true } }
    if (value === 'false') return { ok: true, value: { kind: 'boolean', value: false } }
    return { ok: false, message: 'Enter true or false, or choose NULL.' }
  }
  if (/^(VARCHAR|TEXT|STRING|CHAR|BPCHAR|NVARCHAR|JSON|UUID)/.test(normalized)) {
    return { ok: true, value: { kind: 'string', value: draft } }
  }
  if (/^(FLOAT|REAL|DOUBLE)(\b|\s|\()/.test(normalized)) {
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
  // Integers/decimals/date-time and unfamiliar scalar types stay exact text;
  // the real engine's cast is the final authority, never JS floating point.
  return { ok: true, value: { kind: 'text', text: draft.trim() } }
}

/** Value-free editor capability check for composite DuckDB types. */
export function supportsCellDraft(type: string): boolean {
  const normalized = type.trim().toUpperCase()
  return !(/^(STRUCT|MAP|UNION)\s*\(/.test(normalized) || /\[[^\]]*\]$/.test(normalized))
}
