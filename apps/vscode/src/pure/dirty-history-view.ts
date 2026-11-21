// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Dirty-history display (D03b): the view-model half of the desktop
 * session-editing surface — the grid's editing-control state, the edit
 * status line, and the dirty-cell predicate over the effective overlay.
 *
 * Extracted from the webview entry as a DOM-free module with explicit inputs
 * and outputs so the dirty/history rules (a cell is dirty when its row was
 * inserted live or its value differs from the base) are unit-testable in
 * Node, next to the `EditController` they project.
 */
import { overlayEdit } from '@assay/domain'
import type { OverlayState, RowId } from '@assay/domain'
import type { EditControllerSnapshot } from './edit-controller'

/** The grid toolbar's editing-control state for one snapshot. */
export interface EditingControlState {
  readonly busy: boolean
  readonly dirty: boolean
  readonly canUndo: boolean
  readonly canRedo: boolean
}

/**
 * Derive the toolbar state. `dirty`/`canUndo` track the history cursor (a
 * session at its base state is not dirty and cannot undo); `canRedo` tracks
 * the entries after the cursor.
 */
export function editingControlState(snapshot: EditControllerSnapshot): EditingControlState {
  const cursor = Number(snapshot.history.cursor)
  const entries = Number(snapshot.history.entries.length)
  return {
    busy: snapshot.busy,
    dirty: cursor > 0,
    canUndo: cursor > 0,
    canRedo: cursor < entries,
  }
}

/**
 * The edit status line: the controller's error text wins; otherwise a busy
 * probe, then the applied-revision acknowledgement. `role` is `alert` exactly
 * when an error is shown.
 */
export function describeEditStatus(snapshot: EditControllerSnapshot): {
  readonly text: string
  readonly role: 'status' | 'alert'
} {
  const text =
    snapshot.error ??
    (snapshot.busy ? 'Checking edit…' : snapshot.revision > 0 ? 'Edit applied.' : '')
  return { text, role: snapshot.error === null ? 'status' : 'alert' }
}

/**
 * Whether one cell is dirty against the effective overlay: inserted live rows
 * are dirty on every cell; otherwise the cell carries an edit.
 */
export function isDirtyCell(state: OverlayState, rowId: RowId, column: string): boolean {
  return state.inserts.get(rowId)?.live === true || overlayEdit(state, rowId, column) !== null
}
