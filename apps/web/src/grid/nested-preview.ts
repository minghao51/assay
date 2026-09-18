/**
 * Honest v1 preview for nested cell values — structs and lists as they arrive
 * from the Arrow→rows projection (m3-2).
 *
 * Boundary: this module formats **object/array values only** — plain objects
 * and arrays, plus the two structural shapes Arrow cells actually take on the
 * main thread (m3-1 worker-boundary contract, pinned by
 * `@assay/testing`'s `normalizeArrowCell` scenarios): struct cells as
 * record-like values whose own keys follow the struct's field order, and list
 * cells as array-*like* values (a numeric `length` plus a positional `get(i)`
 * — apache-arrow `Vector` slices, not `Array`s). Scalars, Dates, and binary
 * keep their existing `formatCell` paths; a top-level NULL never reaches this
 * module (the grid renders NULL cells as empty — the m1-5 contract).
 *
 * The contract (each point unit- and property-tested):
 * - **Total** — any input (cycles, hostile shapes, NaN, huge strings) maps to
 *   a string; this module never throws into the render path.
 * - **Deterministic** — the same input renders the same string on every call.
 *   Key order is the object's own property order as delivered by Arrow (the
 *   struct's schema field order); keys are deliberately NOT re-sorted — a
 *   sorted order would lie about how the engine actually structured the data.
 * - **Length-capped** — the result is at most `maxLength` characters
 *   (default 120, marker included). A cut never happens silently: the marker
 *   `…` is appended whenever anything was elided.
 * - **Depth-aware** — children at container depth `maxDepth` or deeper render
 *   as a `…` placeholder (e.g. `{"a":{"b":{"c":…}}}` at the default depth 3),
 *   so render cost is bounded by *shape*, not only by length. The full value
 *   is the m3-3 inspector's job, not the grid cell's.
 * - **Visually distinct NULL/empty** — `null`, `""`, `[]`, `{}` all render
 *   differently, inside structures; nothing is silently dropped (unlike
 *   `JSON.stringify`, which collapses `undefined` fields and renders `NaN`/∞
 *   as `null`).
 *
 * Values are untrusted content (ADR 0007 spirit): this module only produces
 * plain text for React text nodes — nothing here is ever interpreted as
 * markup, and nothing about dataset contents is logged (ADR 0025).
 */

import type { DuckDbType } from '../schema/parseType'
import { formatDecimalForParsedType } from './decimal'

/** Default total length cap (truncation marker included), in UTF-16 units. */
export const NESTED_PREVIEW_DEFAULT_MAX_LENGTH = 120

/**
 * Default depth cap: children at this container depth or deeper render as
 * `…`. Depth 1 = the root value's own elements/fields; 2 = one container
 * deeper; 3 (default) = two containers deeper — so a depth-3 struct
 * `{"a":{"b":{"c":1}}}` previews as `{"a":{"b":{"c":…}}}` (shape visible,
 * leaf elided).
 */
export const NESTED_PREVIEW_DEFAULT_MAX_DEPTH = 3

/** The single-character marker placed where content was elided or cut. */
const ELLIPSIS = '…'

export interface NestedPreviewOptions {
  /**
   * Maximum rendered length including the truncation marker (default 120).
   * Non-finite values fall back to the default; values below 1 render as an
   * empty string (there is no room for any content or marker).
   */
  readonly maxLength?: number
  /**
   * Children at this container depth or deeper render as `…` (default 3).
   * Non-finite or < 1 values fall back to the default.
   */
  readonly maxDepth?: number
  /**
   * Parsed type of the value being previewed (m4-5). When supplied, decimal
   * leaves (`DECIMAL`/`NUMERIC`/`HUGEINT`) nested inside structs/lists are
   * decoded exactly instead of summarized as `<16 bytes>`, using each field's
   * type from the m1-6 parser. Omit to keep the type-blind render.
   */
  readonly columnType?: DuckDbType | null
}

/** Resolved, recursion-inert settings for one `formatNestedPreview` call. */
interface PreviewLimits {
  readonly maxLength: number
  readonly maxDepth: number
}

/**
 * A bounded output sink: accepts text while budget remains, records honestly
 * when anything was dropped. `finish()` applies the marker within the cap
 * (dropping the last emitted character to make room if needed).
 */
class BudgetWriter {
  private parts: string[] = []
  private length = 0
  private dropped = false

