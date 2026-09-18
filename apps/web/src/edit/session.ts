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

/**
 * Render an engine rejection as a readable, text-only alert message.
 *
 * Engine errors echo the operation's SQL context across several lines; only
 * the first (summary) line is surfaced — the rest is the composed statement,
 * which can carry other cells' values and is neither readable nor something
 * the user asked to see. The whole string is rendered as text (never HTML),
 * and is never logged (it can echo the value the user typed, ADR 0025).
 *
 * The mvp browser bundle surfaces value-space cast failures through its
 * emscripten layer as the opaque `_setThrew is not defined` (the `engine-duckdb`
 * `op-channel` write-up documents that failure mode). A raw glue error is not
 * a readable engine message, so it — and an empty message — become a plain
 * summary: the column's type rejected the value. Genuine DuckDB messages
 * (a `Conversion Error`, a binder error) pass through verbatim.
 */
const OPAQUE_GLUE_ERROR = /^_setThrew\b/

export function engineRejectionMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const summary = raw.split('\n')[0]?.trim() ?? ''
  const detail =
    summary === '' || OPAQUE_GLUE_ERROR.test(summary)
      ? "the column's type rejected the value"
      : summary
  return `The engine rejected this edit: ${detail}. The previous value is unchanged.`
}

/** The effects a history commit needs from the composition root. */
export interface CommitEffects {
  /** Publish `history` as the active overlay (overlay ref + React state). */
  setActive(history: TransformationHistory): void
  /** Re-materialize the active overlay through a fresh data epoch. */
  refresh(): Promise<void>
}

/**
 * Commit one history against the engine's (re)materialization, rolling back to
 * the previous history when the new overlay is rejected.
 *
 * The repo's contract for a rejected state change is "the previous state stays
 * in effect" (`GridDataProvider.sort`/`filter`, the domain's typed
 * `Conflict`/`NoOp` outcomes). An engine value-space rejection (a bad DATE
 * cast, an out-of-range BIGINT) is the same class of event: the new overlay
 * materializes to an error, so this restores the previous overlay and
 * re-materializes it, leaving the grid renderable instead of all-loading.
 *
 * `setActive(next)` runs first so the provider reads the new overlay during
 * `refresh()`; on rejection `setActive(previous)` + a second `refresh()`
 * restore the prior effective view, and the engine message is returned for a
 * `role="alert"`. Success returns `null`. Never throws: a failure while
 * restoring the previous view is swallowed (the model already surfaces
 * per-span errors) so a rejected commit can never become an unhandled
 * rejection.
 */
export async function commitWithRollback(
  previous: TransformationHistory,
  next: TransformationHistory,
  effects: CommitEffects,
): Promise<string | null> {
  effects.setActive(next)
  try {
    await effects.refresh()
    return null
  } catch (error) {
    effects.setActive(previous)
    try {
      await effects.refresh()
    } catch {
      // The previous view failed to re-materialize too; its per-span errors
      // are already visible, and the returned alert explains the edit.
    }
    return engineRejectionMessage(error)
  }
}
