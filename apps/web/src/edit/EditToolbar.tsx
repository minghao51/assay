// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Editing toolbar (m4-3, extended m4-4): the session-level affordances around
 * the grid — insert a row, undo/redo the transformation history, and surface
 * non-applied op outcomes as a readable alert. m4-4 adds the honest
 * "pending changes" summary (counts by op kind over the active history
 * prefix): the overlay *is* the preview (ADR 0012 staged changes), so there
 * is no separate pre-commit staging step to show — this line is what makes
 * the staged set legible at a glance.
 *
 * Deliberately thin (repo convention: thin components over tested pure
 * modules): it owns no state, only the disabled logic (`canUndo`/`canRedo`
 * come straight from the history cursor) and the render. Text-only; the
 * alert echoes domain-generated reasons, never dataset content (ADR 0025)
 * and the summary carries only op kinds/counts.
 */
interface EditToolbarProps {
  readonly canUndo: boolean
  readonly canRedo: boolean
  readonly onUndo: () => void
  readonly onRedo: () => void
  readonly onInsertRow: () => void
  /** Pure `pendingChangesSummary` of the active history prefix (m4-4). */
  readonly pendingSummary: string
  /** Non-applied outcome / commit failure message (null when clean). */
  readonly error: string | null
}

export function EditToolbar({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onInsertRow,
  pendingSummary,
  error,
}: EditToolbarProps) {
  return (
    <section className="edit-toolbar" data-testid="edit-toolbar" aria-label="Editing">
      <button
        type="button"
        className="edit-insert-row"
        data-testid="edit-insert-row"
        onClick={onInsertRow}
      >
        Insert row
      </button>{' '}
      <button
        type="button"
        className="edit-undo"
        data-testid="edit-undo"
        disabled={!canUndo}
        onClick={onUndo}
      >
        Undo
      </button>{' '}
      <button
        type="button"
        className="edit-redo"
        data-testid="edit-redo"
        disabled={!canRedo}
        onClick={onRedo}
      >
        Redo
      </button>{' '}
      <span className="edit-pending" data-testid="pending-changes">
        {pendingSummary}
      </span>
      {error !== null && (
        // q-3: the visible edit error is not itself a live region. The app's
        // single `aria-live="polite"` region (`edit-live-region`) announces
        // every edit outcome — commit success and the value-free rejection
        // class — so there is exactly one edit live region (ADR 0025).
        <p className="edit-error" data-testid="edit-error">
          {error}
        </p>
      )}
    </section>
  )
}
