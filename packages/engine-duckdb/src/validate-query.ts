// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Validation-execution query composition and result reading (m5-2).
 *
 * ## Binding a plan to the effective view
 *
 * The m5-1 plan's SQL references its target relation by a quoted binding
 * name (`FROM "<relation>" AS "src"`, `(SELECT count(*) FROM "<relation>")`)
 * — fixed text that must stay byte-identical for cross-surface agreement
 * (m5-4/m5-6). The engine therefore never rewrites plan SQL: it
 * **materializes the effective view under the plan's own binding name** with
 * {@link composeValidationViewSql}:
 *
 *     CREATE VIEW "<relation>" AS
 *       SELECT *, (row_number() OVER () - 1) AS "assay_overlay_ord"
 *       FROM ( <the m4-2 composed relation, effective order> )
 *
 * The composed relation is `composeSourceSql` with row ids (`assay_row_id`)
 * and the sort key (`assay_key`) included — base branch (tombstones excluded,
 * edit CASEs, casts, renames) UNION ALL one branch per live inserted row.
 * When live inserts exist the inner query is ordered by `assay_key`, which
 * reproduces the domain's `effectiveRowIds` emission order exactly (the
 * pinned m4-2 equivalence); with no inserts the base branch already emits
 * base order. The outer `row_number()` therefore bakes the **effective row
 * index** (0-based position in the effective row list) into
 * `"assay_overlay_ord"` — a composer-reserved name
 * (`RESERVED_OVERLAY_COLUMN_NAMES`), so no legal dataset column can collide
 * with it.
 *
 * The plan's own `assay_row_ordinal` (`row_number() OVER () - 1` over scans
 * of this view) equals the baked index: both derive from the same
 * deterministic effective order (unique `assay_key`s ⇒ total order; the
 * single-threaded natural-order scan guarantee the m4-2 composer already
 * relies on for base ordinals in the wasm bundle). {@link resolveRowKeys}
 * turns sampled ordinals into logical row keys through the baked column, so
 * sample failures carry **row keys, not bare positions** — the m5-1 hand-off
 * agreement (ordinal ⇔ effective row-list index ⇔ the row the grid shows)
 * is pinned end-to-end by the conformance scenario.
 *
 * ## Result contract
 *
 * Per planned rule: `{ ruleId, outcome, failCount, failPercent,
 * sampleFailures }` (m5-4 added `outcome` so the result names its own
 * sanity bound). `failCount` follows the plan's empty-result⇔clean
 * convention (m5-1 plan doc) read from the per-rule query; the summary
 * query is executed too and its counts must agree exactly (integrity pin —
 * the plan contract says the two cannot diverge). `failCount` is bounded by
 * the rule's outcome ({@link validationFailCountExcess} — the m5-4
 * refinement of the m5-2 uniform guard). `failPercent` is the documented
 * integer half-up rounding ({@link failPercentFromCounts}). Samples are
 * bounded by `min(plan K, {@link VALIDATION_SAMPLE_HARD_MAX})` — the
 * executed rule query carries that clamp in its own `LIMIT` (m5-2 round-3
 * fix, see {@link composeValidationRuleQuery}) — and values are normalized
 * to wire-safe JSON ({@link normalizeSampleValue}).
 *
 * Privacy (ADR 0025): offending values are report *content* carried to the
 * host — they are never logged, never telemetried, and never embedded in
 * error messages by this module.
 */
import type { Table } from 'apache-arrow'
import { quotedIdentifier } from './format-view.js'
import {
  OVERLAY_ORDINAL_COLUMN,
  OVERLAY_ROW_ID_COLUMN,
  OVERLAY_SORT_KEY_COLUMN,
  RESERVED_OVERLAY_COLUMN_NAMES,
  composeSourceSql,
} from './overlay-query.js'
import type { OverlayComposition } from './overlay-query.js'
import { VALIDATION_SAMPLE_HARD_MAX } from './validate-plan-wire.js'
import type { EngineValidationSample } from './validate-plan-wire.js'
// Pin the assumption the row-key channel rests on: the column this module
// bakes the effective row index into is the composer's own base-ordinal column
// (`OVERLAY_ORDINAL_COLUMN` — its name's single owner, D04b), which is
// composer-reserved, so no legal dataset column can shadow it (the composer
// rejects such datasets at composition time).
if (!RESERVED_OVERLAY_COLUMN_NAMES.has(OVERLAY_ORDINAL_COLUMN)) {
  throw new Error(
    `${OVERLAY_ORDINAL_COLUMN} is not composer-reserved; the validate view would collide`,
  )
}

