// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { deriveNextAction } from './next-action'
import type { NextActionInput } from './next-action'

function input(overrides: Partial<NextActionInput> = {}): NextActionInput {
  return {
    contract: 'loaded',
    validation: 'idle',
    validationStale: false,
    failingRules: 0,
    diff: 'idle',
    diffStale: false,
    ...overrides,
  }
}

describe('deriveNextAction — contract and check states', () => {
  it('offers the contract picker when nothing is loaded', () => {
    expect(deriveNextAction(input({ contract: 'none' }))).toMatchObject({
      kind: 'open-contract',
      action: 'Open a contract…',
      tone: 'neutral',
      secondaryReview: false,
    })
  })

  it('asks for review when the contract could not be read', () => {
    expect(deriveNextAction(input({ contract: 'unreadable' }))).toMatchObject({
      kind: 'review-contract',
      action: 'Review contract',
    })
  })

  it('offers Validate when a contract is loaded but unchecked', () => {
    expect(deriveNextAction(input())).toMatchObject({
      kind: 'validate',
      state: 'Contract loaded — not checked yet',
      action: 'Validate',
    })
  })

  it('always lets the user cancel a running check', () => {
    expect(deriveNextAction(input({ validation: 'running' }))).toMatchObject({
      kind: 'cancel-validation',
      action: 'Cancel',
      state: 'Validating the current dataset view…',
    })
  })

  it('running check wins over an unreadable contract (cancel first)', () => {
    expect(deriveNextAction(input({ contract: 'unreadable', validation: 'running' })).kind).toBe(
      'cancel-validation',
    )
  })

  it('offers a retry after a failed check', () => {
    expect(deriveNextAction(input({ validation: 'failed' }))).toMatchObject({
      kind: 'validate',
      action: 'Retry check',
    })
  })

  it('sends binding errors to the findings', () => {
    expect(deriveNextAction(input({ validation: 'binding-errors' }))).toMatchObject({
      kind: 'review-findings',
      action: 'Review findings',
      state: 'The contract does not bind to the current schema',
    })
  })

  it('keeps the previous result readable after a cancel', () => {
    expect(deriveNextAction(input({ validation: 'cancelled' }))).toMatchObject({
      kind: 'validate',
      state: 'Check cancelled — the previous result is unchanged',
      action: 'Validate',
    })
  })
})

describe('deriveNextAction — verdict truthfulness', () => {
  it('offers Recheck for a stale verdict and never claims changed contents', () => {
    const action = deriveNextAction(
      input({ validation: 'verdict', validationStale: true, failingRules: 3 }),
    )
    expect(action).toMatchObject({
      kind: 'validate',
      action: 'Recheck',
      tone: 'stale',
      secondaryReview: true,
    })
    expect(action.state).toContain('session’s staged state changed')
    expect(action.state).not.toMatch(/dataset changed/i)
    expect(action.state).not.toMatch(/\d/)
  })

  it('stale wins over the failing count (no second run path)', () => {
    const action = deriveNextAction(
      input({ validation: 'verdict', validationStale: true, failingRules: 3 }),
    )
    expect(action.action).toBe('Recheck')
    expect(action.secondaryReview).toBe(true)
  })

  it('sends a fresh failing verdict to the findings without copying the count', () => {
    const action = deriveNextAction(
      input({ validation: 'verdict', failingRules: 3, diffStale: true }),
    )
    expect(action).toMatchObject({ kind: 'review-findings', action: 'Review findings' })
    expect(action.state).toBe('The current check found failures')
    expect(action.state).not.toMatch(/\d/)
  })

  it('offers delivery only for a current, valid verdict', () => {
    expect(deriveNextAction(input({ validation: 'verdict', failingRules: 0 }))).toMatchObject({
      kind: 'export',
      action: 'Export a copy…',
      tone: 'ok',
      state: 'Verdict is current — no violations',
    })
  })
})

