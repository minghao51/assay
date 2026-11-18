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
import type { ReactNode } from 'react'
import { viewNameForTableId } from '@assay/engine-duckdb'
import type { EngineTableHandle } from '@assay/engine-duckdb'
import {
  bucketColumnCount,
  bucketFindingCount,
  bucketRowCount,
  bucketSize,
  classifyOsFamily,
} from '@assay/telemetry'
import type { OverlayBase, TransformationHistory } from '@assay/domain'
import { emptyHistory, liveRowCount, stateAtCursor } from '@assay/domain'
import type { DiffRunState } from './diff/DiffPanel'
import type { ValidationRunState } from './validation/ValidationPanel'
import type { ContractV1 } from '@assay/contracts'
import { GridViewportModel } from '@assay/grid'
import type { ColumnSchema } from '@assay/grid'
import { pickDataFile } from '@assay/data-sources/browser'
import type { PickedDataFile } from '@assay/data-sources/browser'
import { detectFormatFromFileName } from '@assay/data-sources/browser'
import type { EngineCsvOptions } from '@assay/engine-duckdb'
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
import { activeOps, engineErrorMessage, openFailureMessage, overlaySnapshot } from './edit/session'
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
  TAGLINE,
  openAnnouncementText,
  openStatusCopy,
} from './lib/app'
import { preloadBottomPanels } from './lib/bottom-panels'
import type { BottomPanelModules } from './lib/bottom-panels'
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
  WORKBENCH_SECTIONS,
  WORKBENCH_SECTION_PURPOSES,
  sectionsForTask,
  taskOfSection,
  type WorkbenchSectionId,
  type WorkbenchTaskId,
} from './workbench/tasks'
import { RecordInspector } from './record/RecordInspector'
import type { RecordRequest } from './record/RecordInspector'
import { parseDuckDbType } from './schema/parseType'
import { SchemaPanel } from './schema/SchemaPanel'
import { composeNestedAction } from './sql/nested-actions'
import { planProfileFilter } from './profile/filter-action'
import type { ProfileFilterIntent } from './profile/filter-action'
import { replaceColumnFilter } from './grid/query-state'
import type { NestedAction } from './sql/nested-actions'
import type { SqlRunRequest } from './sql/SqlPanel'
import { writeReportCopy } from './validation/report-export'
import { writeDiffReportCopy } from './diff/diff-export'
import { ReplaceGuard } from './replace/ReplaceGuard'
import { CsvReviewDialog } from './csv/CsvReviewDialog'
import type { CsvReviewMode } from './csv/CsvReviewDialog'
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
import { evaluateReadyGesture } from './replace/gate'
import type { OwnedModal, ReadyGestureRefusal } from './replace/gate'
import { NO_REPLACEMENT_INTENT, beginIntent, canAdopt, isIntentCurrent } from './replace/machine'
import type { ReplacementIntent } from './replace/machine'
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
import { useDatasetSession } from './sessions/session-reset'
import { useEditingSession } from './sessions/useEditingSession'
import { useValidationSession } from './sessions/useValidationSession'
import { useDiffSession } from './sessions/useDiffSession'
import type { NavigateToRow, Phase, ScrollRequest } from './sessions/types'
import { readWebTelemetryConfig } from './telemetry/config'
import {
  diffRunOutcome,
  durationSince,
  formatKindFromName,
  reasonCodeFromError,
  validationOutcome,
} from './telemetry/emit'
import { browserStorage, createWebTelemetry } from './telemetry/runtime'
import type { WebTelemetryRuntime } from './telemetry/runtime'
import { TelemetryProvider } from './telemetry/TelemetryContext'
import { TelemetryDisclosure } from './telemetry/TelemetryDisclosure'
import { TelemetrySettings } from './telemetry/TelemetrySettings'
import { WorkbenchHelp, WORKBENCH_HELP_OPEN_LABEL } from './help/WorkbenchHelp'

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
 * ug-17 / UG-27: the count of rules the CURRENT verdict reports as failing
 * (the same `failing` flag the Validation panel renders). Not a row count and
 * never a rule name — the summary is value-free (ADR 0025) and only ever
 * renders when > 0. A stale verdict keeps its count; the panel owns the stale
 * marking, so the summary neither claims freshness nor repeats it.
 */
function failingRuleCount(run: ValidationRunState): number {
  if (run.kind !== 'verdict') return 0
  return run.report.rows.filter((row) => row.failing).length
}

/**
 * ug-17: state summary for the shell-owned Validation toggle, byte-exact
 * (`Validation · <N> failing`, singular and plural alike). `null` at 0 and in
 * every non-verdict state (idle/running/cancelled/failed/binding-errors), so
 * the toggle renders no summary element at all.
 */
export function validationSectionSummary(run: ValidationRunState): string | null {
  const count = failingRuleCount(run)
  return count > 0 ? `Validation \u00b7 ${String(count)} failing` : null
}

/**
 * ug-17: state summary for the shell-owned Compare toggle, byte-exact
 * (`Compare · <N> changed`) from the current row-diff result's `changed`
 * count. `null` for 0 changed and for every non-result state, and a stale
 * result keeps its count (the panel owns the stale marking).
 */
export function comparisonSectionSummary(run: DiffRunState): string | null {
  const count = run.kind === 'result' ? run.report.changed.count : 0
  return count > 0 ? `Compare \u00b7 ${String(count)} changed` : null
}

/**
 * ug-17: state summary for the shell-owned History toggle, byte-exact
 * (`History · <N> pending`). N is `activeOps(history).length` — the SAME
 * staged-operation count R-16 (ug-10) labels in the Profile panel, not a net
 * difference — so the toggle and the panel can never disagree. `null` at
 * cursor 0 and after undoing back to 0.
 */
