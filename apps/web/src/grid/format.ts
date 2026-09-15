/**
 * Cell formatting for DOM projection. Values arrive as plain JS values from
 * the Arrow→rows projection (numbers, strings, bigints, booleans, Dates,
 * nested struct/list objects, binary). Formatting is total: every input maps
 * to a short, deterministic string — never thrown into the render path.
 * NULL renders as an empty cell (the row's `data-status="ready"` distinguishes
 * it from a loading placeholder).
 */

/** Format one cell value for display. */
export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) return `<${String(value.length)} bytes>`
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
