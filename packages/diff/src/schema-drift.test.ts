// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { describeDiffIssue } from './issues'
import type { SchemaDriftFinding } from './schema-drift'
import { nullabilityDrift, schemaDrift } from './schema-drift'

/**
 * Schema-drift pins (m6-0): added/removed columns by exact case-sensitive
 * name; type changes classified through the m5-1 classifier REUSED from
 * `@assay/validation` (same-family vs cross-family vs unclassifiable);
 * nullability drift from the profiles' null shares (engine DESCRIBE carries
 * no nullability — documented); findings in the documented deterministic
 * order; hostile schemas yield issues, never fabricated findings.
 */

const findingKey = (f: SchemaDriftFinding) => `${f.kind}:${f.column}`

describe('schemaDrift — classification (reusing the m5-1 classifier)', () => {
  it('pins added/removed/type-changed findings in the documented order', () => {
    const result = schemaDrift(
      [
        { name: 'id', type: 'BIGINT' },
        { name: 'name', type: 'VARCHAR' },
        { name: 'score', type: 'INTEGER' },
        { name: 'tags', type: 'INTEGER[]' },
      ],
      [
        { name: 'email', type: 'VARCHAR' },
        { name: 'id', type: 'BIGINT' },
        { name: 'score', type: 'BIGINT' },
        { name: 'tags', type: 'VARCHAR[]' },
      ],
    )
    expect(result.issues).toEqual([])
    expect(result.findings.map(findingKey)).toEqual([
      'column-added:email',
      'column-removed:name',
      'type-changed-same-family:score',
      'type-changed-unclassifiable:tags',
    ])
    const score = result.findings[2]
    expect(score).toMatchObject({
      kind: 'type-changed-same-family',
      column: 'score',
      typeA: 'INTEGER',
      typeB: 'BIGINT',
      familyA: 'numeric',
      familyB: 'numeric',
    })
    const tags = result.findings[3]
    // nested-shape drift: the textual difference is the finding; families 'other'
    expect(tags).toMatchObject({
      kind: 'type-changed-unclassifiable',
      typeA: 'INTEGER[]',
      typeB: 'VARCHAR[]',
      familyA: 'other',
      familyB: 'other',
    })
  })

  it('classifies cross-family changes', () => {
    const result = schemaDrift([{ name: 'x', type: 'INTEGER' }], [{ name: 'x', type: 'VARCHAR' }])
    expect(result.findings).toEqual([
      {
        kind: 'type-changed-cross-family',
        column: 'x',
        typeA: 'INTEGER',
        typeB: 'VARCHAR',
        familyA: 'numeric',
        familyB: 'textual',
      },
    ])
  })

  it('classifies nested-into-scalar and alias-free spellings as unclassifiable', () => {
    const struct = schemaDrift(
      [{ name: 'x', type: 'INTEGER' }],
      [{ name: 'x', type: 'STRUCT(a INTEGER)' }],
    )
    expect(struct.findings[0]?.kind).toBe('type-changed-unclassifiable')
    const unknown = schemaDrift(
      [{ name: 'x', type: 'WEIRD_TYPE' }],
      [{ name: 'x', type: 'VARCHAR' }],
    )
    expect(unknown.findings[0]?.kind).toBe('type-changed-unclassifiable')
  })

  it('reports no findings for identical schemas (identity pin)', () => {
    const schema = [
      { name: 'id', type: 'BIGINT' },
      { name: 'VECTOR(a DOUBLE)[]', type: 'VARCHAR' },
    ]
    expect(schemaDrift(schema, schema).findings).toEqual([])
  })

  it('matches names exactly and case-sensitively (documented)', () => {
    const result = schemaDrift([{ name: 'ID', type: 'BIGINT' }], [{ name: 'id', type: 'BIGINT' }])
    expect(result.findings.map(findingKey)).toEqual(['column-removed:ID', 'column-added:id'])
  })

  it('parameterized spellings stay same-family via the reused classifier', () => {
    const result = schemaDrift(
      [{ name: 'x', type: 'DECIMAL(10,2)' }],
      [{ name: 'x', type: 'DOUBLE' }],
    )
    expect(result.findings[0]?.kind).toBe('type-changed-same-family')
    const widened = schemaDrift(
      [{ name: 'x', type: 'VARCHAR(3)' }],
      [{ name: 'x', type: 'VARCHAR' }],
    )
    expect(widened.findings[0]?.kind).toBe('type-changed-same-family')
  })
})

