// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Diff presentation controller (D03b) — the desktop dataset webview's compare
 * surface: staged comparison disclosure, key selection/confirmation, one
 * confirmed row diff, the report rendering, its stale marker, and the report
 * export request.
 *
 * Extracted from the webview entry so the entry stays composition/wiring: the
 * controller receives explicit inputs (message port, revision/overlay/
 * effective-columns seams, engine diff/profile seams, row navigation) and
 * publishes only DOM text/nodes and posted request frames. DOM-free decisions
 * live in `src/pure/diff-presenter.ts`.
 *
 * Invariants (unchanged by the split):
 * - nothing runs before explicit confirmation, and the refusal line names why,
 * - a FAILED or superseded run retains the previous report (status says so),
 * - the stale flag is recomputed against the CURRENT revision for both the
 *   marker and the exported report body (never the publish-time flag),
 * - only A-side samples navigate; B-side samples are display-only,
 * - the exported report is create-only and stays canonical (`projectDiffReport`).
 */
import type {
  EngineColumnSchema,
  EngineComparisonHandle,
  EngineDatasetProfile,
  EngineFileSource,
  EngineTableHandle,
  EngineOverlay,
} from '@assay/engine-duckdb'
import { diffDatasets, inferRowDiffKeys } from '@assay/diff'
import type { RowDiffPlan } from '@assay/diff'
import type { DiffColumn, DiffReportView, EngineDiffResult } from '../src/pure/diff-controller'
import {
  buildDiffReport,
  compileConfirmedDiff,
  describeDiffCompileFailure,
  isCurrentDiffRequest,
  selectDiffSampleNavigation,
} from '../src/pure/diff-controller'
import {
  COMPARISON_REPLACE_REFUSED,
  COMPARISON_SELECT_PROMPT,
  COMPARISON_STAGE_BUSY_REFUSED,
  COMPARISON_STAGE_FAILED,
  DIFF_CANCELLED_STATUS,
  DIFF_COMPLETE_STATUS,
  DIFF_FAILED_STATUS,
  DIFF_NAVIGATION_FAILED,
  DIFF_RUNNING_STATUS,
  DIFF_SAMPLE_NOT_IN_VIEW,
  PROPOSAL_ONLY_STATUS,
  REPORT_EXPORT_PROMPT,
  STAGED_INTRO,
  STAGED_READY_STATUS,
  buildReportExportPayload,
  confirmedDiffKeys,
  describeComparisonFrameFailure,
  describeDiffAspectHeading,
  describeDiffGroupHeading,
  describeDiffIssues,
  describeDiffMetadata,
  describeDiffRefusal,
  describeDiffSample,
  describeDiffVerdict,
  describeKeyCandidate,
  describeKeyOptions,
  describeReportExportStatus,
  describeStagedComparison,
  diffStaleVisible,
  toDiffProfile,
} from '../src/pure/diff-presenter'
import { elementOrThrow } from './dom'

/** A comparison file handed to the panel by the host (staging frame). */
export interface StagedComparisonFrame {
  readonly id: string
  readonly generation: number
  readonly name: string
  readonly displayName: string
  readonly bytes: ArrayBuffer
}

/** Explicit inputs of the diff panel. */
export interface DiffPanelPorts {
  /** Post a request frame to the extension host. */
  readonly post: (message: unknown) => void
  /** The opened dataset's engine handle (side A of every comparison). */
  readonly datasetHandle: EngineTableHandle
  /** The edit controller's current revision (staleness + report body). */
  readonly currentRevision: () => number
  /** Whether an edit operation is in flight (staging/diff are refused). */
  readonly editPending: () => boolean
  /** Effective columns of the view side A compares. */
  readonly effectiveColumns: () => readonly DiffColumn[]
  /** Effective overlay of the view side A compares. */
  readonly overlay: () => EngineOverlay
  /** Engine seams. */
  readonly stageComparison: (source: EngineFileSource) => Promise<EngineComparisonHandle>
  readonly openComparison: (source: EngineFileSource) => Promise<EngineTableHandle>
  readonly schema: (handle: EngineTableHandle) => Promise<readonly EngineColumnSchema[]>
  readonly profile: (handle: EngineTableHandle) => Promise<EngineDatasetProfile>
  readonly runDiff: (
    comparison: EngineComparisonHandle,
    plan: RowDiffPlan,
    overlay: EngineOverlay,
  ) => Promise<EngineDiffResult>
  /** Resolve a logical A-side row key in the grid; `false` when not in view. */
  readonly navigateToRow: (rowKey: string) => Promise<boolean>
  /** New capability token id. */
  readonly createId: () => string
}

