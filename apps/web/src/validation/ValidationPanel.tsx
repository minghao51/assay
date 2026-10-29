// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Validation panel (m5-3): contract import, run controls, per-rule report,
 * sample-failure list with jump-to-row, the honest filter-to-failures
 * control, and the failure-report export — the surfaces of the invalid-row
 * explorer. The component is presentation + two small state machines; all
 * domain logic lives in the pure models (`./report-model`,
 * `./report-export`, `./contract-import`) and all session state (contract,
 * run, verdict) lives in the App, which owns the engine and the editing
 * session the verdict must stay fresh against.
 *
 * Honesty rules rendered here (each pinned by tests or e2e):
 *
 * - A `.yaml` file picked in this panel is a **contract**, not a dataset —
 *   the copy under the import button says so.
 * - Compile binding errors are first-class report content (typed, per-rule
 *   attribution via `describeBindingError`) — the run stops honestly; a
 *   partially-bound plan is never executed.
 * - Per-rule rows render the engine's frozen integer `failPercent`
 *   verbatim and lead with the documented severity ordering (see
 *   `report-model.ts`).
 * - "Show only failing rows" is offered ONLY when the sample set is
 *   complete AND the rule has a single-column predicate; otherwise it is
 *   disabled with copy that says why (partial sample / aggregate
 *   semantics) and points at the report export, which is always available.
 * - A verdict computed before the dataset's latest edits is marked STALE
 *   (the App tracks overlay revisions; the m4-3 discipline) and stays
 *   viewable; re-validation is an explicit click (no auto-revalidate).
 * - The failure report export is always a NEW file (picker/download), and
 *   every result line says the opened file is unchanged (m4-5 copy rules).
 * - Values render as React text only — no HTML anywhere (ADR 0025/0007).
 */
import { useEffect, useRef, useState } from 'react'
import type { ContractError, ContractV1 } from '@assay/contracts'
import type { BindingError } from '@assay/validation'
import { describeBindingError } from '@assay/validation'
import { formatContractParseError } from './report-model'
import type { ValidationReport, ValidationReportRow } from './report-model'
import { contractRuleCount, NOT_EXPRESSIBLE_FILTER_COPY, partialFilterCopy } from './report-model'
import { CONTRACT_TOO_LARGE_MESSAGE } from './contract-import'
import {
  buildReportBytes,
  reportExportFailureMessage,
  reportExportSuccessMessage,
  REPORT_EXPORT_CANCELLED_MESSAGE,
  REPORT_EXPORT_FORMATS,
  REPORT_EXPORT_SAME_SOURCE_MESSAGE,
} from './report-export'
import type { ReportExportFormat } from './report-export'
import type {
  SaveDestination,
  SaveStrategy,
  WritableSaveDestination,
} from '../export/save-destination'

/** Contract half of the session state (owned by the App). */
export type ContractState =
  | { readonly kind: 'none' }
  | { readonly kind: 'parse-error'; readonly errors: readonly ContractError[] }
  | { readonly kind: 'too-large' }
  | { readonly kind: 'read-failed'; readonly message: string }
  | { readonly kind: 'loaded'; readonly contract: ContractV1 }

/** Run half of the session state (owned by the App). */
export type ValidationRunState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly message: string }
  | {
      readonly kind: 'binding-errors'
      readonly errors: readonly BindingError[]
      /** Overlay revision the errors were compiled against (freshness). */
      readonly revision: number
    }
  | {
      readonly kind: 'verdict'
      readonly report: ValidationReport
      /** Overlay revision the verdict ran against (freshness signal). */
      readonly revision: number
    }

