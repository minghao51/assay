// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * C02b — the one mapping from a failed `setFilters` outcome to user-visible
 * copy, shared by every web caller (`FilterBar.applyList`,
 * `App.applyProfileFilter`, `useValidationSession.handleFilterToFailures`).
 *
 * The model owns the transaction **and** the restoration (`FilterApplyError`,
 * C01 §5.2/§7): callers no longer issue a compensating `setFilters(previous)`.
 * "The promise rejected" does not mean "nothing changed", so the copy is
 * derived from the value-free `phase` — never from the error text and never
 * from `model.reloadError` (diagnostics only, C01 §10 decision 4):
 *
 * - `refused-before-change` — the provider refused the new list before
 *   changing anything and the previously accepted list is still the effective
 *   one. This is the only phase allowed to say "the previous filters are still
 *   in effect", and it is the pre-C02 sentence, framed by the shared
 *   single-line engine-error helper (UG-30). No new state claim is invented:
 *   the phase is exactly the contract's promise.
 * - `accepted-reload-failed` — the provider **accepted** the new list and the
 *   model published it, but the data reload failed (C01 case (b)). This is
 *   **not** a rollback: the engine is already filtering by the accepted list,
 *   so the copy must never claim the previous filters are back. Recovery is
 *   `model.refresh()` (the same call the grid's own reload uses), offered as
 *   the `retry` action. The engine/reload message is deliberately not
 *   interpolated — nothing here prints raw engine text.
 * - `restore-failed` — a legacy (non-atomic) provider sequence could not be
 *   rolled back to the published list, so the effective filter list is
 *   unknown (`model.filtersUnknown === true`). The only honest report is that
 *   unknown state plus the two documented ways back: clear the filters or
 *   re-apply one (the `clear` action is the documented Clear affordance).
 *
 * Everything is text-only, single-line, and value-free: no predicate, column
 * name, cell value, dataset name or engine diagnostic is interpolated.
 *
 * A non-`FilterApplyError` rejection is not a phase at all (a malformed spec
 * is a plain `TypeError` from `assertFilterSpec`, a programming error). It
 * keeps the pre-C02 `filter` framing, which is honest there — no provider call
 * happened at all — and offers no recovery action.
 */
import { FilterApplyError } from '@assay/grid'
import type { FilterFailurePhase } from '@assay/grid'
import { engineErrorMessage } from '../edit/session'

/**
 * The one recovery control a failed apply can offer, or `null` when the copy
 * needs no action. `retry` reloads the view (`model.refresh()`); `clear`
 * re-applies the empty filter list, which is the documented Clear-filters
 * affordance for the unknown state.
 */
export type FilterFailureRecovery = { readonly kind: 'retry' } | { readonly kind: 'clear' } | null

export interface FilterFailureCopy {
  /** The single-line, value-free sentence to render. */
  readonly message: string
  /** The recovery control the caller should offer, if any. */
  readonly recovery: FilterFailureRecovery
}

/**
 * C01 §10 decision 5 copy (accepted + reload failed). No "previous filters"
 * clause, no engine text: the accepted chips stay and the view needs a reload.
 */
export const FILTER_RELOAD_FAILED_MESSAGE =
  'The filters were applied, but the grid could not be reloaded. Retry to reload the view.'

/**
 * C01 §7 copy (restore failed): the effective list is unknown. The second
 * sentence is the documented Clear/manual recovery affordance, never a claim
 * that either list is in effect.
 */
export const FILTER_RESTORE_FAILED_MESSAGE =
  'The filter could not be applied and the previous filters could not be restored. ' +
  'The filters now in effect are unknown: clear the filters or re-apply one to recover.'

/** The `accepted-reload-failed` copy + the `retry` recovery, as one value. */
export const FILTER_RELOAD_FAILURE: FilterFailureCopy = {
  message: FILTER_RELOAD_FAILED_MESSAGE,
  recovery: { kind: 'retry' },
}

/** The `restore-failed` copy + the `clear` recovery, as one value. */
export const FILTER_RESTORE_FAILURE: FilterFailureCopy = {
  message: FILTER_RESTORE_FAILED_MESSAGE,
  recovery: { kind: 'clear' },
}

/** The phase of a failed apply, or `null` for a non-transaction rejection. */
export function filterFailurePhase(error: unknown): FilterFailurePhase | null {
  return error instanceof FilterApplyError ? error.phase : null
}

/** Map one failed `setFilters` outcome to its copy + recovery control. */
export function filterFailureCopy(error: unknown): FilterFailureCopy {
  if (!(error instanceof FilterApplyError)) {
    // Not a transaction outcome (e.g. the malformed-spec `TypeError`): the
    // pre-C02 framed sentence is still accurate — nothing reached the
    // provider — and there is no state to recover.
    return { message: engineErrorMessage('filter', error), recovery: null }
  }
  switch (error.phase) {
    case 'refused-before-change':
      // The one phase whose promise is "the previous filters are still in
      // effect"; framed once, single-line, from the provider's own cause.
      return { message: engineErrorMessage('filter', error.cause), recovery: null }
    case 'accepted-reload-failed':
      return FILTER_RELOAD_FAILURE
    case 'restore-failed':
      return FILTER_RESTORE_FAILURE
  }
}
