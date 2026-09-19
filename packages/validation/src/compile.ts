/**
 * The rule→plan compiler (m5-1; ADR 0013/0026).
 *
 * `compileContract` turns a **validated** m5-0 contract (`ContractV1` —
 * what `parseContract` returns) plus the target schema (the engine's
 * `schema()` shape) into a deterministic, serializable
 * {@link ValidationPlan}: one SQL query per rule plus one summary query.
 *
 * ## Guarantees (the done-when, implemented here)
 *
 * - **Total** — never throws, over any input (even a caller bug behind a
 *   cast degrades to typed errors, mirroring the never-throws convention).
 *   A validated contract + schema always yield `{ ok: true, plan }` or
 *   `{ ok: false, errors }`; all independent binding errors are collected,
 *   m5-0-style, and every rule either compiles or is rejected — no silent
 *   skips. (`required`/`unique` normalize to true-or-absent exactly as the
 *   m5-0 parser normalizes them, so a `false` behind a broken cast is an
 *   absent rule, not a skipped one — but any *other* value behind a broken
 *   cast is a typed `invalid-contract-input` error, as are unknown rule
 *   keys and an unrecognizable `dataset` shape: the defensive validation
 *   is as complete as the no-silent-skips claim.)
 * - **Binding errors before execution** — missing columns, rules
 *   inapplicable to the column's type family, unclassifiable type
 *   spellings, and non-RE2 regex patterns are all rejected here, typed and
 *   attributed (see `errors.ts`, `schema.ts`, `re2.ts`).
 * - **Deterministic** — identical (contract, schema, options) produce
 *   byte-identical SQL: no clocks, no randomness, no map-iteration-order
 *   dependence; rule order is the contract's canonical order (m5-0's
 *   column order, then each column's keys in the m5-0 canonical key
 *   order), and the schema array's order never reaches SQL. Golden pins
 *   freeze the bytes.
 * - **Injection-safe** — every value reaching SQL goes through
 *   `literals.ts` helpers; contract/schema text never enters a SQL string
 *   or identifier position unquoted (see that module for the composition
 *   contract).
 * - **Collision-free for every legal column name** — DuckDB identifiers
 *   are case-insensitive even when quoted, and a quoted identifier may
 *   contain anything, so no alias name is unreachable by a dataset
 *   column. The SQL is therefore *structured* so names can never meet at
 *   one scope: every source-column reference is range-qualified
 *   (`"src"."col"` — a qualified reference resolves only against the FROM
 *   range, never against a select-list alias or a same-named column
 *   elsewhere), the relation is always aliased to the reserved range
 *   `"src"`, and every derived table exposes **only** reserved `assay_*`
 *   aliases (a source column never crosses a scope boundary under its
 *   own name). No dataset column is unbindable — including
 *   `assay_row_ordinal` in any casing — and this is regression-pinned
 *   against real DuckDB (the m5-1 review's probes: `unique` over a column
 *   named `assay_occurrences` counts every violation; `required` over
 *   `ASSAY_ROW_ORDINAL` sees the NULL) in `duckdb-agreement.test.ts`.
 *
 * ## Binding semantics (documented decisions m5-2 pins)
 *
 * - NULL never violates a value rule: `required`/`max-null-share` govern
 *   nullness; `min`/`max`/`allowed-values`/`regex` predicates are
 *   NULL-passing (`NULL < 5` is NULL → not selected).
 * - `regex` means **full match** (`regexp_full_match`) — the strict,
 *   contract-honest reading of "the value must match the pattern".
 * - `allowed-values` binds entry-kind-strictly: every entry's scalar kind
 *   must match the column's family (numeric ↔ finite numbers, textual ↔
 *   strings, boolean ↔ booleans). A cross-kind list is a binding error —
 *   DuckDB would either fail the cast at execution or silently coerce the
 *   literal list to a common type, and binding refuses to guess (the RE2
 *   honesty asymmetry: a refused rule is a visible, actionable error; an
 *   accepted-but-miscompiled one is a runtime surprise).
 * - `declared-type` compares spellings **exactly**. The m5-0 vocabulary's
 *   bare `DECIMAL` therefore never matches a DESCRIBE-parameterized
 *   spelling (`DECIMAL(10,2)` — the documented m5-0 caveat): that is an
 *   honest mismatch *violation* reported with both spellings, never a
 *   fuzzy match.
 * - A `declared-type` rule whose expectation differs from the schema is a
 *   *reportable violation*, not a binding error (a contract must be
 *   runnable against a dirty dataset — that is the product). It compiles
 *   to a dataset-fact rule with `failCount ∈ {0,1}` and carries
 *   `expectedType`/`actualType` for the report; a matching expectation
 *   compiles to the same shape with a never-true violation guard.
 * - `min-distinct-share` = distinct non-NULL values ÷ non-NULL values; a
 *   column with zero non-NULL values passes vacuously (nothing to
 *   collapse — consistent with `unique` passing on an all-NULL column).
 * - `max-null-share` on an empty dataset passes (`COALESCE(avg, 0.0)`);
 *   the row-count bounds are the honest emptiness check.
 * - Numeric rule literals are exact-shortest DOUBLE spellings of the m5-0
 *   verified values; comparisons against DECIMAL columns are the engine's
 *   deterministic double-vs-decimal semantics (m5-2 pins the version).
 *
 * Purity: no React, no browser APIs, no engine imports — `@assay/contracts`
 * types only (lint-enforced).
 */

