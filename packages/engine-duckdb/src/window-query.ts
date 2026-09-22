/**
 * SQL composition for filtered/sorted windows and filtered row counts (m2-2).
 *
 * Invariants (all security-relevant, all enforced here and unit-tested):
 *
 * - Only engine-generated names and quoted identifiers enter the SQL. The
 *   view name is the registry's generated `assay_tN`; every column identifier
 *   (projection, filter column, sort key) passes through `quotedIdentifier`
 *   (DuckDB `"` quoting with embedded-quote escaping), so hostile names
 *   (embedded quotes, `;`, unicode, spaces) stay *inside* identifier context
 *   and can never terminate the statement.
 * - The filter predicate is **user-authored SQL text** embedded as
 *   WHERE-clause content — the recorded grid-contracts v1 decision (ADR 0029
 *   note): each filter composes as `("<column>" <predicate>)`, AND-composed.
 *   The predicate is never placed inside a string literal, never wrapped in
 *   quoting of its own, and no cell value ever enters the SQL — the predicate
 *   runs only against the registered view, locally, on the user's own data
 *   (ADR 0007 spirit: user input is untrusted *content*, displayed or run
 *   as-is on their behalf, never executed as markup/HTML by the app).
 * - Absent (or empty) `filters`/`sort` produce SQL **byte-identical** to the
 *   pre-m2-2 queries — the null-clear protocol of the grid contract (`sort(null)`
 *   ⇒ natural order, `filter(null)` ⇒ empty predicate list) is expressed as
 *   "field absent ⇒ clause omitted".
 * - `limit`/`offset` are interpolated verbatim: callers must pass the output
 *   of `validateRowWindow` (safe non-negative integers, ≤ `MAX_RANGE_ROWS`),
 *   which both the client and the worker re-validate before composing.
 */
import { quotedIdentifier } from './format-view.js'
import type { EngineFilterSpec, EngineSortSpec } from './protocol.js'

/** Input for `composeWindowSql` (m2-2 `engine/range`). */
export interface EngineWindowQuery {
  /** The engine-generated view name (`TableRegistry.viewNameForTableId`). */
  readonly viewName: string
  /** Projection column names; omit/undefined for `*` (never empty). */
  readonly columns?: readonly string[]
  /** Ordered predicates, AND-composed; omit/empty for no WHERE clause. */
  readonly filters?: readonly EngineFilterSpec[]
  /** Ordered sort keys; omit/empty for no ORDER BY clause (natural order). */
  readonly sort?: readonly EngineSortSpec[]
  /** Pre-validated row count (from `validateRowWindow`). */
  readonly limit: number
  /** Pre-validated row offset (from `validateRowWindow`). */
  readonly offset: number
}

/**
 * The WHERE clause for a filter list, or `null` when it must be omitted
 * (absent or empty — both mean "no filters", the grid's `filter(null)`).
 */
export function whereClauseSql(filters?: readonly EngineFilterSpec[]): string | null {
  if (filters === undefined || filters.length === 0) return null
  return filters
    .map((filter) => `(${quotedIdentifier(filter.column)} ${filter.predicate})`)
    .join(' AND ')
}

/**
 * The ORDER BY clause for a sort list, or `null` when it must be omitted
 * (absent or empty — both mean "natural order", the grid's `sort(null)`).
 */
export function orderByClauseSql(sort?: readonly EngineSortSpec[]): string | null {
  if (sort === undefined || sort.length === 0) return null
  return sort.map((key) => `${quotedIdentifier(key.column)} ${key.direction}`).join(', ')
}

/**
 * `SELECT … FROM <view> [WHERE …] [ORDER BY …] LIMIT n OFFSET m` — the
 * windowed query `engine/range` runs. With no filters and no sort this is
 * byte-identical to the pre-m2-2 window query.
 */
export function composeWindowSql(query: EngineWindowQuery): string {
  const projection = query.columns ? query.columns.map(quotedIdentifier).join(', ') : '*'
  let sql = `SELECT ${projection} FROM ${quotedIdentifier(query.viewName)}`
  const where = whereClauseSql(query.filters)
  if (where !== null) sql += ` WHERE ${where}`
  const order = orderByClauseSql(query.sort)
  if (order !== null) sql += ` ORDER BY ${order}`
  return sql + ` LIMIT ${query.limit} OFFSET ${query.offset}`
}

/**
 * `SELECT count(*)::BIGINT AS row_count FROM <view> [WHERE …]` — the
 * (optionally filtered) total `engine/row-count` runs. Without filters this
 * is byte-identical to the pre-m2-2 count query.
 */
export function composeRowCountSql(query: {
  viewName: string
  filters?: readonly EngineFilterSpec[]
}): string {
  const base = `SELECT count(*)::BIGINT AS row_count FROM ${quotedIdentifier(query.viewName)}`
  const where = whereClauseSql(query.filters)
  return where === null ? base : `${base} WHERE ${where}`
}
