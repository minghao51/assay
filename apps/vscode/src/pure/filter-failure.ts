// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * C02c — the desktop-local mapping from a failed `setFilters` outcome to
 * user-visible copy (C01 §7, §10 decisions 4–5).
 *
 * This is a deliberate duplicate of the web app's
 * `apps/web/src/grid/filter-failure.ts`, not a shared package: apps never
 * import apps (`docs/engineering/03-repository-structure.md` §3), and the copy
 * is surface-specific anyway (the web app's sentences speak of "the grid",
 * this surface's toolbar is the webview's own). The contract it encodes is
 * shared because both surfaces read the same `FilterApplyError.phase`.
 *
 * The model owns the transaction **and** the restoration (`FilterApplyError`,
 * C01 §5.2/§7): the desktop filter bar never issues a compensating
 * `setFilters(previous)`. "The promise rejected" does not mean "nothing
 * changed", so the copy is derived from the value-free `phase` — never from
 * the error text and never from `model.reloadError` (diagnostics only, C01 §10
 * decision 4):
 *
 * - `refused-before-change` — the provider refused the new list before
 *   changing anything and the previously accepted list is still the effective
 *   one. This is the only phase allowed to say "the previous filters are still
 *   in effect". The sentence is the pre-C02 framing (UG-30), and it is the
 *   only phase whose copy may carry the provider's first diagnostic line.
 * - `accepted-reload-failed` — the provider **accepted** the new list and the
 *   model published it, but the data reload failed (C01 case (b)). This is
 *   **not** a rollback: the engine is already filtering by the accepted list,
 *   so the copy must never claim the previous filters are back. Recovery is
 *   `model.refresh()` (the same call the model's own reload uses), offered as
 *   the `retry` action. The engine/reload message is deliberately not
 *   interpolated — nothing here prints raw engine text.
 * - `restore-failed` — a legacy (non-atomic) provider sequence could not be
 *   rolled back to the published list, so the effective filter list is
 *   unknown (`model.filtersUnknown === true`). The only honest report is that
 *   unknown state plus the two documented ways back: clear the filters or
 *   re-apply one (the `clear` action is the documented Clear affordance).
 *
 * Everything is text-only, single-line, and value-free: no predicate, column
 * name, cell value, dataset name or engine diagnostic is interpolated into the
 * reload/restore sentences.
 *
 * A non-`FilterApplyError` rejection is not a phase at all (a malformed spec
 * is a plain `TypeError` from `assertFilterSpec`, a programming error). It
 * keeps the pre-C02 `filter` framing, which is honest there — no provider call
 * happened at all — and offers no recovery action.
 */
import { FilterApplyError } from '@assay/grid'
import type { FilterFailurePhase } from '@assay/grid'

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

/**
 * The browser bundle's emscripten glue can surface as the opaque
 * `_setThrew is not defined`; that is not a readable engine message, so it
 * (and an empty message) degrade to the plain fallback (mirrors the web app's
 * `engineErrorLine`).
 */
const OPAQUE_GLUE_ERROR = /^_setThrew\b/

/** Every line break an engine diagnostic may carry (UG-30 single-line rule). */
const LINE_BREAK = /\r\n|[\r\n\v\f\u0085\u2028\u2029]/

/** The full raw engine/HTTP text — never rendered by this surface. */
function engineErrorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The first (summary) line of an engine/HTTP error, guaranteed single-line.
 * Engine errors echo their SQL context across several lines; only the summary
 * is surfaced, and it is never logged (it can echo the value typed, ADR 0025).
 */
function engineErrorLine(error: unknown, fallback: string): string {
  const summary = engineErrorDetail(error).split(LINE_BREAK)[0]?.trim() ?? ''
  if (summary === '' || OPAQUE_GLUE_ERROR.test(summary)) return fallback
  return summary.replace(/\s+/g, ' ')
}

/** A summary rendered as a sentence fragment: no doubled/stacked punctuation. */
function fragment(summary: string): string {
  return summary.replace(/[.!?\u2026\s]+$/u, '')
}

/** The pre-C02 filtered-rejection sentence, framed once and single-line. */
function refusedMessage(cause: unknown): string {
  return `The filter could not be applied: ${fragment(engineErrorLine(cause, 'the engine reported an error'))}. The previous filters are still in effect.`
}

/** The phase of a failed apply, or `null` for a non-transaction rejection. */
export function filterFailurePhase(error: unknown): FilterFailurePhase | null {
  return error instanceof FilterApplyError ? error.phase : null
}

/** Map one failed `setFilters` outcome to its copy + recovery control. */
export function filterFailureCopy(error: unknown): FilterFailureCopy {
  if (!(error instanceof FilterApplyError)) {
    // Not a transaction outcome (e.g. the malformed-spec `TypeError`): nothing
    // reached the provider, so the pre-C02 sentence is still accurate and
    // there is no state to recover.
    return { message: refusedMessage(error), recovery: null }
  }
  switch (error.phase) {
    case 'refused-before-change':
      // The one phase whose promise is "the previous filters are still in
      // effect"; framed once, single-line, from the provider's own cause.
      return { message: refusedMessage(error.cause), recovery: null }
    case 'accepted-reload-failed':
      return FILTER_RELOAD_FAILURE
    case 'restore-failed':
      return FILTER_RESTORE_FAILURE
  }
}