import type { ContractV1 } from '@assay/contracts'
import type { BindingError, BindingErrorCode } from './errors'
import {
  quoteIdentifier,
  sqlBooleanLiteral,
  sqlIntegerLiteral,
  sqlNumberLiteral,
  sqlStringLiteral,
} from './literals'
import type { PlannedRule, ValidationPlan, ValidationRuleKind } from './plan'
import { PLAN_KIND, PLAN_VERSION } from './plan'
import { checkRe2Pattern } from './re2'
import type { ColumnTypeFamily, EngineSchema, EngineSchemaColumn } from './schema'
import { classifyColumnType, describeUnbindableType } from './schema'

/** Where the compiled plan reads rows from: a table or view name. */
export interface CompileOptions {
  /**
   * The target relation (engine-generated table/view name, e.g. the m1-4
   * registry id or the m5-2 composed effective view). Quoted into every
   * query; part of the determinism tuple.
   */
  readonly relation: string
  /**
   * K of the sample-failure bound: per-rule queries return at most this
   * many sample rows. Must be a safe integer ≥ 1 (`LIMIT 0` would make a
   * violated rule indistinguishable from a clean one under the
   * empty-result convention). Default 20. m5-2 may clamp further
   * engine-side.
   */
  readonly sampleLimit?: number
}

/** Default K (see {@link CompileOptions.sampleLimit}). */
export const DEFAULT_SAMPLE_LIMIT = 20

/** A compile outcome: plan or collected typed errors — never a throw. */
export type CompileResult =
  | { readonly ok: true; readonly plan: ValidationPlan }
  | { readonly ok: false; readonly errors: readonly BindingError[] }

/** The canonical rule-key order within a column (m5-0's key order). */
const COLUMN_RULE_KEYS = [
  'type',
  'required',
  'unique',
  'min',
  'max',
  'allowed-values',
  'regex',
  'max-null-share',
  'min-distinct-share',
] as const

type ColumnRuleKey = (typeof COLUMN_RULE_KEYS)[number]

/** Which AST field a rule key reads (only where the spelling differs). */
function ruleValue(column: Record<string, unknown>, key: ColumnRuleKey): unknown {
  switch (key) {
    case 'type':
    case 'required':
    case 'unique':
    case 'min':
    case 'max':
    case 'regex':
      return column[key]
    case 'allowed-values':
      return column['allowedValues']
    case 'max-null-share':
      return column['maxNullShare']
    case 'min-distinct-share':
      return column['minDistinctShare']
  }
}

/** Rule key → plan rule kind. */
function ruleKind(key: ColumnRuleKey | 'min-rows' | 'max-rows'): ValidationRuleKind {
  switch (key) {
    case 'type':
      return 'declared-type'
    case 'min-rows':
      return 'min-rows'
    case 'max-rows':
      return 'max-rows'
    default:
      return key
  }
}

/** Quote a name for an identifier position (column, alias, relation). */
function q(name: string): string {
  return quoteIdentifier(name)
}

/**
 * The reserved range name of the target relation inside every plan query
 * (`FROM "rel" AS "src"`). Source columns are referenced *only* through
 * this range (`"src"."col"`): a qualified reference resolves exclusively
 * against the FROM range — never against a select-list alias or a same-named
 * column elsewhere — so a dataset column can never be confused with a plan
 * alias, whatever it is named (DuckDB identifiers are case-insensitive even
 * when quoted, which is exactly why references are qualified instead of
 * aliases being "reserved": a case-folding reserved-name check could never
 * be exhaustive, and it would wrongly make legal columns unbindable).
 */
const SOURCE_RANGE = 'src'

/**
 * A column reference inside plan SQL. `source` is the constrained dataset
 * column at a scope that reads the relation (always rendered
 * range-qualified, see {@link SOURCE_RANGE}); `derived` is one of the
 * plan's own `assay_*` aliases exposed by a derived table (always bare —
 * derived tables expose only reserved names, so a bare `assay_*` alias and
 * a source column name never meet at one scope).
 */
type ColRef =
  | { readonly scope: 'source'; readonly column: string }
  | { readonly scope: 'derived'; readonly alias: string }

/** Render a reference for SQL (source → range-qualified; derived → bare). */
function colSql(ref: ColRef): string {
  return ref.scope === 'source' ? `${q(SOURCE_RANGE)}.${q(ref.column)}` : q(ref.alias)
}

/** The constrained column as the per-rule query's outer scope sees it. */
const DERIVED_VALUE: ColRef = { scope: 'derived', alias: 'assay_value' }

/** The unique rule's occurrence count as an outer scope sees it. */
const DERIVED_OCCURRENCES: ColRef = { scope: 'derived', alias: 'assay_occurrences' }

/** Empty-plan summary: valid SQL, zero rows, pinned shape (see plan.ts). */
const EMPTY_SUMMARY_SQL =
  'SELECT CAST(NULL AS VARCHAR) AS "rule_id", ' +
  'CAST(NULL AS BIGINT) AS "total_rows", ' +
  'CAST(NULL AS BIGINT) AS "fail_count" WHERE FALSE'

/** Mutable compile context (internal). */
interface Ctx {
  readonly errors: BindingError[]
  readonly rules: PlannedRule[]
  readonly summaryArms: string[]
  /** Quoted relation reference; set after option validation. */
  rel: string
  sampleLimit: number
}

function pushError(
  ctx: Ctx,
  code: BindingErrorCode,
  path: string,
  message: string,
  extra?: { readonly ruleId?: string; readonly column?: string },
): void {
  ctx.errors.push({ code, message, path, ruleId: extra?.ruleId, column: extra?.column })
}

