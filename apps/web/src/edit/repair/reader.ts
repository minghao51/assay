// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * EW-04I — the engine boundary for one repair preview: one complete count scan
 * and one bounded example read, both over the **same immutable snapshot**.
 *
 * Two round-trips, deliberately:
 *
 * 1. `engine/query` carries the composed affected count
 *    (`repairAffectedCountSql`) — a single `count(*)` over the engine-composed
 *    effective relation, so the counts are complete and no row reaches the
 *    host (`preview-sql.ts` explains why the count needs the engine's export
 *    composer rather than the typed count op);
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
 * Privacy (ADR 0025): the composed SQL carries the *plan* (keys, trim set —
 * user-authored local UI content) and no other dataset value; the returned
 * example values stay in this module's caller and are rendered, never logged,
 * never telemetered.
 */
import type { EngineOverlay, EngineRangeResult, EngineTableHandle } from '@assay/engine-duckdb'
import { projectBatchToRows, projectOverlayPage } from '../../grid/provider'
import type { ArrowTableLike } from '../../grid/provider'
import { engineClient } from '../../lib/engine'
import type { RepairPlan } from './plan'
import type { RepairPreviewRead } from './preview'
import {
  REPAIR_EXAMPLE_CAP,
  repairAffectedCountSql,
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
 * Read a single count from a one-row/one-column batch. A response that is not
 * that shape is a protocol deviation, not a zero: refusing loudly beats
 * reporting "0 changed rows" and then refusing the plan for the wrong reason.
 */
export function readCountCell(batch: ArrowTableLike): number {
  const [row] = projectBatchToRows(batch)
  const cell = row?.[0]
  if (typeof cell === 'number' && Number.isFinite(cell)) return cell
  // DuckDB's `count(*)::BIGINT` arrives as a bigint through Arrow.
  if (typeof cell === 'bigint') return Number(cell)
  throw new Error('the affected count came back in an unexpected shape')
}

/**
 * One complete preview read: the counts (one scan + one pure fold) and the
 * bounded examples (one `LIMIT`-ed window over the same relation).
 */
export async function readRepairPreview(
  request: RepairReadRequest,
  plan: RepairPlan,
): Promise<RepairPreviewRead> {
  const { handle, overlay, snapshot } = request
  const filter = repairAffectedFilter(plan)
  const countSql = repairAffectedCountSql(snapshot, plan)
  const [countResult, exampleResult] = await Promise.all([
    engineClient.query(countSql),
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
    affected: readCountCell(countResult.batch),
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
