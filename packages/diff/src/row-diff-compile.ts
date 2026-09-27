// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The row-diff DiffPlan compiler (m6-1).
 *
 * `compileRowDiffPlan` turns two engine-shaped schemas (the `schema()`
 * shape, `Array<{ name, type }>`) plus the **explicit** user-chosen key
 * columns into a deterministic, serializable {@link RowDiffPlan}: three
 * per-aspect queries (added / removed / changed) plus one totals query —
 * or collected typed {@link RowDiffBindingError}s. It compiles SQL text
 * only: nothing is executed here, no engine is touched (the m6-2 engine op
 * binds side A to the effective view and side B to a staged scratch view;
 * see `row-diff-plan.ts` for the full binding contract).
 *
 * ## Guarantees (the done-when, implemented here)
 *
 * - **Total** — never throws, over any input: hostile schemas degrade
 *   through the m6-0 guarded validators (`validateSchema` — reused, never
 *   re-validated differently), a hostile key set or options object behind
 *   a cast degrades to typed errors (every field read guarded; option
 *   getters read exactly once, m5-1's `readOptionOnce` pattern), and a
 *   revoked/all-traps Proxy in any argument position comes back as a
 *   binding error, never a raw throw. Errors are collected **across
 *   stages** — options, schema A, schema B, and the key set all run, and
 *   every stage's findings are reported together; within the options
 *   stage the first invalid option aborts that stage only (stage-wise,
 *   not a full sweep — pinned by test, audit AR-F5).
 * - **Keys are explicit** (checkpoint C2) — an empty key set is a binding
 *   error. The compiler never guesses: `inferRowDiffKeys` proposes
 *   candidates; surfaces confirm. The compiler is deliberately blind to
 *   the proposer.
 * - **Deterministic** — identical inputs produce byte-identical SQL and
 *   plan JSON: no clocks, no randomness, no map-iteration-order leak;
 *   documented orderings everywhere (errors: options → schema A → schema
 *   B → key-set shape → no-shared-columns → per-key existence (A side
 *   before B side, key order) → per-key type compatibility (key order) →
 *   per-shared-column type compatibility (schema-A order);
 *   queries: aspect order added → removed → changed; changed-column lists:
 *   shared non-key columns in schema-A order; ON/anti-join conditions: key
 *   order). Golden pins freeze the bytes.
 * - **Injection-safe** — identifiers enter SQL only through
 *   `quoteIdentifier`; the only literals are integers (`sampleLimit`, via
 *   `sqlIntegerLiteral`), column names rendered as string literals for the
 *   changed-column lists (`sqlStringLiteral`), and fixed internal
 *   constants. NUL-carrying names are rejected *before* any helper runs
 *   (the `@assay/validation` literals contract). There are no dataset
 *   values in a row-diff plan — names and integers only, pinned
 *   structurally by scan tests.
 * - **Collision-free for every legal column name** — the `row-diff-plan.ts`
 *   module-doc invariant: source columns are referenced only
 *   range-qualified (`"a"."col"` / `"b"."col"`), derived tables expose
 *   only reserved `assay_*` aliases (plus `sample_index`), so any dataset
 *   column name — the range names themselves, `assay_*` in any casing, SQL
 *   keywords — binds and executes (m5-1 proved the class against real
 *   DuckDB; goldens here pin the shapes, m6-2 executes them).
 *
 * ## Key-type compatibility (the documented compatible-spellings policy)
 *
 * {@link keyTypesCompatible} classifies both spellings with the m5-1
 * type-family classifier (reused from `@assay/validation`, never
 * reimplemented):
 *
 * - **same flat family = compatible** — `INTEGER` ↔ `BIGINT`,
 *   `VARCHAR(3)` ↔ `VARCHAR`, `DECIMAL(10,2)` ↔ `DOUBLE`: a key match
 *   compares values under the engine's documented common-type comparison
 *   semantics, deterministic per engine version (m6-2 pins the version).
 * - **`json` is refused on any side** — JSON equality is textual, which
 *   would make key matching approximate; the m5-1 `unique`-rule honesty
 *   precedent, applied to keys.
 * - **`'other'` (arrays, nested types, unknown spellings) binds only when
 *   BOTH sides carry the byte-identical spelling** — nested equality under
 *   `IS NOT DISTINCT FROM` is elementwise-honest for identical type
 *   spellings, and a cross-spelling nested pair (`INTEGER[]` vs `BIGINT[]`)
 *   is refused rather than approximated.
 * - **different flat families are refused** — no implicit cross-family key
 *   match (`INTEGER` key vs `VARCHAR` key is almost certainly a key
 *   accident; refusing is the visible, actionable outcome).
 *
 * ## Compared-column compatibility (au3-2)
 *
 * The change-comparable **shared non-key** columns are gated by the SAME
 * policy function, applied to every column in schema-A order: both sides
 * are classified and an incompatible pair is refused as
 * `shared-column-type-mismatch`. A cross-family compared pair
 * (`VARCHAR` vs `INTEGER`) is the critical case — both sides are probed
 * with `IS DISTINCT FROM`, and the engine's implicit cast fails at
 * execution with a value-bearing `Conversion Error`; refusing at compile
 * time keeps the plan value-free. The policy is {@link keyTypesCompatible}
 * verbatim (never a second predicate), so same-family numeric widening
 * (`INTEGER` vs `BIGINT`) still compiles and JSON is refused on either
 * side. The `shared-column-type-mismatch` message mirrors the key shape:
 * exact spellings, both families, and the policy reason.
 *
 * Purity: no React, no browser APIs, no engine imports —
 * `@assay/validation` helpers only (lint-enforced).
 */

import type { EngineSchema } from '@assay/validation'
import {
  classifyColumnType,
  quoteIdentifier,
  sqlIntegerLiteral,
  sqlStringLiteral,
} from '@assay/validation'
import { echoValue, readArray } from './guards.js'
import type { DiffIssue } from './issues.js'
import type { ValidatedSchema } from './input-validation.js'
import { validateSchema } from './input-validation.js'
import type { RowDiffBindingError, RowDiffBindingErrorCode } from './row-diff-errors.js'
import type { RowDiffPlan } from './row-diff-plan.js'
import { DIFF_PLAN_KIND, DIFF_PLAN_VERSION } from './row-diff-plan.js'

/** Compile options: the two relation bindings and the sample bound K. */
export interface RowDiffCompileOptions {
  /**
   * Side-A (reference) relation: the engine-generated name m6-2 binds to
   * the effective view (e.g. the composed overlay view or base view).
   * Quoted into every query; part of the determinism tuple.
   */
  readonly relationA: string
  /** Side-B (current) relation: the m6-2 staged scratch view name. */
  readonly relationB: string
  /**
   * K of the sample bound: per-aspect queries return at most this many
   * sample rows (exact counts travel with every query regardless). Must be
   * a safe integer ≥ 1 (`LIMIT 0` would make a non-empty aspect
   * indistinguishable from an empty one under the empty-result ⇔ count-0
   * convention). Default 20. m6-2 may clamp further engine-side.
   */
  readonly sampleLimit?: number
}

/** Default K (see {@link RowDiffCompileOptions.sampleLimit}). */
export const DEFAULT_ROW_DIFF_SAMPLE_LIMIT = 20

/** A compile outcome: plan or collected typed errors — never a throw. */
export type RowDiffCompileResult =
  | { readonly ok: true; readonly plan: RowDiffPlan }
  | { readonly ok: false; readonly errors: readonly RowDiffBindingError[] }

/**
 * The documented compatible-spellings policy for key columns across sides
 * (see module doc). Both arguments must be non-empty NUL-free engine type
 * strings — the compiler has validated that before calling (the classifier
 * is total regardless).
 */
export function keyTypesCompatible(typeA: string, typeB: string): boolean {
  // Totality: a hostile value behind a cast must degrade, never throw —
  // non-strings classify no family (and `classifyColumnType` would coerce
  // an object key through `toString`, which can throw).
  if (typeof typeA !== 'string' || typeof typeB !== 'string') return false
  const familyA = classifyColumnType(typeA)
  const familyB = classifyColumnType(typeB)
  // JSON keys refused outright (textual equality → approximate matching).
  if (familyA === 'json' || familyB === 'json') return false
  // Nested/unknown spellings bind only on byte-identical spellings.
  if (familyA === 'other' || familyB === 'other') {
    return familyA === 'other' && familyB === 'other' && typeA === typeB
  }
  return familyA === familyB
}

// ---------------------------------------------------------------------------
// Internal compile context
// ---------------------------------------------------------------------------

interface Ctx {
  readonly errors: RowDiffBindingError[]
  /** Quoted relation references; set after option validation. */
  relA: string
  relB: string
  sampleLimit: number
}

function pushError(
  ctx: Ctx,
  code: RowDiffBindingErrorCode,
  message: string,
  attribution: { side?: 'A' | 'B'; column?: string } = {},
): void {
  ctx.errors.push({
    code,
    message,
    ...(attribution.side !== undefined ? { side: attribution.side } : {}),
    ...(attribution.column !== undefined ? { column: attribution.column } : {}),
  })
}

/** Quote a name for an identifier position (column, alias, relation, range). */
function q(name: string): string {
  return quoteIdentifier(name)
}

// ---------------------------------------------------------------------------
// Input validation (options / schemas / key set)
// ---------------------------------------------------------------------------

/** The options' resolved values — each property read exactly once, then inert. */
interface ResolvedOptions {
  readonly relationA: string
  readonly relationB: string
  readonly sampleLimit: number
}

/** One guarded property read: a value, or "the accessor threw" as data. */
type OptionRead = { readonly ok: true; readonly value: unknown } | { readonly ok: false }

/**
 * Read one compile-option property **exactly once**, total over hostile
 * accessors (the m5-1 pattern): a throwing getter degrades to
 * `{ ok: false }` data. Resolution order is fixed (relationA, relationB,
 * sampleLimit); the resolved values are the only ones the compiler ever
 * uses, so a stateful accessor yields one consistent snapshot.
 */
function readOptionOnce(
  options: unknown,
  key: 'relationA' | 'relationB' | 'sampleLimit',
): OptionRead {
  try {
    return { ok: true, value: (options as Partial<RowDiffCompileOptions> | undefined)?.[key] }
  } catch {
    return { ok: false }
  }
}

/**
 * Render an invalid option/key value for an error message — **total over
 * every value** (objects are never stringified;
 * `String(Object.create(null))` is a TypeError, so the error path must not
 * route through it). Delegates to the package's total echo.
 */
function describeValue(value: unknown): string {
  return echoValue(value)
}

/** Resolve and validate the compile options; null on error (pushed). */
function validateOptions(ctx: Ctx, options: unknown): ResolvedOptions | null {
  const relationARead = readOptionOnce(options, 'relationA')
  const relationBRead = readOptionOnce(options, 'relationB')
  const limitRead = readOptionOnce(options, 'sampleLimit')
  let ok = true
  const relations: string[] = []
  for (const [key, read] of [
    ['relationA', relationARead],
    ['relationB', relationBRead],
  ] as const) {
    if (!read.ok) {
      pushError(
        ctx,
        'invalid-options',
        `reading '${key}' threw an exception — compile options must be plain values, not throwing getters (the compiler is total, so this typed error replaces the raw exception)`,
      )
      ok = false
      continue
    }
    const relation = read.value
    if (typeof relation !== 'string' || relation === '') {
      pushError(
        ctx,
        'invalid-options',
        `'${key}' must be a non-empty string (the relation name the executor binds this side to); got ${describeValue(relation)}`,
      )
      ok = false
      continue
    }
    if (relation.includes('\u0000')) {
      pushError(
        ctx,
        'invalid-options',
        `'${key}' carries a NUL character, which cannot be bound to SQL text`,
      )
      ok = false
      continue
    }
    relations.push(relation)
  }
  if (!limitRead.ok) {
    pushError(
      ctx,
      'invalid-options',
      "reading 'sampleLimit' threw an exception — compile options must be plain values, not throwing getters (the compiler is total, so this typed error replaces the raw exception)",
    )
    ok = false
  }
  const rawLimit = limitRead.ok ? limitRead.value : undefined
  const sampleLimit = rawLimit === undefined ? DEFAULT_ROW_DIFF_SAMPLE_LIMIT : rawLimit
  if (!ok) return null
  if (typeof sampleLimit !== 'number' || !Number.isSafeInteger(sampleLimit) || sampleLimit < 1) {
    pushError(
      ctx,
      'invalid-options',
      `sampleLimit must be a safe integer ≥ 1 (a smaller limit could not distinguish a non-empty aspect from an empty one); got ${describeValue(sampleLimit)}`,
    )
    return null
  }
  // Both relations validated as strings above when `ok` still holds.
  return { relationA: relations[0] as string, relationB: relations[1] as string, sampleLimit }
}

/**
 * Validate one schema side through the m6-0 guarded validator (reused,
 * never re-validated differently) and translate its issues into binding
 * errors. For *binding*, any schema problem fails the compile — a plan
 * must reference columns unambiguously, so the m6-0 report model's
 * first-wins degradation is deliberately stricter here (documented on
 * `duplicate-schema-column`). Returns the validated side or null.
 */
function validateSchemaSide(ctx: Ctx, schema: unknown, side: 'A' | 'B'): ValidatedSchema | null {
  const issues: DiffIssue[] = []
  const validated = validateSchema(schema, side, issues)
  for (const issue of issues) {
    const code: RowDiffBindingErrorCode =
      issue.code === 'duplicate-column-name' ? 'duplicate-schema-column' : 'invalid-schema-input'
    pushError(ctx, code, issue.message, { side: issue.side, column: issue.column })
  }
  return validated
}

/**
 * Validate the key set: a readable array of non-empty, NUL-free strings,
 * pairwise distinct exactly AND up to case (DuckDB identifiers are
 * case-insensitive even when quoted, so two case-variants cannot be
 * distinct key columns). An empty (but well-formed) key set is its own
 * binding error — keys are explicit, never inferred implicitly (C2).
 * Returns the validated keys in given order, or null (errors pushed).
 */
function validateKeys(ctx: Ctx, keys: unknown): readonly string[] | null {
  const entries = readArray(keys)
  if (entries === null) {
    pushError(
      ctx,
      'invalid-keys-input',
      `keys must be a readable array of key column names; got ${describeValue(keys)}`,
    )
    return null
  }
  const keysOut: string[] = []
  const byLower = new Map<string, string>()
  let ok = true
  entries.forEach((entry, index) => {
    if (typeof entry !== 'string' || entry === '') {
      pushError(
        ctx,
        'invalid-keys-input',
        `key entry ${index} must be a non-empty string; got ${describeValue(entry)}`,
      )
      ok = false
      return
    }
    if (entry.includes('\u0000')) {
      pushError(
        ctx,
        'invalid-keys-input',
        `key entry ${index} ('${entry}') carries a NUL character, which cannot be bound to SQL text`,
        { column: entry },
      )
      ok = false
      return
    }
    const lower = entry.toLowerCase()
    const first = byLower.get(lower)
    if (first !== undefined) {
      pushError(
        ctx,
        'duplicate-key-column',
        first === entry
          ? `key column '${entry}' is listed more than once in the key set`
          : `key columns '${first}' and '${entry}' collide case-insensitively (identifiers are case-insensitive even when quoted), so they cannot both be key columns`,
        { column: entry },
      )
      ok = false
      return
    }
    byLower.set(lower, entry)
    keysOut.push(entry)
  })
  if (!ok) return null
  if (keysOut.length === 0) {
    pushError(
      ctx,
      'empty-key-set',
      'the key set is empty — a row diff requires explicit key columns (key inference proposes candidates per checkpoint C2; a surface confirms them, the compiler never binds an implicit guess)',
    )
    return null
  }
  return keysOut
}

/** The single case-insensitive name candidate on a side, if exactly one exists. */
function caseInsensitiveHint(schema: ValidatedSchema, columnName: string): string | null {
  const lower = columnName.toLowerCase()
  const matches = schema.columns.filter((entry) => entry.name.toLowerCase() === lower)
  return matches.length === 1 ? (matches[0] as { name: string }).name : null
}
// ---------------------------------------------------------------------------
// SQL fragment builders — pure, deterministic, shared between the per-aspect
// queries and the totals arms so the two cannot diverge (row-diff-plan.ts).
// ---------------------------------------------------------------------------

/** The documented range names (row-diff-plan.ts): side A → "a", side B → "b". */
type Range = 'a' | 'b'

/** Indent every line (for embedding a fragment at one deeper level). */
function indent(text: string, pad: string): string {
  return text
    .split('\n')
    .map((line) => pad + line)
    .join('\n')
}

/**
 * Anti-join source fragment (added/removed): one side's rows whose key
 * tuple has no match on the other side, with the scanned side's natural
 * scan ordinal. Every reference is range-qualified; every join condition
 * is `IS NOT DISTINCT FROM` (NULL keys group together — the documented v1
 * semantic, pinned in goldens).
 *
 * **The ordinal is computed over the UNFILTERED relation** (the m5-1
 * `rowSamplesSql` inner-projection pattern): `row_number() OVER ()` shares
 * its SELECT scope with a bare `FROM`, and the anti-join `WHERE NOT EXISTS`
 * is applied *outside* that derived table — SQL evaluates window functions
 * after `WHERE`, so computing the ordinal in the same SELECT as the filter
 * would number the surviving rows `0..K-1` instead of their true scan
 * positions (the m6-1 round-1 defect; see `row-diff-plan.ts`).
 *
 * The scanned side's keys cross the derived-table boundary renamed to the
 * reserved `assay_key_<i>` aliases, so the correlated anti-join can probe
 * them range-qualified (`"a"."key" IS NOT DISTINCT FROM
 * "assay_antijoin_source"."assay_key_i"`) without the source column ever
 * escaping its own scope — the collision-freedom invariant for every legal
 * column name.
 */
function antiJoinSource(ctx: Ctx, keys: readonly string[], scanned: Range): string {
  const probed: Range = scanned === 'a' ? 'b' : 'a'
  const probedRel = probed === 'a' ? ctx.relA : ctx.relB
  const scannedRel = scanned === 'a' ? ctx.relA : ctx.relB
  const keyLines = keys.map((key, i) => `${q(scanned)}.${q(key)} AS ${q(`assay_key_${i}`)}`)
  const inner = [
    `SELECT row_number() OVER () - 1 AS ${q('assay_row_ordinal')},`,
    ...keyLines.map((line, i) => `       ${line}${i < keyLines.length - 1 ? ',' : ''}`),
    `FROM ${scannedRel} AS ${q(scanned)}`,
  ].join('\n')
  const conditions = keys.map(
    (key, i) =>
      `${i === 0 ? '  WHERE ' : '    AND '}${q(probed)}.${q(key)} IS NOT DISTINCT FROM ${q('assay_antijoin_source')}.${q(`assay_key_${i}`)}`,
  )
  return [
    `SELECT ${q('assay_row_ordinal')}`,
    'FROM (',
    indent(inner, '  '),
    `) AS ${q('assay_antijoin_source')}`,
    'WHERE NOT EXISTS (',
    '  SELECT 1',
    `  FROM ${probedRel} AS ${q(probed)}`,
    ...conditions,
    ')',
  ].join('\n')
}

/**
 * Projection lines for one side's inner derived table: source columns
 * cross the scope boundary only renamed to reserved aliases (keys →
 * `assay_key_<i>` in key order, shared columns → `assay_col_<j>` in
 * schema-A order), plus the literal `TRUE` presence marker that makes
 * "matched" decodable in the full outer join even for NULL keys.
 */
function projectionLines(
  range: Range,
  keys: readonly string[],
  shared: readonly string[],
  withOrdinal: boolean,
  presentAlias: 'assay_present_a' | 'assay_present_b',
): string[] {
  const lines: string[] = []
  if (withOrdinal) lines.push(`row_number() OVER () - 1 AS ${q('assay_row_ordinal')}`)
  keys.forEach((key, i) => lines.push(`${q(range)}.${q(key)} AS ${q(`assay_key_${i}`)}`))
  shared.forEach((column, j) => lines.push(`${q(range)}.${q(column)} AS ${q(`assay_col_${j}`)}`))
  lines.push(`TRUE AS ${q(presentAlias)}`)
  return lines
}

/** Render a projection as SELECT-list text (continuations aligned under the first term). */
function projectionSelect(lines: readonly string[], leading: string, pad: string): string {
  const body = [
    `${leading}SELECT ${lines[0] as string},`,
    ...lines.slice(1, -1).map((line) => `${pad}${line},`),
    ...(lines.length > 1 ? [`${pad}${lines[lines.length - 1] as string}`] : []),
  ]
  return body.join('\n')
}

/**
 * The changed source fragment: the **full outer join on key** (the task
 * row's mechanism) with two literal-`TRUE` presence markers — "matched"
 * must stay decodable when key values are NULL (an unmatched row's
 * counterpart columns are NULL, and so are a NULL-key matched pair's). The
 * WHERE keeps exactly the matched pairs with at least one distinct shared
 * non-key column; with nothing comparable it degrades to the never-true
 * guard (`changed` is structurally empty — pinned in goldens).
 *
 * The A-side ordinal is computed over side A's **unfiltered** scan inside
 * the `"ai"` derived table (the m5-1 inner-projection pattern) and is
 * carried out by the outer projection as `"ai"."assay_row_ordinal"` — it is
 * the true pre-filter A-side position the m4-3 `base:<anchor>#<ordinal>`
 * grammar resolves (the m6-1 round-1 defect was re-numbering post-WHERE
 * rows `0..K-1` here). The `"bi"` projection deliberately carries **no**
 * ordinal (`withOrdinal = false`): B-side rows are report content only
 * (C3), the matched B counterpart is identified by the join itself, and
 * `changed` samples are A-side rows, so no B-side ordinal is needed (for
 * `added`, the B-scan ordinal travels from the anti-join source instead).
 * The inner A-side ordinal is therefore no longer dead weight.
 */
function changedSource(ctx: Ctx, keys: readonly string[], shared: readonly string[]): string {
  // The changed-column list: one CASE arm per shared non-key column, in
  // schema-A order; column names enter as string literals through
  // sqlStringLiteral (the only input-derived string literals in a
  // row-diff plan). With nothing to compare, the expression is the empty
  // list literal — its rows are unreachable (never-true guard below), but
  // the binder still sees it.
  const arm = (column: string, j: number): string =>
    `CASE WHEN ${q('ai')}.${q(`assay_col_${j}`)} IS DISTINCT FROM ${q('bi')}.${q(`assay_col_${j}`)} THEN [${sqlStringLiteral(column)}] ELSE [] END`
  const listLines: string[] =
    shared.length === 0
      ? [`       CAST([] AS VARCHAR[]) AS ${q('assay_changed')}`]
      : [
          '       list_concat(',
          ...shared.map(
            (column, j) => `         ${arm(column, j)}${j < shared.length - 1 ? ',' : ''}`,
          ),
          `       ) AS ${q('assay_changed')}`,
        ]
  const projection = [`SELECT ${q('ai')}.${q('assay_row_ordinal')},`, ...listLines].join('\n')

  const ai = [
    projectionSelect(projectionLines('a', keys, shared, true, 'assay_present_a'), '  ', '       '),
    `  FROM ${ctx.relA} AS ${q('a')}`,
  ].join('\n')
  const bi = [
    projectionSelect(projectionLines('b', keys, shared, false, 'assay_present_b'), '  ', '       '),
    `  FROM ${ctx.relB} AS ${q('b')}`,
  ].join('\n')
  const onLines = keys.map(
    (_key, i) =>
      `${i === 0 ? '  ON ' : '   AND '}${q('ai')}.${q(`assay_key_${i}`)} IS NOT DISTINCT FROM ${q('bi')}.${q(`assay_key_${i}`)}`,
  )
  const distinct = shared.map(
    (_column, j) =>
      `${q('ai')}.${q(`assay_col_${j}`)} IS DISTINCT FROM ${q('bi')}.${q(`assay_col_${j}`)}`,
  )
  const predicateLines: string[] =
    shared.length === 0
      ? ['  AND FALSE']
      : shared.length === 1
        ? [`  AND (${distinct[0] as string})`]
        : [
            `  AND (${distinct[0] as string}`,
            ...distinct
              .slice(1)
              .map((term, i) => `    OR ${term}${i === distinct.length - 2 ? ')' : ''}`),
          ]
  return [
    projection,
    'FROM (',
    ai,
    ') AS "ai"',
    'FULL OUTER JOIN (',
    bi,
    ') AS "bi"',
    ...onLines,
    'WHERE "ai"."assay_present_a" IS NOT NULL',
    '  AND "bi"."assay_present_b" IS NOT NULL',
    ...predicateLines,
  ].join('\n')
}

/** Per-aspect query: bounded samples + side-qualified row key + exact count. */
function aspectSql(
  ctx: Ctx,
  side: 'A' | 'B',
  source: string,
  extraColumns: readonly string[],
  wrapperAlias: string,
): string {
  return [
    'SELECT',
    `  '${side}' AS ${q('assay_side')},`,
    `  ${q('assay_row_ordinal')},`,
    ...extraColumns.map((column) => `  ${q(column)},`),
    `  row_number() OVER () - 1 AS ${q('sample_index')},`,
    `  count(*) OVER () AS ${q('assay_count')}`,
    'FROM (',
    indent(source, '  '),
    `) AS ${q(wrapperAlias)}`,
    `LIMIT ${sqlIntegerLiteral(ctx.sampleLimit)}`,
  ].join('\n')
}

/** Totals arm for one aspect (same source fragment as the aspect query). */
function totalsArm(aspect: string, source: string, wrapperAlias: string): string {
  return [
    `SELECT '${aspect}' AS ${q('assay_aspect')}, count(*) AS ${q('assay_count')}`,
    'FROM (',
    indent(source, '  '),
    `) AS ${q(wrapperAlias)}`,
  ].join('\n')
}
// ---------------------------------------------------------------------------
// The compiler entry point
// ---------------------------------------------------------------------------

/**
 * Compile the row-diff DiffPlan. Total over all inputs: `{ ok: true, plan }`
 * or `{ ok: false, errors }` — never a throw, never a partial plan (any
 * binding error fails the whole compile; the caller gets every error to
 * render, in the documented collected order — see the module doc).
 */
export function compileRowDiffPlan(
  schemaA: EngineSchema,
  schemaB: EngineSchema,
  keys: readonly string[],
  options: RowDiffCompileOptions,
): RowDiffCompileResult {
  const ctx: Ctx = { errors: [], relA: '', relB: '', sampleLimit: DEFAULT_ROW_DIFF_SAMPLE_LIMIT }

  const resolved = validateOptions(ctx, options)
  const validatedA = validateSchemaSide(ctx, schemaA, 'A')
  const validatedB = validateSchemaSide(ctx, schemaB, 'B')
  const validatedKeySet = validateKeys(ctx, keys)
  if (
    ctx.errors.length > 0 ||
    resolved === null ||
    validatedA === null ||
    validatedB === null ||
    validatedKeySet === null
  ) {
    return { ok: false, errors: ctx.errors }
  }
  ctx.relA = q(resolved.relationA)
  ctx.relB = q(resolved.relationB)
  ctx.sampleLimit = resolved.sampleLimit

  // Shared columns: exact, case-sensitive intersection, in schema-A order.
  const sharedAll = validatedA.columns.filter((column) => validatedB.byName.has(column.name))
  if (sharedAll.length === 0) {
    pushError(
      ctx,
      'no-shared-columns',
      `the two schemas share no column (exact, case-sensitive matching): side A has ${validatedA.columns.length} columns, side B has ${validatedB.columns.length} — nothing can be key-matched or change-compared`,
    )
  }

  // Per-key existence (side A before side B, key order), then type
  // compatibility (key order) — independent errors all collected.
  for (const key of validatedKeySet) {
    const inA = validatedA.byName.get(key)
    const inB = validatedB.byName.get(key)
    if (inA === undefined) {
      const hint = caseInsensitiveHint(validatedA, key)
      pushError(
        ctx,
        'missing-key-column',
        hint === null
          ? `key column '${key}' does not exist on side A (binding is exact and case-sensitive; the schema has ${validatedA.columns.length} columns)`
          : `key column '${key}' does not exist on side A — did you mean '${hint}'? (binding is exact and case-sensitive)`,
        { side: 'A', column: key },
      )
    }
    if (inB === undefined) {
      const hint = caseInsensitiveHint(validatedB, key)
      pushError(
        ctx,
        'missing-key-column',
        hint === null
          ? `key column '${key}' does not exist on side B (binding is exact and case-sensitive; the schema has ${validatedB.columns.length} columns)`
          : `key column '${key}' does not exist on side B — did you mean '${hint}'? (binding is exact and case-sensitive)`,
        { side: 'B', column: key },
      )
    }
    if (inA !== undefined && inB !== undefined && !keyTypesCompatible(inA.type, inB.type)) {
      pushError(ctx, 'key-type-mismatch', keyMismatchMessage(key, inA.type, inB.type), {
        column: key,
      })
    }
  }
  if (ctx.errors.length > 0) return { ok: false, errors: ctx.errors }

  // Shared NON-key columns: the change-comparable set, in schema-A order
  // (keys can never differ on a matched pair — they define the match).
  const keySet = new Set(validatedKeySet)
  const sharedColumns = sharedAll.filter((column) => !keySet.has(column.name))
  const shared = sharedColumns.map((column) => column.name)

  // Compared-column type policy (au3-2): every shared non-key column is
  // probed with IS DISTINCT FROM, so an incompatible pair has no honest
  // comparison — the SAME `keyTypesCompatible` policy gates it (never a
  // second predicate). Cross-family (VARCHAR vs INTEGER) and mismatched
  // 'other' spellings are refused here instead of failing at execution with
  // a value-bearing conversion error; JSON is refused on either side. Same-
  // family widening (INTEGER vs BIGINT) stays allowed — no behavior change
  // for same-family pairs. Errors are attributed by column only (there is
  // no single offending side).
  for (const column of sharedColumns) {
    const inB = validatedB.byName.get(column.name)
    if (inB !== undefined && !keyTypesCompatible(column.type, inB.type)) {
      pushError(
        ctx,
        'shared-column-type-mismatch',
        sharedColumnMismatchMessage(column.name, column.type, inB.type),
        { column: column.name },
      )
    }
  }
  if (ctx.errors.length > 0) return { ok: false, errors: ctx.errors }

  const added = antiJoinSource(ctx, validatedKeySet, 'b')
  const removed = antiJoinSource(ctx, validatedKeySet, 'a')
  const changed = changedSource(ctx, validatedKeySet, shared)

  const plan: RowDiffPlan = {
    planKind: DIFF_PLAN_KIND,
    planVersion: DIFF_PLAN_VERSION,
    relationA: resolved.relationA,
    relationB: resolved.relationB,
    keys: validatedKeySet,
    sampleLimit: ctx.sampleLimit,
    sharedColumns: shared,
    addedSql: aspectSql(ctx, 'B', added, [], 'assay_added_rows'),
    removedSql: aspectSql(ctx, 'A', removed, [], 'assay_removed_rows'),
    changedSql: aspectSql(ctx, 'A', changed, ['assay_changed'], 'assay_changed_rows'),
    totalsSql: [
      totalsArm('added', added, 'assay_added_total'),
      totalsArm('removed', removed, 'assay_removed_total'),
      totalsArm('changed', changed, 'assay_changed_total'),
    ].join('\nUNION ALL\n'),
  }
  return { ok: true, plan }
}

/** The key-type-mismatch message: exact spellings, the policy reason, families. */
function keyMismatchMessage(key: string, typeA: string, typeB: string): string {
  const familyA = classifyColumnType(typeA)
  const familyB = classifyColumnType(typeB)
  const spelled = `key column '${key}' has engine type '${typeA}' on side A (family '${familyA}') and '${typeB}' on side B (family '${familyB}')`
  if (familyA === 'json' || familyB === 'json') {
    return `${spelled}; JSON keys are refused because JSON equality is textual, which would make key matching approximate (the m5-1 unique-rule honesty precedent)`
  }
  if (familyA === 'other' || familyB === 'other') {
    return `${spelled}; nested or unknown type spellings bind as keys only when both sides carry the byte-identical spelling`
  }
  return `${spelled}; the classified families differ and no implicit cross-family key match is performed (a cross-family key is almost certainly a key accident)`
}

/**
 * The shared-column-type-mismatch message: the same shape as
 * {@link keyMismatchMessage} (exact spellings, both families, the policy
 * reason, value-free) for a **compared** non-key column gated by the
 * identical {@link keyTypesCompatible} policy.
 */
function sharedColumnMismatchMessage(column: string, typeA: string, typeB: string): string {
  const familyA = classifyColumnType(typeA)
  const familyB = classifyColumnType(typeB)
  const spelled = `compared column '${column}' has engine type '${typeA}' on side A (family '${familyA}') and '${typeB}' on side B (family '${familyB}')`
  if (familyA === 'json' || familyB === 'json') {
    return `${spelled}; JSON values are refused as compared columns because JSON equality is textual, which would make change detection approximate (the m5-1 unique-rule honesty precedent)`
  }
  if (familyA === 'other' || familyB === 'other') {
    return `${spelled}; nested or unknown type spellings compare only when both sides carry the byte-identical spelling`
  }
  return `${spelled}; the classified families differ and no implicit cross-family comparison is performed (cast or compare the column so both sides share a type family)`
}