/**
 * Render an invalid option value for an error message — **total over every
 * value**: objects are never stringified (`String(Object.create(null))` is
 * a TypeError — "Cannot convert object to primitive value" — so the error
 * path must not route through it). The error renderer being total is part
 * of the compiler's totality guarantee.
 */
function describeOptionValue(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return `'${value}'`
    case 'number':
    case 'bigint':
    case 'boolean':
      return String(value)
    case 'undefined':
      return 'undefined'
    case 'object':
      return value === null ? 'null' : 'an object (no safe string form)'
    default:
      return `a ${typeof value} value` // function or symbol
  }
}

// ---------------------------------------------------------------------------
// SQL fragment builders — pure, deterministic, shared between the per-rule
// queries and the summary arms so the two cannot diverge (plan.ts doc).
// ---------------------------------------------------------------------------

/** One allowed-values / literal scalar → SQL literal (via the helpers). */
function renderScalarLiteral(value: string | number | boolean): string {
  if (typeof value === 'string') return sqlStringLiteral(value)
  if (typeof value === 'boolean') return sqlBooleanLiteral(value)
  return sqlNumberLiteral(value)
}

/**
 * The violation predicate of a row-level rule (NULL-passing by design).
 * One builder renders the predicate at *both* scopes that need it — the
 * per-rule query's outer scope (over the derived aliases) and the summary
 * arm's scope (over the range-qualified source column) — so the two
 * cannot diverge; only the reference rendering differs.
 */
function violationPredicate(key: ColumnRuleKey, ref: ColRef, value: unknown): string {
  const col = colSql(ref)
  switch (key) {
    case 'required':
      return `${col} IS NULL`
    case 'min':
      return `${col} < ${sqlNumberLiteral(value as number)}`
    case 'max':
      return `${col} > ${sqlNumberLiteral(value as number)}`
    case 'allowed-values': {
      const values = value as readonly (string | number | boolean)[]
      if (values.length === 0) return `(${col} IS NOT NULL)`
      const literals = values.map(renderScalarLiteral)
      return `(${col} IS NOT NULL AND ${col} NOT IN (${literals.join(', ')}))`
    }
    case 'regex':
      return `(${col} IS NOT NULL AND NOT regexp_full_match(${col}, ${sqlStringLiteral(value as string)}))`
    default:
      throw new Error(`internal: ${String(key)} has no row-level predicate`)
  }
}

/**
 * The unique rule's violation predicate over the derived aliases: any row
 * whose non-NULL value recurs. The summary arm renders the identical text
 * over an identically-shaped derived table (see {@link uniqueSummaryFrom}),
 * so plan-vs-summary counts cannot diverge.
 */
function uniqueViolationPredicate(): string {
  return `${colSql(DERIVED_VALUE)} IS NOT NULL AND ${colSql(DERIVED_OCCURRENCES)} > 1`
}

/** Inner projection: the source column, renamed to the reserved alias. */
function sourceValueProjection(column: string): string {
  return `${colSql({ scope: 'source', column })} AS ${q('assay_value')}`
}

/** Inner projection for `unique`: the value plus its occurrence count. */
function sourceUniqueProjection(column: string): string {
  return (
    `${sourceValueProjection(column)}, ` +
    `count(*) OVER (PARTITION BY ${colSql({ scope: 'source', column })}) AS ${q('assay_occurrences')}`
  )
}

/**
 * The per-rule query for a row-level rule: bounded samples + row identity.
 * `innerProjection` renames the source column to the reserved `assay_value`
 * alias (plus the occurrence count for `unique`) at the innermost scope, so
 * the derived table exposes *only* reserved aliases; `predicate` is
 * evaluated over that derived table (bare reserved names — a source column
 * cannot collide here, it never left the inner scope).
 */
function rowSamplesSql(ctx: Ctx, predicate: string, innerProjection: string): string {
  return [
    'SELECT',
    `  (SELECT count(*) FROM ${ctx.rel}) AS ${q('total_rows')},`,
    `  count(*) OVER () AS ${q('fail_count')},`,
    `  row_number() OVER () - 1 AS ${q('sample_index')},`,
    `  ${q('assay_row_ordinal')},`,
    `  ${q('assay_value')}`,
    'FROM (',
    `  SELECT row_number() OVER () - 1 AS ${q('assay_row_ordinal')}, ${innerProjection}`,
    `  FROM ${ctx.rel} AS ${q(SOURCE_RANGE)}`,
    `) AS ${q('assay_rule_source')}`,
    `WHERE ${predicate}`,
    `LIMIT ${sqlIntegerLiteral(ctx.sampleLimit)}`,
  ].join('\n')
}

/**
 * The summary arm for a row-level rule: same predicate text (over the
 * range-qualified source column), count-only. `from` is `rel` for
 * predicate-only rules or the occurrence subquery for `unique` — always
 * row-aligned with the per-rule query's derived table.
 */
function rowSummaryArm(ctx: Ctx, ruleId: string, predicate: string, from: string): string {
  return [
    `SELECT ${sqlStringLiteral(ruleId)} AS ${q('rule_id')}, (SELECT count(*) FROM ${ctx.rel}) AS ${q('total_rows')}, count(*) AS ${q('fail_count')}`,
    `FROM ${from}`,
    `WHERE ${predicate}`,
  ].join('\n')
}

