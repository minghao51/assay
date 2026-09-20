/**
 * Row-diff execution composition and result reading (m6-2).
 *
 * ## Binding the m6-1 plan to two relations
 *
 * The m6-1 `RowDiffPlan`'s SQL references its two sides by quoted binding
 * names (`FROM "<relationA>" AS "a"`, `FROM "<relationB>" AS "b"`) — fixed
 * text that must stay byte-identical for cross-surface agreement. The
 * engine never rewrites plan SQL: it **materializes** both binding views:
 *
 * - side A is the plan's `relationA`, materialized with
 *   {@link composeValidationViewSql} — the m5-2 composed effective view, in
 *   effective order, with the composer-reserved `assay_overlay_ord` baked in
 *   (that is the A-side ordinal-to-logical-row-key channel);
 * - side B is the plan's `relationB`, materialized as a thin
 *   `SELECT * FROM <staged comparison view>` over the staged scratch view
 *   (never the source path, ADR 0017); the plan's B-side ordinals are
 *   report-only (`b:<ordinal>`).
 *
 * ## Result contract
 *
 * Per aspect, in the compiler's documented order (`added`, `removed`,
 * `changed`): the exact count plus bounded samples. The count comes from the
 * aspect query's own `count(*) OVER ()` window (computed before its LIMIT),
 * and the summary/totals query is executed too — the two must agree exactly
 * (the m6-1 no-divergence invariant, asserted not assumed). Samples are
 * bounded by `min(plan K, {@link ROW_DIFF_SAMPLE_HARD_MAX})` — the executed
 * aspect query carries that clamp in its own outer `LIMIT` (the m5-2
 * `composeValidationRuleQuery` pattern) while the inner SQL stays
 * byte-identical and the inner window still computes the FULL count.
 *
 * ## Result-sanity bounds (the m5-4 analog, made explicit)
 *
 * The plan's keys are user-chosen and may be **non-unique**, and NULL keys
 * group under `IS NOT DISTINCT FROM` (the m6-1 contract: joint uniqueness is
 * explicitly NOT derivable from profiles, and NULL-key rows pair rather than
 * splitting into added + removed). Under that join an A row can pair with
 * several B rows, so the per-aspect counts are bounded by the relations, not
 * by the smaller side:
 *
 * - `added ≤ rowCount(B)` — every added row is a distinct B row;
 * - `removed ≤ rowCount(A)` — every removed row is a distinct A row;
 * - `changed ≤ rowCount(A) × rowCount(B)` — the full outer join emits at
 *   most one row per (A row, B row) pair, however the keys group.
 *
 * These are a **corruption/foreign-signal net, not a semantics claim**: every
 * count a legal m6-1 plan can produce is inside them, and a count outside
 * them cannot be compiler output over any legal key set. The product is
 * compared without ever multiplying past `Number.MAX_SAFE_INTEGER`, so the
 * guard is as total as the counts themselves. One typed error, never an
 * out-of-contract result ({@link rowDiffCountExcess}, the shared seam
 * message). The separate requirement that each per-aspect count equal its
 * totals arm is the independent net for an inflated count that still falls
 * inside a bound.
 *
 * ## Duplicate A-side ordinals are legal
 *
 * With non-unique keys or grouped NULL keys a changed-pair set can carry the
 * same A-side ordinal more than once: a 2×2 NULL-key group surfaces the
 * ordinals `0,0,1,1`, one per pair. Every pair legitimately names its A row
 * and each resolves to the same logical row key, so the changed samples are
 * a set of **pairs**, not a set of distinct A rows — surfaces must present
 * them as such (the ordinals `0,0,1,1` are inherent to the m6-1
 * changed-sample contract, not a defect).
 *
 * Privacy (ADR 0025): sampled row keys and changed-column names are report
 * *content* carried to the host — they are never logged, never telemetried,
 * and never embedded in error messages by this module. The A-side logical
 * key carries the host's base anchor token; it is returned to the host (which
 * owns the token) but never logged here.
 */
import type { Table } from 'apache-arrow'
import { quotedIdentifier } from './format-view'
import {
  composeValidationCountSql,
  composeValidationRowKeySql,
  composeValidationViewDropSql,
  composeValidationViewSql,
  readValidationRowCount,
  readValidationRowKeys,
} from './validate-query'
import { ROW_DIFF_SAMPLE_HARD_MAX } from './diff-plan-wire'
import type { EngineRowDiffAspect, EngineRowDiffSample } from './diff-plan-wire'

export { ROW_DIFF_SAMPLE_HARD_MAX }
export { composeValidationViewSql as composeDiffAViewSql }
export { composeValidationViewDropSql as composeDiffViewDropSql }
export { composeValidationCountSql as composeDiffCountSql }
export { composeValidationRowKeySql as composeDiffARowKeySql }
export { readValidationRowCount as readDiffRowCount }
export { readValidationRowKeys as readDiffARowKeys }
export { composeValidationRowKeySql }

