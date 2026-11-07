// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Diff panel (m6-4): stage a comparison dataset, disclose the diff in the
 * fixed order — schema drift → per-column distribution deltas → key-based row
 * diff — then export a sanitized report. The component is presentation plus
 * small local state machines; all domain logic lives in the pure models
 * (`./diff-model`, `./diff-export`) and all session state (the staged
 * comparison, the run, the verdict) lives in the App, which owns the engine
 * and the editing session the verdict must stay fresh against.
 *
 * Honesty rules rendered here (each pinned by tests or e2e):
 *
 * - The comparison file is read locally and never added to the grid: B-side
 *   samples are report content, with no jump affordance, and the copy says so.
 *   Only side A's logical row keys can jump into the grid (m4-3 channel).
 * - Schema drift is visible BEFORE a row diff can run: the key-selection
 *   control and the row-diff result render after the first two aspect
 *   sections.
 * - Key inference (C2) is a proposal: candidates are listed minimal-first with
 *   their evidence and disclosure rendered verbatim, and the user confirms a
 *   candidate or types explicit keys. An empty key set cannot reach the
 *   compiler (the Run control is disabled).
 * - Exact counts are never approximated; every displayed metric is rounded
 *   through the one report convention. A partial sample list says so (the
 *   engine clamp) instead of pretending to be complete.
 * - The zero-state wording is precise about what ran: schema/profile identity
 *   alone is not a row-level identity claim.
 * - A verdict computed before the dataset's latest edits is marked STALE and
 *   stays viewable; re-running is an explicit click (no auto-run).
 * - The report export is always a NEW file, and every result line says the
 *   opened file is unchanged (m4-5 copy rules).
 * - Column names and sample keys are report content; dataset values never
 *   render here (categorical labels are report labels). Values render as
 *   React text only — no HTML anywhere (ADR 0025/0007).
 */
import { useEffect, useRef, useState } from 'react'
import type {
  ColumnDistributionDelta,
  DiffIssue,
  DiffReport,
  KeyCandidate,
  KeyInferenceResult,
  RowDiffBindingError,
  SchemaDriftFinding,
} from '@assay/diff'
import { describeDiffIssue, describeRowDiffBindingError } from '@assay/diff'
import type {
  DiffAspectView,
  DiffKeyDisclosure,
  DiffPanelReport,
  DiffSampleView,
} from './diff-model'
import {
  columnDeltaLine,
  columnDeltaDiffers,
  identicalZeroState,
  plural,
  sampleClampText,
  SCHEMA_PROFILE_DIFFERENCE_CAVEAT,
  SCHEMA_PROFILE_ZERO_STATE,
  schemaFindingLine,
} from './diff-model'
import {
  buildDiffReportBytes,
  DIFF_EXPORT_CANCELLED_MESSAGE,
  DIFF_EXPORT_SAME_SOURCE_MESSAGE,
  DIFF_REPORT_FORMATS,
  diffExportFailureMessage,
  diffExportSuccessMessage,
} from './diff-export'
import type { DiffReportFormat } from './diff-export'
import type {
  SaveDestination,
  SaveStrategy,
  WritableSaveDestination,
} from '../export/save-destination'

/** One column as the panel shows the two staged schemas. */
export interface DiffColumn {
  readonly name: string
  readonly type: string
}

/** Comparison half of the session state (owned by the App). */
export type ComparisonState =
  | { readonly kind: 'none' }
  | { readonly kind: 'staging' }
  | { readonly kind: 'failed'; readonly message: string }
  | {
      readonly kind: 'staged'
      /** The staged comparison's DESCRIBE schema (never rendered as values). */
      readonly schemaB: readonly DiffColumn[]
      readonly rowCountB: number
      /** Side A's base column count, for the schema-drift zero-state. */
      readonly baseColumnCount: number
      /** Schema drift + distribution deltas over the two base schemas/profiles. */
      readonly diff: DiffReport
      /** C2 key inference over the two base profiles. */
      readonly inference: KeyInferenceResult
    }

/** Run half of the session state (owned by the App). */
export type DiffRunState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly message: string }
  | {
      readonly kind: 'binding-errors'
      readonly errors: readonly RowDiffBindingError[]
      readonly revision: number
    }
  | { readonly kind: 'result'; readonly report: DiffPanelReport }