/**
 * Engine-side hard max on the rows a rule query may RETURN (the wire
 * accepts any safe-integer K ≥ 1; the executor clamps the executed query to
 * `min(K, this)` — m5-2 round-3 semantics: over-max K is CLAMPED, never
 * rejected). This module's payload-side slice remains as defense-in-depth
 * for the reported list. Re-exported for the executor and pinned consumers.
 */
export { VALIDATION_SAMPLE_HARD_MAX }

/**
 * The validate op's containment transaction (m5-2 fix round, belt 2): the
 * whole operation — binding view materialization, rule queries, row-key
 * resolution, summary — runs between these two statements, and the executor
 * ALWAYS issues the rollback in its cleanup path (DuckDB DDL is
 * transactional, so even a hypothetical static-gate evasion cannot persist
 * a side-effect object). The binding view is additionally dropped inside the
 * transaction (only when this operation created it), so cleanup holds even
 * if the rollback itself were to fail.
 */
export const VALIDATION_BEGIN_SQL = 'BEGIN TRANSACTION'
/** Always paired with {@link VALIDATION_BEGIN_SQL} in the executor's cleanup. */
export const VALIDATION_ROLLBACK_SQL = 'ROLLBACK'

/**
 * `CREATE VIEW` statement materializing the composed effective view under
 * the plan's binding name (see the module doc for the shape and the ordering
 * argument). The composition's reserved-name and type-expression checks run
 * inside `composeSourceSql` before any SQL is built.
 */
export function composeValidationViewSql(
  composition: OverlayComposition,
  viewName: string,
): string {
  const source = composeSourceOrderedSql(composition)
  return (
    `CREATE VIEW ${quotedIdentifier(viewName)} AS SELECT *, ` +
    `(row_number() OVER () - 1) AS ${quotedIdentifier(OVERLAY_ORDINAL_COLUMN)} ` +
    `FROM (${source})`
  )
}

/** The composed relation in effective order (ordered by the key when inserts exist). */
function composeSourceOrderedSql(composition: OverlayComposition): string {
  // Row ids feed the row-key channel; the sort key gives DuckDB the total
  // effective order when live inserts exist (validate-query module doc).
  const source = composeSourceSql(composition, {
    withRowIds: true,
    sanitizeCsv: false,
    withKey: true,
  })
  const hasInserts = [...composition.state.inserts.values()].some((record) => record.live)
  return hasInserts
    ? `SELECT * FROM (${source}) ORDER BY ${quotedIdentifier(OVERLAY_SORT_KEY_COLUMN)}`
    : source
}

/**
 * `DROP VIEW IF EXISTS` for the binding view — the validate op's `finally`
 * cleanup (best-effort: a failed drop must not mask the op's result).
 */
export function composeValidationViewDropSql(viewName: string): string {
  return `DROP VIEW IF EXISTS ${quotedIdentifier(viewName)}`
}

/**
 * Effective row count of the binding view (`count(*)`).
 */
export function composeValidationCountSql(viewName: string): string {
  return `SELECT count(*)::BIGINT AS ${quotedIdentifier('row_count')} FROM ${quotedIdentifier(viewName)}`
}

/**
 * The effective per-rule row bound: `min(plan K, engine hard max)` (m5-2
 * round-3 fix — over-max K plans execute with their returned rows clamped
 * to this bound; the inner query's own violation count is never affected).
 */
export function validationEffectiveSampleLimit(planSampleLimit: number): number {
  return Math.min(planSampleLimit, VALIDATION_SAMPLE_HARD_MAX)
}

/**
 * The engine-clamped execution of one rule query (m5-2 round-3 fix, per the
 * orchestrator adjudication): the plan's EXACT SQL is wrapped ONCE as
 *
 *     SELECT * FROM ( <the exact rule SQL> ) LIMIT <min(K, hard max)>
 *
 * The inner SQL stays byte-identical — the engine never rewrites plan SQL —
 * and the outer `LIMIT` trims only the rows RETURNED to the client. The
 * inner `count(*) OVER ()` still computes the rule's FULL violation count
 * over every violating row, and every returned row carries that full count,
 * so the reported `failCount` is never corrupted by the outer limit.
 * Documented materialization semantics (honest): the window scan itself is
 * inherent to `failCount` and is NOT bounded by the clamp — the clamp
 * bounds the returned rows, the count semantics stay exactly as compiled.
 */
