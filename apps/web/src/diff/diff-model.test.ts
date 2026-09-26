// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import type { ColumnDistributionDelta, DiffReport } from '@assay/diff'
import type { EngineRowDiffResult } from '@assay/engine-duckdb'
import {
  buildDiffAspectViews,
  buildDiffPanelReport,
  columnDeltaDiffers,
  columnDeltaLine,
  diffReportIdentical,
  displayDiffRowKey,
  exportDiffRowKey,
  identicalZeroState,
  sampleClampText,
  schemaFindingLine,
  SCHEMA_PROFILE_DIFFERENCE_CAVEAT,
  SCHEMA_PROFILE_ZERO_STATE,
} from './diff-model'

/**
 * Unit pins for the m6-4 panel model: aspect assembly and ordering, the
 * anchor-free row keys (the m4-3 export discipline — the host fingerprint
 * never renders), the CLI-identical `identical` predicate, the honest
 * zero-state wording (schema/profile identity is not a row-level claim), the
 * report rounding, and the clamp copy.
 *
 * The report is a plain-data projection, so this suite is Node-only (no DOM).
 */

const DRIFT = [
  { kind: 'column-added', column: 'region', typeB: 'VARCHAR', familyB: 'textual' },
] as const satisfies DiffReport['schemaDrift']

const DELTAS = [
  {
    column: 'id',
    typeA: 'BIGINT',
    typeB: 'BIGINT',
    kindA: 'numeric',
    kindB: 'numeric',
    numeric: {
      meanShiftStandardized: 0.5059644256269407,
      varianceShiftStandardized: 1.68,
      p50Shift: 0,
      p90Shift: 2,
      bins: { edges: [3, 4.6, 4.8, 4.96] },
    },
  },
  {
    column: 'name',
    typeA: 'VARCHAR',
    typeB: 'VARCHAR',
    kindA: 'categorical',
    kindB: 'categorical',
    categorical: {
      totalVariation: 0.6,
      newCategories: [{ value: 'a6', count: 1 }],
      vanishedCategories: [{ value: 'a2', count: 1 }],
    },
  },
] as const satisfies DiffReport['columnDeltas']

function diffReport(overrides: Partial<DiffReport> = {}): DiffReport {
  return { schemaDrift: [...DRIFT], columnDeltas: [...DELTAS], issues: [], ...overrides }
}

function engineResult(): EngineRowDiffResult {
  return {
    rowCountA: 5,
    rowCountB: 5,
    aspects: [
      {
        aspect: 'added',
        count: 2,
        samples: [
          { side: 'B', rowKey: 'b:3' },
          { side: 'B', rowKey: 'b:4' },
        ],
      },
      {
        aspect: 'removed',
        count: 2,
        samples: [
          { side: 'A', rowKey: 'base:anchor-a#3' },
          { side: 'A', rowKey: 'base:anchor-a#4' },
        ],
      },
      {
        aspect: 'changed',
        count: 2,
        samples: [
          { side: 'A', rowKey: 'base:anchor-a#1', changedColumns: ['name'] },
          { side: 'A', rowKey: 'base:anchor-a#2', changedColumns: ['amount'] },
        ],
      },
    ],
  }
}

function panelReport(overrides: Partial<Parameters<typeof buildDiffPanelReport>[0]> = {}) {
  return buildDiffPanelReport({
    diff: diffReport(),
    result: engineResult(),
    keys: ['id'],
    keySource: 'inferred',
    inference: {
      columns: ['id'],
      candidateDisclosure: "key candidate: column 'id' is unique and non-null on both sides",
      outcomeDisclosure: '1 key candidate proposed',
      evidence: {
        column: 'id',
        typeA: 'BIGINT',
        typeB: 'BIGINT',
        rowCountA: 5,
        rowCountB: 5,
        nullCountA: 0,
        nullCountB: 0,
        distinctCountA: 5,
        distinctCountB: 5,
      },
    },
    sharedColumns: ['name', 'amount'],
    sampleLimitRequested: 100,
    sampleLimitEffective: 100,
    baseViewOnly: true,
    revision: 7,
    ...overrides,
  })
}