/**
 * The diff panel. One instance per opened dataset panel; `mount()` wires the
 * controls exactly once.
 */
export class DiffPanel {
  private comparisonGeneration = 0
  private comparisonRequest: { readonly id: string; readonly generation: number } | null = null
  private comparisonHandle: EngineComparisonHandle | null = null
  private comparisonSchema: DiffColumn[] = []
  private comparisonDiff: ReturnType<typeof diffDatasets> | null = null
  private comparisonInference: ReturnType<typeof inferRowDiffKeys> | null = null
  private comparisonProfile: ReturnType<typeof toDiffProfile> | null = null
  private comparisonDisplayName = ''
  private comparisonBusy = false
  private diffGeneration = 0
  private diffBusy = false
  private diffConfirmed = false
  private report: DiffReportView | null = null
  private keySource: 'explicit' | 'inferred' = 'explicit'
  private reportExportRequest: { readonly id: string; readonly generation: number } | null = null
  private mounted = false
  /**
   * Test-harness only: names the comparison fixture the NEXT select pick
   * stages (validated host-side); production never sets it.
   */
  private nextTestFixture: string | undefined

  constructor(private readonly ports: DiffPanelPorts) {}

  /** The published report (retained across failed/superseded runs). */
  get publishedReport(): DiffReportView | null {
    return this.report
  }

  /** Whether a diff run is in flight. */
  get running(): boolean {
    return this.diffBusy
  }

  /** Whether a comparison is staged (a confirmed run is possible). */
  get comparisonIsStaged(): boolean {
    return this.comparisonDiff !== null
  }

  /** The pending report-export request, if one is in flight. */
  get pendingReportExport(): { readonly id: string; readonly generation: number } | null {
    return this.reportExportRequest
  }

  /** Wire the controls and reveal the panel (once). */
  mount(): void {
    if (this.mounted) return
    this.mounted = true
    elementOrThrow('comparison-select').addEventListener('click', () => {
      this.selectComparison()
    })
    elementOrThrow('diff-confirm').addEventListener('click', () => {
      this.confirm()
    })
    elementOrThrow('diff-cancel').addEventListener('click', () => {
      this.cancel()
    })
    elementOrThrow('diff-export').addEventListener('click', () => {
      this.exportReport()
    })
    elementOrThrow('diff-controls').hidden = false
  }

  /** Test-harness seam: stage a named fixture on the next select pick. */
  stageFixtureForTest(name: string): void {
    this.nextTestFixture = name
  }

  /** Ask the host for a local comparison dataset (or a replacement). */
  selectComparison(): void {
    if (this.comparisonBusy || this.diffBusy || this.ports.editPending()) {
      this.status().textContent = COMPARISON_REPLACE_REFUSED
      return
    }
    const request = { id: this.ports.createId(), generation: ++this.comparisonGeneration }
    this.comparisonRequest = request
    this.comparisonBusy = true
    const fixture = this.nextTestFixture
    this.nextTestFixture = undefined
    this.status().textContent = COMPARISON_SELECT_PROMPT
    this.ports.post({
      kind: 'comparison-select-request',
      ...request,
      ...(fixture === undefined ? {} : { fixture }),
    })
  }

  /**
   * Stage the comparison file the host just sent. The in-flight latch
   * (`comparisonBusy`) was set by the select click that CAUSED this frame;
   * refusing on it here deadlocked staging forever (the early return skipped
   * the only finally that clears it). Only a pending edit refuses — and it
   * must release the latch.
   */
  stage(data: StagedComparisonFrame): void {
    if (this.ports.editPending()) {
      this.comparisonBusy = false
      this.status().textContent = COMPARISON_STAGE_BUSY_REFUSED
      return
    }
    this.comparisonBusy = true
    const request = { id: data.id, generation: data.generation }
    const file = new File([data.bytes], data.name)
    void (async () => {
      try {
        const source: EngineFileSource = { name: data.name, getFile: () => Promise.resolve(file) }
        const staged = await this.ports.stageComparison(source)
        const handleB = await this.ports.openComparison(source)
        const [schemaA, schemaB, profileA, profileB] = await Promise.all([
          this.ports.schema(this.ports.datasetHandle),
          this.ports.schema(handleB),
          this.ports.profile(this.ports.datasetHandle),
          this.ports.profile(handleB),
        ])
        const current = this.comparisonRequest
        if (current === null || !isCurrentDiffRequest(request, current)) return
        this.comparisonHandle = staged
        this.comparisonSchema = schemaB.map((column) => ({ name: column.name, type: column.type }))
        const a = toDiffProfile(profileA)
        const b = toDiffProfile(profileB)
        this.comparisonProfile = b
        this.comparisonDiff = diffDatasets({ schemaA, schemaB, profileA: a, profileB: b })
        this.comparisonInference = inferRowDiffKeys(a, b)
        this.comparisonDisplayName = data.displayName
        this.renderStaged()
      } catch {
        const current = this.comparisonRequest
        if (current !== null && isCurrentDiffRequest(request, current))
          this.status().textContent = COMPARISON_STAGE_FAILED
      } finally {
        const current = this.comparisonRequest
        if (current !== null && isCurrentDiffRequest(request, current)) this.comparisonBusy = false
      }
    })()
  }

