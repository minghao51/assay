// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * ug-6 (UG-10): the shell's document-level Undo/Redo shortcuts and the
 * first-append History cue — the *rules*, kept free of React and of DOM
 * globals so they are Node-testable in isolation.
 *
 * Two independent decisions live here:
 *
 * 1. **Shortcut classification** (`classifyHistoryShortcut`). The shell owns
 *    exactly one keydown listener (registered in `App`), which forwards
 *    Ctrl/Cmd+Z to the editing session's existing `handleUndo` and
 *    Ctrl/Cmd+Shift+Z / Ctrl/Cmd+Y to `handleRedo`. These are *shortcuts for
 *    the single visible pair* in `HistoryPanel` (ux-3 ruling) — no second
 *    control pair, no new toolbar button.
 *
 *    Native text undo must win inside anything the user types in: an
 *    `input`, `textarea`, `select`, or a `contenteditable` host (or a node
 *    inside one) returns `null`, so the listener neither handles the event
 *    nor calls `preventDefault()`. `defaultPrevented` events are ignored too
 *    — another handler already claimed the gesture.
 *
 * 2. **First-append History cue** (`shouldAutoExpandHistory`). The queue row
 *    allows either a badge or an auto-expand; ug-6 auto-expands the History
 *    section (the existing `openSection('history')` seam, no new token or
 *    control) exactly once: on the first transition from 0 entries to a
 *    non-zero history. Undo/redo are cursor moves that never change
 *    `entries.length`, so they cannot fire it; dataset open/reset moves the
 *    length *down* to 0, which also cannot fire it. `alreadyCued` makes the
 *    cue one-shot, so once the user has collapsed History it never re-opens
 *    on later appends.
 *
 * Privacy (ADR 0025): nothing here reads, logs or announces a value — the
 * module handles key names and a count.
 */

/** The two history cursor gestures the shell's shortcuts map onto. */
export type HistoryShortcut = 'undo' | 'redo'

/** Form controls whose own native text undo must win over the shell shortcut. */
const EDITABLE_TAG_NAMES: ReadonlySet<string> = new Set(['input', 'textarea', 'select'])

/**
 * The minimal keydown shape the classifier reads. A real `KeyboardEvent` (and
 * React's synthetic keyboard event) satisfies it structurally.
 */
export interface HistoryShortcutEvent {
  readonly key: string
  readonly ctrlKey?: boolean
  readonly metaKey?: boolean
  readonly altKey?: boolean
  readonly shiftKey?: boolean
  readonly defaultPrevented?: boolean
  readonly target?: EventTarget | null
}

/**
 * True when `target` is an editing surface whose native undo/redo must be
 * preserved: a form control, a `contenteditable` host, or any node inside
 * one. Deliberately duck-typed (`closest` is the DOM ancestor walk) so the
 * module never references a DOM global and non-element targets — `window`,
 * `document`, a text node, a plain stub — are simply "not editable".
 */
export function isEditableTarget(target: EventTarget | null | undefined): boolean {
  if (target === null || target === undefined) return false
  // SAFETY: only the DOM surface this predicate reads is probed — `closest`,
  // `tagName` and the optional `isContentEditable` are duck-typed and guarded
  // by `typeof` below, so a non-element `EventTarget` (window/document/text
  // node) is rejected rather than dereferenced.
  const element = target as unknown as Partial<HTMLElement>
  if (typeof element.closest !== 'function') return false
  const tagName = typeof element.tagName === 'string' ? element.tagName.toLowerCase() : ''
  if (EDITABLE_TAG_NAMES.has(tagName)) return true
  if (element.isContentEditable === true) return true
  return element.closest('[contenteditable]') !== null
}

/**
 * Classify one keydown as the shell's history gesture, or `null` when the
 * event belongs to someone else.
 *
 * Accepted (`ctrlKey || metaKey`, never with Alt):
 * - `z` without Shift → `undo`
 * - `z` with Shift → `redo`
 * - `y` without Shift → `redo` (the Windows/Linux redo convention)
 *
 * Everything else returns `null`: plain `z`/`y`, Ctrl+Shift+Y, any Alt
 * combination, already-prevented events, and every editable target.
 */
export function classifyHistoryShortcut(event: HistoryShortcutEvent): HistoryShortcut | null {
  if (event.defaultPrevented === true) return null
  if (event.ctrlKey !== true && event.metaKey !== true) return null
  if (event.altKey === true) return null
  if (isEditableTarget(event.target)) return null

  const key = event.key.toLowerCase()
  if (key === 'z') return event.shiftKey === true ? 'redo' : 'undo'
  if (key === 'y') return event.shiftKey === true ? null : 'redo'
  return null
}

/** The transition inputs the first-append cue reads. */
export interface HistoryCueInput {
  /** `history.entries.length` before this commit. */
  readonly previousEntries: number
  /** `history.entries.length` in this commit. */
  readonly nextEntries: number
  /** True once the cue has already fired for this App session. */
  readonly alreadyCued: boolean
}

/**
 * True only for the first 0 → >0 entries transition, and only while the cue
 * has not already fired. Never true for undo/redo (they leave the length
 * alone), a dataset open/reset (the length moves to 0), a later append
 * (previous > 0), or a re-append after the user collapsed History
 * (`alreadyCued`).
 */
export function shouldAutoExpandHistory(input: HistoryCueInput): boolean {
  if (input.alreadyCued) return false
  return input.previousEntries === 0 && input.nextEntries > 0
}
