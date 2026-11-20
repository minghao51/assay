// SPDX-License-Identifier: AGPL-3.0-or-later

import { useRef } from 'react'

/**
 * Dataset-session epoch + reset registry (f-1).
 *
 * Every async intent in the workbench — a file open (AR-W13), a cast
 * pre-commit check (m4-4), a contract import (AR-W9), a validation run
 * (m5-3), a comparison stage and a row diff (m6-4) — captures the current
 * session token at request time and drops a result that is no longer current.
 * The token is bumped once whenever a new file opens, which is the single
 * point that invalidates *all* in-flight work: an overlay, a contract verdict
 * and a staged comparison must never leak across datasets.
 *
 * f-1: the open flow used to hand-null every session slot (~14 setters) in a
 * fixed statement order. Each per-domain hook now owns its own reset and
 * registers it here, so `beginSession()` is the one call that starts a fresh
 * dataset session and the open flow no longer enumerates slots.
 *
 * Ordering: `beginSession` bumps the token *first*, then runs every
 * registered reset in registration order. Bumping first is what discards a
 * stale async result that resolves in the same tick: the guard is a token
 * comparison, so the new token must be visible before any reset runs. The
 * resets themselves are synchronous React setters and ref writes — nothing
 * reads between them and React batches the setters into one render — so their
 * relative order is not observable; registration order keeps the reset
 * sequence legible and matches the hook call order in `App` (editing,
 * validation, diff).
 *
 * C03b (fail closed): the "synchronous React setters and ref writes" above is
 * the registrants' **contract**, not a language guarantee. An unexpected
 * throw must therefore neither abort the remaining resets nor turn a partial
 * reset into a published `ready` session. Each callback runs under its own
 * isolation, a fault is recorded as a value-free reset fault, the remaining
 * callbacks still run, and `beginSession` returns the outcome instead of
 * throwing. Callers must then abandon the flow (never publish `ready`) and
 * surface the session-fault recovery frame. There is no rollback promise: a
 * faulted callback's effects are whatever they were — the contract is "this
 * session is abandoned", never "the previous session was restored".
 */

/**
 * One value-free reset fault (C03b). It deliberately carries no error message,
 * stack, column, row or value: a reset fault is a session-lifecycle fact, and
 * the recovery copy is fixed text (ADR 0025). `index` is the callback's
 * registration order within the epoch, which is the only detail the contract
 * exposes.
 */
export interface SessionResetFault {
  /** Registration order within this epoch, 0-based. */
  readonly index: number
  /** Closed enum — the only fault class a reset can produce. */
  readonly kind: 'reset-callback'
}

/**
 * What one `beginSession()` did. `faults` empty means every registered reset
 * completed; a non-empty list means the generation was invalidated and the
 * session must not be published (fail closed), whatever the remaining
 * callbacks managed to do.
 */
export interface SessionResetOutcome {
  /** The new session token (bumped before any callback ran). */
  readonly token: number
  /** Empty means every registered reset completed. */
  readonly faults: readonly SessionResetFault[]
}

export interface DatasetSession {
  /**
   * Live session token. An async intent reads `.current` at capture time and
   * re-compares after every `await`; a mismatch means a newer open won and
   * the result is dropped.
   */
  readonly tokenRef: { current: number }
  /**
   * Start a new dataset session: bump the token, run every registered domain
   * reset under its own isolation, and return the new token plus any
   * value-free reset faults. **Never throws** — a caller's flow must check
   * `faults` before publishing `ready` (C03b fail-closed contract).
   */
  readonly beginSession: () => SessionResetOutcome
  /**
   * Register one domain-session reset; returns an unregister callback for
   * effect cleanup (so StrictMode's mount/cleanup/mount does not double-list
   * a reset).
   *
   * Contract for a registered reset: synchronous, no `await`, no external or
   * engine call, no user-supplied callback — state writes, ref writes and
   * counter bumps only. It must not throw; a throw is contained and reported
   * as a fault, but it still abandons the session.
   */
  readonly registerReset: (reset: () => void) => () => void
}

/**
 * Lazily create the stable session object. The object and its token ref must
 * keep their identity for the whole App lifetime (they are refs-cum-module
 * state in React terms); a lazy `useRef` initializer gives that without a
 * `useMemo` dependency discussion.
 */
export function useDatasetSession(): DatasetSession {
  const sessionRef = useRef<DatasetSession | null>(null)
  if (sessionRef.current !== null) return sessionRef.current
  const tokenRef = { current: 0 }
  const resets = new Set<() => void>()
  const session: DatasetSession = {
    tokenRef,
    beginSession: () => {
      // The generation is invalidated before any callback runs, so a callback
      // that reads `.current` already sees the new token (assertion-pinned) and
      // every in-flight intent is fenced even if a later callback faults.
      tokenRef.current += 1
      const faults: SessionResetFault[] = []
      let index = 0
      for (const reset of resets) {
        // One isolation boundary per callback: a fault is recorded, not
        // rethrown, and never short-circuits the remaining resets. Attempting
        // every reset is the strongest honest behaviour — full rollback of
        // arbitrary React state/ref writes is not representable.
        try {
          reset()
        } catch {
          // Value-free by construction: the error object is dropped here and
          // only the closed enum + registration index leave this frame.
          faults.push({ index, kind: 'reset-callback' })
        }
        index += 1
      }
      return { token: tokenRef.current, faults }
    },
    registerReset: (reset) => {
      resets.add(reset)
      return () => {
        resets.delete(reset)
      }
    },
  }
  sessionRef.current = session
  return session
}
