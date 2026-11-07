// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Workbench guide (rd-7 / D-03) — the ONE global Help surface.
 *
 * Scope, by decision: a single minimal guide, not per-task help. It is a native
 * `<dialog>` opened with `showModal()`, so the page behind it is genuinely
 * inert (UA top layer) instead of a panel that merely looks modal; there is no
 * new modal library and no new trap implementation — the browser's modal focus
 * scope is the trap, and `Escape` is the native `cancel` event. Both close
 * paths (the Close control and Escape) unmount the dialog, whose cleanup
 * returns focus to the control that opened it (the header's `help-open`
 * button).
 *
 * Content is the approved, byte-exact §4 copy in the approved order:
 * what this is → the four tasks → formats and locality → keyboard. The four
 * task purposes are imported from `workbench/tasks.ts` rather than retyped, so
 * the guide and the task strip can never drift apart. No links out, no
 * telemetry, no navigation, and no value of any kind (no file name, path, row
 * count or dataset content — ADR 0025).
 */

import { useEffect, useRef } from 'react'
import { WORKBENCH_TASKS } from '../workbench/tasks'

/** §4 title (the dialog's accessible name) and the header control's label. */
export const WORKBENCH_HELP_TITLE = 'Workbench guide'
export const WORKBENCH_HELP_OPEN_LABEL = 'Help'
/** The close control's label: the shell's existing dialog affordance (Settings, Export). */
export const WORKBENCH_HELP_CLOSE_LABEL = 'Close'

/** §4-1 "What this is". */
export const WORKBENCH_HELP_WHAT_THIS_IS =
  'Inspect, check, change and deliver a dataset without leaving this machine. Nothing is uploaded; the file you open is never modified. Changes are staged in this session and exported as a new copy.'

/** §4-2 the line that follows the four tasks. */
export const WORKBENCH_HELP_TASK_NOTE =
  'Choose a task to see the sections it uses. Grid and Record stay available in every task.'

/**
 * §4-3 "Formats and locality", split around the `extensions.duckdb.org` code
 * span. Concatenating the three parts reproduces the approved paragraph
 * exactly; the split exists only so the host is a real `<code>` element.
 */
export const WORKBENCH_HELP_FORMATS_LEAD =
  "Reads Parquet, CSV, JSONL/NDJSON and JSON; Arrow is an export format, not an input. This browser app may download DuckDB's Parquet or JSON reader from "
export const WORKBENCH_HELP_FORMATS_HOST = 'extensions.duckdb.org'
export const WORKBENCH_HELP_FORMATS_TAIL =
  ' the first time it opens such a file, so opening one without a network connection is not guaranteed. The desktop app ships those readers locally.'

/** §4-4 "Keyboard". */
export const WORKBENCH_HELP_KEYBOARD =
  'The task strip is a radio group: arrow keys move between tasks, Home and End jump to the first and last. Section links move focus to the section. In the grid, arrows move the focused cell and Enter opens the editor. Esc closes a dialog.'

/** The separator between a task's name and its approved purpose (§4-2). */
export const WORKBENCH_HELP_TASK_SEPARATOR = '—'

export interface WorkbenchHelpProps {
  /** Called by both close paths; the parent unmounts the dialog. */
  readonly onClose: () => void
}

/**
 * The guide's sequential-navigation stops, in document order: the scrollable
 * body (`tabindex="0"`) and the Close control. The title is deliberately not
 * one — it is the `tabindex="-1"` reading start.
 */
function focusableStops(dialog: HTMLDialogElement): HTMLElement[] {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    ),
  )
}

export function WorkbenchHelp({ onClose }: WorkbenchHelpProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const titleRef = useRef<HTMLHeadingElement | null>(null)
  /**
   * Latest `onClose` in a ref so the mount effect (open, Escape, focus return)
   * never re-runs because the parent passed a fresh inline callback — a re-run
   * would re-focus the dialog and restore focus prematurely.
   */
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) return
    // Captured BEFORE the modal takes focus, so Escape and Close both return
    // focus to the header control that opened the guide.
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!dialog.open) dialog.showModal()
    // Reading comes before acting: initial focus is the guide's own title (a
    // `tabindex="-1"` reading start, not a tab stop), exactly like the
    // first-run telemetry disclosure.
    titleRef.current?.focus()
    // Escape arrives as the native `cancel` event. Prevent the UA's own close
    // so the parent stays the single owner of the open state, then close.
    const cancel = (event: Event): void => {
      event.preventDefault()
      onCloseRef.current()
    }
    dialog.addEventListener('cancel', cancel)
    /**
     * Keep sequential navigation inside the guide. The native modal already
     * blocks the page behind it, but Chromium hands focus past the last stop
     * to the browser chrome (`document.activeElement` falls to `<body>`), so
     * the wrap is explicit — the SAME pattern the app's other two dialogs use
     * (ExportDialog's document-level Tab wrap, TelemetryDisclosure's
     * `containTabKey`), not a new trap architecture. A document-level listener
     * is used because the event's target is `<body>` at the wrap point.
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
      // Never focus a node a concurrent unmount detached.
      if (opener !== null && opener !== document.body && opener.isConnected) {
        opener.focus()
      }
    }
  }, [])

  return (
    <dialog
      ref={dialogRef}
      className="workbench-help-dialog"
      aria-labelledby="workbench-help-title"
      data-testid="workbench-help"
    >
      <h2 id="workbench-help-title" ref={titleRef} className="workbench-help-title" tabIndex={-1}>
        {WORKBENCH_HELP_TITLE}
      </h2>
      {/*
       * The body is the scroll container at 900×900 and small heights. Giving
       * it `tabindex="0"` keeps it keyboard-scrollable (`scrollable-region-
       * focusable`) and gives the dialog a second tab stop, which keeps Tab
       * cycling inside the modal even in browsers that hand a single-control
       * modal's Tab to the chrome.
       */}
      <div className="workbench-help-body" tabIndex={0} data-testid="workbench-help-body">
        <h3 className="workbench-help-heading">What this is</h3>
        <p className="workbench-help-paragraph" data-testid="help-what-this-is">
          {WORKBENCH_HELP_WHAT_THIS_IS}
        </p>

        <h3 className="workbench-help-heading">The four tasks</h3>
        <ul className="workbench-help-tasks" data-testid="help-tasks">
          {WORKBENCH_TASKS.map((task) => (
            <li key={task.id} className="workbench-help-task" data-testid={`help-task-${task.id}`}>
              <strong>{task.name}</strong> {WORKBENCH_HELP_TASK_SEPARATOR} {task.purpose}
            </li>
          ))}
        </ul>
        <p className="workbench-help-paragraph" data-testid="help-task-note">
          {WORKBENCH_HELP_TASK_NOTE}
        </p>

        <h3 className="workbench-help-heading">Formats and locality</h3>
        <p className="workbench-help-paragraph" data-testid="help-formats">
          {WORKBENCH_HELP_FORMATS_LEAD}
          <code className="workbench-help-code">{WORKBENCH_HELP_FORMATS_HOST}</code>
          {WORKBENCH_HELP_FORMATS_TAIL}
        </p>

        <h3 className="workbench-help-heading">Keyboard</h3>
        <p className="workbench-help-paragraph" data-testid="help-keyboard">
          {WORKBENCH_HELP_KEYBOARD}
        </p>
      </div>
      <div className="workbench-help-actions">
        <button
          type="button"
          className="workbench-help-close"
          data-testid="help-close"
          onClick={() => {
            onCloseRef.current()
          }}
        >
          {WORKBENCH_HELP_CLOSE_LABEL}
        </button>
      </div>
    </dialog>
  )
}