  constructor(private readonly limit: number) {}

  /** Appends `text` (or what fits of it); records a drop if anything was cut. */
  write(text: string): void {
    if (text.length === 0) return
    if (this.length >= this.limit) {
      this.dropped = true
      return
    }
    const fits = this.limit - this.length
    if (text.length <= fits) {
      this.parts.push(text)
      this.length += text.length
    } else {
      this.parts.push(text.slice(0, fits))
      this.length = this.limit
      this.dropped = true
    }
  }

  /** The rendered text, marker-applied and always ≤ the cap. */
  finish(): string {
    if (!this.dropped) return this.parts.join('')
    const kept = this.parts.join('').slice(0, Math.max(0, this.limit - 1))
    return kept + ELLIPSIS
  }
}

/**
 * True when the value renders as a positional sequence (Arrow list slices
 * satisfy this). Exported for the record inspector's tree model (m3-3), which
 * classifies the same main-thread cell shapes — reuse, not a fork.
 */
export function isListLike(value: object): boolean {
  return (
    typeof (value as { length?: unknown }).length === 'number' &&
    typeof (value as { get?: unknown }).get === 'function'
  )
}

/** True for `[]` / `{}`-shaped values (cheap emptiness probe). */
function isEmptyContainer(value: unknown): boolean {
  if (value === null) return false
  if (Array.isArray(value)) return value.length === 0
  if (typeof value !== 'object') return false
  if (isListLike(value)) return (value as { length: number }).length === 0
  if (ArrayBuffer.isView(value)) return false
  return Object.keys(value as Record<string, unknown>).length === 0
}

/**
 * The token for a value at/after the depth cap: empty containers keep their
 * distinct `[]`/`{}` (no elided content behind them, and NULL-vs-empty must
 * stay distinct); everything else collapses to the marker.
 */
function elisionToken(value: unknown): string {
  if (!isEmptyContainer(value)) return ELLIPSIS
  // isEmptyContainer returned true, so the value is an object here.
  const container = value as object
  return Array.isArray(container) || isListLike(container) ? '[]' : '{}'
}

/** Formats a primitive (non-container) value as honest, deterministic text. */
function formatPrimitive(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    // Honest literals — JSON.stringify would render NaN/∞ as `null`, which
    // lies about the cell. `String` keeps every IEEE shape distinguishable.
    return String(value)
  }
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'undefined') return 'undefined'
  if (typeof value === 'function' || typeof value === 'symbol') return String(value)
  // Dates can only appear if a future transport delivers them inside a
  // structure; render like the scalar path (ISO), quoted to stay JSON-ish.
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  return String(value)
}

/** The element type of a parsed list, or `null` when the type is not a list. */
function listElementType(type: DuckDbType | null): DuckDbType | null {
  if (type !== null && type.kind === 'list') return type.element
  return null
}

/**
 * The declared type of one struct/union field, or `null` when unknown. Only
 * structs and unions expose named fields; a MAP's rendered shape is not
 * modeled here, so its children stay type-blind (no false decoding).
 */
function fieldType(type: DuckDbType | null, name: string): DuckDbType | null {
  if (type === null) return null
  if (type.kind !== 'struct' && type.kind !== 'union') return null
  return type.fields.find((field) => field.name === name)?.type ?? null
}

/**
 * Renders a positional sequence `[a, b, …]` — elements read lazily through
 * `get` (never re-ordered, never materialized up front, so a hostile getter
 * only costs the prefix already rendered).
 */
function renderList(
  length: number,
  get: (index: number) => unknown,
  elementType: DuckDbType | null,
  depth: number,
  limits: PreviewLimits,
  out: BudgetWriter,
  active: WeakSet<object>,
): void {
  out.write('[')
  for (let index = 0; index < length; index++) {
    if (index > 0) out.write(',')
    renderValue(get(index), elementType, depth + 1, limits, out, active)
  }
  out.write(']')
}

/** Renders `{"k":v}` — keys in the object's own order (Arrow field order). */
function renderRecord(
  record: Record<string, unknown>,
  type: DuckDbType | null,
  depth: number,
  limits: PreviewLimits,
  out: BudgetWriter,
  active: WeakSet<object>,
): void {
  out.write('{')
  const keys = Object.keys(record)
  for (let index = 0; index < keys.length; index++) {
    if (index > 0) out.write(',')
    // JSON.stringify on the key: quoted + escaped, exactly like the values.
    out.write(`${JSON.stringify(keys[index]!)}:`)
    renderValue(record[keys[index]!], fieldType(type, keys[index]!), depth + 1, limits, out, active)
  }
  out.write('}')
}