export function composeValidationRuleQuery(ruleSql: string, effectiveLimit: number): string {
  return `SELECT * FROM (${ruleSql}) LIMIT ${effectiveLimit}`
}

/**
 * Row-key resolution for sampled ordinals: one scan of the binding view
 * reading the logical row ids at the baked effective indexes. The caller
 * passes a non-empty, de-duplicated, validated ordinal list (0 ≤ o < rowCount).
 */
export function composeValidationRowKeySql(viewName: string, ordinals: readonly number[]): string {
  return (
    `SELECT ${quotedIdentifier(OVERLAY_ORDINAL_COLUMN)}, ${quotedIdentifier(OVERLAY_ROW_ID_COLUMN)} ` +
    `FROM ${quotedIdentifier(viewName)} ` +
    `WHERE ${quotedIdentifier(OVERLAY_ORDINAL_COLUMN)} IN (${ordinals.join(', ')})`
  )
}

/**
 * `failPercent` — the written m5-2 definition (see
 * `EngineValidationRuleResult`): integer percentage, rounded **half-up**
 * through exact integer arithmetic (`floor((failCount * 200 + rowCount) /
 * (2 * rowCount))`), `0` for an empty dataset. Integer-only on purpose: the
 * formula is byte-portable to the m5-4 CLI executor (no floating-point
 * rounding-mode ambiguity across surfaces). The intermediates are computed
 * in **BigInt** (m5-2 fix round): both inputs may be safe integers while
 * `failCount * 200 + rowCount` is not (for `failCount = 945755921747804`,
 * `rowCount = 9007199254740991` the float formula returned 11 where the
 * exact value is 10 — the float sum rounded across a floor boundary).
 */
export function failPercentFromCounts(failCount: number, rowCount: number): number {
  if (!Number.isSafeInteger(failCount) || failCount < 0) {
    throw new Error('failPercent: failCount must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(rowCount) || rowCount < 0) {
    throw new Error('failPercent: rowCount must be a non-negative safe integer')
  }
  if (rowCount === 0) return 0
  // Exact intermediates: BigInt division truncates toward zero, and both
  // operands are non-negative, so this is exactly the documented floor.
  const scaled = BigInt(failCount) * 200n + BigInt(rowCount)
  return Number(scaled / (2n * BigInt(rowCount)))
}

/**
 * Why a rule's reported `failCount` sits outside its outcome's
 * result-sanity bound (m5-4 refinement of the m5-2 round-3 uniform
 * `failCount ≤ rowCount` guard). The message text is part of the shared
 * seam: both surfaces throw `validation rule '<id>' <excess>` so the typed
 * failure class is byte-identical everywhere.
 */
export type ValidationFailCountExcess =
  | 'reported more failures than rows in the effective view'
  | 'reported more than one failure for a dataset-fact rule'

/**
 * The result-sanity bound for one planned rule's reported `failCount`
 * (m5-4 addendum, refining the m5-2 round-3 uniform `failCount ≤ rowCount`
 * guard): a `row-samples` rule counts violating ROWS, so its count is
 * bounded by the effective row count; a `dataset-fact` rule is a BOOLEAN
 * fact about the whole dataset (row-count bounds, declared-type match,
 * share comparisons — the compiler emits `fail_count` 0 or 1 for these),
 * so it can fail AT MOST ONCE. `dataset.min-rows ≥ 1` over an empty
 * dataset legitimately reports `failCount 1 > rowCount 0` — an honest
 * violation, never a foreign plan. A count past the outcome's bound
 * remains the foreign/non-compiler signal the m5-2 guard exists for: one
 * typed error (this message), never an out-of-contract result. The
 * outcome is the plan's wire string (the boundary parser pinned it to the
 * v1 vocabulary); any other spelling is bounded as `row-samples` (the
 * conservative reading). Returns `null` when the count is in bounds.
 */
export function validationFailCountExcess(
  failCount: number,
  rowCount: number,
  outcome: string,
): ValidationFailCountExcess | null {
  if (outcome === 'dataset-fact') {
    return failCount > 1 ? 'reported more than one failure for a dataset-fact rule' : null
  }
  return failCount > rowCount ? 'reported more failures than rows in the effective view' : null
}

/**
 * One offending value normalized to wire-safe JSON data — the total renderer
 * behind `EngineValidationSample.value`:
 *
 * - `null`/undefined → `null` (a `required` rule's NULL sample);
 * - string / boolean / finite number → verbatim;
 * - `bigint` (64-bit integers through Arrow) → a number when it is a safe
 *   integer, otherwise the exact decimal **text** (never a lossy number);
 * - binary views (`Uint8Array` — BLOB columns) → lowercase hex text
 *   (deterministic, bounded, honest);
 * - objects with a `valueOf` yielding a safe-integer number (Arrow DECIMAL —
 *   DuckDB HUGEINT — exact integer payloads) → that number, deterministically
 *   across query plans;
 * - other objects with a `toString` (scaled DECIMAL text, temporal
 *   renderings) → the rendered text;
 * - anything else (nested Arrow structures — rules never bind nested types,
 *   so this is an engine-deviation signal) fails the op loudly.
 */
export function normalizeSampleValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null
  switch (typeof value) {
    case 'string':
      return value
    case 'boolean':
      return value
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error('validation sample value was not finite')
      }
      return value
    case 'bigint': {
      return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString()
    }
    case 'object': {
      if (value instanceof Uint8Array) {
        let hex = ''
        for (const byte of value) hex += byte.toString(16).padStart(2, '0')
        return hex
      }
      // Nested structures (lists/structs) never reach a rule — rules fail
      // closed on non-scalar families at compile time — so an array here is
      // an engine deviation, not a value to stringify.
      if (Array.isArray(value)) break
      // Exact-integer engine payloads (DuckDB HUGEINT arrives as Arrow
      // decimal128) expose `valueOf`: render as a JS number when the value
      // is a safe integer, so the rendering is deterministic across query
      // plans (empirically the same column could arrive through either the
      // bigint or the decimal path). Beyond the safe range fall back to the
      // exact decimal TEXT — never a lossy number.
      const valueOf = (value as { valueOf?: unknown }).valueOf
      if (typeof valueOf === 'function') {
        const asNumber = (value as unknown as { valueOf: () => unknown }).valueOf()
        if (typeof asNumber === 'number' && Number.isSafeInteger(asNumber)) {
          return asNumber
        }
      }
      const rendered = (value as { toString?: unknown }).toString
      if (typeof rendered === 'function') {
        const text = String(value)
        if (text === '[object Object]') {
          // A default Object rendering means the engine deviated (a nested
          // value reached a rule that cannot bind one) — fail loudly.
          break
        }
        return text
      }
      break
    }
    default:
      break
  }
  throw new Error('validation sample value had an unexpected shape')
}