/** The summary arm's FROM for predicate-only rules (relation + range). */
function sourceFrom(ctx: Ctx): string {
  return `${ctx.rel} AS ${q(SOURCE_RANGE)}`
}

/** The summary arm's FROM for `unique` — the occurrence subquery, shaped
 * exactly like the per-rule query's derived table (reserved aliases only). */
function uniqueSummaryFrom(ctx: Ctx, column: string): string {
  return [
    '(',
    `  SELECT ${sourceUniqueProjection(column)}`,
    `  FROM ${ctx.rel} AS ${q(SOURCE_RANGE)}`,
    `) AS ${q('assay_rule_summary')}`,
  ].join('\n')
}

/**
 * The per-rule query for a dataset-fact rule: one row when violated, zero
 * rows when the fact holds (empty ⇒ failCount 0, the uniform convention).
 * The stats projection reads source columns range-qualified and exposes
 * only reserved `assay_*` aliases.
 */
function datasetFactSql(ctx: Ctx, statsProjection: string, violated: string): string {
  return [
    `SELECT ${q('assay_n')} AS ${q('total_rows')}, 1 AS ${q('fail_count')}`,
    'FROM (',
    `  SELECT ${statsProjection}`,
    `  FROM ${ctx.rel} AS ${q(SOURCE_RANGE)}`,
    `) AS ${q('assay_rule_stats')}`,
    `WHERE ${violated}`,
  ].join('\n')
}

/** The summary arm for a dataset-fact rule (same violated expression, CASE form). */
function datasetFactSummaryArm(
  ctx: Ctx,
  ruleId: string,
  statsProjection: string,
  violated: string,
): string {
  return [
    `SELECT ${sqlStringLiteral(ruleId)} AS ${q('rule_id')}, ${q('assay_n')} AS ${q('total_rows')}, CASE WHEN ${violated} THEN 1 ELSE 0 END AS ${q('fail_count')}`,
    'FROM (',
    `  SELECT ${statsProjection}`,
    `  FROM ${ctx.rel} AS ${q(SOURCE_RANGE)}`,
    `) AS ${q('assay_rule_stats')}`,
  ].join('\n')
}

/** Stats projection for the plain row-count fact (row bounds, declared type). */
function rowCountStats(): string {
  return `count(*) AS ${q('assay_n')}`
}

// ---------------------------------------------------------------------------
// Per-rule compilation
// ---------------------------------------------------------------------------

interface BoundColumn {
  readonly entry: EngineSchemaColumn
  readonly family: ColumnTypeFamily
}

/**
 * Resolve and validate one rule's column binding: existence (exact,
 * case-sensitive — with an actionable hint on near-misses) and — for
 * family-needing rules — classification. There is deliberately no
 * reserved-name rejection: plan SQL is collision-free for *every* legal
 * column name (see the module doc's collision-freedom invariant), so a
 * dataset column named like a plan alias — in any casing — binds and
 * executes correctly (pinned against real DuckDB).
 */
function bindColumn(
  ctx: Ctx,
  schema: ReadonlyMap<string, EngineSchemaColumn>,
  path: string,
  ruleId: string,
  columnName: string,
  needsFamily: boolean,
): BoundColumn | null {
  const entry = schema.get(columnName)
  if (entry === undefined) {
    const hint = caseInsensitiveHint(schema, columnName)
    pushError(
      ctx,
      'missing-column',
      path,
      hint === null
        ? `rule addresses column '${columnName}', which does not exist in the target schema (binding is exact and case-sensitive; the schema has ${schema.size} columns)`
        : `rule addresses column '${columnName}', which does not exist in the target schema — did you mean '${hint}'? (binding is exact and case-sensitive)`,
      { ruleId, column: columnName },
    )
    return null
  }
  const family = classifyColumnType(entry.type)
  if (needsFamily && family === 'other') {
    pushError(
      ctx,
      'unknown-column-type',
      path,
      `cannot bind: column '${columnName}' has ${describeUnbindableType(entry.type)} — only flat scalar engine types are bindable in v1`,
      { ruleId, column: columnName },
    )
    return null
  }
  return { entry, family }
}

/** The single case-insensitive name candidate, if exactly one exists. */
function caseInsensitiveHint(
  schema: ReadonlyMap<string, EngineSchemaColumn>,
  columnName: string,
): string | null {
  const lower = columnName.toLowerCase()
  const matches = [...schema.values()].filter((entry) => entry.name.toLowerCase() === lower)
  return matches.length === 1 ? (matches[0] as EngineSchemaColumn).name : null
}

/**
 * Family requirements per rule key: whether the rule needs the column's
 * type classified at all, and which families it binds to (the applicability
 * matrix — see schema.ts for the family definitions).
 */
function familyRequirement(key: ColumnRuleKey): {
  needsFamily: boolean
  families?: readonly ColumnTypeFamily[]
} {
  switch (key) {
    case 'min':
    case 'max':
      return { needsFamily: true, families: ['numeric'] }
    case 'regex':
      return { needsFamily: true, families: ['textual'] }
    case 'allowed-values':
      return { needsFamily: true, families: ['numeric', 'textual', 'boolean'] }
    case 'unique':
    case 'min-distinct-share':
      return {
        needsFamily: true,
        families: ['numeric', 'textual', 'boolean', 'temporal', 'uuid', 'blob'],
      }
    default:
      // declared-type / required / max-null-share bind on any type
      return { needsFamily: false }
  }
}

