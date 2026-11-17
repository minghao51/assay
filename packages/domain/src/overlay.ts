// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Overlay fold semantics (m4-1; ADR 0012).
 *
 * The edit overlay represents every edit as an ordered op log applied over an
 * *immutable* base version (ADR 0012); nothing here mutates data. This module
 * is the single source of truth for what a log *means*:
 *
 * - **Fold** — `initialState` + `stepOverlay` + `foldOverlay` interpret ops
 *   against `OverlayBase` (base metadata only — never base data; datasets can
 *   be multi-GB, the overlay stays a small delta). The fold is a pure
 *   function of (base, prefix); the state at any history cursor is exactly
 *   `foldOverlay(base, entries[0..cursor)).state`. Engines (m4-2) compose SQL
 *   from this state; they may refold per cursor move or apply per-step
 *   deltas — the two agree by construction.
 * - **Inverse derivation** — each application derives the op that undoes it
 *   *against the state it was applied to* (e.g. `cell-set` captures the prior
 *   overlay edit — or its absence, inverted by `cell-revert`). Inverses exist
 *   within the op union itself, so undo is expressible as ops, and "inverses
 *   are true inverses" is a property of the fold, not a convention
 *   (property-tested in `overlay.test.ts`). `OpApplication.inverse` is a
 *   (possibly multi-op, possibly empty) list: non-empty exactly when the op
 *   was applied — a no-op or conflicted op left the state unchanged, so
 *   there is nothing to undo. A list is needed where one op's exact undo is
 *   several ops (expunging an edited insert restores the insert *and* its
 *   cell edits); the undo walk applies the ops in order.
 * - **Conflict / no-op rules** — every outcome is a typed value; this module
 *   never throws (repo convention). The queue's cases, ruled explicitly:
 *   *edit of a deleted row* → conflict `row-deleted` (the intent cannot be
 *   honored and silently dropping it would corrupt undo); *delete of an
 *   inserted row* → plain `applied` (a tombstone is exactly how deletes are
 *   represented); *rename onto an existing name* → conflict
 *   `rename-collision`; *cast of a missing column* → conflict
 *   `unknown-column`. No-op means "already satisfied" (idempotent replay);
 *   conflict means "cannot be honored against this state".
 *
 * Deliberate v1 boundaries (documented for m4-2/m4-3): the fold never reads
 * base *data*, so "set to the value the base already has" is not detectable
 * here — no-op detection works within overlay edits only; cast success is an
 * engine-side concern (a failing cast surfaces at materialization); and
 * cross-base-version row identity does not exist (see `row-identity.ts`).
 *
 * Purity: no React, no browser APIs, no engine imports (docs/engineering/05
 * §3, lint-enforced); no I/O; never throws.
 */
import type { CellValue, CellValueRecord, ColumnSpec, EditOp, InsertPosition } from './edit-ops.js'
import {
  MAX_REPAIR_MAPPING_PAIRS,
  MAX_REPAIR_TRIM_CODE_POINTS,
  NULL_VALUE,
  cellValueEqual,
  isTextualRepairType,
  trimWithCodePoints,
} from './edit-ops.js'
import { baseRowId, parseRowId } from './row-identity.js'
import type { RowId } from './row-identity.js'

/**
 * The immutable base an overlay edits *on top of*: metadata only — the base
 * version anchor (see `row-identity.ts`), its schema, and its row count.
 * Base row values are never part of the overlay; consumers (m4-2) join the
 * base view with this delta.
 */
export interface OverlayBase {
  /**
   * Opaque host token identifying the immutable base *version* (ADR 0011).
   * Same version ⇒ same anchor ⇒ stable base row ids; a content change on
   * disk is a different version and must come with a different anchor (the
   * survival boundary in `row-identity.ts`).
   */
  readonly baseAnchor: string
  /** Opaque host token for this editing session; scopes the insert-id space. */
  readonly overlayAnchor: string
  /** The base schema, in base order. Names must be unique (host contract). */
  readonly columns: readonly ColumnSpec[]
  /** Rows in the base version (may be huge — never materialized here). */
  readonly baseRowCount: number
}

/**
 * One overlay-inserted row. Records exist for live *and* tombstoned inserts:
 * a tombstone keeps the row's values and position so `row-restore` (and
 * redo-after-undo) is exact. `position` is kept verbatim; its meaning is
 * resolved at emission time (`effectiveRowIds`), so restores after neighbor
 * changes remain deterministic functions of the current state.
 */
export interface InsertedRowRecord {
  readonly id: RowId
  readonly live: boolean
  readonly position: InsertPosition
  readonly values: CellValueRecord
  /**
   * The insert sequence this id was allocated with. Doubles as the
   * same-anchor emission tie-break: it is unique among coexisting records,
   * so the effective order is a function of the state alone — never of
   * application history — which is exactly what exact refold/undo
   * equivalence (the property tests) requires.
   */
  readonly seq: number
}

/**
 * The base/overlay anchors a folded state is bound to (see
 * {@link OverlayState.anchors}).
 */
export interface OverlayAnchors {
  readonly baseAnchor: string
  readonly overlayAnchor: string
}

