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
 * is pinned against the applied effect by a real-engine test
 * (`preview-sql.engine.test.ts`): for every plan shape the fold accepts, the
 * predicate's count equals the number of rows the engine's own composed wrap
 * actually changes.
 *
 * ## The predicate: affected ⟺ the repaired value differs from the value now
 *
 * With `t = trim_t(v)` (the plan's explicit trim set applied to `v`; `t = v`
 * when the plan declares no trim), `M` the plan's mapping and `v` the
 * effective value:
 *
 * ```text
 * repaired(v) = M[t] ?? t                          (NULL never matches, never produced)
 * affected(v) ⟺ v IS NOT NULL
 *             ∧ ¬( t ∈ keys(M) ∧ M[t] = v )        (A: the plan maps the trimmed value back to v)
 *             ∧ ¬( t ∉ keys(M) ∧ t = v )           (B: nothing happens — no mapping, no trim)
 * ```
 *
 * Both negated terms are **set membership**, not a copy of the composer's CASE
 * chain (ADR 0051 rule 3 / probe §9: never duplicate or re-nest the wrap):
 *
 * - **A** says "the pair `(t, v)` is not in the plan's pair set", composed as
 *   `(t, v) NOT IN (VALUES (k, M[k]), …)`. It is required because a trim and a
 *   mapping can **cancel**: with `trim = ' '` and `M = {a → ' a '}`, the value
 *   `' a '` trims to `a` and maps straight back to `' a '` — the repair changes
 *   nothing, so the row is NOT affected. Without A the preview over-counts
 *   exactly those rows, which is how a no-op plan could pass U1 and append an
 *   empty history entry (regression: fix round 1).
 * - **B** says "a value that misses the mapping is not already its own trimmed
 *   form", composed as `(t IN (keys) OR t <> v)`. It is required because
 *   trimming alone changes the value only when `t <> v`, and a mapped value
 *   changes it even when the trim was a no-op.
 *
 * Two points about this predicate's shape — the first correcting the earlier
 * revision of this comment, the second recording why one set is used:
 *
 * 1. **The mapping targets now enter the SQL** — term A needs the pair set,
 *    not only the keys. That is acceptable and not a privacy change: mapping
 *    keys and targets are user-authored plan configuration (the composer
 *    already emits both at publication), never dataset content copied out of
 *    the relation, and nothing here logs or transmits them.
 * 2. **Term B lists ALL keys, not the earlier `liveKeys` subset.** That subset
 *    ("keys whose target differs from the key") would in fact be *equivalent*
 *    here, not wrong: the two sets disagree only on identity pairs
 *    (`M[t] = t`), and for those `t = v` forces `M[v] = v`, so term A is
 *    already false whichever set term B uses. The predicate lists all keys
 *    because that is the simpler and more obviously complete form — one key
 *    set, no second derivation that could drift out of step with the pair set
 *    — not because the subset would be incorrect. (For `' a '` with
 *    `M = {a → a}` it is the `t <> v` disjunct that fires, and it fires for
 *    either key set.)
 *
 * The target side is applied by the engine when the repair is published, and
 * shown in the examples through the domain's own `trimWithCodePoints` (the
 * function the composer's D17 literal rewrite shares, so TypeScript and SQL
 * cannot drift).
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
 * The plan's pairs, sorted by key so the composed SQL is deterministic (the
 * draft's line order is not part of the plan's meaning — `repairPlanFingerprint`
 * treats the mapping as a set for the same reason).
 */
export function planPairs(plan: RepairPlan): readonly (readonly [string, string])[] {
  return [...plan.mapping].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
}

/** One string as a SQL string literal, via the engine's own escaper. */
function stringLiteral(value: string): string {
  return cellLiteralRawSql({ kind: 'string', value: value })
}

/**
 * The plan's affected-row predicate, in the engine's filter grammar: a
 * fragment that follows `"<column>"` inside `whereClauseSql`'s parentheses
 * (`("col" <predicate>)`). It therefore begins with `IS NOT NULL AND`, which
 * states the repair's NULL rule outright (NULL never matches and is never
 * produced) and cannot change precedence for the terms after it.
 *
 * The two negated set-membership terms are derived and explained in the module
 * doc; their exactness over every plan shape the fold accepts is pinned by
 * `preview-sql.engine.test.ts` against the engine's own composed wrap.
 */
export function repairAffectedPredicate(plan: RepairPlan): string {
  const value = quotedIdentifier(plan.column)
  // `t`: the trimmed value the mapping is matched against (the raw value when
  // the plan declares no trim). One `trim(col, set)` occurrence, the same
  // construct the composer emits (never `String.prototype.trim()`).
  const trimmed = plan.trim === undefined ? value : `trim(${value}, ${stringLiteral(plan.trim)})`
  const pairs = planPairs(plan)
  const terms: string[] = []
  if (pairs.length === 0) {
    // Trim-only plan: the trim is the only thing that can change a value.
    terms.push(`${trimmed} <> ${value}`)
  } else {
    const pairSet = pairs
      .map(([key, target]) => `(${stringLiteral(key)}, ${stringLiteral(target)})`)
      .join(', ')
    // (A) The pair (t, v) is NOT in the plan's pair set: trim and mapping do
    // not cancel. Row-value membership, so the pair set is compared as a set.
    terms.push(`(${trimmed}, ${value}) NOT IN (VALUES ${pairSet})`)
    // (B) The trimmed value is a mapping key, or the trim changed the value.
    const keys = pairs.map(([key]) => stringLiteral(key)).join(', ')
    terms.push(`(${trimmed} IN (${keys}) OR ${trimmed} <> ${value})`)
  }
  return `IS NOT NULL AND ${terms.join(' AND ')}`
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
