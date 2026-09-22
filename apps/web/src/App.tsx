import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type {
  EngineComparisonHandle,
  EngineExportFormat,
  EngineExportResult,
  EngineTableHandle,
} from '@assay/engine-duckdb'
import { viewNameForTableId } from '@assay/engine-duckdb'
import type { CellValue, EditOp, OverlayBase, RowId, TransformationHistory } from '@assay/domain'
import { compileRowDiffPlan, diffDatasets, inferRowDiffKeys } from '@assay/diff'
import {
  appendOp,
  emptyHistory,
  insertRowId,
  liveRowCount,
  redo as redoHistory,
  stateAtCursor,
  undo as undoHistory,
} from '@assay/domain'
import { GridViewportModel } from '@assay/grid'
import { pickDataFile } from '@assay/data-sources/browser'
import { parseContract } from '@assay/contracts'
import { compileContract } from '@assay/validation'
import { DataGrid } from './grid/DataGrid'
import { DuckDbGridProvider } from './grid/provider'
import { ErrorBoundary } from './ErrorBoundary'
import { FilterBar } from './grid/FilterBar'
import { EditToolbar } from './edit/EditToolbar'
import { ExportDialog } from './export/ExportDialog'
import { requestSaveDestination, writeExportCopy } from './export/save-destination'
import type {
  SaveStrategy,
  SourceIdentity,
  WritableSaveDestination,
} from './export/save-destination'
import { HistoryPanel } from './edit/HistoryPanel'
import {
  activeOps,
  castRacedMessage,
  castRefusalMessage,
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
import { ValidationPanel } from './validation/ValidationPanel'
import type { ContractState, ValidationRunState } from './validation/ValidationPanel'
import { readContractFile } from './validation/contract-import'
import { buildValidationReport, resolveRowKeyIndex } from './validation/report-model'
import type { ValidationReportRow } from './validation/report-model'
import { requestReportDestination, writeReportCopy } from './validation/report-export'
import type { ReportExportFormat } from './validation/report-export'
import { DiffPanel } from './diff/DiffPanel'
import type { ComparisonState, DiffRunState } from './diff/DiffPanel'
import {
  buildDiffPanelReport,
  DIFF_PLAN_RELATION_A,
  DIFF_PLAN_RELATION_B,
  DIFF_SAMPLE_LIMIT,
  toDiffProfile,
} from './diff/diff-model'
import type { DiffKeyDisclosure } from './diff/diff-model'
import { requestDiffReportDestination, writeDiffReportCopy } from './diff/diff-export'
import type { DiffReportFormat } from './diff/diff-export'

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
      /** Overlay-aware provider; the grid reads the effective view through it (m4-3). */
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

/**
 * Stable no-op model subscription/snapshot for the pre-open phases. `App`
 * must call `useSyncExternalStore` unconditionally (hook rules); these stand
 * in until a table is ready. Both are module constants so React never
 * re-subscribes between renders.
 */
const NO_SUBSCRIPTION = (): (() => void) => () => {}
const NO_VERSION = (): number => 0

/**
 * How many times the cast path re-runs the engine's pre-commit check when a
 * same-table history change invalidates a result. Each attempt awaits the
 * engine, so this is a contention bound, not a hot loop; if the state keeps
 * changing the intent is refused honestly rather than appended unchecked.
 */
const MAX_CAST_CHECK_ATTEMPTS = 3

/**
 * m5-3 validation binding name and sample bound. The plan's `relation` is
 * the binding name the engine materializes the effective view under — not a
 * registered table view (which are `assay_tN`, and which the engine's plan
 * gate would refuse to shadow). K aligns with the engine's hard sample max
 * (100) so the panel's sample list is as complete as the engine allows; the
 * engine clamps anyway (`min(K, 100)`), so this is a floor, not a promise.
 */
const VALIDATION_RELATION = 'assay_validation_target'
const VALIDATION_SAMPLE_LIMIT = 100

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
  /**
   * Synchronous mirror of `history`. Cell/rename ops run synchronously against
   * the latest value; the cast path `await`s the engine's pre-commit check, so
   * reading this ref at append time prevents a stale closure from dropping an
   * edit made while the check was in flight.
   */
  const historyRef = useRef<TransformationHistory>(history)
  /**
   * Monotonic session token, bumped when a new file opens. The cast check
   * `await`s the engine, so a result that arrives after the user switched
   * tables must be dropped rather than applied to the new session's history.
   */
  const sessionToken = useRef(0)
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
   * Column whose cast pre-check is currently in flight (or `null`). Renders
   * a pending state on that column's cast control so a slow check is honest
   * and a double-click cannot queue a second intent.
   */
  const [castPendingColumn, setCastPendingColumn] = useState<string | null>(null)

  /**
   * m5-3 validation session. `contractState` is the imported contract (none
   * / parse errors / over-bound / loaded); `validationRun` is the run state
   * machine (idle / running / cancelled / failed / binding errors / verdict).
   * A verdict stores the `overlayRevision` it ran against; `validationStale`
   * is the honest freshness signal — ANY history activation (edit, undo,
   * redo, cursor move) marks an existing verdict stale, and re-validation is
   * an explicit click (no auto-revalidate: an editing session triggers many
   * revisions per fix, and a debounced auto-run would spend query-lane work
   * on verdicts that are already stale again). The verdict stays viewable
   * under the stale banner (m4-3 dirty-state discipline).
   */
  const [contractState, setContractState] = useState<ContractState>({ kind: 'none' })
  const [validationRun, setValidationRun] = useState<ValidationRunState>({ kind: 'idle' })
  /**
   * Monotonic run token: the validate path captures it at request time and
   * drops a result that is no longer current (the m2-4 UI-level-cancellation
   * discipline — the engine op itself completes; cancellation abandons the
   * result, and the status line says so).
   */
  const validationSeq = useRef(0)
  /** Jump/filter feedback for the panel (readable, value-free). */
  const [jumpError, setJumpError] = useState<string | null>(null)
  const [filterToFailuresError, setFilterToFailuresError] = useState<string | null>(null)
  /**
   * m5-3 jump-to-row: the grid scrolls to this effective row index. `seq`
   * makes every gesture distinct (the same row can be re-targeted); reset
   * when a new file opens. Immediate gesture — not tracked across epochs.
   */
  const [scrollRequest, setScrollRequest] = useState<{
    readonly rowIndex: number
    readonly seq: number
  } | null>(null)
  const scrollSeq = useRef(0)

  /**
   * m6-4 comparison session. `comparisonState` is the staged comparison
   * (none / staging / failed / staged) and `diffRun` is the row-diff run
   * state machine. `comparisonSeq`/`diffSeq` are the UI-level generation
   * guards (the m5-3 pattern): a superseded or abandoned result is dropped,
   * and a comparison staged against a dead dataset epoch never lands.
   * `comparisonRef` holds the engine's opaque comparison handle (never
   * rendered); `diffStale` marks a result computed before the latest edit.
   */
  const [comparisonState, setComparisonState] = useState<ComparisonState>({ kind: 'none' })
  const [diffRun, setDiffRun] = useState<DiffRunState>({ kind: 'idle' })
  const [diffJumpError, setDiffJumpError] = useState<string | null>(null)
  const comparisonSeq = useRef(0)
  const diffSeq = useRef(0)
  const comparisonRef = useRef<EngineComparisonHandle | null>(null)

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
   * Subscribe to the model so schema re-keys after a rename/cast re-render the
   * panel (and the nested-action specs). `DataGrid`/`LiveTableInfo` already
   * subscribe; `schemaColumns` is derived from `model.schema`, which
   * `refresh()` replaces asynchronously, so without a subscription App never
   * re-rendered and the panel kept the pre-rename names/types.
   */
  const activeModel = phase.kind === 'ready' ? phase.model : null
  useSyncExternalStore(
    activeModel?.subscribe ?? NO_SUBSCRIPTION,
    activeModel?.getVersion ?? NO_VERSION,
  )

  const schemaColumns = activeModel?.schema ?? NO_COLUMNS
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
      const result = await commitWithRollback(previous, next, {
        setActive: activateHistory,
        refresh: () => phase.model.refresh(),
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
        setEditError(outcomeMessage)
      }
    },
    [phase, commitHistory],
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
      const session = sessionToken.current
      setCastPendingColumn(column)
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
              if (sessionToken.current === session) setEditError(engineRejectionMessage(error))
              return
            }
            // A table switch while the check was in flight invalidates the intent.
            if (sessionToken.current !== session) return
            // A *same-table* history change also invalidates it: the check
            // described state that is no longer what the append would commit
            // over (the original silent-brick defect). Re-run against the new
            // state rather than appending a stale result.
            if (historyRevision.current !== revision) continue
            if (check.hasNonConvertibleValues) {
              setEditError(castRefusalMessage(column, targetType))
              return
            }
            applyOp({ kind: 'column-cast', column, targetType })
            return
          }
          // Every attempt was invalidated by a concurrent change; refuse
          // honestly rather than append a result we could never trust.
          if (sessionToken.current === session) {
            setEditError(castRacedMessage(column, targetType))
          }
        } finally {
          setCastPendingColumn((pending) => (pending === column ? null : pending))
        }
      })()
    },
    [phase, applyOp],
  )

  /**
   * m5-3 validation session handlers.
   *
   * Freshness: a verdict (or binding-error report) stores the overlay
   * revision it was produced against; any history activation marks it stale
   * and re-validation is an explicit click. The verdict stays viewable under
   * the stale banner (m4-3 dirty-state discipline).
   *
   * Busy policy: `validate` runs on the engine's query lane (ADR 0040), so
   * the grid stays interactive. Cancellation is UI-level abandonment (the
   * m2-4 pattern — the engine op itself completes; an abandoned result is
   * dropped by seq and the panel says "cancelled"). A second run cannot
   * start while one is in flight.
   */
  const validationStale =
    (validationRun.kind === 'verdict' || validationRun.kind === 'binding-errors') &&
    validationRun.revision !== overlayRevision

  /**
   * m6-4 freshness: a row diff (or binding-error report) computed before the
   * latest overlay activation is stale — the effective view it described has
   * changed. The result stays viewable under the stale banner; re-running is
   * an explicit click (no auto-run).
   */
  const diffStale =
    (diffRun.kind === 'result' && diffRun.report.revision !== overlayRevision) ||
    (diffRun.kind === 'binding-errors' && diffRun.revision !== overlayRevision)

  const handleContractFile = useCallback((file: File) => {
    const session = sessionToken.current
    void (async () => {
      const imported = await readContractFile(file)
      // AR-W9: the read awaits, so a re-open that happened meanwhile means
      // this contract was authored for the previous dataset — discard it
      // (the house session-token guard used by validate/diff/cast).
      if (sessionToken.current !== session) return
      if (imported.kind === 'too-large') {
        setContractState({ kind: 'too-large' })
      } else if (imported.kind === 'read-failed') {
        setContractState({ kind: 'read-failed', message: imported.message })
      } else {
        const parsed = parseContract(imported.text)
        setContractState(
          parsed.ok
            ? { kind: 'loaded', contract: parsed.contract }
            : { kind: 'parse-error', errors: parsed.errors },
        )
      }
      // A newly imported contract invalidates any previous verdict: the old
      // report described rules this contract may no longer contain.
      setValidationRun({ kind: 'idle' })
      setJumpError(null)
      setFilterToFailuresError(null)
    })()
  }, [])

  const handleValidate = useCallback(() => {
    if (phase.kind !== 'ready' || contractState.kind !== 'loaded') return
    const session = sessionToken.current
    const seq = ++validationSeq.current
    const revision = overlayRevision
    const { base, handle } = phase
    const contract = contractState.contract
    setValidationRun({ kind: 'running' })
    void (async () => {
      try {
        // Compile against the CURRENT effective schema (post-rename/cast at
        // the history cursor) — the same effective view the plan then
        // executes over, so binding errors and verdicts always describe the
        // dataset as it is now.
        const effective = stateAtCursor(base, historyRef.current)
        const compiled = compileContract(contract, effective.columns, {
          relation: VALIDATION_RELATION,
          sampleLimit: VALIDATION_SAMPLE_LIMIT,
        })
        if (sessionToken.current !== session) return
        if (!compiled.ok) {
          if (seq === validationSeq.current) {
            setValidationRun({ kind: 'binding-errors', errors: compiled.errors, revision })
          }
          return
        }
        const overlay = overlayRef.current ?? overlaySnapshot(base, historyRef.current)
        const result = await engineClient.validate(handle, compiled.plan, overlay)
        if (sessionToken.current !== session) return
        // Superseded or abandoned (cancel/new run): drop the stale result.
        if (seq !== validationSeq.current) return
        setValidationRun({
          kind: 'verdict',
          report: buildValidationReport(compiled.plan, result, contract),
          revision,
        })
      } catch (error) {
        if (sessionToken.current !== session || seq !== validationSeq.current) return
        setValidationRun({ kind: 'failed', message: engineRejectionMessage(error) })
      }
    })()
  }, [phase, contractState, overlayRevision])

  const handleCancelValidate = useCallback(() => {
    validationSeq.current += 1
    setValidationRun({ kind: 'cancelled' })
  }, [])

  /**
   * Jump-to-row: resolve the sample's logical row key in the CURRENT
   * effective view (m4-3 row-key channel), scroll the grid there, and open
   * the record inspector. A key the current view no longer contains (the
   * row was deleted after the verdict) is an honest, readable error.
   */
  const handleJumpToSample = useCallback(
    (rowKey: string) => {
      if (phase.kind !== 'ready') return
      const state = stateAtCursor(phase.base, historyRef.current)
      const resolution = resolveRowKeyIndex(phase.base, state, rowKey)
      if (resolution.kind === 'missing') {
        setJumpError(
          'That row is no longer in the current view — it may have been deleted after the verdict was computed. Re-validate for a fresh report.',
        )
        return
      }
      setJumpError(null)
      scrollSeq.current += 1
      setScrollRequest({ rowIndex: resolution.rowIndex, seq: scrollSeq.current })
      setRecordRequest((previous) => ({
        rowIndex: resolution.rowIndex,
        seq: (previous?.seq ?? 0) + 1,
      }))
    },
    [phase],
  )

  /**
   * Filter-to-failures: apply the rule's single-column predicate through the
   * m2-2 filter channel, REPLACING the active filter list (the control is a
   * view toggle, not an accumulation — the resulting view is "only the rows
   * failing this rule"). An engine rejection restores the previous filters
   * (the grid contract's rejection-leaves-state rule) and surfaces readable
   * text; the m4-3 rollback convention, applied to filters.
   */
  const handleFilterToFailures = useCallback(
    (row: ValidationReportRow) => {
      if (phase.kind !== 'ready') return
      if (row.filter.kind !== 'ready' || row.column === null) return
      const column = row.column
      const predicate = row.filter.predicate
      void (async () => {
        const previous = phase.model.filters
        try {
          await phase.model.setFilters([{ column, predicate }])
          setFilterToFailuresError(null)
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause)
          try {
            await phase.model.setFilters(previous)
            setFilterToFailuresError(
              `The grid rejected the failure filter (${message}). The previous filters are back in effect.`,
            )
          } catch {
            setFilterToFailuresError(
              'The grid rejected the failure filter, and restoring the previous filters also failed. Clear filters manually.',
            )
          }
        }
      })()
    },
    [phase],
  )

  /** m4-5 pattern for the report: destination with the same-source guard. */
  const requestReportDestinationForPanel = useCallback(
    (format: ReportExportFormat) =>
      requestReportDestination(format, {
        sourceIdentity: sourceIdentityRef.current ?? undefined,
      }),
    [],
  )

  /**
   * m6-4 comparison staging (checkpoint C3). The picked file is read locally,
   * staged through the engine's typed comparison op (single-slot scratch,
   * never the source path) for the row diff, and opened transiently to obtain
   * its profile aggregates — the engine profiles registered tables, and the
   * comparison view is not one. The opened handle is profile-only: the
   * comparison never becomes a grid and no second grid model is created. A
   * staging failure stages nothing; a superseded stage is dropped by seq.
   */
  const handleComparisonFile = useCallback(
    (file: File) => {
      if (phase.kind !== 'ready') return
      const session = sessionToken.current
      const seq = ++comparisonSeq.current
      setComparisonState({ kind: 'staging' })
      setDiffRun({ kind: 'idle' })
      setDiffJumpError(null)
      comparisonRef.current = null
      void (async () => {
        try {
          const source = { name: file.name, getFile: () => Promise.resolve(file) }
          const comparison = await engineClient.stageComparison(source)
          const handleB = await engineClient.open(source)
          const [profileA, profileB] = await Promise.all([
            engineClient.profile(phase.handle),
            engineClient.profile(handleB),
          ])
          if (sessionToken.current !== session || seq !== comparisonSeq.current) return
          comparisonRef.current = comparison
          const schemaA = phase.base.columns
          const diffProfileA = toDiffProfile(profileA)
          const diffProfileB = toDiffProfile(profileB)
          const diff = diffDatasets({
            schemaA,
            schemaB: comparison.schema,
            profileA: diffProfileA,
            profileB: diffProfileB,
          })
          setComparisonState({
            kind: 'staged',
            schemaB: comparison.schema.map((column) => ({ name: column.name, type: column.type })),
            rowCountB: diffProfileB.rowCount,
            baseColumnCount: schemaA.length,
            diff,
            inference: inferRowDiffKeys(diffProfileA, diffProfileB),
          })
        } catch (error) {
          if (sessionToken.current !== session || seq !== comparisonSeq.current) return
          setComparisonState({ kind: 'failed', message: engineRejectionMessage(error) })
        }
      })()
    },
    [phase],
  )

  /**
   * Run the confirmed-key row diff. The plan is compiled against the CURRENT
   * effective schema (post-rename/cast at the history cursor) so binding and
   * changed-column names match the view side A binds to, then executed over
   * the effective view (base + overlay) — the same view the grid shows. A
   * compile binding error is first-class panel content (the m5-3 pattern);
   * the result stores the overlay revision it ran against for the stale
   * banner. UI-level cancel abandons the result via the seq guard.
   */
  const handleRunDiff = useCallback(
    (
      keys: readonly string[],
      keySource: 'explicit' | 'inferred',
      inference: DiffKeyDisclosure | null,
    ) => {
      if (phase.kind !== 'ready' || comparisonState.kind !== 'staged') return
      const comparison = comparisonRef.current
      if (comparison === null) return
      const session = sessionToken.current
      const seq = ++diffSeq.current
      const revision = overlayRevision
      const { diff, schemaB } = comparisonState
      setDiffRun({ kind: 'running' })
      void (async () => {
        try {
          const effective = stateAtCursor(phase.base, historyRef.current)
          const compiled = compileRowDiffPlan(effective.columns, schemaB, keys, {
            relationA: DIFF_PLAN_RELATION_A,
            relationB: DIFF_PLAN_RELATION_B,
            sampleLimit: DIFF_SAMPLE_LIMIT,
          })
          if (sessionToken.current !== session || seq !== diffSeq.current) return
          if (!compiled.ok) {
            setDiffRun({ kind: 'binding-errors', errors: compiled.errors, revision })
            return
          }
          const overlay = overlayRef.current ?? overlaySnapshot(phase.base, historyRef.current)
          const result = await engineClient.diff(phase.handle, comparison, compiled.plan, overlay)
          if (sessionToken.current !== session || seq !== diffSeq.current) return
          setDiffRun({
            kind: 'result',
            report: buildDiffPanelReport({
              diff,
              result,
              keys,
              keySource,
              inference,
              sharedColumns: compiled.plan.sharedColumns,
              sampleLimitRequested: DIFF_SAMPLE_LIMIT,
              sampleLimitEffective: DIFF_SAMPLE_LIMIT,
              baseViewOnly: (overlay.ops?.length ?? 0) === 0,
              revision,
            }),
          })
        } catch (error) {
          if (sessionToken.current !== session || seq !== diffSeq.current) return
          setDiffRun({ kind: 'failed', message: engineRejectionMessage(error) })
        }
      })()
    },
    [phase, comparisonState, overlayRevision],
  )

  const handleCancelDiff = useCallback(() => {
    diffSeq.current += 1
    setDiffRun({ kind: 'cancelled' })
  }, [])

  /**
   * Jump-to-row for an A-side diff sample: resolve the logical row key in the
   * CURRENT effective view (m4-3 row-key channel) and scroll/open the
   * inspector. A key the current view no longer contains is readable, never
   * silent. B-side keys never reach here (the panel shows no jump there).
   */
  const handleJumpToDiffSample = useCallback(
    (rowKey: string) => {
      if (phase.kind !== 'ready') return
      const state = stateAtCursor(phase.base, historyRef.current)
      const resolution = resolveRowKeyIndex(phase.base, state, rowKey)
      if (resolution.kind === 'missing') {
        setDiffJumpError(
          'That row is no longer in the current view — it may have been deleted or changed after the diff ran. Run the diff again for a fresh report.',
        )
        return
      }
      setDiffJumpError(null)
      scrollSeq.current += 1
      setScrollRequest({ rowIndex: resolution.rowIndex, seq: scrollSeq.current })
      setRecordRequest((previous) => ({
        rowIndex: resolution.rowIndex,
        seq: (previous?.seq ?? 0) + 1,
      }))
    },
    [phase],
  )

  /** m4-5 pattern for the diff report: destination with the same-source guard. */
  const requestDiffReportDestinationForPanel = useCallback(
    (format: DiffReportFormat) =>
      requestDiffReportDestination(format, {
        sourceIdentity: sourceIdentityRef.current ?? undefined,
      }),
    [],
  )

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
    [phase],
  )

  const requestExportDestination = useCallback(
    (format: EngineExportFormat) =>
      requestSaveDestination(format, {
        // Undefined before the first open and for opens without a retained
        // FSA handle — the latter is what keeps input-fallback sessions on
        // the download-only delivery path (m4-5 fix round 2).
        sourceIdentity: sourceIdentityRef.current ?? undefined,
      }),
    [],
  )

  const deliverExportCopy = useCallback(
    (destination: WritableSaveDestination, result: EngineExportResult): Promise<SaveStrategy> =>
      writeExportCopy(destination, result),
    [],
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
      setViewError(false)
      setEditError(null)
    } catch (error) {
      setEditError(engineRejectionMessage(error))
    }
  }, [phase])

  const openDataFile = useCallback(async () => {
    // AR-W13: generation guard. Bump the session token up front and capture
    // it; a picker/open chain that resolves after a newer open (or any newer
    // phase transition) is discarded rather than clobbering the newer phase.
    const session = ++sessionToken.current
    setPhase({ kind: 'opening' })
    setRecordRequest(null)
    setExportOpen(false)
    // m3-5 / m4-3: a new table invalidates the previous table's dispatch and
    // editing state — an overlay must never leak across files. The previous
    // source's identity must not leak into the new session's export guard
    // either (m4-5 fix round).
    setSqlRequest(null)
    setActionError(null)
    setEditError(null)
    setViewError(false)
    // m5-3: a new table resets the validation session — the previous
    // contract's verdict described a different dataset and must not leak.
    setContractState({ kind: 'none' })
    setValidationRun({ kind: 'idle' })
    setJumpError(null)
    setFilterToFailuresError(null)
    setScrollRequest(null)
    validationSeq.current += 1
    // m6-4: a new table invalidates the comparison session — a staged
    // comparison and any row diff described a different dataset.
    setComparisonState({ kind: 'none' })
    setDiffRun({ kind: 'idle' })
    setDiffJumpError(null)
    comparisonRef.current = null
    comparisonSeq.current += 1
    diffSeq.current += 1
    sourceIdentityRef.current = null
    historyRevision.current += 1
    setCastPendingColumn(null)
    overlayRef.current = null
    const resetHistory = emptyHistory()
    historyRef.current = resetHistory
    setHistory(resetHistory)
    setOverlayRevision(0)
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
      if (sessionToken.current !== session) return
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
      if (sessionToken.current !== session) return
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
      if (sessionToken.current !== session) return
      // Base metadata for the editing session (ADR 0011/0012). The anchor is
      // the stable function of the file *version* (size + mtime) — re-opening
      // the same unchanged file keeps base row ids stable; the token is never
      // rendered or logged.
      const baseSchema = await engineClient.schema(handle)
      if (sessionToken.current !== session) return
      const baseRowCount = await engineClient.rowCount(handle)
      if (sessionToken.current !== session) return
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
      if (sessionToken.current !== session) return
      setPhase({ kind: 'ready', model, tableId: handle.id, handle, base, provider })
    } catch (error) {
      // A stale chain must not surface its failure over the newer phase.
      if (sessionToken.current !== session) return
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
                viewFiltered={phase.model.filters.length > 0}
                viewSorted={phase.model.sort !== null}
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
          <ValidationPanel
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
          {/**
           * Placement (m6-4): the comparison panel sits beside the validation
           * panel — both drive the grid below (diff samples jump A-side rows)
           * and both track the editing above (verdict freshness). Schema drift
           * and distribution deltas render before the key-selection control, so
           * a row diff can never run before the schema-level view is visible.
           */}
          <DiffPanel
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
          <FilterBar model={phase.model} />
          <ErrorBoundary scope="grid">
            <DataGrid
              model={phase.model}
              overlayState={overlayState}
              scrollRequest={scrollRequest}
              onCommitCell={handleCommitCell}
              onDeleteRow={handleDeleteRow}
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
