/**
 * Unit tests for the m6-3 diff report model (pure half): the aspect-order
 * renderers, the anchor-free row-key forms, the "differs" predicate the exit
 * code and verdict share, and renderer byte-determinism. The full-pipeline
 * byte pins live in `diff.integration.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import type { ColumnDistributionDelta, DiffReport } from '@assay/diff'
import type { EngineRowDiffResult } from '@assay/engine-duckdb/node'
import {
  buildDiffRowDiffReport,
  columnDeltaDiffers,
  columnDeltaLine,
  displayDiffRowKey,
  exportDiffRowKey,
  renderHumanDiffReport,
  renderJsonDiffReport,
  schemaFindingLine,
} from './report'
import type { DiffCommandReport, DiffReportMeta } from './report'

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