export interface DiffPanelProps {
  readonly comparison: ComparisonState
  readonly runState: DiffRunState
  /**
   * True when the dataset's overlay changed after the current row-diff result
   * (or binding-error report) was produced — the m4-3 verdict-freshness
   * signal. The report stays viewable, under this banner.
   */
  readonly stale: boolean
  /** App-level jump failure (the sample row is gone from the current view). */
  readonly jumpError: string | null
  /** A comparison file was picked; the App stages it. */
  readonly onComparisonFile: (file: File) => void
  /**
   * Compile + run the row diff with the confirmed keys. `keySource` records
   * how they were chosen; `inference` is the verbatim C2 disclosure for an
   * inferred candidate (null for explicitly typed keys).
   */
  readonly onRunDiff: (
    keys: readonly string[],
    keySource: 'explicit' | 'inferred',
    inference: DiffKeyDisclosure | null,
  ) => void
  readonly onCancelDiff: () => void
  /** Jump the grid + inspector to this sample's logical row (A-side only). */
  readonly onJumpToSample: (rowKey: string) => void
  /** Acquires a save destination for the report; resolves `null` on cancel. */
  readonly requestReportDestination: (format: DiffReportFormat) => Promise<SaveDestination | null>
  /** Delivers report bytes to the destination (FSA write or download). */
  readonly deliverReportCopy: (
    destination: WritableSaveDestination,
    content: { readonly bytes: Uint8Array<ArrayBuffer>; readonly format: DiffReportFormat },
  ) => Promise<SaveStrategy>
}

/** Report-export state machine (panel-local, like the m4-5 dialog). */
type ReportExportPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'working' }
  | { readonly kind: 'result'; readonly message: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'refused' }
  | { readonly kind: 'error'; readonly message: string }