export interface ValidationPanelProps {
  readonly contractState: ContractState
  readonly runState: ValidationRunState
  /**
   * True when the dataset's overlay changed after the current verdict (or
   * binding-error report) was produced — the m4-3 verdict-freshness signal.
   * The report stays viewable, under this banner.
   */
  readonly stale: boolean
  /** App-level jump failure (the sample row is gone from the current view). */
  readonly jumpError: string | null
  /** App-level filter failure (the engine rejected the failure filter). */
  readonly filterError: string | null
  /** A contract file was picked; the App reads + parses it. */
  readonly onContractFile: (file: File) => void
  readonly onValidate: () => void
  readonly onCancelValidate: () => void
  /** Jump the grid + inspector to this sample's logical row. */
  readonly onJumpToSample: (rowKey: string) => void
  /** Apply this rule's "show only failing rows" grid filter. */
  readonly onFilterToFailures: (row: ValidationReportRow) => void
  /** Acquires a save destination for the report; resolves `null` on cancel. */
  readonly requestReportDestination: (format: ReportExportFormat) => Promise<SaveDestination | null>
  /** Delivers report bytes to the destination (FSA write or download). */
  readonly deliverReportCopy: (
    destination: WritableSaveDestination,
    content: { readonly bytes: Uint8Array<ArrayBuffer>; readonly format: ReportExportFormat },
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

/** Singular/plural honest row counts. */
function rowCountText(count: number): string {
  return `${String(count)} ${count === 1 ? 'row' : 'rows'}`
}

export function ValidationPanel({
  contractState,
  runState,
  stale,
  jumpError,
  filterError,
  onContractFile,
  onValidate,
  onCancelValidate,
  onJumpToSample,
  onFilterToFailures,
  requestReportDestination,
  deliverReportCopy,
}: ValidationPanelProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [exportFormat, setExportFormat] = useState<ReportExportFormat>('csv')
  const [exportPhase, setExportPhase] = useState<ReportExportPhase>({ kind: 'idle' })

  const report = runState.kind === 'verdict' ? runState.report : null
  const contract = contractState.kind === 'loaded' ? contractState.contract : null

  // A new verdict invalidates the previous export result line: the old
  // numbers must never linger under a fresh report.
  useEffect(() => {
    setExportPhase({ kind: 'idle' })
  }, [report])

  const runExport = async (): Promise<void> => {
    if (report === null || contract === null || exportPhase.kind === 'working') return
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
      const bytes = buildReportBytes(exportFormat, report, {
        contractName: contract.metadata.name,
        contractVersion: contract.metadata.version,
        valid: report.valid,
        stale,
        datasetRows: report.rowCount,
      })
      const strategy = await deliverReportCopy(destination, { bytes, format: exportFormat })
      setExportPhase({
        kind: 'result',
        message: reportExportSuccessMessage(report.rows.length, exportFormat, strategy),
      })
    } catch (error) {
      setExportPhase({ kind: 'error', message: reportExportFailureMessage(error) })
    }
  }

  const running = runState.kind === 'running'
  const canValidate = contract !== null && !running

  return (
    <section
      className="validation-panel"
      data-testid="validation-panel"
      aria-label="Validation"
      /*
       * ug-9/R-15 (b): the pipeline gate-failure cross-link reveals + expands
       * this section and moves focus here (a programmatic focus target, never
       * in the tab order). The panel is the section's named landmark, so focus
       * lands where the loaded contract and the next Validate control are.
       */
      tabIndex={-1}
    >
      <h2>Validation</h2>
      <p className="validation-intro" data-testid="validation-intro">
        Load a data contract (YAML) and run it against the open dataset. A <code>.yaml</code> file
        chosen here is read as a <strong>contract</strong>, not as a dataset. Nothing is uploaded —
        validation runs locally, on this machine.
      </p>

      <div className="validation-contract-row">
        <button
          type="button"
          data-testid="validation-open-contract"
          onClick={() => {
            inputRef.current?.click()
          }}
        >
          Open a contract…
        </button>
        <input
          ref={inputRef}
          type="file"
          hidden
          data-testid="validation-contract-input"
          accept=".yaml,.yml,text/yaml,application/yaml,text/plain"
          onChange={(event) => {
            const file = event.target.files?.[0]
            // Reset so picking the same file again still fires onChange.
            event.target.value = ''
            if (file !== undefined) onContractFile(file)
          }}
        />
        {contract !== null && (
          <span data-testid="validation-contract-info">
            contract <code data-testid="validation-contract-name">{contract.metadata.name}</code>{' '}
            version {String(contract.metadata.version)} · {String(contractRuleCount(contract))}{' '}
            rules
            {contract.metadata.description !== undefined &&
              contract.metadata.description !== '' && <> · {contract.metadata.description}</>}
          </span>
        )}
      </div>

      {contractState.kind === 'none' && (
        <p className="validation-zero-state" data-testid="validation-contract-none">
          No contract loaded. Open a contract YAML to define what this dataset should look like.
        </p>
      )}
      {contractState.kind === 'too-large' && (
        <p
          className="validation-import-error"
          role="alert"
          data-testid="validation-import-too-large"
        >
          {CONTRACT_TOO_LARGE_MESSAGE}
        </p>
      )}
      {contractState.kind === 'read-failed' && (
        <p
          className="validation-import-error"
          role="alert"
          data-testid="validation-import-read-failed"
        >
          The contract could not be read: {contractState.message} Nothing was loaded.
        </p>
      )}
      {contractState.kind === 'parse-error' && (
        <div className="validation-parse-errors" data-testid="validation-parse-errors">
          <p role="alert">That file is not a valid contract — nothing was loaded:</p>
          <ul>
            {contractState.errors.map((error, index) => (
              <li key={index} data-testid="validation-parse-error">
                {formatContractParseError(error)}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="validation-run-row">
        <button
          type="button"
          data-testid="validation-run"
          disabled={!canValidate}
          onClick={onValidate}
        >
          {running ? 'Validating…' : 'Validate'}
        </button>
        {running && (
          <button type="button" data-testid="validation-cancel" onClick={onCancelValidate}>
            Cancel
          </button>
        )}
        {contract === null && contractState.kind === 'none' && (
          <span className="validation-run-hint">Load a contract first.</span>
        )}
      </div>
      {runState.kind === 'running' && (
        <p className="validation-status" role="status" data-testid="validation-status">
          Validating… the grid stays usable while this runs.
        </p>
      )}
      {runState.kind === 'cancelled' && (
        <p className="validation-status" role="status" data-testid="validation-status">
          Validation cancelled — no verdict was changed.
        </p>
      )}
      {runState.kind === 'failed' && (
        <p className="validation-status" role="alert" data-testid="validation-status">
          Validation failed: {runState.message} No verdict was changed.
        </p>
      )}

      {runState.kind === 'binding-errors' && (
        <div className="validation-binding" data-testid="validation-binding-errors">
          <p role="alert">
            The contract does not fully bind to the current schema —{' '}
            {runState.errors.length === 1
              ? '1 rule was'
              : `${String(runState.errors.length)} rules were`}{' '}
            not compiled. Fix the contract or the dataset, then validate again:
          </p>
          <ul>
            {runState.errors.map((error, index) => (
              <li key={index} data-testid="validation-binding-error">
                <code>{error.ruleId ?? error.path}</code> {describeBindingError(error)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {report !== null && contract !== null && (
        <div className="validation-report" data-testid="validation-report">
          <p data-testid="validation-verdict" role="status">
            {report.valid
              ? `Valid: 0 violations across ${String(report.rows.length)} rules (${rowCountText(report.rowCount)} checked).`
              : `${String(report.rows.filter((row) => row.failing).length)} of ${String(report.rows.length)} rules fail (${rowCountText(report.rowCount)} checked).`}
          </p>
          {report.rowCount === 0 && (
            <p className="validation-empty-note" data-testid="validation-empty-note">
              The dataset has 0 rows; per-rule shares are 0 by definition.
            </p>
          )}
          {stale && (
            <p className="validation-stale" role="status" data-testid="validation-stale">
              This verdict is <strong>stale</strong> — the dataset changed after it was computed, so
              it no longer reflects the current edits. Re-validate for a fresh result.
            </p>
          )}
          <ol className="validation-rules" data-testid="validation-rules">
            {report.rows.map((row) => (
              <li
                key={row.ruleId}
                className={`validation-rule${row.failing ? ' validation-rule-failing' : ''}`}
                data-testid="validation-rule"
                data-rule-id={row.ruleId}
                data-failing={row.failing ? 'true' : 'false'}
              >
                <div className="validation-rule-head">
                  <code data-testid="validation-rule-id">{row.ruleId}</code>{' '}
                  <span data-testid="validation-rule-label">
                    {row.label}
                    {row.column !== null && (
                      <>
                        {' '}
                        — <code>{row.column}</code>
                      </>
                    )}
                    {row.kind === 'declared-type' &&
                      row.expectedType !== undefined &&
                      row.actualType !== undefined && (
                        <>
                          {' '}
                          (expected <code>{row.expectedType}</code>, found{' '}
                          <code>{row.actualType}</code>)
                        </>
                      )}
                  </span>
                  <span
                    data-testid="validation-rule-count"
                    data-failing={row.failing ? 'true' : 'false'}
                  >
                    {row.outcome === 'dataset-fact'
                      ? row.failing
                        ? 'Violated'
                        : 'Holds'
                      : `${String(row.failCount)} of ${String(report.rowCount)} ${report.rowCount === 1 ? 'row' : 'rows'} (${String(row.failPercent)}%)`}
                  </span>
                </div>
                {row.samples.length > 0 && (
                  <ul className="validation-samples" data-testid="validation-samples">
                    {row.samples.map((sample) => (
                      <li key={sample.rowKey} data-testid="validation-sample">
                        <span data-testid="validation-sample-key">{sample.displayKey}</span> value{' '}
                        <code data-testid="validation-sample-value">{sample.valueText}</code>{' '}
                        <button
                          type="button"
                          data-testid="validation-sample-jump"
                          onClick={() => {
                            onJumpToSample(sample.rowKey)
                          }}
                        >
                          Show row
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {row.filter.kind === 'ready' && (
                  <button
                    type="button"
                    className="validation-filter"
                    data-testid="validation-filter-failures"
                    onClick={() => {
                      onFilterToFailures(row)
                    }}
                  >
                    Show only failing rows
                  </button>
                )}
                {row.filter.kind === 'partial' && (
                  <span className="validation-filter-disabled">
                    <button
                      type="button"
                      className="validation-filter"
                      data-testid="validation-filter-failures"
                      disabled
                    >
                      Show only failing rows
                    </button>{' '}
                    <span data-testid="validation-filter-reason" role="note">
                      {partialFilterCopy(row.filter.samplesReturned, row.filter.failCount)}
                    </span>
                  </span>
                )}
                {row.filter.kind === 'not-expressible' && (
                  <span className="validation-filter-disabled">
                    <button
                      type="button"
                      className="validation-filter"
                      data-testid="validation-filter-failures"
                      disabled
                    >
                      Show only failing rows
                    </button>{' '}
                    <span data-testid="validation-filter-reason" role="note">
                      {NOT_EXPRESSIBLE_FILTER_COPY}
                    </span>
                  </span>
                )}
              </li>
            ))}
          </ol>
          {jumpError !== null && (
            <p className="validation-jump-error" role="alert" data-testid="validation-jump-error">
              {jumpError}
            </p>
          )}
          {filterError !== null && (
            <p
              className="validation-filter-error"
              role="alert"
              data-testid="validation-filter-error"
            >
              {filterError}
            </p>
          )}

          <fieldset className="validation-export" data-testid="validation-export">
            <legend>Export the failure report</legend>
            <p className="validation-export-copy" data-testid="validation-export-copy">
              Writes a <strong>new file</strong> with every rule above and the same counts, in the
              same order. The opened file is not changed. Sample row keys are exported without
              internal identifiers; CSV sample values are formula-injection-sanitized like cell
              exports.
            </p>
            {REPORT_EXPORT_FORMATS.map((info) => (
              <label key={info.format} className="validation-export-option">
                <input
                  type="radio"
                  name="validation-export-format"
                  value={info.format}
                  data-testid={`validation-export-format-${info.format}`}
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
              data-testid="validation-export-run"
              disabled={exportPhase.kind === 'working'}
              onClick={() => {
                void runExport()
              }}
            >
              Export report…
            </button>
            {exportPhase.kind === 'working' && (
              <p role="status" data-testid="validation-export-progress">
                Exporting…
              </p>
            )}
            {exportPhase.kind === 'result' && (
              <p role="status" data-testid="validation-export-result">
                {exportPhase.message}
              </p>
            )}
            {exportPhase.kind === 'cancelled' && (
              <p role="status" data-testid="validation-export-cancelled">
                {REPORT_EXPORT_CANCELLED_MESSAGE}
              </p>
            )}
            {exportPhase.kind === 'refused' && (
              <p role="alert" data-testid="validation-export-refused">
                {REPORT_EXPORT_SAME_SOURCE_MESSAGE}
              </p>
            )}
            {exportPhase.kind === 'error' && (
              <p role="alert" data-testid="validation-export-error">
                {exportPhase.message}
              </p>
            )}
          </fieldset>
        </div>
      )}
    </section>
  )
}
