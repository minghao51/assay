// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { RunGuard } from './run-guard'

describe('RunGuard — generation guard for SQL runs', () => {
  it('a begun token is active', () => {
    const guard = new RunGuard()
    const token = guard.begin()
    expect(guard.isActive(token)).toBe(true)
  })

  it('tokens are increasing and never equal', () => {
    const guard = new RunGuard()
    const first = guard.begin()
    const second = guard.begin()
    expect(second).toBeGreaterThan(first)
  })

  it('a newer run supersedes older ones (late results of superseded runs never render)', () => {
    const guard = new RunGuard()
    const first = guard.begin()
    const second = guard.begin()
    expect(guard.isActive(first)).toBe(false)
    expect(guard.isActive(second)).toBe(true)
  })

  it('invalidate() abandons the current run without beginning a new one (the Cancel path)', () => {
    const guard = new RunGuard()
    const token = guard.begin()
    guard.invalidate()
    expect(guard.isActive(token)).toBe(false)
  })

  it('generations are monotonic: an abandoned token can never be re-activated by later runs', () => {
    const guard = new RunGuard()
    const abandoned = guard.begin()
    guard.invalidate()
    // Tokens are only ever issued (and only ever checked) from begin(), and
    // they never repeat — so a late result of the abandoned run stays dead
    // no matter how many further runs begin.
    const next = guard.begin()
    expect(next).toBeGreaterThan(abandoned)
    expect(guard.isActive(abandoned)).toBe(false)
  })

  it('after invalidate(), the next begin() is active again (pane stays usable)', () => {
    const guard = new RunGuard()
    guard.begin()
    guard.invalidate()
    const next = guard.begin()
    expect(guard.isActive(next)).toBe(true)
  })

  it('nothing is active before the first begin (token 0 / never begun)', () => {
    const guard = new RunGuard()
    expect(guard.isActive(0)).toBe(false)
    expect(guard.isActive(1)).toBe(false)
  })
})
