// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { COMMON_CAST_TARGETS, validateCastTarget, validateRenameTarget } from './column-ops'

describe('validateRenameTarget — non-empty is the only client rule', () => {
  it('trims and accepts a non-empty name', () => {
    expect(validateRenameTarget('  nation  ')).toEqual({ ok: true, name: 'nation' })
  })

  it('refuses empty/whitespace-only names with a readable reason', () => {
    expect(validateRenameTarget('')).toEqual({ ok: false, reason: 'Enter a column name.' })
    expect(validateRenameTarget('   ')).toEqual({ ok: false, reason: 'Enter a column name.' })
  })

  it('does not pre-check collisions (the domain owns the effective schema)', () => {
    // The target need not exist in any list passed here; collisions are a
    // typed domain conflict surfaced by the app, not a client guess.
    expect(validateRenameTarget('country')).toEqual({ ok: true, name: 'country' })
  })
})

describe('validateCastTarget — the engine validator gates every spelling', () => {
  it('accepts every common target', () => {
    for (const target of COMMON_CAST_TARGETS) {
      expect(validateCastTarget(target), target).toEqual({ ok: true, targetType: target })
    }
  })

  it('accepts a well-shaped custom spelling and trims it', () => {
    expect(validateCastTarget('  DECIMAL(10,2) ')).toEqual({
      ok: true,
      targetType: 'DECIMAL(10,2)',
    })
    expect(validateCastTarget('STRUCT(x INTEGER, y VARCHAR)')).toEqual({
      ok: true,
      targetType: 'STRUCT(x INTEGER, y VARCHAR)',
    })
  })

  it('refuses structurally invalid spellings with a readable reason', () => {
    const invalid = ['VARCHAR(1,2,3)', 'MAP(INTEGER)', 'INTEGER; DROP TABLE t', 'INTEGR(2)', '']
    for (const target of invalid) {
      const result = validateCastTarget(target)
      expect(result.ok, target).toBe(false)
      if (!result.ok) expect(result.reason).toMatch(/valid column type|Choose a target type/)
    }
  })

  it('accepts a well-shaped but engine-unknown type — the engine owns the catalog', () => {
    // `VARBIT` is structurally a plain identifier (the validator's permissive
    // path), so it reaches the engine, which rejects it at schema
    // materialization. This is the *second* failure class: shape validity
    // here, catalog validity engine-side — never silently accepted as worked.
    expect(validateCastTarget('VARBIT')).toEqual({ ok: true, targetType: 'VARBIT' })
  })
})
