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

/**
 * Approved-copy enforcement (integration accountability, 2026-11-04).
 *
 * The context bar may only say what the approved table says. The table lives in
 * docs/process/handoff/20261104-rd-decisions-and-runtime-scope.md §2; this list
 * is its machine-enforced mirror, extended once at integration with the row the
 * table did not originally enumerate (the comparison `binding-errors` state, see
 * the amendment note in that record).
 *
 * The test drives the FULL input cross-product, so a new state, action or
 * sentence cannot ship without failing here: every derived row must be in the
 * approved set (no unenumerated copy) and every approved row must be produced by
 * at least one reachable state (no dead or orphaned copy). Keep the two lists in
 * step — that is the point.
 */
const APPROVED_COPY = [
  'Validating the current dataset view… → Cancel',
  'Comparing datasets… → Cancel',
  'No contract loaded → Open a contract…',
  'The contract could not be loaded → Review contract',
  'The last check failed → Retry check',
  'The contract does not bind to the current schema → Review findings',
  'Verdict stale — the session’s staged state changed after it was computed → Recheck',
  'The current check found failures → Review findings',
  'Check cancelled — the previous result is unchanged → Validate',
  'Contract loaded — not checked yet → Validate',
  'The comparison needs attention → Review comparison',
  'The last comparison failed → Review comparison',
  'Comparison stale — the session’s staged state changed after it ran → Review comparison',
  'Verdict is current — no violations → Export a copy…',
] as const

describe('deriveNextAction — approved copy is exhaustive and closed', () => {
  const contracts: NextActionInput['contract'][] = ['none', 'unreadable', 'loaded']
  const validations: NextActionInput['validation'][] = [
    'idle',
    'running',
    'cancelled',
    'failed',
    'binding-errors',
    'verdict',
  ]
  const diffs: NextActionInput['diff'][] = [
    'idle',
    'running',
    'cancelled',
    'failed',
    'binding-errors',
    'result',
  ]

  function row(action: ReturnType<typeof deriveNextAction>): string {
    return `${action.state} → ${action.action ?? '(no action)'}`
  }

  it('only ever emits approved copy across the full input cross-product', () => {
    const produced = new Set<string>()
    for (const contract of contracts) {
      for (const validation of validations) {
        for (const diff of diffs) {
          // Stale and failing variants are part of the reachable domain; cover
          // both so a stale/failing branch cannot carry private copy.
          for (const validationStale of [false, true]) {
            for (const diffStale of [false, true]) {
              for (const failingRules of [0, 2]) {
                produced.add(
                  row(
                    deriveNextAction({
                      contract,
                      validation,
                      validationStale,
                      failingRules,
                      diff,
                      diffStale,
                    }),
                  ),
                )
              }
            }
          }
        }
      }
    }
    expect([...produced].sort()).toEqual([...APPROVED_COPY].sort())
  })

  it('has no dead approved row and keeps the bar to one primary action', () => {
    expect(new Set(APPROVED_COPY).size).toBe(APPROVED_COPY.length)
    // The only classification the copy contract allows a second control in is
    // the stale verdict (Recheck + Review findings).
    expect(APPROVED_COPY.filter((entry) => entry.endsWith('Recheck'))).toHaveLength(1)
  })
})
