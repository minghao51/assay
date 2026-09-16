/**
 * The guarded async tail of a SQL run (m2-4) — extracted from `SqlPanel`'s
 * `execute` as a pure helper (guard + promise + callbacks parameterized) so
 * the discard is observable by Node tests (the repo's convention: thin
 * components over tested pure modules, like m2-3's `query-state.ts` and the
 * `RunGuard` class itself).
 *
 * What it pins: **an invalidated (cancelled) or superseded run's late
 * result/rejection never reaches the handlers.** Before this extraction the
 * discard lived only inside the component's promise tail, which no unit
 * test could observe — deleting the guard-discard line passed every gate
 * because every e2e assertion is final-state and the FIFO-queued follow-up
 * overwrites the transient wrong page moments later. The tests on
 * `runGuarded` now fail under that mutation.
 *
 * Honest cancel semantics (unchanged): `guard.invalidate()` is UI-level
 * abandonment — the late result is discarded when it arrives, while the
 * query itself keeps running worker-side until completion (the engine has
 * no client-facing interrupt; a true interrupt decision is m2-7).
 */

import type { RunGuard } from './run-guard'

/** Handlers invoked only while the run's token is still the active one. */
export interface GuardedRunHandlers<T> {
  /** Receives the delivered value iff the run was not cancelled/superseded. */
  readonly onResult: (value: T) => void
  /** Receives the rejection cause iff the run was not cancelled/superseded. */
  readonly onError: (cause: unknown) => void
}

/**
 * Begin a run on `guard` (a fresh, active token) and attach the guarded
 * delivery to `promise`: each handler fires only if the run's token is
 * still active at settlement time. Returns the run's token.
 *
 * The `.then(…).catch(…)` shape is deliberate: a throw from `onResult`
 * (e.g. a projection failure) is routed to `onError` rather than becoming
 * an unhandled rejection, so a failed delivery cannot wedge the pane.
 */
export function runGuarded<T>(
  guard: RunGuard,
  promise: Promise<T>,
  handlers: GuardedRunHandlers<T>,
): number {
  const token = guard.begin()
  void promise
    .then((value: T) => {
      if (!guard.isActive(token)) return // cancelled/superseded — discard the late result
      handlers.onResult(value)
    })
    .catch((cause: unknown) => {
      if (!guard.isActive(token)) return // cancelled/superseded — discard the late rejection
      handlers.onError(cause)
    })
  return token
}
