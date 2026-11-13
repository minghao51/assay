// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CellValue, EditOp, RowId, TransformationHistory } from '@assay/domain'
import {
  appendOp,
  emptyHistory,
  insertRowId,
  redo as redoHistory,
  stateAtCursor,
  undo as undoHistory,
} from '@assay/domain'
import type { EngineExportFormat, EngineExportResult, EngineOverlay } from '@assay/engine-duckdb'
import {
  castRacedMessage,
  castRefusalMessage,
  commitWithRollback,
  editOutcomeMessage,
  engineRejectionMessage,
  overlaySnapshot,
} from '../edit/session'
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
 */
const MAX_CAST_CHECK_ATTEMPTS = 3

/** The empty aggregate cast-pending set (shared; never mutated in place). */
const EMPTY_CAST_PENDING: ReadonlySet<string> = new Set<string>()

/** q-3: one polite announcement; `seq` keeps repeated identical text firing. */
interface EditAnnouncement {
  readonly text: string
  readonly seq: number
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
   * WF-06 (S-A2-2): commits currently materializing, counted — not a boolean,
   * because two commits can overlap (`applyOp` appends on the live history).
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
   * Synchronous mirror of `history`. Cell/rename ops run synchronously against
   * the latest value; the cast path `await`s the engine's pre-commit check, so
   * reading this ref at append time prevents a stale closure from dropping an
   * edit made while the check was in flight.
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
   * broken grid. Other value failures (cell edits, schema materialization)
   * still reject on the refresh below and roll back here.
   */
  const commitHistory = useCallback(
    async (
      next: TransformationHistory,
      previous: TransformationHistory,
      outcomeMessage: string | null = null,
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
        })
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

  const applyOp = useCallback(
    (op: EditOp) => {
      if (phase.kind !== 'ready') return
      // Read the live history (not a possibly stale closure): the cast path
      // awaits an engine check before calling this.
      const current = historyRef.current
      const result = appendOp(phase.base, current, op)
      // Surface the typed outcome honestly (null for `applied`); a conflicted
      // op changes no state and is not logged (m4-1 `appendOp`). No-op entries
      // *are* logged and keep their message through the commit.
      const outcomeMessage = editOutcomeMessage(result.outcome)
      if (result.entry !== null) {
        void commitHistory(result.history, current, outcomeMessage)
      } else {
        showEditError(outcomeMessage)
      }
    },
    [phase, commitHistory, showEditError],
  )

  const handleUndo = useCallback(() => {
    const current = historyRef.current
    const step = undoHistory(current)
    if (step.entry === null) return
    setEditError(null)
    void commitHistory(step.history, current)
  }, [commitHistory])

  const handleRedo = useCallback(() => {
    // Same ref pattern as undo (see handleUndo).
    const current = historyRef.current
    const step = redoHistory(current)
    if (step.entry === null) return
    setEditError(null)
    void commitHistory(step.history, current)
  }, [commitHistory])

  /**
   * Insert a row. v1 placement ruling: append at the end (`{'end'}`) — the
   * simplest honest placement the domain supports, and the one whose position
   * stays unambiguous under re-sort/re-filter. Anchored insert-before/after
   * placement is a possible m4-4+ affordance; the domain already handles it.
   */
  const handleInsertRow = useCallback(() => {
    if (phase.kind !== 'ready') return
    const current = stateAtCursor(phase.base, history)
    const rowId = insertRowId(phase.base.overlayAnchor, current.nextInsertSeq)
    applyOp({ kind: 'row-insert', rowId, position: { kind: 'end' }, values: new Map() })
  }, [phase, history, applyOp])

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
            applyOp({ kind: 'column-cast', column, targetType })
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
    [phase, applyOp, showEditError, session, markCastPending],
  )

  /**
   * m4-4 selective undo: move the public cursor (clamped) and refold through
   * the normal commit path. `stateAtCursor` re-folds the prefix, so the
   * resulting grid is consistent by construction — no partial application.
   */
  const handleSelectCursor = useCallback(
    (nextCursor: number) => {
      if (phase.kind !== 'ready') return
      const clamped = Math.max(0, Math.min(history.entries.length, nextCursor))
      if (clamped === history.cursor) return
      setEditError(null)
      void commitHistory({ ...history, cursor: clamped }, history)
    },
    [phase, history, commitHistory],
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
    retryView,
  }
}
