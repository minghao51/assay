// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CellValue, EditOp, RowId, TransformationHistory } from '@assay/domain'
import {
  appendOp,
  emptyHistory,
  foldOverlay,
  insertRowId,
  redo as redoHistory,
  stateAtCursor,
  undo as undoHistory,
} from '@assay/domain'
import type { EngineExportFormat, EngineExportResult, EngineOverlay } from '@assay/engine-duckdb'
import {
  activeOps,
  castRacedMessage,
  castRefusalMessage,
  COLUMN_TYPE_REJECTED_SUMMARY,
  commitWithRollback,
  editOutcomeMessage,
  engineRejectionMessage,
  overlaySnapshot,
} from '../edit/session'
import { captureIsStale, repairCaptureTag } from '../edit/repair/capture'
import type { RepairApplyGuard, RepairCaptureTag } from '../edit/repair/capture'
import {
  REPAIR_PREVIEW_STALE,
  REPAIR_REFUSAL_ALREADY_ACTIVE,
  REPAIR_REFUSAL_ZERO_AFFECTED,
} from '../edit/repair/copy'
import {
  repairPlanFingerprint,
  repairPlanIsActive,
  repairPlanOp,
  type RepairPlan,
} from '../edit/repair/plan'
import { requestSaveDestination, writeExportCopy } from '../export/save-destination'
import type {
  SaveStrategy,
  SourceIdentity,
  WritableSaveDestination,
} from '../export/save-destination'
import { engineClient } from '../lib/engine'
import type { DatasetSession } from './session-reset'
import type { Phase } from './types'

/**
 * How many times the cast path re-runs the engine's pre-commit check when a
 * same-table history change invalidates a result. Each attempt awaits the
 * engine, so this is a contention bound, not a hot loop; if the state keeps
 * changing the intent is refused honestly rather than appended unchecked.
 *
 * The cast path is the only flow that keeps this retry: it asks its question
 * *outside* the mutation chain on purpose, because its contract is to re-run
 * when a same-table change lands during the check (the m4-4 race, pinned by
 * `App.column-ops`). A `cell-set` has no retry at all — its check and its
 * activation happen inside one chain task, so nothing can invalidate its
 * verdict (see `appendAndCommit`).
 */
const MAX_CAST_CHECK_ATTEMPTS = 3

/** The empty aggregate cast-pending set (shared; never mutated in place). */
const EMPTY_CAST_PENDING: ReadonlySet<string> = new Set<string>()

/** q-3: one polite announcement; `seq` keeps repeated identical text firing. */
interface EditAnnouncement {
  readonly text: string
  readonly seq: number
}

/**
 * One pre-commit value check, handed to `commitHistory`: the closure
 * `commitWithRollback` runs before it activates anything, plus the abort
 * record the caller reads afterwards (the closure cannot throw a verdict of its
 * own — `commitWithRollback` turns a rejection into the framed refusal text).
 */
interface CellValueCheck {
  readonly validate: () => Promise<void>
  /**
   * True when the check stopped without a verdict because the dataset was
   * replaced while it ran. The mutation chain serializes every same-table
   * activation, so this is the *only* abort there is: nothing was activated and
   * a stale edit error must not be reported against a table that is gone.
   */
  readonly aborted: () => boolean
}

