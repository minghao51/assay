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
 */
export interface DatasetSession {
  /**
   * Live session token. An async intent reads `.current` at capture time and
   * re-compares after every `await`; a mismatch means a newer open won and
   * the result is dropped.
   */
  readonly tokenRef: { current: number }
  /**
   * Start a new dataset session: bump the token, run every registered domain
   * reset, and return the new token so the open flow can guard its own async
   * chain against later opens.
   */
  readonly beginSession: () => number
  /**
   * Register one domain-session reset; returns an unregister callback for
   * effect cleanup (so StrictMode's mount/cleanup/mount does not double-list
   * a reset).
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
      tokenRef.current += 1
      for (const reset of resets) reset()
      return tokenRef.current
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
