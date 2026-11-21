// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { viewNameForTableId } from '@assay/engine-duckdb'
import type { EngineTableHandle } from '@assay/engine-duckdb'
import { bucketFindingCount, classifyOsFamily } from '@assay/telemetry'
import type { OverlayBase } from '@assay/domain'
import { liveRowCount, stateAtCursor } from '@assay/domain'
import type { ContractV1 } from '@assay/contracts'
import { GridViewportModel } from '@assay/grid'
import type { ColumnSchema } from '@assay/grid'
import { pickDataFile } from '@assay/data-sources/browser'
import type { PickedDataFile } from '@assay/data-sources/browser'
import { detectFormatFromFileName } from '@assay/data-sources/browser'
import nestedFixtureText from '../../../fixtures/jsonl/nested.jsonl?raw'
import { DataGrid } from './grid/DataGrid'
import type { EditorReportState, GridQueryBusy } from './grid/DataGrid'
import { DuckDbGridProvider } from './grid/provider'
import { ErrorBoundary } from './ErrorBoundary'
import { FilterBar } from './grid/FilterBar'
import { EditToolbar } from './edit/EditToolbar'
import { ExportDialog } from './export/ExportDialog'
import type { SourceIdentity } from './export/save-destination'
import { HistoryPanel } from './edit/HistoryPanel'
import { activeOps, openFailureMessage, overlaySnapshot } from './edit/session'
import { pendingChangesSummary } from './edit/op-summary'
import { createOverlayAnchor, fileVersionAnchor } from './edit/overlay-base'
import {
  APP_NAME,
  DROP_WITHOUT_FILE,
  IDLE_CAPABILITY,
  IDLE_DROP_HINT,
  IDLE_ENGINE_LINE,
  IDLE_ENGINE_NOTE,
  IDLE_EXAMPLE_ACTION,
  IDLE_EXAMPLE_HELPER,
  IDLE_FORMATS,
  OPEN_CANCEL_LABEL,
  OPEN_PROGRESS_LABEL,
  SESSION_FAULT_COPY,
  SESSION_FAULT_RELOAD_LABEL,
  TAGLINE,
  openAnnouncementText,
  openStatusCopy,
} from './lib/app'
import { preloadBottomPanels } from './lib/bottom-panels'
import { engineClient } from './lib/engine'
import { classifyHistoryShortcut, shouldAutoExpandHistory } from './lib/history-shortcut'
import { NO_COLUMNS, useModelSlice } from './lib/use-model-slice'
import { usePipelineSession } from './pipeline/usePipelineSession'
import { DatasetContextBar } from './workbench/DatasetContextBar'
import { TaskNav } from './workbench/TaskNav'
import { deriveNextAction } from './workbench/next-action'
import type {
  NextActionContract,
  NextActionDiff,
  NextActionValidation,
} from './workbench/next-action'
import {
  DEFAULT_WORKBENCH_TASK,
  sectionsForTask,
  taskOfSection,
  type WorkbenchSectionId,
  type WorkbenchTaskId,
} from './workbench/tasks'
import { PanelBoundary } from './workbench/PanelBoundary'
import { WorkbenchSection } from './workbench/WorkbenchSection'
import {
  comparisonSectionSummary,
  failingRuleCount,
  historySectionSummary,
  validationSectionSummary,
} from './workbench/section-summaries'
import { RecordInspector } from './record/RecordInspector'
import type { RecordRequest } from './record/RecordInspector'
import { parseDuckDbType } from './schema/parseType'
import { SchemaPanel } from './schema/SchemaPanel'
import { composeNestedAction } from './sql/nested-actions'
import { planProfileFilter } from './profile/filter-action'
import type { ProfileFilterIntent } from './profile/filter-action'
import { replaceColumnFilter } from './grid/query-state'
import { filterFailureCopy } from './grid/filter-failure'
import type { NestedAction } from './sql/nested-actions'
import type { SqlRunRequest } from './sql/SqlPanel'
import { writeReportCopy } from './validation/report-export'
import { writeDiffReportCopy } from './diff/diff-export'
import { ReplaceGuard } from './replace/ReplaceGuard'
import { CsvReviewDialog } from './csv/CsvReviewDialog'
import { RepairDialog } from './edit/repair/RepairDialog'
import { REPAIR_ACTION } from './edit/repair/copy'
import { validateRepairPlan } from './edit/repair/refusal'
import { readRepairPreview } from './edit/repair/reader'
import { useRepairPreview } from './edit/repair/useRepairPreview'
import type { RepairSeam } from './edit/repair/useRepairPreview'
import { wireCsvOptions } from './csv/options'
import {
  CSV_REVIEW_ACTION,
  CSV_REVIEW_IDLE_HELPER,
  CSV_REVIEW_STOPPED,
  CSV_REVIEW_STOPPED_SESSION,
} from './csv/copy'
import type { OwnedModal } from './replace/gate'
import { useReplacementController } from './replace/useReplacementController'
import type { CsvAdoptionHandoff, ReplacementCandidate } from './replace/useReplacementController'
import {
  REPLACE_BUSY_NOTICE,
  REPLACE_CAST_NOTICE,
  REPLACE_DRAFT_NOTICE,
  REPLACE_FAILURE_SUFFIX,
  REPLACE_PICKER_NOTICE,
  REPLACE_PROGRESS_LABEL,
  REPLACE_PROGRESS_TEXT,
  REPLACE_RETRY_LABEL,
  REPLACE_SETTLING_NOTICE,
  REPLACE_TECHNICAL_SUMMARY,
} from './replace/messages'
import { useSessionOwner } from './sessions/useSessionOwner'
import type { SessionGridPorts, SessionOwnerPorts } from './sessions/useSessionOwner'
import { useEditingSession } from './sessions/useEditingSession'
import { useValidationSession } from './sessions/useValidationSession'
import { useDiffSession } from './sessions/useDiffSession'
import type { NavigateToRow, Phase, ScrollRequest } from './sessions/types'
import { readWebTelemetryConfig } from './telemetry/config'
import { diffRunOutcome, durationSince, validationOutcome } from './telemetry/emit'
import { browserStorage, createWebTelemetry } from './telemetry/runtime'
import type { WebTelemetryRuntime } from './telemetry/runtime'
import { TelemetryProvider } from './telemetry/TelemetryContext'
import { TelemetryDisclosure } from './telemetry/TelemetryDisclosure'
import { TelemetrySettings } from './telemetry/TelemetrySettings'
import { WorkbenchHelp, WORKBENCH_HELP_OPEN_LABEL } from './help/WorkbenchHelp'

/**
 * D02a seam. The three shell section summaries moved verbatim to
 * `workbench/section-summaries.ts`; App re-exports them so the existing tests
 * (`App.section-summaries.test.tsx` imports them from `./App`) keep working
 * across the migration. Every section shell component (`WorkbenchSection`,
 * `PanelBoundary`) moved with them; only App's own imports changed.
 */
export { comparisonSectionSummary, historySectionSummary, validationSectionSummary }

/**
 * R-07 request-consumption ledger. App owns exactly one ledger for the
 * dataset session; the SQL pane only asks it whether a request is new.
 *
 * The claim is synchronous and happens in the pane's effect BEFORE the
 * external engine query is issued. Because this state lives in App (not a
 * panel-local ref), a true panel remount — a boundary retry, a StrictMode
 * double effect, a close/reopen — sees the earlier claim and runs ZERO
 * additional queries for the same sequence. A genuinely newer sequence is
 * claimed exactly once.
 *
 * The ledger never clears an individual claim: a consumed sequence can only
 * be superseded by a higher one (or dropped wholesale on a new dataset
 * session, where `reset()` runs from `beginSession`). A late acknowledgment
 * of an older request therefore cannot erase a newer request's claim.
 */
export interface SqlRequestLedger {
  /**
   * Claim a request for the live session token. Returns `true` only when the
   * request belongs to that session and its sequence has not been consumed.
   */
  claim(request: SqlRunRequest, sessionToken: number): boolean
  /** Drop every claim when a new dataset session starts. */
  reset(): void
}

export function createSqlRequestLedger(): SqlRequestLedger {
  let claimedSession: number | null = null
  let claimedSeq = 0
  return {
    claim(request, sessionToken) {
      // Requests composed in a replaced dataset are stale by construction:
      // their carried session token no longer matches the live one.
      if (request.session !== sessionToken) return false
      if (claimedSession !== sessionToken) {
        claimedSession = sessionToken
        claimedSeq = 0
      }
      if (request.seq <= claimedSeq) return false
      claimedSeq = request.seq
      return true
    },
    reset() {
      claimedSession = null
      claimedSeq = 0
    },
  }
}

/**
 * Live summary line for the opened table (m2-3 row-count truth): the total
 * is read from the model — which re-reads it from the provider after every
 * accepted filter change and every overlay epoch.
 */
