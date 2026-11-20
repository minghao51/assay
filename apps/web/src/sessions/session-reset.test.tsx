// SPDX-License-Identifier: AGPL-3.0-or-later

import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useDatasetSession } from './session-reset'
import type { SessionResetOutcome } from './session-reset'

/**
 * C03b — the session-reset contract (fail closed).
 *
 * The registry used to bump the token and then invoke every registered reset
 * with no isolation: one callback's throw aborted the remaining resets and
 * propagated to the caller, so the app could keep showing a half-reset,
 * already-invalidated session as `ready`. These pins are the same injections as
 * the C03a probes (`[A-first, B-middle, C-last]` with B throwing), now as
 * assertions of the chosen contract:
 *
 * 1. every callback is still invoked, in registration order;
 * 2. the fault is recorded as a value-free `{ index, kind }` — never the error;
 * 3. `beginSession` never throws and always reports the new token;
 * 4. the token is bumped BEFORE the first callback and is visible to it (so a
 *    stale async result is fenced even on a faulted epoch);
 * 5. the fault is per-invocation: the next clean `beginSession` re-runs
 *    everything from scratch and reports no fault.
 */

/** Six-digit impossible value: no frame may ever echo an error's text. */
const VIOLENT = 'VIOLENT-C03B-PAYLOAD: SELECT secret FROM leak'

function throwingReset(order: string[], label: string): () => void {
  return () => {
    order.push(label)
    throw new Error(VIOLENT)
  }
}

describe('useDatasetSession — reset isolation (C03b)', () => {
  it('S1: a fault in the first reset still runs every later reset', () => {
    const { result } = renderHook(() => useDatasetSession())
    const order: string[] = []
    result.current.registerReset(throwingReset(order, 'first'))
    result.current.registerReset(() => order.push('middle'))
    result.current.registerReset(() => order.push('last'))

    const outcome = result.current.beginSession()

    expect(order).toEqual(['first', 'middle', 'last'])
    expect(outcome.faults).toEqual([{ index: 0, kind: 'reset-callback' }])
    expect(outcome.token).toBe(1)
  })

  it('S2: a fault in a middle reset records its index and keeps going', () => {
    const { result } = renderHook(() => useDatasetSession())
    const order: string[] = []
    result.current.registerReset(() => order.push('A-first'))
    result.current.registerReset(throwingReset(order, 'B-middle'))
    result.current.registerReset(() => order.push('C-last'))

    const outcome = result.current.beginSession()

    // The pre-fix probe stopped at ["A-first", "B-middle"]; the contract
    // inverts that: the callback after the fault still runs.
    expect(order).toEqual(['A-first', 'B-middle', 'C-last'])
    expect(outcome.faults).toEqual([{ index: 1, kind: 'reset-callback' }])
  })

  it('S3: a fault in the last reset is reported (nothing left to preserve)', () => {
    const { result } = renderHook(() => useDatasetSession())
    const order: string[] = []
    result.current.registerReset(() => order.push('A-first'))
    result.current.registerReset(() => order.push('B-middle'))
    result.current.registerReset(throwingReset(order, 'C-last'))

    const outcome = result.current.beginSession()

    expect(order).toEqual(['A-first', 'B-middle', 'C-last'])
    expect(outcome.faults).toEqual([{ index: 2, kind: 'reset-callback' }])
  })

  it('records every faulting callback in one epoch, per callback', () => {
    const { result } = renderHook(() => useDatasetSession())
    const order: string[] = []
    result.current.registerReset(throwingReset(order, 'first'))
    result.current.registerReset(() => order.push('clean'))
    result.current.registerReset(throwingReset(order, 'last'))

    const outcome = result.current.beginSession()

    expect(order).toEqual(['first', 'clean', 'last'])
    expect(outcome.faults).toEqual([
      { index: 0, kind: 'reset-callback' },
      { index: 2, kind: 'reset-callback' },
    ])
  })

  it('pins the token ordering: bumped before the first callback and visible to it', () => {
    const { result } = renderHook(() => useDatasetSession())
    const before = result.current.tokenRef.current
    const seen: number[] = []
    result.current.registerReset(() => {
      // The guard a reset could read: it must already see the NEW token, which
      // is what fences a stale async result in the same tick.
      seen.push(result.current.tokenRef.current)
    })

    const outcome = result.current.beginSession()

    expect(seen).toEqual([before + 1])
    expect(outcome.token).toBe(before + 1)
    expect(result.current.tokenRef.current).toBe(before + 1)
  })

  it('S4: a later clean beginSession re-runs everything and reports no fault', () => {
    const { result } = renderHook(() => useDatasetSession())
    let faulty = true
    const order: string[] = []
    result.current.registerReset(() => {
      order.push('faulty-when-armed')
      if (faulty) throw new Error(VIOLENT)
    })
    result.current.registerReset(() => order.push('always'))

    const faulted = result.current.beginSession()
    expect(faulted.faults).toHaveLength(1)

    faulty = false
    const clean = result.current.beginSession()

    expect(order).toEqual(['faulty-when-armed', 'always', 'faulty-when-armed', 'always'])
    expect(clean.faults).toEqual([])
    expect(clean.token).toBe(faulted.token + 1)
  })

  it('never throws and keeps the fault value-free (enum + index only)', () => {
    const { result } = renderHook(() => useDatasetSession())
    result.current.registerReset(() => {
      throw new Error(VIOLENT)
    })

    const outcomes: SessionResetOutcome[] = []
    expect(() => {
      outcomes.push(result.current.beginSession())
    }).not.toThrow()

    const faults = outcomes[0]?.faults ?? []
    expect(faults).toHaveLength(1)
    const fault = faults[0]
    if (fault === undefined) throw new Error('expected one recorded fault')
    // The whole recorded value: no message, no stack, no value, no file name.
    expect(Object.keys(fault).sort()).toEqual(['index', 'kind'])
    expect(JSON.stringify(fault)).not.toContain(VIOLENT)
    expect(fault.kind).toBe('reset-callback')
  })

  it('fences a stale async result across a faulted epoch (token still moves)', () => {
    const { result } = renderHook(() => useDatasetSession())
    result.current.registerReset(() => {
      throw new Error(VIOLENT)
    })
    // Capture exactly as an async intent does before its first await.
    const captured = result.current.tokenRef.current

    result.current.beginSession()

    // The generation was invalidated even though the reset faulted: the stale
    // intent's token comparison fails and its result is dropped (not applied to
    // the abandoned session).
    expect(result.current.tokenRef.current).not.toBe(captured)
  })

  it('unregisters exactly one callback (effect cleanup cannot double-run a reset)', () => {
    const { result } = renderHook(() => useDatasetSession())
    const order: string[] = []
    result.current.registerReset(() => order.push('kept'))
    const unregister = result.current.registerReset(() => order.push('removed'))
    unregister()

    result.current.beginSession()

    expect(order).toEqual(['kept'])
  })
})
