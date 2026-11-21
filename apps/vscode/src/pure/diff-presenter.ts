// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Diff panel presentation (D03b): the value-free disclosure, verdict and
 * status decisions of the desktop diff surface, extracted from the webview
 * entry as a DOM-free module with explicit inputs and outputs.
 *
 * The webview's `DiffPanel` turns these view models into text nodes and
 * buttons; every string the user can read is decided here, so the honesty
 * rules (a retained report after a failed run, a stale flag recomputed
 * against the CURRENT revision, a refusal that never runs) are unit-testable
 * in Node.
 */
import type { DatasetProfile } from '@assay/diff'
import type { EngineDatasetProfile } from '@assay/engine-duckdb'
import type { DiffColumn, DiffReportView } from './diff-controller'
import { isDiffStale, projectDiffReport, validateConfirmedKeys } from './diff-controller'

/** Header block of a staged (not yet run) comparison. */
export function describeStagedComparison(input: {
  readonly displayName: string
  readonly columnCount: number
  readonly rowCount: number
  readonly schemaDriftCount: number
  readonly columnDeltaCount: number
  readonly issueCount: number
}): { readonly meta: string; readonly findings: string } {
  return {
    meta: `Comparison staged: ${input.displayName} (${input.columnCount} columns; ${input.rowCount} rows).`,
    findings: `Schema/profile findings: ${input.schemaDriftCount} schema drift findings; ${input.columnDeltaCount} column distribution deltas; ${input.issueCount} issues. Row-level comparison has not run.`,
  }
}

/** Candidate selection is a proposal, never a run (the chosen keys stay unconfirmed). */
export const PROPOSAL_ONLY_STATUS = 'Candidate selected as a proposal. Confirm explicitly to run.'
/** Fixed disclosure text that must always accompany a staged comparison. */
export const STAGED_INTRO =
  'Inferred keys are proposals only. Select a candidate or choose columns, then explicitly confirm; no row diff runs before confirmation.'
export const STAGED_READY_STATUS = 'Comparison ready. Choose keys and confirm to run.'

/** One inferable-key candidate, as rendered (proposal disclosure + columns). */
export function describeKeyCandidate(candidate: {
  readonly disclosure: string
  readonly columns: readonly string[]
  readonly evidence: unknown
}): { readonly text: string; readonly columns: readonly string[] } {
  return {
    text: `${candidate.disclosure} — key columns ${JSON.stringify(candidate.columns)}; evidence: ${JSON.stringify(candidate.evidence)}`,
    columns: [...candidate.columns],
  }
}

/** The key multi-select options, in comparison-schema order. */
export function describeKeyOptions(
  columns: readonly DiffColumn[],
): readonly { readonly value: string; readonly label: string }[] {
  return columns.map((column) => ({ value: column.name, label: `${column.name} (${column.type})` }))
}

/** Verdict headline for a published report. */
export function describeDiffVerdict(report: DiffReportView): string {
  return report.identical ? 'IDENTICAL across schema, profile, and row diff' : 'DIFFERENCES found'
}

/** Keys/row-count/base-view honesty line for a published report. */
export function describeDiffMetadata(report: DiffReportView): string {
  return `Keys: ${JSON.stringify(report.keys)} (${report.keySource}); effective rows A ${report.rowCountA}, B ${report.rowCountB}; base view only: ${String(report.baseViewOnly)}.`
}

/** One drift/delta group heading (count-bearing). */
export function describeDiffGroupHeading(name: string, count: number): string {
  return `${name} (${count})`
}

/** One aspect heading (exact-row count + sample completeness). */
export function describeDiffAspectHeading(aspect: DiffReportView['aspects'][number]): string {
  return `${aspect.aspect}: ${aspect.count} exact rows; ${aspect.samplesReturned} samples returned${aspect.samplesComplete ? ' (complete)' : ' (truncated)'}`
}

/** One sample line; `navigate` marks A-side samples that can jump in the grid. */
export function describeDiffSample(sample: DiffReportView['aspects'][number]['samples'][number]): {
  readonly text: string
  readonly navigate: boolean
  readonly jumpLabel: string
} {
  return {
    text: `${sample.side} ${sample.displayKey}${sample.changedColumns ? ` — changed columns ${JSON.stringify(sample.changedColumns)}` : ''}`,
    navigate: sample.side === 'A',
    jumpLabel: `Go to A row ${sample.displayKey}`,
  }
}

