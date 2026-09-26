// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Typed cell-input constraints (m4-3) — the honest client-side bridge from a
 * raw editor string to a domain `CellValue`, derived from the parsed DuckDB
 * column type (`parseDuckDbType`, m1-6's total parser).
 *
 * Design rules, spelled out because "typed constraints" is easy to over- or
 * under-promise:
 *
 * - **NULL is a value, not empty text.** This module never turns an empty
 *   string into `{ kind: 'null' }`; the editor's NULL affordance calls the
 *   commit path with `NULL_VALUE` directly. An empty string is a real empty
 *   string for textual columns, and a readable rejection for a numeric /
 *   temporal column.
 * - **The client validates shape, the engine owns the type space.** Numeric
 *   and boolean inputs are constrained here (a non-numeric string can never
 *   reach the engine for a numeric column). Temporal and textual values are
 *   handed to the engine as `text`/`string` — the domain's `text` kind is
 *   exactly the "engine-parseable literal" escape hatch for value spaces a JS
 *   number would corrupt (dates, timestamps, 64-bit ints, decimals). A value
 *   the engine's cast rejects surfaces later as a readable engine error when
 *   the overlay materializes — never silent corruption.
 * - **Wide numerics stay text.** `BIGINT`/`HUGEINT`/`DECIMAL`/unsigned
 *   64-bit types are sent as `text` so JSON's double-precision number space
 *   cannot silently round a user's value (the m4-1 domain contract).
 * - **Nested columns are read-only.** STRUCT/LIST/MAP/UNION edits are m4-4+
 *   work; this module reports them `unsupported` and the grid declines to
 *   open an editor rather than pretending.
 *
 * Everything is total (never throws) and engine/React-free, so it is
 * Node-tested.
 */
import type { CellValue } from '@assay/domain'
import type { DuckDbType } from '../schema/parseType'

/** How the grid should present (and validate) an editor for a column type. */
export type CellEditorKind = 'number' | 'boolean' | 'text' | 'temporal' | 'unsupported'

/** Numeric primitive type names whose values exceed JS's exact number space. */
const WIDE_NUMERIC = new Set([
  'BIGINT',
  'INT8',
  'LONG',
  'HUGEINT',
  'UHUGEINT',
  'UINT8',
  'UBIGINT',
  'DECIMAL',
  'NUMERIC',
])

/** Numeric primitives that fit losslessly in a JS double (and are validated here). */
const SAFE_NUMERIC = new Set([
  'TINYINT',
  'INT1',
  'SMALLINT',
  'INT2',
  'SHORT',
  'INTEGER',
  'INT',
  'INT4',
  'SIGNED',
  'UTINYINT',
  'UINT1',
  'USMALLINT',
  'UINT2',
  'UINTEGER',
  'UINT4',
  'FLOAT',
  'FLOAT4',
  'REAL',
  'DOUBLE',
  'FLOAT8',
])

const BOOLEAN_TYPES = new Set(['BOOLEAN', 'BOOL', 'LOGICAL'])

/** Textual primitives: the value is a plain string. */
const TEXT_TYPES = new Set([
  'VARCHAR',
  'CHAR',
  'BPCHAR',
  'TEXT',
  'STRING',
  'NVARCHAR',
  'UUID',
  'ENUM',
  'JSON',
])

/**
 * The base keyword of a parsed primitive label (the first whitespace/`(`
 * token, upper-cased): `DECIMAL(21,1)` → `DECIMAL`, `TIMESTAMP WITH TIME
 * ZONE` → `TIMESTAMP`. Labels are already opacity-safe strings.
 */
function primitiveBase(label: string): string {
  return label.trim().toUpperCase().split(/[\s(]/)[0] ?? ''
}

/** The temporal family a parsed primitive belongs to (`null` when not temporal). */
type TemporalFamily = 'date' | 'timestamp' | 'time'

function temporalFamily(type: DuckDbType): TemporalFamily | null {
  if (type.kind !== 'primitive') return null
  const base = primitiveBase(type.label)
  if (base === 'DATE') return 'date'
  if (base === 'TIME') return 'time'
  if (base.startsWith('TIMESTAMP')) return 'timestamp'
  return null
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * Format one temporal cell value as a human-readable, engine-round-trippable
 * literal (the m3-1 worker-boundary representations):
 *
 * - **DATE** crosses as epoch **milliseconds** (Arrow `Date32<DAY>.get()`),
 *   formatted `YYYY-MM-DD` in UTC.
 * - **TIMESTAMP** / **TIMESTAMP WITH TIME ZONE** cross as epoch
 *   **milliseconds** (Arrow `timestamp[us].get()` converts to ms), formatted
 *   as the UTC ISO-8601 instant `YYYY-MM-DDTHH:MM:SS.sssZ`. DuckDB parses
 *   both the naive and the zoned column type from this text (the `Z` is
 *   honoured for a zoned column and treated as wall time for a naive one).
 * - **TIME** crosses as **microseconds since midnight** (Arrow
 *   `Time64<MICROSECOND>.get()` → bigint), formatted `HH:MM:SS[.ffffff]`.
 *
 * Returns `null` when the value is not a finite temporal sample so the caller
 * falls back to the generic draft — the editor never fabricates a date from a
 * value it cannot interpret (never silent corruption). Committing the result
 * goes through the domain's `text` kind, so the engine parses it under the
 * column's type.
 */
function temporalDraft(value: unknown, family: TemporalFamily): string | null {
  if (family === 'time') {
    const micros = typeof value === 'bigint' ? Number(value) : value
    if (typeof micros !== 'number' || !Number.isFinite(micros) || micros < 0) return null
    const total = Math.trunc(micros)
    const hours = Math.floor(total / 3_600_000_000)
    const minutes = Math.floor((total % 3_600_000_000) / 60_000_000)
    const seconds = Math.floor((total % 60_000_000) / 1_000_000)
    const micro = total % 1_000_000
    const base = `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`
    return micro === 0 ? base : `${base}.${String(micro).padStart(6, '0')}`
  }
  const millis =
    value instanceof Date ? value.getTime() : typeof value === 'bigint' ? Number(value) : value
  if (typeof millis !== 'number' || !Number.isFinite(millis)) return null
  const date = new Date(millis)
  if (Number.isNaN(date.getTime())) return null
  const iso = date.toISOString()
  return family === 'date' ? iso.slice(0, 10) : iso
}

/**
 * Classify a parsed type into the editor's constraint family. Composite
 * kinds (struct/list/map/union) are read-only; `unknown` degrades to a
 * textual editor because the honest fallback for an unrecognized primitive
 * is "let the engine cast it", not a refusal.
 */
export function cellEditorKind(type: DuckDbType): CellEditorKind {
  if (type.kind !== 'primitive' && type.kind !== 'unknown') return 'unsupported'
  if (type.kind === 'unknown') return 'text'
  const base = primitiveBase(type.label)
  if (WIDE_NUMERIC.has(base) || SAFE_NUMERIC.has(base)) return 'number'
  if (BOOLEAN_TYPES.has(base)) return 'boolean'
  if (TEXT_TYPES.has(base)) return 'text'
  if (base === 'DATE' || base === 'TIME' || base.startsWith('TIMESTAMP')) return 'temporal'
  // Any other primitive (BLOB, INTERVAL, BIT, …) edits as text and lets the
  // engine's cast be the judge — the documented v1 boundary.
  return 'text'
}

/** One validation outcome: a committable value, or a readable rejection. */
export type CellInputResult =
  { readonly ok: true; readonly value: CellValue } | { readonly ok: false; readonly reason: string }

/** `^[+-]?(digits[.digits]?|.digits)(e[+-]?digits)?$`, no hex/Infinity/NaN. */
const NUMERIC_INPUT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

/**
 * Validate one editor string against a parsed column type. Total: every
 * input (including empty strings and junk) yields a typed result, never a
 * throw. Rejections carry a short, user-facing reason the grid renders as
 * text (`role="alert"`), and the caller leaves overlay state unchanged.
 */
export function validateCellInput(type: DuckDbType, text: string): CellInputResult {
  const kind = cellEditorKind(type)
  switch (kind) {
    case 'number': {
      const trimmed = text.trim()
      if (trimmed === '') {
        return { ok: false, reason: 'Enter a number, or use the NULL button to set NULL.' }
      }
      if (!NUMERIC_INPUT.test(trimmed)) {
        return { ok: false, reason: `"${text}" is not a number.` }
      }
      const base = type.kind === 'primitive' ? primitiveBase(type.label) : ''
      // Wide numerics never round-trip through a JS number (m4-1 `text` kind).
      if (WIDE_NUMERIC.has(base)) return { ok: true, value: { kind: 'text', text: trimmed } }
      const numeric = Number(trimmed)
      if (!Number.isFinite(numeric)) {
        return { ok: false, reason: 'That number is too large to represent.' }
      }
      return { ok: true, value: { kind: 'number', value: numeric } }
    }
    case 'boolean': {
      const trimmed = text.trim().toLowerCase()
      if (trimmed === 'true') return { ok: true, value: { kind: 'boolean', value: true } }
      if (trimmed === 'false') return { ok: true, value: { kind: 'boolean', value: false } }
      return { ok: false, reason: 'Enter true or false, or use the NULL button to set NULL.' }
    }
    case 'temporal': {
      if (text.trim() === '') {
        return { ok: false, reason: 'Enter a date/time value, or use the NULL button to set NULL.' }
      }
      // The engine owns temporal parsing and gives the readable error; the
      // `text` kind is the domain's engine-parseable literal.
      return { ok: true, value: { kind: 'text', text } }
    }
    case 'text':
      return { ok: true, value: { kind: 'string', value: text } }
    case 'unsupported':
      return { ok: false, reason: 'Nested columns are not editable yet (m4-4+).' }
  }
}

/**
 * The editor's initial draft text for a current cell value. NULLs become an
 * empty editor (there is no honest textual NULL), binary/nested values are
 * empty and not editable, everything else uses its display string. `bigint`
 * uses `String` so no precision is lost on re-commit.
 *
 * `type` (optional) lets a temporal column format the engine's epoch
 * representation as a human-readable, engine-round-trippable draft (see
 * `temporalDraft`) instead of the raw epoch number, so double-click + Enter
 * unchanged is a valid cast rather than a rejection.
 */
export function cellEditDraft(value: unknown, type?: DuckDbType): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Uint8Array) return ''
  const family = type === undefined ? null : temporalFamily(type)
  if (family !== null) {
    const temporal = temporalDraft(value, family)
    if (temporal !== null) return temporal
  }
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') return ''
  return String(value)
}
