// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * EW-04I — the column-repair surface: capture → preview → Apply.
 *
 * A **native `<dialog>` opened with `showModal()`** — the Help/CSV-review
 * pattern (UA top layer, UA focus scope, `Escape` arriving as the native
 * `cancel` event). No new modal library and no hand-rolled focus trap.
 *
 * What it shows and what it refuses to show:
 *
 * - **Capture first, preview second, Apply last.** Preview reads the column;
 *   Apply is unavailable until a preview of *this exact plan* against *this
 *   exact session* is on screen (the hook owns that gate; the button is only
 *   its mirror).
 * - **Complete counts + bounded examples** (EW-04D §3). Three counts and
 *   `≤10` before/after pairs, with the cap stated against the complete
 *   affected count. No matching rows are held as an array: the read is
 *   `LIMIT`-ed and the state holds at most those entries.
 * - **Row labels, not anchors.** An example's logical row id is rendered
 *   through the domain's anchor-free `displayRowKey` (`base #12` /
 *   `insert #3`), the shared grammar of every row-key surface — the opaque
 *   host anchor tokens are never put in the DOM (`edit/overlay-base.ts`).
 * - **Values are shown exactly**, with `white-space: pre-wrap` on the cells, so
 *   a whitespace-only difference is visible instead of collapsed. Nothing here
 *   logs, classifies or transmits a value (ADR 0025).
 */
import { useEffect, useRef } from 'react'
import type { ColumnSpec } from '@assay/domain'
import { displayRowKey } from '@assay/domain'
import {
  REPAIR_APPLY,
  REPAIR_CANCEL,
  REPAIR_COLUMN_HELPER,
  REPAIR_COLUMN_LABEL,
  REPAIR_COUNT_AFFECTED,
  REPAIR_COUNT_NOTE,
  REPAIR_COUNT_SCANNED,
  REPAIR_COUNT_UNAFFECTED,
  REPAIR_EXAMPLES_HEADING,
  REPAIR_EXAMPLES_NONE,
  REPAIR_EXAMPLES_NOTE,
  REPAIR_EXAMPLE_AFTER,
  REPAIR_EXAMPLE_BEFORE,
  REPAIR_EXAMPLE_ROW,
  REPAIR_MAPPING_HELPER,
  REPAIR_MAPPING_LABEL,
  REPAIR_PREVIEW_ACTION,
  REPAIR_PREVIEW_HEADING,
  REPAIR_PREVIEW_LOADING,
  REPAIR_PREVIEW_OUTDATED,
  REPAIR_PREVIEW_STALE,
  REPAIR_SCOPE,
  REPAIR_TITLE,
  REPAIR_TRIM_CUSTOM,
  REPAIR_TRIM_CUSTOM_HELPER,
  REPAIR_TRIM_CUSTOM_LABEL,
  REPAIR_TRIM_DEFAULT,
  REPAIR_TRIM_DEFAULT_HELPER,
  REPAIR_TRIM_LABEL,
  REPAIR_TRIM_NONE,
  repairPairCountSentence,
  repairTrimCountSentence,
} from './copy'
import { REPAIR_PAIR_CAP, REPAIR_TRIM_CAP, type RepairTrimMode } from './plan'
import { previewExampleCapSentence } from './preview'
import type { RepairSurface } from './useRepairPreview'

/** The placeholder option (no column chosen yet). */
const NO_COLUMN = 'Choose a column…'

export interface RepairDialogProps {
  /** The *effective* schema (post-rename/cast) the plan can target. */
  readonly columns: readonly ColumnSpec[]
  readonly surface: RepairSurface
}

/** The dialog's sequential-navigation stops, in document order. */
function focusableStops(dialog: HTMLDialogElement): HTMLElement[] {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]',
    ),
  )
}

