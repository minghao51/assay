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
 */
import { formatDecimalValue } from './decimal'
import { formatNestedPreview } from './nested-preview'

/**
 * Format one cell value for display. `type` is the column's DuckDB type
 * string (from the effective schema), optional so existing callers that only
 * have a value keep working; when present it enables decimal decoding.
 */
export function formatCell(value: unknown, type?: string): string {
  if (value === null || value === undefined) return ''
  if (type !== undefined) {
    const decimal = formatDecimalValue(value, type)
    if (decimal !== null) return decimal
  }
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) return `<${String(value.length)} bytes>`
  if (typeof value === 'object') return formatNestedPreview(value)
  return String(value)
}