/**
 * One applied `column-repair` in the active prefix, with the value-independent
 * metadata the engine composer needs to realize the repair as the EW-04D §6.2
 * conditional wrap: the exceptions (rows the repair must NOT touch) are pure
 * prefix metadata — liveness at the repair's position and rows that received a
 * *later applied* `cell-set`/`cell-revert` on the same column — so the composer
 * evaluates them without reading any values. Recorded by the fold (the single
 * source of truth for what the prefix means); consumed read-only by the
 * composer (`overlay-query.ts`).
 */
export interface RepairStepRecord {
  /**
   * Index of the repaired column in `OverlayState.columns` **at the repair's
   * position**. Renames and casts never reorder columns, so this index is the
   * stable column identity across the rest of the prefix (the name at apply
   * time can be stale after a later rename).
   */
  readonly columnIndex: number
  /**
   * The column's declared engine type at the repair's position (a textual
   * spelling — the fold refuses anything else). The wrap's input type: casts
   * before the repair collapse into it; casts after apply outside the wrap.
   */
  readonly typeAtApply: string
  /** The repair's explicit edge-trim set; absent ⇒ mapping matches raw values. */
  readonly trim?: string
  /** Exact whole-value mapping applied to the (trimmed) value. */
  readonly mapping: ReadonlyMap<string, string>
  /**
   * Base ordinals **not live** at the repair's position (tombstoned then, or
   * inserted later). A live-at-cursor row among these is an exception arm: it
   * shows its underlying cursor value untransformed (P3: a restored row shows
   * its pre-repair effective value).
   */
  readonly deadOrdinalsAtApply: ReadonlySet<number>
  /** Insert row ids live at the repair's position (the D17 rewrite consults them). */
  readonly liveInsertIdsAtApply: ReadonlySet<RowId>
  /**
   * Rows (base or insert ids) that received an **applied** `cell-set`/
   * `cell-revert` on this column at a position **after** the repair — the
   * per-row suffix value-ops that mask the repair (the later absolute write
   * wins). Logged no-ops never land here (their outcome is not `applied`).
   * Updated by the fold as later value-ops apply.
   *
   * Boundary (ADR 0050): masking is a function of the active *prefix* (the
   * op list), not of a local (state, op) transition, so a state rebuilt by
   * materializing inverse ops (a mechanism the shipped path never uses —
   * undo is the refold) can over-mask rows whose maskers were undone. The
   * engine composes from fresh refolds, where the mask is exact; the
   * `fold ∘ unfold` properties carry the recorded narrowing.
   */
  readonly maskedRows: ReadonlySet<RowId>
}

/**
 * The folded overlay state: effective schema + the delta over the base.
 * Everything is keyed by logical row id (`row-identity.ts`); base rows exist
 * virtually (anchor + ordinal < baseRowCount) and only *touched* base rows
 * appear in `edits`/`deletedBase`, so state size is bounded by session
 * activity, never by dataset size.
 */
export interface OverlayState {
  /**
   * The anchors this state was folded against. Carried so a state can never
   * be silently applied against a different base version or overlay session:
   * `stepOverlay` compares these to its `base` and returns a typed
   * `state-anchor-mismatch` conflict on divergence (the foreign-state
   * guard; base-row ids and insert ids carry their own anchors, but
   * `deletedBase` ordinals alone do not, so the binding must live on the
   * state itself).
   */
  readonly anchors: OverlayAnchors
  /** Effective schema, in order (renames/casts applied). */
  readonly columns: readonly ColumnSpec[]
  /**
   * Overlay cell edits keyed by row id, then column — last write wins.
   * Edits of rows later tombstoned are kept (undo/restore needs them); the
   * *effective* view simply skips tombstoned rows. A column absent here
   * means "the base value stands".
   */
  readonly edits: ReadonlyMap<RowId, ReadonlyMap<string, CellValue>>
  /** All inserted rows, live and tombstoned (see {@link InsertedRowRecord}). */
  readonly inserts: ReadonlyMap<RowId, InsertedRowRecord>
  /** Tombstoned base rows, as base ordinals under `base.baseAnchor`. */
  readonly deletedBase: ReadonlySet<number>
  /**
   * Monotonic next insert sequence for `base.overlayAnchor`. Advances past
   * every allocated seq. Deleting an inserted row keeps its id spent (the
   * record still exists, so its seq is never reused), while an *expunge*
   * (`row-uninsert`) reclaims the freed top-of-stack seq when nothing lives
   * above it — so undo restores the counter exactly (gap-free allocation is
   * the allocator discipline). This rewind on expunge is deliberate and
   * canonical: the counter is a function of the state, never of application
   * history. A host that hand-skips seqs only lowers the counter's
   * usefulness — the visible projection still restores exactly, but the
   * freed floor stays spent.
   */
  readonly nextInsertSeq: number
  /**
   * The active prefix's applied `column-repair` records, in prefix (forward)
   * order — the value-independent half of §6.2 composition (see
   * {@link RepairStepRecord}). Repairs compose forward over the cursor
   * underlying value: earliest repair innermost, each masked per row by its
   * exceptions. Every other op kind leaves this list untouched.
   */
  readonly repairs: readonly RepairStepRecord[]
}

/** Degradations an applied op survived with (honest, typed, never silent). */
export type AppliedNote =
  /** A `row-insert` position anchor was not live; the row degraded to the end. */
  | 'position-anchor-not-live'
  /**
   * A `column-repair` entry's undo is not expressible as an inverse op list;
   * undo/redo are the usual cursor moves and the engine statelessly re-folds
   * the active prefix (ADR 0050). This entry carries `inverse: []`.
   */
  | 'undo-by-refold'