/** The scalar kind an allowed-values family binds (the module-doc matrix). */
function familyKindFor(family: ColumnTypeFamily): 'number' | 'string' | 'boolean' {
  return family === 'numeric' ? 'number' : family === 'textual' ? 'string' : 'boolean'
}

/**
 * allowed-values binds entry-kind-strictly (module doc). Returns `null`
 * when the list is kind-consistent with the column's family — empty lists
 * always are — otherwise the first offending entry with its kind, for the
 * actionable message. Callers have already validated every entry is a
 * scalar, so exactly three kinds exist.
 */
function allowedValuesKindMismatch(
  values: readonly unknown[],
  family: ColumnTypeFamily,
): { readonly index: number; readonly entryKind: string } | null {
  const familyKind = familyKindFor(family)
  for (let index = 0; index < values.length; index++) {
    const entry = values[index]
    const entryKind =
      typeof entry === 'number' ? 'number' : typeof entry === 'string' ? 'string' : 'boolean'
    if (entryKind !== familyKind) return { index, entryKind }
  }
  return null
}

/** The rule-not-applicable message for a family mismatch (per rule kind). */
function notApplicableMessage(
  key: ColumnRuleKey,
  entry: EngineSchemaColumn,
  family: ColumnTypeFamily,
): string {
  const typed = `column '${entry.name}' has engine type '${entry.type}' (family '${family}')`
  switch (key) {
    case 'min':
    case 'max':
      return `min/max bounds require a numeric column, but ${typed}`
    case 'regex':
      return `regex requires a textual (VARCHAR) column, but ${typed}`
    case 'allowed-values':
      return `allowed-values applies only to numeric, textual or boolean columns, but ${typed}`
    case 'unique':
    case 'min-distinct-share':
      if (family === 'json') {
        return `${key} cannot bind to ${typed} — JSON equality is textual, which would make distinctness approximate; v1 refuses instead`
      }
      return `${key} cannot bind to ${typed}`
    default:
      return `rule does not apply to ${typed}`
  }
}

/**
 * Defensive per-rule value checks for shapes `parseContract` output can
 * never have (caller bugs behind casts). Returns true when the value is
 * usable; otherwise pushes `invalid-contract-input` and the rule is
 * rejected — never a throw, never a silent skip.
 */
function ruleValueIsBindable(
  ctx: Ctx,
  key: ColumnRuleKey,
  path: string,
  ruleId: string,
  column: string,
  value: unknown,
): boolean {
  switch (key) {
    case 'required':
    case 'unique':
      // True-or-absent is the m5-0 normalization: `false` is an absent rule
      // (handled by the caller's skip), but any other non-true value behind
      // a broken cast is a caller bug — reject it, never compile it as a
      // rule and never skip it silently.
      if (value !== true) {
        pushError(
          ctx,
          'invalid-contract-input',
          path,
          `${key} must be exactly true when present (the m5-0 parser normalizes the spelling to true-or-absent)`,
          { ruleId, column },
        )
        return false
      }
      return true
    case 'type':
    case 'regex':
      if (typeof value !== 'string') {
        pushError(ctx, 'invalid-contract-input', path, 'rule value must be a string', {
          ruleId,
          column,
        })
        return false
      }
      return true
    case 'min':
    case 'max':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        pushError(ctx, 'invalid-contract-input', path, 'rule value must be a finite number', {
          ruleId,
          column,
        })
        return false
      }
      return true
    case 'max-null-share':
    case 'min-distinct-share':
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        pushError(
          ctx,
          'invalid-contract-input',
          path,
          'share rule value must be a finite number in [0, 1]',
          {
            ruleId,
            column,
          },
        )
        return false
      }
      return true
    case 'allowed-values': {
      if (!Array.isArray(value)) {
        pushError(
          ctx,
          'invalid-contract-input',
          path,
          'allowed-values must be an array of scalars',
          { ruleId, column },
        )
        return false
      }
      for (let i = 0; i < value.length; i++) {
        const entry = value[i]
        const isScalar =
          typeof entry === 'string' ||
          typeof entry === 'boolean' ||
          (typeof entry === 'number' && Number.isFinite(entry))
        if (!isScalar) {
          pushError(
            ctx,
            'invalid-contract-input',
            path,
            `allowed-values entry ${i} is not a scalar (string, finite number, or boolean)`,
            {
              ruleId,
              column,
            },
          )
          return false
        }
        if (typeof entry === 'string' && (entry as string).includes('\u0000')) {
          pushError(
            ctx,
            'invalid-contract-input',
            path,
            `allowed-values entry ${i} contains a NUL character, which cannot be bound to SQL text`,
            { ruleId, column },
          )
          return false
        }
      }
      return true
    }
  }
}

