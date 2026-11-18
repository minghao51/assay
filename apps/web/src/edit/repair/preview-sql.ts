// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * EW-04I — the two engine reads behind a repair preview, and the composition
 * that makes them exact.
 *
 * ## What has to be asked, and why it must be asked engine-side
 *
 * EW-04D §3 fixes the preview's shape: **complete** `scanned / affected /
 * unaffected` counts from one pass, plus `≤10` before/after examples by
 * `LIMIT`. Both are value-level questions over the *whole effective relation*,
 * so neither may be answered by materializing rows in the host (no full-row
 * materialization, no per-cell JS loop) — they are one `count(*)` scan and one
 * bounded `LIMIT` read, both evaluated by the engine.
 *
 * ## Why the affected count is composed here
 *
 * The engine's typed count op (`overlay-row-count`) composes the effective
 * *union* without the repair wrap on purpose: "values don't affect counts"
 * (D16/D17 composition probe §4.2). That is right for a row count and wrong
 * for *this* question — the affected set is defined by effective **values**,
 * and on a column that already carries a repair the typed count would evaluate
 * pre-repair values (`composeOverlayCountSql` → `composeSourceSql`). The
 * repair wrap is composed by the **window** and **export** paths only
 * (`composeEffectiveSourceSql`), so this module reuses the engine's own
 * exported export-SELECT composer (`composeOverlayExportSelectSql`) as the
 * relation and counts under the plan's predicate —
 * `SELECT count(*) FROM (<engine's effective relation>) WHERE (<predicate>)`.
 *
 * Nothing about the wrap is re-derived: the composition, the literals and the
 * predicate's quoting all come from the engine's exports
 * (`composeOverlayExportSelectSql`, `cellLiteralRawSql`, `quotedIdentifier`,
 * `whereClauseSql`) — the same reuse the SQL pane's nested composers already
 * perform (m3-4). The only new expression is the **predicate** below, and it
 * is pinned against the applied effect by real-engine tests (`repair-reader`):
 * a plan applied to the same snapshot changes exactly `affected` rows.
 *
 * ## The predicate: affected ⟺ the repaired value differs from the value now
 *
 * With `t` the plan's explicit trim set, `M` its mapping and `v` the effective
 * value:
 *
 * ```text
 * repaired(v) = M[trim_t(v)] ?? trim_t(v)          (NULL never matches, never produced)
 * affected(v) = v IS NOT NULL AND (trim_t(v) <> v OR trim_t(v) ∈ liveKeys)
 * liveKeys    = { k ∈ keys(M) : M[k] ≠ k }        (identity pairs change nothing)
 * ```
 *
 * Two things make this a *set-membership* predicate rather than a copy of the
 * composer's CASE: the mapping is exact whole-value equality (D3 — binary, no
 * folding), so "the mapping applies" is membership, and the mapped **target
 * never enters SQL** — only keys do, because the question is "does it change",
 * not "to what". The target side is applied by the engine when the repair is
 * published, and shown in the examples through the domain's own
 * `trimWithCodePoints` (the function the composer's D17 literal rewrite
 * shares, so TypeScript and SQL cannot drift).
 *
 * `affected = 0` is a *complete* answer, which is what makes the zero-affected
 * refusal (U1) honest.
 */
import type { EngineFilterSpec, OverlayComposition } from '@assay/engine-duckdb'
import {
  MAX_REPAIR_EXPORT_CELL_WORK,
  cellLiteralRawSql,
  composeOverlayExportSelectSql,
  quotedIdentifier,
  whereClauseSql,
} from '@assay/engine-duckdb'
import { liveRowCount, trimWithCodePoints } from '@assay/domain'
import type { OverlayBase, OverlayState } from '@assay/domain'
import { MAX_REPAIR_PREVIEW_EXAMPLES, type RepairPlan } from './plan'

/** The snapshot one preview read is answered from (immutable for the read). */
export interface RepairReadSnapshot {
  readonly viewName: string
  readonly base: OverlayBase
  readonly state: OverlayState
}