/**
 * The typed result of folding one op. `applied` = the state changed;
 * `no-op` = already satisfied (state unchanged, idempotent);
 * `conflict` = cannot be honored against this state (state unchanged).
 * Check order is deterministic: row-id shape → session/version anchor →
 * row existence/liveness → schema → value.
 */
export type OpOutcome =
  | { readonly status: 'applied'; readonly notes: readonly AppliedNote[] }
  | { readonly status: 'no-op'; readonly reason: NoOpReason }
  | { readonly status: 'conflict'; readonly reason: ConflictReason }

export type NoOpReason =
  /** `cell-set` to a value the overlay edit already carries. */
  | 'cell-value-unchanged'
  /** `cell-revert` where no overlay edit exists — the base already stands. */
  | 'cell-already-base'
  /** `row-delete` on an already-tombstoned row. */
  | 'row-already-deleted'
  /** `row-restore` on a live row, or a value-identical duplicate `row-insert` (position is not compared — benign replay). */
  | 'row-already-present'
  /** `column-rename` onto its own current name. */
  | 'rename-identity'
  /** `column-cast` to the column's current type. */
  | 'cast-identity'
  /** `column-repair` with no mapping pairs and no trim — the identity function. */
  | 'repair-identity'

export type ConflictReason =
  /** The row id is not a derivable `RowId` (wrong shape, non-canonical ordinal). */
  | 'malformed-row-id'
  /** A `row-insert` was given a well-formed id that is not an insert id. */
  | 'not-an-insert-id'
  /** A base row id anchored to a *different base version* — the survival boundary materializing (see `row-identity.ts`). */
  | 'row-anchor-mismatch'
  /** An insert id minted for a different overlay session (`overlayAnchor`). */
  | 'insert-anchor-mismatch'
  /** The row never existed in this overlay's view (unknown insert id, or base ordinal ≥ base row count). */
  | 'unknown-row'
  /** A cell edit targeted a tombstoned row. */
  | 'row-deleted'
  /** The column is not in the effective schema. */
  | 'unknown-column'
  /** `column-rename` onto a name that already exists. */
  | 'rename-collision'
  /** An insert id is already spent (live with different values, or tombstoned). */
  | 'insert-id-collision'
  /** The state was folded against a different base version or overlay session (its {@link OverlayState.anchors} do not match the `base` it is being stepped against). */
  | 'state-anchor-mismatch'
  /** A `column-repair` targeted a column whose declared type is not a textual repair spelling (`VARCHAR`/`TEXT`/`STRING`; `isTextualRepairType`). */
  | 'repair-column-not-text'
  /** A `column-repair` carried more mapping pairs than the plan cap ({@link MAX_REPAIR_MAPPING_PAIRS}). */
  | 'repair-mapping-cap'
  /** A `column-repair` trim set is malformed or over the {@link MAX_REPAIR_TRIM_CODE_POINTS} code-point cap. */
  | 'repair-trim-invalid'
  /** A `column-repair` mapping key can never match because its own edges carry trim-set members (the CASE operand is always the trimmed value — dead entry). */
  | 'repair-dead-mapping-key'
  /** A second `column-repair` on a column whose repair chain already carries a different trim specification (the composed per-column function is one `trim∘map` with one set). */
  | 'repair-trim-mismatch'

/** One op's interpretation: the op, its typed outcome, and its derived inverse. */
export interface OpApplication {
  readonly op: EditOp
  readonly outcome: OpOutcome
  /**
   * The ops that undo this one against the state it was applied to, in
   * application order — empty exactly when `outcome.status !== 'applied'`
   * (the state did not change, so there is nothing to undo). Usually a
   * single op; a list where the exact undo is several (see
   * `stepRowUninsert`).
   */
  readonly inverse: readonly EditOp[]
}

/** `stepOverlay`: the op applied against one state. */
export interface OverlayStep {
  /** The new state — reference-identical to the input unless `applied`. */
  readonly state: OverlayState
  readonly application: OpApplication
}

/** The empty overlay over `base` — fold of the empty prefix. */
export function initialState(base: OverlayBase): OverlayState {
  return {
    anchors: { baseAnchor: base.baseAnchor, overlayAnchor: base.overlayAnchor },
    columns: base.columns,
    edits: new Map(),
    inserts: new Map(),
    deletedBase: new Set(),
    nextInsertSeq: 0,
    repairs: [],
  }
}

/**
 * Fold one op against `state`. Total: returns a typed outcome for every
 * input; throws on nothing. The returned state is fresh when the outcome is
 * `applied` and the *same reference* otherwise (callers can use identity as
 * a cheap change signal; deep equality holds regardless).
 */
