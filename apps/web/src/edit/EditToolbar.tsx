/**
 * Editing toolbar (m4-3): the session-level affordances around the grid —
 * insert a row, undo/redo the transformation history, and surface non-applied
 * op outcomes as a readable alert.
 *
 * Deliberately thin (repo convention: thin components over tested pure
 * modules): it owns no state, only the disabled logic (`canUndo`/`canRedo`
 * come straight from the history cursor) and the render. Text-only; the
 * alert echoes domain-generated reasons, never dataset content (ADR 0025).
 */
interface EditToolbarProps {
  readonly canUndo: boolean
  readonly canRedo: boolean
  readonly onUndo: () => void
  readonly onRedo: () => void
  readonly onInsertRow: () => void
  /** Non-applied outcome / commit failure message (null when clean). */
  readonly error: string | null
}

export function EditToolbar({
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onInsertRow,
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
      </button>
      {error !== null && (
        <p className="edit-error" role="alert" data-testid="edit-error">
          {error}
        </p>
      )}
    </section>
  )
}
