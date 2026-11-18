// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * EW-04I — the published export envelope, refused **pre-apply** (post-R1
 * acceptance D4 option (a); EW-04D §4.4; U4's measurement).
 *
 * The engine publishes `MAX_REPAIR_EXPORT_CELL_WORK` (1e9 cell rewrites) and
 * refuses an export/full scan above it (`OverlayRepairExportBudgetError`,
 * composed in `assertRepairExportBudget`). D4 asks for that refusal to be
 * **surfaced before anything runs**, not after a failed export — so this module
 * projects the same quantity the engine will: `rows × pairs` over the whole
 * effective relation, where
 *
 * - `rows` is the effective live row count (base rows − tombstones + live
 *   inserts) — the composer's own branch count, i.e. the rows an export
 *   actually evaluates (`liveRowCount` in `@assay/domain`; the engine's
 *   `assertRepairExportBudget` computes the identical quantity),
 * - `pairs` is the **total** mapping pairs of the repair prefix *including* the
 *   plan about to be applied — the engine sums `state.repairs[k].mapping.size`,
 *   so a projection that counted only the new plan would under-report exactly
 *   when a session has several repairs.
 *
 * The preview is itself a full-column read with the plan's predicate, so the
 * same cost line applies to it: the refusal runs **before the preview read**,
 * which is why the copy says nothing was previewed or applied.
 *
 * No interrupt is claimed or performed: nothing cancels a composed query
 * (EW-04D §7). Purity: arithmetic only.
 */
import { MAX_REPAIR_EXPORT_CELL_WORK } from '@assay/engine-duckdb'
import { repairBudgetRefusal } from './copy'

/** The engine's published envelope, re-exported so the surface states its own bound. */
export const REPAIR_EXPORT_CELL_WORK_ENVELOPE = MAX_REPAIR_EXPORT_CELL_WORK

/** The projected cell work of one plan over `rows`: `rows × pairs`. */
export function projectedRepairCellWork(rows: number, pairs: number): number {
  return rows * pairs
}

/**
 * The pre-apply refusal sentence, or `null` when the projection fits the
 * published envelope. `prefixPairs` is the pair count already in the active
 * repair chain (the engine sums the whole prefix), `planPairs` the plan's own.
 */
export function repairBudgetRefusalFor(
  rows: number,
  prefixPairs: number,
  planPairs: number,
): string | null {
  const pairs = prefixPairs + planPairs
  if (pairs === 0) return null
  const work = projectedRepairCellWork(rows, pairs)
  if (work <= REPAIR_EXPORT_CELL_WORK_ENVELOPE) return null
  return repairBudgetRefusal(rows, pairs, REPAIR_EXPORT_CELL_WORK_ENVELOPE)
}