/** The row-diff containment transaction (the m5-2 belt-2 pattern). */
export const ROW_DIFF_BEGIN_SQL = 'BEGIN TRANSACTION'
/** Always paired with {@link ROW_DIFF_BEGIN_SQL} in the executor's cleanup. */
export const ROW_DIFF_ROLLBACK_SQL = 'ROLLBACK'

/** A-side logical row key for a staged (report-only) B-side ordinal. */
export function comparisonRowKey(ordinal: number): string {
  return `b:${String(ordinal)}`
}

/**
 * `CREATE VIEW` binding the plan's side-B name to the staged comparison
 * view: a thin pass-through, so the plan's own `row_number() OVER ()` over
 * this view numbers the staged rows in their natural scan order.
 */
export function composeDiffComparisonViewSql(bindingName: string, stagedViewName: string): string {
  return `CREATE VIEW ${quotedIdentifier(bindingName)} AS SELECT * FROM ${quotedIdentifier(stagedViewName)}`
}

/**
 * The effective per-aspect row bound: `min(plan K, engine hard max)`. The
 * plan's own aspect SQL already carries `LIMIT K`; this outer wrapper bounds
 * the returned rows at the hard max when `K` exceeds it. The inner SQL is
 * byte-identical and the inner `count(*) OVER ()` still reports the full
 * count.
 */
export function diffEffectiveSampleLimit(planSampleLimit: number): number {
  return Math.min(planSampleLimit, ROW_DIFF_SAMPLE_HARD_MAX)
}

/** The engine-clamped execution of one aspect query (exact inner SQL, outer LIMIT). */
export function composeDiffAspectQuery(aspectSql: string, effectiveLimit: number): string {
  if (!Number.isSafeInteger(effectiveLimit) || effectiveLimit < 0) {
    throw new Error('row-diff effective sample limit must be a safe non-negative integer')
  }
  return `SELECT * FROM (${aspectSql}) LIMIT ${String(effectiveLimit)}`
}

/** Why an aspect's reported count sits outside its result-sanity bound. */
export type RowDiffCountExcess =
  | 'reported more added rows than rows in side B'
  | 'reported more removed rows than rows in side A'
  | 'reported more changed rows than (A rows × B rows) pairs can exist'

/**
 * `changed ≤ rowCountA × rowCountB`, evaluated without multiplying past
 * `Number.MAX_SAFE_INTEGER`. When the true product exceeds the safe-integer
 * range every safe `count` is inside it, so the check passes; the zero-row
 * cases are explicit so a nonzero count can never slip through. Both counts
 * are read as safe non-negative integers (`readCountCell`), so the only
 * arithmetic that can overflow is the product — never the comparison.
 */
function changedCountExceedsPairBound(
  count: number,
  rowCountA: number,
  rowCountB: number,
): boolean {
  if (rowCountA === 0 || rowCountB === 0) return count > 0
  if (rowCountA > Math.floor(Number.MAX_SAFE_INTEGER / rowCountB)) return false
  return count > rowCountA * rowCountB
}

/**
 * The result-sanity bound for one aspect's reported count (see the module
 * doc). Returns `null` when the count is in bounds. The bounds are a
 * corruption/foreign-signal net (every legal m6-1 plan is inside them, with
 * non-unique and NULL-grouped keys included), not a claim that the plan
 * semantics force uniqueness.
 */
export function rowDiffCountExcess(
  aspect: EngineRowDiffAspect,
  count: number,
  rowCountA: number,
  rowCountB: number,
): RowDiffCountExcess | null {
  if (aspect === 'added') {
    return count > rowCountB ? 'reported more added rows than rows in side B' : null
  }
  if (aspect === 'removed') {
    return count > rowCountA ? 'reported more removed rows than rows in side A' : null
  }
  return changedCountExceedsPairBound(count, rowCountA, rowCountB)
    ? 'reported more changed rows than (A rows × B rows) pairs can exist'
    : null
}

/** One raw sample row read from an aspect query (before key resolution). */
export interface RowDiffSampleRow {
  readonly side: 'A' | 'B'
  readonly ordinal: number
  readonly changedColumns: readonly string[] | null
}

/** The rows of one aspect query, read and shape-checked. */
export interface RowDiffAspectRows {
  /** The aspect's exact count (empty result ⇒ 0, the plan convention). */
  readonly count: number
  readonly rows: readonly RowDiffSampleRow[]
}

/** BIGINT cell as a safe non-negative integer (engine deviation ⇒ loud failure). */
function readCountCell(table: Table, name: string, row: number): number {
  const vector = table.getChild(name)
  if (vector === null) {
    throw new Error(`row-diff query result is missing the ${name} column`)
  }
  const raw: unknown = vector.get(row)
  const value = typeof raw === 'bigint' ? Number(raw) : raw
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`row-diff query result column ${name} had an unexpected shape`)
  }
  return value
}

/** A text cell (engine deviation ⇒ loud failure). */
function readTextCell(table: Table, name: string, row: number): string {
  const vector = table.getChild(name)
  if (vector === null) {
    throw new Error(`row-diff query result is missing the ${name} column`)
  }
  const value: unknown = vector.get(row)
  if (typeof value !== 'string') {
    throw new Error(`row-diff query result column ${name} was not text`)
  }
  return value
}