export interface EditingSession {
  readonly history: TransformationHistory
  /**
   * The effective overlay state at the history cursor (pure fold); `null`
   * before a table is ready.
   */
  readonly overlayState: ReturnType<typeof stateAtCursor> | null
  readonly overlayRevision: number
  readonly editError: string | null
  readonly editAnnouncement: EditAnnouncement | null
  readonly viewError: boolean
  /**
   * WF-06 (S-A2-4 / IC-02): the columns whose cast pre-check is in flight,
   * keyed by column so two different columns' checks may overlap exactly as
   * today (per-column disable is unchanged). The **authority** the gesture gate
   * reads is `castPendingColumnsRef`; this state is the render mirror
   * `SchemaPanel` and the C16 notice consume.
   */
  readonly castPendingColumns: ReadonlySet<string>
  /** Synchronous authority mirror of `castPendingColumns` (read by the gate). */
  readonly castPendingColumnsRef: { current: ReadonlySet<string> }
  /** Render mirror: how many cast pre-checks are pending (0 ⇒ none). */
  readonly castPendingCount: number
  /**
   * WF-06 (S-A2-2): commits currently materializing, counted — not a boolean.
   * Since R1-C every history-changing gesture is a task on one serialized
   * mutation chain, so the count is 1 while a commit materializes and back to 0
   * when the last queued task settles; it stays a counter rather than a boolean
   * because a *queued* gesture may start the moment the current one settles.
   * Incremented immediately before the commit's `await` and decremented in a
   * `finally`; the gesture gate reads THIS ref.
   */
  readonly mutationStateRef: { current: number }
  /**
   * Render mirror of `mutationStateRef > 0`, written in the same two places.
   * Used only to render/clear the C15 notice — never as gate authority.
   */
  readonly mutationPending: boolean
  /**
   * Synchronous mirror of `history`; the cast path `await`s the engine's
   * pre-commit check, so reading the ref at append time prevents a stale
   * closure from dropping an edit made while the check was in flight. Exposed
   * so the validation/diff hooks compile against the current effective schema.
   */
  readonly historyRef: { current: TransformationHistory }
  /**
   * Synchronous mirror of the active overlay snapshot; the provider reads it
   * the moment a commit triggers `model.refresh()`, before React re-renders.
   * Exposed so the validation/diff hooks export the exact view on screen.
   */
  readonly overlayRef: { current: EngineOverlay | null }
  readonly announceEdit: (text: string) => void
  /**
   * m4-5 export effects. `runExport` materializes the active overlay snapshot
   * (base + ops at the history cursor) — never the source path, never the
   * base view alone (ADR 0012); the two destination helpers thread the
   * same-source guard through the save picker.
   */
  readonly runExport: (format: EngineExportFormat) => Promise<EngineExportResult>
  readonly requestExportDestination: typeof requestSaveDestination
  readonly deliverExportCopy: (
    destination: WritableSaveDestination,
    result: EngineExportResult,
  ) => Promise<SaveStrategy>
  readonly handleUndo: () => void
  readonly handleRedo: () => void
  readonly handleInsertRow: () => void
  readonly handleCommitCell: (rowId: RowId, column: string, value: CellValue) => void
  readonly handleDeleteRow: (rowId: RowId) => void
  readonly handleRenameColumn: (from: string, to: string) => void
  readonly handleCastColumn: (column: string, targetType: string) => void
  readonly handleSelectCursor: (nextCursor: number) => void
  /**
   * EW-04I: the capture tag for a `column-repair` plan — the revision a preview
   * is tagged with (base/overlay anchors, cursor, history revision, target
   * column + whole-schema signature). Read from the LIVE refs, so it is the
   * same value a preview captured and the value publication re-verifies.
   * `null` when the column is not in the effective schema.
   */
  readonly captureRepairTag: (column: string) => RepairCaptureTag | null
  /**
   * EW-04I: publish one repair plan through the existing commit boundary —
   * append `column-repair` (one history entry) + activate + one refresh, with
   * the same rollback/Retry semantics as every other edit. Refuses before any
   * append when the preview is stale (U2), when the plan changes no row (U1,
   * D8: no no-op entry) or when the identical plan is already applied at the
   * cursor (D7, plan identity).
   */
  readonly handleApplyRepair: (plan: RepairPlan, guard: RepairApplyGuard) => void
  readonly retryView: () => Promise<void>
}

/**
 * m4-3 editing session (extracted from `App` by f-1). Owns the immutable
 * `OverlayBase` view: `history` is React state (pure refolds render it);
 * `overlayRef` mirrors the active snapshot synchronously so the provider
 * reads the new ops the moment a commit triggers `model.refresh()`, before
 * React has re-rendered. `overlayRevision` is the monotonic freshness signal
 * the record inspector and the validation/diff stale banners consume.
 *
 * The hook registers its reset with the dataset session: a new file drops the
 * previous table's history, clears the error/announcement surface, nulls the
 * overlay and bumps `historyRevision` so an in-flight cast check is
 * invalidated along with the session token.
 */
