/**
 * Target-schema binding and the engine type-string classifier (m5-1).
 *
 * ## The agreement surface with the engine (m5-2)
 *
 * The compiler binds against the **engine schema shape**: `schema()` returns
 * `Array<{ name: string; type: string }>` (see `@assay/engine`'s `DataEngine`)
 * where `type` is the engine's *own* type string — for engine-duckdb, the
 * verbatim `DESCRIBE` output (`VARCHAR`, `BIGINT`, `DECIMAL(10,2)`, `DATE`,
 * `VARCHAR[]`, …). This module declares that shape structurally
 * ({@link EngineSchemaColumn}) so `@assay/validation` stays engine-free while
 * m5-2 can hand the real thing straight in; the m5-2 conformance work pins
 * that real `DESCRIBE` spellings classify as documented here.
 *
 * ## Classification honesty
 *
 * Rules that constrain *values* (min/max, regex, allowed-values, …) are only
 * meaningful for families of types this compiler understands. The classifier
 * therefore maps engine type strings to a small, documented family set:
 *
 * - Recognized **canonical engine spellings only** — what DuckDB's `DESCRIBE`
 *   prints. Alias spellings (`TEXT`, `INT`, …) are not accepted: an engine
 *   never reports them, and accepting them would fork the canonical form
 *   (the same policy as the m5-0 contract vocabulary).
 * - Parameterized forms are classified only when their parameters can be
 *   validated honestly: `DECIMAL(p,s)` with `1 ≤ p ≤ 38, 0 ≤ s ≤ p`, and
 *   `VARCHAR(n)` with a non-negative safe-integer `n` (DuckDB accepts the
 *   modifier; m5-2 pins what `DESCRIBE` actually prints for it). Bare
 *   `DECIMAL` is classified numeric because it is an m5-0 vocabulary
 *   spelling (`DESCRIBE` itself would print `DECIMAL(18,3)`).
 * - Everything else — arrays (`INTEGER[]`), nested types (`STRUCT(…)`,
 *   `MAP(…)`, `UNION(…)`, `ENUM(…)`), and unknown spellings — classifies as
 *   `'other'` ({@link ColumnTypeFamily}): **reject, never approximate**. A rule
 *   that needs a family on an `other` column is a typed binding error; only
 *   the family-free rules (`required`, `max-null-share` — pure NULL
 *   arithmetic that is total over every type) still bind there.
 *
 * Classification is exact and case-sensitive (engine output is uppercase;
 * m5-2's agreement test pins this).
 */

/** One column of the target dataset, exactly as the engine's `schema()` reports it. */
export interface EngineSchemaColumn {
  /** Column name, verbatim from the engine. */
  readonly name: string
  /** The engine's own type string (for engine-duckdb: `DESCRIBE` output). */
  readonly type: string
}

/** The target schema shape: `DataEngine.schema()`'s return type, structurally. */
export type EngineSchema = readonly EngineSchemaColumn[]

/**
 * The family a rule binds against. Family-free rules (`required`,
 * `max-null-share`) ignore it; every other rule documents its family
 * requirement in `compile.ts`'s applicability matrix.
 */
export type ColumnTypeFamily =
  /** Ordered arithmetic: integers, floats, decimals (`DECIMAL(p,s)` incl.). */
  | 'numeric'
  /** Text: `VARCHAR` (+ the defensive `VARCHAR(n)` modifier form). */
  | 'textual'
  /** `BOOLEAN`. */
  | 'boolean'
  /** `DATE`, `TIME`, `TIMESTAMP`, `TIME/TIMESTAMP WITH TIME ZONE`. */
  | 'temporal'
  /** `UUID`. */
  | 'uuid'
  /** `JSON` — text-backed; equality is textual, so set rules refuse it. */
  | 'json'
  /** `BLOB` — byte equality. */
  | 'blob'
  /** Arrays, nested types, and unknown spellings — nothing value-level binds. */
  | 'other'

const FLAT_FAMILIES: Readonly<Record<string, ColumnTypeFamily>> = {
  // numeric — signed integers
  TINYINT: 'numeric',
  SMALLINT: 'numeric',
  INTEGER: 'numeric',
  BIGINT: 'numeric',
  HUGEINT: 'numeric',
  // numeric — unsigned integers
  UTINYINT: 'numeric',
  USMALLINT: 'numeric',
  UINTEGER: 'numeric',
  UBIGINT: 'numeric',
  UHUGEINT: 'numeric',
  // numeric — floats
  FLOAT: 'numeric',
  DOUBLE: 'numeric',
  // numeric — the bare m5-0 vocabulary spelling (DESCRIBE prints DECIMAL(p,s);
  // classifying the known spelling is harmless and documented, never a guess
  // about a *parameterized* form's meaning)
  DECIMAL: 'numeric',
  // textual
  VARCHAR: 'textual',
  // boolean
  BOOLEAN: 'boolean',
  // temporal
  DATE: 'temporal',
  TIME: 'temporal',
  'TIME WITH TIME ZONE': 'temporal',
  TIMESTAMP: 'temporal',
  'TIMESTAMP WITH TIME ZONE': 'temporal',
  // uuid / json / blob
  UUID: 'uuid',
  JSON: 'json',
  BLOB: 'blob',
}

/** `DECIMAL(p,s)` — DuckDB's canonical decimal spelling (no spaces). */
const DECIMAL_PARAMS = /^DECIMAL\((\d+),(\d+)\)$/

/** `VARCHAR(n)` — the modifier form DuckDB parses (parameter bound defensively). */
const VARCHAR_PARAMS = /^VARCHAR\((\d+)\)$/

/** DuckDB's documented DECIMAL precision range (1–38) and scale ≤ precision. */
const MAX_DECIMAL_PRECISION = 38

/**
 * Classify an engine type string into its rule-binding family. Total and
 * exact: any spelling this compiler cannot honestly classify — unknown
 * spellings, arrays, nested types, malformed parameters — comes back as
 * `'other'`, which every family-needing rule turns into a typed binding
 * error. Never approximates: there is no fuzzy matching, no lowercasing,
 * no alias acceptance.
 */
export function classifyColumnType(type: string): ColumnTypeFamily {
  const flat = FLAT_FAMILIES[type]
  if (flat !== undefined) return flat

  const decimal = DECIMAL_PARAMS.exec(type)
  if (decimal !== null) {
    const precision = Number(decimal[1])
    const scale = Number(decimal[2])
    // Malformed or out-of-range parameters are not classified (fail closed):
    // `DESCRIBE` never emits them, so accepting them would be a guess.
    if (precision < 1 || precision > MAX_DECIMAL_PRECISION) return 'other'
    if (scale > precision) return 'other'
    return 'numeric'
  }

  const varchar = VARCHAR_PARAMS.exec(type)
  if (varchar !== null) {
    const length = Number(varchar[1])
    if (!Number.isSafeInteger(length) || length < 0) return 'other'
    return 'textual'
  }

  return 'other'
}

/**
 * A human-facing explanation of *why* a type string is not classifiable,
 * for binding-error messages. Distinguishes the three honest rejection
 * classes (arrays, nested types, unknown spellings) without pretending any
 * of them could be bound.
 */
export function describeUnbindableType(type: string): string {
  if (type.endsWith('[]')) return `array type '${type}'`
  if (/^(STRUCT|MAP|UNION|ENUM)\(/.test(type)) return `nested type '${type}'`
  return `unknown engine type spelling '${type}'`
}
