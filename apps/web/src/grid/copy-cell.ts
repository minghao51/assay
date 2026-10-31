// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * ug-5 (UG-11): copy the focused grid cell's **display value**.
 *
 * The copied text is the exact string the cell renders: runtime-independent
 * composition through the same `formatCell(value, column.type, parsedType)`
 * call the cell body uses (`DataGrid.tsx`). Copying `String(rawValue)` would
 * hand the user a different, often wrong value — `DECIMAL` payloads arrive as
 * Arrow `DecimalBigNum` byte views, timestamps as `Date`s, NULL as `null` —
 * so the composition lives only here, next to the render path it mirrors.
 *
 * Privacy (ADR 0025): this is the app's only clipboard use. It is
 * **user-initiated and local**: nothing is read from or written to engine
 * output, no dataset value is logged, announced or telemetered, and the three
 * announcement strings below are value-free. The copied text never leaves
 * this module except through `navigator.clipboard.writeText`.
 *
 * The shortcut predicate is deliberately narrow — Ctrl/Cmd+C only, no other
 * modifier, and never when the event target is an editor control. Cells stay
 * non-editing unless an editor is open, and an open editor keeps the native
 * copy behavior (`DataGrid` also gates on `editing !== null` before reaching
 * this predicate, so a NULL button inside the editor wrapper cannot route a
 * copy here).
 */
import { formatCell } from './format'
import type { DuckDbType } from '../schema/parseType'

/**
 * The only copy feedback the user sees. All three are value-free (ADR 0025):
 * they never contain the cell value, the column name, or the row id.
 * Byte-exact — the e2e/component pins assert these strings.
 */
export const CELL_COPY_ANNOUNCEMENTS = {
  copied: 'Value copied.',
  empty: 'Nothing to copy — this cell is empty.',
  failed: 'Copy failed — the clipboard is unavailable.',
} as const

/** Form controls that own their own native copy behavior. */
const EDITOR_TAG_NAMES = new Set(['input', 'select', 'textarea'])

/**
 * True when `target` is an editor control whose native copy/selection
 * behavior must win: a form control or anything inside a `contenteditable`
 * region. Non-element targets (text nodes, a `window` target) are not editor
 * controls.
 */
export function isEditorControlTarget(target: EventTarget | null | undefined): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (EDITOR_TAG_NAMES.has(target.tagName.toLowerCase())) return true
  return target.closest('[contenteditable]') !== null
}

/**
 * The minimal keydown shape the predicate reads. `KeyboardEvent` and React's
 * synthetic keyboard event both satisfy it structurally.
 */
export interface CellCopyShortcutEvent {
  readonly key: string
  readonly ctrlKey?: boolean
  readonly metaKey?: boolean
  readonly altKey?: boolean
  readonly shiftKey?: boolean
  readonly target?: EventTarget | null
}

/**
 * True only for the copy gesture the grid owns: Ctrl+C / Cmd+C with no Alt
 * and no Shift, on a target that is not an editor control. Plain `c`, other
 * modifier combinations, and copies started inside an editor return false, so
 * the caller never `preventDefault`s a native copy.
 *
 * macOS uses `metaKey`; `shiftKey` is rejected because Ctrl+Shift+C is a
 * different gesture (Chromium opens DevTools) and "other modifiers" must not
 * be intercepted.
 */
export function isCellCopyShortcut(event: CellCopyShortcutEvent): boolean {
  if (event.ctrlKey !== true && event.metaKey !== true) return false
  if (event.altKey === true || event.shiftKey === true) return false
  if (event.key.toLowerCase() !== 'c') return false
  return !isEditorControlTarget(event.target)
}

/**
 * The display text to copy for one cell, or `null` when there is nothing to
 * copy. `formatCell` is total and renders NULL/undefined (and an empty
 * string) as `''`; an empty display value is "nothing to copy", not a copy of
 * an empty string.
 *
 * `type`/`parsedType` are passed exactly as the cell render passes them, so
 * decimal and nested formatting match what the user sees.
 */
export function composeCellCopyText(
  value: unknown,
  type?: string,
  parsedType?: DuckDbType | null,
): string | null {
  const text = formatCell(value, type, parsedType)
  return text === '' ? null : text
}
