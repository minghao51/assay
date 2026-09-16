import { describe, expect, it } from 'vitest'
import { reduceProfileState } from './profile-state'
import type { ProfileData, ProfileState } from './profile-state'

/**
 * Pins for the profile panel's lifecycle reducer (m2-6). Delivery ordering
 * is the generation guard's job (`runGuarded` — pinned there); this pins the
 * observable states: running is visible, done carries the profile, and an
 * error is readable and *retryable* — never terminal (the m2-6 brief's
 * "retryable error state", unit-covered because no cheap e2e error path
 * exists for a valid in-app table handle).
 */
describe('reduceProfileState', () => {
  const profile: ProfileData = { rowCount: 5, columns: [] }

  it('idle → started → running', () => {
    expect(reduceProfileState({ kind: 'idle' }, { type: 'started' })).toEqual({ kind: 'running' })
  })

  it('running → succeeded → done carrying the delivered profile', () => {
    const next = reduceProfileState({ kind: 'running' }, { type: 'succeeded', profile })
    expect(next).toEqual({ kind: 'done', profile })
  })

  it('running → failed → error carrying the readable message', () => {
    const next = reduceProfileState({ kind: 'running' }, { type: 'failed', message: 'boom' })
    expect(next).toEqual({ kind: 'error', message: 'boom' })
  })

  it('an error is retryable: started from error goes back to running', () => {
    const errored: ProfileState = { kind: 'error', message: 'unknown table handle' }
    expect(reduceProfileState(errored, { type: 'started' })).toEqual({ kind: 'running' })
  })

  it('reset returns to idle (a re-opened table drops the stale display)', () => {
    expect(reduceProfileState({ kind: 'done', profile }, { type: 'reset' })).toEqual({
      kind: 'idle',
    })
    expect(reduceProfileState({ kind: 'error', message: 'x' }, { type: 'reset' })).toEqual({
      kind: 'idle',
    })
  })

  it('a success delivered on top of an error state still resolves to done (guard-verified deliveries only)', () => {
    // The guard discards stale deliveries, so any success that reaches the
    // reducer belongs to the active run and must win over the stale error.
    const next = reduceProfileState(
      { kind: 'error', message: 'stale' },
      { type: 'succeeded', profile },
    )
    expect(next).toEqual({ kind: 'done', profile })
  })
})
