/**
 * Export dialog (m4-5): choose a format, write a **new file** from the current
 * edited view, and report the engine's honest result.
 *
 * Copy-vs-rewrite (ADR 0012): the wording is deliberately "Export a copy" /
 * "new file" and states that the opened file is never changed. Nothing here
 * offers, implies, or performs an in-place rewrite — the engine's export op
 * writes OPFS scratch (ADR 0017) and this dialog hands those bytes to a save
 * destination (File System Access picker when available, download otherwise).
 *
 * The component owns only the small state machine (idle → working → result /
 * cancelled / error); every effect (engine export, OPFS read, save write) is
 * injected so the state machine is component-tested without a browser worker
 * or native dialog. Text-only rendering; no dataset content is rendered beyond
 * the engine's counts (ADR 0025).
 */
import { useState } from 'react'
import type { EngineExportFormat, EngineExportResult } from '@assay/engine-duckdb'
import { EXPORT_FORMATS, exportFormatInfo } from './formats'
import {
  EXPORT_CANCELLED_MESSAGE,
  exportFailureMessage,
  exportSuccessMessage,
  formatRowCount,
} from './messages'
import type { SaveDestination, SaveStrategy } from './save-destination'

export interface ExportDialogProps {
  /** Row count of the current edited view (engine-backed, from the grid model). */
  readonly rowCount: number
  /** Runs the engine's export op for `format` over the active overlay. */
  readonly runEngineExport: (format: EngineExportFormat) => Promise<EngineExportResult>
  /** Acquires a save destination; resolves `null` when the user cancels. */
  readonly requestDestination: (format: EngineExportFormat) => Promise<SaveDestination | null>
  /** Reads the OPFS scratch bytes and delivers them to the destination. */
  readonly writeCopy: (
    destination: SaveDestination,
    result: EngineExportResult,
  ) => Promise<SaveStrategy>
  readonly onClose: () => void
}

/** Dialog state machine. */
type ExportPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'working' }
  | {
      readonly kind: 'result'
      readonly result: EngineExportResult
      readonly strategy: SaveStrategy
    }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'error'; readonly message: string }

export function ExportDialog({
  rowCount,
  runEngineExport,
  requestDestination,
  writeCopy,
  onClose,
}: ExportDialogProps) {
  const [selectedFormat, setSelectedFormat] = useState<EngineExportFormat>('parquet')
  const [phase, setPhase] = useState<ExportPhase>({ kind: 'idle' })

  const working = phase.kind === 'working'
  const selectedInfo = exportFormatInfo(selectedFormat)

  const run = async (): Promise<void> => {
    if (working) return
    setPhase({ kind: 'working' })
    try {
      const destination = await requestDestination(selectedFormat)
      if (destination === null) {
        // The user dismissed the save picker: nothing was written, nothing
        // failed. The engine export is never even attempted, so there is no
        // wasted materialization to explain.
        setPhase({ kind: 'cancelled' })
        return
      }
      const result = await runEngineExport(selectedFormat)
      const strategy = await writeCopy(destination, result)
      setPhase({ kind: 'result', result, strategy })
    } catch (error) {
      setPhase({ kind: 'error', message: exportFailureMessage(error) })
    }
  }

  return (
    <section
      className="export-dialog"
      role="dialog"
      aria-labelledby="export-dialog-title"
      data-testid="export-dialog"
    >
      <h2 id="export-dialog-title">Export a copy</h2>
      <p className="export-copy-notice" data-testid="export-copy-notice">
        Writes a <strong>new file</strong> with the current edited view. The opened file is not
        changed — Assay never rewrites the source.
      </p>

      <fieldset className="export-formats" disabled={working}>
        <legend>Format</legend>
        {EXPORT_FORMATS.map((info) => (
          <label key={info.format} className="export-format-option">
            <input
              type="radio"
              name="export-format"
              value={info.format}
              data-testid={`export-format-${info.format}`}
              checked={selectedFormat === info.format}
              onChange={() => {
                setSelectedFormat(info.format)
              }}
            />{' '}
            {info.label}
          </label>
        ))}
      </fieldset>
      <p className="export-format-description" data-testid="export-format-description">
        {selectedInfo.description}
      </p>
      <p className="export-options-note" data-testid="export-options-note">
        The engine applies fixed, deterministic options for each format. There are no
        user-adjustable options in this version.
      </p>
      <p className="export-view-note" data-testid="export-view-note">
        Current edited view: <span data-testid="export-view-rows">{formatRowCount(rowCount)}</span>.
      </p>

      {phase.kind === 'working' && (
        <p className="export-progress" role="status" data-testid="export-progress">
          Exporting…
        </p>
      )}
      {phase.kind === 'result' && (
        <>
          <p className="export-result" role="status" data-testid="export-result">
            {exportSuccessMessage(phase.result, phase.strategy)}
          </p>
          <p className="export-reopen-hint" data-testid="export-reopen-hint">
            To view it here, use “Open a data file…” and choose the file you wrote.
          </p>
        </>
      )}
      {phase.kind === 'cancelled' && (
        <p className="export-cancelled" role="status" data-testid="export-cancelled">
          {EXPORT_CANCELLED_MESSAGE}
        </p>
      )}
      {phase.kind === 'error' && (
        <p className="export-error" role="alert" data-testid="export-error">
          {phase.message}
        </p>
      )}

      <div className="export-actions">
        <button
          type="button"
          data-testid="export-confirm"
          disabled={working}
          onClick={() => {
            void run()
          }}
        >
          Export a copy…
        </button>{' '}
        <button type="button" data-testid="export-close" disabled={working} onClick={onClose}>
          Close
        </button>
      </div>
    </section>
  )
}
