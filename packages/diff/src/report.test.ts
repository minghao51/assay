// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { describeDiffIssue } from './issues'
import type { DiffInput, DiffReport } from './report'
import { diffDatasets, hasSchemaOrProfileDifferences } from './report'

/**
 * The report-level pins (m6-0):
 * - **identity** — `drift(a, a)` is empty everywhere: no findings, no
 *   issues, exactly-0 defined metrics, empty new/vanished lists, and `0`
 *   survives the report rounding (pinned across numeric, categorical, and
 *   mixed shapes);
 * - **hostile input** — the m5-0 discipline: nothing throws, all
 *   independent problems arrive as typed, attributed issues in the
 *   documented order, aspects from an unusable side are skipped *with* an
 *   issue (never fabricated findings), `__proto__` spellings are inert,
 *   and issue messages echo offending values exactly (never rounded or
 *   mangled);
 * - **determinism** — identical inputs → byte-identical JSON.
 */

const numericStats = (mean: number, stddev: number, p50: number, p90: number) => ({
  min: mean - 10 * stddev,
  max: mean + 10 * stddev,
  mean,
  stddev,
  quantiles: { p50, p90, p95: p90 + 1, p99: p90 + 2 },
})

const numericColumn = (
  name: string,
  mean: number,
  stddev: number,
  p50 = mean,
  p90 = mean + stddev,
) => ({
  name,
  type: 'DOUBLE',
  kind: 'numeric' as const,
  nullCount: 0,
  distinctCount: 900,
  numeric: numericStats(mean, stddev, p50, p90),
})

const categoricalColumn = (name: string, topK: { value: string; count: number }[]) => ({
  name,
  type: 'VARCHAR',
  kind: 'categorical' as const,
  nullCount: 0,
  distinctCount: topK.length,
  categorical: { topK },
})

const input = (overrides: Partial<DiffInput> = {}): DiffInput => ({
  schemaA: [
    { name: 'id', type: 'BIGINT' },
    { name: 'amount', type: 'DOUBLE' },
    { name: 'country', type: 'VARCHAR' },
  ],
  schemaB: [
    { name: 'id', type: 'BIGINT' },
    { name: 'amount', type: 'DOUBLE' },
    { name: 'country', type: 'VARCHAR' },
  ],
  profileA: {
    rowCount: 1000,
    columns: [
      numericColumn('amount', 100, 20),
      categoricalColumn('country', [
        { value: 'US', count: 600 },
        { value: 'GB', count: 400 },
      ]),
    ],
  },
  profileB: {
    rowCount: 1000,
    columns: [
      numericColumn('amount', 100, 20),
      categoricalColumn('country', [
        { value: 'US', count: 600 },
        { value: 'GB', count: 400 },
      ]),
    ],
  },
  ...overrides,
})

describe('diffDatasets — identity pins across shapes', () => {
  it('mixed shape: drift(a,a) has no findings, no issues, exactly-0 metrics', () => {
    const report = diffDatasets(input())
    expect(report.schemaDrift).toEqual([])
    expect(report.issues).toEqual([])
    expect(report.columnDeltas).toHaveLength(2)
    for (const delta of report.columnDeltas) {
      if (delta.numeric) {
        expect(delta.numeric.meanShiftStandardized).toBe(0)
        expect(delta.numeric.varianceShiftStandardized).toBe(0)
        expect(delta.numeric.p50Shift).toBe(0)
        expect(delta.numeric.p90Shift).toBe(0)
      }
      if (delta.categorical) {
        expect(delta.categorical.totalVariation).toBe(0)
        expect(delta.categorical.newCategories).toEqual([])
        expect(delta.categorical.vanishedCategories).toEqual([])
      }
    }
    expect(hasSchemaOrProfileDifferences(report)).toBe(false)
  })

  it('identity survives the report rounding: roundForReport(0) is 0', () => {
    const report = diffDatasets(input())
    const amounts = report.columnDeltas.find((d) => d.column === 'amount')?.numeric
    expect(amounts?.meanShiftStandardized).toBe(0)
    // and the rounded twin of the identity metric is the identity metric
    expect(Object.is(amounts?.meanShiftStandardized, -0)).toBe(false)
  })

  it('pure-categorical and empty-profile shapes also identify to zero', () => {
    const categoricalOnly = input({
      schemaA: [{ name: 'country', type: 'VARCHAR' }],
      schemaB: [{ name: 'country', type: 'VARCHAR' }],
      profileA: {
        rowCount: 10,
        columns: [categoricalColumn('country', [{ value: 'US', count: 10 }])],
      },
    })
    // profileB deliberately a *deep copy*: identity must not depend on reference equality
    const b = JSON.parse(JSON.stringify(categoricalOnly.profileA))
    const report = diffDatasets({ ...categoricalOnly, profileB: b })
    expect(report.schemaDrift).toEqual([])
    expect(report.columnDeltas[0]?.categorical?.totalVariation).toBe(0)
    expect(hasSchemaOrProfileDifferences(report)).toBe(false)

    const empty = input({
      profileA: { rowCount: 0, columns: [] },
      profileB: { rowCount: 0, columns: [] },
    })
    expect(diffDatasets(empty)).toEqual({
      schemaDrift: [],
      columnDeltas: [],
      issues: [],
    })
  })
})