describe('deriveNextAction — comparison continuation', () => {
  it('offers review (not a hidden second run) for a stale comparison', () => {
    const action = deriveNextAction(
      input({ validation: 'verdict', failingRules: 0, diffStale: true, diff: 'result' }),
    )
    expect(action).toMatchObject({
      kind: 'rerun-diff',
      action: 'Review comparison',
      tone: 'stale',
    })
    expect(action.state).toContain('session’s staged state changed after it ran')
  })

  it('lets the user cancel a running comparison', () => {
    expect(
      deriveNextAction(input({ validation: 'verdict', failingRules: 0, diff: 'running' })),
    ).toMatchObject({ kind: 'cancel-diff', action: 'Cancel' })
  })

  it('offers review after a failed comparison', () => {
    expect(
      deriveNextAction(input({ validation: 'verdict', failingRules: 0, diff: 'failed' })),
    ).toMatchObject({ kind: 'rerun-diff', state: 'The last comparison failed' })
  })

  it('offers review for comparison binding errors', () => {
    expect(
      deriveNextAction(input({ validation: 'verdict', failingRules: 0, diff: 'binding-errors' })),
    ).toMatchObject({ kind: 'review-comparison', action: 'Review comparison' })
  })

  it('does not let a comparison state hide an unrun check', () => {
    expect(
      deriveNextAction(input({ validation: 'idle', diffStale: true, diff: 'result' })),
    ).toMatchObject({ kind: 'validate', state: 'Contract loaded — not checked yet' })
  })

  it('still lets the user cancel a running comparison before a check', () => {
    expect(deriveNextAction(input({ validation: 'idle', diff: 'running' }))).toMatchObject({
      kind: 'cancel-diff',
      action: 'Cancel',
    })
  })

  it('keeps a running comparison cancellable in every contract/check state', () => {
    const states: NextActionInput[] = [
      input({ contract: 'none', diff: 'running' }),
      input({ contract: 'unreadable', diff: 'running' }),
      input({ validation: 'failed', diff: 'running' }),
      input({ validation: 'binding-errors', diff: 'running' }),
      input({ validation: 'verdict', validationStale: true, failingRules: 2, diff: 'running' }),
      input({ validation: 'verdict', failingRules: 2, diff: 'running' }),
      input({ validation: 'verdict', failingRules: 0, diff: 'running' }),
    ]
    for (const state of states) {
      expect(deriveNextAction(state), JSON.stringify(state)).toMatchObject({
        kind: 'cancel-diff',
        action: 'Cancel',
        state: 'Comparing datasets…',
      })
    }
  })
})

describe('deriveNextAction — single action invariants', () => {
  it('returns a non-empty state and at most one primary label in every state', () => {
    const states: NextActionInput[] = [
      input({ contract: 'none' }),
      input({ contract: 'unreadable' }),
      input(),
      input({ validation: 'running' }),
      input({ validation: 'cancelled' }),
      input({ validation: 'failed' }),
      input({ validation: 'binding-errors' }),
      input({ validation: 'verdict', validationStale: true, failingRules: 1 }),
      input({ validation: 'verdict', failingRules: 1 }),
      input({ validation: 'verdict', failingRules: 0 }),
      input({ validation: 'verdict', failingRules: 0, diffStale: true }),
      input({ validation: 'verdict', failingRules: 0, diff: 'running' }),
      input({ validation: 'verdict', failingRules: 0, diff: 'failed' }),
      input({ validation: 'verdict', failingRules: 0, diff: 'binding-errors' }),
      input({ validation: 'idle', diff: 'running' }),
    ]
    for (const state of states) {
      const action = deriveNextAction(state)
      expect(action.state.length).toBeGreaterThan(0)
      expect(typeof action.action === 'string' || action.action === null).toBe(true)
      expect(action.secondaryReview).toBe(action.tone === 'stale' && action.action === 'Recheck')
    }
  })
})
