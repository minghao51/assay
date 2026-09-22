/**
 * Profile column classification (m2-5): decide, from a DuckDB type string
 * (exactly what DESCRIBE / `schema()` report), how `engine/profile` should
 * profile a column.
 *
 * Rules (documented decision, mirrored by the conformance expectations):
 *
 * - `numeric` — integer / decimal / float types (canonical DESCRIBE spellings
 *   plus widely-used aliases). They get exact numeric stats
 *   (min/max/mean/stddev/quantiles). DECIMAL carries its `(p,s)` suffix, so
 *   the base type is matched before any parenthesis.
 * - `categorical` — every other *scalar* type: strings, booleans, and — the
 *   recorded m2-5 call — **temporal types (DATE/TIME/TIMESTAMP and friends)**.
 *   Dates are low-cardinality in exploratory data, their top-k (rendered
 *   ISO-ish text, DuckDB's deterministic `CAST(... AS VARCHAR)` form) is
 *   directly useful, and nullCount/distinctCount carry the rest; they get no
 *   separate numeric payload because their "stats" are not numbers under this
 *   contract (a future temporal payload kind would be an additive change).
 * - `other` — everything else (nested `STRUCT`/`LIST`/`MAP`/`UNION`, `JSON`,
 *   `BLOB`, `INTERVAL`, enums-as-parenthesized declarations, and anything
 *   unrecognized): graceful degradation to name/type/nullCount/distinctCount.
 *   Container types are detected structurally (m3-1): a scan that is bracket-
 *   and quote-aware decides from the *shape* of the type string — any
 *   top-level array dimension (`INTEGER[]`, `DECIMAL(21,1)[]`, and fixed-size
 *   arrays like `INTEGER[2]`, `VARCHAR[4]`, `DECIMAL(21,1)[3]`,
 *   `STRUCT(a INTEGER)[2]`, `INTEGER[2][3]`) makes the column a list/array
 *   and therefore never scalar. The check runs before any paren-stripping, so
 *   a parameterized-base fixed-size list (`DECIMAL(21,1)[3]`, DuckDB 1.5.5's
 *   exact DESCRIBE spelling) cannot reduce to `DECIMAL` and get misrouted
 *   into the numeric aggregate path, where its `avg()`/`quantile_cont()`
 *   binder error would escape `profile()`.
 *
 * The function is total and never throws (m1-6's type-string-parser
 * precedent): an unknown or hostile type string classifies as `other`, never
 * an error — profiling an exotic type must degrade, not fail.
 */
import type { EngineProfileColumnKind } from './protocol.js'

/** Canonical DuckDB numeric type strings (+ common aliases), parens stripped. */
const NUMERIC_TYPES = new Set([
  'TINYINT',
  'SMALLINT',
  'INTEGER',
  'BIGINT',
  'HUGEINT',
  'UTINYINT',
  'USMALLINT',
  'UINTEGER',
  'UBIGINT',
  'UHUGEINT',
  'FLOAT',
  'REAL',
  'DOUBLE',
  // Widely-used aliases DuckDB accepts in DDL; DESCRIBE normally reports the
  // canonical names above, but type strings can arrive from other surfaces.
  'INT',
  'INT4',
  'INT8',
  'SIGNED',
  'FLOAT4',
  'FLOAT8',
  'DECIMAL', // DESCRIBE reports "DECIMAL(p,s)" — matched after stripping parens
  'NUMERIC',
])

/** Canonical DuckDB scalar non-numeric type strings (+ common aliases). */
const CATEGORICAL_TYPES = new Set([
  'VARCHAR',
  'CHAR',
  'BPCHAR',
  'TEXT',
  'STRING',
  'BOOLEAN',
  'BOOL',
  'LOGICAL',
  'UUID',
  'DATE',
  'TIME',
  'TIMESTAMP',
  'DATETIME',
  'TIMESTAMP_S',
  'TIMESTAMP_MS',
  'TIMESTAMP_NS',
  'TIMESTAMPTZ',
  'TIME WITH TIME ZONE',
  'TIMESTAMP WITH TIME ZONE',
])

/**
 * Classify one DuckDB type string for profiling. Empty/unknown/hostile input
 * classifies as `other` (never throws).
 *
 * m3-1 hardening: the scan is structural, not substring-based. One pass
 * tracks bracket depth and double-quoted identifiers (with `""` escapes) and
 * records (a) the head — everything before the first top-level `(` or `[` —
 * and (b) whether any top-level `[` exists. DuckDB renders list and
 * fixed-size-array dimensions at the top level (`INTEGER[]`, `INTEGER[2]`,
 * `INTEGER[2][3]`, `DECIMAL(21,1)[3]`, `STRUCT(a INTEGER)[2]`); a scalar type
 * string can never contain a top-level bracket, so this rule is total and
 * cannot be slipped past: dimension-looking text inside parens (`MAP(INTEGER[2],
 * VARCHAR)`) stays out of the decision, hostile strings with stray or
 * unbalanced brackets/quotes (`INTEGER[2`, `INTEGER]`, `DECIMAL(21,1))[3]`,
 * unterminated quotes) degrade to `other`, and only a clean, balanced,
 * dimension-free head reaches the closed scalar sets below.
 */
export function classifyProfileColumnType(type: string): EngineProfileColumnKind {
  let depth = 0
  let inQuote = false
  let headEnd = type.length
  let hasArrayDimension = false
  for (let index = 0; index < type.length; index++) {
    const char = type[index]
    if (inQuote) {
      if (char === '"') {
        if (type[index + 1] === '"') {
          index += 1 // escaped "" inside the quoted identifier
        } else {
          inQuote = false
        }
      }
      continue
    }
    if (char === '"') {
      inQuote = true
      continue
    }
    if (char === '(' || char === '[') {
      if (depth === 0) {
        if (char === '[') hasArrayDimension = true
        headEnd = Math.min(headEnd, index)
      }
      depth += 1
      continue
    }
    if (char === ')' || char === ']') {
      depth -= 1
      if (depth < 0) return 'other' // stray closer: hostile/truncated, never scalar
      continue
    }
  }
  if (inQuote || depth !== 0) return 'other' // unterminated quote or unbalanced brackets
  if (hasArrayDimension) return 'other' // list / fixed-size array: never scalar
  // The head is the base type (plus trailing words like "WITH TIME ZONE")
  // with parameter lists stripped structurally — no substring shortcuts.
  const head = type.slice(0, headEnd).replace(/\s+/g, ' ').trim().toUpperCase()
  if (NUMERIC_TYPES.has(head)) return 'numeric'
  if (CATEGORICAL_TYPES.has(head)) return 'categorical'
  return 'other'
}
