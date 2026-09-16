/**
 * SQL composition for dataset profiles (m2-5) — sibling of `window-query.ts`
 * and bound by the same invariants: only engine-generated view names and
 * quoted identifiers enter the SQL; the composer is pure and unit-pinned.
 *
 * Query plan per `engine/profile` call (documented scan budget):
 *
 * 1. `DESCRIBE <view>` — metadata only, no data scan.
 * 2. ONE combined aggregate query (`composeProfileBaseSql`) over the view —
 *    a single scan computing, for every column, the non-null count and
 *    `count(DISTINCT)`, and for numeric columns additionally min/max/mean/
 *    stddev and the p50/p90/p95/p99 quantiles. Quantiles use the LIST form
 *    `quantile_cont(col, [0.5,0.9,0.95,0.99])`: ONE aggregate per column, so
 *    DuckDB keeps ONE values buffer per numeric column instead of four —
 *    half the peak-memory story of profiling is quantile state, and this is
 *    the cheap form of it.
 * 3. One top-k query per categorical column (`composeProfileTopKSql`) — a
 *    grouped scan whose projection pushdown reads only that one column.
 *
 * Total: `1 + (#categorical columns)` data scans; every scan is over the
 * registered view only. Numbers interpolated into SQL (quantile positions,
 * top-k limit) are composer-owned constants — never user input.
 */
import { quotedIdentifier } from './format-view'
import type { EngineProfileColumnKind } from './protocol'

/** How many top-k values a categorical column reports (documented k). */
export const PROFILE_TOP_K = 10

/** The quantile positions a numeric column reports (fixed M2 contract set). */
export const PROFILE_QUANTILE_POSITIONS = [0.5, 0.9, 0.95, 0.99] as const

/** One column to profile: its name and the classifier's kind decision. */
export interface ProfileColumnSpec {
  readonly name: string
  readonly kind: EngineProfileColumnKind
}

/**
 * Slot offsets *within one column's block* of the combined base query.
 * Plain columns use nonNull/distinct (block width 2); numeric columns use
 * all seven (block width 7) — `quantiles` is a single DOUBLE[4] slot (the
 * LIST form above), read as four positions by the executor.
 */
export const PROFILE_BASE_SLOT = {
  nonNull: 0,
  distinct: 1,
  min: 2,
  max: 3,
  mean: 4,
  stddev: 5,
  quantiles: 6,
} as const

const PLAIN_BLOCK_WIDTH = 2
const NUMERIC_BLOCK_WIDTH = 7

export interface ProfileBaseQueryPlan {
  readonly sql: string
  /**
   * Start offset of each column's slot block in the result row, in spec
   * order — the composer is the single source of truth for the layout, so
   * the executor can never drift from the SQL it runs.
   */
  readonly offsets: readonly number[]
}

/**
 * The combined single-scan aggregate query:
 *
 * ```sql
 * SELECT count(*)::BIGINT AS "c0",
 *        count("a")::BIGINT AS "c1", count(DISTINCT "a")::BIGINT AS "c2",
 *        min("b")::DOUBLE AS "c3", …, quantile_cont("b", [0.5,0.9,0.95,0.99])::DOUBLE[] AS "c9"
 * FROM <view>
 * ```
 *
 * Output aliases are composer-owned positional names (`"c0"`, `"c1"`, …) —
 * they can never collide with dataset column names and are read
 * positionally anyway. All numeric stats are cast to DOUBLE so the result
 * row is uniformly finite JS numbers (DECIMAL/BIGINT aggregates included);
 * a lossy cast above 2^53 is acceptable and documented — mean/stddev/
 * quantiles are double-precision computations in the engine anyway.
 */
export function composeProfileBaseSql(query: {
  viewName: string
  columns: readonly ProfileColumnSpec[]
}): ProfileBaseQueryPlan {
  const slots: string[] = ['count(*)::BIGINT AS "c0"']
  const offsets: number[] = []
  let next = 1 // slot 0 is the row count
  for (const column of query.columns) {
    const id = quotedIdentifier(column.name)
    offsets.push(next)
    slots.push(`count(${id})::BIGINT AS "c${String(next)}"`)
    slots.push(`count(DISTINCT ${id})::BIGINT AS "c${String(next + 1)}"`)
    if (column.kind === 'numeric') {
      slots.push(`min(${id})::DOUBLE AS "c${String(next + 2)}"`)
      slots.push(`max(${id})::DOUBLE AS "c${String(next + 3)}"`)
      slots.push(`avg(${id})::DOUBLE AS "c${String(next + 4)}"`)
      slots.push(`stddev_samp(${id})::DOUBLE AS "c${String(next + 5)}"`)
      const positions = PROFILE_QUANTILE_POSITIONS.map((position) => String(position)).join(',')
      slots.push(`quantile_cont(${id}, [${positions}])::DOUBLE[] AS "c${String(next + 6)}"`)
      next += NUMERIC_BLOCK_WIDTH
    } else {
      next += PLAIN_BLOCK_WIDTH
    }
  }
  return {
    sql: `SELECT ${slots.join(', ')} FROM ${quotedIdentifier(query.viewName)}`,
    offsets,
  }
}

/**
 * One categorical column's top-k:
 *
 * ```sql
 * SELECT CAST("col" AS VARCHAR) AS "v", count(*)::BIGINT AS "n"
 * FROM <view> WHERE "col" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 ASC LIMIT 10
 * ```
 *
 * NULL handling (documented m2-5 decision): NULLs are **excluded** from
 * top-k values (`nullCount` already reports them); the tie behavior is count
 * descending, then value ascending on the rendered text — deterministic
 * across runs and fixtures. `value`/`v` are reserved-word risks in DuckDB,
 * so aliases are double-quoted; `GROUP BY 1`/`ORDER BY 2, 1` are positional.
 * `k` defaults to `PROFILE_TOP_K` and must be a positive safe integer
 * (composer-owned constant; interpolated verbatim).
 */
export function composeProfileTopKSql(query: {
  viewName: string
  column: string
  k?: number
}): string {
  const k = query.k ?? PROFILE_TOP_K
  if (!Number.isSafeInteger(k) || k <= 0) {
    throw new Error(`profile top-k must be a positive integer, got ${String(k)}`)
  }
  const id = quotedIdentifier(query.column)
  return (
    `SELECT CAST(${id} AS VARCHAR) AS "v", count(*)::BIGINT AS "n" ` +
    `FROM ${quotedIdentifier(query.viewName)} ` +
    `WHERE ${id} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 ASC LIMIT ${String(k)}`
  )
}
