// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * WF-06 — the dirty-session replacement guard (v5 §7, C1–C7).
 *
 * A **native `<dialog>` opened with `showModal()`** (the Help-shaped pattern):
 * the page behind it is genuinely inert (UA top layer), the modal focus scope
 * is the trap, and `Escape` arrives as the native `cancel` event — which is
 * `Stay`, exactly like the Stay control (T3). No new modal library, no new trap
 * implementation, no dismissal-by-click-outside path.
 *
 * What it is NOT: not a confirmation over a destructive ordering. It only
 * chooses *how* to start a replacement; the live session stays byte-identical
 * until a fully prepared candidate adopts. Copy is C1–C7 byte-exact from
 * `replace/messages.ts`; no filename, path, count, cell value or dataset
 * identifier appears here (ADR 0025), and no autosave/save promise is made.
 */
import { useEffect, useRef } from 'react'
import {
  REPLACE_CHOOSE_LABEL,
  REPLACE_EXPORT_LABEL,
  REPLACE_GUARD_BODY_EXPORT,
  REPLACE_GUARD_BODY_STAGED,
  REPLACE_GUARD_BODY_STAYS,
  REPLACE_GUARD_TITLE,
  REPLACE_STAY_LABEL,
} from './messages'

export interface ReplaceGuardProps {
  /** T3 — Stay, or Escape's native `cancel`. */
  readonly onStay: () => void
  /** T4 — closes the guard, ends the intent, then opens the existing exporter. */
  readonly onExport: () => void
  /** T5 — closes the guard and re-enters `choosing` through the gate. */
  readonly onChoose: () => void
}

/** The guard's sequential-navigation stops, in document order. */
function focusableStops(dialog: HTMLDialogElement): HTMLElement[] {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    ),
  )
}

export function ReplaceGuard({ onStay, onExport, onChoose }: ReplaceGuardProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const titleRef = useRef<HTMLHeadingElement | null>(null)
  /**
   * Latest callbacks in refs so the mount effect (open, Escape, focus return)
   * never re-runs because the parent passed fresh inline callbacks — a re-run
   * would re-focus the dialog and restore focus prematurely.
   */
  const onStayRef = useRef(onStay)
  onStayRef.current = onStay
  const onExportRef = useRef(onExport)
  onExportRef.current = onExport
  const onChooseRef = useRef(onChoose)
  onChooseRef.current = onChoose

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) return
    // Captured BEFORE the modal takes focus, so every close path returns focus
    // to the opener that produced this dialog.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!dialog.open) dialog.showModal()
    // Reading comes before the actions: the title is the dialog's reading
    // start (`tabindex="-1"`), exactly like the guide's first focus stop.
    titleRef.current?.focus()
    // Escape arrives as the native `cancel` event. The parent keeps sole
    // ownership of the open state, so prevent the UA close and treat it as
    // Stay.
    const cancel = (event: Event): void => {
      event.preventDefault()
      onStayRef.current()
    }
    dialog.addEventListener('cancel', cancel)
    /**
     * Keep sequential navigation inside the guard. The native modal already
     * blocks the page behind it, but Chromium hands focus past the last stop to
     * the browser chrome, so the wrap is explicit — the same pattern the
     * guide, Export and the disclosure use.
     */
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
      // Only a CONNECTED opener takes focus back. In the guard→export chain
      // the guard (and the button that opened it) is gone by the time this
      // cleanup runs, so the fallback target is the Open control — never
      // `<body>`. The successor dialog then takes its own focus.
      if (opener !== null && opener !== document.body && opener.isConnected) {
        opener.focus()
        return
      }
      document.querySelector<HTMLElement>('[data-testid="open-button"]')?.focus()
    }
  }, [])

  return (
    <dialog
      ref={dialogRef}
      className="replace-guard"
      aria-labelledby="replace-guard-title"
      data-testid="replace-guard"
    >
      <h2 id="replace-guard-title" ref={titleRef} className="replace-guard-title" tabIndex={-1}>
        {REPLACE_GUARD_TITLE}
      </h2>
      {/*
       * C2 is only true — and only rendered — inside this dirty guard. The
       * guard prints no count of changes anywhere (the shipped pending-count
       * line counts no-ops, so it is deliberately not repeated here).
       */}
      <p className="replace-guard-body" data-testid="replace-guard-staged">
        {REPLACE_GUARD_BODY_STAGED}
      </p>
      <p className="replace-guard-body" data-testid="replace-guard-export">
        {REPLACE_GUARD_BODY_EXPORT}
      </p>
      <p className="replace-guard-body" data-testid="replace-guard-stays">
        {REPLACE_GUARD_BODY_STAYS}
      </p>
      <div className="replace-guard-actions">
        <button
          type="button"
          className="replace-guard-secondary"
          data-testid="replace-stay"
          onClick={onStayRef.current}
        >
          {REPLACE_STAY_LABEL}
        </button>{' '}
        <button
          type="button"
          className="replace-guard-secondary"
          data-testid="replace-export"
          onClick={onExportRef.current}
        >
          {REPLACE_EXPORT_LABEL}
        </button>{' '}
        <button
          type="button"
          className="replace-guard-primary"
          data-testid="replace-choose"
          onClick={onChooseRef.current}
        >
          {REPLACE_CHOOSE_LABEL}
        </button>
      </div>
    </dialog>
  )
}
