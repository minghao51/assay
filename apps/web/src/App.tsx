import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { EngineTableHandle } from '@assay/engine-duckdb'
import { viewNameForTableId } from '@assay/engine-duckdb'
import type { CellValue, EditOp, OverlayBase, RowId, TransformationHistory } from '@assay/domain'
import {
  appendOp,
  emptyHistory,
  insertRowId,
  redo as redoHistory,
  stateAtCursor,
  undo as undoHistory,
} from '@assay/domain'
import { GridViewportModel } from '@assay/grid'
import { pickDataFile } from '@assay/data-sources/browser'
import { DataGrid } from './grid/DataGrid'
import { DuckDbGridProvider } from './grid/provider'
import { FilterBar } from './grid/FilterBar'
import { EditToolbar } from './edit/EditToolbar'
import { HistoryPanel } from './edit/HistoryPanel'
import {
  activeOps,
  commitWithRollback,
  editOutcomeMessage,
  engineRejectionMessage,
  overlaySnapshot,
} from './edit/session'
import { pendingChangesSummary } from './edit/op-summary'
import { createOverlayAnchor, fileVersionAnchor } from './edit/overlay-base'
import { APP_NAME, NEXT_MILESTONE, SCAFFOLD_STATUS, TAGLINE } from './lib/app'
import { engineClient } from './lib/engine'
import { ProfilePanel } from './profile/ProfilePanel'
import { RecordInspector } from './record/RecordInspector'
import type { RecordRequest } from './record/RecordInspector'
import { parseDuckDbType } from './schema/parseType'
import { SchemaPanel } from './schema/SchemaPanel'
import { composeNestedAction } from './sql/nested-actions'
import type { NestedAction } from './sql/nested-actions'
import { SqlPanel } from './sql/SqlPanel'
import type { SqlRunRequest } from './sql/SqlPanel'

/**
 * App phases. `ready` holds the composed grid: adapter (engine client) →
 * provider (`GridDataProvider`) → headless model → virtualized DOM renderer
 * (docs/architecture/02-architecture.md §8). Only the table id, row count,
 * and column count are shown — never the picked file's name (ADR 0025).
 *
 * m3-5: the ready phase also wires the one-click nested actions.
 *
 * m4-3: the ready phase also owns the editing session. The immutable
 * `OverlayBase` (host tokens + base schema + base row count) is built once
 * when a file opens; every edit is a typed `EditOp` appended to a
 * `TransformationHistory`, and the grid's provider reads the active overlay
 * snapshot (`stateAtCursor` prefix) per request. Undo/redo are cursor moves
 * on that history; the grid re-materializes via a fresh data epoch. The base
 * view is never mutated (ADR 0012), and no edit or cell value is logged
 * (ADR 0025).
 */
type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'opening' }
  | { readonly kind: 'error'; readonly message: string }
  | {
      readonly kind: 'ready'
      readonly model: GridViewportModel
      readonly tableId: string
      readonly handle: EngineTableHandle
      /** Immutable base metadata for the editing session (ADR 0011/0012). */
      readonly base: OverlayBase
      /** Overlay-aware provider; the commit path probes it for value failures (m4-4). */
      readonly provider: DuckDbGridProvider
    }

/**
 * Live summary line for the opened table (m2-3 row-count truth): the total
 * is read from the model — which re-reads it from the provider after every
 * accepted filter change and every overlay epoch.
 */
function LiveTableInfo({ model, tableId }: { model: GridViewportModel; tableId: string }) {
  useSyncExternalStore(model.subscribe, model.getVersion)
  return (
    <p data-testid="table-info">
      table <code data-testid="open-table-id">{tableId}</code> ·{' '}
      <span data-testid="grid-total-rows">{model.totalRows ?? 0}</span> rows ·{' '}
      <span data-testid="grid-column-count">{model.schema?.length ?? 0}</span> columns
    </p>
  )
}

/** Stable empty-schema constant for the pre-open phases (useMemo stability). */
const NO_COLUMNS: readonly { readonly name: string; readonly type: string }[] = []