/**
 * The keys whose mapping target differs from the key — the only keys that can
 * change a value. Identity pairs are dropped here (a pair that maps a value to
 * itself changes nothing; a row whose *trim* changes is caught by the trim
 * term, and its trimmed form is exactly such a key).
 */
export function liveMappingKeys(plan: RepairPlan): string[] {
  const live: string[] = []
  for (const [key, target] of plan.mapping) {
    if (key !== target) live.push(key)
  }
  return live.sort()
}

/** One mapping key as a SQL string literal, via the engine's own escaper. */
function keyLiteral(key: string): string {
  return cellLiteralRawSql({ kind: 'string', value: key })
}

/**
 * The plan's affected-row predicate, in the engine's filter grammar: a
 * fragment that follows `"<column>"` inside `whereClauseSql`'s parentheses
 * (`("col" <predicate>)`). It therefore begins with `IS NOT NULL AND`, which
 * states the repair's NULL rule outright (NULL never matches and is never
 * produced) and cannot change precedence for the terms after it.
 */
export function repairAffectedPredicate(plan: RepairPlan): string {
  const column = quotedIdentifier(plan.column)
  const operand =
    plan.trim === undefined
      ? column
      : `trim(${column}, ${cellLiteralRawSql({ kind: 'string', value: plan.trim })})`
  const liveKeys = liveMappingKeys(plan)
  const mappingChanges =
    liveKeys.length === 0 ? 'FALSE' : `${operand} IN (${liveKeys.map(keyLiteral).join(', ')})`
  const trimmed = plan.trim === undefined ? null : `${operand} <> ${column}`
  const changes = trimmed === null ? mappingChanges : `(${trimmed} OR ${mappingChanges})`
  return `IS NOT NULL AND ${changes}`
}

/** The predicate as the engine's filter spec (one AND-ed clause). */
export function repairAffectedFilter(plan: RepairPlan): EngineFilterSpec {
  return { column: plan.column, predicate: repairAffectedPredicate(plan) }
}

/**
 * The complete affected count over the effective relation. Format `parquet` is
 * not cosmetic: the CSV formula guard rewrites projected values, so counting
 * under it would compare sanitized text against the plan. Every non-CSV format
 * composes the identical relation.
 */
export function repairAffectedCountSql(snapshot: RepairReadSnapshot, plan: RepairPlan): string {
  const composition: OverlayComposition = {
    viewName: snapshot.viewName,
    base: snapshot.base,
    state: snapshot.state,
  }
  const relation = composeOverlayExportSelectSql(composition, 'parquet')
  const where = whereClauseSql([repairAffectedFilter(plan)])
  if (where === null) throw new Error('a repair predicate is always present')
  return `SELECT count(*)::BIGINT AS affected FROM (${relation}) WHERE ${where}`
}

/**
 * The example read's window: `LIMIT` {@link MAX_REPAIR_PREVIEW_EXAMPLES}, no
 * sort (effective order), the target column plus the logical row id. Never a
 * matching-row array: the `LIMIT` is what bounds it, and the surface states the
 * cap against the complete count.
 */
export const REPAIR_EXAMPLE_CAP = MAX_REPAIR_PREVIEW_EXAMPLES

/** The scanned side of the counts: the effective live row count (pure fold). */
export function repairScannedRows(base: OverlayBase, state: OverlayState): number {
  return liveRowCount(base, state)
}

/** The published envelope this module's refused-at-preview cost line uses. */
export const REPAIR_ENVELOPE = MAX_REPAIR_EXPORT_CELL_WORK

/**
 * The repaired value for one example, computed the way the composer's D17
 * literal rewrite computes it (`trimWithCodePoints`, then the mapping) — the
 * shared domain function, never `String.prototype.trim()`.
 */
export function repairedValue(value: string, plan: RepairPlan): string {
  const trimmed = plan.trim === undefined ? value : trimWithCodePoints(value, plan.trim)
  return plan.mapping.get(trimmed) ?? trimmed
}
