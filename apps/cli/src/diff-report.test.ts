// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for the m6-3 diff report model (pure half): the aspect-order
 * renderers, the anchor-free row-key forms, the "differs" predicate the exit
 * code and verdict share, and renderer byte-determinism. The full-pipeline
 * byte pins live in `diff.integration.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ColumnDistributionDelta, DiffReport } from '@assay/diff'
import { ROW_DIFF_SAMPLE_HARD_MAX } from '@assay/engine-duckdb/node'
import type { EngineRowDiffResult } from '@assay/engine-duckdb/node'
import {
  buildDiffRowDiffReport,
  columnDeltaDiffers,
  columnDeltaLine,
  diffReportIdentical,
  displayDiffRowKey,
  divergentColumnDeltas,
  exportDiffRowKey,
  renderHumanDiffReport,
  renderJsonDiffReport,
  schemaFindingLine,
} from './report.js'
import type { DiffCommandReport, DiffReportMeta } from './report.js'

// AR-C2 divergent-constant pin: force the `./node` seam's DIFF clamp and
// VALIDATION clamp apart for this file. Both are 100 in production, so a pin
// that interpolated the imported constant would survive a regression to the
// validation constant; with the mock they disagree (137 vs 3) and the
// renderer must name the DIFF value. Swapping the constant in
// `diffTruncationLine` therefore fails the assertion below.
vi.mock('@assay/engine-duckdb/node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@assay/engine-duckdb/node')>()
  return { ...actual, ROW_DIFF_SAMPLE_HARD_MAX: 137, VALIDATION_SAMPLE_HARD_MAX: 3 }
})

const emptyDiff: DiffReport = { schemaDrift: [], columnDeltas: [], issues: [] }

function numericDelta(
  overrides: Partial<NonNullable<ColumnDistributionDelta['numeric']>> = {},
): ColumnDistributionDelta {
  return {
    column: 'amount',
    typeA: 'BIGINT',
    typeB: 'BIGINT',
    kindA: 'numeric',
    kindB: 'numeric',
    numeric: {
      meanShiftStandardized: 0,
      varianceShiftStandardized: 0,
      p50Shift: 0,
      p90Shift: 0,
      bins: { edges: [] },
      ...overrides,
    },
  }
}

const zeroRowDiff: EngineRowDiffResult = {
  rowCountA: 3,
  rowCountB: 3,
  aspects: [
    { aspect: 'added', count: 0, samples: [] },
    { aspect: 'removed', count: 0, samples: [] },
    { aspect: 'changed', count: 0, samples: [] },
  ],
}

const META: DiffReportMeta = {
  nameA: 'a.csv',
  nameB: 'b.csv',
  formatA: 'csv',
  formatB: 'csv',
  keys: ['id'],
  keySource: 'explicit',
  inference: null,
  sampleLimitRequested: 20,
  sampleLimitEffective: 20,
}

describe('diff report — pure helpers', () => {
  it('columnDeltaDiffers is true only for a defined non-zero signal', () => {
    expect(columnDeltaDiffers(numericDelta())).toBe(false)
    expect(columnDeltaDiffers(numericDelta({ meanShiftStandardized: 0.5 }))).toBe(true)
    expect(columnDeltaDiffers(numericDelta({ varianceShiftStandardized: null }))).toBe(false)
    const categorical: ColumnDistributionDelta = {
      column: 'region',
      typeA: 'VARCHAR',
      typeB: 'VARCHAR',
      kindA: 'categorical',
      kindB: 'categorical',
      categorical: {
        totalVariation: 0,
        newCategories: [{ value: 'DE', count: 1 }],
        vanishedCategories: [],
      },
    }
    expect(columnDeltaDiffers(categorical)).toBe(true)
  })

  it('diffReportIdentical/divergentColumnDeltas are the single identity decision (q-4)', () => {
    const zeroColumns = [numericDelta()]
    expect(divergentColumnDeltas(zeroColumns)).toEqual([])
    expect(
      diffReportIdentical({
        diff: { schemaDrift: [], columnDeltas: zeroColumns, issues: [] },
        rowDiff: buildDiffRowDiffReport(zeroRowDiff, true),
      }),
    ).toBe(true)

    const divergent = [numericDelta({ meanShiftStandardized: 0.5 })]
    expect(divergentColumnDeltas(divergent)).toHaveLength(1)
    expect(
      diffReportIdentical({
        diff: { schemaDrift: [], columnDeltas: divergent, issues: [] },
        rowDiff: buildDiffRowDiffReport(zeroRowDiff, true),
      }),
    ).toBe(false)

    // Any row-diff aspect count also flips the shared verdict.
    expect(
      diffReportIdentical({
        diff: emptyDiff,
        rowDiff: buildDiffRowDiffReport(
          {
            rowCountA: 3,
            rowCountB: 4,
            aspects: [
              { aspect: 'added', count: 1, samples: [{ side: 'B', rowKey: 'b:3' }] },
              { aspect: 'removed', count: 0, samples: [] },
              { aspect: 'changed', count: 0, samples: [] },
            ],
          },
          true,
        ),
      }),
    ).toBe(false)
  })

  it('anchor-free row keys render the base and comparison forms', () => {
    expect(displayDiffRowKey('base:#12')).toBe('base #12')
    expect(displayDiffRowKey('b:3')).toBe('b #3')
    expect(exportDiffRowKey('base:#12')).toBe('base:12')
    expect(exportDiffRowKey('b:3')).toBe('b:3')
    // An unparsable key degrades honestly, never a positional fake.
    expect(displayDiffRowKey('mystery')).toBe('unknown row')
  })

  it('buildDiffRowDiffReport computes samplesComplete from count vs returned', () => {
    const report = buildDiffRowDiffReport(
      {
        rowCountA: 3,
        rowCountB: 3,
        aspects: [
          { aspect: 'added', count: 120, samples: [{ side: 'B', rowKey: 'b:1' }] },
          { aspect: 'removed', count: 0, samples: [] },
          {
            aspect: 'changed',
            count: 1,
            samples: [{ side: 'A', rowKey: 'base:#1', changedColumns: ['amount'] }],
          },
        ],
      },
      false,
    )
    expect(report.added.count).toBe(120)
    expect(report.added.samplesReturned).toBe(1)
    expect(report.added.samplesComplete).toBe(false)
    expect(report.changed.samplesComplete).toBe(true)
    expect(report.changedComparable).toBe(false)
  })

  it('schema/column finding lines are stable and kind-dispatched', () => {
    expect(schemaFindingLine({ kind: 'column-added', column: 'score', typeB: 'BIGINT' })).toBe(
      'column-added: score — B BIGINT',
    )
    expect(schemaFindingLine({ kind: 'column-removed', column: 'old', typeA: 'INTEGER' })).toBe(
      'column-removed: old — A INTEGER',
    )
    expect(
      schemaFindingLine({
        kind: 'type-changed-cross-family',
        column: 'region',
        typeA: 'VARCHAR',
        typeB: 'INTEGER',
      }),
    ).toBe('type-changed-cross-family: region — VARCHAR -> INTEGER')
    expect(
      schemaFindingLine({
        kind: 'nullability-changed',
        column: 'note',
        nullShareA: 0,
        nullShareB: 1 / 6,
      }),
    ).toBe('nullability-changed: note — null share A 0 -> B 0.166667')
    expect(columnDeltaLine(numericDelta())).toBe(
      'amount — numeric: mean shift 0, variance shift 0, p50 shift 0, p90 shift 0',
    )
    const categorical: ColumnDistributionDelta = {
      column: 'region',
      typeA: 'VARCHAR',
      typeB: 'VARCHAR',
      kindA: 'categorical',
      kindB: 'categorical',
      categorical: {
        totalVariation: 1 / 3,
        newCategories: [{ value: 'DE', count: 1 }],
        vanishedCategories: [],
      },
    }
    expect(columnDeltaLine(categorical)).toBe(
      'region — categorical: total variation 0.333333, new: [DE], vanished: []',
    )
    expect(
      columnDeltaLine({
        column: 'tags',
        typeA: 'INTEGER[]',
        typeB: 'BIGINT[]',
        kindA: 'other',
        kindB: 'other',
      }),
    ).toBe('tags — other -> other: no comparable metrics')
  })

  it('the diff truncation clamp names ROW_DIFF_SAMPLE_HARD_MAX, not the validation constant (AR-C2)', () => {
    // The mock above makes the two constants diverge (137 vs 3) so this pin
    // cannot be satisfied by reading the validation clamp.
    expect(ROW_DIFF_SAMPLE_HARD_MAX).toBe(137)
    const report: DiffCommandReport = {
      diff: emptyDiff,
      rowDiff: buildDiffRowDiffReport(
        {
          rowCountA: 1,
          rowCountB: 121,
          aspects: [
            { aspect: 'added', count: 120, samples: [{ side: 'B', rowKey: 'b:1' }] },
            { aspect: 'removed', count: 0, samples: [] },
            { aspect: 'changed', count: 0, samples: [] },
          ],
        },
        true,
      ),
    }
    const human = renderHumanDiffReport(report, {
      ...META,
      sampleLimitRequested: 500,
      sampleLimitEffective: 100,
    })
    expect(human).toContain('    … 119 more added rows not shown (sample limit 500 clamped to 137)')
    expect(human).not.toContain('clamped to 3')
  })

  it('renderers are byte-deterministic and carry the json verdict', () => {
    const report: DiffCommandReport = {
      diff: emptyDiff,
      rowDiff: buildDiffRowDiffReport(zeroRowDiff, true),
    }
    const humanFirst = renderHumanDiffReport(report, META)
    const humanSecond = renderHumanDiffReport(report, META)
    expect(humanSecond).toBe(humanFirst)
    expect(humanFirst).toContain(
      'verdict: IDENTICAL — no differences found (row diff ran on keys: id; schema/profile-level identity alone would not prove row identity)',
    )

    const jsonFirst = renderJsonDiffReport(report, META)
    const jsonSecond = renderJsonDiffReport(report, META)
    expect(jsonSecond).toBe(jsonFirst)
    const payload = JSON.parse(jsonFirst) as { report: string; identical: boolean; keys: string[] }
    expect(payload.report).toBe('assay-diff-report')
    expect(payload.identical).toBe(true)
    expect(payload.keys).toEqual(['id'])
  })
})
