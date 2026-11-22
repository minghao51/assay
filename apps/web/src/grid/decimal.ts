// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Arrow decimal rendering (m4-4 fix round).
 *
 * DuckDB-WASM transports `DECIMAL(p,s)` as an Apache Arrow `Decimal128`, and
 * Arrow's `Vector.get()` hands the main thread a `DecimalBigNum`: a
 * `Uint32Array` *subclass* holding the 16-byte little-endian two's-complement
 * unscaled integer. `formatCell`'s `value instanceof Uint8Array` branch does
 * not match it (it is a `Uint32Array`, not a `Uint8Array`), so the value fell
 * through to the nested preview's `ArrayBuffer.isView` summary and every cell
 * rendered `<16 bytes>` — unreadable, even though the cast itself succeeded.
 *
 * This module decodes the bytes with the column's declared `(precision, scale)`
 * from the existing m1-6 type parser (`parseDuckDbType`) and renders the human
 * value exactly (never through a lossy float): `DECIMAL(10,2)` unscaled
 * `5200000` → `52000.00`, `-1234500` → `-12345.00`.
 *
 * Sibling audit (empirically confirmed against DuckDB-WASM 1.32 / Arrow 17):
 * - `HUGEINT` arrives as the same `DecimalBigNum` (`Arrow Decimal(38,0)`), so
 *   it shares this decoder with scale 0 and is fixed here too.
 * - `UUID` arrives as Arrow `Utf8` — a plain string, already readable.
 * - `BLOB` arrives as Arrow `Binary` (`Uint8Array`) and stays `<N bytes>`
 *   (legitimately binary; `formatCell`'s existing summary).
 * - `UHUGEINT` arrives as `FixedSizeBinary(16)` (a `Uint8Array`), but it is an
 *   **unsigned** integer with no precision/scale, so it is deliberately not
 *   decoded here: `uhugeint.ts` renders its exact unsigned 128-bit value
 *   (b2 defect 3). This decoder must never sign-extend it.
 *
 * Boundary: this decoder recognizes **top-level** decimal-like column types
 * from their type string, and — via `decimalSpecForParsedType` — decimal
 * leaves at any position in the parsed type tree. The nested preview threads
 * the parsed struct/list field types through its walk (m4-5), so a decimal
 * inside `STRUCT("a" DECIMAL(10,2))` or `DECIMAL(10,2)[]` now renders its
 * exact value too; the m4-4 carry-over (`<16 bytes>`) is closed. `UHUGEINT`
 * (Arrow `FixedSizeBinary(16)`) is not decimal-like and is handled by
 * `uhugeint.ts` instead, so the signed decoder stays total for every
 * non-decimal type here (returns `null`).
 *
 * Text-only, total: unknown shapes/lengths return `null` and the caller keeps
 * its existing formatting path. No dataset value is ever logged (ADR 0025).
 */
import { parseDuckDbType } from '../schema/parseType'
import type { DuckDbType } from '../schema/parseType'

/** The declared precision/scale of a decimal-like column. */
export interface DecimalSpec {
  readonly precision: number
  readonly scale: number
}

/**
 * DuckDB's bare `DECIMAL`/`NUMERIC` default is `DECIMAL(18,3)` (the engine's
 * `type-expr.ts` records the same default).
 */
const DEFAULT_DECIMAL: DecimalSpec = { precision: 18, scale: 3 }

/**
 * DuckDB-WASM exports `HUGEINT` as Arrow `Decimal(38,0)`: a signed 128-bit
 * integer with no fractional part.
 */
const HUGEINT_DECIMAL: DecimalSpec = { precision: 38, scale: 0 }

/** Arrow decimal128 payload width in bytes. */
const DECIMAL128_BYTE_LENGTH = 16

/**
 * Recognize a decimal-like label (the primitive label from the m1-6 tree).
 * Label-only so callers that already hold the parsed tree (q-1) never pay a
 * second parse.
 */
function decimalSpecForLabel(label: string): DecimalSpec | null {
  const trimmed = label.trim()
  const withModifiers = /^(?:DECIMAL|NUMERIC)\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(trimmed)
  if (withModifiers !== null) {
    const precision = Number(withModifiers[1])
    const scale = Number(withModifiers[2])
    if (Number.isFinite(precision) && Number.isFinite(scale)) return { precision, scale }
    return null
  }
  if (/^(?:DECIMAL|NUMERIC)$/i.test(trimmed)) return DEFAULT_DECIMAL
  if (/^HUGEINT$/i.test(trimmed)) return HUGEINT_DECIMAL
  return null
}

/**
 * Recognize the column types whose Arrow value is a 128-bit decimal payload.
 * Uses the m1-6 parser so whitespace/quoting differences in the engine's
 * DESCRIBE string do not matter. Returns `null` for every other type.
 */
export function decimalSpecForType(type: string): DecimalSpec | null {
  const parsed = parseDuckDbType(type)
  if (parsed.kind !== 'primitive') return null
  return decimalSpecForLabel(parsed.label)
}

/**
 * Render an unscaled signed integer at the given decimal scale. The value is
 * `unscaled / 10^scale`; the fraction is zero-padded and never rounded, so no
 * precision is lost. `scale <= 0` (or a non-integer) renders the integer
 * as-is.
 */
export function formatUnscaledDecimal(unscaled: bigint, scale: number): string {
  const safeScale = Number.isInteger(scale) && scale > 0 ? scale : 0
  const negative = unscaled < 0n
  const magnitude = (negative ? -unscaled : unscaled).toString()
  const sign = negative ? '-' : ''
  if (safeScale === 0) return sign + magnitude
  const padded = magnitude.padStart(safeScale + 1, '0')
  const split = padded.length - safeScale
  return `${sign}${padded.slice(0, split)}.${padded.slice(split)}`
}

/**
 * Recognize a parsed type (m1-6 tree) whose Arrow value is a 128-bit decimal
 * payload. Used by the nested preview (m4-5) to decode decimals nested inside
 * structs/lists, where only the parsed field type — not a flat type string —
 * is available at each leaf.
 */
export function decimalSpecForParsedType(type: DuckDbType | null): DecimalSpec | null {
  if (type === null || type.kind !== 'primitive') return null
  return decimalSpecForLabel(type.label)
}

/**
 * Format a value when the *parsed* type at its position is decimal-like.
 * Returns `null` for unrelated types or unrecognized value shapes so callers
 * keep their existing path (mirrors `formatDecimalValue`, which takes the raw
 * type string).
 */
export function formatDecimalForParsedType(value: unknown, type: DuckDbType | null): string | null {
  const spec = decimalSpecForParsedType(type)
  if (spec === null) return null
  if (ArrayBuffer.isView(value)) return decodeDecimal128(value, spec.scale)
  if (typeof value === 'bigint') return formatUnscaledDecimal(value, spec.scale)
  return null
}

/**
 * Decode one 16-byte little-endian two's-complement Arrow decimal128 payload.
 * Returns `null` for any other width (the caller then keeps its existing
 * summary path). The sign is recovered from bit 127, not from the typed-array
 * element type, so it is correct for both the `DecimalBigNum` and a plain
 * `Uint8Array` payload.
 */
export function decodeDecimal128(view: ArrayBufferView, scale: number): string | null {
  if (view.byteLength !== DECIMAL128_BYTE_LENGTH) return null
  // Copy through a byte view at the payload's own offset — Arrow subarrays
  // share the parent buffer, so `byteOffset` must be honored.
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  let value = 0n
  for (let index = 0; index < bytes.length; index++) {
    value |= BigInt(bytes[index]!) << BigInt(8 * index)
  }
  if ((value & (1n << 127n)) !== 0n) value -= 1n << 128n
  return formatUnscaledDecimal(value, scale)
}

/**
 * Format a cell value when the column's declared type is decimal-like
 * (`DECIMAL`/`NUMERIC`/`HUGEINT`). Returns `null` for unrelated types or
 * unrecognized value shapes, so `formatCell` falls back unchanged.
 */
export function formatDecimalValue(value: unknown, type: string): string | null {
  const spec = decimalSpecForType(type)
  if (spec === null) return null
  if (ArrayBuffer.isView(value)) return decodeDecimal128(value, spec.scale)
  // Defensive: a future/other Arrow path could deliver the integer directly.
  if (typeof value === 'bigint') return formatUnscaledDecimal(value, spec.scale)
  return null
}