export function RepairDialog({ columns, surface }: RepairDialogProps): React.JSX.Element {
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const titleRef = useRef<HTMLHeadingElement | null>(null)
  const { closeDialog } = surface
  const closeRef = useRef(closeDialog)
  closeRef.current = closeDialog

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!dialog.open) dialog.showModal()
    titleRef.current?.focus()
    const cancel = (event: Event): void => {
      event.preventDefault()
      closeRef.current()
    }
    dialog.addEventListener('cancel', cancel)
    const wrapTab = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return
      const stops = focusableStops(dialog)
      const first = stops[0]
      const last = stops[stops.length - 1]
      if (first === undefined || last === undefined) return
      const current = document.activeElement
      const outside = current === null || !dialog.contains(current)
      if (event.shiftKey && (outside || current === first || current === titleRef.current)) {
        event.preventDefault()
        last.focus()
        return
      }
      if (!event.shiftKey && (outside || current === last)) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', wrapTab)
    return () => {
      document.removeEventListener('keydown', wrapTab)
      dialog.removeEventListener('cancel', cancel)
      if (dialog.open) dialog.close()
      if (opener !== null && opener !== document.body && opener.isConnected) {
        opener.focus()
        return
      }
      document.querySelector<HTMLElement>('[data-testid="repair-open"]')?.focus()
    }
  }, [])

  const { draft, update, preview } = surface
  const trimHelper =
    draft.trimMode === 'custom' ? REPAIR_TRIM_CUSTOM_HELPER : REPAIR_TRIM_DEFAULT_HELPER

  return (
    <dialog
      ref={dialogRef}
      className="repair-dialog"
      aria-labelledby="repair-title"
      data-testid="repair"
    >
      <h2 id="repair-title" ref={titleRef} className="repair-title" tabIndex={-1}>
        {REPAIR_TITLE}
      </h2>
      <p className="repair-scope" data-testid="repair-scope">
        {REPAIR_SCOPE}
      </p>

      <section aria-labelledby="repair-capture-heading" data-testid="repair-capture">
        <h3 id="repair-capture-heading" className="visually-hidden">
          Plan
        </h3>
        <div className="repair-field">
          <label htmlFor="repair-column" className="repair-label">
            {REPAIR_COLUMN_LABEL}
          </label>
          <select
            id="repair-column"
            data-testid="repair-column"
            className="repair-select"
            value={draft.column}
            onChange={(event) => {
              update({ column: event.target.value })
            }}
          >
            <option value="">{NO_COLUMN}</option>
            {columns.map((column) => (
              <option key={column.name} value={column.name}>
                {`${column.name} (${column.type})`}
              </option>
            ))}
          </select>
          <p className="repair-helper" data-testid="repair-column-helper">
            {REPAIR_COLUMN_HELPER}
          </p>
        </div>

        <div className="repair-field">
          <label htmlFor="repair-trim-mode" className="repair-label">
            {REPAIR_TRIM_LABEL}
          </label>
          <select
            id="repair-trim-mode"
            data-testid="repair-trim-mode"
            className="repair-select"
            value={draft.trimMode}
            onChange={(event) => {
              update({ trimMode: event.target.value as RepairTrimMode })
            }}
          >
            <option value="none">{REPAIR_TRIM_NONE}</option>
            <option value="default">{REPAIR_TRIM_DEFAULT}</option>
            <option value="custom">{REPAIR_TRIM_CUSTOM}</option>
          </select>
          <p className="repair-helper" data-testid="repair-trim-helper">
            {trimHelper}
          </p>
          {draft.trimMode === 'custom' ? (
            <div className="repair-field">
              <label htmlFor="repair-trim-custom" className="repair-label">
                {REPAIR_TRIM_CUSTOM_LABEL}
              </label>
              <input
                id="repair-trim-custom"
                data-testid="repair-trim-custom"
                className="repair-input"
                type="text"
                value={draft.customTrim}
                onChange={(event) => {
                  update({ customTrim: event.target.value })
                }}
              />
            </div>
          ) : null}
          <p className="repair-helper" data-testid="repair-trim-count">
            {repairTrimCountSentence(surface.trimCodePoints, REPAIR_TRIM_CAP)}
          </p>
        </div>

        <div className="repair-field">
          <label htmlFor="repair-mapping" className="repair-label">
            {REPAIR_MAPPING_LABEL}
          </label>
          <textarea
            id="repair-mapping"
            data-testid="repair-mapping"
            className="repair-textarea"
            rows={5}
            value={draft.mappingText}
            onChange={(event) => {
              update({ mappingText: event.target.value })
            }}
          />
          <p className="repair-helper" data-testid="repair-mapping-helper">
            {REPAIR_MAPPING_HELPER}
          </p>
          <p className="repair-helper" data-testid="repair-pair-count">
            {repairPairCountSentence(surface.pairCount, REPAIR_PAIR_CAP)}
          </p>
        </div>

        {surface.refusal === null ? null : (
          <p role="alert" className="repair-refusal" data-testid="repair-refusal">
            {surface.refusal.message}
          </p>
        )}
        {surface.budgetRefusal === null ? null : (
          <p role="alert" className="repair-refusal" data-testid="repair-budget-refusal">
            {surface.budgetRefusal}
          </p>
        )}
        <button
          type="button"
          className="repair-secondary"
          data-testid="repair-preview"
          disabled={!surface.canPreview}
          onClick={() => {
            surface.runPreview()
          }}
        >
          {REPAIR_PREVIEW_ACTION}
        </button>
      </section>

      <section aria-labelledby="repair-preview-heading" data-testid="repair-preview-panel">
        <h3 id="repair-preview-heading" className="repair-heading">
          {REPAIR_PREVIEW_HEADING}
        </h3>
        {preview.kind === 'loading' ? (
          <p className="repair-helper" data-testid="repair-preview-loading">
            {REPAIR_PREVIEW_LOADING}
          </p>
        ) : null}
        {preview.kind === 'failed' ? (
          <p role="alert" className="repair-refusal" data-testid="repair-preview-failed">
            {preview.message}
          </p>
        ) : null}
        {surface.previewStale ? (
          <p role="status" className="repair-stale" data-testid="repair-preview-stale">
            {REPAIR_PREVIEW_STALE}
          </p>
        ) : null}
        {surface.previewOutdated ? (
          <p role="status" className="repair-stale" data-testid="repair-preview-outdated">
            {REPAIR_PREVIEW_OUTDATED}
          </p>
        ) : null}
        {preview.kind === 'ready' ? (
          <>
            <dl className="repair-counts">
              <div>
                <dt>{REPAIR_COUNT_SCANNED}</dt>
                <dd data-testid="repair-count-scanned">{String(preview.preview.counts.scanned)}</dd>
              </div>
              <div>
                <dt>{REPAIR_COUNT_AFFECTED}</dt>
                <dd data-testid="repair-count-affected">
                  {String(preview.preview.counts.affected)}
                </dd>
              </div>
              <div>
                <dt>{REPAIR_COUNT_UNAFFECTED}</dt>
                <dd data-testid="repair-count-unaffected">
                  {String(preview.preview.counts.unaffected)}
                </dd>
              </div>
            </dl>
            <p className="repair-helper" data-testid="repair-count-note">
              {REPAIR_COUNT_NOTE}
            </p>
            <h4 className="repair-subheading">{REPAIR_EXAMPLES_HEADING}</h4>
            <p className="repair-helper" data-testid="repair-example-cap">
              {previewExampleCapSentence(preview.preview)}
            </p>
            <p className="repair-helper" data-testid="repair-example-note">
              {REPAIR_EXAMPLES_NOTE}
            </p>
            {preview.preview.examples.length === 0 ? (
              <p className="repair-helper" data-testid="repair-examples-none">
                {REPAIR_EXAMPLES_NONE}
              </p>
            ) : (
              <table className="repair-table" data-testid="repair-examples">
                <thead>
                  <tr>
                    <th scope="col">{REPAIR_EXAMPLE_ROW}</th>
                    <th scope="col">{REPAIR_EXAMPLE_BEFORE}</th>
                    <th scope="col">{REPAIR_EXAMPLE_AFTER}</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.preview.examples.map((example) => (
                    <tr key={example.rowId} data-testid="repair-example">
                      <td data-testid="repair-example-row">{displayRowKey(example.rowId)}</td>
                      <td data-testid="repair-example-before">{example.before}</td>
                      <td data-testid="repair-example-after">{example.after}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        ) : null}
      </section>

      {surface.message === null ? null : (
        <p role="alert" className="repair-refusal" data-testid="repair-message">
          {surface.message}
        </p>
      )}

      <div className="repair-actions">
        {surface.applyBlockedReason === null ? null : (
          <p className="repair-helper" data-testid="repair-apply-blocked">
            {surface.applyBlockedReason}
          </p>
        )}
        <button
          type="button"
          className="repair-secondary"
          data-testid="repair-cancel"
          onClick={() => {
            surface.closeDialog()
          }}
        >
          {REPAIR_CANCEL}
        </button>{' '}
        <button
          type="button"
          className="repair-primary"
          data-testid="repair-apply"
          disabled={!surface.canApply}
          onClick={() => {
            surface.applyPreview()
          }}
        >
          {REPAIR_APPLY}
        </button>
      </div>
    </dialog>
  )
}