/** Compile one column's rule set; pushes planned rules and/or errors. */
function compileColumnRule(
  ctx: Ctx,
  schema: ReadonlyMap<string, EngineSchemaColumn>,
  index: number,
  column: Record<string, unknown>,
): void {
  const pathBase = `columns[${index}]`
  const columnName = typeof column['name'] === 'string' ? column['name'] : ''
  for (const key of COLUMN_RULE_KEYS) {
    const value = ruleValue(column, key)
    // `required`/`unique` normalize to true-or-absent (m5-0 semantics).
    if (value === undefined || value === false) continue
    const path = `${pathBase}.${key}`
    const ruleId = path

    // RE2 dialect honesty happens before any other binding work: a pattern
    // outside the documented subset is a typed error regardless of column.
    // The string check comes first so a non-string value behind a broken
    // cast degrades to a typed error (compiler totality) instead of a
    // TypeError inside the checker.
    if (key === 'regex') {
      if (typeof value !== 'string') {
        pushError(ctx, 'invalid-contract-input', path, 'rule value must be a string', {
          ruleId,
          column: columnName,
        })
        continue
      }
      const check = checkRe2Pattern(value)
      if (!check.valid) {
        pushError(
          ctx,
          'invalid-regex',
          path,
          `regex pattern is not valid RE2 (DuckDB's dialect): ${check.reason}`,
          { ruleId, column: columnName },
        )
        continue
      }
    }
    if (!ruleValueIsBindable(ctx, key, path, ruleId, columnName, value)) continue

    const requirement = familyRequirement(key)
    const bound = bindColumn(ctx, schema, path, ruleId, columnName, requirement.needsFamily)
    if (bound === null) continue
    const { entry, family } = bound
    const srcCol = colSql({ scope: 'source', column: entry.name })

    if (requirement.families !== undefined && !requirement.families.includes(family)) {
      pushError(ctx, 'rule-not-applicable', path, notApplicableMessage(key, entry, family), {
        ruleId,
        column: entry.name,
      })
      continue
    }
    if (key === 'allowed-values') {
      // Family-matched, but the entries' scalar kind must still match the
      // family or DuckDB would fail/coerce the comparison at execution
      // (module doc): binding rejects, never approximates.
      const mismatch = allowedValuesKindMismatch(value as readonly unknown[], family)
      if (mismatch !== null) {
        pushError(
          ctx,
          'rule-not-applicable',
          path,
          `allowed-values entry ${mismatch.index} is a ${mismatch.entryKind} literal, but column '${entry.name}' has engine type '${entry.type}' (family '${family}') — ${family} columns bind only ${familyKindFor(family)} literals (a cross-kind comparison would fail or coerce at execution)`,
          { ruleId, column: entry.name },
        )
        continue
      }
    }

    switch (key) {
      case 'type': {
        // A declared-type mismatch is the reportable violation itself
        // (module doc): compile to a dataset fact, never a binding error.
        const match = (value as string) === entry.type
        const violated = match ? 'FALSE' : 'TRUE'
        ctx.rules.push({
          ruleId,
          path,
          kind: 'declared-type',
          column: entry.name,
          outcome: 'dataset-fact',
          sql: datasetFactSql(ctx, rowCountStats(), violated),
          expectedType: value as string,
          actualType: entry.type,
        })
        ctx.summaryArms.push(datasetFactSummaryArm(ctx, ruleId, rowCountStats(), violated))
        break
      }
      case 'required':
      case 'min':
      case 'max':
      case 'allowed-values':
      case 'regex': {
        const predicate = violationPredicate(key, DERIVED_VALUE, value)
        ctx.rules.push({
          ruleId,
          path,
          kind: ruleKind(key),
          column: entry.name,
          outcome: 'row-samples',
          sql: rowSamplesSql(ctx, predicate, sourceValueProjection(entry.name)),
        })
        // The summary arm renders the identical predicate over the
        // range-qualified source column (one shared builder — the two
        // queries cannot diverge).
        ctx.summaryArms.push(
          rowSummaryArm(
            ctx,
            ruleId,
            violationPredicate(key, { scope: 'source', column: entry.name }, value),
            sourceFrom(ctx),
          ),
        )
        break
      }
      case 'unique': {
        // Violations are per-row (any row whose non-NULL value recurs),
        // counted with the same window expression in both queries. The
        // source column is renamed to the reserved aliases at the innermost
        // scope, so its own name (whatever it is) never reaches an outer
        // scope where a plan alias lives.
        const predicate = uniqueViolationPredicate()
        ctx.rules.push({
          ruleId,
          path,
          kind: 'unique',
          column: entry.name,
          outcome: 'row-samples',
          sql: rowSamplesSql(ctx, predicate, sourceUniqueProjection(entry.name)),
        })
        ctx.summaryArms.push(
          rowSummaryArm(ctx, ruleId, predicate, uniqueSummaryFrom(ctx, entry.name)),
        )
        break
      }
      case 'max-null-share': {
        const share = sqlNumberLiteral(value as number)
        const nullShare = q('assay_null_share')
        const stats = `count(*) AS ${q('assay_n')}, coalesce(avg(CASE WHEN ${srcCol} IS NULL THEN 1.0 ELSE 0.0 END), 0.0) AS ${nullShare}`
        const violated = `${nullShare} > ${share}`
        ctx.rules.push({
          ruleId,
          path,
          kind: 'max-null-share',
          column: entry.name,
          outcome: 'dataset-fact',
          sql: datasetFactSql(ctx, stats, violated),
        })
        ctx.summaryArms.push(datasetFactSummaryArm(ctx, ruleId, stats, violated))
        break
      }
      case 'min-distinct-share': {
        const share = sqlNumberLiteral(value as number)
        const nonNull = q('assay_non_null')
        const distinct = q('assay_distinct')
        const stats = `count(*) AS ${q('assay_n')}, count(${srcCol}) AS ${nonNull}, count(DISTINCT ${srcCol}) AS ${distinct}`
        // Zero non-NULL values pass vacuously (module doc).
        const violated = `${nonNull} > 0 AND CAST(${distinct} AS DOUBLE) / ${nonNull} < ${share}`
        ctx.rules.push({
          ruleId,
          path,
          kind: 'min-distinct-share',
          column: entry.name,
          outcome: 'dataset-fact',
          sql: datasetFactSql(ctx, stats, violated),
        })
        ctx.summaryArms.push(datasetFactSummaryArm(ctx, ruleId, stats, violated))
        break
      }
    }
  }
}