function LiveTableInfo({ model }: { model: GridViewportModel }) {
  useSyncExternalStore(model.subscribe, model.getVersion)
  return (
    <p className="workbench-table-info" data-testid="table-info">
      Dataset · <span data-testid="grid-total-rows">{model.totalRows ?? 0}</span> rows ·{' '}
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

/**
 * q-15 — workbench shell slice 2, the ≥1024px grid-centric two-pane shell
 * (spec docs/product/05-workbench-shell.md §3; ADR 0044). At ≥1024px the grid
 * is the persistent center column and the tool sections live in a collapsible
 * left pane; below 1024px the SAME DOM renders as the slice-1 single-column
 * stack via CSS `display: contents` + `order` (index.css).
 *
 * UI-RD-01 (2026-11-04): the sections are grouped into four user tasks in
 * `workbench/tasks.ts` (Explore/Check/Change/Prepare). At ≥1024px the active
 * task's sections are the only ones EXPOSED (pane `data-task` + one CSS rule);
 * the others stay mounted and are `display: none`, so a task switch re-runs and
 * remounts nothing. Choosing a task also opens its manageable sections. Every
 * section keeps its `section-nav-<id>` link and every link stays exposed while
 * it can be a focus target, because revealing a section activates its task
 * first. The DOM stays flat with one deliberate within-Change order (History
 * before Export); no task wrappers are added, and <1024px is unchanged.
 */
const INNER_DISCLOSURE_SECTIONS: ReadonlySet<WorkbenchSectionId> = new Set<WorkbenchSectionId>([
  'schema',
  'filters',
  'profile',
])

/**
 * CO-3 (ug-23): the pane rail toggle's own accessible name. It used to reuse
 * the in-pane nav's "Workbench sections", so one name covered two different
 * roles (a `button` and a `navigation`) and "jump to the sections" could not
 * tell the landmark from the control. The name states what pressing it does
 * and tracks the state `aria-expanded` already publishes (collapsed ⇒ the
 * press expands), which is why it is derived from the same boolean rather than
 * a fixed string. The nav keeps "Workbench sections".
 */
function paneToggleLabel(collapsed: boolean): string {
  return collapsed ? 'Expand workbench pane' : 'Collapse workbench pane'
}

/**
 * ug-12 (UG-26): the jump-to-row announcement for the SINGLE polite live
 * region. The validation/compare “Show row” gesture scrolls the grid, opens
 * the record inspector and lands roving focus on the target row; the region
 * states that in one value-free sentence. `displayKey` is the sample's domain
 * display key (`base #12` / `insert #3`) — a logical row identity, never a
 * cell value or filename (ADR 0025). A jump without a caller-supplied label
 * announces nothing (`null`), so only the sample-list gestures speak.
 */
export function rowJumpAnnouncementText(displayKey?: string): string | null {
  return displayKey === undefined ? null : `Showing ${displayKey} in the grid and record inspector`
}

/**
 * K17 (v5 §3.2/§7, spec IC-03): may the Open control start an open right now?
 *
 * `false` while the legacy chain is already opening, while a replacement intent
 * owns the shell, or while ANY owned surface is open — in **every** phase, so
 * an idle-phase Open can never fall through to the legacy destroy-first
 * `openDataFile()` behind Help, the first-run telemetry disclosure, the Export
 * dialog or Settings. The click handler applies the same predicate, so a
 * programmatic activation is refused too.
 */
export function openControlBlocked(input: {
  readonly phase: Phase['kind']
  readonly intentActive: boolean
  readonly openModal: OwnedModal | null
}): boolean {
  return input.phase === 'opening' || input.intentActive || input.openModal !== null
}

/**
 * D02c — the session owner's engine export port. The in-flight snapshot is
 * frozen by the owner (one `EngineOverlay` value per click); this is a plain
 * forward to the one engine client, kept at module scope so the port identity
 * is stable for the owner's whole lifetime.
 */
const exportViewPort: SessionOwnerPorts['exportView'] = (handle, request) =>
  engineClient.exportView(handle, request)

export interface AppProps {
  /**
   * Telemetry injection seam for tests. When omitted, `App` builds the
   * build-configured runtime (inert in the stock build: no endpoint).
   */
  readonly telemetry?: WebTelemetryRuntime
}

export function App({ telemetry: injectedTelemetry }: AppProps = {}) {
  const telemetryConfig = useMemo(() => readWebTelemetryConfig(), [])
  const telemetry = useMemo(
    () =>
      injectedTelemetry ??
      createWebTelemetry({ config: telemetryConfig, storage: browserStorage() }),
    [injectedTelemetry, telemetryConfig],
  )
  /**
   * First-run disclosure visibility. The runtime only reports `true` when
   * telemetry would otherwise be active (endpoint configured AND not opted
   * out) and the per-install marker is absent (design §6.3).
   */
  const [disclosureOpen, setDisclosureOpen] = useState(() => telemetry.shouldShowDisclosure())
  /**
   * D02c — App-owned, **session-scoped request slots**. They are the state the
   * session owner retires at every session boundary (a previous dataset's
   * request can never address the new one). The owner decides WHEN; App owns
   * WHAT, so it passes `retireRequests` as one named port.
   */
  const [recordRequest, setRecordRequest] = useState<RecordRequest | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [sqlRequest, setSqlRequest] = useState<SqlRunRequest | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [scrollRequest, setScrollRequest] = useState<ScrollRequest | null>(null)
  const scrollSeq = useRef(0)
  const retireRequests = useCallback(() => {
    setRecordRequest(null)
    setExportOpen(false)
    setSqlRequest(null)
    setActionError(null)
    setScrollRequest(null)
  }, [])
  /**
   * D02c — the session owner. It owns the reset registry + token, the live
   * `phase` (and its synchronous mirror), the fail-closed fault frame, the
   * adopted source slots, the resolved panels, the one irreversible adoption
   * step, exactly-once `dataset_opened` and the export-in-flight snapshot. See
   * `sessions/useSessionOwner.ts` for the boundary and the ownership table.
   *
   * `App` stays the composition root: it supplies the telemetry runtime, the
   * app-local request slots to retire, and the engine export op — nothing else.
   * Each per-domain reset body stays with its own hook; this passes the
   * registry to them below.
   */
  const sessionOwner = useSessionOwner({ telemetry, retireRequests, exportView: exportViewPort })
  const {
    session: datasetSession,
    phase,
    phaseRef,
    sessionFault,
    openSourceRef,
    sourceIdentityRef,
    panelModules,
    currentToken,
    isCurrent: isCurrentSession,
    beginOpen,
    cancelOpen,
    publishIdle,
    publishError,
    failOpen,
    publishReady,
    adopt: adoptSession,
    runExport: runSessionExport,
  } = sessionOwner

  /**
   * ug-15: readable inline notice for a drop that carried no `File` (dragged
   * text, a page selection). Shown only on the idle screen; a real file drop
   * clears it. The copy is value-free (ADR 0025).
   */
  const [dropNotice, setDropNotice] = useState<string | null>(null)
  /**
   * ux-2/UX-10: open-completion announcement + focus move. `phase` is a new
   * object only on a real phase transition, so this effect runs once per open
   * — not on the App re-renders driven by editing state or `model.refresh()`.
   * On `ready` it announces through a polite `role="status"` region and moves
   * focus off the Open button to the first ready panel (the schema disclosure
   * toggle). The announcement carries only row/column counts (already public
   * in the info line) — never a filename, path, cell value, or PII (ADR 0025).
   * Errors keep their own `role="alert"` and do not steal focus.
   */
  const [openAnnouncement, setOpenAnnouncement] = useState<{ seq: number; text: string } | null>(
    null,
  )
  const openAnnounceSeqRef = useRef(0)
  useEffect(() => {
    if (phase.kind !== 'ready') {
      // Leaving ready clears any prior announcement so an in-flight or failed
      // open never leaves a stale "Dataset opened" in the live region.
      setOpenAnnouncement(null)
      return
    }
    openAnnounceSeqRef.current += 1
    setOpenAnnouncement({
      seq: openAnnounceSeqRef.current,
      text: openAnnouncementText(phase.model.totalRows ?? 0, phase.model.schema?.length ?? 0),
    })
    const firstPanel = document.querySelector<HTMLElement>('[data-testid="schema-toggle"]')
    firstPanel?.focus()
  }, [phase])
  /**
   * m3-3 record inspector open gesture. App holds it so a row open survives
   * the grid's re-renders; `seq` makes every gesture distinct so re-opening
   * the SAME row re-fires the inspector's open effect. Cleared when a new
   * file is opened — a request must never leak across tables. (The slot itself
   * is declared with the other retirable request slots above.)
   */
  /**
   * ug-19 (UG-19): the in-flight query epoch shown on the grid. App owns the
   * combined state because the two sources live in different components: the
   * FilterBar reports its existing `pending` apply and the DataGrid reports its
   * own header-sort transition. `Filtering…` wins while both are in flight, and
   * neither clear resets the other — the render derives the display from both
   * flags, so a sort settling under a pending filter stays `Filtering…`.
   * Component-local UI state only: nothing here reaches the engine or the grid
   * protocol, and the read-only pipeline preview receives neither prop.
   */
  const [gridSorting, setGridSorting] = useState(false)
  const [gridFiltering, setGridFiltering] = useState(false)
  const gridBusy: GridQueryBusy | null = gridFiltering
    ? 'filtering'
    : gridSorting
      ? 'sorting'
      : null
  /**
   * A new dataset (model identity) retires both epochs: the previous session's
   * in-flight sort/filter can never describe the new grid. This is the same
   * per-session boundary the editing/query state already follows.
   */
  const gridModel = phase.kind === 'ready' ? phase.model : null
  useEffect(() => {
    setGridSorting(false)
    setGridFiltering(false)
  }, [gridModel])
  /**
   * m4-5 export dialog visibility: a retirable App-local request slot (declared
   * with the others above; the session owner retires it on every boundary).
   * Closing unmounts the dialog, so its format choice and result reset on every
   * open (no stale "Exported…" line from a previous session). The dialog itself
   * never touches the base source (ADR 0012).
   */

  /**
   * The App-owned editor-state authority (S-A2-1/IC-01). `DataGrid` writes it
   * synchronously at every editor transition; the gesture gate reads it and
   * never a render value.
   */
  const editorStateRef = useRef<EditorReportState>({ open: false, invalid: false })
  /** C9's progress element, focused explicitly when the region goes inert. */
  const replaceProgressRef = useRef<HTMLDivElement | null>(null)
  /**
   * EW-03I-b: one-shot hand-off into the single open chain — the picked file,
   * its identity and (for a reviewed CSV) the exact reviewed option set. Set
   * only by the review path and cleared before the chain's first await, the
   * same one-shot discipline as `exampleFileRef`/`pendingDropFileRef`.
   * `options === undefined` means the ordinary open (a non-.csv pick from the
   * review control keeps today's path byte-identically).
   */
  const pendingReviewHandoffRef = useRef<CsvAdoptionHandoff | null>(null)

  /**
   * rd-7 (D-03): the ONE global Help surface, plus the telemetry Settings
   * panel's open state. Both are component-local UI state — no session, no
   * engine, no telemetry event — and `settingsOpen` exists only so App can
   * arbitrate modal ownership: the guide's opener is disabled while any other
   * owned surface is open (Settings is a non-modal panel, so nothing else
   * would stop a second dialog opening on top of it).
   */
  const [helpOpen, setHelpOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  /**
   * UI-RD-01 app-local navigation state. Neither value is session data: the
   * active task exposes its sections at ≥1024px (CSS) and opens its manageable
   * sections, and the jump-origin marker only offers the return chip. Both
   * reset when a new dataset session starts, and neither reaches the
   * engine/hooks.
   */
  const [activeTask, setActiveTask] = useState<WorkbenchTaskId>(DEFAULT_WORKBENCH_TASK)
  const [jumpOrigin, setJumpOrigin] = useState<'validation' | 'diff' | null>(null)
  useEffect(
    () =>
      datasetSession.registerReset(() => {
        setActiveTask(DEFAULT_WORKBENCH_TASK)
        setJumpOrigin(null)
      }),
    [datasetSession],
  )

  /**
   * rd-3b focus guard (one of the two pieces of behaviour conditional exposure
   * adds; the other is the rd-3c durable-edit-error reveal, which lives with
   * the editing session below because it reads `editError`).
   *
   * At ≥1024px the inactive tasks' sections are `display: none`, which removes
   * a focused descendant from the tab order and drops focus to `<body>`. Mouse
   * and keyboard task selection already leave focus on the checked radio
   * (TaskNav focuses it), and the reveal seams focus their own target, so this
   * only covers a PROGRAMMATIC change of the outgoing task while focus sits
   * inside one of its panels. After the change commits, if the focused element
   * now lives in a section the layout does not render, focus the checked radio.
   *
   * The check asks the layout (`getComputedStyle`) instead of re-deriving the
   * media query and the task rule in JS, so the CSS stays the single source of
   * exposure truth and this guard is inert below 1024px. No announcement, no
   * scroll, no focus trap, no new state.
   */
  useEffect(() => {
    const active = document.activeElement
    if (!(active instanceof HTMLElement)) return
    const section = active.closest('.workbench-section')
    if (section === null) return
    if (window.getComputedStyle(section).display !== 'none') return
    document.getElementById(`task-${activeTask}`)?.focus()
  }, [activeTask])

  /**
   * q-15 tool-pane state. Component-local shell state ONLY (ADR 0044
   * negative-consequence discipline): nothing here reaches the engine, the grid
   * model, or any session hook, and the grid's first paint is unchanged.
   *
   * `openSections` is the pane's non-exclusive disclosure set. First paint
   * expands exactly one tool section (Schema, an inner-disclosure section whose
   * own control defaults open) while the managed tool sections start collapsed;
   * expanding one never collapses another, so a validate→jump→edit round-trip
   * can have several tools open at once (the spec §3 escape hatch, recorded in
   * the q-15 row report). The grid is the persistent center and starts open; the
   * record dock has no shell toggle (it is grid-linked state, not a pane peer).
   */
  const [openSections, setOpenSections] = useState<ReadonlySet<WorkbenchSectionId>>(
    () => new Set<WorkbenchSectionId>(['grid']),
  )
  const toggleSection = useCallback((id: WorkbenchSectionId) => {
    setOpenSections((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const openSection = useCallback((id: WorkbenchSectionId) => {
    setOpenSections((previous) => (previous.has(id) ? previous : new Set(previous).add(id)))
  }, [])
  /**
   * ug-7/R-07 recovery-only visibility override for inner-disclosure sections
   * (Schema/Filters/Profile). Their own control remains the normal disclosure;
   * this set exists only so a failed panel's "Close section" can hide the
   * parent body without adding a duplicate shell toggle. A new dataset clears
   * it and the section's existing nav link clears it on reopen.
   */
  const [recoveryHiddenSections, setRecoveryHiddenSections] = useState<
    ReadonlySet<WorkbenchSectionId>
  >(() => new Set<WorkbenchSectionId>())
  const closeSection = useCallback((id: WorkbenchSectionId) => {
    if (INNER_DISCLOSURE_SECTIONS.has(id)) {
      setRecoveryHiddenSections((previous) => {
        if (previous.has(id)) return previous
        return new Set(previous).add(id)
      })
    } else {
      setOpenSections((previous) => {
        if (!previous.has(id)) return previous
        const next = new Set(previous)
        next.delete(id)
        return next
      })
    }
    // "Close section" hands focus to the section's EXISTING nav link; the
    // retained fallback stays mounted (hidden) so reopening never retries
    // implicitly.
    document.querySelector<HTMLElement>(`[data-testid="section-nav-${id}"]`)?.focus()
  }, [])
  /**
   * rd-3c review fix (CR-1): a programmatic reveal is not a link, so the
   * browser never performs a section anchor's own scroll — the scroll a link
   * click produces comes from its `href`, which `revealSectionFromNav` does
   * not navigate to. An opted-in reveal (see the seam below) therefore records a
   * request here and this effect (the same render-then-act shape as
   * `panelFocus`) scrolls the SECTION element into view once the commit has
   * activated the task and expanded the section — `.workbench-section` keeps
   * its `scroll-margin-top`, so the pinned nav never covers the heading.
   * Scrolling only: no focus call, no `focus({ preventScroll })` trick, no new
   * navigation mechanism. The request is keyed by `seq`, so exactly the call
   * that asked for it scrolls: an unrelated re-render, a re-reveal of the same
   * error, or the user scrolling the pane afterwards never re-scrolls.
   */
  const [revealScroll, setRevealScroll] = useState<{ id: WorkbenchSectionId; seq: number } | null>(
    null,
  )
  useEffect(() => {
    if (revealScroll === null) return
    const section = document.getElementById(`section-${revealScroll.id}`)
    if (section === null) return
    if (typeof section.scrollIntoView === 'function') section.scrollIntoView({ block: 'start' })
  }, [revealScroll])
  const revealSectionFromNav = useCallback(
    (
      id: WorkbenchSectionId,
      // Opt-in scroll: every existing caller omits it and is behaviourally
      // unchanged (a section-link click already scrolls through its `href`).
      options: { readonly scroll?: boolean } = {},
    ) => {
      // Task-aware reveal: a nested action, a pipeline cross-link or a
      // section-link click first exposes the owning task, then expands and
      // anchors the section. Switching the task is presentation only.
      const task = taskOfSection(id)
      if (task !== null) setActiveTask(task)
      setRecoveryHiddenSections((previous) => {
        if (!previous.has(id)) return previous
        const next = new Set(previous)
        next.delete(id)
        return next
      })
      openSection(id)
      // A link click scrolls itself; a programmatic reveal asks explicitly.
      if (options.scroll === true) {
        setRevealScroll((previous) => ({ id, seq: (previous?.seq ?? 0) + 1 }))
      }
    },
    [openSection],
  )
  /**
   * Render-then-focus seam for reveal actions (ug-9/R-15 and the context bar).
   * A sequence state commits AFTER the shell has activated the task and
   * expanded the section, so the target exists and is visible when focused.
   * It adds no navigation mechanism and performs no DOM move.
   */
  const [panelFocus, setPanelFocus] = useState<{ testId: string; seq: number } | null>(null)
  const focusPanel = useCallback((testId: string) => {
    setPanelFocus((previous) => ({ testId, seq: (previous?.seq ?? 0) + 1 }))
  }, [])
  useEffect(() => {
    if (panelFocus === null) return
    const panel = document.querySelector<HTMLElement>(`[data-testid="${panelFocus.testId}"]`)
    if (panel === null) return
    if (typeof panel.scrollIntoView === 'function') panel.scrollIntoView({ block: 'start' })
    panel.focus()
  }, [panelFocus])
  /**
   * q-15 pane rail state: ≥1024px the tool pane collapses to a rail (the
   * center column stays put). Below 1024px the pane head is hidden and the
   * single-column stack always shows every section.
   */
  const [paneCollapsed, setPaneCollapsed] = useState(false)
  /**
   * D02c — the two **adopted source slots** are session-owned state now
   * (`openSourceRef`, `sourceIdentityRef` on the owner above). Both are
   * published only by a ready frame and cleared at the next session start:
   *
   * - `sourceIdentityRef` is the export same-source guard's identity (m4-5 fix
   *   round): only FSA opens retain one (the handle's authoritative
   *   `isSameEntry`), so an open without a retained handle is never offered a
   *   direct-write destination at all (round 2). Never rendered or logged
   *   (ADR 0025).
   * - `openSourceRef` is the opened `File` retained so a pipeline source node
   *   can bind it with no second OS picker (ug-9/R-15). A reference only — no
   *   bytes are read here — and deliberately NOT the export identity: a plain
   *   `File` has no `FileSystemHandle`, so it can never prove same-entry. The
   *   name reaches the engine for format detection only.
   * - `panelModules` (au3-12) is the resolved below-fold panel set; the owner
   *   publishes it from the open chain's or the adopted candidate's resolve,
   *   before the `ready` render, so the grid and panels mount in one render.
   *   (See `lib/bottom-panels.ts` for why these live in state, not `React.lazy`.)
   */

  /**
   * m3-5 nested-action dispatch: both click surfaces (schema tree, grid
   * headers) emit a `NestedAction`; the app composes it through m3-4's pure
   * composer against the parsed schema and the SQL-facing view name, then
   * hands the SQL to the m2-4 pane via `sqlRequest` (a retirable request slot
   * declared above).
   */
  const requestSeq = useRef(0)
  /**
   * R-07: App-owned, session-scoped consumption state. The ledger instance
   * (not the SQL pane) decides whether an external request is new; see the
   * `SqlRequestLedger` contract above. It is stable for the App lifetime.
   */
  const sqlRequestLedger = useMemo(() => createSqlRequestLedger(), [])
  const claimSqlRequest = useCallback(
    (request: SqlRunRequest) => sqlRequestLedger.claim(request, currentToken()),
    [currentToken, sqlRequestLedger],
  )
  useEffect(
    () =>
      datasetSession.registerReset(() => {
        // A replacement dataset drops every claim and every recovery-only
        // visibility override. The request state itself is nulled by the open
        // flow, so a stale request can never be replayed in the new session.
        sqlRequestLedger.reset()
        setRecoveryHiddenSections((previous) =>
          previous.size === 0 ? previous : new Set<WorkbenchSectionId>(),
        )
      }),
    [datasetSession, sqlRequestLedger],
  )

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
    castPendingColumns,
    castPendingColumnsRef,
    castPendingCount,
    mutationStateRef,
    mutationPending,
    historyRef,
    overlayRef,
    announceEdit,
    publishEmptyBase,
    snapshotOverlay,
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
  } = useEditingSession(phase, datasetSession, sourceIdentityRef)

  /**
   * D02c — the grid publication ports the session owner uses at a transition.
   * Both commands belong to the history/overlay owner (`useEditingSession`);
   * they are memoized here so the owner can hold them in its dependency list
   * without a mutable port slot (`App` stays the composition root; the owner
   * never writes another module's state).
   */
  const grid = useMemo<SessionGridPorts>(
    () => ({ publishEmptyBase, snapshotOverlay }),
    [publishEmptyBase, snapshotOverlay],
  )

  /**
   * EW-04I: the column-repair surface's seam into the live editing session.
   *
   * Every read below is answered from the session's own snapshot — the base
   * metadata, the active ops at the history cursor and the effective schema —
   * so a preview describes exactly the relation the grid is showing, and
   * `captureRepairTag`/`handleApplyRepair` (owned by the session hook, which
   * holds the live refs) make the capture and the publication check the same
   * measurement. `facts` reads the memoized fold (a render-path read: it is
   * called on every render for the budget projection), while the rules that
   * decide refusals read the live refs at the moment they run.
   */
  const repairSeam = useMemo<RepairSeam>(
    () => ({
      facts: () => {
        if (phase.kind !== 'ready' || overlayState === null) return null
        return {
          liveRows: liveRowCount(phase.base, overlayState),
          repairPairs: overlayState.repairs.reduce(
            (total, record) => total + record.mapping.size,
            0,
          ),
        }
      },
      captureTag: captureRepairTag,
      validatePlan: (plan) => {
        if (phase.kind !== 'ready') return null
        return validateRepairPlan(phase.base, stateAtCursor(phase.base, historyRef.current), plan)
      },
      readPreview: (plan) => {
        if (phase.kind !== 'ready') {
          return Promise.reject(new Error('no table is open'))
        }
        const live = historyRef.current
        return readRepairPreview(
          {
            handle: phase.handle,
            overlay: overlaySnapshot(phase.base, live),
            snapshot: {
              viewName: viewNameForTableId(phase.tableId),
              base: phase.base,
              state: stateAtCursor(phase.base, live),
            },
          },
          plan,
        )
      },
      apply: handleApplyRepair,
    }),
    [phase, overlayState, captureRepairTag, handleApplyRepair, historyRef],
  )

  /**
   * EW-04I: the repair surface's own state (capture → preview → Apply). App
   * owns it so the dialog's lifecycle is independent of the editing panel's
   * disclosure state, and so a late preview result is dropped by the hook's
   * generation guard rather than by a component that might be unmounted.
   */
  const repairPreview = useRepairPreview(repairSeam)

  /**
   * rd-3c: durable edit feedback from any task.
   *
   * The durable `edit-error` (engine rejection, cast refusal, non-applied op)
   * lives in the Editing section, which is a Change-task surface, so since
   * rd-3b a rejection raised while another task is active would be invisible —
   * a sighted user editing a typed/temporal cell from Explore saw a silent
   * revert. When the error TRANSITIONS to a non-null value, reveal the Editing
   * section through the existing seam (activate Change, expand, and — the
   * review fix — scroll the section into view, which a programmatic reveal
   * does not get for free) and deliberately do NOT move focus: the grid keeps
   * the user's editing position and roving stop. `revealedEditErrorRef` makes that once per error — it
   * starts at the mount value (a pre-existing error is never revealed) and
   * resets when the error clears (a new attempt/commit clears it in the
   * session hook), so a user who returns to Explore with the error still on
   * record is not yanked back. The no-op case (Change already active with
   * Editing already open) is skipped so nothing scrolls when nothing would
   * change. Nothing else moves: same messages, same sources, same clearing
   * behaviour, no second render of the text.
   */
  const revealedEditErrorRef = useRef<string | null>(editError)
  useEffect(() => {
    if (editError === null) {
      revealedEditErrorRef.current = null
      return
    }
    if (revealedEditErrorRef.current === editError) return
    revealedEditErrorRef.current = editError
    if (activeTask === 'change' && openSections.has('editing')) return
    revealSectionFromNav('editing', { scroll: true })
  }, [editError, activeTask, openSections, revealSectionFromNav])

  /**
   * m5-3/m6-4 jump-to-row gesture. Owned by the composition root because the
   * validation and diff panels share it: both resolve a logical row key, then
   * scroll the grid, open the record inspector and land roving focus on the
   * target row through `navigateToRow`.
   *
   * ug-12 (UG-26): a sample gesture also carries the domain display key, so
   * the SAME single polite live region that announces edit outcomes states
   * `Showing <displayKey> in the grid and record inspector` — value-free row
   * identity only (ADR 0025). The announcement lives here, after the editing
   * session supplies `announceEdit`, so no second region or announcement
   * mechanism is introduced. A jump without a label (no caller supplies one
   * today) still navigates, silently. The scroll request slot itself is
   * declared with the other retirable request slots at the top of `App`.
   */
  const navigateToRow = useCallback(
    (rowIndex: number, displayKey?: string) => {
      scrollSeq.current += 1
      setScrollRequest({ rowIndex, seq: scrollSeq.current })
      setRecordRequest((previous) => ({
        rowIndex,
        seq: (previous?.seq ?? 0) + 1,
      }))
      const announcement = rowJumpAnnouncementText(displayKey)
      if (announcement !== null) announceEdit(announcement)
    },
    [announceEdit],
  )

  /**
   * rd-4: the validation and diff jump channels record WHICH panel the user
   * came from, so the context bar can offer an accurate `Back to findings`.
   * Record stepping deliberately uses `navigateToRow` directly and never sets
   * an origin. This is app-local UI state, not captured run metadata.
   */
  const jumpToValidationFinding = useCallback<NavigateToRow>(
    (rowIndex, displayKey) => {
      setJumpOrigin('validation')
      navigateToRow(rowIndex, displayKey)
    },
    [navigateToRow],
  )
  const jumpToDiffFinding = useCallback<NavigateToRow>(
    (rowIndex, displayKey) => {
      setJumpOrigin('diff')
      navigateToRow(rowIndex, displayKey)
    },
    [navigateToRow],
  )

  /**
   * ug-11 (UG-12): the record dock's ◀ Prev / ▶ Next gesture. Stepping is the
   * SAME navigate gesture a panel jump uses — one record request plus one grid
   * scroll request — with no display label, so it stays silent: ug-12's
   * announcement copy is for the validation/diff "Show row" jumps only, and
   * stepping inside an already-open dock is not a navigation the user has to
   * be told about. The dock decides WHICH row (the immediate neighbour, or
   * disabled at a bound/error slot); this seam only applies it. Stable identity
   * so the memoized inspector does not re-render on every App render.
   */
  const stepRecord = useCallback(
    (rowIndex: number) => {
      navigateToRow(rowIndex)
    },
    [navigateToRow],
  )

  /**
   * ug-6 (UG-10): the shell's document-level Undo/Redo shortcuts. One
   * `window` keydown listener maps Ctrl/Cmd+Z → the editing session's existing
   * `handleUndo` and Ctrl/Cmd+Shift+Z / Ctrl/Cmd+Y → its existing `handleRedo`.
   * These are SHORTCUTS for the single visible pair in `HistoryPanel` (ux-3
   * ruling) — no second control pair, no toolbar addition. The phase is read
   * from the synchronous `phaseRef` mirror, so the listener stays registered
   * across phase changes (and is removed on unmount) without a stale closure.
   *
   * `classifyHistoryShortcut` owns every guard: ready-only is enforced here,
   * the classifier rejects modifiers we do not own, already-prevented events,
   * and any editable target — Ctrl+Z inside the cell editor, the SQL editor or
   * a filter input keeps the browser's native text undo, and the event is not
   * prevented.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (phaseRef.current.kind !== 'ready') return
      const action = classifyHistoryShortcut(event)
      if (action === null) return
      event.preventDefault()
      if (action === 'undo') handleUndo()
      else handleRedo()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [handleRedo, handleUndo, phaseRef])

  /**
   * ug-6 (UG-10) history surface cue: auto-expand the History section on the
   * FIRST appended operation only (0 → >0 entries). Undo/redo are cursor
   * moves that never change `entries.length`, a dataset open/reset moves it
   * down to 0, and `historyCueSpentRef` makes the cue one-shot — so once the
   * user collapses History it never re-opens on later appends. `openSection`
   * is the existing disclosure seam: no new control, badge token or visible
   * Undo/Redo pair (ux-3), and the ug-17 `History · N pending` summary is
   * untouched.
   */
  const previousHistoryLengthRef = useRef(history.entries.length)
  const historyCueSpentRef = useRef(false)
  useEffect(() => {
    const previousEntries = previousHistoryLengthRef.current
    const nextEntries = history.entries.length
    previousHistoryLengthRef.current = nextEntries
    const expand = shouldAutoExpandHistory({
      previousEntries,
      nextEntries,
      alreadyCued: historyCueSpentRef.current,
    })
    if (!expand) return
    historyCueSpentRef.current = true
    openSection('history')
  }, [history.entries.length, openSection])

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
    handleContractDocument,
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
    navigateToRow: jumpToValidationFinding,
  })

  /**
   * p-5 pipeline session: open a pipeline file (real picker path), bind its
   * source datasets per node (C2), and run it on the engine (serialized at the
   * UI level + guard cancellation — the runner has no re-entrancy guard of its
   * own by design).
   *
   * p2-6 made previews grid-native: a materialized node's relation opens
   * through the p2-1 `registerPipelineRelation` handle op and drives the SAME
   * handle-based grid model a dataset open uses (the panel renders it with the
   * existing `DataGrid`). Nothing is pushed into the SQL pane's result surface
   * — that detour is retired (CO-1, ug-23: this block used to claim the jump).
   * Two later additions belong to the panel/session pair, not to App: the
   * `data-bind-revision` contract-bind ordinal (a contract replacement is
   * observable without rendering any file, path or contract content — ADR
   * 0025) and the ug-9/R-15 gate cross-link, wired below as `onInspectContract`
   * to `inspectPipelineContractInValidation`.
   *
   * Entirely dataset-session scoped: the reset registered inside the hook drops
   * everything on a new file open.
   */
  const pipeline = usePipelineSession({
    session: datasetSession,
    sourceIdentityRef,
    openSourceRef,
    // ug-9/R-15: the validation session's parsed contract, offered to
    // validate nodes as the no-picker primary binding.
    loadedContract: contractState.kind === 'loaded' ? contractState.contract : null,
  })

  /**
   * ug-9/R-15 (b): "Inspect this contract in Validation" from a failed
   * validate gate. It loads the RUN's snapshot contract (the one the run
   * started with, passed in by the panel) into the validation session with no
   * picker, reveals + expands the Validation section, and focuses it — so the
   * user's next Validate names the failing ruleIds instead of re-picking
   * artifacts. Resolving the live node binding here would load a NEW binding
   * after a re-bind and misattribute the failure. Loading is NOT validating:
   * `handleValidate` stays the explicit click and no engine call happens here.
   */
  const inspectPipelineContractInValidation = useCallback(
    (contract: ContractV1) => {
      handleContractDocument(contract)
      revealSectionFromNav('validation')
      focusPanel('validation-panel')
    },
    [handleContractDocument, revealSectionFromNav, focusPanel],
  )

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
    navigateToRow: jumpToDiffFinding,
  })

  /**
   * rd-3/rd-4 context bar: one pure derivation from state the App already
   * owns. The contract kind is normalised (unreadable folds parse/too-large/
   * read-failed), and the failing-rule count is read from the current verdict
   * only. The bar never runs anything; the action below calls the SAME
   * handlers the panels use.
   */
  const contractAction: NextActionContract =
    contractState.kind === 'loaded'
      ? 'loaded'
      : contractState.kind === 'none'
        ? 'none'
        : 'unreadable'
  const nextAction = deriveNextAction({
    contract: contractAction,
    validation: validationRun.kind as NextActionValidation,
    validationStale,
    failingRules: failingRuleCount(validationRun),
    diff: diffRun.kind as NextActionDiff,
    diffStale,
  })

  const revealContextPanel = useCallback(
    (section: WorkbenchSectionId, testId: string) => {
      revealSectionFromNav(section)
      focusPanel(testId)
    },
    [revealSectionFromNav, focusPanel],
  )
  /**
   * A task choice frames the work: at ≥1024px it exposes the task's sections
   * (the others stay mounted behind `display: none`) and opens its
   * shell-managed sections so the tools are ready where the choice points. It
   * never unmounts a panel, never touches the session, and never moves focus
   * into content. Inner disclosures (Schema/Filters/Profile) keep their own
   * state.
   */
  const handleSelectTask = useCallback(
    (task: WorkbenchTaskId) => {
      setActiveTask(task)
      for (const id of sectionsForTask(task)) {
        if (!INNER_DISCLOSURE_SECTIONS.has(id)) openSection(id)
      }
    },
    [openSection],
  )
  const handleBackToFindings = useCallback(() => {
    const origin = jumpOrigin
    setJumpOrigin(null)
    if (origin === 'diff') revealContextPanel('compare', 'diff-run')
    else revealContextPanel('validation', 'validation-panel')
  }, [jumpOrigin, revealContextPanel])

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
  /** Guards `app_boot` against React StrictMode's double mount effect. */
  const appBootEmittedRef = useRef(false)
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
   * Telemetry: `app_boot` once per boot, after the opt-out + endpoint gates
   * (design §2/Appendix C), plus a fire-and-forget exit flush. `os_family` is
   * a coarse enum; the raw platform string never leaves this expression
   * (ADR 0025/D8). The exit flush uses `keepalive` and never blocks unload
   * (R9).
   */
  useEffect(() => {
    // StrictMode runs mount effects twice in development; emit `app_boot`
    // exactly once per App instance (the ref survives the double-invoke).
    if (!appBootEmittedRef.current) {
      appBootEmittedRef.current = true
      telemetry.emit('app_boot', {
        engine_family: 'duckdb_wasm',
        os_family: classifyOsFamily(typeof navigator === 'undefined' ? '' : navigator.userAgent),
        build_channel: telemetryConfig.buildChannel,
      })
    }
    const flushOnExit = (): void => {
      void telemetry.flush()
    }
    window.addEventListener('pagehide', flushOnExit)
    return () => {
      window.removeEventListener('pagehide', flushOnExit)
      telemetry.dispose()
    }
  }, [telemetry, telemetryConfig])

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
      // ug-1/R-01: a successful one-click nested action must reveal its
      // outcome. Reuse the shell's existing section seam and rail state — no
      // nav click, no DOM relocation. The request itself is still what the
      // SQL pane runs; the pane owns the post-render scroll/focus (sequence
      // tied, see SqlPanel).
      openSection('sql')
      setPaneCollapsed(false)
      requestSeq.current += 1
      setSqlRequest({
        sql: composed.sql,
        seq: requestSeq.current,
        // Stamped with the live dataset session: a request that outlives its
        // session can be rejected synchronously by the App-owned ledger.
        session: currentToken(),
      })
    },
    [currentToken, nestedSpecs, openSection, phase],
  )

  /**
   * ug-16 profile click-to-act bridge. The profile is base-derived (R-16), the
   * grid runs on the overlay-effective view — so a click is planned against
   * the *active ops at the history cursor* and the *effective schema* before
   * anything is compiled or applied:
   *
   * - `refuse` (renamed / unresolved / builder rejection) applies no filter,
   *   changes no filter state, makes no engine call, and renders the planner's
   *   single-line, value-free message in the profile's refusal slot;
   * - `apply` compiles through the existing grid builder against the effective
   *   column type, then replaces that column's filter with
   *   `replaceColumnFilter` + `model.setFilters` (the FilterBar path, chips
   *   included — no new chip code). C02b: a rejection is mapped from the
   *   model's `FilterApplyError.phase` to the shared, value-free copy
   *   (`filter-failure.ts`); the model is the single owner of restoration, so
   *   this bridge issues exactly one `setFilters` per attempt and never a
   *   compensating `setFilters(previous)`.
   *
   * The refusal/error feedback is cleared on the next click, a profile re-run
   * (the panel calls `clearProfileFilterFeedback`), undo/redo (cursor move),
   * and a new dataset — the copy always describes the state it was computed
   * against. Nothing here re-profiles, remaps, coerces, or logs.
   *
   * **Apply lifecycle (round 2).** Two independent guards keep an async tail
   * from invalidating current state:
   *
   * 1. *Single-flight* (the `FilterBar.applyList` precedent): while one apply
   *    is in flight the panel's filter controls are disabled
   *    (`profileFilterPending`) and a further click is ignored, so an
   *    unrelated later action cannot race this attempt's feedback.
   *    `GridViewportModel.setFilters` serializes calls last-request-wins and
   *    reconciles superseded runs to the published list itself (R-C01), so no
   *    caller-side rollback is needed or allowed.
   * 2. *Attempt/session identity*: every attempt captures its token, its
   *    originating model and the dataset-session token; after EVERY `await`
   *    the attempt must still be the current one on the live session and the
   *    originating model must still be active, otherwise the completion is a
   *    silent no-op — no feedback, no filter write. This is what stops a late
   *    rejection from a previous dataset (or from before an undo/redo cursor
   *    move) resurrecting feedback on the session that replaced it.
   */
  const [profileFilterRefusal, setProfileFilterRefusal] = useState<string | null>(null)
  const [profileFilterError, setProfileFilterError] = useState<string | null>(null)
  const [profileFilterPending, setProfileFilterPending] = useState(false)
  /** Monotonic identity of the current apply attempt (bumped on each begin). */
  const profileFilterAttemptRef = useRef(0)
  /** Synchronous single-flight gate (state alone is a render behind). */
  const profileFilterPendingRef = useRef(false)
  const clearProfileFilterFeedback = useCallback(() => {
    setProfileFilterRefusal(null)
    setProfileFilterError(null)
  }, [])
  const activeTableId = phase.kind === 'ready' ? phase.tableId : null
  useEffect(() => {
    // A new dataset (model identity), a cursor move (undo/redo) or a phase
    // change invalidates any in-flight apply: its late completion must be a
    // no-op (design §4.2 — the feedback clears on undo/redo and new data).
    profileFilterAttemptRef.current += 1
    profileFilterPendingRef.current = false
    setProfileFilterPending(false)
    clearProfileFilterFeedback()
  }, [activeModel, activeTableId, clearProfileFilterFeedback, history.cursor])

  const applyProfileFilter = useCallback(
    (baseColumn: string, intent: ProfileFilterIntent): void => {
      // Single-flight: an apply already in flight owns the transition.
      if (profileFilterPendingRef.current) return
      clearProfileFilterFeedback()
      if (phase.kind !== 'ready') return
      const plan = planProfileFilter(
        baseColumn,
        intent,
        activeOps(history),
        modelSchema ?? NO_COLUMNS,
      )
      if (plan.kind === 'refuse') {
        setProfileFilterRefusal(plan.message)
        return
      }
      const originModel = phase.model
      const originSession = currentToken()
      const next = replaceColumnFilter(originModel.filters, plan.column, plan.predicate)
      const attempt = (profileFilterAttemptRef.current += 1)
      /**
       * True only while this attempt is still the current one, on the live
       * dataset session, with its originating model still active. Checked
       * after every `await`: a superseded attempt must not touch either
       * filters or feedback.
       */
      const isCurrentAttempt = (): boolean => {
        if (profileFilterAttemptRef.current !== attempt) return false
        if (!isCurrentSession(originSession)) return false
        const live = phaseRef.current
        return live.kind === 'ready' && live.model === originModel
      }
      profileFilterPendingRef.current = true
      setProfileFilterPending(true)
      void (async () => {
        try {
          await originModel.setFilters(next)
        } catch (cause) {
          // A superseded attempt's rejection is swallowed: the model already
          // reconciled the provider to the published list (R-C01), so there is
          // nothing to undo and its report would describe a state the user has
          // already left.
          if (!isCurrentAttempt()) return
          // One `setFilters` per attempt (C02b): the phase-derived copy only.
          // `accepted-reload-failed` never claims a rollback happened, and
          // `restore-failed` states the unknown state it actually is.
          setProfileFilterError(filterFailureCopy(cause).message)
        } finally {
          // Only the current attempt may release the gate; a superseded one
          // leaves the pending state to whoever invalidated it.
          if (isCurrentAttempt()) {
            profileFilterPendingRef.current = false
            setProfileFilterPending(false)
          }
        }
      })()
    },
    [
      clearProfileFilterFeedback,
      currentToken,
      isCurrentSession,
      history,
      modelSchema,
      phase,
      phaseRef,
    ],
  )

  /**
   * `validation_run` (design §2/Appendix C): emitted once a run settles —
   * verdict, binding error, engine failure, or abort. The duration is
   * measured from the `running` transition; the counts are value-free (rule
   * count + coarse finding bucket), never rule/column text (ADR 0025).
   */
  const validationStartedAtRef = useRef<number | null>(null)
  useEffect(() => {
    if (validationRun.kind === 'running') {
      validationStartedAtRef.current = Date.now()
      return
    }
    if (validationRun.kind === 'idle') {
      validationStartedAtRef.current = null
      return
    }
    const startedAt = validationStartedAtRef.current ?? Date.now()
    validationStartedAtRef.current = null
    const report = validationRun.kind === 'verdict' ? validationRun.report : null
    telemetry.emit('validation_run', {
      checks_run: report?.rows.length ?? 0,
      finding_count_bucket: bucketFindingCount(
        report?.rows.reduce((sum, row) => sum + row.failCount, 0) ?? 0,
      ),
      duration_bucket: durationSince(startedAt),
      outcome: validationOutcome(validationRun),
    })
  }, [validationRun, telemetry])

  /**
   * `diff_run` (design §2/Appendix C): emitted once a diff settles. Only the
   * `key_mode` enum (how keys were chosen) is sent — never the key column
   * names (ADR 0025/R4).
   */
  const diffStartedAtRef = useRef<number | null>(null)
  useEffect(() => {
    if (diffRun.kind === 'running') {
      diffStartedAtRef.current = Date.now()
      return
    }
    if (diffRun.kind === 'idle') {
      diffStartedAtRef.current = null
      return
    }
    const startedAt = diffStartedAtRef.current ?? Date.now()
    diffStartedAtRef.current = null
    telemetry.emit('diff_run', {
      aspects_count: diffRun.kind === 'result' ? 3 : 0,
      key_mode:
        diffRun.kind === 'result'
          ? diffRun.report.keySource === 'inferred'
            ? 'inferred'
            : 'explicit'
          : 'none',
      duration_bucket: durationSince(startedAt),
      outcome: diffRunOutcome(diffRun),
    })
  }, [diffRun, telemetry])

  // `query_run` for the grid's filter/sort paths is deliberately NOT emitted
  // here: the app-level filter/sort seam only sees the request transition, so
  // the previous emission fabricated `duration_bucket: lt_50ms` and
  // `outcome: 'success'` at request time, not at settle. The grid model does
  // not expose a genuine settle notification without re-subscribing to the
  // full model version (q-1 forbids that), so honest absence beats false data
  // until a settle seam exists (recorded t-2 carry-over). SQL/nested/paging
  // `query_run` are emitted from the SQL pane where the run actually settles.

  /**
   * p2-6: the pipeline panel owns its grid-native preview through the p2-1
   * `registerPipelineRelation` handle op (see `usePipelineSession`). The
   * former SQL-result detour is retired: a materialized relation now opens
   * through the SAME handle-based grid model a dataset open uses, never
   * through a composed `SELECT *` on the SQL pane.
   */
  const handleRecordClosed = useCallback(() => {
    setRecordRequest(null)
  }, [])

  /** One-shot file source consumed by the normal open flow for the idle example action. */
  const exampleFileRef = useRef<File | null>(null)

  /**
   * ug-15: a file dropped on the idle shell is parked here for exactly one
   * consumption by `openDataFile` — the same one-shot precedent as the idle
   * example. The window drop listener only fills it while idle; the open flow
   * clears it before its first await, so a stale drop can never seed a later
   * picker open.
   */
  const pendingDropFileRef = useRef<File | null>(null)

  /**
   * ug-21: cancelling an in-flight open is the session owner's command
   * (`cancelOpen` below): it starts a new (empty) session, runs every registered
   * reset, publishes `idle`/the fault frame, and the open chain's post-await
   * token comparisons drop the late result. There is no engine interrupt in the
   * protocol, so this is an honest UI reset + token discard, never a claimed
   * abort.
   */

  /* ---------------------------------------------------------------------
   * WF-06 — session-preserving replacement (the reviewed v5 lifecycle).
   *
   * D02b: the acquisition / preparation / currency half of a ready-state
   * replacement lives in the app-local replacement controller
   * (`replace/useReplacementController.ts`). It consumes the explicit ports
   * below and returns commands + renderable state; it reuses the existing
   * `replace/machine` + `replace/gate` modules and never writes a session
   * slot, a history/overlay ref or a `Phase`.
   *
   * App stays the composition root: the ONE irreversible step —
   * `adoptReplacement` — is defined here and is called by the controller at
   * most once per candidate, after the controller's own step-0 currency
   * check. The legacy idle/example/drop/retry/cancel chain below is
   * unchanged; a cancelled chooser or a failed candidate leaves every live
   * session slot untouched (T3/T4/T6/T9/T9b/T10).
   * ------------------------------------------------------------------- */

  /**
   * The candidate's provider + model. The controller passes an overlay source
   * that reads the CANDIDATE-LOCAL box it builds from the candidate's own base
   * (A1-1); the provider is rebound to the live session only in
   * `adoptReplacement` (A1-3).
   */
  const createCandidateGrid = useCallback(
    (input: {
      readonly handle: EngineTableHandle
      readonly overlaySource: () => ReturnType<typeof overlaySnapshot>
    }) => {
      const provider = new DuckDbGridProvider(engineClient, input.handle, input.overlaySource)
      const model = new GridViewportModel(provider)
      return { provider, model }
    },
    [],
  )

  /**
   * D02c — the one irreversible step, as a **port** for the replacement
   * controller. Steps 1–8 (session reset → history/overlay publication →
   * provider rebind → source slots → panels → ready + request retirement →
   * `dataset_opened`) live in the session owner; this call site only bounds the
   * controller's exactly-once call to it with the same grid publication ports
   * the open chain uses (`App` stays the composition root). The controller's
   * step 0 (`canAdopt`) has already refused a superseded candidate, so reaching
   * this function means exactly one adoption for this candidate.
   */
  const adoptReplacement = useCallback(
    (candidate: ReplacementCandidate) => adoptSession(candidate, grid),
    [adoptSession, grid],
  )

  /**
   * D02b — the app-local replacement controller. Every dependency is a named
   * port (no registry): the synchronous authority refs, the picker, the engine
   * operations, the candidate grid factory, the panel preload and App's
   * exactly-once adoption. The volatile gate readings (`gateModal`,
   * `gridBusy`) travel with the gesture that consumes them, because they are
   * render values rather than authorities.
   */
  const replacement = useReplacementController({
    phaseRef,
    editorStateRef,
    mutationStateRef,
    castPendingColumnsRef,
    historyRef,
    pickFile: pickDataFile,
    engine: engineClient,
    createCandidateGrid,
    preloadPanels: preloadBottomPanels,
    adopt: adoptReplacement,
  })
  const {
    intent,
    pickerWasCancelled,
    replacementFailure,
    busyNotice,
    draftNotice,
    csvReview,
    csvReviewStopped,
    beginGesture,
    chooseFromGuard,
    retry: retryReplacement,
    endIntent,
    noteEditorClosed,
    adoptCsvReview,
    stopCsvReview,
    presentCsvReview,
    clearReviewStopped,
    previewCsv,
  } = replacement

  /**
   * App-local modal ownership, reused rather than replaced: Export, Settings and
   * the first-run telemetry disclosure already own their own open state, and
   * Help joins that set. At most one surface is open at a time — the disclosure
   * and Help are native modals (the page behind them is inert), while Export
   * and Settings are guarded at the opener instead of with a new trap.
   *
   * WF-06 (§7): the dirty replacement guard joins that set between the
   * telemetry disclosure and Export. `otherModal` is the same value without the
   * guard — the gate's G1 input when the guard itself is closing (T5), which is
   * exactly "the modal closed first, so G1 passes".
   */
  const otherModal: Exclude<OwnedModal, 'replace'> | null = helpOpen
    ? 'help'
    : disclosureOpen
      ? 'disclosure'
      : exportOpen
        ? 'export'
        : settingsOpen
          ? 'settings'
          : null
  const openModal: OwnedModal | null = helpOpen
    ? 'help'
    : disclosureOpen
      ? 'disclosure'
      : intent.kind === 'guard'
        ? 'replace'
        : otherModal
  /**
   * The guide's opener is disabled while a DIFFERENT surface owns the modal,
   * and stays enabled while the guide itself is open: it is the focus-return
   * target, and a disabled control cannot take focus back.
   */
  const helpBlocked = openModal !== null && openModal !== 'help'

  /**
   * IC-01: the render-only editor-state mirror. The ref write alone cannot
   * re-render App, so the grid calls this at the same handler writes when the
   * reported state CHANGES (never per keystroke). Its only job is clearing
   * C13 the moment the editor closes — by Escape, by an ordinary commit, or
   * by a blur commit — with no second Open click and no unrelated rerender.
   */
  const handleEditorStateChange = useCallback(
    (next: EditorReportState) => {
      if (!next.open) noteEditorClosed()
    },
    [noteEditorClosed],
  )

  /**
   * C15/C16 are **lifecycle-derived**, not gesture-owned (K40/v5 §3.7):
   * C15 renders exactly while a history commit is materializing and C16
   * exactly while at least one column cast pre-check is pending (with C15
   * winning when both are). They therefore cannot be cleared by a refusal for
   * a different, higher-priority reason (a G3 draft refusal or a G1 modal
   * refusal), and they clear only when their own observable clears. They are
   * non-dismissible; nothing auto-resumes, so a notice clearing never opens a
   * guard or a picker by itself.
   */
  const pendingNotice: 'settling' | 'cast' | null = mutationPending
    ? 'settling'
    : castPendingCount > 0
      ? 'cast'
      : null

  /**
   * N12 / §4.6: entering `opening-candidate` makes the ready region inert, so
   * any focus inside it must be moved EXPLICITLY to the progress element — the
   * implementation never relies on a browser blurring an inert subtree.
   */
  useLayoutEffect(() => {
    if (intent.kind !== 'opening-candidate') return
    replaceProgressRef.current?.focus()
  }, [intent.kind])

  /**
   * T4 — export-first: the guard closes, the intent ends, then the EXISTING
   * exporter opens. No export outcome advances, resets or marks the session
   * clean, and nothing auto-opens a chooser afterwards.
   */
  const exportFirstFromGuard = (): void => {
    endIntent()
    revealSectionFromNav('export')
    setExportOpen(true)
  }

  const handleContextAction = useCallback(() => {
    switch (nextAction.kind) {
      case 'open-contract':
        revealContextPanel('validation', 'validation-open-contract')
        return
      case 'review-contract':
      case 'review-findings':
        revealContextPanel('validation', 'validation-panel')
        return
      case 'review-comparison':
        revealContextPanel('compare', 'diff-run')
        return
      case 'validate':
        handleValidate()
        return
      case 'cancel-validation':
        handleCancelValidate()
        return
      case 'rerun-diff':
        // The comparison's key mode/manual keys live in the panel, so the bar
        // reveals the panel and focuses its existing run control instead of
        // duplicating that state here. The panel remains the single run path.
        revealContextPanel('compare', 'diff-run')
        return
      case 'cancel-diff':
        handleCancelDiff()
        return
      case 'export':
        // The dialog renders inside the Export section body, so the section
        // must be open (and Change active) before the dialog mounts. The
        // dialog owns its own initial focus; do not move focus to the opener.
        // K17: an in-flight replacement owns the shell — no second surface.
        if (intent.kind !== 'none') return
        revealSectionFromNav('export')
        setExportOpen(true)
        return
      default:
        return
    }
  }, [
    intent.kind,
    nextAction.kind,
    revealContextPanel,
    revealSectionFromNav,
    handleValidate,
    handleCancelValidate,
    handleCancelDiff,
  ])
  const openDataFile = useCallback(async () => {
    // AR-W13: generation guard. `beginSession` bumps the shared session token
    // and runs every per-domain reset (f-1), so a picker/open chain that
    // resolves after a newer open (or any newer phase transition) is discarded
    // rather than clobbering the newer phase.
    const exampleFile = exampleFileRef.current
    exampleFileRef.current = null
    const droppedFile = pendingDropFileRef.current
    pendingDropFileRef.current = null
    /**
     * EW-03I-b: the CSV review's one-shot hand-off (an idle adoption carrying
     * the reviewed options, or a non-.csv pick from the review control).
     * Cleared before the first await, exactly like the two sources above.
     */
    const reviewHandoff = pendingReviewHandoffRef.current
    pendingReviewHandoffRef.current = null
    // A one-shot source (the bundled example, an idle drop, or the review
    // hand-off) skips only the picker acquisition below; it rejoins the
    // identical guarded open chain.
    const oneShotFile = exampleFile ?? droppedFile ?? reviewHandoff?.file ?? null
    // A no-file drop's notice belongs to the idle screen only; any real open
    // attempt (including a cancelled picker returning to idle) supersedes it.
    setDropNotice(null)
    clearReviewStopped()
    // D02c: the session owner starts the session — token bump + every reset,
    // the adopted source slots cleared, the previous session's requests retired,
    // and `opening` published. C03b fail closed (S7): a faulted reset
    // invalidates the generation, publishes the recovery frame + `idle`, and
    // returns `faulted` so this chain abandons before its first await — no
    // picker, no engine open, no `dataset_opened`/`dataset_open_failed`.
    const start = beginOpen()
    if (start.kind === 'faulted') return
    const session = start.token
    // au3-12: warm the below-fold panel chunks in parallel with the open flow
    // so they are resident by `ready` (see `lib/bottom-panels.ts`).
    // Swallow a warm-up rejection here: the awaited re-call below re-rejects
    // from the same memoized promises and the open flow's catch handles it.
    void preloadBottomPanels().catch(() => undefined)
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
      let file: File
      if (oneShotFile === null) {
        const picked = await pickDataFile({
          showOpenFilePicker: async (options) => {
            const handles = await showOpenFilePicker(options)
            openCapture.handle = handles[0] ?? null
            return handles
          },
        })
        if (!isCurrentSession(session)) return
        if (picked === null) {
          // User dismissed the picker — back to idle, nothing opened.
          publishIdle()
          return
        }
        // BrowserFileSource exposes getFile() but not its input's name, and the
        // EngineFileSource seam needs the name for extension detection only.
        // Resolving the File here is a cheap reference (no dataset bytes read,
        // ADR 0001); the name is transported per protocol but never rendered or
        // logged (ADR 0025).
        file = await picked.source.getFile()
        if (!isCurrentSession(session)) return
      } else {
        // The bundled synthetic example and a dropped file skip only picker
        // acquisition. Both rejoin the exact same guarded engine/session open
        // path below (same identity reset, session token checks, telemetry).
        file = oneShotFile
      }
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
      const pickedHandle = oneShotFile === null ? openCapture.handle : null
      // EW-03I-b: the review path picked its file one step earlier (its own
      // picker), so it supplies the identity it captured there; every other
      // open derives it here exactly as before. The identity is handed to the
      // ready frame (the session owner publishes it), so nothing leaks into the
      // new session's export guard by assignment here.
      const identity: SourceIdentity | null =
        reviewHandoff !== null
          ? reviewHandoff.identity
          : pickedHandle !== null
            ? { isSameEntry: pickedHandle.isSameEntry.bind(pickedHandle) }
            : null
      // EW-03I-b: a reviewed CSV adopts through a fresh `engine/open` carrying
      // the reviewed options (ADR 0049 acceptance resolution 5). With no review
      // hand-off, `wireCsvOptions({})` is `undefined` and this stays the exact
      // single-argument quick-open call it has always been — the ordinary open
      // path is byte-identical, by construction rather than by convention.
      const openSource = { name: file.name, getFile: () => Promise.resolve(file) }
      const reviewedOptions = wireCsvOptions(reviewHandoff?.options ?? {})
      const handle =
        reviewedOptions === undefined
          ? await engineClient.open(openSource)
          : await engineClient.open(openSource, reviewedOptions)
      if (!isCurrentSession(session)) return
      // Base metadata for the editing session (ADR 0011/0012). The anchor is
      // the stable function of the file *version* (size + mtime) — re-opening
      // the same unchanged file keeps base row ids stable; the token is never
      // rendered or logged.
      const baseSchema = await engineClient.schema(handle)
      if (!isCurrentSession(session)) return
      const baseRowCount = await engineClient.rowCount(handle)
      if (!isCurrentSession(session)) return
      const base: OverlayBase = {
        baseAnchor: fileVersionAnchor({ size: file.size, lastModified: file.lastModified }),
        overlayAnchor: createOverlayAnchor(),
        columns: baseSchema.map((column) => ({ name: column.name, type: column.type })),
        baseRowCount,
      }
      // The provider reads the live overlay through the editing session's
      // snapshot command; after the ready frame publishes this base's empty
      // overlay the ref is that base's own, so `model.load()` here and every
      // later refresh read exactly the adopted view (ADR 0012).
      const provider = new DuckDbGridProvider(engineClient, handle, () =>
        grid.snapshotOverlay(base),
      )
      const model = new GridViewportModel(provider)
      await model.load()
      if (!isCurrentSession(session)) return
      // au3-12: the below-fold chunks were requested at the top of this flow;
      // resolving them here hands them to the ready frame BEFORE the `ready`
      // render, so the grid and panels mount in one synchronous render (no
      // post-ready fallback cycle — see `lib/bottom-panels.ts`).
      const panels = await preloadBottomPanels()
      if (!isCurrentSession(session)) return
      // D02c: one publication for a completed open — history/overlay for the
      // adopted base, the source slots, the panels, request retirement, the
      // `ready` phase and exactly-once `dataset_opened`. A superseded chain
      // publishes nothing.
      publishReady(
        {
          file,
          handle,
          base,
          model,
          provider,
          panels,
          identity,
          openSource: { getFile: () => Promise.resolve(file) },
        },
        session,
        grid,
      )
    } catch (error) {
      // A stale chain must not surface its failure over the newer phase; the
      // owner emits the value-free `dataset_open_failed` reason enum and the
      // terminal error frame only for the live session.
      failOpen(session, error)
    }
  }, [beginOpen, clearReviewStopped, failOpen, grid, isCurrentSession, publishIdle, publishReady])

  /**
   * EW-03I-b — the idle review entry: pick a file, then review it; or, for
   * anything that is not a `.csv`, hand it straight to the ordinary open chain
   * with no new copy and no review (EW-03D §3: non-CSV files keep today's
   * path). Declared after `openDataFile` because it re-enters that one chain
   * for the non-CSV hand-off.
   *
   * There is no WF-06 gate here (no live session to protect), but the same
   * generation discipline applies: every await is guarded by the dataset
   * session token and the phase, so a pick that resolves after a newer open is
   * dropped instead of resurrecting the review over the new dataset.
   */
  const startCsvReviewFromIdle = (): void => {
    if (phaseRef.current.kind !== 'idle') return
    const session = currentToken()
    const openCapture: { handle: FileSystemFileHandle | null } = { handle: null }
    void (async () => {
      let picked: PickedDataFile | null
      try {
        picked = await pickDataFile({
          showOpenFilePicker: async (options) => {
            const handles = await showOpenFilePicker(options)
            openCapture.handle = handles[0] ?? null
            return handles
          },
        })
      } catch {
        // A refused or dismissed chooser opens nothing and says nothing —
        // exactly the idle Open control's picker behaviour.
        return
      }
      if (!isCurrentSession(session)) return
      if (picked === null) return
      if (phaseRef.current.kind !== 'idle') return
      const identity: SourceIdentity | null =
        openCapture.handle === null
          ? null
          : { isSameEntry: openCapture.handle.isSameEntry.bind(openCapture.handle) }
      let file: File
      try {
        file = await picked.source.getFile()
      } catch (error) {
        if (!isCurrentSession(session)) return
        if (phaseRef.current.kind !== 'idle') return
        // The same terminal error frame the open chain uses for this exact
        // failure (a picked file that cannot be read); no second
        // classification and no new copy, and no `dataset_open_failed` (no
        // session was started on this idle path).
        publishError(error)
        return
      }
      if (!isCurrentSession(session)) return
      if (phaseRef.current.kind !== 'idle') return
      if (detectFormatFromFileName(file.name) !== 'csv') {
        pendingReviewHandoffRef.current = { file, identity, options: undefined }
        void openDataFile()
        return
      }
      presentCsvReview({
        mode: 'idle',
        file,
        identity,
        startPhase: phaseRef.current,
        intentSeq: 0,
      })
    })()
  }

  /**
   * ug-15/UG-6: drop a data file anywhere on the shell. Both handlers are
   * window-level so the whole page is a target, and both call
   * `preventDefault()` in EVERY phase — the browser's default for a dropped
   * file is to navigate away from the unsaved workbench session.
   *
   * The drop acts only from `idle`: it parks the first dropped `File` as the
   * one-shot source above and re-enters `openDataFile`, so the dropped open
   * shares the picker's generation guard, identity resets, phase transitions,
   * error classification and telemetry. A drop while opening/ready/error is
   * consumed by `preventDefault()` and otherwise ignored — it must not start a
   * session, bump the token, or change the phase. A payload with no `File`
   * never reaches the engine; it gets readable inline copy instead.
   */
  useEffect(() => {
    const handleDragOver = (event: DragEvent): void => {
      event.preventDefault()
    }
    const handleDrop = (event: DragEvent): void => {
      event.preventDefault()
      if (phaseRef.current.kind !== 'idle') return
      const file = event.dataTransfer?.files?.[0] ?? null
      if (file === null) {
        setDropNotice(DROP_WITHOUT_FILE)
        return
      }
      setDropNotice(null)
      pendingDropFileRef.current = file
      void openDataFile()
    }
    window.addEventListener('dragover', handleDragOver)
    window.addEventListener('drop', handleDrop)
    return () => {
      window.removeEventListener('dragover', handleDragOver)
      window.removeEventListener('drop', handleDrop)
    }
  }, [openDataFile, phaseRef])

  /*
   * ug-17: the three shell-owned section summaries. Derived from state App
   * already holds (`validationRun`, `diffRun`, `activeOps(history)`) — counts
   * only (ADR 0025), no new session/engine state, no polling, no telemetry. A
   * helper returns `null` at 0, so "0 failing"/"0 changed"/"0 pending" is
   * never shown and the toggle renders no summary element.
   */
  const validationSummary = validationSectionSummary(validationRun)
  const comparisonSummary = comparisonSectionSummary(diffRun)
  const historySummary = historySectionSummary(history)

  return (
    <TelemetryProvider runtime={telemetry}>
      <main>
        <h1 className="workbench-heading">{APP_NAME}</h1>
        <p className="workbench-tagline">{TAGLINE}</p>
        {/*
         * WF-06 (§4.6/K17): while a replacement intent owns the shell there is
         * no second surface to open — Open, Help and Export are disabled and
         * this opener is not rendered. (The guard itself is a native modal and
         * the OS picker owns focus during `choosing`, so this only closes the
         * `opening-candidate` window, where the ready region is inert but the
         * header is not.)
         */}
        {intent.kind === 'none' && (
          <TelemetrySettings
            onOpenChange={(open) => {
              setSettingsOpen(open)
            }}
          />
        )}
        {disclosureOpen && (
          <TelemetryDisclosure
            onDismiss={() => {
              setDisclosureOpen(false)
            }}
          />
        )}
        {/*
         * rd-7: the one global guide. Rendered only while open (like the export
         * dialog), so the closed state costs no DOM, no heading and no tab stop.
         */}
        {helpOpen && (
          <WorkbenchHelp
            onClose={() => {
              setHelpOpen(false)
            }}
          />
        )}
        {/*
         * WF-06: the dirty-session guard is a native `<dialog>` opened with
         * `showModal()` — a genuinely inert page and a UA focus scope, with
         * Escape as the native cancel (= Stay). Escape and the Stay control are
         * the same transition (T3); choosing from it is T5.
         */}
        {intent.kind === 'guard' && (
          <ReplaceGuard
            onStay={endIntent}
            onExport={exportFirstFromGuard}
            onChoose={() => {
              chooseFromGuard({ gateModal: otherModal, gridBusy })
            }}
          />
        )}
        {/*
         * EW-03I-b: the CSV review — a native `<dialog>` like the guard and the
         * guide (UA top layer + UA focus scope, Escape = Stop reviewing). It
         * mounts only while a reviewed candidate exists, and it only ever
         * calls `csvPreview`: nothing in this subtree can adopt, open or write
         * a session table. The picked file's name is never rendered (ADR 0025).
         */}
        {csvReview !== null && (
          <CsvReviewDialog
            mode={csvReview.mode}
            source={{
              name: csvReview.file.name,
              getFile: () => Promise.resolve(csvReview.file),
            }}
            requestPreview={previewCsv}
            onAdopt={(options) => {
              const handoffToOpen = adoptCsvReview(csvReview, options)
              if (handoffToOpen === null) return
              pendingReviewHandoffRef.current = handoffToOpen
              void openDataFile()
            }}
            onStop={() => {
              stopCsvReview(csvReview)
            }}
          />
        )}

        {/*
         * EW-04I: the column-repair surface — a native `<dialog>` like the
         * guard, the guide and the CSV review. It mounts only while the editing
         * session is ready and the surface is open; capture and preview are
         * local state, and the only way out is Apply through the session's
         * existing commit boundary (`handleApplyRepair`).
         */}
        {phase.kind === 'ready' && repairPreview.open && (
          <RepairDialog
            columns={overlayState === null ? NO_COLUMNS : overlayState.columns}
            surface={repairPreview}
          />
        )}

        {phase.kind === 'idle' && (
          <div className="idle-intro" data-testid="idle-intro">
            <p data-testid="idle-capability">{IDLE_CAPABILITY}</p>
            <p data-testid="idle-formats">{IDLE_FORMATS}</p>
            {/*
             * R-12: the engine explanation is static copy, not engine state —
             * it renders only inside this idle block and reads nothing from
             * the session, engine or telemetry. No live status, benchmark,
             * memory or version claim and no new request/event.
             */}
            <p data-testid="idle-engine-line">{IDLE_ENGINE_LINE}</p>
            <p data-testid="idle-engine-note">{IDLE_ENGINE_NOTE}</p>
            <p className="idle-drop-hint" data-testid="idle-drop-hint">
              {IDLE_DROP_HINT}
            </p>
            {dropNotice !== null && (
              <p role="status" data-testid="drop-notice">
                {dropNotice}
              </p>
            )}
          </div>
        )}

        <section className="workbench-open-flow" data-testid="open-flow">
          <button
            type="button"
            className="open-button"
            data-testid="open-button"
            onClick={() => {
              // K17: the same predicate, so a programmatic activation cannot
              // start either open path behind an owned modal.
              if (
                openControlBlocked({
                  phase: phase.kind,
                  intentActive: intent.kind !== 'none',
                  openModal,
                })
              ) {
                return
              }
              // WF-06: a ready-state Open enters the synchronous gate; every
              // other phase keeps the unchanged legacy destroy-first chain.
              if (phase.kind === 'ready') {
                beginGesture(
                  { gateModal: openModal, gridBusy },
                  { respectDirtyGuard: true, path: 'open' },
                )
              } else void openDataFile()
            }}
            /* IC-03/K17 (§4.6): disabled when an intent is active OR ANY owned
               modal is open — not only when both are true, and not only in
               `ready`: in `idle`/`error` the legacy open path must not run
               behind Help, the telemetry disclosure, Export or Settings. A
               G3/G4 refusal leaves the intent at `none`, so the control stays
               enabled and a retry is possible (and refused identically while
               the work is pending). */
            disabled={openControlBlocked({
              phase: phase.kind,
              intentActive: intent.kind !== 'none',
              openModal,
            })}
          >
            Open a data file…
          </button>{' '}
          {/*
           * EW-03I-b: the explicit CSV review path, beside the Open control
           * (EW-03D §3). It is a second, discoverable entry — never a change
           * to the default: the Open control above keeps its exact chain,
           * copy and phase transitions, and nothing here renders in a phase
           * that does not offer it. In `ready` it goes through the same WF-06
           * gate, so a dirty session gets the same guard and a busy one the
           * same refusal. It is inline (no new block) so the ≤140px ready-top
           * budget is untouched.
           */}
          {(phase.kind === 'idle' || phase.kind === 'ready') && (
            <button
              type="button"
              className="csv-review-open"
              data-testid={phase.kind === 'idle' ? 'csv-review-button' : 'csv-review-open'}
              disabled={openControlBlocked({
                phase: phase.kind,
                intentActive: intent.kind !== 'none',
                openModal,
              })}
              onClick={() => {
                if (
                  openControlBlocked({
                    phase: phase.kind,
                    intentActive: intent.kind !== 'none',
                    openModal,
                  })
                ) {
                  return
                }
                if (phase.kind === 'ready') {
                  beginGesture(
                    { gateModal: openModal, gridBusy },
                    { respectDirtyGuard: true, path: 'review' },
                  )
                } else startCsvReviewFromIdle()
              }}
            >
              {CSV_REVIEW_ACTION}
            </button>
          )}
          {phase.kind === 'idle' && (
            <>
              <p className="csv-review-entry-helper" data-testid="csv-review-helper">
                {CSV_REVIEW_IDLE_HELPER}
              </p>
              <div data-testid="example-data-entry">
                <button
                  type="button"
                  className="example-button"
                  data-testid="example-data-button"
                  onClick={() => {
                    exampleFileRef.current = new File([nestedFixtureText], 'nested.jsonl')
                    void openDataFile()
                  }}
                >
                  {IDLE_EXAMPLE_ACTION}
                </button>
                <p data-testid="example-data-helper">{IDLE_EXAMPLE_HELPER}</p>
              </div>
            </>
          )}
          <span data-testid="open-status" data-phase={phase.kind}>
            {openStatusCopy(phase.kind)}
          </span>
          {/*
           * C03b fail-closed recovery frame: exactly one, whenever the last
           * `beginSession()` reported a reset fault. The copy is fixed and
           * value-free (no error text, file, column or cell — ADR 0025) and the
           * only affordance is a fresh page, because the app cannot prove which
           * resets completed and has no persisted state to repair. Rendered
           * outside every phase branch so `openDataFile`, `cancelOpen` and
           * adoption surface the same frame and none of them shows `ready`.
           */}
          {sessionFault !== null && (
            <div className="session-fault" data-testid="session-fault">
              <p role="alert" data-testid="session-fault-text">
                {SESSION_FAULT_COPY}
              </p>
              <button
                type="button"
                data-testid="session-fault-reload"
                onClick={() => {
                  window.location.reload()
                }}
              >
                {SESSION_FAULT_RELOAD_LABEL}
              </button>
            </div>
          )}
          {/*
           * EW-03I-b: abandonment copy (ADR 0049 item 7 / envelope §5a).
           * "Stopped reviewing" — never "aborted", and never a claim that a
           * preview slot was released: there is no host-reachable release op.
           */}
          {csvReviewStopped !== null && (
            <span role="status" data-testid="csv-review-stopped">
              {CSV_REVIEW_STOPPED}
              {csvReviewStopped === 'replace' ? ` ${CSV_REVIEW_STOPPED_SESSION}` : ''}
            </span>
          )}
          {/*
           * WF-06: the replacement notices live beside the Open control, in
           * the open-flow status area (never inside the ready region, which is
           * inert during `opening-candidate`). Each is a value-free
           * `role="status"`; the failure alert's announced text is value-free
           * too and the raw diagnostic sits in a sibling, non-live `<details>`
           * (IC-04) — never in the announced subtree, a title or telemetry.
           */}
          {phase.kind === 'ready' && pickerWasCancelled && (
            <span role="status" data-testid="replace-notice">
              {REPLACE_PICKER_NOTICE}
            </span>
          )}
          {phase.kind === 'ready' && busyNotice && (
            <span role="status" data-testid="replace-busy">
              {REPLACE_BUSY_NOTICE}
            </span>
          )}
          {phase.kind === 'ready' && draftNotice && (
            <span role="status" data-testid="replace-draft-notice">
              {REPLACE_DRAFT_NOTICE}
            </span>
          )}
          {phase.kind === 'ready' && pendingNotice === 'settling' && (
            <span role="status" data-testid="replace-settling-notice">
              {REPLACE_SETTLING_NOTICE}
            </span>
          )}
          {phase.kind === 'ready' && pendingNotice === 'cast' && (
            <span role="status" data-testid="replace-cast-notice">
              {REPLACE_CAST_NOTICE}
            </span>
          )}
          {phase.kind === 'ready' && replacementFailure !== null && (
            <div className="replace-failure" data-testid="replace-error">
              <p role="alert" data-testid="replace-error-text">
                {replacementFailure.cause}
                {REPLACE_FAILURE_SUFFIX}
              </p>
              <button
                type="button"
                data-testid="replace-retry"
                onClick={() => {
                  retryReplacement({ gateModal: otherModal, gridBusy })
                }}
              >
                {REPLACE_RETRY_LABEL}
              </button>
              <details data-testid="replace-error-details">
                <summary>{REPLACE_TECHNICAL_SUMMARY}</summary>
                <pre data-testid="replace-error-detail">{replacementFailure.detail}</pre>
              </details>
            </div>
          )}
          {phase.kind === 'ready' && intent.kind === 'opening-candidate' && (
            <div
              className="replace-progress"
              role="status"
              data-testid="replace-progress"
              tabIndex={-1}
              ref={replaceProgressRef}
            >
              {REPLACE_PROGRESS_TEXT}{' '}
              <progress
                className="open-progress"
                data-testid="replace-progress-bar"
                aria-label={REPLACE_PROGRESS_LABEL}
              />
            </div>
          )}
          {phase.kind === 'opening' && (
            <>
              {' '}
              {/*
               * ug-21: indeterminate by construction — no `value`/`max`, so
               * the native <progress> reports no percentage. The accessible
               * name is value-free (ADR 0025); it is not a live region.
               */}
              <progress
                className="open-progress"
                data-testid="open-progress"
                aria-label={OPEN_PROGRESS_LABEL}
              />{' '}
              <button type="button" data-testid="open-cancel" onClick={cancelOpen}>
                {OPEN_CANCEL_LABEL}
              </button>
            </>
          )}
          <span
            className="visually-hidden"
            role="status"
            aria-atomic="true"
            data-testid="open-live-region"
          >
            {openAnnouncement === null ? null : (
              <span key={openAnnouncement.seq}>{openAnnouncement.text}</span>
            )}
          </span>
          {/*
           * rd-7 (D-03) header control: the ONE way into the guide, present in
           * every phase. It is inline in this header line and no taller than the
           * Open control beside it, so in the ready frame it adds no line box
           * (the ≤140px ready-top and the 1024×700 first-paint budgets measure
           * byte-identically to the pre-slice baseline). Modal arbitration lives
           * in `openModal`: while Export, Settings or the telemetry disclosure
           * is open this control is disabled — neither clickable nor focusable.
           */}
          <button
            type="button"
            className="workbench-help-open"
            data-testid="help-open"
            aria-haspopup="dialog"
            /* K17: no second surface opens while a replacement intent owns the
               shell (the guard/choosing/opening-candidate window). */
            disabled={helpBlocked || intent.kind !== 'none'}
            onClick={() => {
              if (helpBlocked || intent.kind !== 'none') return
              setHelpOpen(true)
            }}
          >
            {WORKBENCH_HELP_OPEN_LABEL}
          </button>
          {phase.kind === 'error' && (
            // UG-5: a failed open states a one-line human cause (classified,
            // never the raw DuckDB diagnostic), offers the same open path back
            // through "Choose a different file…", and keeps the full engine
            // text behind a technical-detail disclosure. Text-only rendering;
            // the copy never carries the picked file's name (ADR 0025).
            <div data-testid="open-error" role="alert">
              <p data-testid="open-error-cause">
                {openFailureMessage(phase.message, phase.errorName)}
              </p>
              <button
                type="button"
                data-testid="open-error-retry"
                onClick={() => {
                  void openDataFile()
                }}
              >
                Choose a different file…
              </button>
              <details data-testid="open-error-details">
                <summary>Technical detail</summary>
                <pre data-testid="open-error-detail">{phase.message}</pre>
              </details>
            </div>
          )}
          {phase.kind === 'ready' && <LiveTableInfo model={phase.model} />}
        </section>

        {phase.kind === 'ready' ? (
          <>
            {actionError !== null && (
              <p className="nested-action-error" role="alert" data-testid="nested-action-error">
                {actionError}
              </p>
            )}
            {/*
             * q-3: the ONE polite live region for grid edit outcomes. Commit
             * success and every value-free rejection (client validation reason
             * or the q-8 engine materialization class) announce here; the
             * visible `edit-error`/`grid-edit-error` text is not itself a live
             * region. `seq` remounts the text node so repeated announcements
             * still fire. Never carries a cell value (ADR 0025). Kept OUTSIDE
             * the collapsible section bodies and the tool-pane rail so
             * collapsing a section or the pane never mutes an announcement.
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
            {/*
             * q-15: the two-pane shell. At ≥1024px this is a CSS grid — a
             * sticky tool pane (nav + tool sections) beside the persistent
             * grid/grid-dock center column; below 1024px the wrappers become
             * `display: contents` and `order` restores the slice-1
             * single-column stack (index.css). One DOM, two CSS layouts.
             */}
            {/*
             * WF-06 §4.6: while a candidate is prepared the region holding the
             * grid and every panel is `inert` + `aria-busy`, so no new grid
             * gesture, edit or filter can start against the about-to-retire
             * session. The open-flow controls (and C9's progress) are OUTSIDE
             * this region, and focus is moved to the progress element
             * explicitly (never relying on the UA blurring an inert subtree).
             */}
            <div
              className="workbench-layout"
              data-pane={paneCollapsed ? 'collapsed' : 'expanded'}
              inert={intent.kind === 'opening-candidate'}
              aria-busy={intent.kind === 'opening-candidate' ? true : undefined}
            >
              <div className="workbench-tools" data-task={activeTask}>
                <div className="workbench-pane-head">
                  <button
                    type="button"
                    className="workbench-pane-toggle"
                    data-testid="pane-toggle"
                    aria-expanded={!paneCollapsed}
                    aria-controls="workbench-tools-body"
                    aria-label={paneToggleLabel(paneCollapsed)}
                    title={paneToggleLabel(paneCollapsed)}
                    onClick={() => {
                      setPaneCollapsed((previous) => !previous)
                    }}
                  >
                    <span aria-hidden="true">{paneCollapsed ? '▸' : '◂'}</span>
                  </button>
                </div>
                <div
                  className="workbench-tools-body"
                  id="workbench-tools-body"
                  hidden={paneCollapsed}
                >
                  {/*
                   * UI-RD-01 in-pane navigation: a single-select task radio
                   * group plus task-grouped section links. The links keep the
                   * existing `section-nav-<id>` contract (so close-section
                   * focus and the anchor behaviour are unchanged). All four
                   * groups stay in the DOM; ≥1024px exposes only the active
                   * one plus Workspace, and <1024px exposes all of them.
                   */}
                  <TaskNav
                    activeTask={activeTask}
                    onSelectTask={handleSelectTask}
                    onRevealSection={revealSectionFromNav}
                  />
                  <WorkbenchSection
                    id="schema"
                    disclosure="inner"
                    open={!recoveryHiddenSections.has('schema')}
                  >
                    <PanelBoundary id="schema" onClose={closeSection}>
                      {/* WF-06 (T8/§3.4): a dataset-identity key makes the
                          adoption discard this panel's rename/cast drafts once,
                          while a candidate preparation (intent-only, same
                          tableId) never remounts it. */}
                      <MemoSchemaPanel
                        key={phase.tableId}
                        columns={schemaColumns}
                        onAction={runNestedAction}
                        onRenameColumn={handleRenameColumn}
                        onCastColumn={handleCastColumn}
                        castPendingColumns={castPendingColumns}
                      />
                    </PanelBoundary>
                  </WorkbenchSection>
                  <WorkbenchSection
                    id="editing"
                    open={openSections.has('editing')}
                    onToggle={toggleSection}
                  >
                    <PanelBoundary id="editing" onClose={closeSection}>
                      <EditToolbar
                        onInsertRow={handleInsertRow}
                        pendingSummary={pendingChangesSummary(activeOps(history))}
                        error={editError}
                      />
                      {/*
                       * EW-04I: the bulk-repair entry point, beside the
                       * single-cell and column affordances. Authoring a plan
                       * applies nothing — the dialog only reads a preview
                       * until Apply, which goes through the same commit path.
                       * Disabled while another owned modal or a replacement
                       * intent owns the shell (the same predicate the Open
                       * controls use), never hidden: the affordance is
                       * discoverable and its refusal is honest.
                       */}
                      <button
                        type="button"
                        className="repair-open"
                        data-testid="repair-open"
                        disabled={openControlBlocked({
                          phase: phase.kind,
                          intentActive: intent.kind !== 'none',
                          openModal,
                        })}
                        onClick={() => {
                          if (
                            openControlBlocked({
                              phase: phase.kind,
                              intentActive: intent.kind !== 'none',
                              openModal,
                            })
                          ) {
                            return
                          }
                          repairPreview.openDialog()
                        }}
                      >
                        {REPAIR_ACTION}
                      </button>
                    </PanelBoundary>
                  </WorkbenchSection>
                  <WorkbenchSection
                    id="history"
                    open={openSections.has('history')}
                    onToggle={toggleSection}
                    summary={historySummary}
                  >
                    <PanelBoundary id="history" onClose={closeSection}>
                      <HistoryPanel
                        entries={history.entries}
                        cursor={history.cursor}
                        onSelectCursor={handleSelectCursor}
                        onUndo={handleUndo}
                        onRedo={handleRedo}
                      />
                    </PanelBoundary>
                  </WorkbenchSection>
                  <WorkbenchSection
                    id="export"
                    open={openSections.has('export')}
                    onToggle={toggleSection}
                  >
                    <PanelBoundary id="export" onClose={closeSection}>
                      <section className="export-actions" aria-label="Export">
                        <h2 className="visually-hidden">Export</h2>
                        <button
                          type="button"
                          className="export-open"
                          data-testid="export-open"
                          /* K17: an in-flight replacement owns the shell; the
                             ready region is also inert during its preparation,
                             so this only closes the programmatic path. */
                          disabled={helpOpen || intent.kind !== 'none'}
                          onClick={() => {
                            // rd-7 modal ownership: the guide is a native modal,
                            // so this control is already inert behind it — the
                            // guard covers the programmatic paths (a dispatched
                            // activation, the context bar's export action)
                            // without adding a trap.
                            if (helpOpen || intent.kind !== 'none') return
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
                            activeOperationCount={activeOps(history).length}
                            // Filtering and sorting tracked separately (m4-5 fix
                            // round 2): a sort-only view must not claim a "filtered
                            // subset"; the dialog describes only the active state.
                            viewFiltered={modelFilters.length > 0}
                            viewSorted={modelSort !== null}
                            // D02c: the session owner freezes the exact view on
                            // screen for this export (its in-flight snapshot) and
                            // forwards it to the engine export op.
                            runEngineExport={(format) => runSessionExport(format, grid)}
                            requestDestination={requestExportDestination}
                            writeCopy={deliverExportCopy}
                            onClose={() => {
                              setExportOpen(false)
                            }}
                          />
                        )}
                      </section>
                    </PanelBoundary>
                  </WorkbenchSection>
                  {/*
                   * Placement (m5-3): the validation panel's sample lists and filter
                   * control drive the grid above it, and its verdicts track the
                   * editing before it. Slice 1 keeps it a collapsible section in the
                   * stack.
                   */}
                  <WorkbenchSection
                    id="validation"
                    open={openSections.has('validation')}
                    onToggle={toggleSection}
                    summary={validationSummary}
                  >
                    <PanelBoundary id="validation" onClose={closeSection}>
                      {panelModules === null ? null : (
                        <panelModules.ValidationPanel
                          contractState={contractState}
                          runState={validationRun}
                          stale={validationStale}
                          jumpError={jumpError}
                          filterError={filterToFailuresError}
                          datasetColumns={schemaColumns}
                          activeFilterCount={modelFilters.length}
                          onContractFile={handleContractFile}
                          onValidate={handleValidate}
                          onCancelValidate={handleCancelValidate}
                          onJumpToSample={handleJumpToSample}
                          onFilterToFailures={handleFilterToFailures}
                          requestReportDestination={requestReportDestinationForPanel}
                          deliverReportCopy={writeReportCopy}
                        />
                      )}
                    </PanelBoundary>
                  </WorkbenchSection>
                  {/*
                   * Placement (m6-4): the comparison panel sits beside the validation
                   * panel — both drive the grid above (diff samples jump A-side rows)
                   * and both track the editing before them (verdict freshness). Schema
                   * drift and distribution deltas render before the key-selection
                   * control, so a row diff can never run before the schema-level view
                   * is visible.
                   */}
                  <WorkbenchSection
                    id="compare"
                    open={openSections.has('compare')}
                    onToggle={toggleSection}
                    summary={comparisonSummary}
                  >
                    <PanelBoundary id="compare" onClose={closeSection}>
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
                    </PanelBoundary>
                  </WorkbenchSection>
                  <WorkbenchSection
                    id="filters"
                    disclosure="inner"
                    open={!recoveryHiddenSections.has('filters')}
                  >
                    <PanelBoundary id="filters" onClose={closeSection}>
                      {/* WF-06 (T8): the filter compose/row drafts are local
                          to this panel; the dataset key discards them at
                          adoption only. */}
                      <FilterBar
                        key={phase.tableId}
                        model={phase.model}
                        onPendingChange={setGridFiltering}
                      />
                    </PanelBoundary>
                  </WorkbenchSection>
                  <WorkbenchSection
                    id="sql"
                    open={openSections.has('sql')}
                    onToggle={toggleSection}
                  >
                    <PanelBoundary id="sql" onClose={closeSection}>
                      {panelModules === null ? null : (
                        // WF-06 (T8): the SQL statement is a local draft —
                        // "preserved by Stay; lost at adoption".
                        <panelModules.SqlPanel
                          key={phase.tableId}
                          tableId={phase.tableId}
                          runRequest={sqlRequest}
                          claimRequest={claimSqlRequest}
                        />
                      )}
                    </PanelBoundary>
                  </WorkbenchSection>
                  <WorkbenchSection
                    id="profile"
                    disclosure="inner"
                    open={!recoveryHiddenSections.has('profile')}
                  >
                    <PanelBoundary id="profile" onClose={closeSection}>
                      {panelModules === null ? null : (
                        <panelModules.ProfilePanel
                          handle={phase.handle}
                          // R-16 (ug-10): active history entries (not a net
                          // difference) — the panel labels staged changes as
                          // not reflected in these base-view statistics.
                          stagedCount={activeOps(history).length}
                          // ug-16: base-derived statistic clicks go through
                          // the resolve-then-compile bridge above.
                          onFilterValue={(column, value) => {
                            applyProfileFilter(column, { kind: 'value', value })
                          }}
                          onFilterNull={(column) => {
                            applyProfileFilter(column, { kind: 'null' })
                          }}
                          filterRefusal={profileFilterRefusal}
                          filterError={profileFilterError}
                          // Round 2 single-flight: the panel disables its filter
                          // controls while one apply is in flight (the
                          // FilterBar `pending` posture).
                          filterPending={profileFilterPending}
                          onClearFilterFeedback={clearProfileFilterFeedback}
                        />
                      )}
                    </PanelBoundary>
                  </WorkbenchSection>
                  {/*
                   * Panel-placement ruling (queue 2026-10-02): the pipeline panel
                   * is a tool-pane resident ordered last (after profile) in BOTH
                   * layouts; the former "PROVISIONAL placement" note is resolved.
                   * The panel is dataset-session scoped — the session hook
                   * registers the f-1 reset, so a new file open drops its state.
                   */}
                  <WorkbenchSection
                    id="pipeline"
                    open={openSections.has('pipeline')}
                    onToggle={toggleSection}
                  >
                    <PanelBoundary id="pipeline" onClose={closeSection}>
                      {panelModules === null ? null : (
                        <panelModules.PipelinePanel
                          fileState={pipeline.fileState}
                          bindings={pipeline.bindings}
                          contractBindings={pipeline.contractBindings}
                          runState={pipeline.runState}
                          preview={pipeline.preview}
                          onOpenPipelineFile={pipeline.openPipelineFile}
                          onBindSource={pipeline.bindSourceDataset}
                          onBindContract={pipeline.bindContract}
                          openDatasetAvailable={phase.kind === 'ready'}
                          loadedContractAvailable={contractState.kind === 'loaded'}
                          onBindOpenDataset={pipeline.bindOpenDataset}
                          onBindLoadedContract={pipeline.bindLoadedContract}
                          onInspectContract={inspectPipelineContractInValidation}
                          onRun={pipeline.run}
                          onCancel={pipeline.cancelRun}
                          onOpenPreview={pipeline.openPreview}
                          onClosePreview={pipeline.closePreview}
                          dcrExport={pipeline.dcrExport}
                          onExportDcr={pipeline.exportDcr}
                        />
                      )}
                    </PanelBoundary>
                  </WorkbenchSection>
                </div>
              </div>
              <div className="workbench-center">
                {/*
                 * rd-3/rd-4: one compact dataset/session context bar beside the
                 * artifact. Neutral facts + exactly one next action; no filename
                 * and no copied verdict count (see DatasetContextBar).
                 */}
                <DatasetContextBar
                  rows={liveRowCount(
                    phase.base,
                    overlayState ?? stateAtCursor(phase.base, history),
                  )}
                  columns={schemaColumns.length}
                  stagedOperations={activeOps(history).length}
                  next={nextAction}
                  onAction={handleContextAction}
                  onSecondaryReview={() => {
                    revealContextPanel('validation', 'validation-panel')
                  }}
                  jumpOrigin={jumpOrigin !== null}
                  onBackToFindings={handleBackToFindings}
                />
                <WorkbenchSection
                  id="grid"
                  open={openSections.has('grid')}
                  onToggle={toggleSection}
                >
                  <ErrorBoundary scope="grid" sectionId="grid">
                    <DataGrid
                      model={phase.model}
                      overlayState={overlayState}
                      scrollRequest={scrollRequest}
                      onCommitCell={handleCommitCell}
                      onDeleteRow={handleDeleteRow}
                      onEditAnnounce={announceEdit}
                      overlayRevision={overlayRevision}
                      queryBusy={gridBusy}
                      onSortBusyChange={setGridSorting}
                      onOpenRecord={(rowIndex) => {
                        // ux-a3: explicit row activation (Enter on a focused
                        // row or a row click — the same gesture) is the ONE
                        // request that lands focus in the inspector, so the
                        // next Escape/Close returns to the row instead of the
                        // recorded 18-Tab walk. Validation/diff "Show row"
                        // jumps and the dock's Prev/Next step go through
                        // `navigateToRow` and keep their focus policy.
                        setRecordRequest((previous) => ({
                          rowIndex,
                          seq: (previous?.seq ?? 0) + 1,
                          focusOnOpen: true,
                        }))
                      }}
                      onNestedAction={runNestedAction}
                      editorStateRef={editorStateRef}
                      onEditorStateChange={handleEditorStateChange}
                    />
                  </ErrorBoundary>
                </WorkbenchSection>
                {/*
                 * m3-3 dock: the record inspector is grid-linked state, not a
                 * pane peer — it holds the bottom of the center column and its
                 * open/close semantics are unchanged (opens on row activation,
                 * closes on epoch shift). No shell toggle: it is a dock.
                 */}
                <WorkbenchSection id="record" disclosure="inner" open>
                  {/*
                   * ug-13/R-14: the dock returns `null` while closed, so the
                   * shell owns the closed-state hint. It appears only while
                   * no record is requested, so the open inspector never shows
                   * duplicate guidance. Value-free (ADR 0025).
                   */}
                  {recordRequest === null && (
                    <p className="record-closed-hint" data-testid="record-hint">
                      Select a row to inspect it here — press Enter or double-click a row.
                    </p>
                  )}
                  <MemoRecordInspector
                    model={phase.model}
                    request={recordRequest}
                    overlayRevision={overlayRevision}
                    onClosed={handleRecordClosed}
                    onStep={stepRecord}
                  />
                </WorkbenchSection>
              </div>
            </div>
          </>
        ) : null}
      </main>
    </TelemetryProvider>
  )
}
