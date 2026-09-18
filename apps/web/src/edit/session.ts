/**
 * Overlay-session helpers (m4-3) — pure glue between the domain's
 * transformation history and the engine's stateless overlay protocol.
 *
 * The web composition root owns the *effects* (React state, grid refresh,
 * error surfacing); this module owns the *rules* so they are Node-tested
 * without a DOM:
 *
 * - `activeOps` is the engine-facing projection of a history: exactly the
 *   entries left of the undo/redo cursor, in order. The engine refolds them
 *   (`foldOverlay`) per request, so the grid always materializes the active
 *   prefix — undo/redo are cursor moves, never inverse-SQL bookkeeping.
 * - `overlaySnapshot` packages `{ base, ops }` into the engine's
 *   `EngineOverlay`. The engine folds the ops itself; because of a known
 *   m4-2 engine gap (inserted-row cell edits are dropped), the host projects
 *   the folded state into an equivalent op list the engine composes
 *   correctly — see `overlay-projection.ts` for the defect write-up and the
 *   projection rules.
 * - `editOutcomeMessage` turns a typed `OpOutcome` into an honest,
 *   text-only message (or `null` for an applied op). No-op and conflict
 *   outcomes are surfaced, never swallowed: the brief forbids silently
 *   dropping an edit the user asked for.
 */
import type { EditOp, OpOutcome, OverlayBase, TransformationHistory } from '@assay/domain'
import { stateAtCursor } from '@assay/domain'
import type { EngineOverlay } from '@assay/engine-duckdb'
import { isSchemaOp, projectOverlayOps } from './overlay-projection'

/** The ops left of the history cursor, in application order. */
export function activeOps(history: TransformationHistory): EditOp[] {
  return history.entries.slice(0, history.cursor).map((entry) => entry.op)
}

/**
 * Package the active overlay for one engine request. The engine folds the ops
 * itself, so the host projects the already-folded state into the equivalent op
 * list the engine composes correctly (`projectOverlayOps` — inserted-row cell
 * edits are folded into insert values; schema ops are replayed verbatim).
 * `ops` is always present so the wire payload is byte-stable.
 */
export function overlaySnapshot(base: OverlayBase, history: TransformationHistory): EngineOverlay {
  const state = stateAtCursor(base, history)
  const historyOps = activeOps(history)
  return { base, ops: projectOverlayOps(base, state, historyOps.filter(isSchemaOp)) }
}

/** Human-readable reason fragments for the domain's typed non-applied outcomes. */
const NO_OP_TEXT: Record<string, string> = {
  'cell-value-unchanged': 'the cell already has that value',
  'cell-already-base': 'the cell already shows its base value',
  'row-already-deleted': 'the row is already deleted',
  'row-already-present': 'the row is already present',
  'rename-identity': 'the column already has that name',
  'cast-identity': 'the column already has that type',
}

const CONFLICT_TEXT: Record<string, string> = {
  'malformed-row-id': 'the row reference is malformed',
  'not-an-insert-id': 'a new row must use an insert id',
  'row-anchor-mismatch': 'the row belongs to a different file version',
  'insert-anchor-mismatch': 'the row belongs to a different editing session',
  'unknown-row': 'the row no longer exists',
  'row-deleted': 'the row was deleted',
  'unknown-column': 'the column does not exist',
  'rename-collision': 'a column with that name already exists',
  'insert-id-collision': 'the new-row id is already in use',
}

/**
 * Render one typed outcome as an honest message, or `null` when the op was
 * applied. Text only (ADR 0007 spirit): the string echoes *reasons* and, for
 * cell values, nothing — reasons are engine/domain vocabulary, never dataset
 * content, so this is safe for the accessibility alert and for logs alike.
 */
export function editOutcomeMessage(outcome: OpOutcome): string | null {
  switch (outcome.status) {
    case 'applied':
      return null
    case 'no-op':
      return `No change: ${NO_OP_TEXT[outcome.reason] ?? outcome.reason}.`
    case 'conflict':
      return `Cannot apply the edit: ${CONFLICT_TEXT[outcome.reason] ?? outcome.reason}.`
  }
}
