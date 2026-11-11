// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Cell formatting for DOM projection. Values arrive as plain JS values from
 * the Arrow→rows projection (numbers, strings, bigints, booleans, Dates,
 * nested struct/list objects, binary). Formatting is total: every input maps
 * to a short, deterministic string — never thrown into the render path.
 * NULL renders as an empty cell (the row's `data-status="ready"` distinguishes
 * it from a loading placeholder).
 *
 * m3-2: nested struct/list values (plain or in their raw Arrow shapes —
 * record-likes for structs, `{length, get}`-likes for list slices) render
 * through the bounded, depth-aware nested preview instead of raw
 * `JSON.stringify`, which was unbounded in length, blind to depth, and
 * dishonest for `NaN`/`undefined` members. Scalars keep their existing paths.
 *
 * m4-4 fix round: when the column's declared type is passed, decimal-like
 * Arrow payloads (`DECIMAL(p,s)` and the `HUGEINT` → Arrow `Decimal(38,0)`
 * mapping) are decoded to their exact human value first. Arrow's
 * `DecimalBigNum` is a `Uint32Array` subclass, so the old `Uint8Array`
 * binary check missed it and the nested preview summarized it as
 * `<16 bytes>`. See `decimal.ts`.
 *
 * wf-01 (WFD-06 = B): the declared-type channel now also drives **temporal**
 * cells. A measured probe of the real engine found that no payload is ever a
 * `Date`: `DATE`/`TIMESTAMP*` arrive as epoch-**millisecond** numbers (often
 * fractional, carrying the delivered µs) and `TIME` as a **bigint of
 * microseconds since midnight**, so every typed temporal cell used to render
 * as a raw number and the `Date` branch was dead code for engine data. Those
 * families now render the approved UTC ISO-like text at their exactly
 * delivered precision, and fall back to the raw number whenever that
 * precision is not recoverable (never a truncation, never a fabricated
 * instant) — including **every** `TIMESTAMP_NS` column, whose declared
 * precision the Arrow→rows projection already dropped. See
 * `temporal-display.ts`. Scope is scalar cells plus the focused
 * display-value copy, which composes through this same function; nested
 * previews, the Record tree and untyped SQL results keep raw temporals
 * (WF-O2).
 */
import { formatDecimalForParsedType } from './decimal'
import { formatTemporalForParsedType } from './temporal-display'
import { formatNestedPreview } from './nested-preview'
import { parseDuckDbType } from '../schema/parseType'
import type { DuckDbType } from '../schema/parseType'

/**
 * Format one cell value for display. `type` is the column's DuckDB type
 * string (from the effective schema), optional so existing callers that only
 * have a value keep working; when present it enables decimal decoding —
 * top-level and nested struct/list decimal leaves via the parsed type tree
 * passed to the nested preview (m4-5).
 *
 * q-1: callers that already hold the column's parsed type tree (the grid
 * precomputes one per column) may pass it as `parsedType`, which skips the
 * per-cell `parseDuckDbType` on the decimal and object paths. When omitted,
 * `type` is parsed as before. Explicit `null` is equivalent to omission here:
 * the `??` fallback reparses `type`; callers that need to suppress parsing
 * must provide no `type` (the current callers never pass explicit null).
 */
export function formatCell(value: unknown, type?: string, parsedType?: DuckDbType | null): string {
  if (value === null || value === undefined) return ''
  const parsed = parsedType ?? (type === undefined ? null : parseDuckDbType(type))
  if (parsed !== null) {
    const decimal = formatDecimalForParsedType(value, parsed)
    if (decimal !== null) return decimal
    // wf-01: temporal families only; every other type (and every payload the
    // temporal decoder cannot read exactly) returns null and keeps its path.
    const temporal = formatTemporalForParsedType(value, parsed)
    if (temporal !== null) return temporal
  }
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) return `<${String(value.length)} bytes>`
  if (typeof value === 'object') {
    return formatNestedPreview(value, { columnType: parsed })
  }
  return String(value)
}