export function stepOverlay(base: OverlayBase, state: OverlayState, op: EditOp): OverlayStep {
  // Foreign-state guard: a state folded against another base version or
  // overlay session must never be applied here. `deletedBase` ordinals do
  // not carry an anchor, so the binding lives on the state itself (see
  // {@link OverlayState.anchors}); divergence is a typed conflict, never a
  // silent cross-application.
  if (
    state.anchors.baseAnchor !== base.baseAnchor ||
    state.anchors.overlayAnchor !== base.overlayAnchor
  ) {
    return unchanged(op, state, conflict('state-anchor-mismatch'))
  }
  switch (op.kind) {
    case 'cell-set':
      return stepCellSet(base, state, op)
    case 'cell-revert':
      return stepCellRevert(base, state, op)
    case 'row-insert':
      return stepRowInsert(base, state, op)
    case 'row-uninsert':
      return stepRowUninsert(base, state, op)
    case 'row-delete':
      return stepRowDelete(base, state, op)
    case 'row-restore':
      return stepRowRestore(base, state, op)
    case 'column-rename':
      return stepColumnRename(base, state, op)
    case 'column-cast':
      return stepColumnCast(base, state, op)
    case 'column-repair':
      return stepColumnRepair(base, state, op)
    default: {
      // Exhaustiveness guard: adding an EditOp variant without a step rule
      // must fail compilation, not fall through at runtime.
      const exhaustive: never = op
      throw new Error(`unreachable: unhandled edit op kind ${String(exhaustive)}`)
    }
  }
}

/** Fold a whole op list left-to-right, collecting per-op applications. */
export function foldOverlay(
  base: OverlayBase,
  ops: readonly EditOp[],
): { readonly state: OverlayState; readonly applications: readonly OpApplication[] } {
  let state = initialState(base)
  const applications: OpApplication[] = []
  for (const op of ops) {
    const step = stepOverlay(base, state, op)
    state = step.state
    applications.push(step.application)
  }
  return { state, applications }
}

// ---------------------------------------------------------------------------
// Per-op rules
// ---------------------------------------------------------------------------

function stepCellSet(
  base: OverlayBase,
  state: OverlayState,
  op: Extract<EditOp, { kind: 'cell-set' }>,
): OverlayStep {
  const located = locateLiveRow(base, state, op.rowId)
  if ('outcome' in located) return unchanged(op, state, located.outcome)
  if (!hasColumn(state.columns, op.column)) {
    return unchanged(op, state, conflict('unknown-column'))
  }
  const prior = state.edits.get(op.rowId)?.get(op.column)
  if (prior !== undefined && cellValueEqual(prior, op.value)) {
    return unchanged(op, state, noOp('cell-value-unchanged'))
  }
  const edits = new Map(state.edits)
  const inner = new Map(edits.get(op.rowId) ?? new Map<string, CellValue>())
  inner.set(op.column, op.value)
  edits.set(op.rowId, inner)
  const columnIndex = state.columns.findIndex((candidate) => candidate.name === op.column)
  return {
    state: maskRepairsFor({ ...state, edits }, columnIndex, op.rowId),
    application: {
      op,
      outcome: { status: 'applied', notes: located.notes },
      // Restore the prior overlay edit if there was one; otherwise the
      // inverse is "drop the edit, the base value stands again".
      inverse: [
        prior === undefined
          ? { kind: 'cell-revert', rowId: op.rowId, column: op.column }
          : { kind: 'cell-set', rowId: op.rowId, column: op.column, value: prior },
      ],
    },
  }
}

function stepCellRevert(
  base: OverlayBase,
  state: OverlayState,
  op: Extract<EditOp, { kind: 'cell-revert' }>,
): OverlayStep {
  const located = locateLiveRow(base, state, op.rowId)
  if ('outcome' in located) return unchanged(op, state, located.outcome)
  if (!hasColumn(state.columns, op.column)) {
    return unchanged(op, state, conflict('unknown-column'))
  }
  const prior = state.edits.get(op.rowId)?.get(op.column)
  if (prior === undefined) return unchanged(op, state, noOp('cell-already-base'))
  const edits = new Map(state.edits)
  const inner = new Map(edits.get(op.rowId))
  inner.delete(op.column)
  if (inner.size === 0) edits.delete(op.rowId)
  else edits.set(op.rowId, inner)
  const columnIndex = state.columns.findIndex((candidate) => candidate.name === op.column)
  return {
    state: maskRepairsFor({ ...state, edits }, columnIndex, op.rowId),
    application: {
      op,
      outcome: { status: 'applied', notes: located.notes },
      inverse: [{ kind: 'cell-set', rowId: op.rowId, column: op.column, value: prior }],
    },
  }
}

function stepRowInsert(
  base: OverlayBase,
  state: OverlayState,
  op: Extract<EditOp, { kind: 'row-insert' }>,
): OverlayStep {
  // Check order: id shape → session anchor → schema → state.
  const parsed = parseRowId(op.rowId)
  if (parsed === null) return unchanged(op, state, conflict('malformed-row-id'))
  if (parsed.origin !== 'insert') return unchanged(op, state, conflict('not-an-insert-id'))
  if (parsed.anchor !== base.overlayAnchor) {
    return unchanged(op, state, conflict('insert-anchor-mismatch'))
  }
  for (const column of op.values.keys()) {
    if (!hasColumn(state.columns, column)) {
      return unchanged(op, state, conflict('unknown-column'))
    }
  }
  const existing = state.inserts.get(op.rowId)
  if (existing !== undefined) {
    if (existing.live && valueRecordsEqual(existing.values, op.values)) {
      return unchanged(op, state, noOp('row-already-present'))
    }
    return unchanged(op, state, conflict('insert-id-collision'))
  }
  const notes: AppliedNote[] =
    op.position.kind === 'before' || op.position.kind === 'after'
      ? isLiveRow(base, state, op.position.rowId)
        ? []
        : ['position-anchor-not-live']
      : []
  const inserts = new Map(state.inserts)
  inserts.set(op.rowId, {
    id: op.rowId,
    live: true,
    position: op.position,
    values: op.values,
    seq: parsed.seq,
  })
  return {
    state: {
      ...state,
      inserts,
      // Monotonic past every allocated seq, even when a host batch-allocates
      // ahead — ids are never reused while a log entry references them.
      nextInsertSeq: Math.max(state.nextInsertSeq, parsed.seq + 1),
    },
    application: {
      op,
      outcome: { status: 'applied', notes },
      // The exact inverse is the un-insert (record, edits and allocation
      // gone) — a plain row-delete would leave a tombstone behind, so
      // undoing an insert via delete would not restore the prior fold.
      inverse: [{ kind: 'row-uninsert', rowId: op.rowId }],
    },
  }
}

