// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Dirty-history display controller (D03b) — the desktop dataset webview's
 * session-editing surface: the grid's editing adapter (toolbar state, dirty
 * cell predicate) and the edit status line.
 *
 * Extracted from the webview entry so the entry stays composition/wiring: the
 * controller receives the opened base overlay + the edit controller and
 * publishes the grid adapter object plus text/attribute updates. The DOM-free
 * derivation lives in `src/pure/dirty-history-view.ts`; this module owns only
 * the DOM binding and the effective-overlay memo.
 *
 * Invariants (unchanged by the split):
 * - the dirty predicate reads the overlay AT THE HISTORY CURSOR (memoized per
 *   history object, recomputed only when the controller publishes a new one),
 * - toolbar state is derived from the same snapshot the controller published,
 * - the status line carries `role="alert"` exactly when the controller reports
 *   an error.
 */
import { stateAtCursor } from '@assay/domain'
import type {
  CellValue,
  OverlayBase,
  OverlayState,
  RowId,
  TransformationHistory,
} from '@assay/domain'
import type { EditController, EditControllerSnapshot } from '../src/pure/edit-controller'
import {
  describeEditStatus,
  editingControlState,
  isDirtyCell,
} from '../src/pure/dirty-history-view'
import type { WebviewDataGridOptions } from './data-grid'
import { elementOrThrow } from './dom'

/** The grid's `editing` adapter (structurally the grid option's shape). */
export type GridEditingAdapter = NonNullable<WebviewDataGridOptions['editing']>

/** Explicit inputs of the dirty-history display. */
export interface DirtyHistoryPorts {
  /** The opened dataset's overlay base. */
  readonly base: OverlayBase
  /** The session edit controller (one per panel). */
  readonly controller: EditController
  /** The mounted grid, or `null` before it exists. */
  readonly grid: () => { refreshEditingState(): void } | null
}

/**
 * The dirty-history display. One instance per opened dataset panel; the
 * controller's change callback forwards each snapshot to `render`.
 */
export class DirtyHistoryView {
  private history: TransformationHistory
  private overlay: OverlayState
  private statusElement: HTMLElement | null = null
  private readonly ports: DirtyHistoryPorts

  constructor(ports: DirtyHistoryPorts) {
    this.ports = ports
    this.history = ports.controller.currentHistory
    this.overlay = stateAtCursor(ports.base, this.history)
  }

  /** The grid editing adapter wired to this controller. */
  get editing(): GridEditingAdapter {
    return {
      state: () => editingControlState(this.ports.controller.snapshot),
      isDirty: (rowId: RowId, column: string) => isDirtyCell(this.currentOverlay(), rowId, column),
      onInsert: () => void this.ports.controller.insertRow(),
      onUndo: () => void this.ports.controller.undo(),
      onRedo: () => void this.ports.controller.redo(),
      onCommitCell: (rowId: RowId, column: string, value: CellValue) =>
        void this.ports.controller.commitCell(rowId, column, value),
      onDeleteRow: (rowId: RowId) => void this.ports.controller.deleteRow(rowId),
    }
  }

  /**
   * The effective overlay at the history cursor. Memoized per `currentHistory`
   * identity: the controller publishes a new history object exactly when the
   * cursor/entries change, so this recomputes once per accepted operation.
   */
  currentOverlay(): OverlayState {
    const history = this.ports.controller.currentHistory
    if (history !== this.history) {
      this.history = history
      this.overlay = stateAtCursor(this.ports.base, history)
    }
    return this.overlay
  }

  /** Create + insert the edit status line (idempotent per element id). */
  mountStatus(): void {
    const existing = document.getElementById('edit-status')
    if (existing !== null) {
      this.statusElement = existing
      return
    }
    const status = document.createElement('p')
    status.id = 'edit-status'
    status.setAttribute('role', 'status')
    elementOrThrow('grid-root').before(status)
    this.statusElement = status
  }

  /** Publish one controller snapshot to the status line and the grid. */
  render(snapshot: EditControllerSnapshot): void {
    const status = this.statusElement ?? document.getElementById('edit-status')
    if (status !== null) {
      const { text, role } = describeEditStatus(snapshot)
      status.setAttribute('role', role)
      status.textContent = text
    }
    this.ports.grid()?.refreshEditingState()
  }
}
