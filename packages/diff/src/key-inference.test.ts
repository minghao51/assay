import { describe, expect, it } from 'vitest'
import { inferRowDiffKeys } from './key-inference'
import type { ColumnProfile, DatasetProfile } from './profile'
import {
  makeAllTrapsProxy,
  makeProxyArray,
  makeProxyObject,
  makeRevokedProxy,
  makeThrowingGetter,
  makeUnstringifiable,
} from './diff-property-testing'

/**
 * Key-inference pins (m6-1, checkpoint C2). Inference is a deterministic
 * *proposal*: minimal-first (single-column v1 — the evidence boundary),
 * profile-A column order for ties, machine-readable evidence only from
 * what the profiles prove, and a disclosure string for verbatim surface
 * rendering — including for the zero-candidates outcome (never silent).
 * The compiler never sees this module's output implicitly.
 */

function profile(columns: ColumnProfile[], rowCount: number): DatasetProfile {
  return { rowCount, columns }
}

function keyColumn(name: string, type: string, rowCount: number): ColumnProfile {
  return { name, type, kind: 'other', nullCount: 0, distinctCount: rowCount }
}

function numericColumn(
  name: string,
  type: string,
  _rowCount: number,
  nullCount: number,
  distinctCount: number,
): ColumnProfile {
  return { name, type, kind: 'numeric', nullCount, distinctCount }
}

describe('key inference — candidacy (what the profiles honestly prove)', () => {
  it('a single-column key: unique and non-null on BOTH sides, rowCount ≥ 1, types compatible', () => {
    const a = profile([keyColumn('id', 'BIGINT', 42), keyColumn('email', 'VARCHAR', 42)], 42)
    const b = profile([keyColumn('id', 'BIGINT', 40), keyColumn('email', 'VARCHAR', 40)], 40)
    const result = inferRowDiffKeys(a, b)
    expect(result.candidates.map((c) => c.columns)).toEqual([['id'], ['email']])
    expect(result.issues).toEqual([])
    expect(result.candidates[0]?.evidence).toEqual({
      column: 'id',
      typeA: 'BIGINT',
      typeB: 'BIGINT',
      rowCountA: 42,
      rowCountB: 40,
      nullCountA: 0,
      nullCountB: 0,
      distinctCountA: 42,
      distinctCountB: 40,
    })
  })

  it('a NULL anywhere, a duplicate, or an unknown count disqualifies a column on a side', () => {
    const a = profile(
      [
        numericColumn('has_nulls', 'BIGINT', 10, 1, 9),
        numericColumn('has_dupes', 'BIGINT', 10, 0, 9),
        numericColumn('unknown_distinct', 'BIGINT', 10, 0, 0), // distinctCount unknown (0 ≠ rowCount 10)
        keyColumn('good', 'BIGINT', 10),
      ],
      10,
    )
    const b = profile(
      [
        numericColumn('has_nulls', 'BIGINT', 10, 0, 10),
        numericColumn('has_dupes', 'BIGINT', 10, 0, 10),
        numericColumn('unknown_distinct', 'BIGINT', 10, 0, 10),
        keyColumn('good', 'BIGINT', 10),
      ],
      10,
    )
    const result = inferRowDiffKeys(a, b)
    expect(result.candidates.map((c) => c.columns)).toEqual([['good']])
  })

  it('a column missing from one profile is not a candidate (exact-name matching)', () => {
    const a = profile([keyColumn('id', 'BIGINT', 5), keyColumn('only_a', 'BIGINT', 5)], 5)
    const b = profile([keyColumn('id', 'BIGINT', 5)], 5)
    expect(inferRowDiffKeys(a, b).candidates.map((c) => c.columns)).toEqual([['id']])
  })

  it('zero rows prove nothing: rowCount 0 is vacuous and never proposed', () => {
    const empty: DatasetProfile = { rowCount: 0, columns: [keyColumn('id', 'BIGINT', 0)] }
    const good = profile([keyColumn('id', 'BIGINT', 5)], 5)
    expect(inferRowDiffKeys(empty, good).candidates).toEqual([])
    expect(inferRowDiffKeys(good, empty).candidates).toEqual([])
  })

  it('a type pair the compiler would refuse is never proposed (the one shared policy)', () => {
    const a = profile(
      [
        keyColumn('id', 'BIGINT', 5),
        keyColumn('j', 'JSON', 5),
        keyColumn('nested', 'INTEGER[]', 5),
      ],
      5,
    )
    const b = profile(
      [
        keyColumn('id', 'VARCHAR', 5),
        keyColumn('j', 'JSON', 5),
        keyColumn('nested', 'INTEGER[]', 5),
      ],
      5,
    )
    const result = inferRowDiffKeys(a, b)
    // id: cross-family → refused; j: JSON → refused; nested: identical
    // nested spellings → proposed (documented policy)
    expect(result.candidates.map((c) => c.columns)).toEqual([['nested']])
  })
})

