// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The pure per-session emission state (design §5.1/§5.2).
 *
 * A session tracker owns the three pieces of session-scoped telemetry state
 * that are not part of the schema or the sampling decision:
 *
 * - a monotonic `localSeq` for the sampling HMAC (never sent),
 * - the **first `query_run` per session** exception (§5, always sent), and
 * - the **`dataset_opened` 50-per-session cap** (§5.2, then dropped).
 *
 * It reads no environment, clock, storage, or network — the emission surfaces
 * own those. The tracker is created once per session (web page load or CLI
 * process) and discarded with it.
 */

/** Max `dataset_opened` events per session before drops (design §5). */
export const MAX_DATASET_OPENED_PER_SESSION = 50

/** Options for {@link createSessionTracker}. */
export interface SessionTrackerOptions {
  /** Override the `dataset_opened` cap (tests). */
  readonly datasetOpenedCap?: number
}

/** Session-scoped emission counters (design §5.1/§5.2). */
export interface SessionTracker {
  /** Next monotonic sampling sequence (starts at 1; never sent). */
  nextSeq(): number
  /**
   * Whether this is the first `query_run` of the session. True exactly once;
   * the caller passes it to the sampling decision as `firstOfSession`.
   */
  firstQueryOfSession(): boolean
  /**
   * Note an attempted `dataset_opened`, returning `false` once the session
   * cap is reached (the event must then be dropped, design §5.2).
   */
  noteDatasetOpened(): boolean
}

/** Create the per-session emission tracker (design §5.1/§5.2). */
export function createSessionTracker(options: SessionTrackerOptions = {}): SessionTracker {
  const datasetOpenedCap = options.datasetOpenedCap ?? MAX_DATASET_OPENED_PER_SESSION
  let seq = 0
  let datasetOpenedCount = 0
  let queried = false
  return {
    nextSeq(): number {
      seq += 1
      return seq
    },
    firstQueryOfSession(): boolean {
      if (queried) return false
      queried = true
      return true
    },
    noteDatasetOpened(): boolean {
      if (datasetOpenedCount >= datasetOpenedCap) return false
      datasetOpenedCount += 1
      return true
    },
  }
}