/** Parse a comma-separated manual key list (trim, drop empties). */
export function parseManualKeys(text: string): string[] {
  return text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

/** Singular/plural honest row counts. */
function rowCountText(count: number): string {
  return `${String(count)} ${count === 1 ? 'row' : 'rows'}`
}

function aspectHeading(aspect: DiffAspectView, comparable: boolean): string {
  const caveat =
    !comparable && aspect.aspect === 'changed' ? ' — no shared non-key columns to compare' : ''
  return `${aspect.aspect} (${String(aspect.count)}${caveat})`
}

/** One schema-drift finding row. */
function SchemaFinding({ finding }: { finding: SchemaDriftFinding }) {
  return (
    <li data-testid="diff-schema-finding" data-kind={finding.kind} data-column={finding.column}>
      {schemaFindingLine(finding)}
    </li>
  )
}

/** One column's distribution delta row. */
function ColumnDelta({ delta }: { delta: ColumnDistributionDelta }) {
  return (
    <li
      data-testid="diff-column-delta"
      data-column={delta.column}
      data-differs={columnDeltaDiffers(delta) ? 'true' : 'false'}
    >
      {columnDeltaLine(delta)}
    </li>
  )
}

/** One bounded row-diff sample. A-side samples jump; B-side are report-only. */
function SampleRow({
  sample,
  onJumpToSample,
}: {
  sample: DiffSampleView
  onJumpToSample: (rowKey: string) => void
}) {
  return (
    <li data-testid="diff-sample" data-side={sample.side} data-row-key={sample.exportKey}>
      <span data-testid="diff-sample-key">{sample.displayKey}</span>
      {sample.changedColumns !== null && sample.changedColumns.length > 0 && (
        <>
          {' '}
          — changed:{' '}
          <span data-testid="diff-sample-changed">{sample.changedColumns.join(', ')}</span>
        </>
      )}
      {sample.side === 'A' ? (
        <>
          {' '}
          <button
            type="button"
            data-testid="diff-sample-jump"
            onClick={() => {
              onJumpToSample(sample.rowKey)
            }}
          >
            Show row
          </button>
        </>
      ) : (
        <span className="diff-sample-report-only" data-testid="diff-sample-report-only">
          {' '}
          (report only — the comparison file is not shown in the grid)
        </span>
      )}
    </li>
  )
}

/** One aspect block (added / removed / changed). */
function AspectBlock({
  aspect,
  report,
  onJumpToSample,
}: {
  aspect: DiffAspectView
  report: DiffPanelReport
  onJumpToSample: (rowKey: string) => void
}) {
  return (
    <div className="diff-aspect" data-testid="diff-aspect" data-aspect={aspect.aspect}>
      <p data-testid="diff-aspect-count">{aspectHeading(aspect, report.changedComparable)}</p>
      {aspect.samples.length === 0 ? (
        <p className="diff-aspect-none" data-testid="diff-aspect-none">
          none
        </p>
      ) : (
        <ul className="diff-samples" data-testid="diff-samples">
          {aspect.samples.map((sample) => (
            <SampleRow
              key={`${sample.side}:${sample.rowKey}:${sample.changedColumns?.join(',') ?? ''}`}
              sample={sample}
              onJumpToSample={onJumpToSample}
            />
          ))}
        </ul>
      )}
      {!aspect.samplesComplete && (
        <p className="diff-sample-clamp" data-testid="diff-sample-clamp">
          {sampleClampText(
            aspect.count,
            aspect.samplesReturned,
            report.sampleLimitRequested,
            report.sampleLimitEffective,
          )}
        </p>
      )}
    </div>
  )
}

/** One C2 key candidate: a radio, the verbatim evidence, and the disclosure. */
function KeyCandidateOption({
  candidate,
  checked,
  onSelect,
}: {
  candidate: KeyCandidate
  checked: boolean
  onSelect: () => void
}) {
  const evidence = candidate.evidence
  return (
    <li
      className="diff-key-candidate"
      data-testid="diff-key-candidate"
      data-column={evidence.column}
    >
      <label>
        <input
          type="radio"
          name="diff-key-candidate"
          data-testid="diff-key-candidate-radio"
          checked={checked}
          onChange={onSelect}
        />{' '}
        <code data-testid="diff-key-candidate-column">{candidate.columns.join(', ')}</code>
      </label>
      <p className="diff-key-evidence" data-testid="diff-key-evidence">
        unique and non-null on both sides — A: <code>{evidence.typeA}</code>,{' '}
        {String(evidence.nullCountA)} nulls, {String(evidence.distinctCountA)} distinct of{' '}
        {String(evidence.rowCountA)} rows; B: <code>{evidence.typeB}</code>,{' '}
        {String(evidence.nullCountB)} nulls, {String(evidence.distinctCountB)} distinct of{' '}
        {String(evidence.rowCountB)} rows
      </p>
      <p className="diff-key-disclosure" data-testid="diff-key-candidate-disclosure">
        {candidate.disclosure}
      </p>
    </li>
  )
}

export function DiffPanel({
  comparison,
  runState,
  stale,
  jumpError,
  onComparisonFile,
  onRunDiff,
  onCancelDiff,
  onJumpToSample,
  requestReportDestination,
  deliverReportCopy,
}: DiffPanelProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [keyMode, setKeyMode] = useState<'candidate' | 'manual'>('candidate')
  const [selectedCandidate, setSelectedCandidate] = useState(0)
  const [manualKeys, setManualKeys] = useState('')
  const [exportFormat, setExportFormat] = useState<DiffReportFormat>('json')
  const [exportPhase, setExportPhase] = useState<ReportExportPhase>({ kind: 'idle' })

  const inference = comparison.kind === 'staged' ? comparison.inference : null
  const candidates = inference?.candidates ?? []
  const report = runState.kind === 'result' ? runState.report : null

  // A newly staged comparison invalidates the previous key choice and export
  // result line: the old numbers must never linger under a fresh comparison.
  useEffect(() => {
    setKeyMode('candidate')
    setSelectedCandidate(0)
    setManualKeys('')
    setExportPhase({ kind: 'idle' })
  }, [comparison])

  // A new result invalidates the previous export result line (the m5-3 rule).
  useEffect(() => {
    setExportPhase({ kind: 'idle' })
  }, [report])

  const chosenCandidate = keyMode === 'candidate' ? candidates[selectedCandidate] : undefined
  const chosenKeys =
    keyMode === 'manual'
      ? parseManualKeys(manualKeys)
      : chosenCandidate === undefined
        ? []
        : chosenCandidate.columns
  const running = runState.kind === 'running'
  const canRun = comparison.kind === 'staged' && !running && chosenKeys.length > 0

  const runExport = async (): Promise<void> => {
    if (report === null || exportPhase.kind === 'working') return
    setExportPhase({ kind: 'working' })
    try {
      const destination = await requestReportDestination(exportFormat)
      if (destination === null) {
        setExportPhase({ kind: 'cancelled' })
        return
      }
      if (destination.via === 'refused-source') {
        setExportPhase({ kind: 'refused' })
        return
      }
      const bytes = buildDiffReportBytes(exportFormat, report, { stale })
      const strategy = await deliverReportCopy(destination, { bytes, format: exportFormat })
      setExportPhase({
        kind: 'result',
        message: diffExportSuccessMessage(report, exportFormat, strategy),
      })
    } catch (error) {
      setExportPhase({ kind: 'error', message: diffExportFailureMessage(error) })
    }
  }

  return (
    <section className="diff-panel" data-testid="diff-panel" aria-label="Dataset comparison">
      <h2>Compare</h2>
      <p className="diff-intro" data-testid="diff-intro">
        Stage a second dataset version to compare against the open dataset (A). The comparison file
        is read locally, is <strong>not added to the grid</strong>, and nothing is uploaded. Schema
        drift is shown first, then per-column distribution deltas, then — after you confirm keys —
        the row-level diff.
      </p>

      <div className="diff-stage-row">
        <button
          type="button"
          data-testid="diff-open-comparison"
          onClick={() => {
            inputRef.current?.click()
          }}
        >
          Open a comparison file…
        </button>
        <input
          ref={inputRef}
          type="file"
          hidden
          data-testid="diff-comparison-input"
          onChange={(event) => {
            const file = event.target.files?.[0]
            // Reset so picking the same file again still fires onChange.
            event.target.value = ''
            if (file !== undefined) onComparisonFile(file)
          }}
        />
        {comparison.kind === 'staged' && (
          <span data-testid="diff-comparison-info">
            Comparison file (B) staged —{' '}
            <span data-testid="diff-comparison-rows">{rowCountText(comparison.rowCountB)}</span> ×{' '}
            <span data-testid="diff-comparison-columns">{String(comparison.schemaB.length)}</span>{' '}
            columns
          </span>
        )}
      </div>

      {comparison.kind === 'none' && (
        <p className="diff-zero-state" data-testid="diff-comparison-none">
          No comparison staged. Open a second dataset version to compare against the open dataset
          (A).
        </p>
      )}
      {comparison.kind === 'staging' && (
        <p className="diff-status" role="status" data-testid="diff-status">
          Staging the comparison file… the grid stays usable while this runs.
        </p>
      )}
      {comparison.kind === 'failed' && (
        <p className="diff-stage-error" role="alert" data-testid="diff-stage-error">
          The comparison file could not be staged: {comparison.message} Nothing was staged.
        </p>
      )}

      {comparison.kind === 'staged' && (
        <>
          <section
            className="diff-schema-drift"
            data-testid="diff-schema-drift"
            aria-label="Schema drift"
          >
            <h3>Schema drift</h3>
            <p className="diff-schema-note" data-testid="diff-schema-note">
              This compares side A&apos;s base file schema against the staged file; the row diff
              binds side A to the effective view (base plus any edits you make), so edits after
              staging are not reflected here.
            </p>
            {comparison.diff.schemaDrift.length === 0 ? (
              <p className="diff-aspect-none" data-testid="diff-schema-drift-none">
                No schema drift — {plural(comparison.baseColumnCount, 'column')} match by name and
                type.
              </p>
            ) : (
              <ul data-testid="diff-schema-findings">
                {comparison.diff.schemaDrift.map((finding, index) => (
                  <SchemaFinding
                    key={`${finding.column}:${finding.kind}:${String(index)}`}
                    finding={finding}
                  />
                ))}
              </ul>
            )}
          </section>

          <section
            className="diff-column-deltas"
            data-testid="diff-column-deltas"
            aria-label="Distribution deltas"
          >
            <h3>Distribution deltas</h3>
            <p className="diff-deltas-note" data-testid="diff-deltas-note">
              Metrics compare the stored profile aggregates of side A's base file against the staged
              file; this is schema/profile-observable signal, not a row-level claim.
            </p>
            {comparison.diff.columnDeltas.length === 0 ? (
              <p className="diff-aspect-none" data-testid="diff-column-deltas-none">
                No shared columns to compare.
              </p>
            ) : (
              <ul data-testid="diff-column-delta-list">
                {comparison.diff.columnDeltas.map((delta) => (
                  <ColumnDelta key={delta.column} delta={delta} />
                ))}
              </ul>
            )}
          </section>

          {/* Pre-run zero-state: schema/profile identity alone is not a row-level claim,
              and the next action (choose keys) is still ahead. The closing
              instruction must never render once a row diff has run. */}
          {comparison.diff.schemaDrift.length === 0 &&
            !comparison.diff.columnDeltas.some(columnDeltaDiffers) &&
            report === null && (
              <p className="diff-zero-note" data-testid="diff-schema-profile-zero">
                {SCHEMA_PROFILE_ZERO_STATE}
              </p>
            )}

          {comparison.diff.issues.length > 0 && (
            <div className="diff-issues" data-testid="diff-issues">
              <p role="alert">Some input problems were reported and those aspects were skipped:</p>
              <ul>
                {comparison.diff.issues.map((issue: DiffIssue, index: number) => (
                  <li key={index} data-testid="diff-issue">
                    {describeDiffIssue(issue)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <section
            className="diff-key-selection"
            data-testid="diff-key-selection"
            aria-label="Row diff keys"
          >
            <h3>Row diff keys</h3>
            <p className="diff-key-intro" data-testid="diff-key-intro">
              Inference is a proposal, never a key. Confirm a candidate or type explicit key
              columns; the row diff compiles only with the keys you choose.
            </p>
            {inference !== null && (
              <p className="diff-key-outcome" data-testid="diff-key-outcome">
                {inference.disclosure}
              </p>
            )}
            {inference !== null && inference.issues.length > 0 && (
              <ul data-testid="diff-key-issues">
                {inference.issues.map((issue: DiffIssue, index: number) => (
                  <li key={index} data-testid="diff-key-issue">
                    {describeDiffIssue(issue)}
                  </li>
                ))}
              </ul>
            )}
            {candidates.length === 0 ? (
              <p className="diff-key-none" data-testid="diff-key-none">
                No candidate is provable from the profiles. Type one or more key columns below.
              </p>
            ) : (
              <ul className="diff-key-candidates" data-testid="diff-key-candidates">
                {candidates.map((candidate, index) => (
                  <KeyCandidateOption
                    // Injective over the rendered list: the evidence column
                    // alone is not guaranteed unique (case-variant / duplicate
                    // spellings can both be provable), so the position
                    // discriminates — the same composite-key idiom this file
                    // uses for schema findings.
                    key={`${candidate.evidence.column}:${String(index)}`}
                    candidate={candidate}
                    checked={keyMode === 'candidate' && selectedCandidate === index}
                    onSelect={() => {
                      setKeyMode('candidate')
                      setSelectedCandidate(index)
                    }}
                  />
                ))}
              </ul>
            )}
            <div className="diff-key-manual-row">
              <label className="diff-key-manual-label">
                <input
                  type="radio"
                  name="diff-key-mode"
                  data-testid="diff-key-manual-radio"
                  checked={keyMode === 'manual'}
                  onChange={() => {
                    setKeyMode('manual')
                  }}
                />{' '}
                Use explicit keys:
              </label>{' '}
              <input
                type="text"
                className="diff-key-manual-input"
                data-testid="diff-key-manual-input"
                placeholder="column1, column2"
                value={manualKeys}
                onChange={(event) => {
                  setManualKeys(event.target.value)
                  setKeyMode('manual')
                }}
              />
            </div>
            <div className="diff-run-row">
              <button
                type="button"
                data-testid="diff-run"
                disabled={!canRun}
                onClick={() => {
                  if (chosenKeys.length === 0) return
                  onRunDiff(
                    chosenKeys,
                    keyMode === 'candidate' && chosenCandidate !== undefined
                      ? 'inferred'
                      : 'explicit',
                    keyMode === 'candidate' && chosenCandidate !== undefined
                      ? {
                          columns: chosenCandidate.columns,
                          candidateDisclosure: chosenCandidate.disclosure,
                          outcomeDisclosure: inference?.disclosure ?? '',
                          evidence: chosenCandidate.evidence,
                        }
                      : null,
                  )
                }}
              >
                {running ? 'Running row diff…' : 'Run row diff'}
              </button>
              {running && (
                <button type="button" data-testid="diff-cancel" onClick={onCancelDiff}>
                  Cancel
                </button>
              )}
            </div>
          </section>

          {runState.kind === 'running' && (
            <p className="diff-status" role="status" data-testid="diff-status">
              Running the row diff… the grid stays usable while this runs.
            </p>
          )}
          {runState.kind === 'cancelled' && (
            <p className="diff-status" role="status" data-testid="diff-status">
              Row diff cancelled — no result was changed.
            </p>
          )}
          {runState.kind === 'failed' && (
            <p className="diff-status" role="alert" data-testid="diff-status">
              The row diff failed: {runState.message} No result was changed.
            </p>
          )}
          {runState.kind === 'binding-errors' && (
            <div className="diff-binding" data-testid="diff-binding-errors">
              <p role="alert">
                The row diff does not bind against the two schemas —{' '}
                {runState.errors.length === 1
                  ? '1 problem was'
                  : `${String(runState.errors.length)} problems were`}{' '}
                found. Fix the keys or the datasets, then run again:
              </p>
              <ul>
                {runState.errors.map((error, index) => (
                  <li key={index} data-testid="diff-binding-error">
                    {describeRowDiffBindingError(error)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {report !== null && (
            <section className="diff-result" data-testid="diff-result" aria-label="Row diff result">
              <h3>Row diff</h3>
              <p data-testid="diff-verdict" role="status">
                {report.identical
                  ? identicalZeroState(report.keys)
                  : `${String(report.added.count)} added, ${String(report.removed.count)} removed, ${String(report.changed.count)} changed — rows ${String(report.rowCountA)} → ${String(report.rowCountB)} (keys: ${report.keys.join(', ')}${report.keySource === 'inferred' ? ', inferred' : ''}).`}
              </p>
              {!report.identical &&
                report.drift.length === 0 &&
                !report.deltas.some(columnDeltaDiffers) && (
                  <p className="diff-zero-note" data-testid="diff-schema-profile-none">
                    {SCHEMA_PROFILE_DIFFERENCE_CAVEAT}
                  </p>
                )}
              {report.inference !== null && (
                <p className="diff-inference" data-testid="diff-inference">
                  Inferred key — {report.inference.candidateDisclosure}
                </p>
              )}
              {stale && (
                <p className="diff-stale" role="status" data-testid="diff-stale">
                  This row diff is <strong>stale</strong> — the session's staged state changed after
                  it ran, so it may no longer reflect the current dataset view. Re-run for a fresh
                  comparison.
                </p>
              )}
              <div className="diff-aspects" data-testid="diff-aspects">
                <AspectBlock
                  aspect={report.added}
                  report={report}
                  onJumpToSample={onJumpToSample}
                />
                <AspectBlock
                  aspect={report.removed}
                  report={report}
                  onJumpToSample={onJumpToSample}
                />
                <AspectBlock
                  aspect={report.changed}
                  report={report}
                  onJumpToSample={onJumpToSample}
                />
              </div>
              {jumpError !== null && (
                <p className="diff-jump-error" role="alert" data-testid="diff-jump-error">
                  {jumpError}
                </p>
              )}

              <fieldset className="diff-export" data-testid="diff-export">
                <legend>Export the diff report</legend>
                <p className="diff-export-copy" data-testid="diff-export-copy">
                  Writes a <strong>new file</strong> with every finding above and the same exact
                  counts, in the same order. The opened file is not changed. Row keys are exported
                  without internal identifiers; no file names appear in the report; CSV string
                  values are formula-injection-sanitized like cell exports.
                </p>
                {DIFF_REPORT_FORMATS.map((info) => (
                  <label key={info.format} className="diff-export-option">
                    <input
                      type="radio"
                      name="diff-export-format"
                      value={info.format}
                      data-testid={`diff-export-format-${info.format}`}
                      checked={exportFormat === info.format}
                      onChange={() => {
                        setExportFormat(info.format)
                      }}
                    />{' '}
                    {info.label}
                  </label>
                ))}{' '}
                <button
                  type="button"
                  data-testid="diff-export-run"
                  disabled={exportPhase.kind === 'working'}
                  onClick={() => {
                    void runExport()
                  }}
                >
                  Export report…
                </button>
                {exportPhase.kind === 'working' && (
                  <p role="status" data-testid="diff-export-progress">
                    Exporting…
                  </p>
                )}
                {exportPhase.kind === 'result' && (
                  <p role="status" data-testid="diff-export-result">
                    {exportPhase.message}
                  </p>
                )}
                {exportPhase.kind === 'cancelled' && (
                  <p role="status" data-testid="diff-export-cancelled">
                    {DIFF_EXPORT_CANCELLED_MESSAGE}
                  </p>
                )}
                {exportPhase.kind === 'refused' && (
                  <p role="alert" data-testid="diff-export-refused">
                    {DIFF_EXPORT_SAME_SOURCE_MESSAGE}
                  </p>
                )}
                {exportPhase.kind === 'error' && (
                  <p role="alert" data-testid="diff-export-error">
                    {exportPhase.message}
                  </p>
                )}
              </fieldset>
            </section>
          )}

          {report !== null && report.sampleLimitEffective !== report.sampleLimitRequested && (
            <p className="diff-clamp-note" data-testid="diff-clamp-note">
              Sample limit {String(report.sampleLimitRequested)} was clamped to{' '}
              {String(report.sampleLimitEffective)} by the engine.
            </p>
          )}
        </>
      )}
    </section>
  )
}
