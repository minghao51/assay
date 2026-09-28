// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * ux-4 — type-aware filter builder, pure and Node-testable (the repo's
 * testing convention: thin component over a tested pure module).
 *
 * This module is the **compile target bridge**: the UI collects a column
 * kind, an operator id, and a raw value; `compileFilterInput` turns those
 * into the v1 `FilterSpec.predicate` fragment grammar (`packages/grid`
 * `FilterSpec`, unchanged). The engine still composes each fragment as
 * `("<column>" <predicate>)` and AND-composes the list — no engine, grid
 * model, or `GridViewportModel` protocol change.
 *
 * Trust boundary (ADR 0007/0025): values are **untrusted content**. Nothing
 * here produces markup; every value becomes a SQL string literal (single
 * quotes doubled), or for `contains` a `LIKE` pattern with the LIKE
 * metacharacters `%`, `_`, and the escape character itself escaped. The
 * produced text is only ever handed to the user's own local query.
 *
 * Type classification reuses the total `parseDuckDbType` parser (`schema/
 * parseType.ts`) — this module is a thin adapter over its primitive label,
 * never a second type-string parser.
 */
import { parseDuckDbType } from '../schema/parseType'
import type { DuckDbType } from '../schema/parseType'

/** The column families the builder distinguishes. */
export type FilterColumnKind = 'numeric' | 'string' | 'temporal' | 'boolean' | 'other'

/** A column's filter profile: its kind plus the temporal literal keyword. */
export interface FilterColumnProfile {
  readonly kind: FilterColumnKind
  /** The SQL literal keyword for temporal `= value` compilation. */
  readonly temporalKeyword: 'DATE' | 'TIME' | 'TIMESTAMP' | null
}

/** The operator ids the catalogs use. */
export type FilterOperatorId =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'is-true'
  | 'is-false'
  | 'is-null'
  | 'is-not-null'

/** One operator option: its id, visible label, and whether it takes a value. */
export interface FilterOperator {
  readonly id: FilterOperatorId
  readonly label: string
  readonly needsValue: boolean
}

/** Result of compiling one operator+value pair into a predicate fragment. */
export type FilterInputResult =
  | { readonly ok: true; readonly predicate: string }
  | { readonly ok: false; readonly message: string }

// --- Type classification -------------------------------------------------

/** Numeric primitives (safe and wide alike — the engine owns the type space). */
const NUMERIC_BASES = new Set([
  'TINYINT',
  'INT1',
  'SMALLINT',
  'INT2',
  'SHORT',
  'INTEGER',
  'INT',
  'INT4',
  'SIGNED',
  'BIGINT',
  'INT8',
  'LONG',
  'HUGEINT',
  'UHUGEINT',
  'UTINYINT',
  'UINT1',
  'USMALLINT',
  'UINT2',
  'UINTEGER',
  'UINT4',
  'UBIGINT',
  'UINT8',
  'FLOAT',
  'FLOAT4',
  'REAL',
  'DOUBLE',
  'FLOAT8',
  'DECIMAL',
  'NUMERIC',
])

/** Boolean primitives. */
const BOOLEAN_BASES = new Set(['BOOLEAN', 'BOOL', 'LOGICAL'])

/** Textual primitives whose values compare naturally as strings. */
const STRING_BASES = new Set([
  'VARCHAR',
  'CHAR',
  'BPCHAR',
  'TEXT',
  'STRING',
  'NVARCHAR',
  'UUID',
  'ENUM',
])

/**
 * The leading keyword of a parsed primitive label: `DECIMAL(21,1)` →
 * `DECIMAL`, `TIMESTAMP WITH TIME ZONE` → `TIMESTAMP`. `parseDuckDbType`
 * only produces `primitive` labels for these, so the split is total.
 */