/**
 * Formats one value (container or primitive) at the given container depth.
 * The depth cap elides the *value* (`…`) — keys/positions above it stay
 * visible, so a depth-3 struct reads `{"a":{"b":{"c":…}}}`: the shape is
 * honest, the hidden leaf is explicitly marked.
 */
function renderValue(
  value: unknown,
  type: DuckDbType | null,
  depth: number,
  limits: PreviewLimits,
  out: BudgetWriter,
  active: WeakSet<object>,
): void {
  if (depth >= limits.maxDepth) {
    // Empty containers still render as `[]`/`{}` at the cap — there is no
    // elided content behind them, and NULL-vs-empty must stay distinct.
    out.write(elisionToken(value))
    return
  }
  if (value === null) {
    out.write('null')
    return
  }
  // Dates are `typeof 'object'` but render like the scalar path (ISO, quoted
  // — totality support; the Arrow transport does not deliver them today).
  if (value instanceof Date) {
    out.write(formatPrimitive(value))
    return
  }
  if (typeof value !== 'object') {
    out.write(formatPrimitive(value))
    return
  }
  const container: object = value
  if (active.has(container)) {
    // A container re-entered through its own descendants. The distinctive
    // marker keeps this honest (it is not a depth or length elision) and
    // bounds render cost under any `maxDepth` setting.
    out.write('(circular)')
    return
  }
  // Binary views summarize like the scalar `formatCell` path (never a byte
  // dump) — *except* a 16-byte payload at a declared decimal position, which
  // is decoded exactly when the parsed field type is known (m4-5). Checked
  // before list-likeness: `Uint8Array` has a numeric length.
  if (ArrayBuffer.isView(container)) {
    const decimal = formatDecimalForParsedType(container, type)
    if (decimal !== null) {
      out.write(decimal)
      return
    }
    out.write(`<${String((container as { byteLength?: number }).byteLength ?? 0)} bytes>`)
    return
  }
  active.add(container)
  if (Array.isArray(container)) {
    renderList(
      container.length,
      (index) => container[index],
      listElementType(type),
      depth,
      limits,
      out,
      active,
    )
  } else if (isListLike(container)) {
    // Read positionally — never through property enumeration, whose keys on
    // Arrow `Vector` slices are internal machinery, not elements.
    const listLike = container as { length: number; get(index: number): unknown }
    renderList(
      listLike.length,
      (index) => listLike.get(index),
      listElementType(type),
      depth,
      limits,
      out,
      active,
    )
  } else {
    renderRecord(container as Record<string, unknown>, type, depth, limits, out, active)
  }
  active.delete(container)
}

/**
 * Format a nested cell value (struct/list or any JSON-ish shape) as a short,
 * deterministic, depth-aware preview line. See the module doc for the full
 * contract; scalars keep going through `formatCell`'s own paths.
 */
export function formatNestedPreview(value: unknown, options?: NestedPreviewOptions): string {
  const requestedLength = options?.maxLength
  const maxLength =
    typeof requestedLength === 'number' && Number.isFinite(requestedLength)
      ? Math.floor(requestedLength)
      : NESTED_PREVIEW_DEFAULT_MAX_LENGTH
  const requestedDepth = options?.maxDepth
  const maxDepth =
    typeof requestedDepth === 'number' && Number.isFinite(requestedDepth) && requestedDepth >= 1
      ? Math.floor(requestedDepth)
      : NESTED_PREVIEW_DEFAULT_MAX_DEPTH
  // Below 1 there is no room for content or marker: the honest render is the
  // empty string (and the `result.length ≤ maxLength` invariant holds).
  if (maxLength < 1) return ''
  const out = new BudgetWriter(maxLength)
  try {
    renderValue(value, options?.columnType ?? null, 0, { maxLength, maxDepth }, out, new WeakSet())
  } catch {
    // Totality: a hostile input (throwing getter, exotic proxy) must never
    // throw into the render path. Whatever rendered before the failure stays,
    // and the marker records that content is missing — never a silent cut.
    out.write(ELLIPSIS)
  }
  return out.finish()
}