/** One per-rule query row (row-samples outcome). */
export interface ValidationSampleRow {
  readonly sampleIndex: number
  readonly ordinal: number
  readonly value: WireSampleValue
}

/** A wire-safe sample value (see {@link normalizeSampleValue}). */
export type WireSampleValue = string | number | boolean | null

/** The rows of one per-rule query, read and shape-checked. */
export interface ValidationRuleRows {
  /** The relation count repeated on every row (first row's `total_rows`). */
  readonly totalRows: number | null
  /** The rule's violation count (empty result ⇒ 0, the plan convention). */
  readonly failCount: number
  /** Sample rows (row-samples only; empty for dataset-fact). */
  readonly samples: readonly ValidationSampleRow[]
}

/** BIGINT cell as a safe non-negative integer (engine deviation ⇒ loud failure). */
function readCountCell(table: Table, name: string, row: number): number {
  const vector = table.getChild(name)
  if (vector === null) {
    throw new Error(`validation query result is missing the ${name} column`)
  }
  const raw: unknown = vector.get(row)
  const value = typeof raw === 'bigint' ? Number(raw) : raw
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`validation query result column ${name} had an unexpected shape`)
  }
  return value
}

/**
 * Read one per-rule query result (m5-1 plan contract: `total_rows` /
 * `fail_count` on every row; row-samples adds `sample_index` /
 * `assay_row_ordinal` / `assay_value`; empty result ⇔ clean). The outcome is
 * the plan's wire string (the boundary parser already pinned it to the v1
 * vocabulary); shape deviations are typed engine errors — never silent
 * guesses.
 */