function primitiveBase(type: DuckDbType): string {
  if (type.kind !== 'primitive') return ''
  return type.label.trim().toUpperCase().split(/[\s(]/)[0] ?? ''
}

/**
 * Classify a raw DuckDB type string (the schema's `column.type`) into a
 * builder family. Total: composite/unknown/unrecognized primitives become
 * `other` (the honest fallback — null-checks still apply).
 */
export function classifyColumnType(rawType: string): FilterColumnProfile {
  const parsed = parseDuckDbType(rawType)
  if (parsed.kind !== 'primitive') return { kind: 'other', temporalKeyword: null }
  const base = primitiveBase(parsed)
  if (NUMERIC_BASES.has(base)) return { kind: 'numeric', temporalKeyword: null }
  if (BOOLEAN_BASES.has(base)) return { kind: 'boolean', temporalKeyword: null }
  if (base === 'DATE') return { kind: 'temporal', temporalKeyword: 'DATE' }
  if (base === 'TIME') return { kind: 'temporal', temporalKeyword: 'TIME' }
  if (base.startsWith('TIMESTAMP')) return { kind: 'temporal', temporalKeyword: 'TIMESTAMP' }
  if (STRING_BASES.has(base)) return { kind: 'string', temporalKeyword: null }
  return { kind: 'other', temporalKeyword: null }
}

// --- Operator catalogs ---------------------------------------------------

const NULL_OPERATORS: readonly FilterOperator[] = [
  { id: 'is-null', label: 'is null', needsValue: false },
  { id: 'is-not-null', label: 'is not null', needsValue: false },
]

const NUMERIC_OPERATORS: readonly FilterOperator[] = [
  { id: 'eq', label: '=', needsValue: true },
  { id: 'neq', label: '≠', needsValue: true },
  { id: 'gt', label: '>', needsValue: true },
  { id: 'gte', label: '≥', needsValue: true },
  { id: 'lt', label: '<', needsValue: true },
  { id: 'lte', label: '≤', needsValue: true },
  ...NULL_OPERATORS,
]

const STRING_OPERATORS: readonly FilterOperator[] = [
  { id: 'eq', label: '=', needsValue: true },
  { id: 'neq', label: '≠', needsValue: true },
  { id: 'contains', label: 'contains', needsValue: true },
  ...NULL_OPERATORS,
]

const TEMPORAL_OPERATORS: readonly FilterOperator[] = [
  { id: 'eq', label: '=', needsValue: true },
  { id: 'neq', label: '≠', needsValue: true },
  { id: 'gt', label: '>', needsValue: true },
  { id: 'gte', label: '≥', needsValue: true },
  { id: 'lt', label: '<', needsValue: true },
  { id: 'lte', label: '≤', needsValue: true },
  ...NULL_OPERATORS,
]

const BOOLEAN_OPERATORS: readonly FilterOperator[] = [
  { id: 'is-true', label: '= true', needsValue: false },
  { id: 'is-false', label: '= false', needsValue: false },
  ...NULL_OPERATORS,
]

/** The operator catalog for one column kind (immutable, shared). */
export function filterOperators(kind: FilterColumnKind): readonly FilterOperator[] {
  switch (kind) {
    case 'numeric':
      return NUMERIC_OPERATORS
    case 'string':
      return STRING_OPERATORS
    case 'temporal':
      return TEMPORAL_OPERATORS
    case 'boolean':
      return BOOLEAN_OPERATORS
    case 'other':
      return NULL_OPERATORS
  }
}

/** The operator a column's builder starts on (the first catalog entry). */
export function defaultOperatorForKind(kind: FilterColumnKind): FilterOperatorId {
  return filterOperators(kind)[0]?.id ?? 'is-null'
}

/** Look up an operator within a kind's catalog (`undefined` = invalid combo). */
export function findOperator(
  kind: FilterColumnKind,
  operatorId: FilterOperatorId,
): FilterOperator | undefined {
  return filterOperators(kind).find((operator) => operator.id === operatorId)
}

// --- Compilation ---------------------------------------------------------

/** `^[+-]?(digits[.digits]?|.digits)(e[+-]?digits)?$`, no hex/Infinity/NaN. */
const NUMERIC_INPUT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

const DATE_INPUT = /^(\d{4})-(\d{2})-(\d{2})$/
const TIME_INPUT = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?$/
const TIMESTAMP_INPUT =
  /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/

/** Single-quote a value as a SQL string literal (`'` doubled). */
export function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/**
 * Escape the LIKE metacharacters in a user value so it matches literally.
 * The chosen escape character is a backslash (DuckDB's conventional LIKE
 * escape, made explicit with `ESCAPE '\'` in the compiled fragment). A
 * literal backslash, `%`, and `_` each gain one backslash of escape — the
 * backslash itself is escaped first so it cannot double-escape the others.
 */
export function escapeLikePattern(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

function isRealDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
}

function isValidTemporalValue(keyword: 'DATE' | 'TIME' | 'TIMESTAMP', value: string): boolean {
  if (keyword === 'DATE') {
    const match = DATE_INPUT.exec(value)
    if (match === null) return false
    return isRealDate(Number(match[1]), Number(match[2]), Number(match[3]))
  }
  if (keyword === 'TIME') {
    const match = TIME_INPUT.exec(value)
    if (match === null) return false
    return (
      Number(match[1]) <= 23 &&
      Number(match[2]) <= 59 &&
      (match[3] === undefined || Number(match[3]) <= 59)
    )
  }
  if (!TIMESTAMP_INPUT.test(value)) return false
  return !Number.isNaN(Date.parse(value.replace(' ', 'T')))
}

const COMPARISON: Readonly<Record<string, string>> = {
  eq: '=',
  neq: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
}

/**
 * Compile one builder operator+value into a `FilterSpec.predicate` fragment.
 * Total: every input yields a predicate or a readable, value-free rejection
 * (the component shows the message inline and never calls the engine).
 */
export function compileFilterInput(
  profile: FilterColumnProfile,
  operatorId: FilterOperatorId,
  rawValue: string,
): FilterInputResult {
  const operator = findOperator(profile.kind, operatorId)
  if (operator === undefined) {
    return { ok: false, message: 'Choose an operator for this column.' }
  }

  switch (operator.id) {
    case 'is-null':
      return { ok: true, predicate: 'IS NULL' }
    case 'is-not-null':
      return { ok: true, predicate: 'IS NOT NULL' }
    case 'is-true':
      return { ok: true, predicate: '= TRUE' }
    case 'is-false':
      return { ok: true, predicate: '= FALSE' }
    default:
      break
  }

  const value = rawValue.trim()
  if (value === '') return { ok: false, message: 'Enter a value for this operator.' }

  if (profile.kind === 'numeric') {
    if (!NUMERIC_INPUT.test(value)) return { ok: false, message: 'That is not a number.' }
    return { ok: true, predicate: `${COMPARISON[operator.id] ?? '='} ${value}` }
  }

  if (profile.kind === 'string') {
    if (operator.id === 'contains') {
      const pattern = `%${escapeLikePattern(value)}%`
      return { ok: true, predicate: `LIKE ${sqlStringLiteral(pattern)} ESCAPE '\\'` }
    }
    return { ok: true, predicate: `${COMPARISON[operator.id] ?? '='} ${sqlStringLiteral(value)}` }
  }

  if (profile.kind === 'temporal') {
    const keyword = profile.temporalKeyword ?? 'DATE'
    if (!isValidTemporalValue(keyword, value)) {
      return {
        ok: false,
        message:
          keyword === 'DATE'
            ? 'Enter a date as YYYY-MM-DD.'
            : keyword === 'TIME'
              ? 'Enter a time as HH:MM[:SS].'
              : 'Enter a timestamp as YYYY-MM-DD[ HH:MM[:SS]].',
      }
    }
    return {
      ok: true,
      predicate: `${COMPARISON[operator.id] ?? '='} ${keyword} ${sqlStringLiteral(value)}`,
    }
  }

  // `other` kinds expose only the null operators, handled above.
  return { ok: false, message: 'Choose an operator for this column.' }
}
