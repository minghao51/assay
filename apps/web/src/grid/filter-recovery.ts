// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * C02 parity (A3) — the copy a failed **panel-local recovery** re-derives.
 *
 * `filter-failure.ts` classifies a failed `setFilters` transaction by its
 * `FilterApplyError.phase`. The `Retry` control is not a transaction at all —
 * it calls the live model's `refresh()` (C01 §7) — so its rejection carries no
 * phase. The state it describes is nevertheless unchanged: the accepted list
 * is still applied and the view still has not been reloaded, which is exactly
 * `FILTER_RELOAD_FAILURE`. Re-running the phase mapping on a phase-less
 * rejection would fall back to the `filter` framing and claim a rollback that
 * did not happen, so the retry keeps its own honest sentence there.
 *
 * A transaction phase, should one ever surface on a recovery path, is still
 * classified by the shared mapping — this adds no phase logic and changes no
 * copy.
 */
import { FILTER_RELOAD_FAILURE, filterFailureCopy, filterFailurePhase } from './filter-failure'
import type { FilterFailureCopy } from './filter-failure'

/** The copy after a `Retry` (`model.refresh()`) attempt fails again. */
export function filterRetryFailureCopy(cause: unknown): FilterFailureCopy {
  return filterFailurePhase(cause) === null ? FILTER_RELOAD_FAILURE : filterFailureCopy(cause)
}
