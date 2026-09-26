// SPDX-License-Identifier: AGPL-3.0-or-later

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
import { useEffect, useRef, useState } from 'react'
import type { EngineExportFormat, EngineExportResult } from '@assay/engine-duckdb'
import { EXPORT_FORMATS, exportFormatInfo } from './formats'
import {
  EXPORT_CANCELLED_MESSAGE,
  EXPORT_SAME_SOURCE_MESSAGE,
  exportFailureMessage,
  exportReopenGuidance,
  exportSuccessMessage,
  exportViewSubsetNote,
  formatRowCount,
} from './messages'
import type { SaveDestination, SaveStrategy, WritableSaveDestination } from './save-destination'

export interface ExportDialogProps {
  /**
   * Effective (unfiltered) row count of the edited dataset — the domain's
   * `liveRowCount` at the history cursor, NOT the grid's filtered count:
   * `exportView` exports base + overlay in natural order, with no view
   * filters or sorting (m4-5 review finding: the dialog used to echo the
   * grid's filtered count while the export contained every row).
   */
  readonly rowCount: number
  /**
   * True when the grid view currently applies at least one filter. Tracked
   * separately from sorting (m4-5 fix round 2) so the dialog describes only
   * the state that is actually active.
   */
  readonly viewFiltered: boolean
  /** True when the grid view currently applies a sort. */
  readonly viewSorted: boolean
  /** Runs the engine's export op for `format` over the active overlay. */
  readonly runEngineExport: (format: EngineExportFormat) => Promise<EngineExportResult>
  /** Acquires a save destination; resolves `null` when the user cancels. */
  readonly requestDestination: (format: EngineExportFormat) => Promise<SaveDestination | null>
  /** Reads the OPFS scratch bytes and delivers them to the destination. */
  readonly writeCopy: (
    destination: WritableSaveDestination,
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
  /**
   * The save picker returned the opened source's own entry. Rendered before
   * any engine work or byte write — a save to the opened file is the exact
   * in-place rewrite ADR 0012 forbids.
   */
  | { readonly kind: 'refused' }
  | { readonly kind: 'error'; readonly message: string }

export function ExportDialog({
  rowCount,
  viewFiltered,
  viewSorted,
  runEngineExport,
  requestDestination,
  writeCopy,
  onClose,
}: ExportDialogProps) {
  const [selectedFormat, setSelectedFormat] = useState<EngineExportFormat>('parquet')
  const [phase, setPhase] = useState<ExportPhase>({ kind: 'idle' })
  const dialogRef = useRef<HTMLElement | null>(null)
  /**
   * Latest `onClose` in a ref so the mount effect below (initial focus, focus
   * trap, Escape) never re-runs just because the parent passed a fresh inline
   * callback — re-running it would re-focus the dialog and restore focus
   * prematurely.
   */
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  /**
   * AR-W10 dialog semantics: initial focus into the dialog, a Tab/Shift+Tab
   * trap that cycles inside while open, Escape-to-close, and focus restored
   * to the trigger on unmount (the dialog is conditionally rendered, so the
   * trigger survives). Hand-rolled against the native `keydown` event — no
   * new dependency.
   */
  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) return
    const opener = document.activeElement
    const focusable = (): HTMLElement[] =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      )
    // Initial focus: the first real control. In the `working` phase every
    // control is disabled, so the focused dialog itself still holds focus
    // inside the trap.
    ;(focusable()[0] ?? dialog).focus()

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusable()
      if (items.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const firstItem = items[0]
      const lastItem = items[items.length - 1]
      const current = document.activeElement
      // A disabled control loses focus to `<body>`, and the modal must still
      // trap it: treat "focus outside the dialog" as both the first and the
      // last position so the next Tab lands back inside.
      const outside = !dialog.contains(current)
      if (event.shiftKey && (outside || current === firstItem || current === dialog)) {
        event.preventDefault()
        lastItem.focus()
      } else if (!event.shiftKey && (outside || current === lastItem)) {
        event.preventDefault()
        firstItem.focus()
      }
    }
    // A document-level listener (not the dialog node): while the dialog is
    // open, Escape and the Tab trap must work even when focus has fallen to
    // `<body>` (every control is momentarily disabled during the export).
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      // Return focus to the element that opened the dialog (Escape/Close path)
      // only when it is still in the document.
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
    }
  }, [])

  const working = phase.kind === 'working'
  // The export starts by disabling every control; if that dropped focus to
  // `<body>`, pull it back to the dialog so the modal keeps an active element.
  useEffect(() => {
    if (!working) return
    const dialog = dialogRef.current
    if (dialog !== null && !dialog.contains(document.activeElement)) dialog.focus()
  }, [working])
  const selectedInfo = exportFormatInfo(selectedFormat)
  // Honest per-state wording (m4-5 fix round 2): filtering and sorting are
  // described separately; `null` adds no note when the grid is unmodified.
  const viewSubsetNote = exportViewSubsetNote(viewFiltered, viewSorted)

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
      if (destination.via === 'refused-source') {
        // The picked destination is the opened file itself. Refused inside
        // the destination request — before any engine work and before any
        // byte write — so the source cannot be replaced by its own export.
        setPhase({ kind: 'refused' })
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
      ref={dialogRef}
      className="export-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-dialog-title"
      data-testid="export-dialog"
      tabIndex={-1}
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
        Exports the <strong>complete edited dataset</strong> — all{' '}
        <span data-testid="export-view-rows">{formatRowCount(rowCount)}</span> in natural order.
        Grid filters and sorting are not applied.
      </p>
      {viewSubsetNote !== null && (
        <p className="export-filtered-note" data-testid="export-filtered-note">
          {viewSubsetNote}
        </p>
      )}

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
            {exportReopenGuidance(phase.result.format)}
          </p>
        </>
      )}
      {phase.kind === 'cancelled' && (
        <p className="export-cancelled" role="status" data-testid="export-cancelled">
          {EXPORT_CANCELLED_MESSAGE}
        </p>
      )}
      {phase.kind === 'refused' && (
        <p className="export-refused" role="alert" data-testid="export-refused">
          {EXPORT_SAME_SOURCE_MESSAGE}
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
