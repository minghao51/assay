// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Editing toolbar (m4-3, extended m4-4): the session-level affordances around
 * the grid — insert a row and surface non-applied op outcomes as a readable
 * alert. m4-4 adds the honest "pending changes" summary (counts by op kind
 * over the active history prefix): the overlay *is* the preview (ADR 0012
 * staged changes), so there is no separate pre-commit staging step to show —
 * this line is what makes the staged set legible at a glance.
 *
 * ux-3 (UX-6): the toolbar no longer renders its own Undo/Redo pair. Time
 * travel is a property of the transformation history, so the `HistoryPanel`
 * owns the single Undo/Redo pair (plus selective cursor jumps); a second pair
 * here was a duplicate control surface with identical disabled logic. The
 * toolbar keeps Insert row + the pending summary.
 *
 * Deliberately thin (repo convention: thin components over tested pure
 * modules): it owns no state, only the render. The section carries its own
 * h2 (the app's complete heading map, UX-7). Text-only; the alert echoes
 * domain-generated reasons, never dataset content (ADR 0025) and the summary
 * carries only op kinds/counts.
 */
interface EditToolbarProps {
  readonly onInsertRow: () => void
  /** Pure `pendingChangesSummary` of the active history prefix (m4-4). */
  readonly pendingSummary: string
  /** Non-applied outcome / commit failure message (null when clean). */
  readonly error: string | null
}

export function EditToolbar({ onInsertRow, pendingSummary, error }: EditToolbarProps) {
  return (
    <section className="edit-toolbar" data-testid="edit-toolbar" aria-label="Editing">
      <h2 className="visually-hidden">Editing</h2>
      <p className="edit-overlay-explanation" data-testid="edit-overlay-explanation">
        Edits are staged in this session; the opened file is never modified. Export writes a copy.
      </p>
      <button
        type="button"
        className="edit-insert-row"
        data-testid="edit-insert-row"
        onClick={onInsertRow}
      >
        Insert row
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