describe('schemaDrift — hostile input discipline', () => {
  it('an unusable side skips the aspect with its issue — never fabricated findings', () => {
    const result = schemaDrift(null as never, [{ name: 'x', type: 'BIGINT' }])
    expect(result.findings).toEqual([])
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]?.code).toBe('invalid-schema-input')
    expect(result.issues[0]?.side).toBe('A')
  })

  it('collects all independent entry problems (never first-error abort)', () => {
    const result = schemaDrift(
      [null, { name: 'x', type: '' }, { name: 'ok', type: 'BIGINT' }] as never,
      [{ name: 'ok', type: 'BIGINT' }],
    )
    expect(result.findings).toEqual([])
    expect(result.issues).toHaveLength(2)
    expect(result.issues.every((issue) => issue.code === 'invalid-schema-input')).toBe(true)
    expect(describeDiffIssue(result.issues[0])).toContain('entry 0')
  })

  it('duplicates are typed issues with first-occurrence-wins (never a silent merge)', () => {
    const result = schemaDrift(
      [
        { name: 'x', type: 'INTEGER' },
        { name: 'x', type: 'DOUBLE' },
      ],
      [{ name: 'x', type: 'INTEGER' }],
    )
    expect(result.findings).toEqual([]) // the first occurrence (INTEGER) matched
    expect(result.issues).toEqual([
      {
        code: 'duplicate-column-name',
        message: expect.stringContaining('first occurrence is kept'),
        side: 'A',
        column: 'x',
      },
    ])
  })

  it('NUL-bearing names are rejected as input hygiene (parity with m5-1)', () => {
    const result = schemaDrift(
      [{ name: 'a\u0000b', type: 'BIGINT' }],
      [{ name: 'a\u0000b', type: 'BIGINT' }],
    )
    expect(result.findings).toEqual([]) // both entries rejected → nothing to compare
    expect(result.issues).toHaveLength(2)
    expect(result.issues[0]?.code).toBe('invalid-schema-input')
    expect(result.issues[0]?.side).toBe('A')
    expect(result.issues[1]?.side).toBe('B')
  })
})

describe('nullabilityDrift — profile-derived, documented', () => {
  const profile = (rowCount: number, columns: { name: string; nullCount: number }[]) => ({
    rowCount,
    columns: columns.map((c) => ({
      ...c,
      type: 'VARCHAR',
      kind: 'categorical' as const,
      distinctCount: 1,
      categorical: { topK: [] },
    })),
  })

  it('fires when exactly one side observed a NULL; both shares travel', () => {
    const result = nullabilityDrift(
      profile(100, [{ name: 'x', nullCount: 0 }]),
      profile(100, [{ name: 'x', nullCount: 25 }]),
    )
    expect(result.issues).toEqual([])
    expect(result.findings).toEqual([
      { kind: 'nullability-changed', column: 'x', nullShareA: 0, nullShareB: 0.25 },
    ])
  })

  it('does not fire when both sides observed nulls, or neither did', () => {
    const both = nullabilityDrift(
      profile(100, [{ name: 'x', nullCount: 5 }]),
      profile(100, [{ name: 'x', nullCount: 9 }]),
    )
    expect(both.findings).toEqual([])
    const neither = nullabilityDrift(
      profile(100, [{ name: 'x', nullCount: 0 }]),
      profile(100, [{ name: 'x', nullCount: 0 }]),
    )
    expect(neither.findings).toEqual([])
  })

  it('suppresses the finding when a side has zero rows (no observation)', () => {
    const result = nullabilityDrift(profile(0, []), profile(100, [{ name: 'x', nullCount: 25 }]))
    expect(result.findings).toEqual([])
  })

  it('identity: comparing a profile to itself yields no findings', () => {
    const p = profile(100, [
      { name: 'x', nullCount: 0 },
      { name: 'y', nullCount: 40 },
    ])
    expect(nullabilityDrift(p, p).findings).toEqual([])
  })
})
