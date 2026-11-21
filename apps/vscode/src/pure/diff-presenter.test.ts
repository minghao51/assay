// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import type { DiffColumn, DiffReportView } from './diff-controller'
import {
  COMPARISON_REPLACE_REFUSED,
  COMPARISON_STAGE_BUSY_REFUSED,
  COMPARISON_STAGE_FAILED,
  DIFF_CANCELLED_STATUS,
  DIFF_COMPLETE_STATUS,
  DIFF_FAILED_STATUS,
  DIFF_NAVIGATION_FAILED,
  DIFF_RUNNING_STATUS,
  DIFF_SAMPLE_NOT_IN_VIEW,
  PROPOSAL_ONLY_STATUS,
  REPORT_EXPORT_PROMPT,
  STAGED_INTRO,
  STAGED_READY_STATUS,
  buildReportExportPayload,
  confirmedDiffKeys,
  describeComparisonFrameFailure,
  describeDiffAspectHeading,
  describeDiffGroupHeading,
  describeDiffIssues,
  describeDiffMetadata,
  describeDiffRefusal,
  describeDiffSample,
  describeDiffVerdict,
  describeKeyCandidate,
  describeKeyOptions,
  describeReportExportStatus,
  describeStagedComparison,
  diffStaleVisible,
  toDiffProfile,
} from './diff-presenter'

const columns: readonly DiffColumn[] = [
  { name: 'id', type: 'BIGINT' },
  { name: 'value', type: 'DOUBLE' },
]

const report = {
  keys: ['id'],
  keySource: 'explicit',
  rowCountA: 12,
  rowCountB: 12,
  baseViewOnly: true,
  identical: false,
  issues: [],
  drift: [],
  deltas: [],
  divergentDeltas: [],
  inference: null,
  sampleLimitRequested: 10,
  sampleLimitEffective: 10,
  changedComparable: true,
  stale: false,
  revision: 7,
  aspects: [
    {
      aspect: 'added',
      count: 1,
      samplesReturned: 1,
      samplesComplete: true,
      samples: [
        { side: 'A', rowKey: 'base:a#1', displayKey: '1', exportKey: '1' },
        {
          side: 'B',
          rowKey: 'base:b#2',
          displayKey: '2',
          exportKey: '2',
          changedColumns: ['value'],
        },
      ],
    },
    { aspect: 'removed', count: 0, samplesReturned: 0, samplesComplete: true, samples: [] },
    { aspect: 'changed', count: 2, samplesReturned: 1, samplesComplete: false, samples: [] },
  ],
} as unknown as DiffReportView

