// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Transformation-history model (m4-1; ADR 0012).
 *
 * An append-only log of edit-ops with an undo/redo cursor. Semantics, ruled
 * precisely:
 *
 * - **The log is append-only and never mutated in place.** Every function
 *   returns a *new* `TransformationHistory`; inputs are untouched (a
 *   persistent structure, so a caller can keep a snapshot and fork from it).
 *   `entries[0..cursor)` is the active prefix — exactly the ops whose effect
 *   is in the folded state (`stateAtCursor` = `foldOverlay` of that prefix).
 * - **Undo/redo are cursor movements.** `undo` moves the cursor back and
 *   returns the entry being undone — the caller materializes its derived
 *   `inverse` ops (engine-side, m4-2, in order) or refolds; `redo` moves the
 *   cursor forward and returns the entry being re-applied. Because the fold
 *   is a pure function of the prefix, cursor movement cannot drift: the
 *   same prefix always folds to the same state. Inverses were derived *at
 *   append time* against the state the op actually saw, and a reverse
 *   cursor walk visits exactly those states, so undo can never stick for
 *   logs built by {@link appendOp}.
 * - **Undo→new-op→redo = branch truncation (the ruling).** Appending after
 *   an undo drops the redo tail (`entries.slice(0, cursor)` + the new
 *   entry): redo after a fresh op is impossible. Justification: (1) redoing
 *   stale ops against a diverged fold would replay user-abandoned intent,
 *   possibly conflicting or duplicating effects — dishonest either way;
 *   (2) ADR 0012 frames the active log as the staged transaction — abandoned
 *   branches are not part of it; (3) it is the dominant editor convention
 *   (undo-then-edit branches). Deliberate v1 narrowing: abandoned branches
 *   are discarded, not archived — an audit-grade branch tree is future work
 *   (the pre-truncate history object remains valid in the caller's hands if
 *   it wants the dropped tail; this module never rewrites entries).
 * - **Only non-conflicted ops enter the log.** A conflicted op changed
 *   nothing and must not occupy history (undoing "past" it would be
 *   meaningless), so `appendOp` *refuses* it: same history reference back,
 *   `entry: null`, and the conflict outcome for the caller to surface. No-op
 *   ops are appended (they are honest "nothing changed" entries) with
 *   an empty `inverse`, so undo/redo skip materializing them.
 *
 * Purity: no React, no browser APIs, no engine imports, no I/O; never
 * throws. O(cursor) refolding per append keeps this implementation simple;
 * histories are session-sized and the state is a pure value, so m4-3 may
 * memoize snapshots freely.
 */
import type { EditOp } from './edit-ops.js'
import type { OpOutcome, OverlayBase, OverlayState } from './overlay.js'
import { foldOverlay, stepOverlay } from './overlay.js'

/**
 * One logged operation: the op, the typed outcome it had when it was
 * appended, and its derived inverse ops (`inverse.length === 0` exactly
 * when `outcome.status !== 'applied'` — usually a single op, a list where
 * the exact undo is several, e.g. expunging an edited insert).
 */
export interface HistoryEntry {
  readonly op: EditOp
  readonly outcome: OpOutcome
  readonly inverse: readonly EditOp[]
}

/**
 * An immutable transformation history: `entries` is the append-only log,
 * `cursor` (0 ≤ cursor ≤ entries.length) splits it into the applied prefix
 * `entries[0..cursor)` and the redo tail `entries[cursor..]`.
 */
export interface TransformationHistory {
  readonly entries: readonly HistoryEntry[]
  readonly cursor: number
}

/** The empty history — nothing logged, nothing applied. */
export function emptyHistory(): TransformationHistory {
  return { entries: [], cursor: 0 }
}

/** Result of {@link appendOp}. */
export interface AppendResult {
  /**
   * The new history. Reference-equal to the input only when the op was
   * refused (conflict) — a cheap, honest "nothing happened" signal.
   */
  readonly history: TransformationHistory
  /** The logged entry, or `null` when the op was refused (conflict). */
  readonly entry: HistoryEntry | null
  /** The op's outcome — including the refusing conflict. */
  readonly outcome: OpOutcome
}

/**
 * Step `op` against the state at the cursor and append it. Appending after
 * an undo truncates the redo tail (branch truncation — see the module doc).
 * Refuses conflicted ops: no new history, no entry, conflict outcome out.
 */
export function appendOp(
  base: OverlayBase,
  history: TransformationHistory,
  op: EditOp,
): AppendResult {
  const step = stepOverlay(base, stateAtCursor(base, history), op)
  if (step.application.outcome.status === 'conflict') {
    return { history, entry: null, outcome: step.application.outcome }
  }
  const entry: HistoryEntry = {
    op,
    outcome: step.application.outcome,
    inverse: step.application.inverse,
  }
  return {
    history: {
      // Branch truncation: entries after the cursor are dropped; this
      // creates a new array — the input log object is never mutated.
      entries: [...history.entries.slice(0, history.cursor), entry],
      cursor: history.cursor + 1,
    },
    entry,
    outcome: step.application.outcome,
  }
}

/** Result of {@link undo}/{@link redo}; `entry: null` at a cursor boundary. */
export interface CursorStep {
  /** The new history with the moved cursor (input never mutated). */
  readonly history: TransformationHistory
  /**
   * The entry at the boundary: for undo, materialize `entry.inverse` (empty
   * for a no-op entry — nothing to apply); for redo, re-apply
   * `entry.op` (skip materialization when `entry.outcome` is a no-op).
   */
  readonly entry: HistoryEntry | null
}

/** Move the cursor back one entry; `entry: null` when already at the start. */
export function undo(history: TransformationHistory): CursorStep {
  if (history.cursor === 0) return { history, entry: null }
  return {
    history: { ...history, cursor: history.cursor - 1 },
    entry: history.entries[history.cursor - 1] ?? null,
  }
}

/** Move the cursor forward one entry; `entry: null` when already at the end. */
export function redo(history: TransformationHistory): CursorStep {
  if (history.cursor >= history.entries.length) return { history, entry: null }
  return {
    history: { ...history, cursor: history.cursor + 1 },
    entry: history.entries[history.cursor] ?? null,
  }
}

/**
 * The folded overlay state at the cursor — the effective changes the active
 * prefix represents. Pure; equals `foldOverlay(base, entries[0..cursor))`.
 */
export function stateAtCursor(base: OverlayBase, history: TransformationHistory): OverlayState {
  return foldOverlay(
    base,
    history.entries.slice(0, history.cursor).map((entry) => entry.op),
  ).state
}