export function useEditingSession(
  phase: Phase,
  session: DatasetSession,
  /**
   * Identity of the opened source, retained by the open flow for the export
   * same-source guard (m4-5). Never rendered or logged (ADR 0025).
   */
  sourceIdentityRef: { current: SourceIdentity | null },
): EditingSession {
  const [history, setHistory] = useState<TransformationHistory>(() => emptyHistory())
  const [overlayRevision, setOverlayRevision] = useState(0)
  const [editError, setEditError] = useState<string | null>(null)
  /**
   * q-3: the single `aria-live="polite"` announcement for grid edit commit
   * and rejection. The region is persistent; a monotonic `seq` replaces its
   * text node so a repeated identical announcement (two commits in a row)
   * still fires. Announced text is always value-free: the engine rejection
   * class (q-8) or a client validation reason (typed-input), never a cell
   * value (ADR 0025).
   */
  const [editAnnouncement, setEditAnnouncement] = useState<EditAnnouncement | null>(null)
  const editAnnouncementSeq = useRef(0)
  const announceEdit = useCallback((text: string) => {
    editAnnouncementSeq.current += 1
    setEditAnnouncement({ text, seq: editAnnouncementSeq.current })
  }, [])
  /**
   * Set the visible edit error and mirror every non-null message into the
   * polite live region. Used for engine rejections, cast refusals, and
   * non-applied outcomes; the grid reports its client-side rejections
   * through `announceEdit` directly (it keeps its own visible text).
   */
  const showEditError = useCallback(
    (message: string | null) => {
      setEditError(message)
      if (message !== null) announceEdit(message)
    },
    [announceEdit],
  )
  /**
   * m4-4 carry-over: true only when a commit was rejected *and* restoring the
   * previous view also failed. It renders a retry affordance so an engine
   * outage cannot leave an unattributed alert over a half-loaded grid.
   */
  const [viewError, setViewError] = useState(false)
  const overlayRef = useRef<EngineOverlay | null>(null)
  /**
   * Synchronous mirror of `history`. Every history-changing gesture is a task on
   * the mutation chain (see `enqueue`) and reads this ref **when its task runs**,
   * so a burst of edits composes in order and a stale closure can never drop an
   * edit that was queued behind an engine check.
   */
  const historyRef = useRef<TransformationHistory>(history)
  /**
   * Monotonic revision of the *active history*, bumped by every
   * `activateHistory` (each op, undo/redo, and selective-cursor move). The
   * cast path `await`s the engine's pre-commit check against a snapshot; if
   * the history changed while that check was in flight, the result describes
   * state the append would no longer commit over (the reviewer's same-table
   * race: a cell edit/undo/insert landing during the check let a stale
   * `hasNonConvertibleValues:false` append a cast over un-checked values).
   * The revision captured with the snapshot is re-compared at append time.
   */
  const historyRevision = useRef(0)
  /**
   * WF-06 (S-A2-4 / IC-02): the set of columns whose cast pre-check is
   * currently in flight. Replaces the single `castPendingColumn` string so an
   * aggregate gate input exists: with one value, the later check's `finally`
   * could clear the marker while an earlier check on another column was still
   * running, and the gate would permit replacement mid-check.
   *
   * The ref is the synchronous authority (updated before the first `await` and
   * in the existing `finally`); the state is the render mirror. Keying by
   * column keeps today's per-column disable exactly: a running check disables
   * only its own column's Rename/Cast buttons, and a double-click cannot queue
   * a second intent for the same column.
   */
  const castPendingColumnsRef = useRef<ReadonlySet<string>>(EMPTY_CAST_PENDING)
  const [castPendingColumns, setCastPendingColumns] =
    useState<ReadonlySet<string>>(EMPTY_CAST_PENDING)
  /**
   * WF-06 (S-A2-2): counted commits in flight + its render mirror. The counter
   * only lets the gesture gate refuse while work is pending; it does not
   * serialize, order, coalesce, abort or repair commits (v5 §3.6), and nothing
   * in code or copy may claim it does.
   */
  const mutationStateRef = useRef(0)
  const [mutationPending, setMutationPending] = useState(false)
  /**
   * One cast check's add/remove point: the ref first (gate authority), then the
   * render mirror — the same two writes, so they cannot disagree on the render
   * that follows. Removing an absent column, or re-adding a present one, is a
   * no-op (no pointless render).
   */
  const markCastPending = useCallback((column: string, pending: boolean): void => {
    if (castPendingColumnsRef.current.has(column) === pending) return
    const next = new Set(castPendingColumnsRef.current)
    if (pending) next.add(column)
    else next.delete(column)
    castPendingColumnsRef.current = next
    setCastPendingColumns(next)
  }, [])

  /**
   * The effective overlay state at the history cursor. Pure fold — after
   * undoing every edit it equals the initial state, so the grid is clean
   * again (the e2e "undo → clean" pin).
   */
  const overlayState = useMemo(
    () => (phase.kind === 'ready' ? stateAtCursor(phase.base, history) : null),
    [phase, history],
  )

  /**
   * Publish one history as the active overlay. `overlayRef` is updated
   * synchronously (the provider is read during `refresh()`), then React state
   * re-renders and the revision bump makes the inspector re-read.
   */
  const activateHistory = useCallback(
    (next: TransformationHistory): void => {
      if (phase.kind !== 'ready') return
      historyRef.current = next
      // Bump before publishing: the cast guard reads this ref synchronously at
      // both snapshot and append time, so any activation between them is seen.
      historyRevision.current += 1
      overlayRef.current = overlaySnapshot(phase.base, next)
      setHistory(next)
      setOverlayRevision((revision) => revision + 1)
    },
    [phase],
  )

  /**
   * The mutation chain (R1-C fix round): one promise tail that every
   * history-changing gesture appends its task to.
   *
   * Why it exists: a `cell-set` must get its engine verdict and then activate
   * *atomically*. Without serialization another gesture could activate between
   * the verdict and `setActive`, which either invalidates the verdict (the bug
   * this row fixes) or, worse, made the previous design "commit unchecked" after
   * a bounded number of invalidations — a reachable path that activated a staged
   * value with no verdict at all. Serializing removes the interleaving instead of
   * bounding it: there is no retry and no fallback left to get wrong.
   *
   * The chain owns every gesture that can change the history or its activation
   * order — cell-set / insert / delete / rename (via `applyOp`), undo, redo, the
   * selective cursor move, and the cast flow's append (via `appendAndCommit`).
   * `retryView` deliberately does not enqueue: it re-materializes the *already
   * active* overlay after an engine outage, changing neither the history nor its
   * order, and it must not wait behind a burst of edits the user just made.
   *
   * A task reads `historyRef.current` when it runs (not when the gesture fired),
   * so a burst applies in order with no lost update. Each task is skipped when
   * the dataset was replaced after the gesture; a rejection is caught so a
   * failed task can never wedge the chain.
   */
  const mutationChain = useRef<Promise<void>>(Promise.resolve())
  const enqueue = useCallback(
    (task: (token: number) => Promise<void>): void => {
      const token = session.tokenRef.current
      const run = mutationChain.current
        .then(async () => {
          // A replaced dataset invalidates gestures that were still queued; the
          // session reset has already cleared the surface they would report on
          // (including this hook's cast-pending markers).
          if (session.tokenRef.current !== token) return
          await task(token)
        })
        .catch((error: unknown) => {
          // Every task reports its own outcome; this guard keeps the chain live
          // and makes an unexpected throw visible instead of swallowing it.
          showEditError(engineRejectionMessage(error))
        })
      mutationChain.current = run
    },
    [session, showEditError],
  )

  /**
   * Commit `history` as the active overlay and re-materialize it through a
   * fresh data epoch. An engine that rejects the new overlay (a bad typed
   * value) has the commit rolled back to `previous` and the previous effective
   * view re-materialized (`commitWithRollback`) before the engine's message is
   * surfaced as a text-only alert — a rejected value can never leave the grid
   * all-loading or require a manual Undo to recover.
   *
   * m4-4 fix round: the cast path no longer relies on a bounded post-commit
   * window probe (`verifyEffectiveView`, removed). Casts are checked *before*
   * they are appended via the engine's `overlayCastCheck` (see
   * `handleCastColumn`), which is the only honest point at which a
   * value-level conversion failure is knowable without risking a committed
   * broken grid.
   *
   * R1-C: a `cell-set` arrives with a `check` whose `validate` closure runs
   * inside `commitWithRollback` **before** anything is activated, so a value
   * the column's type cannot convert is refused while the previous view is
   * still on screen (nothing to roll back, nothing to refresh). The caller is
   * always a mutation-chain task, so no other activation can land between the
   * verdict and `setActive` — that is what makes "committed without a verdict"
   * unreachable.
   */
  const commitHistory = useCallback(
    async (
      next: TransformationHistory,
      previous: TransformationHistory,
      outcomeMessage: string | null = null,
      check?: CellValueCheck,
    ): Promise<void> => {
      if (phase.kind !== 'ready') return
      // S-A2-2: count the commit before its first await so the ready-state
      // gesture gate can refuse while it materializes (no time bound claimed).
      mutationStateRef.current += 1
      setMutationPending(true)
      try {
        const result = await commitWithRollback(previous, next, {
          setActive: activateHistory,
          refresh: () => phase.model.refresh(),
          ...(check === undefined ? {} : { validate: check.validate }),
        })
        if (check?.aborted() === true) {
          // The dataset was replaced while the check ran: nothing was activated,
          // no refresh ran, no rollback happened, and the reset already cleared
          // the alert surface — reporting a stale edit error would be a lie.
          return
        }
        // An honest non-applied outcome (a no-op entry) must survive a
        // successful commit; an engine rejection message wins if present.
        showEditError(result.message ?? outcomeMessage)
        setViewError(result.restoreFailed)
        // q-3: announce a clean commit. `showEditError` already announced any
        // rejection/no-op message; only a fully applied edit reaches here silent.
        if (result.message === null && outcomeMessage === null) {
          announceEdit('Edit committed.')
        }
      } finally {
        mutationStateRef.current -= 1
        // Written in the same two places as the ref so the mirror can never
        // disagree on the render that follows settlement.
        setMutationPending(mutationStateRef.current > 0)
      }
    },
    [phase, activateHistory, showEditError, announceEdit],
  )

  /**
   * The pre-activation value check for one `cell-set` (R1-C).
   *
   * The engine's commit-time `refresh()` only reads metadata (`schema()` and
   * `rowCount()`), which never evaluates an edited value — under a bundle that
   * reports real engine messages such an edit therefore *commits*, and the
   * conversion failure only surfaces later as retryable `!` cells with no
   * message (the R1-A finding). This restores deterministic refusal at the
   * only point where it is knowable without risking a committed broken grid:
   * the engine's existing `overlayCastCheck` over the **prospective** overlay,
   * asked whether the edited column's own effective type rejects any value.
   *
   * `initialCatalog`-free and value-free: the question is a boolean about one
   * column and the refusal text is the shared `COLUMN_TYPE_REJECTED_SUMMARY`,
   * so a hostile cell value can neither reach the alert nor the log (ADR 0025).
   * A rejected check (unknown column, engine failure) is *not* swallowed — it
   * propagates and `commitWithRollback` frames it with the existing wording. The
   * one exception is a rejection that arrives after the dataset was replaced: it
   * describes a table that no longer exists, so the abort marker suppresses it
   * (mirroring the cast path's token guard; pinned by the reject-path sibling of
   * the stale-token test).
   *
   * `markCastPending` is deliberately not used: that gesture gate is
   * cast-specific (it disables a column's Rename/Cast controls while a cast
   * pre-check runs) and a cell commit is already counted by
   * `mutationStateRef`, so a cell edit must not disable the cast affordances.
   */
  const buildCellCheck = useCallback(
    (
      op: Extract<EditOp, { kind: 'cell-set' }>,
      prospective: TransformationHistory,
    ): CellValueCheck => {
      const token = session.tokenRef.current
      // Narrow once, outside the closure: `appendAndCommit` only builds a check
      // for a ready phase, and this keeps the async body total.
      const ready = phase.kind === 'ready' ? phase : null
      let aborted = false
      const validate = async (): Promise<void> => {
        if (ready === null) return
        aborted = false
        // The edited column's **effective** type, read from the domain's fold of
        // the prospective history (`stateAtCursor` is `foldOverlay` over the
        // active prefix — the same fold the grid renders). Never a host-side
        // type guess, and never the base metadata alone: a pending cast on the
        // column changes the type the committed view applies.
        const columns = foldOverlay(ready.base, activeOps(prospective)).state.columns
        const effectiveType = columns.find((column) => column.name === op.column)?.type
        if (effectiveType === undefined) {
          // `appendOp` resolved this column, so this is an invariant breach;
          // the client's own unknown-column rejection is the honest text for
          // it and no SQL is composed either way.
          throw new Error(`unknown overlay column: ${op.column}`)
        }
        // Mirror the cast path's staleness rule on BOTH outcomes: a rejection
        // after the dataset was replaced describes a table that no longer
        // exists, so the abort marker suppresses the message (nothing was
        // activated either way). Without the token change the rejection is kept
        // verbatim and framed by `commitWithRollback` — a genuine engine failure
        // is never swallowed.
        let check: { readonly hasNonConvertibleValues: boolean }
        try {
          check = await engineClient.overlayCastCheck(
            ready.handle,
            overlaySnapshot(ready.base, prospective),
            { column: op.column, targetType: effectiveType },
          )
        } catch (error) {
          if (session.tokenRef.current !== token) aborted = true
          throw error
        }
        // Staleness discipline: the check spanned an await, so a dataset
        // replacement during it drops the intent entirely. The chain already
        // serializes every same-table activation, so a *same-table* change can
        // never race this verdict — that is why there is no revision guard, no
        // retry and no unchecked fallback here.
        if (session.tokenRef.current !== token) {
          aborted = true
          throw new Error('the table changed while the edit was being checked')
        }
        if (check.hasNonConvertibleValues) {
          // Value-free by construction: the shared summary, never the value.
          throw new Error(COLUMN_TYPE_REJECTED_SUMMARY)
        }
      }
      return { validate, aborted: () => aborted }
    },
    [phase, session],
  )

  /**
   * Append the op to the **live** history and commit it. This is the only path
   * that appends and activates, and it is only ever called from inside a
   * mutation-chain task (never from a gesture handler): the cast flow calls it
   * directly after its own check, which is exactly why the chain can never
   * deadlock on a nested enqueue.
   *
   * Reading `historyRef.current` here (when the task runs, not when the gesture
   * fired) is what makes a burst of edits compose in order instead of each one
   * being derived from the same stale prefix.
   *
   * R1-C: an applied `cell-set` carries a pre-activation value check, so a value
   * the column's type cannot convert is refused before anything is activated.
   * Conflicts/no-ops need none (no new value reaches the view), and `row-insert`
   * stays uncovered because a v1 insert carries empty values — every later
   * cell-set on it is checked here like any other edit. Undo/redo and the
   * selective cursor move do not re-check: they re-activate a state whose cell
   * values already passed this check when they were staged, and a later cast
   * that could invalidate one is itself checked before it appends.
   */
  const appendAndCommit = useCallback(
    async (op: EditOp): Promise<void> => {
      if (phase.kind !== 'ready') return
      const current = historyRef.current
      const result = appendOp(phase.base, current, op)
      // Surface the typed outcome honestly (null for `applied`); a conflicted
      // op changes no state and is not logged (m4-1 `appendOp`). No-op entries
      // *are* logged and keep their message through the commit.
      const outcomeMessage = editOutcomeMessage(result.outcome)
      if (result.entry === null) {
        showEditError(outcomeMessage)
        return
      }
      const check =
        op.kind === 'cell-set' && result.outcome.status === 'applied'
          ? buildCellCheck(op, result.history)
          : undefined
      await commitHistory(result.history, current, outcomeMessage, check)
    },
    [phase, commitHistory, showEditError, buildCellCheck],
  )

  /** Queue one op for the mutation chain (every gesture goes through here). */
  const applyOp = useCallback(
    (op: EditOp) => {
      enqueue(async () => {
        await appendAndCommit(op)
      })
    },
    [enqueue, appendAndCommit],
  )

  const handleUndo = useCallback(() => {
    enqueue(async () => {
      const current = historyRef.current
      const step = undoHistory(current)
      if (step.entry === null) return
      setEditError(null)
      await commitHistory(step.history, current)
    })
  }, [enqueue, commitHistory])

  const handleRedo = useCallback(() => {
    // Same queued/live-history pattern as undo (see handleUndo).
    enqueue(async () => {
      const current = historyRef.current
      const step = redoHistory(current)
      if (step.entry === null) return
      setEditError(null)
      await commitHistory(step.history, current)
    })
  }, [enqueue, commitHistory])

  /**
   * Insert a row. v1 placement ruling: append at the end (`{'end'}`) — the
   * simplest honest placement the domain supports, and the one whose position
   * stays unambiguous under re-sort/re-filter. Anchored insert-before/after
   * placement is a possible m4-4+ affordance; the domain already handles it.
   */
  const handleInsertRow = useCallback(() => {
    enqueue(async () => {
      if (phase.kind !== 'ready') return
      // Read the folded state of the LIVE history: the row id's insert sequence
      // must be taken after every earlier queued gesture has landed.
      const current = stateAtCursor(phase.base, historyRef.current)
      const rowId = insertRowId(phase.base.overlayAnchor, current.nextInsertSeq)
      await appendAndCommit({
        kind: 'row-insert',
        rowId,
        position: { kind: 'end' },
        values: new Map(),
      })
    })
  }, [phase, enqueue, appendAndCommit])

  const handleCommitCell = useCallback(
    (rowId: RowId, column: string, value: CellValue) => {
      applyOp({ kind: 'cell-set', rowId, column, value })
    },
    [applyOp],
  )

  const handleDeleteRow = useCallback(
    (rowId: RowId) => {
      applyOp({ kind: 'row-delete', rowId })
    },
    [applyOp],
  )

  /**
   * m4-4 column ops. Rename emits its intent through the same `applyOp` path
   * as every other edit, so the domain owns conflict/no-op semantics (a
   * rename collision surfaces as typed text and leaves state unchanged).
   *
   * Cast is **validate-before-commit**: before appending the op, the engine's
   * `overlayCastCheck` runs over the current (pre-cast) overlay and reports
   * whether any non-NULL value cannot convert to the target type. A partial
   * post-commit window probe was proven false (a bad value past row 0 could
   * commit and brick the grid), so the check is the *only* place a
   * value-level cast failure is knowable — the failed cast is never appended
   * and the grid is never touched. The engine check's own rejection (unknown
   * column, engine error) is surfaced as readable text and likewise appends
   * nothing. Non-cast engine failures still use the m4-3 rollback path.
   *
   * The check spans an `await`, so its result is only trustworthy if the
   * effective history did not change while it ran: the pre-cast snapshot is
   * tagged with `historyRevision`, and a mismatch at append time re-runs the
   * check against the new state (bounded) instead of appending a stale
   * verdict — covering cell edits, insert/delete, undo/redo and table
   * switches, not just table switches.
   */
  const handleRenameColumn = useCallback(
    (from: string, to: string) => {
      applyOp({ kind: 'column-rename', from, to })
    },
    [applyOp],
  )

  const handleCastColumn = useCallback(
    (column: string, targetType: string) => {
      if (phase.kind !== 'ready') return
      const sessionId = session.tokenRef.current
      // S-A2-4: add THIS column before the first await; the aggregate set (not
      // a single value) is what the gesture gate reads.
      markCastPending(column, true)
      void (async () => {
        try {
          for (let attempt = 0; attempt < MAX_CAST_CHECK_ATTEMPTS; attempt++) {
            // Capture the history revision *and* the exact snapshot the check
            // will validate. They are read together (no await between), so a
            // change after this point is unambiguously a concurrent edit.
            const revision = historyRevision.current
            const preCast = overlaySnapshot(phase.base, historyRef.current)
            let check: { readonly hasNonConvertibleValues: boolean }
            try {
              check = await engineClient.overlayCastCheck(phase.handle, preCast, {
                column,
                targetType,
              })
            } catch (error) {
              if (session.tokenRef.current === sessionId) {
                showEditError(engineRejectionMessage(error))
              }
              return
            }
            // A table switch while the check was in flight invalidates the intent.
            if (session.tokenRef.current !== sessionId) return
            // A *same-table* history change also invalidates it: the check
            // described state that is no longer what the append would commit
            // over (the original silent-brick defect). Re-run against the new
            // state rather than appending a stale result.
            if (historyRevision.current !== revision) continue
            if (check.hasNonConvertibleValues) {
              showEditError(castRefusalMessage(column, targetType))
              return
            }
            // The verdict is only usable if the append commits over the state it
            // was taken against, so both halves go to the chain: the task
            // re-verifies `historyRevision` when it runs (a commit already in
            // flight can land while this append waits) and refuses with the
            // existing raced-cast copy instead of appending a verdict that no
            // longer describes the view. The append runs inside the chain task
            // via `appendAndCommit`, never via `applyOp`, so it cannot enqueue a
            // second time and deadlock.
            enqueue(async () => {
              if (historyRevision.current !== revision) {
                showEditError(castRacedMessage(column, targetType))
                return
              }
              await appendAndCommit({ kind: 'column-cast', column, targetType })
            })
            return
          }
          // Every attempt was invalidated by a concurrent change; refuse
          // honestly rather than append a result we could never trust.
          if (session.tokenRef.current === sessionId) {
            showEditError(castRacedMessage(column, targetType))
          }
        } finally {
          // Remove only this column: another column's check may still be in
          // flight, and the aggregate must stay non-empty until the LAST one
          // clears (N17).
          markCastPending(column, false)
        }
      })()
    },
    [phase, enqueue, appendAndCommit, showEditError, session, markCastPending],
  )

  /**
   * m4-4 selective undo: move the public cursor (clamped) and refold through
   * the normal commit path. `stateAtCursor` re-folds the prefix, so the
   * resulting grid is consistent by construction — no partial application.
   *
   * R1-C: the gesture is queued like every other history change and reads the
   * live history when it runs, so a cursor move issued while a cell check is in
   * flight waits for that verdict instead of racing it.
   */
  const handleSelectCursor = useCallback(
    (nextCursor: number) => {
      enqueue(async () => {
        const current = historyRef.current
        const clamped = Math.max(0, Math.min(current.entries.length, nextCursor))
        if (clamped === current.cursor) return
        setEditError(null)
        await commitHistory({ ...current, cursor: clamped }, current)
      })
    },
    [enqueue, commitHistory],
  )

  /**
   * EW-04I: the repair plan's capture tag, read from the live refs (`historyRef`
   * + `historyRevision`) so a preview's tag and the publication-time check are
   * the same measurement. Pure: no engine call, no state change.
   */
  const captureRepairTag = useCallback(
    (column: string): RepairCaptureTag | null => {
      if (phase.kind !== 'ready') return null
      return repairCaptureTag(
        phase.base,
        historyRef.current,
        stateAtCursor(phase.base, historyRef.current),
        historyRevision.current,
        column,
      )
    },
    [phase],
  )

  /**
   * EW-04I: publish one repair plan.
   *
   * Queued on the mutation chain like every other history change, so the
   * verdicts below and the append/activation happen with no other activation
   * in between (the `cell-set`/cast discipline). Three refusals run BEFORE
   * `appendAndCommit`, which is what makes each of them observable as "no
   * entry was appended":
   *
   * 1. **Stale preview (U2).** The guard's tag must still describe the live
   *    session — anchors, cursor, history revision, column type, schema
   *    signature. Any edit, undo, redo, cursor jump, rename/cast or dataset
   *    replacement between preview and Apply refuses here with the authored
   *    stale sentence; the plan is not appended and the view is untouched.
   * 2. **Zero affected (U1/D8).** The preview's complete count is the
   *    authority: a plan that changes no row is refused, never appended as a
   *    no-op entry (the dirty predicate and the history panel would both lie
   *    about a repair that did nothing).
   * 3. **Repeat Apply (D7).** The identical plan already applied at this
   *    cursor is refused by plan identity.
   */
  const handleApplyRepair = useCallback(
    (plan: RepairPlan, guard: RepairApplyGuard): void => {
      enqueue(async () => {
        if (phase.kind !== 'ready') return
        const current = historyRef.current
        const liveTag = repairCaptureTag(
          phase.base,
          current,
          stateAtCursor(phase.base, current),
          historyRevision.current,
          plan.column,
        )
        if (liveTag === null || captureIsStale(guard.tag, liveTag)) {
          showEditError(REPAIR_PREVIEW_STALE)
          return
        }
        if (guard.affected <= 0) {
          showEditError(REPAIR_REFUSAL_ZERO_AFFECTED)
          return
        }
        if (repairPlanIsActive(current, repairPlanFingerprint(plan))) {
          showEditError(REPAIR_REFUSAL_ALREADY_ACTIVE)
          return
        }
        await appendAndCommit(repairPlanOp(plan))
      })
    },
    [phase, enqueue, showEditError, appendAndCommit],
  )

  /**
   * m4-4 double-failure recovery: re-attempt the previous view after an
   * engine outage. Success clears the honest view error; failure surfaces the
   * new error and keeps the retry affordance.
   */
  const retryView = useCallback(async () => {
    if (phase.kind !== 'ready') return
    try {
      await phase.model.refresh()
      setViewError(false)
      setEditError(null)
    } catch (error) {
      showEditError(engineRejectionMessage(error))
    }
  }, [phase, showEditError])

  /**
   * m4-5 export effects. `runExport` materializes the **active** overlay
   * snapshot (base + ops at the history cursor) through the engine's merged
   * export op — never the source path, never the base view alone (ADR 0012).
   * `overlayRef` is the synchronous source the grid already reads, so the
   * exported copy is exactly the view on screen.
   */
  const runExport = useCallback(
    (format: EngineExportFormat): Promise<EngineExportResult> => {
      if (phase.kind !== 'ready') {
        return Promise.reject(new Error('no table is open'))
      }
      const overlay = overlayRef.current ?? overlaySnapshot(phase.base, historyRef.current)
      return engineClient.exportView(phase.handle, { format, overlay })
    },
    [phase, overlayRef, historyRef],
  )

  const requestExportDestination = useCallback(
    (format: EngineExportFormat) =>
      requestSaveDestination(format, {
        // Undefined before the first open and for opens without a retained
        // FSA handle — the latter is what keeps input-fallback sessions on
        // the download-only delivery path (m4-5 fix round 2).
        sourceIdentity: sourceIdentityRef.current ?? undefined,
      }),
    [sourceIdentityRef],
  )

  const deliverExportCopy = useCallback(
    (destination: WritableSaveDestination, result: EngineExportResult): Promise<SaveStrategy> =>
      writeExportCopy(destination, result),
    [],
  )

  /**
   * New-dataset reset: clear the error/announcement surface, drop the
   * previous history, null the overlay, and bump `historyRevision` so an
   * in-flight cast check is invalidated synchronously (the session token is
   * bumped before any reset by `beginSession`).
   */
  const reset = useCallback(() => {
    setEditError(null)
    setViewError(false)
    castPendingColumnsRef.current = EMPTY_CAST_PENDING
    setCastPendingColumns(EMPTY_CAST_PENDING)
    mutationStateRef.current = 0
    setMutationPending(false)
    historyRevision.current += 1
    overlayRef.current = null
    const resetHistory = emptyHistory()
    historyRef.current = resetHistory
    setHistory(resetHistory)
    setOverlayRevision(0)
  }, [])
  useEffect(() => session.registerReset(reset), [session, reset])

  return {
    history,
    overlayState,
    overlayRevision,
    editError,
    editAnnouncement,
    viewError,
    castPendingColumns,
    castPendingColumnsRef,
    castPendingCount: castPendingColumns.size,
    mutationStateRef,
    mutationPending,
    historyRef,
    overlayRef,
    announceEdit,
    runExport,
    requestExportDestination,
    deliverExportCopy,
    handleUndo,
    handleRedo,
    handleInsertRow,
    handleCommitCell,
    handleDeleteRow,
    handleRenameColumn,
    handleCastColumn,
    handleSelectCursor,
    captureRepairTag,
    handleApplyRepair,
    retryView,
  }
}