describe('key inference — determinism, ranking, and the evidence boundary', () => {
  it('ties resolve by profile-A column order (never alphabetical, never map order)', () => {
    const a = profile(
      [
        keyColumn('zeta', 'BIGINT', 3),
        keyColumn('alpha', 'BIGINT', 3),
        keyColumn('mid', 'BIGINT', 3),
      ],
      3,
    )
    const b = profile(
      [
        keyColumn('mid', 'BIGINT', 4),
        keyColumn('zeta', 'BIGINT', 4),
        keyColumn('alpha', 'BIGINT', 4),
      ],
      4,
    )
    const result = inferRowDiffKeys(a, b)
    expect(result.candidates.map((c) => c.columns)).toEqual([['zeta'], ['alpha'], ['mid']])
    // determinism: identical inputs → identical output bytes
    expect(JSON.stringify(inferRowDiffKeys(a, b))).toBe(JSON.stringify(result))
  })

  it('v1 proposes single columns ONLY (multi-column joint uniqueness is not derivable)', () => {
    // Two columns that are EACH unique/non-null per aggregates — the pair
    // is still not honestly provable, and v1 must not pretend otherwise.
    const a = profile([keyColumn('x', 'BIGINT', 6), keyColumn('y', 'BIGINT', 6)], 6)
    const b = profile([keyColumn('x', 'BIGINT', 6), keyColumn('y', 'BIGINT', 6)], 6)
    const result = inferRowDiffKeys(a, b)
    for (const candidate of result.candidates) expect(candidate.columns).toHaveLength(1)
    expect(result.disclosure).toContain('single columns')
    expect(result.disclosure).toContain('confirm keys explicitly')
  })

  it('every candidate carries a deterministic verbatim disclosure with exact numbers', () => {
    const a = profile([keyColumn('id', 'BIGINT', 1234)], 1234)
    const b = profile([keyColumn('id', 'BIGINT', 567)], 567)
    const result = inferRowDiffKeys(a, b)
    const disclosure = result.candidates[0]?.disclosure as string
    expect(disclosure).toBe(
      "key candidate: column 'id' is unique and non-null on both sides " +
        '(A: BIGINT, 0 nulls, 1234 distinct of 1234 rows; ' +
        'B: BIGINT, 0 nulls, 567 distinct of 567 rows)',
    )
    expect(inferRowDiffKeys(a, b).candidates[0]?.disclosure).toBe(disclosure)
    // never-echo: the numbers appear exactly, never rounded or re-formatted
    expect(disclosure).toContain('1234')
  })

  it('the zero-candidates outcome is disclosed, never silent', () => {
    const a = profile([numericColumn('id', 'BIGINT', 5, 1, 4)], 5)
    const b = profile([numericColumn('id', 'BIGINT', 5, 1, 4)], 5)
    const result = inferRowDiffKeys(a, b)
    expect(result.candidates).toEqual([])
    expect(result.disclosure).toContain('no key candidate is provable')
    expect(result.disclosure).toContain('multi-column joint uniqueness is not derivable')
    expect(result.disclosure).toContain('choose key columns explicitly')
  })
})

describe('key inference — totality over hostile profiles', () => {
  const FIXTURES: readonly { readonly name: string; readonly make: () => unknown }[] = [
    { name: 'array Proxy', make: makeProxyArray },
    { name: 'object Proxy', make: makeProxyObject },
    { name: 'revoked Proxy', make: makeRevokedProxy },
    { name: 'all-traps Proxy', make: makeAllTrapsProxy },
    { name: 'throwing getter', make: () => makeThrowingGetter('nullCount', { rowCount: 3 }) },
    { name: 'unstringifiable', make: makeUnstringifiable },
    { name: 'null-prototype object', make: () => Object.create(null) },
  ]

  const healthy: DatasetProfile = profile(
    [keyColumn('id', 'BIGINT', 2), keyColumn('other', 'BIGINT', 2)],
    2,
  )

  it('every hostile fixture in every position: never throws, issues typed, candidates honest', () => {
    for (const { make } of FIXTURES) {
      const hostile = make()
      let result: ReturnType<typeof inferRowDiffKeys> | undefined
      expect(() => {
        result = inferRowDiffKeys(hostile as never, healthy)
      }).not.toThrow()
      expect(result?.candidates).toEqual([]) // an unreadable side proves nothing
      expect(result?.disclosure).toContain('no key candidate is provable')
      expect(result?.issues.length).toBeGreaterThan(0)
      for (const issue of result?.issues ?? []) {
        expect(issue.message.length).toBeGreaterThan(0)
        expect(issue.message).not.toContain('[object') // never-echo of hostile shapes
      }
      // and with the healthy side first
      expect(() => inferRowDiffKeys(healthy, hostile as never)).not.toThrow()
      // both sides hostile at once
      expect(() => inferRowDiffKeys(hostile as never, hostile as never)).not.toThrow()
    }
  })

  it('a top-level unusable side (non-object) skips the aspect with its typed issue', () => {
    for (const unusable of [null, 42, 'profile', true]) {
      const result = inferRowDiffKeys(unusable as never, healthy)
      expect(result.candidates).toEqual([])
      expect(result.issues.map((i) => i.code)).toEqual(['invalid-profile-input'])
      expect(result.issues[0]?.side).toBe('A')
      expect(result.disclosure).toContain('a profile side is unusable')
    }
  })
})