  /** Explicit confirmation: the only path that runs a row diff. */
  confirm(): void {
    if (this.comparisonDiff === null || this.comparisonHandle === null || this.diffBusy) {
      this.status().textContent = describeDiffRefusal('busy')
      return
    }
    if (this.ports.editPending()) {
      this.status().textContent = describeDiffRefusal('busy')
      return
    }
    const selected = [...(elementOrThrow('diff-keys') as HTMLSelectElement).selectedOptions].map(
      (option) => option.value,
    )
    const validation = confirmedDiffKeys(selected, this.comparisonSchema)
    if (!validation.ok) {
      this.status().textContent = describeDiffRefusal({
        kind: 'invalid-keys',
        error: validation.error,
      })
      return
    }
    this.diffConfirmed = true
    this.diffBusy = true
    const generation = ++this.diffGeneration
    const revision = this.ports.currentRevision()
    const compiled = compileConfirmedDiff(
      validation.keys,
      this.ports.effectiveColumns(),
      this.comparisonSchema,
    )
    if (!compiled.ok) {
      this.diffBusy = false
      this.status().textContent = compiled.errors.map(describeDiffCompileFailure).join('; ')
      return
    }
    const overlay = this.ports.overlay()
    this.status().textContent = DIFF_RUNNING_STATUS
    elementOrThrow('diff-confirm').setAttribute('disabled', 'true')
    elementOrThrow('diff-cancel').hidden = false
    const comparison = this.comparisonHandle
    const comparisonDiff = this.comparisonDiff
    const inference = this.comparisonInference
    void this.ports
      .runDiff(comparison, compiled.plan, overlay)
      .then((result) => {
        if (generation !== this.diffGeneration || !this.diffConfirmed) return
        this.report = buildDiffReport({
          comparison: comparisonDiff,
          result,
          keys: validation.keys,
          keySource: this.keySource,
          inference: inference?.candidates[0]
            ? {
                columns: inference.candidates[0].columns,
                candidateDisclosure: inference.candidates[0].disclosure,
                outcomeDisclosure: inference.disclosure,
                evidence: inference.candidates[0].evidence,
              }
            : null,
          sharedColumns: compiled.plan.sharedColumns,
          baseViewOnly: (overlay.ops?.length ?? 0) === 0,
          revision,
        })
        this.renderResult(this.report)
        this.status().textContent = DIFF_COMPLETE_STATUS
      })
      .catch(() => {
        if (generation === this.diffGeneration) this.status().textContent = DIFF_FAILED_STATUS
      })
      .finally(() => {
        if (generation === this.diffGeneration) {
          this.diffBusy = false
          elementOrThrow('diff-confirm').removeAttribute('disabled')
          elementOrThrow('diff-cancel').hidden = true
        }
      })
  }

  /** Cancel any in-flight run; late results are ignored by generation. */
  cancel(): void {
    this.diffGeneration++
    this.diffBusy = false
    this.diffConfirmed = false
    elementOrThrow('diff-confirm').removeAttribute('disabled')
    elementOrThrow('diff-cancel').hidden = true
    this.status().textContent = DIFF_CANCELLED_STATUS
  }

  /** Ask the host to write the report as a NEW local file (create-only). */
  exportReport(): void {
    if (this.report === null) return
    const id = this.ports.createId()
    const generation = this.diffGeneration
    this.reportExportRequest = { id, generation }
    const report = buildReportExportPayload(this.report, this.ports.currentRevision())
    this.ports.post({
      kind: 'report-export-request',
      id,
      generation,
      json: JSON.stringify(report, null, 2),
    })
    this.status().textContent = REPORT_EXPORT_PROMPT
  }

