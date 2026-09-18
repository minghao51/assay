/**
 * Overlay-session helpers (m4-3/m4-4) — pure glue between the domain's
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
 *   `EngineOverlay` as a **pass-through** of the active ops. m4-3 shipped a
 *   web-side projection here that folded inserted-row cell edits into their
 *   insert records, working around an m4-2 composer gap; m4-2b fixed the
 *   engine to merge the folded `state.edits` itself, so the projection is
 *   redundant and `overlaySnapshot` now hands the raw ops straight to the
 *   engine (m4-4 simplification — the engine fold is the single source of
 *   truth for op order, and `stateAtCursor` is by construction the fold of
 *   exactly these ops).
 * - `editOutcomeMessage` turns a typed `OpOutcome` into an honest, text-only
 *   message (or `null` for an applied op). No-op and conflict outcomes are
 *   surfaced, never swallowed: the brief forbids silently dropping an edit
 *   the user asked for.
 */
import type { EditOp, OpOutcome, OverlayBase, TransformationHistory } from '@assay/domain'
import type { EngineOverlay } from '@assay/engine-duckdb'

/** The ops left of the history cursor, in application order. */
export function activeOps(history: TransformationHistory): EditOp[] {
  return history.entries.slice(0, history.cursor).map((entry) => entry.op)
}

/**
 * Package the active overlay for one engine request: the raw active ops, in
 * order. The engine folds them with the same domain model the host used for
 * `stateAtCursor`, so the two agree by construction (m4-2b merged inserted-row
 * edits engine-side; the m4-3 projection is gone). `ops` is always present so
 * the wire payload is byte-stable.
 */
export function overlaySnapshot(base: OverlayBase, history: TransformationHistory): EngineOverlay {
  return { base, ops: activeOps(history) }
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
 * The mvp browser bundle surfaces some value-space cast failures through its
 * emscripten layer as the opaque `_setThrew is not defined` (the
 * `engine-duckdb` `op-channel` write-up documents that failure mode). A raw
 * glue error is not a readable engine message, so it — and an empty message —
 * degrade to a plain summary.
 */
const OPAQUE_GLUE_ERROR = /^_setThrew\b/

/**
 * The first (summary) line of an engine/HTTP error, with the opaque glue
 * error and empty messages translated to `opaqueFallback`. Engine errors echo
 * the operation's SQL context across several lines; only the summary is
 * surfaced — the rest is the composed statement, which can carry other cells'
 * values and is neither readable nor something the user asked to see. The
 * string is rendered as text (never HTML) and is never logged (it can echo the
 * value typed, ADR 0025).
 */
function errorSummary(error: unknown, opaqueFallback: string): string {
  const raw = error instanceof Error ? error.message : String(error)
  const summary = raw.split('\n')[0]?.trim() ?? ''
  if (summary === '' || OPAQUE_GLUE_ERROR.test(summary)) return opaqueFallback
  return summary
}

/** The engine-error summary with the single-failure value-cast fallback. */
export function engineErrorSummary(error: unknown): string {
  return errorSummary(error, "the column's type rejected the value")
}

/**
 * Render a single engine rejection as a readable, text-only alert message:
 * the new state was rejected, so it was rolled back and the previous view is
 * unchanged.
 */
export function engineRejectionMessage(error: unknown): string {
  return `The engine rejected this edit: ${engineErrorSummary(error)}. The previous view is unchanged.`
}

/**
 * Readable refusal for a cast the engine's pre-commit check proved would fail
 * to convert some of the column's values (m4-4 fix round). Names the column
 * and target type (schema vocabulary, never cell values) and states plainly
 * that nothing was applied, so the alert can never be mistaken for a
 * successful-but-odd commit.
 */
export function castRefusalMessage(column: string, targetType: string): string {
  return (
    `Cannot cast "${column}" to ${targetType}: ` +
    'some values cannot convert to that type. No cast was applied; the view is unchanged.'
  )
}

/**
 * Readable refusal for a cast whose pre-commit check kept being invalidated by
 * a concurrent same-table change (m4-4 fix round 2). The check never completed
 * against a state the append could trust, so nothing was applied — the user is
 * asked to retry rather than being handed a stale verdict.
 */
export function castRacedMessage(column: string, targetType: string): string {
  return (
    `Cannot cast "${column}" to ${targetType}: ` +
    'the view changed while the cast was being checked. No cast was applied; try again.'
  )
}

/** The effects a history commit needs from the composition root. */
export interface CommitEffects {
  /** Publish `history` as the active overlay (overlay ref + React state). */
  setActive(history: TransformationHistory): void
  /** Re-materialize the active overlay through a fresh data epoch. */
  refresh(): Promise<void>
}

/**
 * The outcome of a history commit: `message` is `null` on success, and
 * `restoreFailed` is true only when the previous view could not be
 * re-materialized after a rejection (the double-failure case the alert must
 * attribute honestly and the host must offer a retry for).
 */
export interface CommitResult {
  readonly message: string | null
  readonly restoreFailed: boolean
}

/**
 * Commit one history against the engine's (re)materialization, rolling back to
 * the previous history when the new overlay is rejected.
 *
 * The repo's contract for a rejected state change is "the previous state stays
 * in effect" (`GridDataProvider.sort`/`filter`, the domain's typed
 * `Conflict`/`NoOp` outcomes). An engine value-space rejection (a bad DATE
 * cast, an out-of-range BIGINT, a `column-cast` whose values do not convert)
 * is the same class of event: the new overlay materializes to an error, so
 * this restores the previous overlay and re-materializes it, leaving the grid
 * renderable instead of all-loading.
 *
 * `setActive(next)` runs first so the provider reads the new overlay during
 * `refresh()`; on rejection `setActive(previous)` + a second `refresh()`
 * restore the prior effective view. **Double-failure honesty** (m4-3
 * carry-over): if that restore also rejects, the returned message names
 * *both* failures — it never claims only the value was rejected — and
 * `restoreFailed: true` tells the host to surface a retry affordance, so an
 * engine outage cannot leave the user with an unattributed alert and no way
 * back. Never throws.
 *
 * m4-4 fix round: the bounded `verify()` probe is gone. A cast whose values
 * cannot convert is now refused *before* the op is appended via the engine's
 * `overlayCastCheck` (see `handleCastColumn`), and every other value failure
 * rejects on the `refresh()` window read itself. A partial-window probe was a
 * false assurance: a bad value past row 0 could commit and brick the grid.
 */
export async function commitWithRollback(
  previous: TransformationHistory,
  next: TransformationHistory,
  effects: CommitEffects,
): Promise<CommitResult> {
  effects.setActive(next)
  try {
    await effects.refresh()
    return { message: null, restoreFailed: false }
  } catch (error) {
    effects.setActive(previous)
    let restoreError: unknown = null
    try {
      await effects.refresh()
    } catch (restoreFailure) {
      restoreError = restoreFailure
    }
    if (restoreError === null) {
      return { message: engineRejectionMessage(error), restoreFailed: false }
    }
    return {
      // Name both failures and attribute the engine/view, not a value claim:
      // an opaque glue error here describes an engine outage as much as a bad
      // cell, so the neutral fallback is the honest one. `restoreFailed` tells
      // the host to pair this with a retry, so rows can never sit in an
      // unattributed loading state.
      message:
        `The change could not be applied: ${errorSummary(error, 'the engine or view rejected it')}. ` +
        `Restoring the previous view also failed: ${errorSummary(restoreError, 'the engine or view was unavailable')}. ` +
        'Use Retry to reload the view.',
      restoreFailed: true,
    }
  }
}