describe('diffDatasets — a drifted pair produces the expected findings', () => {
  it('schema drift first, deltas second, zero-state honest (the aspect order)', () => {
    const report = diffDatasets(
      input({
        schemaB: [
          { name: 'id', type: 'BIGINT' },
          { name: 'amount', type: 'INTEGER' }, // same family (numeric)
          { name: 'country', type: 'VARCHAR' },
          { name: 'arrived', type: 'TIMESTAMP' }, // added
          // 'gone' removed below via profile mismatch is NOT drift — schemas rule
        ],
        profileB: {
          rowCount: 1000,
          columns: [
            numericColumn('amount', 130, 25, 128, 180),
            categoricalColumn('country', [
              { value: 'US', count: 900 },
              { value: 'DE', count: 100 },
            ]),
          ],
        },
      }),
    )
    expect(report.schemaDrift.map((f) => `${f.kind}:${f.column}`)).toEqual([
      'type-changed-same-family:amount', // 'amount' < 'arrived' in code-unit order
      'column-added:arrived',
    ])
    const country = report.columnDeltas.find((d) => d.column === 'country')?.categorical
    expect(country?.totalVariation).toBeGreaterThan(0)
    expect(country?.newCategories).toEqual([{ value: 'DE', count: 100 }])
    expect(country?.vanishedCategories).toEqual([{ value: 'GB', count: 400 }])
    expect(hasSchemaOrProfileDifferences(report)).toBe(true)
  })
})