/** Issues line of a published report. */
export function describeDiffIssues(report: DiffReportView): string {
  return `Issues: ${report.issues.length}${report.issues.length ? ` — ${JSON.stringify(report.issues)}` : ''}`
}

/** Whether the stale indicator is shown for the current revision. */
export function diffStaleVisible(report: DiffReportView | null, revision: number): boolean {
  return isDiffStale(report, revision)
}

/**
 * Refusal status for a confirm click. `busy` covers the "previous report stays
 * visible, nothing runs" cases; `invalid-keys` carries the validation error.
 * Keys are re-validated here (not merely read from the select) so a tampered
 * or emptied selection can never reach the engine.
 */
export function describeDiffRefusal(
  reason: 'busy' | { readonly kind: 'invalid-keys'; readonly error: string },
): string {
  return reason === 'busy'
    ? 'Diff refused: busy or comparison unavailable.'
    : `Diff refused: invalid keys (${reason.error}).`
}

/** Keys chosen in the select, in DOM order, validated against the schema. */
export function confirmedDiffKeys(
  selected: readonly (string | null)[],
  columns: readonly DiffColumn[],
):
  | { readonly ok: true; readonly keys: readonly string[] }
  | { readonly ok: false; readonly error: string } {
  const result = validateConfirmedKeys(selected, columns)
  return result.ok ? { ok: true, keys: result.keys } : { ok: false, error: result.error }
}

/**
 * The create-only JSON report body: the canonical projection plus the
 * recomputed stale flag (never the stale flag frozen at publish time).
 */
export function buildReportExportPayload(
  report: DiffReportView,
  revision: number,
): Record<string, unknown> {
  return { ...projectDiffReport(report), stale: isDiffStale(report, revision) }
}

/** Status line for a host report-export result frame. */
export function describeReportExportStatus(status: string | undefined): string {
  switch (status) {
    case 'created':
      return 'JSON report created as a new local file.'
    case 'cancelled':
      return 'Report export cancelled.'
    case 'busy':
      return 'Report export refused: another export is pending.'
    case 'refused':
      return 'Report export refused: destination exists, aliases a source, or is not a local file.'
    default:
      return 'Report export failed; no success was reported.'
  }
}

/** Status line for an uncorrelated/failed comparison staging frame. */
export function describeComparisonFrameFailure(kind: 'cancelled' | 'error'): string {
  return kind === 'cancelled'
    ? 'Comparison selection cancelled.'
    : 'Comparison file is unsupported, empty, too large, or could not be read.'
}

export const COMPARISON_REPLACE_REFUSED =
  'Comparison cannot be replaced while an operation is pending.'
export const COMPARISON_STAGE_BUSY_REFUSED = 'Cannot stage while an edit is pending.'
export const COMPARISON_STAGE_FAILED = 'Comparison could not be staged or profiled.'
export const COMPARISON_SELECT_PROMPT = 'Select a local comparison dataset…'
export const DIFF_RUNNING_STATUS = 'Running confirmed row diff…'
export const DIFF_COMPLETE_STATUS = 'Diff complete.'
/** A failed run keeps the previous report: the status says so explicitly. */
export const DIFF_FAILED_STATUS = 'Diff failed. The previous report, if any, is unchanged.'
export const DIFF_CANCELLED_STATUS = 'Diff cancelled; any late result will be ignored.'
export const REPORT_EXPORT_PROMPT = 'Choose a new local file for the JSON report…'
export const DIFF_SAMPLE_NOT_IN_VIEW =
  'That A-side logical row is not in the current grid view. Clear filters or re-run the diff.'
export const DIFF_NAVIGATION_FAILED = 'Could not navigate to that A-side logical row.'

/** Engine profile projection used by the stage flow (kept here, one owner). */
export function toDiffProfile(profile: EngineDatasetProfile): DatasetProfile {
  return { rowCount: profile.rowCount, columns: profile.columns.map((column) => ({ ...column })) }
}
