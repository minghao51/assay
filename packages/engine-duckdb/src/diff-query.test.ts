// SPDX-License-Identifier: AGPL-3.0-or-later

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
  it('bounds added by side B and removed by side A (unconditional)', () => {
    expect(rowDiffCountExcess('added', 3, 5, 3)).toBeNull()
    expect(rowDiffCountExcess('added', 4, 5, 3)).toMatch(/added/)
    expect(rowDiffCountExcess('removed', 5, 5, 9)).toBeNull()
    expect(rowDiffCountExcess('removed', 6, 5, 9)).toMatch(/removed/)
  })

  it('bounds changed by rowCountA × rowCountB (keys need not be unique)', () => {
    expect(rowDiffCountExcess('changed', 9, 5, 3)).toBeNull() // 9 > min(5,3) — the old bound was wrong
    expect(rowDiffCountExcess('changed', 15, 5, 3)).toBeNull()
    expect(rowDiffCountExcess('changed', 16, 5, 3)).toMatch(/changed/)
    // A zero-row side can produce no pair at all.
    expect(rowDiffCountExcess('changed', 0, 0, 5)).toBeNull()
    expect(rowDiffCountExcess('changed', 1, 0, 5)).toMatch(/changed/)
    expect(rowDiffCountExcess('changed', 1, 5, 0)).toMatch(/changed/)
  })

  it('compares the changed bound without overflowing the safe-integer range', () => {
    // 2^27 × 2^27 = 2^54 > MAX_SAFE_INTEGER: every safe count is inside it.
    const side = 2 ** 27
    expect(rowDiffCountExcess('changed', Number.MAX_SAFE_INTEGER, side, side)).toBeNull()
    // A product that lands exactly on the safe boundary still bounds a count one past it.
    const big = 2 ** 26
    const product = big * big // 2^52, safely representable
    expect(rowDiffCountExcess('changed', product, big, big)).toBeNull()
    expect(rowDiffCountExcess('changed', product + 1, big, big)).toMatch(/changed/)
  })

  it('accepts the m6-1 legal NULL-key grouping count (2×2 group → changed 4)', () => {
    // Two NULL-key rows per side group into a 2×2 pair set: changed 4 > min(2,2).
    expect(rowDiffCountExcess('changed', 4, 2, 2)).toBeNull()
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

  it('normalizes unsorted ordinals to ascending order and is stable on ties', () => {
    // The plan emits its sample set in engine-join order; the reader presents
    // it ascending by ordinal. Equal ordinals are legal (non-unique keys and
    // grouped NULL keys) and keep the plan's own relative order.
    const changed = vectorFromArray(
      [['a'], ['b'], ['c'], ['d']],
      new List(new Field('item', new Utf8())),
    )
    const table = new Table({
      assay_side: vectorFromArray(['A', 'A', 'A', 'A']),
      assay_row_ordinal: vectorFromArray([1n, 0n, 1n, 0n]),
      assay_changed: changed,
      sample_index: vectorFromArray([0n, 1n, 2n, 3n]),
      assay_count: vectorFromArray([4n, 4n, 4n, 4n]),
    })
    expect(readDiffAspectRows(table, 'changed')).toEqual({
      count: 4,
      rows: [
        { side: 'A', ordinal: 0, changedColumns: ['b'] },
        { side: 'A', ordinal: 0, changedColumns: ['d'] },
        { side: 'A', ordinal: 1, changedColumns: ['a'] },
        { side: 'A', ordinal: 1, changedColumns: ['c'] },
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

  it('surfaces duplicate A-side ordinals honestly (non-unique / grouped NULL keys)', () => {
    // A 2×2 NULL-key group yields the ordinals 0,0,1,1: each pair names its
    // A row, so two samples share a logical row key but carry their own
    // changed-column lists — a pair set, not a set of distinct A rows.
    const aKeys = new Map([
      [0, 'base:anchor#0'],
      [1, 'base:anchor#1'],
    ])
    expect(
      buildDiffAspectSamples(
        [
          { side: 'A', ordinal: 0, changedColumns: ['val'] },
          { side: 'A', ordinal: 0, changedColumns: ['score'] },
          { side: 'A', ordinal: 1, changedColumns: ['val'] },
          { side: 'A', ordinal: 1, changedColumns: ['score'] },
        ],
        'changed',
        aKeys,
      ),
    ).toEqual([
      { side: 'A', rowKey: 'base:anchor#0', changedColumns: ['val'] },
      { side: 'A', rowKey: 'base:anchor#0', changedColumns: ['score'] },
      { side: 'A', rowKey: 'base:anchor#1', changedColumns: ['val'] },
      { side: 'A', rowKey: 'base:anchor#1', changedColumns: ['score'] },
    ])
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