function stepRowUninsert(
  base: OverlayBase,
  state: OverlayState,
  op: Extract<EditOp, { kind: 'row-uninsert' }>,
): OverlayStep {
  // Same id rules as row-insert: shape → session anchor → existence.
  const parsed = parseRowId(op.rowId)
  if (parsed === null) return unchanged(op, state, conflict('malformed-row-id'))
  if (parsed.origin !== 'insert') return unchanged(op, state, conflict('not-an-insert-id'))
  if (parsed.anchor !== base.overlayAnchor) {
    return unchanged(op, state, conflict('insert-anchor-mismatch'))
  }
  const record = state.inserts.get(op.rowId)
  if (record === undefined) return unchanged(op, state, conflict('unknown-row'))
  // Expunge the row's whole overlay story: record *and* cell edits (the
  // edits map is unreachable while the record is gone, and leaving it would
  // let a reclaimed id inherit a dead row's edits).
  const wasDead = !record.live
  const priorEdits = state.edits.get(op.rowId)
  const inserts = new Map(state.inserts)
  inserts.delete(op.rowId)
  const edits = new Map(state.edits)
  edits.delete(op.rowId)
  // Reclaim the allocation point only when nothing lives above the freed
  // seq — freeing an interior insert must not let a future insert reuse an
  // id below surviving rows (nextInsertSeq > every stored seq stays true).
  let nextInsertSeq = state.nextInsertSeq
  let above = false
  for (const other of inserts.values()) {
    if (other.seq > parsed.seq) {
      above = true
      break
    }
  }
  if (!above) nextInsertSeq = Math.min(nextInsertSeq, parsed.seq)
  return {
    state: { ...state, inserts, edits, nextInsertSeq },
    application: {
      op,
      outcome: { status: 'applied', notes: [] },
      // Exact undo is a small op list: re-insert the captured record,
      // restore each expunged cell edit — and, if the row was tombstoned
      // when expunged, re-tombstone it (cell edits are kept under
      // tombstones, exactly as row-delete leaves them).
      inverse: [
        { kind: 'row-insert', rowId: op.rowId, position: record.position, values: record.values },
        ...Array.from(priorEdits ?? new Map<string, CellValue>()).map(([column, value]) => ({
          kind: 'cell-set' as const,
          rowId: op.rowId,
          column,
          value,
        })),
        ...(wasDead ? [{ kind: 'row-delete' as const, rowId: op.rowId }] : []),
      ],
    },
  }
}

function stepRowDelete(
  base: OverlayBase,
  state: OverlayState,
  op: Extract<EditOp, { kind: 'row-delete' }>,
): OverlayStep {
  const located = locateRow(base, state, op.rowId)
  if ('outcome' in located) return unchanged(op, state, located.outcome)
  if (!located.live) return unchanged(op, state, noOp('row-already-deleted'))
  if (located.origin === 'base') {
    const deletedBase = new Set(state.deletedBase)
    deletedBase.add(located.ordinal)
    return {
      state: { ...state, deletedBase },
      application: {
        op,
        outcome: { status: 'applied', notes: [] },
        inverse: [{ kind: 'row-restore', rowId: op.rowId }],
      },
    }
  }
  const inserts = new Map(state.inserts)
  const record = inserts.get(op.rowId)
  // locateRow proved existence; re-checking keeps the step total without
  // assertions even if the locate contract ever changes.
  if (record === undefined) return unchanged(op, state, conflict('unknown-row'))
  inserts.set(op.rowId, { ...record, live: false })
  return {
    state: { ...state, inserts },
    application: {
      op,
      outcome: { status: 'applied', notes: [] },
      inverse: [{ kind: 'row-restore', rowId: op.rowId }],
    },
  }
}

function stepRowRestore(
  base: OverlayBase,
  state: OverlayState,
  op: Extract<EditOp, { kind: 'row-restore' }>,
): OverlayStep {
  const located = locateRow(base, state, op.rowId)
  if ('outcome' in located) return unchanged(op, state, located.outcome)
  if (located.live) return unchanged(op, state, noOp('row-already-present'))
  if (located.origin === 'base') {
    const deletedBase = new Set(state.deletedBase)
    deletedBase.delete(located.ordinal)
    return {
      state: { ...state, deletedBase },
      application: {
        op,
        outcome: { status: 'applied', notes: [] },
        inverse: [{ kind: 'row-delete', rowId: op.rowId }],
      },
    }
  }
  const inserts = new Map(state.inserts)
  const record = inserts.get(op.rowId)
  if (record === undefined) return unchanged(op, state, conflict('unknown-row'))
  // Values, position and seq are preserved verbatim — restore is exact.
  inserts.set(op.rowId, { ...record, live: true })
  return {
    state: { ...state, inserts },
    application: {
      op,
      outcome: { status: 'applied', notes: [] },
      inverse: [{ kind: 'row-delete', rowId: op.rowId }],
    },
  }
}