/** A VARCHAR-list cell (Arrow list/fixed-size-list) as text values. */
function readStringListCell(table: Table, name: string, row: number): readonly string[] {
  const vector = table.getChild(name)
  if (vector === null) {
    throw new Error(`row-diff query result is missing the ${name} column`)
  }
  const value: unknown = vector.get(row)
  if (value === null || value === undefined) return []
  let entries: readonly unknown[]
  if (Array.isArray(value)) {
    entries = value
  } else if (typeof (value as { toArray?: unknown }).toArray === 'function') {
    entries = (value as { toArray: () => unknown[] }).toArray()
  } else if (typeof (value as Iterable<unknown>)[Symbol.iterator] === 'function') {
    entries = Array.from(value as Iterable<unknown>)
  } else {
    throw new Error(`row-diff query result column ${name} had an unexpected shape`)
  }
  const out: string[] = []
  for (const entry of entries) {
    if (typeof entry !== 'string') {
      throw new Error(`row-diff changed-column list carried a non-text entry`)
    }
    out.push(entry)
  }
  return out
}

/**
 * Read one aspect query's result. The expected side is fixed by the aspect
 * (added → B, removed/changed → A); a mismatched `assay_side` cell, a
 * non-integral ordinal, or an inconsistent `assay_count` is an engine
 * deviation and fails the op loudly.
 */
export function readDiffAspectRows(table: Table, aspect: EngineRowDiffAspect): RowDiffAspectRows {
  if (table.numRows === 0) return { count: 0, rows: [] }
  const expectedSide: 'A' | 'B' = aspect === 'added' ? 'B' : 'A'
  const count = readCountCell(table, 'assay_count', 0)
  const rows: RowDiffSampleRow[] = []
  for (let row = 0; row < table.numRows; row++) {
    if (readCountCell(table, 'assay_count', row) !== count) {
      throw new Error('row-diff aspect query reported inconsistent counts')
    }
    const side = readTextCell(table, 'assay_side', row)
    if (side !== expectedSide) {
      throw new Error(`row-diff ${aspect} query reported an unexpected side`)
    }
    const ordinal = readCountCell(table, 'assay_row_ordinal', row)
    const changedColumns =
      aspect === 'changed' ? readStringListCell(table, 'assay_changed', row) : null
    rows.push({ side: expectedSide, ordinal, changedColumns })
  }
  // Deterministic presentation: the plan's own LIMIT selects the sample SET
  // (in whatever order the engine's join emitted it — DuckDB's anti-join can
  // reorder), and the engine presents that set in ascending ordinal order so
  // the reported samples are engine-version-independent and cross-surface
  // (m6-5) byte-stable. The plan SQL is untouched; only the returned order is
  // normalized. The sort is stable (ES2019+), so equal ordinals — legal for
  // non-unique keys and grouped NULL keys (see the module doc) — keep the
  // plan's emitted relative order.
  rows.sort((a, b) => a.ordinal - b.ordinal)
  return { count, rows }
}

/**
 * Read the totals query into an `aspect → count` map. Exactly three rows in
 * the compiler's aspect order (arm order is canonical; no ORDER BY), each
 * aspect once — anything else is not compiler output.
 */
export function readDiffTotalsRows(table: Table): ReadonlyMap<EngineRowDiffAspect, number> {
  const counts = new Map<EngineRowDiffAspect, number>()
  for (let row = 0; row < table.numRows; row++) {
    const aspect = readTextCell(table, 'assay_aspect', row)
    if (aspect !== 'added' && aspect !== 'removed' && aspect !== 'changed') {
      throw new Error('row-diff totals query reported an unknown aspect')
    }
    if (counts.has(aspect)) {
      throw new Error('row-diff totals query reported an aspect more than once')
    }
    counts.set(aspect, readCountCell(table, 'assay_count', row))
  }
  if (counts.size !== 3) {
    throw new Error('row-diff totals query did not report exactly one row per aspect')
  }
  return counts
}

/**
 * Turn one aspect's raw rows into wire samples: A-side ordinals resolve
 * through the effective view's baked ordinal to logical row keys (loud
 * failure on an unresolved ordinal — never a positional fake); B-side
 * ordinals become the documented report-only `b:<ordinal>` key.
 */
export function buildDiffAspectSamples(
  rows: readonly RowDiffSampleRow[],
  aspect: EngineRowDiffAspect,
  aKeys: ReadonlyMap<number, string>,
): readonly EngineRowDiffSample[] {
  return rows.map((row) => {
    if (row.side === 'A') {
      const rowKey = aKeys.get(row.ordinal)
      if (rowKey === undefined) {
        throw new Error('row-diff sample row key did not resolve')
      }
      return aspect === 'changed'
        ? { side: 'A', rowKey, changedColumns: row.changedColumns ?? [] }
        : { side: 'A', rowKey }
    }
    return aspect === 'changed'
      ? {
          side: 'B',
          rowKey: comparisonRowKey(row.ordinal),
          changedColumns: row.changedColumns ?? [],
        }
      : { side: 'B', rowKey: comparisonRowKey(row.ordinal) }
  })
}