  /** Recompute the stale marker against the current revision. */
  refreshStale(): void {
    elementOrThrow('diff-stale').hidden = !diffStaleVisible(
      this.report,
      this.ports.currentRevision(),
    )
  }

  /**
   * Handle a host frame. Returns `true` when the frame belonged to this panel
   * (so the entry stops routing it).
   */
  handleHostFrame(data: unknown): boolean {
    const frame = data as { kind?: unknown } | null
    if (frame === null || typeof frame !== 'object') return false
    if (frame.kind === 'comparison-stage-request') {
      this.requestAutoStage()
      return true
    }
    if (
      frame.kind === 'comparison-loaded' ||
      frame.kind === 'comparison-cancelled' ||
      frame.kind === 'comparison-error'
    ) {
      return this.handleComparisonFrame(data)
    }
    if (frame.kind === 'report-export-result') {
      return this.handleReportExportFrame(data)
    }
    return false
  }

  /**
   * The compare command stages as soon as the panel is ready, but the
   * open-flow harness exercises may still hold busy states — a click can be
   * accepted (request sent) and the staging still refused later while an
   * edit is pending, with nobody left to re-click. Gate on completion:
   * re-click whenever idle and no comparison is staged yet, until the
   * staging actually lands (or the bounded window closes; the reduced
   * command proof's own wait then surfaces the honest failure).
   *
   * Public because the host may post the request BEFORE the dataset frame is
   * processed (the entry then replays it once the panel is mounted).
   */
  requestAutoStage(): void {
    void (async () => {
      const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline && !this.comparisonIsStaged) {
        if (!this.comparisonBusy && !this.diffBusy) {
          elementOrThrow('comparison-select').dispatchEvent(new Event('click'))
        }
        await sleep(200)
      }
    })()
  }

  /** Invalidate every pending staging/diff/report request (panel close). */
  dispose(): void {
    this.comparisonGeneration++
    this.comparisonRequest = null
    this.diffGeneration++
    this.diffBusy = false
    this.reportExportRequest = null
  }

  /** Cancel + report the pending staging request (dispose path). */
  cancelPendingOnDispose(): void {
    const request = this.comparisonRequest
    if (request !== null) this.ports.post({ kind: 'comparison-cancel', ...request })
    const exportRequest = this.reportExportRequest
    if (exportRequest !== null) this.ports.post({ kind: 'report-export-cancel', ...exportRequest })
  }

  private handleComparisonFrame(data: unknown): boolean {
    const frame = data as {
      kind?: unknown
      id?: unknown
      generation?: unknown
      bytes?: unknown
      name?: unknown
      displayName?: unknown
    }
    if (typeof frame.id !== 'string' || !Number.isSafeInteger(frame.generation)) return false
    const expected = this.comparisonRequest
    if (expected === null || frame.id !== expected.id || frame.generation !== expected.generation)
      return true
    if (
      frame.kind === 'comparison-loaded' &&
      frame.bytes instanceof ArrayBuffer &&
      typeof frame.name === 'string' &&
      typeof frame.displayName === 'string'
    ) {
      this.stage({
        id: frame.id,
        generation: frame.generation,
        name: frame.name,
        displayName: frame.displayName,
        bytes: frame.bytes,
      })
      return true
    }
    this.comparisonBusy = false
    this.status().textContent = describeComparisonFrameFailure(
      frame.kind === 'comparison-cancelled' ? 'cancelled' : 'error',
    )
    return true
  }

  private handleReportExportFrame(data: unknown): boolean {
    const frame = data as { id?: unknown; generation?: unknown; status?: unknown }
    const expected = this.reportExportRequest
    if (expected === null || frame.id !== expected.id || frame.generation !== expected.generation) {
      return false
    }
    this.reportExportRequest = null
    this.status().textContent = describeReportExportStatus(
      typeof frame.status === 'string' ? frame.status : undefined,
    )
    return true
  }

  private renderStaged(): void {
    const disclosure = elementOrThrow('diff-disclosure')
    const candidates = elementOrThrow('diff-candidates')
    const select = elementOrThrow('diff-keys') as HTMLSelectElement
    disclosure.replaceChildren()
    candidates.replaceChildren()
    select.replaceChildren()
    elementOrThrow('diff-results').replaceChildren()
    this.report = null
    this.diffConfirmed = false
    elementOrThrow('diff-export').setAttribute('disabled', 'true')
    elementOrThrow('diff-stale').hidden = true
    if (this.comparisonDiff === null || this.comparisonInference === null) return
    const { meta, findings } = describeStagedComparison({
      displayName: this.comparisonDisplayName,
      columnCount: this.comparisonSchema.length,
      rowCount: this.comparisonProfile?.rowCount ?? 0,
      schemaDriftCount: this.comparisonDiff.schemaDrift.length,
      columnDeltaCount: this.comparisonDiff.columnDeltas.length,
      issueCount: this.comparisonDiff.issues.length,
    })
    const metaNode = document.createElement('p')
    metaNode.textContent = meta
    disclosure.appendChild(metaNode)
    const findingsNode = document.createElement('p')
    findingsNode.textContent = findings
    disclosure.appendChild(findingsNode)
    for (const [title, entries] of [
      ['Schema drift', this.comparisonDiff.schemaDrift],
      ['Column distribution deltas', this.comparisonDiff.columnDeltas],
      ['Profile issues', this.comparisonDiff.issues],
    ] as const) {
      const heading = document.createElement('h3')
      heading.textContent = title
      disclosure.appendChild(heading)
      for (const entry of entries) {
        const item = document.createElement('p')
        item.textContent = JSON.stringify(entry)
        disclosure.appendChild(item)
      }
    }
    const inferenceOutcome = document.createElement('p')
    inferenceOutcome.textContent = this.comparisonInference.disclosure
    disclosure.appendChild(inferenceOutcome)
    const intro = document.createElement('p')
    intro.textContent = STAGED_INTRO
    disclosure.appendChild(intro)
    for (const option of describeKeyOptions(this.comparisonSchema)) {
      const node = document.createElement('option')
      node.value = option.value
      node.textContent = option.label
      select.appendChild(node)
    }
    this.comparisonInference.candidates.forEach((candidate, index) => {
      const description = describeKeyCandidate(candidate)
      const section = document.createElement('section')
      const text = document.createElement('p')
      text.textContent = description.text
      section.appendChild(text)
      const choose = document.createElement('button')
      choose.type = 'button'
      choose.textContent = `Select candidate ${String(index + 1)}`
      choose.addEventListener('click', () => {
        const names = new Set(description.columns)
        for (const option of [...select.options]) option.selected = names.has(option.value)
        this.keySource = 'inferred'
        this.diffConfirmed = false
        this.status().textContent = PROPOSAL_ONLY_STATUS
      })
      section.appendChild(choose)
      candidates.appendChild(section)
    })
    this.status().textContent = STAGED_READY_STATUS
    elementOrThrow('diff-confirm').removeAttribute('disabled')
  }

  private renderResult(report: DiffReportView): void {
    const root = elementOrThrow('diff-results')
    root.replaceChildren()
    const verdict = document.createElement('h3')
    verdict.textContent = describeDiffVerdict(report)
    root.appendChild(verdict)
    const metadata = document.createElement('p')
    metadata.textContent = describeDiffMetadata(report)
    root.appendChild(metadata)
    for (const group of [
      { name: 'Schema drift', entries: report.drift },
      { name: 'Column deltas', entries: report.divergentDeltas },
    ]) {
      const title = document.createElement('h4')
      title.textContent = describeDiffGroupHeading(group.name, group.entries.length)
      root.appendChild(title)
      for (const entry of group.entries) {
        const line = document.createElement('p')
        line.textContent = JSON.stringify(entry)
        root.appendChild(line)
      }
    }
    for (const aspect of report.aspects) {
      const title = document.createElement('h4')
      title.textContent = describeDiffAspectHeading(aspect)
      root.appendChild(title)
      for (const sample of aspect.samples) {
        const description = describeDiffSample(sample)
        const line = document.createElement('p')
        line.textContent = description.text
        root.appendChild(line)
        if (selectDiffSampleNavigation(sample).kind === 'navigate') {
          const jump = document.createElement('button')
          jump.type = 'button'
          jump.textContent = description.jumpLabel
          jump.addEventListener('click', () => {
            void this.navigate(sample.rowKey)
          })
          root.appendChild(jump)
        }
      }
    }
    const issues = document.createElement('p')
    issues.textContent = describeDiffIssues(report)
    root.appendChild(issues)
    this.refreshStale()
    elementOrThrow('diff-export').removeAttribute('disabled')
  }

  private async navigate(rowKey: string): Promise<void> {
    try {
      const found = await this.ports.navigateToRow(rowKey)
      if (!found) this.status().textContent = DIFF_SAMPLE_NOT_IN_VIEW
    } catch {
      this.status().textContent = DIFF_NAVIGATION_FAILED
    }
  }

  private status(): HTMLElement {
    return elementOrThrow('diff-status')
  }
}