function stepColumnRepair(
  _base: OverlayBase,
  state: OverlayState,
  op: Extract<EditOp, { kind: 'column-repair' }>,
): OverlayStep {
  // Check order: schema → declared type → plan shape (caps, trim, dead keys)
  // → identity. Every refusal is a typed value-free conflict, so an invalid
  // plan never enters the log and never reaches the engine (appendOp refuses
  // conflicted ops).
  const columnIndex = state.columns.findIndex((candidate) => candidate.name === op.column)
  if (columnIndex < 0) return unchanged(op, state, conflict('unknown-column'))
  const declaredType = state.columns[columnIndex]?.type as string
  if (!isTextualRepairType(declaredType)) {
    return unchanged(op, state, conflict('repair-column-not-text'))
  }
  if (op.mapping.size > MAX_REPAIR_MAPPING_PAIRS) {
    return unchanged(op, state, conflict('repair-mapping-cap'))
  }
  let trim: string | undefined
  if (op.trim !== undefined) {
    const codePointCount = [...op.trim].length
    if (typeof op.trim !== 'string' || op.trim.length === 0 || codePointCount === 0) {
      return unchanged(op, state, conflict('repair-trim-invalid'))
    }
    if (codePointCount > MAX_REPAIR_TRIM_CODE_POINTS) {
      return unchanged(op, state, conflict('repair-trim-invalid'))
    }
    trim = op.trim
  }
  // Dead entries (D16/D17 probe §7.1 constraint 3): with a trim in the plan
  // the CASE operand is always the *trimmed* value, so a key carrying
  // trim-set edges can never match — trimWithCodePoints(key) ≠ key. (The
  // one-line summary inverts this twice; the probe, D17 test item 19 and the
  // emitted SQL all pin the same direction: keys that differ from their
  // trim-normalised form are the dead ones.) Without a trim nothing is dead:
  // every key matches itself exactly.
  if (trim !== undefined) {
    for (const key of op.mapping.keys()) {
      if (trimWithCodePoints(key, trim) !== key) {
        return unchanged(op, state, conflict('repair-dead-mapping-key'))
      }
    }
  }
  // One composed per-column function is one trim∘map with ONE trim set (§1:
  // the wrap's operand and ELSE share "<same set>"); a second repair on a
  // column whose chain already carries a different trim specification would
  // make the composed function unreproducible by any single-operand form —
  // refused here, at plan construction, while the prefix is still flat.
  for (const prior of state.repairs) {
    if (prior.columnIndex !== columnIndex) continue
    if (prior.trim !== trim) {
      return unchanged(op, state, conflict('repair-trim-mismatch'))
    }
  }
  if (op.mapping.size === 0 && trim === undefined) {
    return unchanged(op, state, noOp('repair-identity'))
  }
  // The repair's own value effect lives in the composer (the §6.2 wrap); the
  // fold records the value-independent metadata the wrap needs. Undo is the
  // exact refold at the cursor: inverse: [] + the ADR 0050 note.
  const deadOrdinalsAtApply = new Set(state.deletedBase)
  const liveInsertIdsAtApply = new Set<RowId>()
  for (const record of state.inserts.values()) {
    if (record.live) liveInsertIdsAtApply.add(record.id)
  }
  const record: RepairStepRecord = {
    columnIndex,
    typeAtApply: declaredType,
    ...(trim !== undefined ? { trim } : {}),
    mapping: op.mapping,
    deadOrdinalsAtApply,
    liveInsertIdsAtApply,
    maskedRows: new Set<RowId>(),
  }
  return {
    state: { ...state, repairs: [...state.repairs, record] },
    application: {
      op,
      outcome: { status: 'applied', notes: ['undo-by-refold'] },
      inverse: [],
    },
  }
}

/**
 * Record a suffix value-op's masking: an **applied** `cell-set`/`cell-revert`
 * on a column with repairs masks, for that one row, every earlier repair on
 * the same column (the later absolute write wins; EW-04D §6.2). Logged no-ops
 * never reach this path (they leave the state unchanged). Column identity is
 * the index — renames re-key names, never positions. O(repairs) per applied
 * value-op, session-bounded.
 */
function maskRepairsFor(state: OverlayState, columnIndex: number, rowId: RowId): OverlayState {
  let changed = false
  const repairs = state.repairs.map((record) => {
    if (record.columnIndex !== columnIndex || record.maskedRows.has(rowId)) return record
    changed = true
    const maskedRows = new Set(record.maskedRows)
    maskedRows.add(rowId)
    return { ...record, maskedRows }
  })
  return changed ? { ...state, repairs } : state
}