/** Compile one dataset-level rule (`dataset.min-rows` / `dataset.max-rows`). */
function compileDatasetRule(
  ctx: Ctx,
  dataset: Record<string, unknown>,
  key: 'min-rows' | 'max-rows',
): void {
  const path = `dataset.${key}`
  const value = dataset[key === 'min-rows' ? 'minRows' : 'maxRows']
  if (value === undefined) return
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    pushError(
      ctx,
      'invalid-contract-input',
      path,
      'row-count bound must be a non-negative safe integer',
      {
        ruleId: path,
      },
    )
    return
  }
  const violated =
    key === 'min-rows'
      ? `${q('assay_n')} < ${sqlIntegerLiteral(value)}`
      : `${q('assay_n')} > ${sqlIntegerLiteral(value)}`
  ctx.rules.push({
    ruleId: path,
    path,
    kind: ruleKind(key),
    column: null,
    outcome: 'dataset-fact',
    sql: datasetFactSql(ctx, rowCountStats(), violated),
  })
  ctx.summaryArms.push(datasetFactSummaryArm(ctx, path, rowCountStats(), violated))
}

// ---------------------------------------------------------------------------
// Input validation (options / schema / defensive contract shape)
// ---------------------------------------------------------------------------

/** Validate compile options; returns resolved values or null (error pushed). */
function validateOptions(
  ctx: Ctx,
  options: CompileOptions,
): { readonly sampleLimit: number } | null {
  const relation = (options as CompileOptions | null)?.relation
  if (typeof relation !== 'string' || relation === '') {
    pushError(
      ctx,
      'invalid-options',
      'options',
      'relation must be a non-empty string (the target table or view name)',
    )
    return null
  }
  if (relation.includes('\u0000')) {
    pushError(
      ctx,
      'invalid-options',
      'options',
      'relation carries a NUL character, which cannot be bound to SQL text',
    )
    return null
  }
  const sampleLimit = options.sampleLimit ?? DEFAULT_SAMPLE_LIMIT
  if (typeof sampleLimit !== 'number' || !Number.isSafeInteger(sampleLimit) || sampleLimit < 1) {
    pushError(
      ctx,
      'invalid-options',
      'options',
      `sampleLimit must be a safe integer ≥ 1 (a smaller limit could not distinguish a violated rule from a clean one); got ${describeOptionValue(sampleLimit)}`,
    )
    return null
  }
  return { sampleLimit }
}

/** Validate the schema; returns the by-name map or null (errors pushed). */
function validateSchema(
  ctx: Ctx,
  schema: readonly unknown[],
): ReadonlyMap<string, EngineSchemaColumn> | null {
  const byName = new Map<string, EngineSchemaColumn>()
  let ok = true
  schema.forEach((entry, index) => {
    const path = `schema[${index}]`
    const record = entry as { readonly name?: unknown; readonly type?: unknown } | null
    if (record === null || typeof record !== 'object') {
      pushError(
        ctx,
        'invalid-schema-input',
        path,
        'schema entry must be an object with string name and type',
      )
      ok = false
      return
    }
    const name = record['name']
    const type = record['type']
    if (typeof name !== 'string' || name === '') {
      pushError(ctx, 'invalid-schema-input', path, 'schema entry must have a non-empty string name')
      ok = false
      return
    }
    if (typeof type !== 'string' || type === '') {
      pushError(
        ctx,
        'invalid-schema-input',
        path,
        `column '${name}' must have a non-empty string type`,
      )
      ok = false
      return
    }
    if (name.includes('\u0000') || type.includes('\u0000')) {
      pushError(
        ctx,
        'invalid-schema-input',
        path,
        `column '${name}' carries a NUL character, which cannot be bound to SQL text`,
      )
      ok = false
      return
    }
    if (byName.has(name)) {
      pushError(
        ctx,
        'invalid-schema-input',
        path,
        `duplicate column name '${name}' in the target schema`,
      )
      ok = false
      return
    }
    byName.set(name, { name, type })
  })
  return ok ? byName : null
}

/**
 * Validate the parts of the contract AST the compiler depends on that
 * `parseContract` output always satisfies — kept total against caller bugs
 * behind casts (the canonical serializer's defensive-read precedent). The
 * key vocabulary is enforced too: `parseContract` rejects unknown keys, so
 * a key outside the v1 vocabulary is a caller bug and is a typed error —
 * never a silently-ignored rule.
 */

/** The full v1 column rule-set vocabulary (m5-0's AST field spellings). */
const COLUMN_RULE_KEY_SPELLINGS: ReadonlySet<string> = new Set([
  'name',
  'type',
  'required',
  'unique',
  'min',
  'max',
  'allowedValues',
  'regex',
  'maxNullShare',
  'minDistinctShare',
])