export function readValidationRuleRows(table: Table, outcome: string): ValidationRuleRows {
  if (table.numRows === 0) return { totalRows: null, failCount: 0, samples: [] }
  const totalRows = readCountCell(table, 'total_rows', 0)
  const failCount = readCountCell(table, 'fail_count', 0)
  if (outcome === 'dataset-fact') {
    // One row at most (the plan contract); extra rows mean the executed SQL
    // is not the compiled shape.
    if (table.numRows > 1) {
      throw new Error('dataset-fact rule query returned more than one row')
    }
    return { totalRows, failCount, samples: [] }
  }
  const sampleIndexVector = table.getChild('sample_index')
  const ordinalVector = table.getChild('assay_row_ordinal')
  const valueVector = table.getChild('assay_value')
  if (sampleIndexVector === null || ordinalVector === null || valueVector === null) {
    throw new Error('row-samples rule query result is missing its declared columns')
  }
  const samples: ValidationSampleRow[] = []
  for (let row = 0; row < table.numRows; row++) {
    samples.push({
      sampleIndex: readCountCell(table, 'sample_index', row),
      ordinal: readCountCell(table, 'assay_row_ordinal', row),
      value: normalizeSampleValue(valueVector.get(row)),
    })
  }
  return { totalRows, failCount, samples }
}

/**
 * Read the summary query result: exactly one row per planned rule, in plan
 * order (the plan contract). Returns the `ruleId → failCount` map; a
 * duplicate or non-string `rule_id` fails the op loudly (compiler-shaped
 * summaries cannot produce either).
 */
export function readValidationSummaryRows(table: Table): ReadonlyMap<string, number> {
  const idVector = table.getChild('rule_id')
  if (idVector === null) {
    throw new Error('validation summary result is missing the rule_id column')
  }
  const counts = new Map<string, number>()
  for (let row = 0; row < table.numRows; row++) {
    const rawId: unknown = idVector.get(row)
    if (typeof rawId !== 'string') {
      throw new Error('validation summary rule_id was not text')
    }
    if (counts.has(rawId)) {
      throw new Error(`validation summary reported rule '${rawId}' more than once`)
    }
    counts.set(rawId, readCountCell(table, 'fail_count', row))
  }
  return counts
}

/** Read the composed view's row count (`count(*)`). */
export function readValidationRowCount(table: Table): number {
  if (table.numRows !== 1) {
    throw new Error('validation row-count query returned an unexpected shape')
  }
  return readCountCell(table, 'row_count', 0)
}

/**
 * Read the row-key resolution result into an `ordinal → rowKey` map. Every
 * ordinal must resolve to exactly one non-empty string key (a missing key
 * means the scan order diverged from the baked index — a loud failure, never
 * a position passed off as a key).
 */
export function readValidationRowKeys(table: Table): ReadonlyMap<number, string> {
  const ordinalVector = table.getChild(OVERLAY_ORDINAL_COLUMN)
  const keyVector = table.getChild(OVERLAY_ROW_ID_COLUMN)
  if (ordinalVector === null || keyVector === null) {
    throw new Error('validation row-key query result is missing its declared columns')
  }
  const keys = new Map<number, string>()
  for (let row = 0; row < table.numRows; row++) {
    const rawOrdinal: unknown = ordinalVector.get(row)
    const rawKey: unknown = keyVector.get(row)
    const ordinal = typeof rawOrdinal === 'bigint' ? Number(rawOrdinal) : rawOrdinal
    if (typeof ordinal !== 'number' || !Number.isSafeInteger(ordinal) || ordinal < 0) {
      throw new Error('validation row-key ordinal had an unexpected shape')
    }
    if (typeof rawKey !== 'string' || rawKey === '') {
      throw new Error('validation row key was not resolvable text')
    }
    if (keys.has(ordinal)) {
      throw new Error('validation row-key query resolved an ordinal twice')
    }
    keys.set(ordinal, rawKey)
  }
  return keys
}

/**
 * Clamp one rule's samples to the engine hard max and build the result
 * entries. The executed rule query is already LIMIT-clamped to
 * `min(K, hard max)` (m5-2 round-3 fix), so a sample list longer than the
 * clamp should be impossible — the slice stays as cheap defense-in-depth
 * for the reported payload. Reserved-name hygiene is asserted here too: the
 * row-key channel would be meaningless if a dataset column could shadow
 * `assay_row_id`/`assay_overlay_ord` (the composer already rejects such
 * datasets; this is the cheap defence-in-depth re-check).
 */
export function buildSampleFailures(
  samples: readonly ValidationSampleRow[],
  keys: ReadonlyMap<number, string>,
): readonly EngineValidationSample[] {
  const clamped =
    samples.length > VALIDATION_SAMPLE_HARD_MAX
      ? samples.slice(0, VALIDATION_SAMPLE_HARD_MAX)
      : samples
  return clamped.map((sample) => {
    const rowKey = keys.get(sample.ordinal)
    if (rowKey === undefined) {
      throw new Error('validation sample row key did not resolve')
    }
    return { rowKey, value: sample.value }
  })
}