function stepColumnRename(
  _base: OverlayBase,
  state: OverlayState,
  op: Extract<EditOp, { kind: 'column-rename' }>,
): OverlayStep {
  if (!hasColumn(state.columns, op.from)) {
    return unchanged(op, state, conflict('unknown-column'))
  }
  if (op.from === op.to) return unchanged(op, state, noOp('rename-identity'))
  if (hasColumn(state.columns, op.to)) {
    return unchanged(op, state, conflict('rename-collision'))
  }
  // Rename is schema meta: values are untouched, but every overlay record
  // keyed by column name is re-keyed so later ops (and engine composition)
  // see the final names.
  const columns = state.columns.map((c) => (c.name === op.from ? { name: op.to, type: c.type } : c))
  const edits = new Map<RowId, ReadonlyMap<string, CellValue>>()
  for (const [rowId, inner] of state.edits) {
    if (!inner.has(op.from)) {
      edits.set(rowId, inner)
      continue
    }
    const rekeyed = new Map<string, CellValue>()
    for (const [column, value] of inner) {
      rekeyed.set(column === op.from ? op.to : column, value)
    }
    edits.set(rowId, rekeyed)
  }
  const inserts = new Map<RowId, InsertedRowRecord>()
  for (const [rowId, record] of state.inserts) {
    if (!record.values.has(op.from)) {
      inserts.set(rowId, record)
      continue
    }
    const rekeyed = new Map<string, CellValue>()
    for (const [column, value] of record.values) {
      rekeyed.set(column === op.from ? op.to : column, value)
    }
    inserts.set(rowId, { ...record, values: rekeyed })
  }
  return {
    state: { ...state, columns, edits, inserts },
    application: {
      op,
      outcome: { status: 'applied', notes: [] },
      inverse: [{ kind: 'column-rename', from: op.to, to: op.from }],
    },
  }
}

function stepColumnCast(
  _base: OverlayBase,
  state: OverlayState,
  op: Extract<EditOp, { kind: 'column-cast' }>,
): OverlayStep {
  const current = state.columns.find((c) => c.name === op.column)
  if (current === undefined) return unchanged(op, state, conflict('unknown-column'))
  if (current.type === op.targetType) return unchanged(op, state, noOp('cast-identity'))
  const columns = state.columns.map((c) =>
    c.name === op.column ? { name: c.name, type: op.targetType } : c,
  )
  return {
    state: { ...state, columns },
    application: {
      op,
      outcome: { status: 'applied', notes: [] },
      // Cast-back intent: whether the original cast round-trips the data is
      // the engine's concern at materialization; the inverse restores the
      // declared type so the schema fold is exactly reversible.
      inverse: [{ kind: 'column-cast', column: op.column, targetType: current.type }],
    },
  }
}

// ---------------------------------------------------------------------------
// Row location (shared check order: shape → anchor/version → existence)
// ---------------------------------------------------------------------------

type LocatedRow =
  | {
      readonly found: true
      readonly origin: 'base'
      readonly ordinal: number
      readonly live: boolean
    }
  | {
      readonly found: true
      readonly origin: 'insert'
      readonly ordinal?: undefined
      readonly live: boolean
    }
  | { readonly found: false; readonly outcome: OpOutcome }

function locateRow(base: OverlayBase, state: OverlayState, rowId: RowId): LocatedRow {
  const parsed = parseRowId(rowId)
  if (parsed === null) return { found: false, outcome: conflict('malformed-row-id') }
  if (parsed.origin === 'base') {
    if (parsed.anchor !== base.baseAnchor) {
      // A different base version — ids from an older session are foreign
      // (the documented survival boundary, surfacing as a typed conflict).
      return { found: false, outcome: conflict('row-anchor-mismatch') }
    }
    if (parsed.ordinal >= base.baseRowCount) {
      return { found: false, outcome: conflict('unknown-row') }
    }
    return {
      found: true,
      origin: 'base',
      ordinal: parsed.ordinal,
      live: !state.deletedBase.has(parsed.ordinal),
    }
  }
  if (parsed.anchor !== base.overlayAnchor) {
    return { found: false, outcome: conflict('insert-anchor-mismatch') }
  }
  const record = state.inserts.get(rowId)
  if (record === undefined) return { found: false, outcome: conflict('unknown-row') }
  return { found: true, origin: 'insert', live: record.live }
}

/** Locate a row and require it to be live (for cell-level ops). */
function locateLiveRow(
  base: OverlayBase,
  state: OverlayState,
  rowId: RowId,
):
  | { readonly found: true; readonly notes: readonly AppliedNote[] }
  | { readonly found: false; readonly outcome: OpOutcome } {
  const located = locateRow(base, state, rowId)
  if (!located.found) return located
  if (!located.live) return { found: false, outcome: conflict('row-deleted') }
  return { found: true, notes: [] }
}

// ---------------------------------------------------------------------------
// Queries over the folded state
// ---------------------------------------------------------------------------

/** True iff the id resolves to a live row of this overlay (never throws). */
export function isLiveRow(base: OverlayBase, state: OverlayState, rowId: RowId): boolean {
  const located = locateRow(base, state, rowId)
  return located.found && located.live
}

/**
 * The overlay edit for one cell, or `null` when the cell has no overlay edit
 * (the base value stands). `null` is "no edit" — a NULL *value* is
 * `{ kind: 'null' }` and never conflated with it.
 */
export function overlayEdit(state: OverlayState, rowId: RowId, column: string): CellValue | null {
  return state.edits.get(rowId)?.get(column) ?? null
}

/**
 * Effective live row count: base rows minus tombstones plus live inserts.
 * This is what m4-2's row-count composition must produce.
 */