export function historySectionSummary(history: TransformationHistory): string | null {
  const count = activeOps(history).length
  return count > 0 ? `History \u00b7 ${String(count)} pending` : null
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

interface WorkbenchSectionProps {
  readonly id: WorkbenchSectionId
  readonly children: ReactNode
  /**
   * `managed` (default): this shell owns the section's single disclosure
   * toggle. `inner`: the section's own component already exposes an equivalent
   * `aria-expanded` disclosure (Schema, Profile, Filters — the ux-3/ux-4
   * pattern this shell reuses), so the shell renders NO second toggle and just
   * wraps the content as the nav/scroll target.
   */
  readonly disclosure?: 'managed' | 'inner'
  /**
   * q-15: pane-controlled disclosure state. The tool pane owns the open set
   * (component-local shell state, never engine/data flow — ADR 0044) so a
   * sticky-nav activation can expand its target. Inner-disclosure sections
   * ignore this and stay open (their own control governs content).
   */
  readonly open: boolean
  readonly onToggle?: (id: WorkbenchSectionId) => void
  /**
   * ug-17: optional state summary for a shell-owned toggle (e.g.
   * `Validation · 2 failing`). The call site decides visibility — pass a
   * string only at count > 0 and `null`/nothing otherwise, so a zero count is
   * never rendered. It renders inside the toggle's text column, which keeps
   * it visible while the body is collapsed (the R-14 purpose precedent), and
   * becomes the toggle's SECOND description (after the purpose) without
   * touching the accessible name. Inner-disclosure sections ignore it: their
   * panels own their own collapsed summary (e.g. `Filters · N active`).
   */
  readonly summary?: string | null
}

/**
 * One top-level section shell. Collapse is CSS-only DOM structure + component
 * state: the body stays MOUNTED and gains the `hidden` attribute when
 * collapsed, so the grid's fetch/window/virtualization behavior and the f-2
 * memo boundaries are byte-identical (rendering position only, ADR 0022). The
 * stable `section-<id>` anchor is the sticky nav's scroll target;
 * `scroll-margin-top` (index.css) keeps it clear of the pinned nav.
 */
function WorkbenchSection({
  id,
  children,
  disclosure = 'managed',
  open,
  onToggle,
  summary = null,
}: WorkbenchSectionProps) {
  const title = WORKBENCH_SECTIONS.find((section) => section.id === id)?.title ?? id
  const purpose = WORKBENCH_SECTION_PURPOSES[id]
  const contentId = `section-${id}-content`
  const purposeId = `section-${id}-purpose`
  const summaryId = `section-${id}-summary`
  // Only a shell-owned toggle can carry a summary; inner-disclosure panels
  // keep their own collapsed idiom (Filters) and get none from the shell.
  const summaryText = disclosure === 'managed' ? summary : null
  const toggleLabel = `${open ? 'Collapse' : 'Expand'} ${title}`
  const task = taskOfSection(id)
  return (
    <section
      className="workbench-section"
      id={`section-${id}`}
      data-section={id}
      data-task={task ?? undefined}
    >
      {disclosure === 'managed' && (
        <button
          type="button"
          className="workbench-section-toggle"
          data-testid={`section-toggle-${id}`}
          aria-expanded={open}
          aria-controls={contentId}
          /* ug-13/R-14: the purpose line is the toggle's DESCRIPTION, not its
             name — `Expand/Collapse <Title>` stays the accessible name the
             existing specs and pins query (the ug-4 hint pattern). */
          /* ug-17: the summary joins the description (purpose first, summary
             second) only while one exists; the name above is untouched. */
          aria-describedby={summaryText === null ? purposeId : `${purposeId} ${summaryId}`}
          aria-label={toggleLabel}
          title={toggleLabel}
          onClick={() => {
            onToggle?.(id)
          }}
        >
          <span className="workbench-section-marker" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          <span className="workbench-section-text">
            <span className="workbench-section-label">{title}</span>
            <span
              className="workbench-section-purpose"
              id={purposeId}
              data-testid={`section-purpose-${id}`}
            >
              {purpose}
            </span>
            {summaryText !== null && (
              <span
                className="workbench-section-summary"
                id={summaryId}
                data-testid={`section-summary-${id}`}
              >
                {summaryText}
              </span>
            )}
          </span>
        </button>
      )}
      {/*
       * Inner-disclosure sections (Schema/Filters/Profile/Record) own their
       * own toggle, so the shell renders the same purpose line directly above
       * the body instead of inside a shell button. It stays visible while the
       * inner panel is collapsed (the bodies it describes are the panel's own)
       * and the nav link below points at this stable id.
       */}
      {disclosure === 'inner' && (
        <p
          className="workbench-section-purpose"
          id={purposeId}
          data-testid={`section-purpose-${id}`}
        >
          {purpose}
        </p>
      )}
      <div id={contentId} className="workbench-section-body" hidden={!open}>
        {children}
      </div>
    </section>
  )
}

/**
 * ug-7/R-06: one panel-scope boundary around a tool section's body. The
 * boundary itself owns only the failed/retry state; App owns the section's
 * visibility (managed open set or the inner-disclosure override) and the
 * focus move to the section's existing nav link on close.
 */
function PanelBoundary({
  id,
  onClose,
  children,
}: {
  readonly id: WorkbenchSectionId
  readonly onClose: (id: WorkbenchSectionId) => void
  readonly children: ReactNode
}) {
  return (
    <ErrorBoundary
      scope="panel"
      sectionId={id}
      onClose={() => {
        onClose(id)
      }}
    >
      {children}
    </ErrorBoundary>
  )
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

export interface AppProps {
  /**
   * Telemetry injection seam for tests. When omitted, `App` builds the
   * build-configured runtime (inert in the stock build: no endpoint).
   */
  readonly telemetry?: WebTelemetryRuntime
}

/**
 * WF-06: a fully prepared replacement candidate. Every value here is local to
 * the preparation — the candidate's own handle/base/model/provider (whose
 * overlay source is the candidate-local empty box until `adopt()` rebinds it),
 * its parked identity and open source. Nothing in this record references the
 * live session's `historyRef`, `overlayRef`, `phase` or panels.
 */
interface ReplacementCandidate {
  readonly file: File
  readonly handle: EngineTableHandle
  readonly base: OverlayBase
  readonly model: GridViewportModel
  readonly provider: DuckDbGridProvider
  readonly panels: BottomPanelModules
  readonly identity: SourceIdentity | null
  readonly openSource: { getFile: () => Promise<File> }
}

/**
 * EW-03I-b: what the next ready-state replacement gesture will do once the
 * gate passes. `open` is the shipped candidate open; `review` is the CSV
 * review (EW-03D §3). The Open control always states its own path, so a
 * remembered review can never turn a plain Open into a review — only the
 * guard hand-off (T5) and the failure retry (C11) reuse the remembered path.
 */
type ReplacementPath = 'open' | 'review'

/**
 * EW-03I-b: the CSV review surface's App-owned inputs. The option FORM and the
 * preview payload stay inside `CsvReviewDialog` (they are display state); App
 * keeps only what adoption needs, so the review cannot write session state.
 */
interface CsvReviewHandoff {
  readonly mode: CsvReviewMode
  readonly file: File
  readonly identity: SourceIdentity | null
  /** The phase the gesture started from — WF-06's currency capture. */
  readonly startPhase: Phase
  /** The WF-06 intent sequence the review belongs to. */
  readonly intentSeq: number
}

/**
 * EW-03I-b: one-shot hand-off into the single open chain (idle adoption, or a
 * non-.csv pick from the review control). `options === undefined` keeps the
 * pre-EW-03I open path byte-identical (no options argument at all).
 */
interface CsvAdoptionHandoff {
  readonly file: File
  readonly identity: SourceIdentity | null
  readonly options: EngineCsvOptions | undefined
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
   * f-1: dataset-session epoch + reset registry. `beginSession` bumps the
   * shared token and runs every per-domain reset, so `openDataFile` no longer
   * hand-nulls each session slot. See `sessions/session-reset.ts` for the
   * token/ordering rationale.
   */
  const datasetSession = useDatasetSession()

  const [phase, setPhaseState] = useState<Phase>({ kind: 'idle' })
  /**
   * ug-15: the window-level drop listener is registered once and reads the
   * live phase through this mirror. `dragover`/`drop` must be prevented in
   * every phase (otherwise the browser navigates to the dropped file), while
   * only an idle drop may start an open.
   *
   * The mirror is written SYNCHRONOUSLY by the stable `setPhase` wrapper, not
   * by a passive effect: a drop that lands in the same task as the click that
   * started an open would otherwise still read `idle` (effects have not run
   * yet) and start a second `openDataFile`/`beginSession`, invalidating the
   * first open. `setPhase` is the only writer of either half.
   */
  const phaseRef = useRef(phase)
  const setPhase = useCallback((next: Phase) => {
    phaseRef.current = next
    setPhaseState(next)
  }, [])
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
   * file is opened — a request must never leak across tables.
   */
  const [recordRequest, setRecordRequest] = useState<RecordRequest | null>(null)
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
   * m4-5 export dialog visibility. Closing unmounts the dialog, so its format
   * choice and result reset on every open (no stale "Exported…" line from a
   * previous session). The dialog itself never touches the base source
   * (ADR 0012).
   */
  const [exportOpen, setExportOpen] = useState(false)

  /** The replacement intent (App-local; never part of `Phase`). */
  const [intent, setIntentState] = useState<ReplacementIntent>(NO_REPLACEMENT_INTENT)
  /**
   * Synchronous mirror of the intent. The gate (G2), the guard-close→choosing
   * transition (T5) and `adopt()` step 0 all need the CURRENT intent, not the
   * value captured by the render that created the handler.
   */
  const intentRef = useRef<ReplacementIntent>(NO_REPLACEMENT_INTENT)
  /** The sequence authority (C2): bumped when an intent is entered. */
  const intentSeqRef = useRef(0)
  const setIntent = useCallback((next: ReplacementIntent) => {
    intentRef.current = next
    setIntentState(next)
  }, [])
  /**
   * The App-owned editor-state authority (S-A2-1/IC-01). `DataGrid` writes it
   * synchronously at every editor transition; the gesture gate reads it and
   * never a render value.
   */
  const editorStateRef = useRef<EditorReportState>({ open: false, invalid: false })
  /** C9's progress element, focused explicitly when the region goes inert. */
  const replaceProgressRef = useRef<HTMLDivElement | null>(null)
  /** T6: the picker was dismissed; the live session is unchanged (C8). */
  const [pickerWasCancelled, setPickerWasCancelled] = useState(false)
  /** T9/T9b: the candidate failed; only C10 + C14 render (live session kept). */
  const [replacementFailure, setReplacementFailure] = useState<{
    readonly cause: string
    readonly detail: string
  } | null>(null)
  /** C12 — a ready gesture arrived while another intent is active. */
  const [busyNotice, setBusyNotice] = useState(false)
  /** C13 — G3 refusal; clears when the editor closes (the mirror callback). */
  const [draftNotice, setDraftNotice] = useState(false)
  /**
   * EW-03I-b — the CSV review surface (ADR 0049; envelope §5.1/§5.2).
   *
   * `csvReview` is App-local UI state, never a `Phase` and never an intent
   * kind: the review is a candidate step of the EXISTING replacement intent
   * ("choosing" owns the shell while the modal is up), so nothing here is a
   * second writer of the session lifecycle. It carries exactly what adoption
   * needs — the picked `File`, its FSA identity and the phase the gesture
   * started from — and nothing about the engine slot.
   */
  const [csvReview, setCsvReview] = useState<CsvReviewHandoff | null>(null)
  /** "You stopped reviewing" — abandonment copy, cleared by the next gesture. */
  const [csvReviewStopped, setCsvReviewStopped] = useState<CsvReviewMode | null>(null)
  /**
   * The path the user chose for the next replacement gesture (EW-03D §3):
   * plain open, or the CSV review. Remembered across the dirty guard (T5) and
   * the failure retry (C11) so a review gesture stays a review gesture; the
   * Open control always states its own mode, so this can never silently turn
   * a plain Open into a review.
   */
  const desiredModeRef = useRef<ReplacementPath>('open')
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
   * IC-01: the render-only editor-state mirror. The ref write alone cannot
   * re-render App, so the grid calls this at the same handler writes when the
   * reported state CHANGES (never per keystroke). Its only job is clearing
   * C13 the moment the editor closes — by Escape, by an ordinary commit, or
   * by a blur commit — with no second Open click and no unrelated rerender.
   */
  const handleEditorStateChange = useCallback((next: EditorReportState) => {
    if (!next.open) setDraftNotice(false)
  }, [])

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
   * ug-9/R-15: the open dataset as App-held state. The opened `File` is
   * retained for the rest of the session so a pipeline source node can bind
   * it without a second OS picker ("Use the open dataset"). This is a
   * reference only — no bytes are read here — and it is deliberately NOT the
   * export same-source identity (`sourceIdentityRef`): a plain `File` has no
   * `FileSystemHandle`, so it can never prove same-entry. Set on every
   * successful open (picker, hidden-input fallback, bundled example), cleared
   * by the session reset and at the start of every open attempt. The name is
   * transported to the engine for format detection only and never rendered
   * or logged (ADR 0025).
   */
  const openSourceRef = useRef<{ getFile: () => Promise<File> } | null>(null)
  useEffect(
    () =>
      datasetSession.registerReset(() => {
        // A new dataset epoch owns a new open source; nothing from the
        // previous session may be re-bound in the pipeline panel.
        openSourceRef.current = null
      }),
    [datasetSession],
  )

  /**
   * m3-5 nested-action dispatch: both click surfaces (schema tree, grid
   * headers) emit a `NestedAction`; the app composes it through m3-4's pure
   * composer against the parsed schema and the SQL-facing view name, then
   * hands the SQL to the m2-4 pane via `sqlRequest`.
   */ const [sqlRequest, setSqlRequest] = useState<SqlRunRequest | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const requestSeq = useRef(0)
  /**
   * R-07: App-owned, session-scoped consumption state. The ledger instance
   * (not the SQL pane) decides whether an external request is new; see the
   * `SqlRequestLedger` contract above. It is stable for the App lifetime.
   */
  const sqlRequestLedger = useMemo(() => createSqlRequestLedger(), [])
  const claimSqlRequest = useCallback(
    (request: SqlRunRequest) => sqlRequestLedger.claim(request, datasetSession.tokenRef.current),
    [datasetSession, sqlRequestLedger],
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
  } = useEditingSession(phase, datasetSession, sourceIdentityRef)

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
   * today) still navigates, silently.
   */
  const [scrollRequest, setScrollRequest] = useState<ScrollRequest | null>(null)
  const scrollSeq = useRef(0)
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
  }, [handleRedo, handleUndo])

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
        if (intentRef.current.kind !== 'none') return
        revealSectionFromNav('export')
        setExportOpen(true)
        return
      default:
        return
    }
  }, [
    nextAction.kind,
    revealContextPanel,
    revealSectionFromNav,
    handleValidate,
    handleCancelValidate,
    handleCancelDiff,
  ])
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
        session: datasetSession.tokenRef.current,
      })
    },
    [datasetSession, nestedSpecs, openSection, phase],
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
   *   included — no new chip code). An engine rejection rolls the previous
   *   filter list back and surfaces the existing framed `filter` error copy.
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
   *    (`profileFilterPending`) and a further click is ignored, so no later
   *    list can be submitted that an earlier attempt's failure rollback would
   *    then supersede. `GridViewportModel.setFilters` serializes calls
   *    last-request-wins, so an unconditional rollback issued after a newer
   *    action would overwrite that action's list — this gate makes that
   *    sequence unrepresentable.
   * 2. *Attempt/session identity*: every attempt captures its token, its
   *    originating model and the dataset-session token; after EVERY `await`
   *    the attempt must still be the current one on the live session and the
   *    originating model must still be active, otherwise the completion is a
   *    silent no-op — no `setFilters` rollback, no feedback. This is what
   *    stops a late rejection from a previous dataset (or from before an
   *    undo/redo cursor move) restoring stale filters or resurrecting
   *    feedback on the session that replaced it.
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
      const originSession = datasetSession.tokenRef.current
      const previous = originModel.filters
      const next = replaceColumnFilter(previous, plan.column, plan.predicate)
      const attempt = (profileFilterAttemptRef.current += 1)
      /**
       * True only while this attempt is still the current one, on the live
       * dataset session, with its originating model still active. Checked
       * after every `await`: a superseded attempt must not touch either
       * filters or feedback.
       */
      const isCurrentAttempt = (): boolean => {
        if (profileFilterAttemptRef.current !== attempt) return false
        if (datasetSession.tokenRef.current !== originSession) return false
        const live = phaseRef.current
        return live.kind === 'ready' && live.model === originModel
      }
      profileFilterPendingRef.current = true
      setProfileFilterPending(true)
      void (async () => {
        try {
          await originModel.setFilters(next)
        } catch (cause) {
          // A superseded attempt's rejection is swallowed: rolling back now
          // would replace a newer list (or a newer session's state).
          if (!isCurrentAttempt()) return
          const message = engineErrorMessage('filter', cause)
          try {
            await originModel.setFilters(previous)
            if (!isCurrentAttempt()) return
            setProfileFilterError(message)
          } catch {
            if (!isCurrentAttempt()) return
            // Same double-failure honesty as the FilterBar: the single-failure
            // framing would claim the previous filters are back in effect,
            // which is exactly what could not be restored.
            setProfileFilterError(
              'The filter could not be applied and the previous filters could not be restored. ' +
                'Re-apply a filter or reopen the dataset if the grid looks wrong.',
            )
          }
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
    [clearProfileFilterFeedback, datasetSession, history, modelSchema, phase],
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
   * ug-21: cancel an in-flight open by starting a new (empty) dataset session
   * and returning to the normal idle frame. There is no engine interrupt in
   * the protocol, so this does NOT abort the engine operation: it bumps the
   * shared session token through `beginSession` (running every registered
   * domain reset) and the open chain's post-await token comparisons drop the
   * late result. Honest UI reset + token discard, never a claimed abort.
   */
  const cancelOpen = useCallback(() => {
    datasetSession.beginSession()
    setPhase({ kind: 'idle' })
  }, [datasetSession, setPhase])

  /* ---------------------------------------------------------------------
   * WF-06 — session-preserving replacement (the reviewed v5 lifecycle).
   *
   * The legacy idle/example/drop/retry/cancel chain above and below is
   * unchanged. A ready-state Open now runs the synchronous G1–G6 gate first;
   * only a prepared candidate that adopts atomically ever ends the live
   * session. A cancelled chooser or a failed candidate leaves every live
   * session slot untouched (T3/T4/T6/T9/T9b/T10) — see the intent/notice
   * transitions below.
   * ------------------------------------------------------------------- */

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
   * Clear the GESTURE-scoped notices a newer gesture (or a finished intent)
   * supersedes. C15/C16 are deliberately absent: they follow their own live
   * observables and no gesture may clear them early.
   */
  const clearReplacementNotices = (): void => {
    setPickerWasCancelled(false)
    setReplacementFailure(null)
    setBusyNotice(false)
    setDraftNotice(false)
    setCsvReviewStopped(null)
  }

  /** End the current intent without touching the live session. */
  const endReplacementIntent = (): void => {
    setIntent(NO_REPLACEMENT_INTENT)
    setBusyNotice(false)
  }

  /**
   * Enter one in-flight intent: bump the sequence authority first, then publish
   * the intent carrying that sequence (C2). Returns the sequence the async
   * chain must keep comparing against `intentSeqRef.current`.
   */
  const enterReplacementIntent = (kind: 'guard' | 'choosing' | 'opening-candidate'): number => {
    intentSeqRef.current += 1
    const seq = intentSeqRef.current
    setIntent(beginIntent(kind, seq))
    return seq
  }

  /**
   * G3's per-kind focus chain (§3.2.1): the boolean editor's own testid, then
   * the text/number/temporal input, then the shared editor container, then the
   * roving row, then the Open control. Never `<body>`: the Open control is
   * always connected. The refusal only moves focus — it never commits,
   * cancels or types anything.
   */
  const focusDraftRefusal = (): void => {
    const selectors = [
      '[data-testid="grid-editor-boolean"]',
      '[data-testid="grid-editor-input"]',
      '[data-testid="grid-cell-editor"]',
      '[data-testid="grid-viewport"] [data-testid="grid-row"][tabindex="0"]',
      '[data-testid="open-button"]',
    ]
    for (const selector of selectors) {
      const target = document.querySelector<HTMLElement>(selector)
      if (target === null) continue
      target.focus()
      return
    }
  }

  /** One refusal: a value-free notice (or the existing idle/status path). */
  const applyReplacementRefusal = (reason: ReadyGestureRefusal): void => {
    switch (reason) {
      case 'modal':
        // Existing arbitration: the opener is disabled while another owned
        // surface is open, so this path is defensive only — no notice.
        return
      case 'intent':
        setBusyNotice(true)
        return
      case 'editor':
        setDraftNotice(true)
        focusDraftRefusal()
        return
      case 'settling':
      case 'cast':
        // C15/C16 are already rendered because their observable is live; a
        // refusal adds nothing and (critically) never owns their lifetime.
        return
      case 'busy':
        // G5 reuses the grid's existing filter/sort busy status; no new copy.
        return
    }
  }

  /**
   * T9/T9b: the candidate failed before adoption. The live session keeps every
   * slot (only the notice state changes) and one retained candidate table may
   * exist in this worker (ADR 0047 — no release primitive; never claimed
   * leak-free). The C10 cause is the classified, value-free sentence; the raw
   * diagnostic is parked for the collapsed C14 block only.
   */
  const failReplacement = (error: unknown): void => {
    endReplacementIntent()
    setReplacementFailure({
      cause: openFailureMessage(error, error instanceof Error ? error.name : undefined),
      detail: error instanceof Error ? error.message : String(error),
    })
  }

  /**
   * T1/T5/T6/T7 — acquire and prepare a candidate while the live session stays
   * live. The picker is invoked synchronously from the triggering gesture (the
   * File System Access picker needs the transient user activation), so the gate
   * above it must already have run; nothing here awaits before it.
   */
  const acquireReplacementCandidate = (startPhase: Phase): void => {
    const seq = enterReplacementIntent('choosing')
    // The picked FSA handle is the ground truth for the export same-source
    // guard (as in the legacy flow); structural fakes may omit it.
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
      } catch (error) {
        if (!isIntentCurrent(intentSeqRef.current, seq, phaseRef.current, startPhase)) return
        failReplacement(error)
        return
      }
      if (!isIntentCurrent(intentSeqRef.current, seq, phaseRef.current, startPhase)) return
      if (picked === null) {
        // T6: chooser dismissed. No reset, no phase write — the live session
        // is byte-identical, and C8 says so.
        endReplacementIntent()
        setPickerWasCancelled(true)
        return
      }
      const identity: SourceIdentity | null =
        openCapture.handle === null
          ? null
          : { isSameEntry: openCapture.handle.isSameEntry.bind(openCapture.handle) }
      let file: File
      try {
        file = await picked.source.getFile()
      } catch (error) {
        if (!isIntentCurrent(intentSeqRef.current, seq, phaseRef.current, startPhase)) return
        failReplacement(error)
        return
      }
      if (!isIntentCurrent(intentSeqRef.current, seq, phaseRef.current, startPhase)) return
      prepareReplacementCandidate({ file, identity, startPhase })
    })()
  }

  /**
   * T7–T9b — prepare the candidate against its OWN base and an EMPTY local
   * overlay box (A1-1/A1-2). The live session's refs, phase, provider, history
   * and panels are untouched for the whole preparation. A1's stop rule applies:
   * if a candidate read could reach `overlayRef` this would be a data-correctness
   * defect, not a cosmetic one — the closure below references no App ref.
   */
  const prepareReplacementCandidate = (input: {
    readonly file: File
    readonly identity: SourceIdentity | null
    readonly startPhase: Phase
    /**
     * EW-03I-b: the reviewed CSV option set, when this candidate came from
     * the CSV review. It is passed straight to `engine/open` — a fresh open
     * carrying the reviewed options (ADR 0049 acceptance resolution 5), never
     * a promotion and never a second `TableRegistry` writer. `undefined` for
     * every other path, which keeps that request byte-identical.
     */
    readonly csvOptions?: EngineCsvOptions
  }): void => {
    const { file, identity, startPhase, csvOptions } = input
    const seq = enterReplacementIntent('opening-candidate')
    void (async () => {
      try {
        const source = { name: file.name, getFile: () => Promise.resolve(file) }
        // Wire shape only: a fresh plain record (structured clone), which the
        // client and the worker each re-validate through the same total
        // `parseCsvOptions` — no trust crosses the boundary. No reviewed
        // options ⇒ the exact single-argument call this chain always made.
        const reviewed = wireCsvOptions(csvOptions ?? {})
        const handle =
          reviewed === undefined
            ? await engineClient.open(source)
            : await engineClient.open(source, reviewed)
        if (!isIntentCurrent(intentSeqRef.current, seq, phaseRef.current, startPhase)) return
        const candidateSchema = await engineClient.schema(handle)
        if (!isIntentCurrent(intentSeqRef.current, seq, phaseRef.current, startPhase)) return
        const candidateRowCount = await engineClient.rowCount(handle)
        if (!isIntentCurrent(intentSeqRef.current, seq, phaseRef.current, startPhase)) return
        const candidateBase: OverlayBase = {
          baseAnchor: fileVersionAnchor({ size: file.size, lastModified: file.lastModified }),
          overlayAnchor: createOverlayAnchor(),
          columns: candidateSchema.map((column) => ({ name: column.name, type: column.type })),
          baseRowCount: candidateRowCount,
        }
        // A1-1: candidate-local box, built from the CANDIDATE's base. No live
        // ref, history or phase value is captured (A1-2).
        const candidateOverlayBox = { current: overlaySnapshot(candidateBase, emptyHistory()) }
        const candidateProvider = new DuckDbGridProvider(
          engineClient,
          handle,
          () => candidateOverlayBox.current,
        )
        const candidateModel = new GridViewportModel(candidateProvider)
        await candidateModel.load()
        if (!isIntentCurrent(intentSeqRef.current, seq, phaseRef.current, startPhase)) return
        const panels = await preloadBottomPanels()
        if (!isIntentCurrent(intentSeqRef.current, seq, phaseRef.current, startPhase)) return
        adoptReplacementCandidate(
          {
            file,
            handle,
            base: candidateBase,
            model: candidateModel,
            provider: candidateProvider,
            panels,
            identity,
            openSource: { getFile: () => Promise.resolve(file) },
          },
          startPhase,
        )
      } catch (error) {
        if (!isIntentCurrent(intentSeqRef.current, seq, phaseRef.current, startPhase)) return
        failReplacement(error)
      }
    })()
  }

  /* ---------------------------------------------------------------------
   * EW-03I-b — the CSV review path (ADR 0049 decisions 4/6/7; EW-03D §3).
   *
   * The review is a CANDIDATE step of the existing machinery, not a second
   * lifecycle: in a ready session it occupies the same `choosing` intent (so
   * the shell stays owned, Open/Help stay disabled and G2 refuses a competing
   * gesture) and adoption goes through the same `prepareReplacementCandidate`
   * → `adoptReplacementCandidate` pair, exactly once, carrying the reviewed
   * options into a fresh `engine/open`. In idle there is no session to guard,
   * so adoption hands the reviewed file + options to the one existing open
   * chain through a one-shot ref — the same precedent as the idle example and
   * the dropped file.
   *
   * The preview itself never adopts: `CsvReviewDialog` only ever calls
   * `csvPreview`. Abandonment drops the local candidate, bumps the sequence
   * authority so every late result is discarded, and claims nothing about the
   * engine (envelope §5a: there is no host-reachable release op).
   * ------------------------------------------------------------------- */

  /** The engine's non-adopting preview call, stable for the dialog's effect. */
  const previewCsvSource = useCallback(
    (
      source: { readonly name: string; getFile(): Promise<File> },
      options?: Record<string, unknown>,
      sampleRows?: number,
    ) => engineClient.csvPreview(source, options, sampleRows),
    [],
  )

  /**
   * The ready-state review acquisition (T1/T5/T6/T7 shape): the picker runs
   * synchronously from the gesture, then a CSV pick opens the review instead
   * of preparing a candidate. A cancelled chooser is T6 (C8: nothing opened,
   * session unchanged); a non-CSV pick falls through to the ordinary candidate
   * preparation unchanged.
   */
  const acquireCsvReview = (startPhase: Phase): void => {
    const seq = enterReplacementIntent('choosing')
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
      } catch (error) {
        if (!isIntentCurrent(intentSeqRef.current, seq, phaseRef.current, startPhase)) return
        failReplacement(error)
        return
      }
      if (!isIntentCurrent(intentSeqRef.current, seq, phaseRef.current, startPhase)) return
      if (picked === null) {
        endReplacementIntent()
        setPickerWasCancelled(true)
        return
      }
      const identity: SourceIdentity | null =
        openCapture.handle === null
          ? null
          : { isSameEntry: openCapture.handle.isSameEntry.bind(openCapture.handle) }
      let file: File
      try {
        file = await picked.source.getFile()
      } catch (error) {
        if (!isIntentCurrent(intentSeqRef.current, seq, phaseRef.current, startPhase)) return
        failReplacement(error)
        return
      }
      if (!isIntentCurrent(intentSeqRef.current, seq, phaseRef.current, startPhase)) return
      if (detectFormatFromFileName(file.name) !== 'csv') {
        prepareReplacementCandidate({ file, identity, startPhase })
        return
      }
      setCsvReviewStopped(null)
      setCsvReview({ mode: 'replace', file, identity, startPhase, intentSeq: seq })
    })()
  }

  /**
   * Adoption of a reviewed CSV — the only irreversible step, and the only one
   * that ever writes a session. Idle: one-shot hand-off to `openDataFile` with
   * the reviewed options. Ready: the existing guarded preparation, which ends
   * in the same exactly-once `adoptReplacementCandidate`.
   */
  const adoptCsvReview = (handoff: CsvReviewHandoff, options: EngineCsvOptions): void => {
    setCsvReviewStopped(null)
    setCsvReview(null)
    if (handoff.mode === 'idle') {
      pendingReviewHandoffRef.current = {
        file: handoff.file,
        identity: handoff.identity,
        options,
      }
      void openDataFile()
      return
    }
    // Defensive (the modal owns the shell, so no gesture can supersede it):
    // if the intent or the phase moved, open nothing and say so.
    if (
      !isIntentCurrent(
        intentSeqRef.current,
        handoff.intentSeq,
        phaseRef.current,
        handoff.startPhase,
      )
    ) {
      endReplacementIntent()
      setCsvReviewStopped('replace')
      return
    }
    prepareReplacementCandidate({
      file: handoff.file,
      identity: handoff.identity,
      startPhase: handoff.startPhase,
      csvOptions: options,
    })
  }

  /**
   * Abandonment (ADR 0049 item 7; envelope §5a). Drops the candidate, bumps the
   * sequence authority so a late preview result can never be adopted, ends any
   * intent, and says "stopped reviewing" — never "aborted", and never that a
   * preview slot was released. There is no host-reachable release op, so one
   * staged preview stays retained until the next preview, an open, or
   * `engine/dispose`; this row discloses that rather than faking a call.
   */
  const stopCsvReview = (handoff: CsvReviewHandoff): void => {
    intentSeqRef.current += 1
    setCsvReview(null)
    endReplacementIntent()
    setPickerWasCancelled(false)
    setReplacementFailure(null)
    setCsvReviewStopped(handoff.mode)
  }

  /**
   * T8 — `adopt()`, the only irreversible step (v5 §4.3, steps 0–9 in order).
   *
   * Fully synchronous: no `await`, no `model.refresh()`, no second worker, no
   * reopen, no release. Step 0 refuses when the intent was superseded or the
   * phase changed (defensive — no gesture can reach it); a refusal writes
   * nothing at all. `dataset_opened` is emitted exactly as the legacy open does.
   */
  const adoptReplacementCandidate = (
    candidate: ReplacementCandidate,
    startPhase: Phase,
  ): boolean => {
    if (
      !canAdopt({
        intent: intentRef.current,
        currentSeq: intentSeqRef.current,
        phase: phaseRef.current,
        capturedPhase: startPhase,
      })
    ) {
      return false
    }
    // 1. One new dataset session: token bump + every registered reset.
    datasetSession.beginSession()
    // 2–3. The adopted base is the candidate's own; republish history/overlay
    // AFTER the reset (the reset nulls both).
    const adoptedHistory = emptyHistory()
    const adoptedOverlay = overlaySnapshot(candidate.base, adoptedHistory)
    historyRef.current = adoptedHistory
    overlayRef.current = adoptedOverlay
    // 4. A1-3: only now may the candidate provider follow the live session.
    candidate.provider.rebindOverlaySource(() => overlayRef.current ?? adoptedOverlay)
    // 5. The adopted session's identity and bound open source.
    sourceIdentityRef.current = candidate.identity
    openSourceRef.current = candidate.openSource
    // 6. Panels resolved during preparation, published before the ready frame.
    setPanelModules(candidate.panels)
    // 7. Publish the ready phase (one render), retiring the previous session's
    // app-local requests so nothing from it can address the new table.
    setRecordRequest(null)
    setExportOpen(false)
    setSqlRequest(null)
    setActionError(null)
    setScrollRequest(null)
    setPhase({
      kind: 'ready',
      model: candidate.model,
      tableId: candidate.handle.id,
      handle: candidate.handle,
      base: candidate.base,
      provider: candidate.provider,
    })
    // 8. `dataset_opened` — closed enums only, exactly as the legacy open.
    telemetry.emit('dataset_opened', {
      dataset_role: 'primary',
      format_kind: formatKindFromName(candidate.file.name),
      size_bucket: bucketSize(candidate.file.size),
      row_count_bucket: bucketRowCount(candidate.base.baseRowCount),
      column_count_bucket: bucketColumnCount(candidate.base.columns.length),
    })
    // 9. The intent ends last.
    clearReplacementNotices()
    setIntent(NO_REPLACEMENT_INTENT)
    return true
  }

  /**
   * The single ready-state entry point (G1–G6). `gateModal` is the owned-modal
   * value the gate sees — `openModal` for a fresh gesture, or the non-replace
   * value when the guard itself is closing into choosing (T5), where the modal
   * is already gone so G1 must pass. `respectDirtyGuard` is false for T5/C11,
   * which re-enter `choosing` directly.
   *
   * EW-03I-b: `path` selects WHICH picker path the gesture takes once the gate
   * passes — the shipped candidate open (default) or the CSV review. It is a
   * path choice, not a new lifecycle state: the gate, the guard, the notices,
   * the intent kinds and the adoption step are unchanged for both. The chosen
   * path is remembered in `desiredPathRef` so T5 (choose from the guard) and
   * C11 (retry) resume the same path without inventing a per-intent field; the
   * two entry controls always state theirs explicitly.
   */
  const startReplacementGate = (
    gateModal: OwnedModal | null,
    respectDirtyGuard: boolean,
    path?: ReplacementPath,
  ): void => {
    const livePhase = phaseRef.current
    if (livePhase.kind !== 'ready') return
    if (path !== undefined) desiredModeRef.current = path
    const wantedPath = desiredModeRef.current
    // v5 §3.2: the gate runs FIRST — before any dialog, picker, await or state
    // write. Notices are cleared only once the verdict is known; a refusal then
    // sets its own notice, so a stale notice can never be cleared by a gesture
    // the gate refused for another reason, and the gate never observes a render
    // it caused.
    const verdict = evaluateReadyGesture({
      openModal: gateModal,
      intent: intentRef.current,
      editorOpen: editorStateRef.current.open,
      mutations: mutationStateRef.current,
      castPendingCount: castPendingColumnsRef.current.size,
      gridBusy,
      history: historyRef.current,
    })
    clearReplacementNotices()
    if (verdict.kind === 'refuse') {
      applyReplacementRefusal(verdict.reason)
      return
    }
    if (respectDirtyGuard && verdict.dirty) {
      enterReplacementIntent('guard')
      return
    }
    if (wantedPath === 'review') acquireCsvReview(livePhase)
    else acquireReplacementCandidate(livePhase)
  }

  /** T3: Stay / Escape — byte-identical live session, no other effect. */
  const stayOnGuard = (): void => {
    endReplacementIntent()
  }

  /**
   * T4 — export-first: the guard closes, the intent ends, then the EXISTING
   * exporter opens. No export outcome advances, resets or marks the session
   * clean, and nothing auto-opens a chooser afterwards.
   */
  const exportFirstFromGuard = (): void => {
    endReplacementIntent()
    revealSectionFromNav('export')
    setExportOpen(true)
  }

  /**
   * T5 — the guard's destructive action re-enters `choosing`.
   *
   * `ReplaceGuard` closes the native dialog element SYNCHRONOUSLY before it
   * calls this handler (v5 §3.2/T5: "the modal closed first, so G1 passes"),
   * so the picker that `acquireReplacementCandidate` invokes below is never
   * started behind an open modal. The intent also drops to `none` before the
   * gate so G2 passes for this one transition; `otherModal` is the G1 input and
   * still refuses if another owned surface is open.
   */
  const chooseFromGuard = (): void => {
    if (phaseRef.current.kind !== 'ready') return
    setIntent(NO_REPLACEMENT_INTENT)
    startReplacementGate(otherModal, false)
  }

  /** C11 — retry re-enters `choosing`; it is never the destroy-first flow. */
  const retryReplacement = (): void => {
    startReplacementGate(otherModal, false)
  }

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
    setCsvReviewStopped(null)
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
    openSourceRef.current = null
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
        file = await picked.source.getFile()
        if (datasetSession.tokenRef.current !== session) return
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
      // open derives it here exactly as before.
      sourceIdentityRef.current =
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
      // ug-9/R-15: retain the opened `File` for the rest of the session so a
      // pipeline source node can bind it with no picker. Only a successful
      // open publishes this — a failed chain leaves the previous reset in
      // force.
      openSourceRef.current = { getFile: () => Promise.resolve(file) }
      // `dataset_opened` (design §2/Appendix C): role/format/size/row/column
      // buckets only — the file name is read for its extension and discarded
      // (ADR 0025). The runtime enforces the 50-per-session cap.
      telemetry.emit('dataset_opened', {
        dataset_role: 'primary',
        format_kind: formatKindFromName(file.name),
        size_bucket: bucketSize(file.size),
        row_count_bucket: bucketRowCount(baseRowCount),
        column_count_bucket: bucketColumnCount(baseSchema.length),
      })
    } catch (error) {
      // A stale chain must not surface its failure over the newer phase.
      if (datasetSession.tokenRef.current !== session) return
      // `dataset_open_failed` (design §2/Appendix C): a closed reason enum
      // only; the error message/stack are never attached (ADR 0025/R3).
      telemetry.emit('dataset_open_failed', {
        dataset_role: 'primary',
        format_kind: 'unknown',
        reason_code: reasonCodeFromError(error),
      })
      setPhase({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
        // UG-5: a `DOMException` (`getFile()` missing/unreadable/refused)
        // carries its cause in the NAME while its message is generic, so the
        // alert needs the name to classify. The name is a closed, value-free
        // identifier and is never attached to telemetry (ADR 0025).
        errorName: error instanceof Error ? error.name : undefined,
      })
    }
  }, [datasetSession, historyRef, overlayRef, setPhase, telemetry])

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
    const session = datasetSession.tokenRef.current
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
      if (datasetSession.tokenRef.current !== session) return
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
        if (datasetSession.tokenRef.current !== session) return
        if (phaseRef.current.kind !== 'idle') return
        // The same terminal error frame the open chain uses for this exact
        // failure (a picked file that cannot be read); no second
        // classification and no new copy.
        setPhase({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
          errorName: error instanceof Error ? error.name : undefined,
        })
        return
      }
      if (datasetSession.tokenRef.current !== session) return
      if (phaseRef.current.kind !== 'idle') return
      if (detectFormatFromFileName(file.name) !== 'csv') {
        pendingReviewHandoffRef.current = { file, identity, options: undefined }
        void openDataFile()
        return
      }
      setCsvReviewStopped(null)
      setCsvReview({ mode: 'idle', file, identity, startPhase: phaseRef.current, intentSeq: 0 })
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
  }, [openDataFile])

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
            onStay={stayOnGuard}
            onExport={exportFirstFromGuard}
            onChoose={chooseFromGuard}
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
            requestPreview={previewCsvSource}
            onAdopt={(options) => {
              adoptCsvReview(csvReview, options)
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
              if (phase.kind === 'ready') startReplacementGate(openModal, true, 'open')
              else void openDataFile()
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
                if (phase.kind === 'ready') startReplacementGate(openModal, true, 'review')
                else startCsvReviewFromIdle()
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
              <button type="button" data-testid="replace-retry" onClick={retryReplacement}>
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
                            runEngineExport={runExport}
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
