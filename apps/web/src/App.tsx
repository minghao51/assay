// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { viewNameForTableId } from '@assay/engine-duckdb'
import type { OverlayBase } from '@assay/domain'
import { emptyHistory, liveRowCount, stateAtCursor } from '@assay/domain'
import { GridViewportModel } from '@assay/grid'
import type { ColumnSchema } from '@assay/grid'
import { pickDataFile } from '@assay/data-sources/browser'
import { DataGrid } from './grid/DataGrid'
import { DuckDbGridProvider } from './grid/provider'
import { ErrorBoundary } from './ErrorBoundary'
import { FilterBar } from './grid/FilterBar'
import { EditToolbar } from './edit/EditToolbar'
import { ExportDialog } from './export/ExportDialog'
import type { SourceIdentity } from './export/save-destination'
import { HistoryPanel } from './edit/HistoryPanel'
import { activeOps, overlaySnapshot } from './edit/session'
import { pendingChangesSummary } from './edit/op-summary'
import { createOverlayAnchor, fileVersionAnchor } from './edit/overlay-base'
import { APP_NAME, NEXT_MILESTONE, SCAFFOLD_STATUS, TAGLINE } from './lib/app'
import { preloadBottomPanels } from './lib/bottom-panels'
import type { BottomPanelModules } from './lib/bottom-panels'
import { engineClient } from './lib/engine'
import { NO_COLUMNS, useModelSlice } from './lib/use-model-slice'
import { RecordInspector } from './record/RecordInspector'
import type { RecordRequest } from './record/RecordInspector'
import { parseDuckDbType } from './schema/parseType'
import { SchemaPanel } from './schema/SchemaPanel'
import { composeNestedAction } from './sql/nested-actions'
import type { NestedAction } from './sql/nested-actions'
import type { SqlRunRequest } from './sql/SqlPanel'
import { writeReportCopy } from './validation/report-export'
import { writeDiffReportCopy } from './diff/diff-export'
import { useDatasetSession } from './sessions/session-reset'
import { useEditingSession } from './sessions/useEditingSession'
import { useValidationSession } from './sessions/useValidationSession'
import { useDiffSession } from './sessions/useDiffSession'
import type { Phase, ScrollRequest } from './sessions/types'

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

/**
 * f-2: reuse the previous effective-schema array when its content is
 * unchanged. `model.refresh()` re-reads the schema on every edit commit and
 * `DuckDbGridProvider.schema()` projects a fresh array each time even when
 * the columns are identical, which would make the `columns` prop unstable
 * across an edit and defeat `React.memo` on the schema panel. Rename/cast
 * are the only edits that change the schema, and they change this signature
 * (name/type/nullable), so the reused reference is always the current
 * schema. Ref-in-render is the q-1 `use-model-slice` cache pattern (not a
 * side effect the panels can observe).
 */
function useStableColumns(columns: readonly ColumnSchema[]): readonly ColumnSchema[] {
  const ref = useRef(columns)
  const signature = columns
    .map((column) => `${column.name}\t${column.type}\t${String(column.nullable)}`)
    .join('\u0000')
  const signatureRef = useRef(signature)
  if (signatureRef.current !== signature) {
    signatureRef.current = signature
    ref.current = columns
  }
  return ref.current
}

/**
 * f-2: memoized panel boundaries for the ready phase. App re-renders on
 * every editing-session state change (history, overlay revision, announced
 * outcome) and on every `model.refresh()` notification; the schema panel and
 * the record inspector receive only references that are stable across those
 * changes (the value-stable schema slice above plus `useCallback` handlers),
 * so `memo` lets React skip their subtrees. The record inspector deliberately
 * consumes `overlayRevision` and therefore does re-render on an edit — that
 * is the freshness signal, not a leak. Validation/Diff are memoized at their
 * lazy-module seam in `lib/bottom-panels.ts` (the chunk-resolution point).
 */
const MemoSchemaPanel = memo(SchemaPanel)
const MemoRecordInspector = memo(RecordInspector)

