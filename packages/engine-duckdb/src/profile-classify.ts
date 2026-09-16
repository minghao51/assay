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
 *   Lists are detected by the `[]` suffix BEFORE any paren-stripping: a
 *   parameterized-base list like `DECIMAL(21,1)[]` (DuckDB 1.5.5's exact
 *   DESCRIBE spelling) would otherwise reduce to `DECIMAL`, be misrouted
 *   into the numeric aggregate path, and its `avg()`/`quantile_cont()` binder
 *   error would escape `profile()` — lists are never scalar, so they degrade.
 *
 * The function is total and never throws (m1-6's type-string-parser
 * precedent): an unknown or hostile type string classifies as `other`, never
 * an error — profiling an exotic type must degrade, not fail.
 */
import type { EngineProfileColumnKind } from './protocol'

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
 */
export function classifyProfileColumnType(type: string): EngineProfileColumnKind {
  // List columns (parameterized base included: `DECIMAL(21,1)[]`, `VARCHAR[]`,
  // `INTEGER[]`) are never scalar: detect the `[]` suffix BEFORE stripping
  // parens. Stripping first would reduce `DECIMAL(21,1)[]` to `DECIMAL` and
  // misroute a LIST column into the numeric aggregate path, where `avg()` is
  // a binder error that would escape `profile()` (verified against DuckDB
  // 1.5.5: DESCRIBE renders exactly `DECIMAL(21,1)[]`). No scalar type string
  // can contain `[]`, so this check is total and cannot misclassify.
  if (type.includes('[]')) return 'other'
  // Strip parameter lists ("DECIMAL(21,1)" → "DECIMAL") before matching, so
  // parametrized scalars classify as their base type. Remaining nested types
  // reduce to a container name ("STRUCT") — not in the scalar sets, so they
  // fall through to `other`.
  const openParen = type.indexOf('(')
  const base = (openParen === -1 ? type : type.slice(0, openParen)).trim().toUpperCase()
  if (NUMERIC_TYPES.has(base)) return 'numeric'
  if (CATEGORICAL_TYPES.has(base)) return 'categorical'
  return 'other'
}
