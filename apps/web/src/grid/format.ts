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
 */
import { formatNestedPreview } from './nested-preview'

/** Format one cell value for display. */
export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) return `<${String(value.length)} bytes>`
  if (typeof value === 'object') return formatNestedPreview(value)
  return String(value)
}