export function App() {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  /**
   * m3-3 record inspector open gesture. App holds it so a row open survives
   * the grid's re-renders; `seq` makes every gesture distinct so re-opening
   * the SAME row re-fires the inspector's open effect. Cleared when a new
   * file is opened — a request must never leak across tables.
   */
  const [recordRequest, setRecordRequest] = useState<RecordRequest | null>(null)

  /**
   * m3-5 nested-action dispatch: both click surfaces (schema tree, grid
   * headers) emit a `NestedAction`; the app composes it through m3-4's pure
   * composer against the parsed schema and the SQL-facing view name, then
   * hands the SQL to the m2-4 pane via `sqlRequest`.
   */
  const [sqlRequest, setSqlRequest] = useState<SqlRunRequest | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const requestSeq = useRef(0)

  /**
   * m4-3 editing session. `history` is React state (pure refolds render it);
   * `overlayRef` mirrors the active snapshot synchronously so the provider
   * reads the new ops the moment a commit triggers `model.refresh()`, before
   * React has re-rendered. `overlayRevision` is the monotonic freshness
   * signal the record inspector consumes.
   */
  const [history, setHistory] = useState<TransformationHistory>(() => emptyHistory())
  const [overlayRevision, setOverlayRevision] = useState(0)
  const [editError, setEditError] = useState<string | null>(null)
  /**
   * m4-4 carry-over: true only when a commit was rejected *and* restoring the
   * previous view also failed. It renders a retry affordance so an engine
   * outage cannot leave an unattributed alert over a half-loaded grid.
   */
  const [viewError, setViewError] = useState(false)
  const overlayRef = useRef<ReturnType<typeof overlaySnapshot> | null>(null)

  const schemaColumns = phase.kind === 'ready' ? (phase.model.schema ?? []) : NO_COLUMNS
  const nestedSpecs = useMemo(
    () =>
      schemaColumns.map((column) => ({ name: column.name, type: parseDuckDbType(column.type) })),
    [schemaColumns],
  )
  const runNestedAction = useCallback(
    (action: NestedAction): void => {
      if (phase.kind !== 'ready') return
      const composed = composeNestedAction(viewNameForTableId(phase.tableId), nestedSpecs, action)
      if (!composed.ok) {
        setActionError(composed.reason)
        return
      }
      setActionError(null)
      requestSeq.current += 1
      setSqlRequest({ sql: composed.sql, seq: requestSeq.current })
    },
    [phase, nestedSpecs],
  )

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
      overlayRef.current = overlaySnapshot(phase.base, next)
      setHistory(next)
      setOverlayRevision((revision) => revision + 1)
    },
    [phase],
  )

  /**
   * Commit a new history and rebuild the grid's data epoch. An engine that
   * rejects the new overlay (a bad typed value) has the commit rolled back to
   * `previous` and the previous effective view re-materialized
   * (`commitWithRollback`) before the engine's message is surfaced as a
   * text-only alert — a rejected value can never leave the grid all-loading
   * or require a manual Undo to recover.
   */
  const commitHistory = useCallback(
    async (
      next: TransformationHistory,
      previous: TransformationHistory,
      outcomeMessage: string | null = null,
    ): Promise<void> => {
      if (phase.kind !== 'ready') return
      const result = await commitWithRollback(previous, next, {
        setActive: activateHistory,
        refresh: () => phase.model.refresh(),
        // Bounded value probe (m4-4): a cast whose values cannot convert
        // passes schema/count reads and only fails on a window read, so the
        // rollback path verifies values before declaring success.
        verify: () => phase.provider.verifyEffectiveView(),
      })
      // An honest non-applied outcome (a no-op entry) must survive a
      // successful commit; an engine rejection message wins if present.
      setEditError(result.message ?? outcomeMessage)
      setViewError(result.restoreFailed)
    },
    [phase, activateHistory],
  )

  const applyOp = useCallback(
    (op: EditOp) => {
      if (phase.kind !== 'ready') return
      const result = appendOp(phase.base, history, op)
      // Surface the typed outcome honestly (null for `applied`); a conflicted
      // op changes no state and is not logged (m4-1 `appendOp`). No-op entries
      // *are* logged and keep their message through the commit.
      const outcomeMessage = editOutcomeMessage(result.outcome)
      if (result.entry !== null) {
        void commitHistory(result.history, history, outcomeMessage)
      } else {
        setEditError(outcomeMessage)
      }
    },
    [phase, history, commitHistory],
  )

  const handleUndo = useCallback(() => {
    const step = undoHistory(history)
    if (step.entry === null) return
    setEditError(null)
    void commitHistory(step.history, history)
  }, [history, commitHistory])

  const handleRedo = useCallback(() => {
    const step = redoHistory(history)
    if (step.entry === null) return
    setEditError(null)
    void commitHistory(step.history, history)
  }, [history, commitHistory])

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
   * m4-4 column ops. Both emit the intent through the same `applyOp` path as
   * every other edit, so the domain owns conflict/no-op semantics (a rename
   * collision surfaces as typed text and leaves state unchanged) and the
   * commit rollback+alert path owns engine rejections (a cast the engine
   * cannot materialize).
   */
  const handleRenameColumn = useCallback(
    (from: string, to: string) => {
      applyOp({ kind: 'column-rename', from, to })
    },
    [applyOp],
  )

  const handleCastColumn = useCallback(
    (column: string, targetType: string) => {
      applyOp({ kind: 'column-cast', column, targetType })
    },
    [applyOp],
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
   * new message and keeps the retry affordance.
   */
  const retryView = useCallback(async () => {
    if (phase.kind !== 'ready') return
    try {
      await phase.model.refresh()
      await phase.provider.verifyEffectiveView()
      setViewError(false)
      setEditError(null)
    } catch (error) {
      setEditError(engineRejectionMessage(error))
    }
  }, [phase])

  const openDataFile = useCallback(async () => {
    setPhase({ kind: 'opening' })
    setRecordRequest(null)
    // m3-5 / m4-3: a new table invalidates the previous table's dispatch and
    // editing state — an overlay must never leak across files.
    setSqlRequest(null)
    setActionError(null)
    setEditError(null)
    setViewError(false)
    overlayRef.current = null
    setHistory(emptyHistory())
    setOverlayRevision(0)
    try {
      const picked = await pickDataFile()
      if (picked === null) {
        // User dismissed the picker — back to idle, nothing opened.
        setPhase({ kind: 'idle' })
        return
      }
      // BrowserFileSource exposes getFile() but not its input's name, and the
      // EngineFileSource seam needs the name for extension detection only.
      // Resolving the File here is a cheap reference (no dataset bytes read,
      // ADR 0001); the name is transported per protocol but never rendered or
      // logged (ADR 0025).
      const file = await picked.source.getFile()
      const handle = await engineClient.open({
        name: file.name,
        getFile: () => Promise.resolve(file),
      })
      // Base metadata for the editing session (ADR 0011/0012). The anchor is
      // the stable function of the file *version* (size + mtime) — re-opening
      // the same unchanged file keeps base row ids stable; the token is never
      // rendered or logged.
      const baseSchema = await engineClient.schema(handle)
      const baseRowCount = await engineClient.rowCount(handle)
      const base: OverlayBase = {
        baseAnchor: fileVersionAnchor({ size: file.size, lastModified: file.lastModified }),
        overlayAnchor: createOverlayAnchor(),
        columns: baseSchema.map((column) => ({ name: column.name, type: column.type })),
        baseRowCount,
      }
      const initialHistory = emptyHistory()
      overlayRef.current = overlaySnapshot(base, initialHistory)
      const provider = new DuckDbGridProvider(
        engineClient,
        handle,
        () => overlayRef.current ?? overlaySnapshot(base, initialHistory),
      )
      const model = new GridViewportModel(provider)
      await model.load()
      setPhase({ kind: 'ready', model, tableId: handle.id, handle, base, provider })
    } catch (error) {
      setPhase({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }, [])

  return (
    <main>
      <h1>{APP_NAME}</h1>
      <p>{TAGLINE}</p>

      <section data-testid="open-flow">
        <button
          type="button"
          data-testid="open-button"
          onClick={() => {
            void openDataFile()
          }}
          disabled={phase.kind === 'opening'}
        >
          Open a data file…
        </button>{' '}
        <span data-testid="open-status">{phase.kind}</span>
        {phase.kind === 'error' && (
          <p data-testid="open-error" role="alert">
            {phase.message}
          </p>
        )}
        {phase.kind === 'ready' && <LiveTableInfo model={phase.model} tableId={phase.tableId} />}
      </section>

      {phase.kind === 'ready' ? (
        <>
          {actionError !== null && (
            <p className="nested-action-error" role="alert" data-testid="nested-action-error">
              {actionError}
            </p>
          )}
          <SchemaPanel
            columns={schemaColumns}
            onAction={runNestedAction}
            onRenameColumn={handleRenameColumn}
            onCastColumn={handleCastColumn}
          />
          <EditToolbar
            canUndo={history.cursor > 0}
            canRedo={history.cursor < history.entries.length}
            onUndo={handleUndo}
            onRedo={handleRedo}
            onInsertRow={handleInsertRow}
            pendingSummary={pendingChangesSummary(activeOps(history))}
            error={editError}
          />
          {viewError && (
            <p className="edit-view-error" role="alert" data-testid="view-error">
              The grid could not be restored to a trustworthy view.{' '}
              <button
                type="button"
                data-testid="view-retry"
                onClick={() => {
                  void retryView()
                }}
              >
                Retry loading the view
              </button>
            </p>
          )}
          <HistoryPanel
            entries={history.entries}
            cursor={history.cursor}
            onSelectCursor={handleSelectCursor}
            onUndo={handleUndo}
            onRedo={handleRedo}
          />
          <FilterBar model={phase.model} />
          <DataGrid
            model={phase.model}
            overlayState={overlayState}
            onCommitCell={handleCommitCell}
            onDeleteRow={handleDeleteRow}
            onOpenRecord={(rowIndex) => {
              setRecordRequest((previous) => ({ rowIndex, seq: (previous?.seq ?? 0) + 1 }))
            }}
            onNestedAction={runNestedAction}
          />
          {/**
           * Placement (m3-3): directly under the grid it inspects. The app
           * composes single-column, full-width disclosure sections (schema →
           * editing → filters → grid → record → SQL → profile).
           */}
          <RecordInspector
            model={phase.model}
            request={recordRequest}
            overlayRevision={overlayRevision}
            onClosed={() => {
              setRecordRequest(null)
            }}
          />
          <SqlPanel tableId={phase.tableId} runRequest={sqlRequest} />
          <ProfilePanel handle={phase.handle} />
        </>
      ) : (
        <>
          <p>{SCAFFOLD_STATUS}</p>
          <p>
            Next: <strong>{NEXT_MILESTONE}</strong>
          </p>
          <p>
            Documentation lives in <code>docs/</code> — start with{' '}
            <code>docs/process/handoff.md</code>.
          </p>
        </>
      )}
    </main>
  )
}
