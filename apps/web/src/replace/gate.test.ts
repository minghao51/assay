// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { appendOp, emptyHistory } from '@assay/domain'
import type { OverlayBase, TransformationHistory } from '@assay/domain'
import { evaluateReadyGesture } from './gate'
import type { ReadyGestureInput } from './gate'
import { NO_REPLACEMENT_INTENT, beginIntent } from './machine'

/**
 * WF-06 gate unit pin (v5 §3.2, G1–G6). Pure: no React, no DOM, no engine.
 *
 * Each row is pinned in isolation AND in order: the order tests are the
 * substantive ones, because a gate that evaluated dirty first, or cast before
 * mutation, would still pass every single-row case.
 */

const BASE: OverlayBase = {
  baseAnchor: 'fv-9-100',
  overlayAnchor: 'ov-1',
  columns: [
    { name: 'id', type: 'BIGINT' },
    { name: 'label', type: 'VARCHAR' },
  ],
  baseRowCount: 1,
}

/** A history with one applied rename (dirty by the adopted predicate). */
function dirtyHistory(): TransformationHistory {
  const result = appendOp(BASE, emptyHistory(), {
    kind: 'column-rename',
    from: 'label',
    to: 'tag',
  })
  return result.history
}

/** A no-op-only history: an entry exists, but nothing was applied. */
function noOpHistory(): TransformationHistory {
  const result = appendOp(BASE, emptyHistory(), {
    kind: 'column-rename',
    from: 'label',
    to: 'label',
  })
  return result.history
}

function input(overrides: Partial<ReadyGestureInput> = {}): ReadyGestureInput {
  return {
    openModal: null,
    intent: NO_REPLACEMENT_INTENT,
    editorOpen: false,
    mutations: 0,
    castPendingCount: 0,
    gridBusy: null,
    history: emptyHistory(),
    ...overrides,
  }
}

describe('WF-06 gate — G1 modal arbitration', () => {
  it('refuses every owned modal kind with the modal reason and no dirty read', () => {
    for (const openModal of ['help', 'disclosure', 'replace', 'export', 'settings'] as const) {
      expect(evaluateReadyGesture(input({ openModal, history: dirtyHistory() }))).toEqual({
        kind: 'refuse',
        reason: 'modal',
      })
    }
  })
})

describe('WF-06 gate — G2 intent', () => {
  it('refuses every in-flight intent before any other row is consulted', () => {
    for (const kind of ['guard', 'choosing', 'opening-candidate'] as const) {
      const intent = beginIntent(kind, 7)
      expect(
        evaluateReadyGesture(
          input({ intent, editorOpen: true, mutations: 2, history: dirtyHistory() }),
        ),
      ).toEqual({ kind: 'refuse', reason: 'intent' })
    }
  })
})

describe('WF-06 gate — G3 open editor (any kind)', () => {
  it('refuses an open editor and never proceeds, even on a clean or dirty history', () => {
    expect(evaluateReadyGesture(input({ editorOpen: true }))).toEqual({
      kind: 'refuse',
      reason: 'editor',
    })
    expect(evaluateReadyGesture(input({ editorOpen: true, history: dirtyHistory() }))).toEqual({
      kind: 'refuse',
      reason: 'editor',
    })
  })
})

describe('WF-06 gate — G4 pending work (aggregate cast, C15 wins)', () => {
  it('refuses a mutation in flight with the settling reason', () => {
    expect(evaluateReadyGesture(input({ mutations: 1 }))).toEqual({
      kind: 'refuse',
      reason: 'settling',
    })
  })

  it('refuses ANY pending cast check (aggregate count, not one column)', () => {
    expect(evaluateReadyGesture(input({ castPendingCount: 1 }))).toEqual({
      kind: 'refuse',
      reason: 'cast',
    })
    // The exact defect a single-column value could not express: two checks on
    // different columns (count 2) still refuse.
    expect(evaluateReadyGesture(input({ castPendingCount: 2, history: dirtyHistory() }))).toEqual({
      kind: 'refuse',
      reason: 'cast',
    })
  })

  it('prefers the mutation reason (C15) when both waits are pending', () => {
    expect(evaluateReadyGesture(input({ mutations: 1, castPendingCount: 3 }))).toEqual({
      kind: 'refuse',
      reason: 'settling',
    })
  })
})

describe('WF-06 gate — G5 busy and G6 dirty', () => {
  it('refuses either grid-busy epoch', () => {
    expect(evaluateReadyGesture(input({ gridBusy: 'filtering' }))).toEqual({
      kind: 'refuse',
      reason: 'busy',
    })
    expect(evaluateReadyGesture(input({ gridBusy: 'sorting' }))).toEqual({
      kind: 'refuse',
      reason: 'busy',
    })
  })

  it('proceeds clean when every earlier row passes, and evaluates dirty last', () => {
    expect(evaluateReadyGesture(input())).toEqual({ kind: 'proceed', dirty: false })
    // A no-op-only history is CLEAN (the predicate reads outcomes, not entries).
    expect(evaluateReadyGesture(input({ history: noOpHistory() }))).toEqual({
      kind: 'proceed',
      dirty: false,
    })
    expect(evaluateReadyGesture(input({ history: dirtyHistory() }))).toEqual({
      kind: 'proceed',
      dirty: true,
    })
  })

  it('never evaluates dirty before G1–G5 (a refusal never reports a verdict)', () => {
    const verdict = evaluateReadyGesture(
      input({ openModal: 'export', editorOpen: true, mutations: 1, history: dirtyHistory() }),
    )
    expect(verdict).toEqual({ kind: 'refuse', reason: 'modal' })
    expect('dirty' in verdict).toBe(false)
  })
})