export function liveRowCount(base: OverlayBase, state: OverlayState): number {
  let liveInserts = 0
  for (const record of state.inserts.values()) if (record.live) liveInserts++
  return base.baseRowCount - state.deletedBase.size + liveInserts
}

/**
 * The effective row order as logical ids: base rows in base-ordinal order
 * (minus tombstones), with live inserts placed at their requested
 * {@link InsertPosition}:
 *
 * - `start`/`end` emit at the very beginning/end (before degraded rows).
 * - `before X` / `after X` emit immediately before/after `X`'s emission;
 *   several rows anchored to the same `X` keep insert-sequence order —
 *   reading AWAY from the anchor: an `after X` chain emits the earliest
 *   closest to `X`, a `before X` chain emits the latest closest to `X`
 *   (both lists read in ascending sequence order away from `X`'s side —
 *   sequence order is a function of the state alone, not of application
 *   history; this matches the engine's `insertSortKeys` composition,
 *   m4-2/audit AR-D2) — and chains nest depth-first (`after X` then `after`
 *   that row, etc.).
 * - An anchor that is not live (deleted, unknown, or foreign) — or a
 *   degenerate self-referencing chain — degrades deterministically to the
 *   end, after explicit `end` rows, in application order. Apply-time
 *   `position-anchor-not-live` notes on the outcome announce this per op.
 *
 * O(base row count + inserts): a full materialization is the caller's
 * choice (bounded views, tests); engines compose the same order in SQL
 * (m4-2) instead of calling this at dataset scale.
 */
export function effectiveRowIds(base: OverlayBase, state: OverlayState): RowId[] {
  const beforeByAnchor = new Map<RowId, InsertedRowRecord[]>()
  const afterByAnchor = new Map<RowId, InsertedRowRecord[]>()
  const start: InsertedRowRecord[] = []
  const end: InsertedRowRecord[] = []
  for (const record of state.inserts.values()) {
    if (!record.live) continue
    switch (record.position.kind) {
      case 'start':
        start.push(record)
        break
      case 'end':
        end.push(record)
        break
      case 'before':
        bucket(beforeByAnchor, record.position.rowId, record)
        break
      case 'after':
        bucket(afterByAnchor, record.position.rowId, record)
        break
    }
  }
  const bySeq = (a: InsertedRowRecord, b: InsertedRowRecord): number => a.seq - b.seq
  start.sort(bySeq)
  end.sort(bySeq)
  for (const list of beforeByAnchor.values()) list.sort(bySeq)
  for (const list of afterByAnchor.values()) list.sort(bySeq)

  const emitted = new Set<RowId>()
  const out: RowId[] = []
  const emitChain = (record: InsertedRowRecord): void => {
    if (emitted.has(record.id)) return
    emitted.add(record.id)
    for (const before of beforeByAnchor.get(record.id) ?? []) emitChain(before)
    out.push(record.id)
    for (const after of afterByAnchor.get(record.id) ?? []) emitChain(after)
  }
  for (const record of start) emitChain(record)
  for (let ordinal = 0; ordinal < base.baseRowCount; ordinal++) {
    // A tombstoned row is not emitted, and neither are the rows anchored to
    // it — their slots degrade to the end sweep below (documented rule).
    if (state.deletedBase.has(ordinal)) continue
    const id = baseRowId(base.baseAnchor, ordinal)
    for (const record of beforeByAnchor.get(id) ?? []) emitChain(record)
    emitted.add(id)
    out.push(id)
    for (const record of afterByAnchor.get(id) ?? []) emitChain(record)
  }
  for (const record of end) emitChain(record)
  // Degraded slots (dead/unknown anchors, cycles) fall out here, in insert
  // sequence order — deterministic even when hosts anchor into the void.
  const leftovers = [...state.inserts.values()]
    .filter((record) => record.live && !emitted.has(record.id))
    .sort(bySeq)
  for (const record of leftovers) emitChain(record)
  return out
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function hasColumn(columns: readonly ColumnSpec[], name: string): boolean {
  return columns.some((c) => c.name === name)
}

function valueRecordsEqual(a: CellValueRecord, b: CellValueRecord): boolean {
  // Columns absent from a record materialize as NULL (the documented v1
  // rule, `edit-ops.ts`), so `{a: 1}` and `{a: 1, b: null}` describe the
  // same logical insert — a benign replay, not a conflict (AR-D1). Compare
  // the *materialized* records over the union of keys; a real value against
  // an explicit NULL still diverges.
  const columns = new Set<string>([...a.keys(), ...b.keys()])
  for (const column of columns) {
    const left = a.get(column) ?? NULL_VALUE
    const right = b.get(column) ?? NULL_VALUE
    if (!cellValueEqual(left, right)) return false
  }
  return true
}

function bucket(
  map: Map<RowId, InsertedRowRecord[]>,
  anchor: RowId,
  record: InsertedRowRecord,
): void {
  const list = map.get(anchor)
  if (list === undefined) map.set(anchor, [record])
  else list.push(record)
}

function unchanged(op: EditOp, state: OverlayState, outcome: OpOutcome): OverlayStep {
  return { state, application: { op, outcome, inverse: [] } }
}

function noOp(reason: NoOpReason): OpOutcome {
  return { status: 'no-op', reason }
}

function conflict(reason: ConflictReason): OpOutcome {
  return { status: 'conflict', reason }
}