describe('diff presenter', () => {
  it('describes a staged comparison with its disclosure counts', () => {
    expect(
      describeStagedComparison({
        displayName: 'comparison-b.csv',
        columnCount: 2,
        rowCount: 12,
        schemaDriftCount: 0,
        columnDeltaCount: 3,
        issueCount: 1,
      }),
    ).toEqual({
      meta: 'Comparison staged: comparison-b.csv (2 columns; 12 rows).',
      findings:
        'Schema/profile findings: 0 schema drift findings; 3 column distribution deltas; 1 issues. Row-level comparison has not run.',
    })
    expect(STAGED_INTRO).toContain('no row diff runs before confirmation')
    expect(STAGED_READY_STATUS).toBe('Comparison ready. Choose keys and confirm to run.')
    expect(PROPOSAL_ONLY_STATUS).toContain('Confirm explicitly to run')
  })

  it('proposes candidate keys without selecting them as confirmed', () => {
    const candidate = describeKeyCandidate({
      disclosure: 'unique values in id',
      columns: ['id'],
      evidence: { distinct: 12 },
    })
    expect(candidate.text).toContain('key columns ["id"]')
    expect(candidate.columns).toEqual(['id'])
    expect(describeKeyOptions(columns)).toEqual([
      { value: 'id', label: 'id (BIGINT)' },
      { value: 'value', label: 'value (DOUBLE)' },
    ])
  })

  it('renders verdict, metadata, headings and issues', () => {
    expect(describeDiffVerdict(report)).toBe('DIFFERENCES found')
    expect(describeDiffVerdict({ ...report, identical: true })).toBe(
      'IDENTICAL across schema, profile, and row diff',
    )
    expect(describeDiffMetadata(report)).toBe(
      'Keys: ["id"] (explicit); effective rows A 12, B 12; base view only: true.',
    )
    expect(describeDiffGroupHeading('Schema drift', 2)).toBe('Schema drift (2)')
    expect(describeDiffAspectHeading(report.aspects[0]!)).toBe(
      'added: 1 exact rows; 1 samples returned (complete)',
    )
    expect(describeDiffAspectHeading(report.aspects[2]!)).toBe(
      'changed: 2 exact rows; 1 samples returned (truncated)',
    )
    expect(describeDiffIssues(report)).toBe('Issues: 0')
    expect(describeDiffIssues({ ...report, issues: [{ code: 'x' } as never] })).toContain(
      'Issues: 1 — ',
    )
  })

  it('navigates from A-side samples only', () => {
    const a = describeDiffSample(report.aspects[0]!.samples[0]!)
    expect(a).toEqual({ text: 'A 1', navigate: true, jumpLabel: 'Go to A row 1' })
    const b = describeDiffSample(report.aspects[0]!.samples[1]!)
    expect(b.navigate).toBe(false)
    expect(b.text).toContain('changed columns ["value"]')
  })

  it('computes staleness against the CURRENT revision', () => {
    expect(diffStaleVisible(report, 7)).toBe(false)
    expect(diffStaleVisible(report, 8)).toBe(true)
    expect(diffStaleVisible(null, 8)).toBe(false)
  })

  it('refuses with an honest reason and nothing else', () => {
    expect(describeDiffRefusal('busy')).toBe('Diff refused: busy or comparison unavailable.')
    expect(describeDiffRefusal({ kind: 'invalid-keys', error: 'empty' })).toBe(
      'Diff refused: invalid keys (empty).',
    )
  })

  it('re-validates the selected keys instead of trusting the select', () => {
    expect(confirmedDiffKeys(['id'], columns)).toEqual({ ok: true, keys: ['id'] })
    expect(confirmedDiffKeys([], columns)).toEqual({ ok: false, error: 'empty' })
    expect(confirmedDiffKeys(['nope'], columns)).toEqual({ ok: false, error: 'unknown-column' })
    // Duplicate keys are refused case-insensitively.
    expect(confirmedDiffKeys(['id', 'ID'], columns)).toEqual({ ok: false, error: 'duplicate-key' })
  })

  it('builds the create-only report body with a RECOMPUTED stale flag', () => {
    const current = buildReportExportPayload({ ...report, stale: true }, 7)
    expect(current['stale']).toBe(false)
    expect(current['report']).toBe('assay-diff-report')
    expect(current['baseViewOnly']).toBe(true)
    const stale = buildReportExportPayload(report, 8)
    expect(stale['stale']).toBe(true)
  })

  it('maps every report-export status to its user-visible line', () => {
    expect(describeReportExportStatus('created')).toBe('JSON report created as a new local file.')
    expect(describeReportExportStatus('cancelled')).toBe('Report export cancelled.')
    expect(describeReportExportStatus('busy')).toContain('another export is pending')
    expect(describeReportExportStatus('refused')).toContain('destination exists')
    expect(describeReportExportStatus('failed')).toBe(
      'Report export failed; no success was reported.',
    )
    expect(describeReportExportStatus(undefined)).toBe(
      'Report export failed; no success was reported.',
    )
  })

  it('maps comparison frame failures', () => {
    expect(describeComparisonFrameFailure('cancelled')).toBe('Comparison selection cancelled.')
    expect(describeComparisonFrameFailure('error')).toContain('unsupported, empty, too large')
  })

  it('keeps the fixed diff status lines stable (user-visible contract text)', () => {
    expect(COMPARISON_REPLACE_REFUSED).toContain('cannot be replaced')
    expect(COMPARISON_STAGE_BUSY_REFUSED).toBe('Cannot stage while an edit is pending.')
    expect(COMPARISON_STAGE_FAILED).toBe('Comparison could not be staged or profiled.')
    expect(DIFF_RUNNING_STATUS).toBe('Running confirmed row diff…')
    expect(DIFF_COMPLETE_STATUS).toBe('Diff complete.')
    expect(DIFF_FAILED_STATUS).toContain('previous report, if any, is unchanged')
    expect(DIFF_CANCELLED_STATUS).toContain('any late result will be ignored')
    expect(REPORT_EXPORT_PROMPT).toBe('Choose a new local file for the JSON report…')
    expect(DIFF_SAMPLE_NOT_IN_VIEW).toContain('Clear filters or re-run the diff')
    expect(DIFF_NAVIGATION_FAILED).toBe('Could not navigate to that A-side logical row.')
  })

  it('projects an engine profile without mutating the engine payload', () => {
    const engine = {
      rowCount: 3,
      columns: [{ name: 'id', type: 'BIGINT', kind: 'numeric', nullCount: 0, distinctCount: 3 }],
    } as unknown as Parameters<typeof toDiffProfile>[0]
    const projected = toDiffProfile(engine)
    expect(projected.rowCount).toBe(3)
    expect(projected.columns[0]!.name).toBe('id')
    expect(projected.columns[0]).not.toBe(engine.columns[0])
  })
})