export function App() {
  /**
   * f-1: dataset-session epoch + reset registry. `beginSession` bumps the
   * shared token and runs every per-domain reset, so `openDataFile` no longer
   * hand-nulls each session slot. See `sessions/session-reset.ts` for the
   * token/ordering rationale.
   */
  const datasetSession = useDatasetSession()

  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  /**
   * m3-3 record inspector open gesture. App holds it so a row open survives
   * the grid's re-renders; `seq` makes every gesture distinct so re-opening
   * the SAME row re-fires the inspector's open effect. Cleared when a new
   * file is opened — a request must never leak across tables.
   */
  const [recordRequest, setRecordRequest] = useState<RecordRequest | null>(null)
  /**
   * m4-5 export dialog visibility. Closing unmounts the dialog, so its format
   * choice and result reset on every open (no stale "Exported…" line from a
   * previous session). The dialog itself never touches the base source
   * (ADR 0012).
   */
  const [exportOpen, setExportOpen] = useState(false)

  /**
   * Identity of the opened source, retained from the open flow for the
   * export same-source guard (m4-5 fix round): the save picker can return
   * the opened file's own entry, and writing the export there would replace
   * the source. `requestExportDestination` threads this into
   * `requestSaveDestination`, which refuses such a destination before any
   * engine work or byte write. Only FSA opens retain an identity (the
   * handle's authoritative `isSameEntry`); an open without a retained
   * handle keeps this null — identity cannot be proven, so that session is
   * never offered a direct-write destination at all (m4-5 fix round 2).
   * Null until a file is open (and briefly during each open attempt). Never
   * rendered or logged (ADR 0025).
   */
  const sourceIdentityRef = useRef<SourceIdentity | null>(null)

  /**
   * m3-5 nested-action dispatch: both click surfaces (schema tree, grid
   * headers) emit a `NestedAction`; the app composes it through m3-4's pure
   * composer against the parsed schema and the SQL-facing view name, then
   * hands the SQL to the m2-4 pane via `sqlRequest`.
   */ const [sqlRequest, setSqlRequest] = useState<SqlRunRequest | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const requestSeq = useRef(0)

  /**
   * m5-3/m6-4 jump-to-row gesture. Owned by the composition root because the
   * validation and diff panels share it: both resolve a logical row key, then
   * scroll the grid and open the record inspector through `navigateToRow`.
   */
  const [scrollRequest, setScrollRequest] = useState<ScrollRequest | null>(null)
  const scrollSeq = useRef(0)
  const navigateToRow = useCallback((rowIndex: number) => {
    scrollSeq.current += 1
    setScrollRequest({ rowIndex, seq: scrollSeq.current })
    setRecordRequest((previous) => ({
      rowIndex,
      seq: (previous?.seq ?? 0) + 1,
    }))
  }, [])

  /**
   * m4-3 editing session (f-1 extraction). Owns the overlay history, its
   * synchronous mirror refs, the cast race guard, and the export/diff/
   * validation consumers' view of the active overlay.
   */
  const {
    history,
    overlayState,
    overlayRevision,
    editError,
    editAnnouncement,
    viewError,
    castPendingColumn,
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
  } = useEditingSession(phase, datasetSession, sourceIdentityRef)

  /**
   * m5-3 validation session (f-1 extraction): contract import, verdict run
   * state machine, freshness banner, and jump/filter controls.
   */
  const {
    contractState,
    validationRun,
    jumpError,
    filterToFailuresError,
    validationStale,
    handleContractFile,
    handleValidate,
    handleCancelValidate,
    handleJumpToSample,
    handleFilterToFailures,
    requestReportDestinationForPanel,
  } = useValidationSession({
    phase,
    session: datasetSession,
    historyRef,
    overlayRef,
    overlayRevision,
    sourceIdentityRef,
    navigateToRow,
  })

  /**
   * m6-4 comparison session (f-1 extraction): staged comparison, row-diff run
   * state machine, freshness banner, and jump/report controls.
   */
  const {
    comparisonState,
    diffRun,
    diffJumpError,
    diffStale,
    handleComparisonFile,
    handleRunDiff,
    handleCancelDiff,
    handleJumpToDiffSample,
    requestDiffReportDestinationForPanel,
  } = useDiffSession({
    phase,
    session: datasetSession,
    historyRef,
    overlayRef,
    overlayRevision,
    sourceIdentityRef,
    navigateToRow,
  })

  /**
   * au3-12: resolved below-fold panel components (see `lib/bottom-panels.ts`
   * for why these live in state instead of `React.lazy`). `null` before the
   * first open completes; published before the `ready` render.
   */
  const [panelModules, setPanelModules] = useState<BottomPanelModules | null>(null)

  /**
   * AR-W5: release the engine (every registered view + file handle) when the
   * tab goes away. `dispose()` is the only release op the current client
   * exposes and is terminal + idempotent; the ref makes repeated unload
   * events (`beforeunload` + `pagehide`) request it exactly once. The
   * comparison B-side transient open stays the recorded PT-H carry-over —
   * the client has no `closeTable`/`profileComparison` op, so it cannot be
   * released per-action without an engine change (boundary rule §7.4).
   */
  const disposeRequested = useRef(false)
  useEffect(() => {
    const disposeEngine = (): void => {
      if (disposeRequested.current) return
      disposeRequested.current = true
      void engineClient.dispose()
    }
    window.addEventListener('beforeunload', disposeEngine)
    window.addEventListener('pagehide', disposeEngine)
    return () => {
      window.removeEventListener('beforeunload', disposeEngine)
      window.removeEventListener('pagehide', disposeEngine)
    }
  }, [])

  /**
   * Subscribe to the model slices App renders from so schema re-keys after a
   * rename/cast re-render the panel (and the nested-action specs). `DataGrid`/
   * `LiveTableInfo` already subscribe to the full model for row data;
   * `schemaColumns` is derived from `model.schema`, which `refresh()` replaces
   * asynchronously, so without a subscription App never re-rendered and the
   * panel kept the pre-rename names/types. The slice snapshot (q-1) keeps App
   * from re-rendering on every viewport fetch notify.
   */
  const activeModel = phase.kind === 'ready' ? phase.model : null
  const { schema: modelSchema, sort: modelSort, filters: modelFilters } = useModelSlice(activeModel)

  const schemaColumns = useStableColumns(modelSchema ?? NO_COLUMNS)
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

  const handleRecordClosed = useCallback(() => {
    setRecordRequest(null)
  }, [])

  const openDataFile = useCallback(async () => {
    // AR-W13: generation guard. `beginSession` bumps the shared session token
    // and runs every per-domain reset (f-1), so a picker/open chain that
    // resolves after a newer open (or any newer phase transition) is discarded
    // rather than clobbering the newer phase.
    const session = datasetSession.beginSession()
    // au3-12: warm the below-fold panel chunks in parallel with the open flow
    // so they are resident by `ready` (see `lib/bottom-panels.ts`).
    // Swallow a warm-up rejection here: the awaited re-call below re-rejects
    // from the same memoized promises and the open flow's catch handles it.
    void preloadBottomPanels().catch(() => undefined)
    setPhase({ kind: 'opening' })
    setRecordRequest(null)
    setExportOpen(false)
    // m3-5: a new table invalidates the previous table's dispatch. The
    // previous source's identity must not leak into the new session's export
    // guard either (m4-5 fix round).
    setSqlRequest(null)
    setActionError(null)
    setScrollRequest(null)
    sourceIdentityRef.current = null
    // Retained so the export same-source guard can compare the save picker's
    // destination against the opened entry. `pickDataFile` does not expose
    // the picked FSA handle (packages/** is outside this task's
    // authorization), so the open flow passes its own `showOpenFilePicker`
    // wrapper: the same call the package's default makes, plus capture. The
    // captured handle is the ground truth for the FSA path, so the flow does
    // not branch on `picked.via` (structural fakes may omit it). A holder
    // object defeats TS's control-flow narrowing of the plain local across
    // the closure assignment.
    const openCapture: { handle: FileSystemFileHandle | null } = { handle: null }
    try {
      const picked = await pickDataFile({
        showOpenFilePicker: async (options) => {
          const handles = await showOpenFilePicker(options)
          openCapture.handle = handles[0] ?? null
          return handles
        },
      })
      if (datasetSession.tokenRef.current !== session) return
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
      if (datasetSession.tokenRef.current !== session) return
      // Export same-source guard identity (m4-5 fix round, hardened in
      // round 2). FSA opens retain the handle — the platform's
      // authoritative `isSameEntry` verdict, so a picked save destination
      // that IS the opened file is refused. Every other open (the
      // hidden-input fallback; structural fakes) retains NO identity: a
      // plain `File` has no `FileSystemHandle` representation, so same-entry
      // can never be proven — and round 1's name+size+lastModified suspicion
      // missed a source externally touched after opening. Such a session is
      // therefore never offered the direct-write picker at all; its exports
      // ride the browser download (see `save-destination.ts`).
      const pickedHandle = openCapture.handle
      sourceIdentityRef.current =
        pickedHandle !== null ? { isSameEntry: pickedHandle.isSameEntry.bind(pickedHandle) } : null
      const handle = await engineClient.open({
        name: file.name,
        getFile: () => Promise.resolve(file),
      })
      if (datasetSession.tokenRef.current !== session) return
      // Base metadata for the editing session (ADR 0011/0012). The anchor is
      // the stable function of the file *version* (size + mtime) — re-opening
      // the same unchanged file keeps base row ids stable; the token is never
      // rendered or logged.
      const baseSchema = await engineClient.schema(handle)
      if (datasetSession.tokenRef.current !== session) return
      const baseRowCount = await engineClient.rowCount(handle)
      if (datasetSession.tokenRef.current !== session) return
      const base: OverlayBase = {
        baseAnchor: fileVersionAnchor({ size: file.size, lastModified: file.lastModified }),
        overlayAnchor: createOverlayAnchor(),
        columns: baseSchema.map((column) => ({ name: column.name, type: column.type })),
        baseRowCount,
      }
      const initialHistory = emptyHistory()
      historyRef.current = initialHistory
      overlayRef.current = overlaySnapshot(base, initialHistory)
      const provider = new DuckDbGridProvider(
        engineClient,
        handle,
        () => overlayRef.current ?? overlaySnapshot(base, initialHistory),
      )
      const model = new GridViewportModel(provider)
      await model.load()
      if (datasetSession.tokenRef.current !== session) return
      // au3-12: the below-fold chunks were requested at the top of this flow;
      // resolving them here publishes the panel components as state BEFORE the
      // `ready` render, so the grid and panels mount in one synchronous render
      // (no post-ready fallback cycle — see `lib/bottom-panels.ts`).
      const panels = await preloadBottomPanels()
      if (datasetSession.tokenRef.current !== session) return
      setPanelModules(panels)
      setPhase({ kind: 'ready', model, tableId: handle.id, handle, base, provider })
    } catch (error) {
      // A stale chain must not surface its failure over the newer phase.
      if (datasetSession.tokenRef.current !== session) return
      setPhase({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }, [datasetSession, historyRef, overlayRef])

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
          <MemoSchemaPanel
            columns={schemaColumns}
            onAction={runNestedAction}
            onRenameColumn={handleRenameColumn}
            onCastColumn={handleCastColumn}
            castPendingColumn={castPendingColumn}
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
          {/*
           * q-3: the ONE polite live region for grid edit outcomes. Commit
           * success and every value-free rejection (client validation reason
           * or the q-8 engine materialization class) announce here; the
           * visible `edit-error`/`grid-edit-error` text is not itself a live
           * region. `seq` remounts the text node so repeated announcements
           * still fire. Never carries a cell value (ADR 0025).
           */}
          <span
            className="visually-hidden"
            aria-live="polite"
            aria-atomic="true"
            data-testid="edit-live-region"
          >
            {editAnnouncement === null ? null : (
              <span key={editAnnouncement.seq}>{editAnnouncement.text}</span>
            )}
          </span>
          <section className="export-actions" aria-label="Export">
            <button
              type="button"
              className="export-open"
              data-testid="export-open"
              onClick={() => {
                setExportOpen(true)
              }}
            >
              Export a copy…
            </button>
            {exportOpen && (
              <ExportDialog
                // The effective (unfiltered) count at the history cursor —
                // never the grid's filtered `totalRows` (m4-5 review
                // finding): `exportView` exports every row in natural order.
                // The memo is null only pre-ready; this branch is ready.
                rowCount={liveRowCount(
                  phase.base,
                  overlayState ?? stateAtCursor(phase.base, history),
                )}
                // Filtering and sorting tracked separately (m4-5 fix
                // round 2): a sort-only view must not claim a "filtered
                // subset"; the dialog describes only the active state.
                viewFiltered={modelFilters.length > 0}
                viewSorted={modelSort !== null}
                runEngineExport={runExport}
                requestDestination={requestExportDestination}
                writeCopy={deliverExportCopy}
                onClose={() => {
                  setExportOpen(false)
                }}
              />
            )}
          </section>
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
          {/**
           * Placement (m5-3): the validation panel sits between the editing
           * surface and the grid — its sample lists and filter control drive
           * the grid below, and its verdicts track the editing above.
           */}
          {panelModules === null ? null : (
            <panelModules.ValidationPanel
              contractState={contractState}
              runState={validationRun}
              stale={validationStale}
              jumpError={jumpError}
              filterError={filterToFailuresError}
              onContractFile={handleContractFile}
              onValidate={handleValidate}
              onCancelValidate={handleCancelValidate}
              onJumpToSample={handleJumpToSample}
              onFilterToFailures={handleFilterToFailures}
              requestReportDestination={requestReportDestinationForPanel}
              deliverReportCopy={writeReportCopy}
            />
          )}
          {/**
           * Placement (m6-4): the comparison panel sits beside the validation
           * panel — both drive the grid below (diff samples jump A-side rows)
           * and both track the editing above (verdict freshness). Schema drift
           * and distribution deltas render before the key-selection control, so
           * a row diff can never run before the schema-level view is visible.
           */}
          {panelModules === null ? null : (
            <panelModules.DiffPanel
              comparison={comparisonState}
              runState={diffRun}
              stale={diffStale}
              jumpError={diffJumpError}
              onComparisonFile={handleComparisonFile}
              onRunDiff={handleRunDiff}
              onCancelDiff={handleCancelDiff}
              onJumpToSample={handleJumpToDiffSample}
              requestReportDestination={requestDiffReportDestinationForPanel}
              deliverReportCopy={writeDiffReportCopy}
            />
          )}
          <FilterBar model={phase.model} />
          <ErrorBoundary scope="grid">
            <DataGrid
              model={phase.model}
              overlayState={overlayState}
              scrollRequest={scrollRequest}
              onCommitCell={handleCommitCell}
              onDeleteRow={handleDeleteRow}
              onEditAnnounce={announceEdit}
              onOpenRecord={(rowIndex) => {
                setRecordRequest((previous) => ({ rowIndex, seq: (previous?.seq ?? 0) + 1 }))
              }}
              onNestedAction={runNestedAction}
            />
          </ErrorBoundary>
          {/**
           * Placement (m3-3): directly under the grid it inspects. The app
           * composes single-column, full-width disclosure sections (schema →
           * editing → filters → grid → record → SQL → profile).
           */}
          <MemoRecordInspector
            model={phase.model}
            request={recordRequest}
            overlayRevision={overlayRevision}
            onClosed={handleRecordClosed}
          />
          {panelModules === null ? null : (
            <panelModules.SqlPanel tableId={phase.tableId} runRequest={sqlRequest} />
          )}
          {panelModules === null ? null : <panelModules.ProfilePanel handle={phase.handle} />}
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
