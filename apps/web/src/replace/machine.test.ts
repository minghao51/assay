// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { NO_REPLACEMENT_INTENT, beginIntent, canAdopt, isIntentCurrent } from './machine'
import type { Phase } from '../sessions/types'

/**
 * WF-06 intent machine pin (v5 §4.1–§4.3, C2). Pure.
 *
 * N8 lives here: a superseded candidate / changed phase is a DEFENSIVE guard,
 * not a user-reachable transition — there is no Cancel during
 * `opening-candidate` and only one intent at a time (M-D8/ADR 0047), so an
 * e2e leg that faked it would be inventing a gesture the app refuses to have.
 */

const READY: Phase = {
  kind: 'ready',
  model: {} as never,
  tableId: 't1',
  handle: { kind: 'table', id: 't1' },
  base: {
    baseAnchor: 'fv-1-1',
    overlayAnchor: 'ov-1',
    columns: [],
    baseRowCount: 0,
  },
  provider: {} as never,
}

describe('WF-06 machine — intent shapes', () => {
  it('carries no sequence on `none` and copies the sequence into every in-flight kind', () => {
    expect(NO_REPLACEMENT_INTENT).toEqual({ kind: 'none' })
    expect('seq' in NO_REPLACEMENT_INTENT).toBe(false)
    expect(beginIntent('guard', 3)).toEqual({ kind: 'guard', seq: 3 })
    expect(beginIntent('choosing', 4)).toEqual({ kind: 'choosing', seq: 4 })
    expect(beginIntent('opening-candidate', 5)).toEqual({
      kind: 'opening-candidate',
      seq: 5,
    })
  })
})

describe('WF-06 machine — late-result identity (T10)', () => {
  it('accepts only the current sequence on the captured phase', () => {
    expect(isIntentCurrent(4, 4, READY, READY)).toBe(true)
    expect(isIntentCurrent(5, 4, READY, READY)).toBe(false)
    // A different phase object — even with identical content — is a mismatch:
    // identity, not deep equality, is what the captured phase guarantees.
    expect(isIntentCurrent(4, 4, { ...READY }, READY)).toBe(false)
  })
})

describe('WF-06 machine — adoption precondition (N8, e2e-unreachable)', () => {
  it('adopts only the current `opening-candidate` on the captured phase', () => {
    expect(
      canAdopt({
        intent: beginIntent('opening-candidate', 2),
        currentSeq: 2,
        phase: READY,
        capturedPhase: READY,
      }),
    ).toBe(true)
  })

  it('rejects a superseded sequence', () => {
    expect(
      canAdopt({
        intent: beginIntent('opening-candidate', 1),
        currentSeq: 2,
        phase: READY,
        capturedPhase: READY,
      }),
    ).toBe(false)
  })

  it('rejects a phase that is no longer the captured one', () => {
    expect(
      canAdopt({
        intent: beginIntent('opening-candidate', 2),
        currentSeq: 2,
        phase: { ...READY },
        capturedPhase: READY,
      }),
    ).toBe(false)
  })

  it('rejects every intent that is not opening-candidate', () => {
    for (const intent of [
      NO_REPLACEMENT_INTENT,
      beginIntent('guard', 2),
      beginIntent('choosing', 2),
    ]) {
      expect(canAdopt({ intent, currentSeq: 2, phase: READY, capturedPhase: READY })).toBe(false)
    }
  })
})