/** The v1 contract's top-level keys. */
const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(['format', 'metadata', 'columns', 'dataset'])
function validateContractShape(ctx: Ctx, contract: ContractV1): boolean {
  let ok = true
  if (contract?.format !== 'v1') {
    pushError(ctx, 'invalid-contract-input', 'format', "contract format must be 'v1'")
    ok = false
  }
  if (contract !== null && typeof contract === 'object') {
    for (const key of Object.keys(contract).sort()) {
      if (!TOP_LEVEL_KEYS.has(key)) {
        pushError(
          ctx,
          'invalid-contract-input',
          key,
          `'${key}' is not a v1 contract key (format, metadata, columns, dataset)`,
        )
        ok = false
      }
    }
  }
  if (typeof contract?.metadata?.name !== 'string') {
    pushError(
      ctx,
      'invalid-contract-input',
      'metadata.name',
      'contract metadata.name must be a string',
    )
    ok = false
  }
  const version = contract?.metadata?.version
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    pushError(
      ctx,
      'invalid-contract-input',
      'metadata.version',
      'contract metadata.version must be a positive safe integer',
    )
    ok = false
  }
  if (!Array.isArray(contract?.columns)) {
    pushError(ctx, 'invalid-contract-input', 'columns', 'contract columns must be an array')
    return false
  }
  const seen = new Set<string>()
  contract.columns.forEach((entry, index) => {
    const path = `columns[${index}]`
    const record = entry as { readonly name?: unknown } | null
    if (record === null || typeof record !== 'object' || typeof record['name'] !== 'string') {
      pushError(
        ctx,
        'invalid-contract-input',
        path,
        'column rule set must be an object with a string name',
      )
      ok = false
      return
    }
    const name = record['name']
    if (seen.has(name)) {
      pushError(ctx, 'invalid-contract-input', path, `duplicate column rule set for '${name}'`)
      ok = false
      return
    }
    seen.add(name)
    for (const key of Object.keys(record).sort()) {
      if (!COLUMN_RULE_KEY_SPELLINGS.has(key)) {
        pushError(
          ctx,
          'invalid-contract-input',
          `${path}.${key}`,
          `'${key}' is not a rule key in the m5-0 column vocabulary`,
        )
        ok = false
      }
    }
    if (name.includes('\u0000')) {
      pushError(
        ctx,
        'invalid-contract-input',
        path,
        `column name contains a NUL character, which cannot be bound to SQL text`,
      )
      ok = false
    }
  })
  return ok
}

// ---------------------------------------------------------------------------
// The compiler entry point
// ---------------------------------------------------------------------------

/**
 * Compile a validated contract + target schema into a validation plan.
 * Total over all inputs: `{ ok: true, plan }` or `{ ok: false, errors }` —
 * never a throw, never a partial plan (any binding error fails the whole
 * compile; the caller gets every error to render).
 */
export function compileContract(
  contract: ContractV1,
  schema: EngineSchema,
  options: CompileOptions,
): CompileResult {
  const ctx: Ctx = {
    errors: [],
    rules: [],
    summaryArms: [],
    rel: '',
    sampleLimit: DEFAULT_SAMPLE_LIMIT,
  }

  const resolved = validateOptions(ctx, options)
  const schemaList = Array.isArray(schema) ? (schema as readonly unknown[]) : null
  if (schemaList === null) {
    pushError(
      ctx,
      'invalid-schema-input',
      'schema',
      'target schema must be an array of { name, type } columns',
    )
  }
  const byName = schemaList === null ? null : validateSchema(ctx, schemaList)
  const contractOk = validateContractShape(ctx, contract)
  if (ctx.errors.length > 0 || byName === null || resolved === null || !contractOk) {
    return { ok: false, errors: ctx.errors }
  }
  ctx.rel = q(options.relation)
  ctx.sampleLimit = resolved.sampleLimit

  // Column rules in canonical contract order; dataset rules after. Each
  // rule compiles or is rejected — errors collect across everything.
  const columns = contract.columns as unknown as readonly Record<string, unknown>[]
  for (let index = 0; index < columns.length; index++) {
    compileColumnRule(ctx, byName, index, columns[index])
  }
  // The dataset rule set is defensively validated (no silent skips): a
  // non-object `dataset` behind a broken cast cannot carry rules, so it is
  // a typed error rather than an absent rule set; unknown keys are caller
  // bugs just like unknown column rule keys.
  const dataset: unknown =
    contract === null || typeof contract !== 'object'
      ? undefined
      : (contract as unknown as Record<string, unknown>)['dataset']
  if (dataset !== undefined) {
    if (dataset === null || typeof dataset !== 'object' || Array.isArray(dataset)) {
      pushError(
        ctx,
        'invalid-contract-input',
        'dataset',
        'contract dataset must be an object with minRows/maxRows when present — a non-object dataset can carry no rules, so it is rejected rather than silently ignored',
      )
    } else {
      const record = dataset as Record<string, unknown>
      for (const key of Object.keys(record).sort()) {
        if (key !== 'minRows' && key !== 'maxRows') {
          pushError(
            ctx,
            'invalid-contract-input',
            `dataset.${key}`,
            `'${key}' is not a dataset rule key (only minRows/maxRows exist in v1)`,
          )
        }
      }
      compileDatasetRule(ctx, record, 'min-rows')
      compileDatasetRule(ctx, record, 'max-rows')
    }
  }

  if (ctx.errors.length > 0) return { ok: false, errors: ctx.errors }

  const plan: ValidationPlan = {
    planKind: PLAN_KIND,
    planVersion: PLAN_VERSION,
    contractName: contract.metadata.name,
    contractVersion: contract.metadata.version,
    relation: options.relation,
    sampleLimit: ctx.sampleLimit,
    rules: ctx.rules,
    summarySql:
      ctx.summaryArms.length > 0 ? ctx.summaryArms.join('\nUNION ALL\n') : EMPTY_SUMMARY_SQL,
  }
  return { ok: true, plan }
}
