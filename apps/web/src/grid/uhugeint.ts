// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Exact rendering of DuckDB `UHUGEINT` cells (unsigned 128-bit).
 *
 * DuckDB-WASM transports `UHUGEINT` as Apache Arrow `FixedSizeBinary(16)`: a
 * plain `Uint8Array` holding the raw 16 bytes, little-endian and **unsigned**
 * (no sign bit, no decimal precision/scale). It is neither a decimal payload
 * nor a BLOB, so `decimal.ts` deliberately exempts it (there is no scale to
 * decode) and `formatCell`'s `instanceof Uint8Array` branch summarized every
 * value as `<16 bytes>` — unreadable even though the cell is an integer.
 *
 * Byte order is verified, never assumed. A probe of the pinned transport this
 * app ships (duckdb-wasm 1.32.0 → engine v1.4.3, Arrow 17) read the Arrow
 * value of each `::UHUGEINT` cast and printed these payloads:
 *
 *   0::UHUGEINT                                      00 00 … (16 × 00)
 *   1::UHUGEINT                                      01 00 … (01 then 15 × 00)
 *   18446744073709551615::UHUGEINT                   ff × 8, then 8 × 00
 *   340282366920938463463374607431768211455::UHUGEINT  ff × 16
 *
 * i.e. little-endian unsigned. The same probe showed `HUGEINT` arriving as
 * Arrow `Decimal(38,0)` (a `DecimalBigNum`), which is why the signed decoder
 * stays in `decimal.ts`: only the unsigned fixed-size payload is handled here.
 *
 * Boundary: **scalar** `UHUGEINT` columns with the declared type available —
 * `formatCell(value, type, parsedType)` passes the parsed tree, so the decoder
 * runs before the generic byte summary. A BLOB of any width keeps its honest
 * `<N bytes>` summary (the type gate is `UHUGEINT` only), `HUGEINT`/`DECIMAL`
 * keep their signed decimal decoding, and a payload of the wrong width for a
 * `UHUGEINT` column is never mis-decoded (it keeps the byte summary). Nested
 * `UHUGEINT` leaves inside structs/lists are not decoded here (the nested
 * preview's decimal channel is a separate, documented boundary).
 *
 * Copy and export: the focused-cell copy composes through `formatCell`, so the
 * copied text is exactly the rendered text; raw CSV/JSONL/Parquet export is
 * engine-side and untouched. Text-only, total: never throws, never logs a
 * value (ADR 0025).
 */
import type { DuckDbType } from '../schema/parseType'

/** Arrow `FixedSizeBinary(16)` payload width in bytes. */
const UHUGEINT_BYTE_LENGTH = 16

/** Whether a parsed type tree names the unsigned 128-bit integer. */
export function isUHUGEINTType(type: DuckDbType | null): boolean {
  return type !== null && type.kind === 'primitive' && /^UHUGEINT$/i.test(type.label.trim())
}

/**
 * Decode one 16-byte little-endian **unsigned** integer payload to its exact
 * decimal text. Returns `null` for any other width (the caller then keeps its
 * existing summary path). Unlike `decodeDecimal128` there is no two's-
 * complement step: all 128 bits are magnitude.
 */
export function decodeUHUGEINT(view: ArrayBufferView): string | null {
  if (view.byteLength !== UHUGEINT_BYTE_LENGTH) return null
  // Copy through a byte view at the payload's own offset — Arrow subarrays
  // share the parent buffer, so `byteOffset` must be honored.
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  let value = 0n
  for (let index = bytes.length - 1; index >= 0; index--) {
    value = (value << 8n) | BigInt(bytes[index]!)
  }
  return value.toString()
}

/**
 * Format a value when the *parsed* type at its position is `UHUGEINT`.
 * Returns `null` for unrelated types or unrecognized value shapes so callers
 * keep their existing path (mirrors `formatDecimalForParsedType`).
 */
export function formatUHUGEINTForParsedType(
  value: unknown,
  type: DuckDbType | null,
): string | null {
  if (!isUHUGEINTType(type)) return null
  if (ArrayBuffer.isView(value)) return decodeUHUGEINT(value)
  return null
}