describe('diff panel model', () => {
  it('assembles the three aspects in the documented order with exact counts', () => {
    const aspects = buildDiffAspectViews(engineResult())
    expect(aspects.added.aspect).toBe('added')
    expect(aspects.removed.aspect).toBe('removed')
    expect(aspects.changed.aspect).toBe('changed')
    expect(aspects.added.count).toBe(2)
    expect(aspects.removed.count).toBe(2)
    expect(aspects.changed.count).toBe(2)
    expect(aspects.added.samples.map((sample) => sample.displayKey)).toEqual(['b #3', 'b #4'])
  })

  it('resolves A-side keys to anchor-free display/export forms and leaves B keys report-only', () => {
    const report = panelReport()
    const removed = report.removed.samples.map((sample) => sample)
    expect(removed.map((sample) => sample.displayKey)).toEqual(['base #3', 'base #4'])
    expect(removed.map((sample) => sample.exportKey)).toEqual(['base:3', 'base:4'])
    // The anchor token must never survive into the export form.
    for (const sample of removed) {
      expect(sample.exportKey).not.toContain('anchor')
      expect(sample.displayKey).not.toContain('anchor')
    }
    const added = report.added.samples
    expect(added.map((sample) => sample.exportKey)).toEqual(['b:3', 'b:4'])
    expect(added.every((sample) => sample.side === 'B')).toBe(true)
  })

  it('handles insert row keys (m4-1 grammar) anchor-free too', () => {
    expect(displayDiffRowKey('ins:ov-2#1')).toBe('insert #1')
    expect(exportDiffRowKey('ins:ov-2#1')).toBe('insert:1')
    expect(displayDiffRowKey('unknown-garbage')).toBe('unknown row')
    expect(exportDiffRowKey('unknown-garbage')).toBe('unknown')
  })

  it('marks changedComparable false when the plan shares no non-key columns', () => {
    expect(panelReport({ sharedColumns: [] }).changedComparable).toBe(false)
    expect(panelReport().changedComparable).toBe(true)
  })

  it('computes identical from every aspect exactly like the CLI', () => {
    expect(panelReport().identical).toBe(false)
    const flat: DiffReport = { schemaDrift: [], columnDeltas: [], issues: [] }
    const zero: EngineRowDiffResult = {
      rowCountA: 5,
      rowCountB: 5,
      aspects: [
        { aspect: 'added', count: 0, samples: [] },
        { aspect: 'removed', count: 0, samples: [] },
        { aspect: 'changed', count: 0, samples: [] },
      ],
    }
    const report = panelReport({ diff: flat, result: zero })
    expect(report.identical).toBe(true)
    expect(report.added.samples).toEqual([])
  })

  it('treats a defined non-zero metric or a new/vanished category as a difference', () => {
    expect(columnDeltaDiffers(DELTAS[0])).toBe(true)
    expect(columnDeltaDiffers(DELTAS[1])).toBe(true)
    const flat: ColumnDistributionDelta = {
      column: 'x',
      typeA: 'BIGINT',
      typeB: 'BIGINT',
      kindA: 'numeric',
      kindB: 'numeric',
      numeric: {
        meanShiftStandardized: 0,
        varianceShiftStandardized: 0,
        p50Shift: 0,
        p90Shift: 0,
        bins: { edges: [1] },
      },
    }
    expect(columnDeltaDiffers(flat)).toBe(false)
    expect(
      diffReportIdentical({
        drift: [],
        deltas: [flat],
        added: {
          aspect: 'added',
          count: 0,
          samplesReturned: 0,
          samplesComplete: true,
          samples: [],
        },
        removed: {
          aspect: 'removed',
          count: 0,
          samplesReturned: 0,
          samplesComplete: true,
          samples: [],
        },
        changed: {
          aspect: 'changed',
          count: 0,
          samplesReturned: 0,
          samplesComplete: true,
          samples: [],
        },
      }),
    ).toBe(true)
  })

  it('rounds displayed metrics through the one report convention (half away from zero)', () => {
    const finding = {
      kind: 'nullability-changed',
      column: 'x',
      nullShareA: 1 / 3,
      nullShareB: 2 / 3,
    } as const
    expect(schemaFindingLine(finding)).toContain('null share A 0.333333 → B 0.666667')
    const delta: ColumnDistributionDelta = {
      column: 'x',
      typeA: 'BIGINT',
      typeB: 'BIGINT',
      kindA: 'numeric',
      kindB: 'numeric',
      numeric: {
        meanShiftStandardized: 0.5059644256269407,
        varianceShiftStandardized: 1.68,
        p50Shift: 0,
        p90Shift: 2,
        bins: { edges: [1] },
      },
    }
    expect(columnDeltaLine(delta)).toContain('mean shift 0.505964')
    expect(columnDeltaLine(delta)).toContain('p50 shift 0')
  })

  it('words the zero-state precisely about what ran', () => {
    expect(SCHEMA_PROFILE_ZERO_STATE).toContain('stored profile aggregates only')
    expect(SCHEMA_PROFILE_ZERO_STATE).toContain('row-only difference would not appear')
    // The instruction belongs only to the pre-run state; the post-row-diff
    // result state renders the caveat alone (the m6-4 review warning).
    expect(SCHEMA_PROFILE_ZERO_STATE).toContain('Choose keys below to run the row diff.')
    expect(SCHEMA_PROFILE_DIFFERENCE_CAVEAT).toContain('stored profile aggregates only')
    expect(SCHEMA_PROFILE_DIFFERENCE_CAVEAT).toContain('row-only difference would not appear')
    expect(SCHEMA_PROFILE_DIFFERENCE_CAVEAT).not.toContain('Choose keys')
    expect(SCHEMA_PROFILE_ZERO_STATE).toBe(
      `${SCHEMA_PROFILE_DIFFERENCE_CAVEAT} Choose keys below to run the row diff.`,
    )
    const zero = identicalZeroState(['id', 'region'])
    expect(zero).toContain('No differences')
    expect(zero).toContain('row-level comparison (keys: id, region)')
    // The row-level claim is only made once the row diff ran.
    expect(zero).toContain('every aspect that ran')
  })

  it('discloses a partial sample list with the requested and effective bounds', () => {
    expect(sampleClampText(110, 100, 100, 100)).toContain('10 more not shown (sample limit 100)')
    expect(sampleClampText(110, 100, 500, 100)).toContain(
      '10 more not shown (sample limit 500 clamped to 100)',
    )
  })
})
