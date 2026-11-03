// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The first-run telemetry disclosure (design §6.3, ADR 0037).
 *
 * Rendered by `App` only when `runtime.shouldShowDisclosure()` was true. The
 * body is the byte-exact §6.3 copy from `@assay/telemetry`; the two buttons
 * are the §6.3 affordances. On mount it records the disclosure as shown and
 * emits `disclosure_shown` (revision 1) — once per install: the runtime's
 * persisted flag makes the mount effect idempotent (StrictMode-safe).
 *
 * Keyboard lifecycle (ux-a3) — the panel is a REAL modal dialog:
 *
 * - It renders as a native `<dialog>` and opens through `showModal()`, so the
 *   background is genuinely inert (UA top layer: no pointer, focus or
 *   sequential-navigation path back into the page) instead of a panel that
 *   merely looks modal. The UA colour (`canvastext`) is neutralised by the
 *   scoped `.telemetry-disclosure` rule so dark mode keeps the existing AA
 *   contrast.
 * - Initial focus lands on the neutral, non-action title so a keyboard user
 *   starts by reading the disclosure rather than by silently choosing. Tab /
 *   Shift+Tab then cycle the two explicit actions and never leave the dialog
 *   (the native modal already contains sequential navigation; the local
 *   handler keeps the wrap explicit and testable).
 * - Escape is a deliberate NO-OP: the native `cancel` event is prevented, so
 *   Escape neither dismisses the dialog nor writes a preference nor acts as
 *   either choice. Consent is only ever the two explicit buttons (ADR 0037) —
 *   there is no implicit consent path.
 * - Unmount closes the dialog and returns focus to the still-connected
 *   element that had it before the modal opened; the listener and top-layer
 *   entry are removed with the component, so nothing leaks into the page.
 *
 * No preference, event, storage or transport behaviour changes here: the
 * bookkeeping effect and both action handlers are byte-identical to before.
 */
import { useEffect, useRef } from 'react'
import type { KeyboardEvent } from 'react'
import {
  DISCLOSURE_REVISION,
  WEB_DISCLOSURE_BODY,
  WEB_DISCLOSURE_KEEP_ON_LABEL,
  WEB_DISCLOSURE_TURN_OFF_LABEL,
} from '@assay/telemetry'
import { useTelemetry } from './TelemetryContext'

export interface TelemetryDisclosureProps {
  readonly onDismiss: () => void
}

/** The dialog's explicit consent actions (the only focusable controls inside). */
function actionButtons(dialog: HTMLDialogElement): HTMLButtonElement[] {
  return Array.from(
    dialog.querySelectorAll<HTMLButtonElement>(
      '.telemetry-disclosure-actions button:not([disabled])',
    ),
  )
}

/**
 * Keep sequential navigation inside the dialog. The native modal already
 * blocks the page behind it; this makes the wrap-around explicit (and provable
 * in the component tests): Tab from the initial title goes to the first
 * action, Tab on the last action wraps to the first, Shift+Tab on the first
 * action (or the title) wraps to the last.
 */
function containTabKey(
  event: KeyboardEvent<HTMLDialogElement>,
  dialog: HTMLDialogElement,
  title: HTMLElement | null,
): void {
  const actions = actionButtons(dialog)
  const first = actions[0]
  const last = actions[actions.length - 1]
  if (first === undefined || last === undefined) return
  const active = document.activeElement
  if (event.shiftKey) {
    if (active === first || active === title || active === dialog) {
      event.preventDefault()
      last.focus()
    }
    return
  }
  if (active === last) {
    event.preventDefault()
    first.focus()
    return
  }
  if (active === title || active === dialog) {
    event.preventDefault()
    first.focus()
  }
}

export function TelemetryDisclosure({ onDismiss }: TelemetryDisclosureProps) {
  const telemetry = useTelemetry()
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const titleRef = useRef<HTMLParagraphElement | null>(null)

  useEffect(() => {
    // Only emit while the disclosure is genuinely pending: `markDisclosureShown`
    // persists the flag, so React StrictMode's second effect run is a no-op.
    if (!telemetry.shouldShowDisclosure()) return
    telemetry.markDisclosureShown()
    telemetry.emit('disclosure_shown', { disclosure_revision: DISCLOSURE_REVISION })
  }, [telemetry])

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) return
    // The pre-open focus owner (null on a genuine first run, where the page had
    // nothing focused yet). Captured BEFORE the modal takes focus.
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!dialog.open) dialog.showModal()
    // Neutral initial focus: reading comes before choosing.
    titleRef.current?.focus()
    // ADR 0037: Escape must never consent, dismiss or record anything. Native
    // `cancel` would close the dialog, so consume it and stay open — the two
    // explicit choices remain the only exits.
    const preventCancel = (event: Event): void => {
      event.preventDefault()
    }
    dialog.addEventListener('cancel', preventCancel)
    return () => {
      dialog.removeEventListener('cancel', preventCancel)
      if (dialog.open) dialog.close()
      // Return focus to the still-connected pre-open owner (never to a node
      // the dialog unmount detached, never to a stale reference).
      if (
        previouslyFocused !== null &&
        previouslyFocused !== document.body &&
        previouslyFocused.isConnected
      ) {
        previouslyFocused.focus()
      }
    }
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>): void => {
    if (event.key !== 'Tab') return
    const dialog = dialogRef.current
    if (dialog === null) return
    containTabKey(event, dialog, titleRef.current)
  }

  return (
    <dialog
      ref={dialogRef}
      className="telemetry-disclosure"
      role="dialog"
      aria-modal="true"
      aria-labelledby="telemetry-disclosure-title"
      data-testid="telemetry-disclosure"
      onKeyDown={onKeyDown}
    >
      <p id="telemetry-disclosure-title" ref={titleRef} className="visually-hidden" tabIndex={-1}>
        Telemetry disclosure
      </p>
      <pre className="telemetry-disclosure-copy" data-testid="telemetry-disclosure-copy">
        {WEB_DISCLOSURE_BODY}
      </pre>
      <div className="telemetry-disclosure-actions">
        <button
          type="button"
          className="telemetry-disclosure-action"
          data-testid="telemetry-keep-on"
          onClick={() => {
            onDismiss()
          }}
        >
          {WEB_DISCLOSURE_KEEP_ON_LABEL}
        </button>
        <button
          type="button"
          className="telemetry-disclosure-action"
          data-testid="telemetry-turn-off"
          onClick={() => {
            telemetry.setPreference('off')
            onDismiss()
          }}
        >
          {WEB_DISCLOSURE_TURN_OFF_LABEL}
        </button>
      </div>
    </dialog>
  )
}
