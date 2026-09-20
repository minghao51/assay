import { Field, List, Table, Utf8, tableFromArrays, vectorFromArray } from 'apache-arrow'
import { describe, expect, it } from 'vitest'
import {
  buildDiffAspectSamples,
  comparisonRowKey,
  composeDiffAspectQuery,
  composeDiffComparisonViewSql,
  diffEffectiveSampleLimit,
  readDiffAspectRows,
  readDiffTotalsRows,
  rowDiffCountExcess,
} from './diff-query'
import { ROW_DIFF_SAMPLE_HARD_MAX } from './diff-plan-wire'

describe('diff-query composition (m6-2)', () => {
  it('clamps the effective sample limit to the engine hard max (never refuses)', () => {
    expect(diffEffectiveSampleLimit(1)).toBe(1)
    expect(diffEffectiveSampleLimit(50)).toBe(50)
    expect(diffEffectiveSampleLimit(ROW_DIFF_SAMPLE_HARD_MAX)).toBe(ROW_DIFF_SAMPLE_HARD_MAX)
    expect(diffEffectiveSampleLimit(ROW_DIFF_SAMPLE_HARD_MAX + 1)).toBe(ROW_DIFF_SAMPLE_HARD_MAX)
  })

  it('wraps the exact aspect SQL in one outer LIMIT (inner SQL byte-identical)', () => {
    const inner = 'SELECT 1 AS "assay_count"'
    expect(composeDiffAspectQuery(inner, 7)).toBe(`SELECT * FROM (${inner}) LIMIT 7`)
    expect(composeDiffAspectQuery(inner, 7)).toContain(inner)
  })

  it('binds side B as a thin pass-through over the staged view', () => {
    expect(composeDiffComparisonViewSql('ds_b', 'assay_diff_d1')).toBe(
      'CREATE VIEW "ds_b" AS SELECT * FROM "assay_diff_d1"',
    )
  })

  it('renders B-side report keys as b:<ordinal>', () => {
    expect(comparisonRowKey(0)).toBe('b:0')
    expect(comparisonRowKey(42)).toBe('b:42')
  })
})

describe('rowDiffCountExcess (m6-2 result-sanity bounds)', () => {
  it('bounds added by side B, removed by side A, changed by the smaller side', () => {
    expect(rowDiffCountExcess('added', 3, 5, 3)).toBeNull()
    expect(rowDiffCountExcess('added', 4, 5, 3)).toMatch(/added/)
    expect(rowDiffCountExcess('removed', 5, 5, 9)).toBeNull()
    expect(rowDiffCountExcess('removed', 6, 5, 9)).toMatch(/removed/)
    expect(rowDiffCountExcess('changed', 3, 5, 3)).toBeNull()
    expect(rowDiffCountExcess('changed', 4, 5, 3)).toMatch(/changed/)
  })
})

describe('readDiffAspectRows / readDiffTotalsRows (m6-2 readers)', () => {
  it('reads an empty aspect as count 0 with no samples (the plan convention)', () => {
    expect(readDiffAspectRows(tableFromArrays({}), 'added')).toEqual({ count: 0, rows: [] })
  })

  it('reads side-qualified ordinals and changed-column lists', () => {
    const changed = vectorFromArray(
      [['val'], ['val', 'score']],
      new List(new Field('item', new Utf8())),
    )
    const table = new Table({
      assay_side: vectorFromArray(['A', 'A']),
      assay_row_ordinal: vectorFromArray([1n, 4n]),
      assay_changed: changed,
      sample_index: vectorFromArray([0n, 1n]),
      assay_count: vectorFromArray([2n, 2n]),
    })
    expect(readDiffAspectRows(table, 'changed')).toEqual({
      count: 2,
      rows: [
        { side: 'A', ordinal: 1, changedColumns: ['val'] },
        { side: 'A', ordinal: 4, changedColumns: ['val', 'score'] },
      ],
    })
  })

  it('fails loudly on an inconsistent count or a mismatched side', () => {
    const inconsistent = tableFromArrays({
      assay_side: ['B', 'B'],
      assay_row_ordinal: BigInt64Array.from([0n, 1n]),
      sample_index: BigInt64Array.from([0n, 1n]),
      assay_count: BigInt64Array.from([2n, 3n]),
    })
    expect(() => readDiffAspectRows(inconsistent, 'added')).toThrow(/inconsistent/)
    const wrongSide = tableFromArrays({
      assay_side: ['A'],
      assay_row_ordinal: BigInt64Array.from([0n]),
      sample_index: BigInt64Array.from([0n]),
      assay_count: BigInt64Array.from([1n]),
    })
    expect(() => readDiffAspectRows(wrongSide, 'added')).toThrow(/unexpected side/)
  })

  it('reads the three totals arms and rejects duplicates/unknown aspects', () => {
    const totals = tableFromArrays({
      assay_aspect: ['added', 'removed', 'changed'],
      assay_count: BigInt64Array.from([1n, 2n, 3n]),
    })
    expect([...readDiffTotalsRows(totals)]).toEqual([
      ['added', 1],
      ['removed', 2],
      ['changed', 3],
    ])
    const duplicate = tableFromArrays({
      assay_aspect: ['added', 'added', 'changed'],
      assay_count: BigInt64Array.from([1n, 2n, 3n]),
    })
    expect(() => readDiffTotalsRows(duplicate)).toThrow(/more than once/)
    const unknown = tableFromArrays({
      assay_aspect: ['added', 'removed', 'nope'],
      assay_count: BigInt64Array.from([1n, 2n, 3n]),
    })
    expect(() => readDiffTotalsRows(unknown)).toThrow(/unknown aspect/)
  })
})

describe('buildDiffAspectSamples (m6-2 side-qualified keys)', () => {
  it('resolves A-side ordinals to logical row keys and B-side to b:<ordinal>', () => {
    const aKeys = new Map([
      [1, 'base:anchor#1'],
      [4, 'ins:anchor#0'],
    ])
    expect(
      buildDiffAspectSamples(
        [
          { side: 'A', ordinal: 1, changedColumns: null },
          { side: 'A', ordinal: 4, changedColumns: null },
        ],
        'removed',
        aKeys,
      ),
    ).toEqual([
      { side: 'A', rowKey: 'base:anchor#1' },
      { side: 'A', rowKey: 'ins:anchor#0' },
    ])
    expect(
      buildDiffAspectSamples([{ side: 'B', ordinal: 7, changedColumns: null }], 'added', aKeys),
    ).toEqual([{ side: 'B', rowKey: 'b:7' }])
  })

  it('fails loudly when an A-side ordinal does not resolve (never a positional fake)', () => {
    expect(() =>
      buildDiffAspectSamples(
        [{ side: 'A', ordinal: 9, changedColumns: null }],
        'removed',
        new Map(),
      ),
    ).toThrow(/did not resolve/)
  })
})
