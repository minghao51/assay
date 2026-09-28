// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Transformation-history panel (m4-4).
 *
 * The visible form of the m4-1 history: the append-only log of typed ops with
 * the undo/redo cursor, rendered through `describeOp` (human-readable, and —
 * deliberately — including cell values, because this is the user's own local
 * UI and never telemetry/logging; ADR 0025). Each entry carries its typed
 * outcome (applied / no-op / conflict) so the panel never implies an op did
 * something it did not.
 *
 * **Selective undo** is a cursor move, not an inverse-SQL replay: clicking an
 * entry jumps the cursor to the state *after* that op (`cursor = index + 1`),
 * and `stateAtCursor` re-folds the prefix — so a jump lands on a consistent
 * state by construction (no partial application, no drift). Entries after the
 * cursor are the redo tail; a new op after a rewind truncates it (m4-1 branch
 * truncation), and the panel surfaces that *before* it happens with a dimmed
 * tail + a note, rather than silently dropping steps.
 *
 * Text-only (ADR 0007 spirit): descriptions render as text, never HTML.
 *
 * ux-3 (UX-6): this panel owns the app's SINGLE Undo/Redo pair — the editing
 * toolbar's duplicate was removed, since time travel is a property of the
 * history (the cursor and the selective jumps live here).
 */
import type { HistoryEntry } from '@assay/domain'
import { describeOp } from '@assay/domain'

interface HistoryPanelProps {
  /** The append-only log (entries at/after `cursor` are redo-able). */
  readonly entries: readonly HistoryEntry[]
  /** Number of applied entries (`entries[0..cursor)`). */
  readonly cursor: number
  /** Jump the cursor so `entries[0..nextCursor)` is applied. */
  readonly onSelectCursor: (nextCursor: number) => void
  readonly onUndo: () => void
  readonly onRedo: () => void
}

/** Honest outcome label for one logged entry. */
function outcomeLabel(entry: HistoryEntry): string {
  switch (entry.outcome.status) {
    case 'applied':
      return entry.outcome.notes.length === 0
        ? 'applied'
        : `applied (${entry.outcome.notes.join(', ')})`
    case 'no-op':
      return `no-op: ${entry.outcome.reason}`
    case 'conflict':
      return `conflict: ${entry.outcome.reason}`
  }
}

export function HistoryPanel({
  entries,
  cursor,
  onSelectCursor,
  onUndo,
  onRedo,
}: HistoryPanelProps) {
  const redoCount = entries.length - cursor
  return (
    <section className="history" data-testid="history-panel" aria-label="Transformation history">
      <h2 className="visually-hidden">History</h2>
      <div className="history-controls">
        <button
          type="button"
          className="history-undo"
          data-testid="history-undo"
          disabled={cursor === 0}
          onClick={onUndo}
        >
          Undo
        </button>{' '}
        <button
          type="button"
          className="history-redo"
          data-testid="history-redo"
          disabled={redoCount === 0}
          onClick={onRedo}
        >
          Redo
        </button>{' '}
        <span className="history-cursor" data-testid="history-cursor">
          {entries.length === 0
            ? 'No steps yet'
            : `Step ${String(cursor)} of ${String(entries.length)} applied`}
        </span>
      </div>
      {entries.length === 0 ? (
        <p className="history-empty" data-testid="history-empty">
          No changes yet. Edits, row ops and column ops appear here as reversible steps.
        </p>
      ) : (
        <ol className="history-list" data-testid="history-list">
          {entries.map((entry, index) => {
            const applied = index < cursor
            const description = describeOp(entry.op)
            return (
              <li
                key={index}
                className={`history-item${applied ? '' : ' history-item-undone'}`}
                data-testid="history-item"
                data-index={index}
                data-applied={applied ? 'true' : 'false'}
              >
                <button
                  type="button"
                  className="history-entry"
                  data-testid="history-entry"
                  data-index={index}
                  data-applied={applied ? 'true' : 'false'}
                  title={
                    applied
                      ? `Undo this step and everything after it (${description})`
                      : `Re-apply up to this step (${description})`
                  }
                  onClick={() => {
                    onSelectCursor(index + 1)
                  }}
                >
                  <span className="history-description" data-testid="history-description">
                    {description}
                  </span>
                  <span className="history-outcome" data-testid="history-outcome">
                    {outcomeLabel(entry)}
                  </span>
                </button>
              </li>
            )
          })}
        </ol>
      )}
      {redoCount > 0 && (
        <p className="history-redo-tail" data-testid="history-redo-tail" role="status">
          {redoCount === 1
            ? '1 later step is undone'
            : `${String(redoCount)} later steps are undone`}{' '}
          — a new edit will discard {redoCount === 1 ? 'it' : 'them'}.
        </p>
      )}
    </section>
  )
}
