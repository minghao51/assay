// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * EW-04I — the engine boundary for one repair preview: one complete count scan
 * and one bounded example read, both over the **same immutable snapshot**.
 *
 * Two round-trips, deliberately:
 *
 * 1. `engine/repair-preview-count` (`repairPreviewCount`, B1/ENG-2) carries the
 *    affected count: the engine composes the `count(*)` under the plan's own
 *    affected predicate over the composed effective relation, so the
 *    definition of "affected" is engine-owned and cannot drift from the
 *    example set (both use `repairAffectedPredicate`);
 * 2. `overlay-range` (`fetchOverlayRange`) carries the `≤10` examples with
 *    their logical row ids — the typed op, so the window validation/clamping
 *    and the row-id projection stay the engine's.
 *
 * Both are composed from the snapshot passed in (base + the active ops at the
 * cursor), which is a pure value: the two answers therefore describe one
 * relation by construction, and a session change between them is impossible
 * to observe (the SQL is already composed). They run concurrently because the
 * worker has separate query/registry lanes (m2-7) and each answer is
 * self-contained; neither result is asserted to arrive first (U3 — the
 * surface's generation guard is what orders them, see `useRepairPreview`).
 *
 * The `scanned` side needs no engine call at all: it is the domain's
 * `liveRowCount` over the same snapshot — the exact quantity the engine's
 * unfiltered `overlay-row-count` composes ("base rows minus tombstones plus
 * live inserts"), so the preview cannot disagree with a separate count.
 *
 * Privacy (ADR 0025): the request carries the *plan* (keys, targets, trim set —
 * user-authored local UI content) and no other dataset value; the returned
 * example values stay in this module's caller and are rendered, never logged,
 * never telemetered.
 */
import type { EngineOverlay, EngineRangeResult, EngineTableHandle } from '@assay/engine-duckdb'
import { projectOverlayPage } from '../../grid/provider'
import { engineClient } from '../../lib/engine'
import type { RepairPlan } from './plan'
import type { RepairPreviewRead } from './preview'
import {
  REPAIR_EXAMPLE_CAP,
  repairAffectedEnginePlan,
  repairAffectedFilter,
  repairScannedRows,
  type RepairReadSnapshot,
} from './preview-sql'

/** Everything one preview read needs from the live session (one snapshot). */
export interface RepairReadRequest {
  readonly handle: EngineTableHandle
  readonly overlay: EngineOverlay
  readonly snapshot: RepairReadSnapshot
}

/**
 * One complete preview read: the counts (one typed count op + one pure fold)
 * and the bounded examples (one `LIMIT`-ed window over the same relation).
 */
export async function readRepairPreview(
  request: RepairReadRequest,
  plan: RepairPlan,
): Promise<RepairPreviewRead> {
  const { handle, overlay, snapshot } = request
  const filter = repairAffectedFilter(plan)
  // The count is the typed op, not a host-composed statement through
  // `engine/query`: the affected definition is the engine's (B1/ENG-2), and a
  // test asserts the request type rather than a generic-query argument.
  const [affected, exampleResult] = await Promise.all([
    engineClient.repairPreviewCount(handle, overlay, repairAffectedEnginePlan(plan)),
    engineClient.fetchOverlayRange(handle, overlay, {
      startRow: 0,
      endRow: REPAIR_EXAMPLE_CAP,
      columns: [plan.column],
      filters: [filter],
      includeRowIds: true,
    }),
  ])
  return {
    scanned: repairScannedRows(snapshot.base, snapshot.state),
    affected,
    exampleRows: exampleRows(exampleResult),
    exampleCap: REPAIR_EXAMPLE_CAP,
  }
}

/**
 * Project the bounded window: `projectOverlayPage` strips the engine's leading
 * `assay_row_id` column and returns the parallel ids, so a row id can never be
 * silently paired with another row's value.
 */
function exampleRows(
  result: EngineRangeResult,
): readonly { readonly rowId: string; readonly value: unknown }[] {
  const { rows, rowKeys } = projectOverlayPage(result.batch)
  return rowKeys.map((rowId, index) => ({ rowId, value: rows[index]?.[0] ?? null }))
}