describe('diffDatasets — hostile-input probes (m5-0 discipline)', () => {
  it('never throws over the hostile matrix; problems arrive as typed issues', () => {
    const inputs: unknown[] = [
      null,
      42,
      'report',
      [],
      {},
      { schemaA: null, schemaB: null, profileA: null, profileB: null },
      {
        schemaA: [{ name: 'x', type: 'BIGINT' }],
        schemaB: [{ name: 'x', type: NaN }, { name: 'y' }, 'junk', 42],
        profileA: { rowCount: -5, columns: 'nope' },
        profileB: { rowCount: NaN, columns: [null, 42, { name: 'z', kind: 'weird' }] },
      },
    ]
    for (const hostile of inputs) {
      let report: DiffReport | undefined
      expect(() => {
        report = diffDatasets(hostile as DiffInput)
      }).not.toThrow()
      expect(report).toBeDefined()
      expect(Array.isArray(report?.schemaDrift)).toBe(true)
      expect(Array.isArray(report?.columnDeltas)).toBe(true)
      expect(Array.isArray(report?.issues)).toBe(true)
      for (const issue of report?.issues ?? []) {
        expect(typeof issue.message).toBe('string')
        expect(issue.message.length).toBeGreaterThan(0)
      }
    }
  })

  it('a throwing getter degrades to an issue, never a throw', () => {
    const evilProfile = {
      get rowCount(): number {
        throw new Error('boom')
      },
      columns: [],
    }
    const report = diffDatasets(
      input({
        profileA: evilProfile as unknown as DiffInput['profileA'],
      }),
    )
    expect(report.issues.some((issue) => issue.code === 'invalid-profile-input')).toBe(true)
    expect(report.issues.some((issue) => issue.code === 'invalid-input')).toBe(false)
  })

  it('an unreadable Proxy degrades to an issue, never a throw', () => {
    const evil = new Proxy(
      {},
      {
        get() {
          throw new Error('proxy says no')
        },
      },
    )
    const report = diffDatasets(input({ profileA: evil as DiffInput['profileA'] }))
    expect(report.issues.some((issue) => issue.code === 'invalid-profile-input')).toBe(true)
  })

  it('missing input keys skip their aspects WITH an issue — no fabricated findings', () => {
    const partial = {
      schemaB: [{ name: 'x', type: 'BIGINT' }],
      profileA: { rowCount: 1, columns: [] },
      profileB: { rowCount: 1, columns: [] },
    } as unknown as DiffInput
    const report = diffDatasets(partial)
    expect(report.schemaDrift).toEqual([]) // never "everything added" from an empty stand-in
    expect(report.columnDeltas).toEqual([])
    expect(report.issues).toEqual([
      {
        code: 'invalid-input',
        message: expect.stringContaining('input.schemaA is missing or unreadable'),
      },
    ])
  })

  it('collects issues across all sides in the documented order', () => {
    const report = diffDatasets({
      schemaA: [{ name: '', type: 'BIGINT' }] as never,
      schemaB: null as never,
      profileA: { rowCount: NaN, columns: [] } as never,
      profileB: 'nope' as never,
    })
    expect(report.issues.map((issue) => `${issue.code}:${issue.side ?? '-'}`)).toEqual([
      'invalid-schema-input:A',
      'invalid-schema-input:B',
      'invalid-profile-input:A',
      'invalid-profile-input:B',
    ])
  })

  it('hostile numbers never leak into metrics: NaN/±Infinity stats are issues + null', () => {
    const report = diffDatasets(
      input({
        profileA: {
          rowCount: 1000,
          columns: [
            {
              name: 'amount',
              type: 'DOUBLE',
              kind: 'numeric',
              nullCount: 0,
              distinctCount: 900,
              numeric: {
                min: NaN,
                max: Infinity,
                mean: NaN,
                stddev: -5,
                quantiles: { p50: 100, p90: NaN, p95: 150, p99: Infinity },
              },
            },
          ],
        },
      }),
    )
    const delta = report.columnDeltas[0]
    expect(delta?.numeric?.meanShiftStandardized).toBeNull() // A's mean was NaN
    expect(delta?.numeric?.varianceShiftStandardized).toBeNull() // A's stddev was -5 → treated unknown
    expect(delta?.numeric?.p50Shift).toBe(0) // 100 − 100: the finite cutpoints still compare
    expect(delta?.numeric?.p90Shift).toBeNull() // A's p90 was NaN
    expect(delta?.numeric?.bins).toEqual({ edges: [100, 150] }) // finite cutpoints survive
    const messages = report.issues.map((issue) => issue.message).join('\n')
    expect(report.issues.every((issue) => issue.code === 'invalid-column-profile')).toBe(true)
    expect(messages).toContain('stddev must be non-negative')
  })

  it('counts that cannot exist are typed issues and suppress dependent findings', () => {
    const report = diffDatasets(
      input({
        profileA: {
          rowCount: 100,
          columns: [
            {
              name: 'country',
              type: 'VARCHAR',
              kind: 'categorical',
              nullCount: 250, // > rowCount
              distinctCount: 400, // > non-null mass
              categorical: { topK: [{ value: 'US', count: 0 }] }, // count 0
            },
          ],
        },
      }),
    )
    expect(report.columnDeltas[0]?.categorical).toBeUndefined() // unusable payload
    const codes = report.issues.map((issue) => issue.code)
    expect(codes).toContain('invalid-column-profile')
    expect(report.issues.length).toBeGreaterThanOrEqual(3) // nullCount, distinctCount, topK — all collected
  })

  it('issue messages echo offending values exactly (never-echo lesson)', () => {
    const ugly = 0.30000000000000004 // exact double rendering — never re-formatted in a message
    const report = diffDatasets(
      input({
        profileA: {
          rowCount: 10,
          columns: [
            {
              name: 'country',
              type: 'VARCHAR',
              kind: 'categorical',
              nullCount: 1,
              distinctCount: 1,
              categorical: { topK: [{ value: 'US', count: ugly }] },
            },
          ],
        },
      }),
    )
    const issue = report.issues.find((issue) => issue.code === 'invalid-column-profile')
    expect(issue?.message).toContain(String(ugly)) // exact echo: String() IS the convention
    expect(issue?.message).not.toContain('0.3,') // no re-formatted/rounded rendering
  })

  it('unknown kinds degrade fail-closed to other (documented)', () => {
    const report = diffDatasets(
      input({
        profileA: {
          rowCount: 10,
          columns: [
            {
              name: 'country',
              type: 'VARCHAR',
              kind: 'weird' as never,
              nullCount: 0,
              distinctCount: 1,
            },
          ],
        },
      }),
    )
    expect(report.columnDeltas[0]?.kindA).toBe('other')
    expect(report.columnDeltas[0]?.categorical).toBeUndefined()
    expect(report.issues[0]?.code).toBe('invalid-column-profile')
  })

  it('__proto__ column names and category values are inert (Map/Set lookup only)', () => {
    const schema = [{ name: '__proto__', type: 'BIGINT' }]
    const report = diffDatasets(
      input({
        schemaA: schema,
        schemaB: [{ name: '__proto__', type: 'VARCHAR' }],
        profileA: {
          rowCount: 10,
          columns: [categoricalColumn('__proto__', [{ value: '__proto__', count: 10 }])],
        },
        profileB: {
          rowCount: 10,
          columns: [categoricalColumn('__proto__', [{ value: 'toString', count: 10 }])],
        },
      }),
    )
    expect(report.schemaDrift.map((f) => `${f.kind}:${f.column}`)).toEqual([
      'type-changed-cross-family:__proto__',
    ])
    expect(report.columnDeltas[0]?.categorical?.newCategories).toEqual([
      { value: 'toString', count: 10 },
    ])
    expect(report.columnDeltas[0]?.categorical?.vanishedCategories).toEqual([
      { value: '__proto__', count: 10 },
    ])
  })

  it('mismatched column sets are findings, not issues (that IS schema drift)', () => {
    const report = diffDatasets(
      input({
        schemaB: [{ name: 'id', type: 'BIGINT' }],
        profileB: { rowCount: 1000, columns: [] },
      }),
    )
    expect(report.issues).toEqual([])
    expect(report.schemaDrift.map((f) => `${f.kind}:${f.column}`)).toEqual([
      'column-removed:amount',
      'column-removed:country',
    ])
  })

  it('NUL-bearing names are input-hygiene issues; the honest remainder is still reported', () => {
    const report = diffDatasets(
      input({
        schemaA: [{ name: 'a\u0000b', type: 'BIGINT' }],
      }),
    )
    // A's NUL column is rejected with an issue; B's columns are then honestly
    // "added" relative to A's valid remainder (the issue discloses the drop).
    expect(report.issues).toEqual([
      {
        code: 'invalid-schema-input',
        message: expect.stringContaining('NUL character'),
        side: 'A',
        column: 'a\u0000b',
      },
    ])
    expect(report.schemaDrift.map((f) => `${f.kind}:${f.column}`)).toEqual([
      'column-added:amount', // column name ascending (UTF-16 code-unit order)
      'column-added:country',
      'column-added:id',
    ])
  })
})

describe('diffDatasets — determinism', () => {
  it('same input twice → byte-identical JSON', () => {
    const pair = input({
      schemaB: [
        { name: 'id', type: 'BIGINT' },
        { name: 'amount', type: 'INTEGER' },
        { name: 'country', type: 'VARCHAR' },
        { name: 'arrived', type: 'TIMESTAMP' },
      ],
      profileB: {
        rowCount: 1000,
        columns: [
          numericColumn('amount', 130, 25, 128, 180),
          categoricalColumn('country', [
            { value: 'US', count: 900 },
            { value: 'DE', count: 100 },
          ]),
        ],
      },
    })
    expect(JSON.stringify(diffDatasets(pair))).toBe(JSON.stringify(diffDatasets(pair)))
  })

  it('reports are JSON-stable: no undefined-valued keys, no -0 anywhere', () => {
    const report = diffDatasets(
      input({
        profileA: {
          rowCount: 10,
          columns: [
            {
              name: 'weird',
              type: 'DOUBLE',
              kind: 'numeric',
              nullCount: 0,
              distinctCount: 1,
              numeric: numericStats(-5, 0.5, -3, 7),
            },
          ],
        },
      }),
    )
    const text = JSON.stringify(report)
    expect(text).not.toContain('undefined')
    const walk = (node: unknown): void => {
      if (typeof node === 'number') {
        expect(Number.isFinite(node)).toBe(true)
        expect(Object.is(node, -0)).toBe(false)
      } else if (Array.isArray(node)) {
        node.forEach(walk)
      } else if (node !== null && typeof node === 'object') {
        Object.values(node).forEach(walk)
      }
    }
    walk(report)
    expect(JSON.parse(text)).toEqual(report)
  })
})

describe('describeDiffIssue — canonical rendering', () => {
  it('renders code, side, column, and message greppably', () => {
    expect(
      describeDiffIssue({
        code: 'invalid-column-profile',
        message: 'stddev must be non-negative',
        side: 'A',
        column: 'amount',
      }),
    ).toBe("invalid-column-profile [side A] (column 'amount'): stddev must be non-negative")
  })
})
