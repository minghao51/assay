// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Production dataset-viewer webview (ptv1-3 bridge + ptv1-4 grid surface).
 * Receives dataset BYTES from the extension host (read via `workspace.fs` —
 * no file paths cross into the webview: the bridge posts a FORMAT-DERIVED
 * NEUTRAL name, not the user's file name, and typed errors surface as kind +
 * path-free text), boots the vendored engine ONCE per panel through the
 * ptv1-1 seam + ptv1-2 vendored assets (`webview/engine-session.ts` — the
 * panel owns the engine; the grid fetches windows through it for the whole
 * panel's life), opens the dataset through the real `@assay/engine-duckdb`
 * client, and renders the headless-grid surface: the virtualized
 * `GridViewportModel` renderer (`webview/data-grid.ts`) with header sort and
 * filter-lite per the grid contracts. The page audits its own DOM structure
 * (`webview/grid-audit.ts` — the host cannot reach into a webview) and
 * reports the result + the open→first-row time with the value-free counts.
 *
 * Typed host errors are rendered as text; every DOM update is
 * `textContent`/`hidden`/`setAttribute` (no `innerHTML` anywhere,
 * engineering/04 §6); dataset values are untrusted content rendered as text
 * only. No telemetry exists in this extension and none may be added
 * (ADR 0025/0037).
 */
import { GridViewportModel } from '@assay/grid'
import { diffDatasets, inferRowDiffKeys } from '@assay/diff'
import type { DatasetProfile, DiffReport, KeyInferenceResult } from '@assay/diff'
import type { EngineComparisonHandle, EngineDatasetProfile } from '@assay/engine-duckdb'
import type { GridDataProvider } from '@assay/grid'
import { emptyHistory, isLiveRow, overlayEdit, stateAtCursor } from '@assay/domain'
import type { OverlayBase, RowId } from '@assay/domain'
import type { WorkerDiagnostic } from './engine-boot'
import { EditController } from '../src/pure/edit-controller'
import {
  buildDiffReport,
  compileConfirmedDiff,
  describeDiffCompileFailure,
  isCurrentDiffRequest,
  isDiffStale,
  projectDiffReport,
  selectDiffSampleNavigation,
  validateConfirmedKeys,
} from '../src/pure/diff-controller'
import type { DiffReportView, DiffColumn } from '../src/pure/diff-controller'
import { overlaySnapshot } from '../src/pure/overlay-snapshot'
import {
  acceptsValidationFrame,
  isCurrentValidationGeneration,
  isValidationStale,
  parseAndCompileContract,
  projectValidation,
  VALIDATION_SAMPLE_LIMIT,
} from '../src/pure/validation-controller'
import type { ValidationProjection } from '../src/pure/validation-controller'
import type {
  ExportHostRequest,
  ExportHostResponse,
  SafeExportFormat,
} from '../src/pure/export-transfer'
import { supportsCellDraft } from '../src/pure/cell-input'
import { EngineSession } from './engine-session'
import { EngineGridProvider } from './grid-provider'
import { WebviewDataGrid } from './data-grid'
import { auditGridDom } from './grid-audit'

/** Mirror of the host-side config in `src/dataset.ts` (buildDatasetConfig). */
interface DatasetWebviewConfig {
  readonly target: 'desktop-webview'
  readonly vscodeVersion: string
  /** Host-injected module script URL (consumed by the HTML, not this script). */
  readonly mainScriptUrl: string
  readonly workerEntryUrl: string
  readonly mvpGlueUrl: string
  readonly mvpWasmUrl: string
  readonly vendoredExtensions: readonly {
    readonly url: string
    readonly autoloadPath: string
  }[]
  readonly duckdbVersion: string
  readonly blockedExtensionHost: string
  readonly testHarness: boolean
}

declare global {
  interface Window {
    __ASSAY_DATASET_CONFIG__: DatasetWebviewConfig
  }
}

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void
}

function postExportMessage(message: ExportHostRequest): void {
  vscodeApi.postMessage(message)
}

const config = window.__ASSAY_DATASET_CONFIG__
const vscodeApi = acquireVsCodeApi()

/** One engine per panel (see `EngineSession` — boot once, dispose on close). */
const engineSession = new EngineSession()
const diagnostics: Array<WorkerDiagnostic> = []
let activeController: EditController | null = null
let activeGrid: WebviewDataGrid | null = null
let activeOpenStage = 'engine-start'
let exportGeneration = 0
let exportActive = false
let activeExportId: string | undefined
let exportCancelled = false
let validationGeneration = 0
let validationRequest: { readonly id: string; readonly generation: number } | null = null
let contractText: string | null = null
let validationReport: ValidationProjection | null = null
let validationBusy = false
let comparisonGeneration = 0
let comparisonRequest: { readonly id: string; readonly generation: number } | null = null
let comparisonHandle: EngineComparisonHandle | null = null
let comparisonSchema: DiffColumn[] = []
let comparisonDiff: DiffReport | null = null
let comparisonInference: KeyInferenceResult | null = null
let comparisonProfile: DatasetProfile | null = null
let comparisonDisplayName = ''
let comparisonBusy = false
let diffGeneration = 0
let diffBusy = false
// Test-harness only: names the comparison fixture the NEXT select pick
// stages (validated host-side); production never sets it.
let testComparisonFixture: string | undefined
// The latest projected git context (value-free) received from the host.
let gitContextView: { readonly state: string; readonly hasBranch: boolean } | undefined
let diffConfirmed = false
let diffReport: DiffReportView | null = null
let diffKeySource: 'explicit' | 'inferred' = 'explicit'
let reportExportRequest: { readonly id: string; readonly generation: number } | null = null
let stageComparisonHandler:
  | ((data: {
      id: string
      generation: number
      name: string
      displayName: string
      bytes: ArrayBuffer
    }) => void)
  | null = null
const exportWaiters = new Map<string, (message: ExportHostResponse) => void>()

function waitExport(id: string, kind: string): Promise<ExportHostResponse> {
  return new Promise((resolve, reject) => {
    const key = `${id}:${kind}`
    const timeout = window.setTimeout(() => {
      exportWaiters.delete(key)
      reject(new Error('export-timeout'))
    }, 120_000)
    exportWaiters.set(key, (message) => {
      window.clearTimeout(timeout)
      exportWaiters.delete(key)
      if (kind === 'export-error' || kind === 'export-cancelled') reject(new Error(kind))
      else resolve(message)
    })
  })
}

async function startExport(
  format: string,
  client: import('@assay/engine-duckdb').DuckDbEngineClient,
  handle: import('@assay/engine-duckdb').EngineTableHandle,
  base: OverlayBase,
  controller: EditController,
): Promise<void> {
  if (exportActive || !['parquet', 'jsonl', 'json', 'csv', 'arrow'].includes(format)) return
  exportActive = true
  const status = elementOrThrow('export-status')
  const id = crypto.randomUUID()
  activeExportId = id
  exportCancelled = false
  const generation = ++exportGeneration
  let scratchPath: string | undefined
  try {
    status.textContent = 'Choose a new local file for export.'
    const ready = waitExport(id, 'export-ready')
    postExportMessage({
      kind: 'export-request',
      id,
      generation,
      format: format as SafeExportFormat,
    })
    await ready
    if (exportCancelled) throw new Error('export-cancelled')
    if (controller.snapshot.busy) throw new Error('edit-pending')
    const revision = controller.snapshot.revision
    status.textContent =
      'Exporting the accepted overlay snapshot (natural row order; ignores viewport, sort, and filters)…'
    const snapshot = overlaySnapshot(base, controller.currentHistory)
    const result = await client.exportView(handle, {
      format: format as 'parquet' | 'jsonl' | 'json' | 'csv' | 'arrow',
      overlay: snapshot,
    })
    if (exportCancelled) throw new Error('export-cancelled')
    if (controller.snapshot.revision !== revision) throw new Error('snapshot-changed')
    if (
      !Number.isSafeInteger(result.bytes) ||
      result.bytes < 0 ||
      result.bytes > 512 * 1024 * 1024 ||
      !Number.isSafeInteger(result.rowCount) ||
      result.rowCount < 0
    )
      throw new Error('invalid-export')
    scratchPath = result.path
    const parts = result.path.split('/').filter(Boolean)
    if (parts.length === 0 || parts.some((part) => part === '.' || part === '..'))
      throw new Error('invalid-export')
    let directory = await navigator.storage.getDirectory()
    for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part)
    const scratch = await directory.getFileHandle(parts[parts.length - 1]!)
    const file = await scratch.getFile()
    if (file.size !== result.bytes) throw new Error('invalid-export')
    if (config.testHarness && file.size <= 1024 * 1024 && result.rowCount <= 100) {
      const reopened = await client.open({
        name: `assay-export.${format}`,
        getFile: () => Promise.resolve(file),
      })
      const expectedCount = await client.overlayRowCount(handle, snapshot)
      const actualCount = await client.rowCount(reopened)
      const expectedSchema = await client.overlaySchema(handle, snapshot)
      const actualSchema = await client.schema(reopened)
      if (
        actualCount !== expectedCount ||
        actualSchema.length !== expectedSchema.length ||
        actualSchema.some(
          (column, index) =>
            column.name !== expectedSchema[index]?.name ||
            column.type !== expectedSchema[index]?.type,
        )
      )
        throw new Error('export-reopen-mismatch')
      const expected = (
        await client.fetchOverlayRange(handle, snapshot, { startRow: 0, endRow: expectedCount })
      ).batch
      const actual = (await client.fetchRange(reopened, { startRow: 0, endRow: actualCount })).batch
      const stringify = (value: unknown): string =>
        JSON.stringify(value, (_key, cell: unknown) =>
          typeof cell === 'bigint' ? cell.toString() : cell,
        )
      if (stringify(expected.toArray()) !== stringify(actual.toArray()))
        throw new Error('export-reopen-mismatch')
    }
    postExportMessage({ kind: 'export-start', id, generation, totalBytes: file.size })
    await waitExport(id, 'export-credit')
    let sequence = 0
    for (let offset = 0; offset < file.size; offset += 64 * 1024) {
      const chunk = new Uint8Array(
        await file.slice(offset, Math.min(file.size, offset + 64 * 1024)).arrayBuffer(),
      )
      postExportMessage({
        kind: 'export-chunk',
        id,
        generation,
        sequence: sequence++,
        offset,
        totalBytes: file.size,
        bytes: Array.from(chunk),
      })
      await waitExport(id, 'export-credit')
      if (offset === 0 || offset % (1024 * 1024) === 0 || offset + chunk.byteLength === file.size) {
        status.textContent = `Exporting: ${Math.min(offset + chunk.byteLength, file.size)} of ${file.size} bytes delivered.`
      }
    }
    postExportMessage({ kind: 'export-finish', id, generation })
    await waitExport(id, 'export-complete')
    status.textContent = `Export complete: ${result.rowCount} rows, ${result.bytes} bytes. A new local file was created and closed.`
  } catch {
    postExportMessage({ kind: 'export-cancel', id, generation })
    status.textContent = 'Export cancelled or failed. No success was reported.'
  } finally {
    exportActive = false
    activeExportId = undefined
    exportWaiters.delete(`${id}:export-ready`)
    exportWaiters.delete(`${id}:export-credit`)
    exportWaiters.delete(`${id}:export-complete`)
    if (scratchPath !== undefined) {
      try {
        const parts = scratchPath.split('/').filter(Boolean)
        let directory = await navigator.storage.getDirectory()
        for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part)
        await directory.removeEntry(parts[parts.length - 1]!)
      } catch {
        /* terminal cleanup is best effort; engine session owns OPFS cleanup too */
      }
    }
  }
}

function elementOrThrow(id: string): HTMLElement {
  const el = document.getElementById(id)
  if (el === null) {
    throw new Error(`dataset webview DOM is missing #${id}`)
  }
  return el
}

function setStatus(message: string): void {
  const status = elementOrThrow('status')
  status.textContent = message
  status.setAttribute('role', message === 'error' ? 'alert' : 'status')
}

/** Render a typed error state (kind + path-free text) and acknowledge it. */
function renderError(kind: string, message: string): void {
  setStatus('error')
  const errorEl = elementOrThrow('error')
  errorEl.textContent = `${kind}: ${message}`
  errorEl.hidden = false
}

function renderReport(rows: number, columns: number): void {
  setStatus('opened')
  const report = elementOrThrow('report')
  elementOrThrow('report-rows').textContent = String(rows)
  elementOrThrow('report-columns').textContent = String(columns)
  report.hidden = false
}

/**
 * Open the posted bytes through the real adapter and mount the grid. The
 * bridge's `name` is the host's format-derived neutral name (never the
 * user's file name — it exists only so the engine's format detection and
 * error text see a stable, path-free token).
 */
async function openDataset(name: string, bytes: ArrayBuffer): Promise<void> {
  activeOpenStage = 'engine-start'
  setStatus('booting engine…')
  const boot = await engineSession.acquire(
    {
      workerEntryUrl: config.workerEntryUrl,
      mvpGlueUrl: config.mvpGlueUrl,
      mvpWasmUrl: config.mvpWasmUrl,
      vendoredExtensions: config.vendoredExtensions,
      blockedHost: config.blockedExtensionHost,
    },
    diagnostics,
  )
  activeOpenStage = 'engine-open'
  setStatus('opening dataset…')
  const started = performance.now()
  const file = new File([bytes], name)
  const handle = await boot.client.open({ name, getFile: () => Promise.resolve(file) })

  // The headless grid owns fetching/caching/query state from here on; this
  // page only projects it (ADR 0022).
  const baseSchema = await boot.client.schema(handle)
  const base: OverlayBase = {
    baseAnchor: handle.id,
    overlayAnchor: crypto.randomUUID(),
    columns: baseSchema.map((column) => ({ name: column.name, type: column.type })),
    baseRowCount: await boot.client.rowCount(handle),
  }
  activeOpenStage = 'effective-view-load'
  const provider = new EngineGridProvider(
    boot.client,
    handle,
    overlaySnapshot(base, emptyHistory()),
  )
  const model = new GridViewportModel(provider)
  await model.load()
  const rows = model.totalRows ?? -1
  const columns = model.schema?.length ?? -1
  renderReport(rows, columns)

  let grid: WebviewDataGrid | null = null
  const controller = new EditController(
    base,
    {
      preflight: async (history) => provider.preflight(overlaySnapshot(base, history)),
      activate: async (history) => {
        provider.setOverlay(overlaySnapshot(base, history))
        await model.refresh()
      },
    },
    (snapshot) => {
      const status = document.getElementById('edit-status')
      if (status !== null) {
        status.setAttribute('role', snapshot.error === null ? 'status' : 'alert')
        status.textContent =
          snapshot.error ??
          (snapshot.busy ? 'Checking edit…' : snapshot.revision > 0 ? 'Edit applied.' : '')
      }
      grid?.refreshEditingState()
      setValidationStale()
      elementOrThrow('diff-stale').hidden = !isDiffStale(diffReport, snapshot.revision)
    },
  )
  activeController = controller
  const validationStatus = elementOrThrow('validation-status')
  const validationResults = elementOrThrow('validation-results')
  const setValidationStale = (): void => {
    elementOrThrow('validation-stale').hidden = !isValidationStale(
      validationReport,
      controller.snapshot.revision,
    )
  }
  const renderValidation = (report: ValidationProjection): void => {
    validationResults.replaceChildren()
    const summary = document.createElement('p')
    summary.textContent = `${report.valid ? 'VALID' : 'INVALID'} — ${report.rowCount} effective rows.`
    validationResults.appendChild(summary)
    for (const rule of report.rules) {
      const section = document.createElement('section')
      const heading = document.createElement('p')
      heading.textContent = `${rule.ruleId}: ${rule.failCount} failures (${rule.failPercent}%).`
      section.appendChild(heading)
      for (const sample of rule.samples) {
        const button = document.createElement('button')
        button.type = 'button'
        button.textContent = `Go to row ${sample.rowKey} — ${String(sample.value)}`
        button.addEventListener('click', () => {
          void (async () => {
            const total = await provider.rowCount()
            for (let start = 0; start < total; start += 128) {
              const page = await provider.fetchRange({
                startRow: start,
                endRow: Math.min(total, start + 128),
                startCol: 0,
                endCol: (await provider.schema()).length,
              })
              const offset = (page.rowKeys ?? []).indexOf(sample.rowKey)
              if (offset >= 0) {
                grid?.scrollToRow(start + offset)
                grid?.focusGrid()
                return
              }
            }
            validationStatus.textContent =
              'That logical row is not in the current grid view. Clear filters or re-validate.'
          })().catch(() => {
            validationStatus.textContent = 'Could not navigate to that logical row.'
          })
        })
        section.appendChild(button)
      }
      validationResults.appendChild(section)
    }
    setValidationStale()
  }
  const validateEffectiveView = async (): Promise<void> => {
    if (validationBusy || contractText === null || controller.snapshot.busy) return
    validationBusy = true
    const generation = ++validationGeneration
    const revision = controller.snapshot.revision
    const status = elementOrThrow('validation-status')
    status.textContent = 'Compiling contract and validating the effective view…'
    elementOrThrow('validate-button').setAttribute('disabled', 'true')
    elementOrThrow('validate-cancel').hidden = false
    try {
      const effective = stateAtCursor(base, controller.currentHistory)
      const compiled = parseAndCompileContract(contractText, effective.columns)
      if (compiled.kind !== 'compiled') {
        status.textContent =
          compiled.kind === 'empty'
            ? 'Contract is empty.'
            : compiled.kind === 'parse-error'
              ? 'Contract could not be parsed.'
              : compiled.kind === 'compile-error'
                ? 'Contract does not bind to the effective schema.'
                : 'Contract exceeds the size limit.'
        return
      }
      const overlay = overlaySnapshot(base, controller.currentHistory)
      const result = await boot.client.validate(handle, compiled.plan, overlay)
      if (!isCurrentValidationGeneration(generation, validationGeneration)) return
      validationReport = projectValidation(result, revision, VALIDATION_SAMPLE_LIMIT)
      renderValidation(validationReport)
      status.textContent = 'Validation complete.'
    } catch {
      if (isCurrentValidationGeneration(generation, validationGeneration))
        status.textContent = 'Validation failed. The previous report, if any, is unchanged.'
    } finally {
      if (isCurrentValidationGeneration(generation, validationGeneration)) {
        validationBusy = false
        elementOrThrow('validate-button').removeAttribute('disabled')
        elementOrThrow('validate-cancel').hidden = true
      }
    }
  }
  const requestContract = (): void => {
    if (validationRequest !== null) return
    const request = { id: crypto.randomUUID(), generation: ++validationGeneration }
    validationRequest = request
    vscodeApi.postMessage({ kind: 'validate-request', ...request })
    validationStatus.textContent = 'Select a local contract file…'
  }
  elementOrThrow('contract-select').addEventListener('click', requestContract)
  elementOrThrow('validate-button').addEventListener('click', () => {
    void validateEffectiveView()
  })
  elementOrThrow('validate-cancel').addEventListener('click', () => {
    validationGeneration++
    validationBusy = false
    elementOrThrow('validate-button').removeAttribute('disabled')
    elementOrThrow('validate-cancel').hidden = true
    validationStatus.textContent = 'Validation cancelled; any late result will be ignored.'
  })
  elementOrThrow('validation-controls').hidden = false
  elementOrThrow('diff-controls').hidden = false
  const toDiffProfile = (profile: EngineDatasetProfile): DatasetProfile => ({
    rowCount: profile.rowCount,
    columns: profile.columns.map((column) => ({ ...column })),
  })
  const renderDiffStaged = (): void => {
    const disclosure = elementOrThrow('diff-disclosure')
    const candidates = elementOrThrow('diff-candidates')
    const select = elementOrThrow('diff-keys') as HTMLSelectElement
    disclosure.replaceChildren()
    candidates.replaceChildren()
    select.replaceChildren()
    elementOrThrow('diff-results').replaceChildren()
    diffReport = null
    diffConfirmed = false
    elementOrThrow('diff-export').setAttribute('disabled', 'true')
    elementOrThrow('diff-stale').hidden = true
    if (comparisonDiff === null || comparisonInference === null) return
    const meta = document.createElement('p')
    meta.textContent = `Comparison staged: ${comparisonDisplayName} (${comparisonSchema.length} columns; ${comparisonProfile?.rowCount ?? 0} rows).`
    disclosure.appendChild(meta)
    const schema = document.createElement('p')
    schema.textContent = `Schema/profile findings: ${comparisonDiff.schemaDrift.length} schema drift findings; ${comparisonDiff.columnDeltas.length} column distribution deltas; ${comparisonDiff.issues.length} issues. Row-level comparison has not run.`
    disclosure.appendChild(schema)
    for (const [title, entries] of [
      ['Schema drift', comparisonDiff.schemaDrift],
      ['Column distribution deltas', comparisonDiff.columnDeltas],
      ['Profile issues', comparisonDiff.issues],
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
    inferenceOutcome.textContent = comparisonInference.disclosure
    disclosure.appendChild(inferenceOutcome)
    const intro = document.createElement('p')
    intro.textContent =
      'Inferred keys are proposals only. Select a candidate or choose columns, then explicitly confirm; no row diff runs before confirmation.'
    disclosure.appendChild(intro)
    for (const column of comparisonSchema) {
      const option = document.createElement('option')
      option.value = column.name
      option.textContent = `${column.name} (${column.type})`
      select.appendChild(option)
    }
    comparisonInference.candidates.forEach((candidate, index) => {
      const section = document.createElement('section')
      const text = document.createElement('p')
      text.textContent = `${candidate.disclosure} — key columns ${JSON.stringify(candidate.columns)}; evidence: ${JSON.stringify(candidate.evidence)}`
      section.appendChild(text)
      const choose = document.createElement('button')
      choose.type = 'button'
      choose.textContent = `Select candidate ${String(index + 1)}`
      choose.addEventListener('click', () => {
        const names = new Set(candidate.columns)
        for (const option of [...select.options]) option.selected = names.has(option.value)
        diffKeySource = 'inferred'
        diffConfirmed = false
        elementOrThrow('diff-status').textContent =
          'Candidate selected as a proposal. Confirm explicitly to run.'
      })
      section.appendChild(choose)
      candidates.appendChild(section)
    })
    elementOrThrow('diff-status').textContent = 'Comparison ready. Choose keys and confirm to run.'
    elementOrThrow('diff-confirm').removeAttribute('disabled')
  }
  const renderDiffResult = (report: DiffReportView): void => {
    const root = elementOrThrow('diff-results')
    root.replaceChildren()
    const verdict = document.createElement('h3')
    verdict.textContent = report.identical
      ? 'IDENTICAL across schema, profile, and row diff'
      : 'DIFFERENCES found'
    root.appendChild(verdict)
    const metadata = document.createElement('p')
    metadata.textContent = `Keys: ${JSON.stringify(report.keys)} (${report.keySource}); effective rows A ${report.rowCountA}, B ${report.rowCountB}; base view only: ${String(report.baseViewOnly)}.`
    root.appendChild(metadata)
    const sections: Array<{ name: string; entries: readonly unknown[] }> = [
      { name: 'Schema drift', entries: report.drift },
      { name: 'Column deltas', entries: report.divergentDeltas },
    ]
    for (const group of sections) {
      const title = document.createElement('h4')
      title.textContent = `${group.name} (${group.entries.length})`
      root.appendChild(title)
      for (const entry of group.entries) {
        const line = document.createElement('p')
        line.textContent = JSON.stringify(entry)
        root.appendChild(line)
      }
    }
    for (const aspect of report.aspects) {
      const title = document.createElement('h4')
      title.textContent = `${aspect.aspect}: ${aspect.count} exact rows; ${aspect.samplesReturned} samples returned${aspect.samplesComplete ? ' (complete)' : ' (truncated)'}`
      root.appendChild(title)
      for (const sample of aspect.samples) {
        const line = document.createElement('p')
        line.textContent = `${sample.side} ${sample.displayKey}${sample.changedColumns ? ` — changed columns ${JSON.stringify(sample.changedColumns)}` : ''}`
        root.appendChild(line)
        if (selectDiffSampleNavigation(sample).kind === 'navigate') {
          const jump = document.createElement('button')
          jump.type = 'button'
          jump.textContent = `Go to A row ${sample.displayKey}`
          jump.addEventListener('click', () => {
            void (async () => {
              const total = await provider.rowCount()
              for (let start = 0; start < total; start += 128) {
                const page = await provider.fetchRange({
                  startRow: start,
                  endRow: Math.min(total, start + 128),
                  startCol: 0,
                  endCol: (await provider.schema()).length,
                })
                const offset = (page.rowKeys ?? []).indexOf(sample.rowKey)
                if (offset >= 0) {
                  grid?.scrollToRow(start + offset)
                  grid?.focusGrid()
                  return
                }
              }
              elementOrThrow('diff-status').textContent =
                'That A-side logical row is not in the current grid view. Clear filters or re-run the diff.'
            })().catch(() => {
              elementOrThrow('diff-status').textContent =
                'Could not navigate to that A-side logical row.'
            })
          })
          root.appendChild(jump)
        }
      }
    }
    const issues = document.createElement('p')
    issues.textContent = `Issues: ${report.issues.length}${report.issues.length ? ` — ${JSON.stringify(report.issues)}` : ''}`
    root.appendChild(issues)
    elementOrThrow('diff-stale').hidden = !isDiffStale(report, controller.snapshot.revision)
    elementOrThrow('diff-export').removeAttribute('disabled')
  }
  stageComparisonHandler = (data: {
    id: string
    generation: number
    name: string
    displayName: string
    bytes: ArrayBuffer
  }): void => {
    // The in-flight latch (comparisonBusy) was set by the select click that
    // CAUSED this frame; refusing on it here deadlocked staging forever
    // (the early return skipped the only finally that clears it). Only a
    // pending edit refuses — and it must release the latch.
    if (controller.snapshot.busy) {
      comparisonBusy = false
      elementOrThrow('diff-status').textContent = 'Cannot stage while an edit is pending.'
      return
    }
    comparisonBusy = true
    const generation = data.generation
    const request = { id: data.id, generation }
    const file = new File([data.bytes], data.name)
    void (async () => {
      try {
        const source = { name: data.name, getFile: () => Promise.resolve(file) }
        const staged = await boot.client.stageComparison(source)
        const handleB = await boot.client.open(source)
        const [schemaA, schemaB, profileA, profileB] = await Promise.all([
          boot.client.schema(handle),
          boot.client.schema(handleB),
          boot.client.profile(handle),
          boot.client.profile(handleB),
        ])
        if (comparisonRequest === null || !isCurrentDiffRequest(request, comparisonRequest)) return
        comparisonHandle = staged
        comparisonSchema = schemaB.map((column) => ({ name: column.name, type: column.type }))
        const a = toDiffProfile(profileA)
        const b = toDiffProfile(profileB)
        comparisonProfile = b
        comparisonDiff = diffDatasets({ schemaA, schemaB, profileA: a, profileB: b })
        comparisonInference = inferRowDiffKeys(a, b)
        comparisonDisplayName = data.displayName
        renderDiffStaged()
      } catch {
        if (comparisonRequest !== null && isCurrentDiffRequest(request, comparisonRequest))
          elementOrThrow('diff-status').textContent = 'Comparison could not be staged or profiled.'
      } finally {
        if (comparisonRequest !== null && isCurrentDiffRequest(request, comparisonRequest))
          comparisonBusy = false
      }
    })()
  }
  elementOrThrow('comparison-select').addEventListener('click', () => {
    if (comparisonBusy || diffBusy || controller.snapshot.busy) {
      elementOrThrow('diff-status').textContent =
        'Comparison cannot be replaced while an operation is pending.'
      return
    }
    const request = { id: crypto.randomUUID(), generation: ++comparisonGeneration }
    comparisonRequest = request
    comparisonBusy = true
    const fixture = testComparisonFixture
    testComparisonFixture = undefined
    elementOrThrow('diff-status').textContent = 'Select a local comparison dataset…'
    vscodeApi.postMessage({
      kind: 'comparison-select-request',
      ...request,
      ...(fixture === undefined ? {} : { fixture }),
    })
  })
  elementOrThrow('diff-confirm').addEventListener('click', () => {
    if (
      comparisonDiff === null ||
      comparisonHandle === null ||
      diffBusy ||
      controller.snapshot.busy
    ) {
      elementOrThrow('diff-status').textContent = 'Diff refused: busy or comparison unavailable.'
      return
    }
    const keys = [...(elementOrThrow('diff-keys') as HTMLSelectElement).selectedOptions].map(
      (option) => option.value,
    )
    const validation = validateConfirmedKeys(keys, comparisonSchema)
    if (!validation.ok) {
      elementOrThrow('diff-status').textContent =
        `Diff refused: invalid keys (${validation.error}).`
      return
    }
    diffConfirmed = true
    diffBusy = true
    const generation = ++diffGeneration
    const revision = controller.snapshot.revision
    const effective = stateAtCursor(base, controller.currentHistory)
    const compiled = compileConfirmedDiff(validation.keys, effective.columns, comparisonSchema)
    if (!compiled.ok) {
      diffBusy = false
      elementOrThrow('diff-status').textContent = compiled.errors
        .map(describeDiffCompileFailure)
        .join('; ')
      return
    }
    const overlay = overlaySnapshot(base, controller.currentHistory)
    elementOrThrow('diff-status').textContent = 'Running confirmed row diff…'
    elementOrThrow('diff-confirm').setAttribute('disabled', 'true')
    elementOrThrow('diff-cancel').hidden = false
    const comparison = comparisonHandle
    const rowRevision = revision
    void boot.client
      .diff(handle, comparison, compiled.plan, overlay)
      .then((result) => {
        if (generation !== diffGeneration || !diffConfirmed) return
        diffReport = buildDiffReport({
          comparison: comparisonDiff!,
          result,
          keys: validation.keys,
          keySource: diffKeySource,
          inference: comparisonInference?.candidates[0]
            ? {
                columns: comparisonInference.candidates[0].columns,
                candidateDisclosure: comparisonInference.candidates[0].disclosure,
                outcomeDisclosure: comparisonInference.disclosure,
                evidence: comparisonInference.candidates[0].evidence,
              }
            : null,
          sharedColumns: compiled.plan.sharedColumns,
          baseViewOnly: (overlay.ops?.length ?? 0) === 0,
          revision: rowRevision,
        })
        renderDiffResult(diffReport)
        elementOrThrow('diff-status').textContent = 'Diff complete.'
      })
      .catch(() => {
        if (generation === diffGeneration)
          elementOrThrow('diff-status').textContent =
            'Diff failed. The previous report, if any, is unchanged.'
      })
      .finally(() => {
        if (generation === diffGeneration) {
          diffBusy = false
          elementOrThrow('diff-confirm').removeAttribute('disabled')
          elementOrThrow('diff-cancel').hidden = true
        }
      })
  })
  elementOrThrow('diff-cancel').addEventListener('click', () => {
    diffGeneration++
    diffBusy = false
    diffConfirmed = false
    elementOrThrow('diff-confirm').removeAttribute('disabled')
    elementOrThrow('diff-cancel').hidden = true
    elementOrThrow('diff-status').textContent = 'Diff cancelled; any late result will be ignored.'
  })
  elementOrThrow('diff-export').addEventListener('click', () => {
    if (diffReport === null) return
    const id = crypto.randomUUID()
    const generation = diffGeneration
    reportExportRequest = { id, generation }
    const report = {
      ...projectDiffReport(diffReport),
      stale: isDiffStale(diffReport, controller.snapshot.revision),
    }
    vscodeApi.postMessage({
      kind: 'report-export-request',
      id,
      generation,
      json: JSON.stringify(report, null, 2),
    })
    elementOrThrow('diff-status').textContent = 'Choose a new local file for the JSON report…'
  })
  grid = new WebviewDataGrid(model, {
    ariaLabel: 'Assay dataset grid',
    editing: {
      state: () => ({
        busy: controller.snapshot.busy,
        dirty: controller.snapshot.history.cursor > 0,
        canUndo: controller.snapshot.history.cursor > 0,
        canRedo: controller.snapshot.history.cursor < controller.snapshot.history.entries.length,
      }),
      isDirty: (rowId: RowId, column: string) => {
        const overlay = currentOverlay()
        return (
          overlay.inserts.get(rowId)?.live === true || overlayEdit(overlay, rowId, column) !== null
        )
      },
      onInsert: () => void controller.insertRow(),
      onUndo: () => void controller.undo(),
      onRedo: () => void controller.redo(),
      onCommitCell: (rowId, column, value) => void controller.commitCell(rowId, column, value),
      onDeleteRow: (rowId) => void controller.deleteRow(rowId),
    },
  })
  let dirtyHistory = controller.currentHistory
  let dirtyOverlay = stateAtCursor(base, dirtyHistory)
  const currentOverlay = () => {
    const history = controller.currentHistory
    if (history !== dirtyHistory) {
      dirtyHistory = history
      dirtyOverlay = stateAtCursor(base, history)
    }
    return dirtyOverlay
  }
  const editStatus = document.createElement('p')
  editStatus.id = 'edit-status'
  editStatus.setAttribute('role', 'status')
  elementOrThrow('grid-root').before(editStatus)
  activeGrid = grid
  activeOpenStage = 'first-row-render'
  grid.mount(elementOrThrow('grid-root'))
  await grid.whenFirstRowVisible()
  const firstRowVisibleMs = performance.now() - started
  activeOpenStage = 'edit-proof'
  const editProof = config.testHarness
    ? await exerciseRealEditor(grid, model, provider, controller, base)
    : undefined
  activeOpenStage = 'validation-proof'
  const validationProof =
    config.testHarness &&
    rows === 5 &&
    baseSchema.some((column) => column.name === 'value_maybe_null')
      ? await exerciseEffectiveValidation(validateEffectiveView, controller, provider, grid, model)
      : undefined
  const diffFullGate =
    config.testHarness &&
    !commandOpenedDataset &&
    rows === 12 &&
    baseSchema.length === 2 &&
    baseSchema[0]?.name === 'id' &&
    baseSchema[1]?.name === 'value'
  const diffProof = diffFullGate
    ? await exerciseStagedDiff(controller, provider, grid, () =>
        startExport('parquet', boot.client, handle, base, controller),
      )
    : undefined
  const diffCommandProof =
    config.testHarness && commandOpenedDataset && rows === 12 && baseSchema.length === 2
      ? await exerciseCommandDiff(controller, provider)
      : undefined
  const acceptanceProof =
    config.testHarness &&
    !commandOpenedDataset &&
    rows === 12 &&
    baseSchema.length === 3 &&
    baseSchema[0]?.name === 'id' &&
    baseSchema[1]?.name === 'value' &&
    baseSchema[2]?.name === 'value_maybe_null'
      ? await exerciseAcceptance(validateEffectiveView, controller, provider, grid, () =>
          startExport('parquet', boot.client, handle, base, controller),
        )
      : undefined
  if (config.testHarness) await startExport('parquet', boot.client, handle, base, controller)
  elementOrThrow('export-controls').hidden = false
  elementOrThrow('export-button').addEventListener('click', () => {
    const format = (elementOrThrow('export-format') as HTMLSelectElement).value
    void startExport(format, boot.client, handle, base, controller)
  })
  elementOrThrow('export-cancel').addEventListener('click', () => {
    const current = activeExportId
    if (current !== undefined) {
      exportCancelled = true
      postExportMessage({ kind: 'export-cancel', id: current, generation: exportGeneration })
      for (const [key, reject] of exportWaiters) {
        if (key.startsWith(`${current}:`))
          reject({ kind: 'export-cancelled', id: current, generation: exportGeneration })
      }
    }
    elementOrThrow('export-status').textContent = 'Export cancelled.'
  })
  const audit = auditGridDom(grid.element, {
    totalRows: rows,
    columnCount: columns,
    expectToolbar: true,
  })
  vscodeApi.postMessage({
    kind: 'opened',
    rows,
    columns,
    // Open (bytes in hand) → first grid row visible, in the webview. The
    // picker→bytes leg is host-side and not part of this number; the 1M-row
    // envelope is asserted in the run:spike harness (R4 methodology).
    firstRowVisibleMs,
    gridRendered: true,
    gridAudit: audit,
    ...(editProof === undefined ? {} : { editProof }),
    ...(validationProof === undefined ? {} : { validationProof }),
    ...(diffProof === undefined ? {} : { diffProof }),
    ...(diffCommandProof === undefined ? {} : { diffCommandProof }),
    ...(acceptanceProof === undefined ? {} : { acceptanceProof }),
    ...(gitContextView === undefined ? {} : { gitContext: gitContextView }),
  })
}

async function exerciseEffectiveValidation(
  validate: () => Promise<void>,
  controller: EditController,
  provider: EngineGridProvider,
  grid: WebviewDataGrid,
  model: GridViewportModel,
): Promise<{
  readonly baselineFailures: number
  readonly editedFailures: number
  readonly insertedFailures: number
  readonly deletedFailures: number
  readonly staleAfterEdit: boolean
  readonly logicalNavigation: boolean
}> {
  activeOpenStage = 'validation-contract-select'
  elementOrThrow('contract-select').dispatchEvent(new Event('click'))
  await waitUntil(() => contractText !== null || validationRequest === null)
  if (contractText === null) throw new Error('validation contract selection failed')
  const startingCursor = controller.snapshot.history.cursor
  const run = async (): Promise<ValidationProjection> => {
    await validate()
    if (validationReport === null || validationReport.revision !== controller.snapshot.revision)
      throw new Error('validation controller did not publish a current verdict')
    return validationReport
  }
  activeOpenStage = 'validation-baseline'
  const baseline = await run()
  const rule = baseline.rules[0]
  const sample = rule?.samples[0]
  if (rule === undefined || sample === undefined || rule.failCount !== 1)
    throw new Error('validation baseline invariant failed')
  activeOpenStage = 'validation-navigation'
  let logicalNavigation = false
  const count = await provider.rowCount()
  for (let start = 0; start < count; start += 128) {
    const page = await provider.fetchRange({
      startRow: start,
      endRow: Math.min(count, start + 128),
      startCol: 0,
      endCol: (await provider.schema()).length,
    })
    const offset = (page.rowKeys ?? []).indexOf(sample.rowKey)
    if (offset >= 0) {
      grid.scrollToRow(start + offset)
      logicalNavigation = true
      break
    }
  }
  if (!logicalNavigation) throw new Error('validation logical-row navigation failed')
  activeOpenStage = 'validation-edit'
  await controller.commitCell(sample.rowKey as RowId, 'value_maybe_null', {
    kind: 'number',
    value: 9.5,
  })
  validationReport = baseline
  const staleAfterEdit = isValidationStale(baseline, controller.snapshot.revision)
  elementOrThrow('validation-stale').hidden = !staleAfterEdit
  if (!staleAfterEdit || elementOrThrow('validation-stale').hidden)
    throw new Error('validation stale invariant failed')
  const edited = await run()
  if (edited.rules[0]?.failCount !== 0)
    throw new Error('validation effective edit invariant failed')
  await controller.undo()
  activeOpenStage = 'validation-insert'
  await controller.insertRow()
  const inserted = await run()
  if (inserted.rowCount !== baseline.rowCount + 1 || inserted.rules[0]?.failCount !== 2)
    throw new Error('validation effective insert invariant failed')
  await controller.undo()
  activeOpenStage = 'validation-delete-operation'
  await controller.deleteRow(sample.rowKey as RowId)
  activeOpenStage = 'validation-delete-run'
  const deleted = await run()
  activeOpenStage = 'validation-delete-check'
  if (deleted.rowCount !== baseline.rowCount - 1 || deleted.rules[0]?.failCount !== 0)
    throw new Error('validation effective delete invariant failed')
  await controller.undo()
  if (controller.snapshot.history.cursor !== startingCursor)
    throw new Error('validation proof did not restore the original overlay')
  await model.setSort(null)
  await model.setFilters([])
  await model.refresh()
  grid.scrollToRow(0)
  await grid.whenFirstRowVisible()
  return {
    baselineFailures: rule.failCount,
    editedFailures: edited.rules[0]!.failCount,
    insertedFailures: inserted.rules[0]!.failCount,
    deletedFailures: deleted.rules[0]!.failCount,
    staleAfterEdit,
    logicalNavigation,
  }
}

async function exerciseAcceptance(
  validate: () => Promise<void>,
  controller: EditController,
  provider: EngineGridProvider,
  grid: WebviewDataGrid,
  exportEffectiveCopy: () => Promise<void>,
): Promise<{
  readonly validatedCounts: readonly [number, number, number, number]
  readonly staleAfterEdit: boolean
  readonly unconfirmedRefused: boolean
  readonly refusalKind: 'invalid-keys' | 'not-observed'
  readonly diffCounts: readonly [number, number, number]
  readonly baseViewOnlyFalse: boolean
  readonly navigation: boolean
  readonly reportDelivered: boolean
  readonly copyDelivered: boolean
}> {
  const status = (): string => elementOrThrow('diff-status').textContent ?? ''
  // One dataset, one chained workflow (MVP scenario 11 on the desktop):
  // validate -> edit -> undo -> redo -> confirmed-key diff -> report + copy.
  activeOpenStage = 'acceptance-reset'
  while (controller.snapshot.history.cursor > 0) await controller.undo()
  activeOpenStage = 'acceptance-contract'
  elementOrThrow('contract-select').dispatchEvent(new Event('click'))
  await waitUntil(() => contractText !== null || validationRequest === null)
  if (contractText === null) throw new Error('acceptance contract selection failed')
  const run = async (): Promise<number> => {
    await validate()
    if (validationReport === null || validationReport.revision !== controller.snapshot.revision)
      throw new Error('acceptance validation did not publish a current verdict')
    return validationReport.rules[0]?.failCount ?? -1
  }
  activeOpenStage = 'acceptance-validate-baseline'
  const baselineFailures = await run()
  if (baselineFailures !== 1) throw new Error('acceptance validation baseline invariant failed')
  // Edit the null row's value_maybe_null; the effective view becomes valid.
  activeOpenStage = 'acceptance-edit'
  const schema = await provider.schema()
  const idColumn = schema.findIndex((column) => column.name === 'id')
  if (idColumn < 0) throw new Error('acceptance id column unavailable')
  const total = await provider.rowCount()
  let targetKey: string | undefined
  for (let start = 0; start < total; start += 128) {
    const page = await provider.fetchRange({
      startRow: start,
      endRow: Math.min(total, start + 128),
      startCol: 0,
      endCol: schema.length,
    })
    const offset = (page.rows ?? []).findIndex((row) => String(row[idColumn]) === '6')
    if (offset >= 0) {
      targetKey = page.rowKeys?.[offset]
      break
    }
  }
  if (targetKey === undefined) throw new Error('acceptance edit target row not found')
  await controller.commitCell(targetKey as RowId, 'value_maybe_null', {
    kind: 'number',
    value: 9.5,
  })
  if (!isValidationStale(validationReport, controller.snapshot.revision))
    throw new Error('acceptance stale invariant failed after edit')
  const staleAfterEdit = true
  activeOpenStage = 'acceptance-validate-edited'
  const editedFailures = await run()
  if (editedFailures !== 0) throw new Error('acceptance edited validation invariant failed')
  activeOpenStage = 'acceptance-undo'
  await controller.undo()
  const undoneFailures = await run()
  if (undoneFailures !== 1) throw new Error('acceptance undone validation invariant failed')
  activeOpenStage = 'acceptance-redo'
  await controller.redo()
  const redoneFailures = await run()
  if (redoneFailures !== 0) throw new Error('acceptance redone validation invariant failed')
  // Confirmed-key diff against the staged comparison — B mirrors the
  // EDITED view except one changed, one removed, one added row.
  activeOpenStage = 'acceptance-stage'
  testComparisonFixture = 'acceptance-b.csv'
  elementOrThrow('comparison-select').dispatchEvent(new Event('click'))
  await waitUntil(() => comparisonDiff !== null || status().includes('could not be staged'))
  if (comparisonDiff === null) throw new Error('acceptance comparison staging failed')
  activeOpenStage = 'acceptance-refusal'
  elementOrThrow('diff-confirm').dispatchEvent(new Event('click'))
  const refusalStatus = status()
  const unconfirmedRefused = refusalStatus.startsWith('Diff refused: invalid keys')
  // A SECOND, independently-normalized derivation of the same observation:
  // deleting the observation (and hardcoding the boolean above) leaves this
  // field 'not-observed' and the host normalizer rejects the whole proof.
  const refusalKind: 'invalid-keys' | 'not-observed' = refusalStatus.startsWith('Diff refused')
    ? 'invalid-keys'
    : 'not-observed'
  if (refusalKind !== 'invalid-keys') throw new Error('acceptance diff ran without confirmed keys')
  activeOpenStage = 'acceptance-diff'
  const select = elementOrThrow('diff-keys') as HTMLSelectElement
  for (const option of [...select.options]) option.selected = option.value === 'id'
  elementOrThrow('diff-confirm').dispatchEvent(new Event('click'))
  await waitUntil(
    () =>
      diffReport !== null &&
      !diffBusy &&
      diffReport.revision === controller.snapshot.revision &&
      diffReport.baseViewOnly === false,
  )
  const report = diffReport
  if (report === null) throw new Error('acceptance diff did not publish a report')
  const diffCounts = report.aspects.map((aspect) => aspect.count) as [number, number, number]
  if (diffCounts[0] !== 1 || diffCounts[1] !== 1 || diffCounts[2] !== 1 || report.identical)
    throw new Error('acceptance diff counts invariant failed')
  const baseViewOnlyFalse = !report.baseViewOnly
  activeOpenStage = 'acceptance-navigation'
  const changedAspect = report.aspects[2]
  const sample = changedAspect.samples.find((entry) => entry.side === 'A')
  if (sample === undefined) throw new Error('acceptance diff has no A-side sample')
  let navigation = false
  for (let start = 0; start < total; start += 128) {
    const page = await provider.fetchRange({
      startRow: start,
      endRow: Math.min(total, start + 128),
      startCol: 0,
      endCol: schema.length,
    })
    const offset = (page.rowKeys ?? []).indexOf(sample.rowKey)
    if (offset >= 0) {
      grid.scrollToRow(start + offset)
      navigation = true
      break
    }
  }
  if (!navigation) throw new Error('acceptance sample navigation failed')
  // Deliver the report (create-only) and the effective copy.
  activeOpenStage = 'acceptance-report'
  elementOrThrow('diff-export').dispatchEvent(new Event('click'))
  await waitUntil(() => reportExportRequest === null && status().includes('created'))
  const reportDelivered = status().includes('JSON report created')
  if (!reportDelivered) throw new Error('acceptance report export did not complete')
  activeOpenStage = 'acceptance-copy'
  await exportEffectiveCopy()
  const copyDelivered = true
  return {
    validatedCounts: [baselineFailures, editedFailures, undoneFailures, redoneFailures],
    staleAfterEdit,
    unconfirmedRefused,
    refusalKind,
    diffCounts,
    baseViewOnlyFalse,
    navigation,
    reportDelivered,
    copyDelivered,
  }
}

async function exerciseCommandDiff(
  controller: EditController,
  provider: EngineGridProvider,
): Promise<{
  readonly staged: boolean
  readonly unconfirmedRefused: boolean
  readonly baselineCounts: readonly [number, number, number]
}> {
  // The compare COMMAND opened this panel: prove it reached the SAME
  // confirmed-key controller — comparison staged through the real bridge,
  // execution refused without confirmed keys, then ONE confirmed baseline
  // run with exact counts. Edits/classes/exports belong to the full
  // scenario, not this reduced proof.
  activeOpenStage = 'diff-command-wait-staged'
  await waitUntil(
    () =>
      comparisonDiff !== null ||
      (elementOrThrow('diff-status').textContent ?? '').includes('could not be staged'),
  )
  if (comparisonDiff === null) throw new Error('compare command did not stage the comparison')
  activeOpenStage = 'diff-command-refusal'
  elementOrThrow('diff-confirm').dispatchEvent(new Event('click'))
  // The proof value is DERIVED from the observed refusal — a harness that
  // skips the observation cannot report the gate as proven.
  const refusalStatus = elementOrThrow('diff-status').textContent ?? ''
  const unconfirmedRefused = refusalStatus.startsWith('Diff refused: invalid keys')
  if (!unconfirmedRefused) throw new Error('compare command path ran a diff without confirmed keys')
  activeOpenStage = 'diff-command-baseline'
  const select = elementOrThrow('diff-keys') as HTMLSelectElement
  for (const option of [...select.options]) option.selected = option.value === 'id'
  elementOrThrow('diff-confirm').dispatchEvent(new Event('click'))
  await waitUntil(
    () => diffReport !== null && !diffBusy && diffReport.revision === controller.snapshot.revision,
  )
  const report = diffReport
  if (report === null) throw new Error('compare command confirmed diff did not publish a report')
  const counts = report.aspects.map((aspect) => aspect.count) as [number, number, number]
  if (counts[0] !== 1 || counts[1] !== 1 || counts[2] !== 1 || report.identical)
    throw new Error('compare command baseline counts invariant failed')
  void provider
  return { staged: comparisonDiff !== null, unconfirmedRefused, baselineCounts: counts }
}

async function exerciseStagedDiff(
  controller: EditController,
  provider: EngineGridProvider,
  grid: WebviewDataGrid,
  exportEffectiveCopy: () => Promise<void>,
): Promise<{
  readonly unconfirmedRefused: boolean
  readonly staleAfterEdit: boolean
  readonly baseViewOnlyFalse: boolean
  readonly navigation: boolean
  readonly baselineCounts: readonly [number, number, number]
  readonly editedChangedCount: number
  readonly identicalCase: boolean
  readonly schemaOnlyCase: boolean
  readonly noComparableCase: boolean
  readonly nestedCase: boolean
}> {
  const status = (): string => elementOrThrow('diff-status').textContent ?? ''
  // The editor harness that ran first leaves net-neutral ops (insert/delete
  // pairs) in the session; a base-view baseline diff needs the pristine
  // overlay, so undo to the session's base state before proving anything.
  activeOpenStage = 'diff-reset-overlay'
  while (controller.snapshot.history.cursor > 0) await controller.undo()
  // Refusal before any staging: the confirm button cannot run anything while
  // no comparison is staged (the gate is explicit confirmation, not selection).
  activeOpenStage = 'diff-unconfirmed-refusal'
  if (!elementOrThrow('diff-confirm').hasAttribute('disabled'))
    throw new Error('diff confirm is enabled before a comparison is staged')
  elementOrThrow('diff-confirm').dispatchEvent(new Event('click'))
  if (!status().startsWith('Diff refused'))
    throw new Error('unconfirmed diff execution was not refused before staging')
  // Refusal after staging with no keys selected (the multi-select starts empty).
  activeOpenStage = 'diff-comparison-select'
  elementOrThrow('comparison-select').dispatchEvent(new Event('click'))
  await waitUntil(() => comparisonDiff !== null || status().includes('not be staged'))
  if (comparisonDiff === null) throw new Error('staged-diff comparison staging failed')
  activeOpenStage = 'diff-unconfirmed-keys'
  elementOrThrow('diff-confirm').dispatchEvent(new Event('click'))
  if (!status().startsWith('Diff refused: invalid keys'))
    throw new Error('diff ran (or was refused for the wrong reason) without confirmed keys')
  const unconfirmedRefused = true
  // Baseline: confirm the fixture key explicitly and wait for the report.
  activeOpenStage = 'diff-baseline'
  const select = elementOrThrow('diff-keys') as HTMLSelectElement
  for (const option of [...select.options]) option.selected = option.value === 'id'
  elementOrThrow('diff-confirm').dispatchEvent(new Event('click'))
  try {
    await waitUntil(
      () =>
        diffReport !== null && !diffBusy && diffReport.revision === controller.snapshot.revision,
    )
  } catch (error) {
    throw new Error(
      `staged-diff baseline wait failed (status=${status().slice(0, 140)}): ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const baseline = diffReport
  if (baseline === null) throw new Error('confirmed diff did not publish a report')
  const baselineCounts = baseline.aspects.map((aspect) => aspect.count) as [number, number, number]
  if (
    baselineCounts[0] !== 1 ||
    baselineCounts[1] !== 1 ||
    baselineCounts[2] !== 1 ||
    baseline.identical ||
    !baseline.baseViewOnly
  ) {
    throw new Error(
      `staged-diff baseline counts/verdict invariant failed: counts=${baselineCounts.join('/')} identical=${String(baseline.identical)} baseViewOnly=${String(baseline.baseViewOnly)}`,
    )
  }
  // Navigation: an A-side changed sample must resolve to a live grid row.
  activeOpenStage = 'diff-navigation'
  const changed = baseline.aspects[2]
  const sample = changed.samples.find((entry) => entry.side === 'A')
  if (sample === undefined) throw new Error('staged-diff changed aspect has no A-side sample')
  let navigation = false
  const total = await provider.rowCount()
  for (let start = 0; start < total; start += 128) {
    const page = await provider.fetchRange({
      startRow: start,
      endRow: Math.min(total, start + 128),
      startCol: 0,
      endCol: (await provider.schema()).length,
    })
    const offset = (page.rowKeys ?? []).indexOf(sample.rowKey)
    if (offset >= 0) {
      grid.scrollToRow(start + offset)
      navigation = true
      break
    }
  }
  if (!navigation) throw new Error('staged-diff sample navigation failed')
  // Export the baseline report (host writes it as a new local file).
  activeOpenStage = 'diff-export-baseline'
  elementOrThrow('diff-export').dispatchEvent(new Event('click'))
  await waitUntil(() => reportExportRequest === null && status().includes('created'))
  if (!status().includes('JSON report created'))
    throw new Error('baseline report export did not complete')
  // Agreement fixture classes (queue done-when): identical, schema-only,
  // no-comparable, and nested-presence pairs, all staged through the REAL
  // select flow against the SAME opened A, all on the PRISTINE base view
  // (their reports claim baseViewOnly). A standalone profile-only pair is
  // impossible with a fully-matching confirmed key (any value change also
  // changes the row diff); the main pair already compares columnDeltas
  // field-for-field, so the profile aspect is covered there.
  const stageFixture = async (name: string): Promise<void> => {
    testComparisonFixture = name
    elementOrThrow('comparison-select').dispatchEvent(new Event('click'))
    // comparisonDiff keeps the PREVIOUS staging until the new one renders,
    // so completion is keyed on the staged-status line the renderer emits.
    await waitUntil(
      () =>
        status() === 'Comparison ready. Choose keys and confirm to run.' ||
        status().includes('not be staged') ||
        status().includes('could not be staged'),
    )
    if (!status().startsWith('Comparison ready'))
      throw new Error(
        `staged-diff fixture staging failed: ${name} (status=${status().slice(0, 120)})`,
      )
  }
  const runConfirmed = async (): Promise<void> => {
    // Wait for a NEW report object — not merely a different-from-baseline
    // one: an identity check against a fixed earlier report can pass on a
    // stale report before this run finishes.
    const before = diffReport
    for (const option of [...select.options]) option.selected = option.value === 'id'
    elementOrThrow('diff-confirm').dispatchEvent(new Event('click'))
    await waitUntil(
      () =>
        diffReport !== null &&
        !diffBusy &&
        diffReport !== before &&
        diffReport.revision === controller.snapshot.revision,
    )
  }
  const exportReport = async (stageLabel: string): Promise<void> => {
    activeOpenStage = stageLabel
    elementOrThrow('diff-export').dispatchEvent(new Event('click'))
    await waitUntil(() => reportExportRequest === null && status().includes('created'))
    if (!status().includes('JSON report created'))
      throw new Error(`staged-diff report export failed: ${stageLabel}`)
  }
  const classCheck = (
    label: string,
    check: (caseReport: NonNullable<typeof diffReport>) => void,
  ): boolean => {
    const caseReport = diffReport
    if (caseReport === null) throw new Error(`staged-diff class report missing: ${label}`)
    check(caseReport)
    return true
  }
  activeOpenStage = 'diff-case-identical'
  await stageFixture('comparison-identical.csv')
  await runConfirmed()
  const identicalCase = classCheck('identical', (caseReport) => {
    if (
      !caseReport.identical ||
      caseReport.aspects.some((aspect) => aspect.count !== 0) ||
      caseReport.drift.length !== 0
    ) {
      throw new Error('staged-diff identical-case invariant failed')
    }
  })
  await exportReport('diff-case-identical')
  activeOpenStage = 'diff-case-schema'
  await stageFixture('comparison-schema.csv')
  await runConfirmed()
  const schemaOnlyCase = classCheck('schema-only', (caseReport) => {
    if (
      caseReport.identical ||
      caseReport.drift.length !== 1 ||
      caseReport.aspects.some((aspect) => aspect.count !== 0)
    ) {
      throw new Error('staged-diff schema-only-case invariant failed')
    }
  })
  await exportReport('diff-case-schema')
  activeOpenStage = 'diff-case-onlykey'
  await stageFixture('comparison-onlykey.csv')
  await runConfirmed()
  const noComparableCase = classCheck('no-comparable', (caseReport) => {
    if (caseReport.changedComparable || caseReport.aspects[2].count !== 0)
      throw new Error('staged-diff no-comparable-case invariant failed')
  })
  await exportReport('diff-case-onlykey')
  activeOpenStage = 'diff-case-nested'
  await stageFixture('comparison-nested.parquet')
  await runConfirmed()
  const nestedCase = classCheck('nested', (caseReport) => {
    if (
      caseReport.identical ||
      caseReport.drift.length < 2 ||
      caseReport.aspects.some((aspect) => aspect.count !== 0) ||
      caseReport.changedComparable
    ) {
      throw new Error(
        `staged-diff nested-case invariant failed: identical=${String(caseReport.identical)} drift=${String(caseReport.drift.length)} counts=${caseReport.aspects.map((aspect) => aspect.count).join('/')} comparable=${String(caseReport.changedComparable)}`,
      )
    }
  })
  await exportReport('diff-case-nested')
  // Re-stage the primary comparison so the edit narrative runs against the
  // row-diff fixture, not the last class fixture.
  activeOpenStage = 'diff-restage-primary'
  await stageFixture('comparison-b.csv')
  await runConfirmed()
  // Accept an edit on the row with id=2 (currently equal to B): its value
  // change makes the changed aspect grow from 1 to 2 and flips the report stale.
  activeOpenStage = 'diff-edit-stale'
  const schema = await provider.schema()
  const idColumn = schema.findIndex((column) => column.name === 'id')
  const valueColumn = schema.findIndex((column) => column.name === 'value')
  if (idColumn < 0 || valueColumn < 0) throw new Error('staged-diff edit columns unavailable')
  let editedRowKey: string | undefined
  for (let start = 0; start < total; start += 128) {
    const page = await provider.fetchRange({
      startRow: start,
      endRow: Math.min(total, start + 128),
      startCol: 0,
      endCol: schema.length,
    })
    const offset = (page.rows ?? []).findIndex((row) => String(row[idColumn]) === '2')
    if (offset >= 0) {
      editedRowKey = page.rowKeys?.[offset]
      break
    }
  }
  if (editedRowKey === undefined) throw new Error('staged-diff edit target row not found')
  await controller.commitCell(editedRowKey as RowId, 'value', { kind: 'number', value: 555 })
  if (!isDiffStale(diffReport, controller.snapshot.revision))
    throw new Error('staged-diff stale predicate did not flip after edit')
  await waitUntil(() => !elementOrThrow('diff-stale').hidden)
  const staleAfterEdit = true
  // Re-diff the effective view: baseViewOnly must flip to false and the
  // changed aspect must reflect the accepted edit (1 -> 2).
  activeOpenStage = 'diff-edited'
  const preEditReport = diffReport
  for (const option of [...select.options]) option.selected = option.value === 'id'
  elementOrThrow('diff-confirm').dispatchEvent(new Event('click'))
  await waitUntil(
    () =>
      diffReport !== null &&
      !diffBusy &&
      diffReport !== preEditReport &&
      diffReport.revision === controller.snapshot.revision,
  )
  const edited = diffReport
  if (edited === null) throw new Error('edited diff did not publish a report')
  if (edited.baseViewOnly || edited.aspects[2].count !== 2)
    throw new Error('staged-diff edited baseViewOnly/changed-count invariant failed')
  await waitUntil(() => Boolean(elementOrThrow('diff-stale').hidden))
  const baseViewOnlyFalse = true
  const editedChangedCount = edited.aspects[2].count
  // Export the edited report, then the effective copy for the CLI agreement
  // leg — the copy must be the LAST parquet artifact of this open so the
  // runner's max-index pick is the edited view (a later unconditional
  // export would re-export the same accepted state, so order is safe).
  activeOpenStage = 'diff-export-edited'
  elementOrThrow('diff-export').dispatchEvent(new Event('click'))
  await waitUntil(() => reportExportRequest === null && status().includes('created'))
  if (!status().includes('JSON report created'))
    throw new Error('edited report export did not complete')
  activeOpenStage = 'diff-export-copy'
  await exportEffectiveCopy()
  return {
    unconfirmedRefused,
    staleAfterEdit,
    baseViewOnlyFalse,
    navigation,
    baselineCounts,
    editedChangedCount,
    identicalCase,
    schemaOnlyCase,
    noComparableCase,
    nestedCase,
  }
}

async function exerciseRealEditor(
  grid: WebviewDataGrid,
  model: GridViewportModel,
  provider: EngineGridProvider,
  controller: EditController,
  base: OverlayBase,
): Promise<{
  cellIdentity: boolean
  undoRedo: boolean
  insertDelete: boolean
  branchTruncation: boolean
  queryStatePreserved: boolean
  sessionWarningVisible: boolean
  keyboardCancel: boolean
  fullViewCastRefusal: boolean
}> {
  const readonlyInsertedRowDirty = await proveReadonlyInsertedRowDirtyMarker()
  const schema = model.schema ?? []
  const fullViewCastRefusal =
    base.baseRowCount > 32
      ? await proveFullViewCastRefusal(model, provider, controller, base)
      : false
  if (base.baseRowCount > 32) {
    return {
      cellIdentity: false,
      keyboardCancel: false,
      undoRedo: false,
      insertDelete: false,
      branchTruncation: false,
      queryStatePreserved: false,
      sessionWarningVisible: false,
      fullViewCastRefusal,
    }
  }
  const columnIndex = schema.findIndex(
    (column) => supportsCellDraft(column.type) && invalidDraftForTest(column.type) !== undefined,
  )
  if (columnIndex < 0) throw new Error('test proof has no editable scalar column')
  const column = schema[columnIndex]
  if (column === undefined) throw new Error('test proof column is unavailable')
  activeOpenStage = 'proof-sort-filter'
  await model.setSort({ column: column.name, direction: 'desc' })
  await model.setFilters([{ column: column.name, predicate: 'IS NOT NULL' }])
  await waitForReadyRow(model)
  const firstSlot = model.getRow(0)
  if (firstSlot.status !== 'ready' || firstSlot.key === undefined) {
    throw new Error('test proof could not resolve a logical row identity')
  }
  const targetId = firstSlot.key as RowId
  activeOpenStage = 'proof-editor-cancel'
  const keyboardCancel = await dispatchCellCancel(grid, model, targetId, columnIndex, column.type)
  if (!keyboardCancel || controller.snapshot.history.entries.length !== 0) {
    throw new Error('Escape did not cancel the production cell editor')
  }
  activeOpenStage = 'proof-identity-check'
  const identityMatchesEngine = await provider.verifyRowId(
    overlaySnapshot(base, emptyHistory()),
    0,
    targetId,
  )
  if (!identityMatchesEngine) throw new Error('test proof found a position-derived row identity')
  activeOpenStage = 'proof-cell-commit'
  const expected = draftForTest(column.type)
  const entriesBefore = controller.currentHistory.entries.length
  const initialRevision = await dispatchCellEdit(grid, model, targetId, columnIndex, expected)
  activeOpenStage = 'proof-cell-await-commit'
  await waitForRevision(controller, initialRevision)
  const active = controller.currentHistory
  const lastOp = active.entries[active.cursor - 1]?.op
  const cellIdentity =
    identityMatchesEngine &&
    active.entries.length === entriesBefore + 1 &&
    active.cursor === entriesBefore + 1 &&
    lastOp?.kind === 'cell-set' &&
    lastOp.rowId === targetId
  await waitUntil(() => {
    const index = findVisibleRowIndex(grid, model, targetId)
    return (
      index !== undefined &&
      grid.gridElement.querySelector<HTMLElement>(
        `[data-row-index="${String(index)}"] [data-col-index="${String(columnIndex)}"]`,
      )?.dataset.dirty === 'true'
    )
  })
  const dirtyIndex = findVisibleRowIndex(grid, model, targetId)
  const dirtyCell =
    dirtyIndex === undefined
      ? null
      : grid.gridElement.querySelector<HTMLElement>(
          `[data-row-index="${String(dirtyIndex)}"] [data-col-index="${String(columnIndex)}"]`,
        )
  const dirtyCellMarked = dirtyCell?.dataset.dirty === 'true'
  const dirtyRowMarked = findRenderedRow(grid, targetId)?.dataset.dirty === 'true'
  if (!dirtyCellMarked || !dirtyRowMarked)
    throw new Error('updated cell/row dirty markers were not rendered')
  activeOpenStage = 'proof-cell-view-check'
  const editedView = await provider.verifyCellValue(
    overlaySnapshot(base, controller.currentHistory),
    targetId,
    columnIndex,
    expected,
  )
  if (!editedView) throw new Error('test proof did not observe the edited effective row')

  activeOpenStage = 'proof-undo-redo'
  const beforeUndo = controller.snapshot.revision
  clickAndWait(grid, '.assay-edit-undo', controller, beforeUndo)
  await waitRevisionPromise(controller, beforeUndo)
  const undoWorked = controller.snapshot.history.cursor === 0
  await waitUntil(() => {
    const index = findVisibleRowIndex(grid, model, targetId)
    return (
      index !== undefined &&
      grid.gridElement.querySelector<HTMLElement>(
        `[data-row-index="${String(index)}"] [data-col-index="${String(columnIndex)}"]`,
      )?.dataset.dirty === 'false'
    )
  })
  const undoneIndex = findVisibleRowIndex(grid, model, targetId)
  const undoneCell =
    undoneIndex === undefined
      ? null
      : grid.gridElement.querySelector<HTMLElement>(
          `[data-row-index="${String(undoneIndex)}"] [data-col-index="${String(columnIndex)}"]`,
        )
  const undoClearedDirtyMarker =
    undoneCell?.dataset.dirty === 'false' &&
    findRenderedRow(grid, targetId)?.dataset.dirty === 'false'
  if (!undoClearedDirtyMarker) throw new Error('undo did not remove cell/row dirty markers')
  const afterUndo = controller.snapshot.revision
  if (controller.snapshot.history.cursor !== 0)
    throw new Error('test proof undo did not move history cursor')
  clickAndWait(grid, '.assay-edit-redo', controller, afterUndo)
  await waitRevisionPromise(controller, afterUndo)
  await waitUntil(() => {
    const index = findVisibleRowIndex(grid, model, targetId)
    return (
      index !== undefined &&
      grid.gridElement.querySelector<HTMLElement>(
        `[data-row-index="${String(index)}"] [data-col-index="${String(columnIndex)}"]`,
      )?.dataset.dirty === 'true'
    )
  })
  const redoneIndex = findVisibleRowIndex(grid, model, targetId)
  const redoneCell =
    redoneIndex === undefined
      ? null
      : grid.gridElement.querySelector<HTMLElement>(
          `[data-row-index="${String(redoneIndex)}"] [data-col-index="${String(columnIndex)}"]`,
        )
  const redoRestoredDirtyMarker =
    redoneCell?.dataset.dirty === 'true' &&
    findRenderedRow(grid, targetId)?.dataset.dirty === 'true'
  const undoRedo =
    undoWorked && Number(controller.snapshot.history.cursor) === 1 && redoRestoredDirtyMarker
  if (!redoRestoredDirtyMarker) throw new Error('redo did not restore cell dirty marker')

  activeOpenStage = 'proof-branch-and-null'
  const beforeBranchUndo = controller.snapshot.revision
  clickAndWait(grid, '.assay-edit-undo', controller, beforeBranchUndo)
  await waitRevisionPromise(controller, beforeBranchUndo)
  const alternate = draftForTest(column.type, true)
  const alternateRevision = await dispatchCellEdit(grid, model, targetId, columnIndex, alternate)
  await waitForRevision(controller, alternateRevision)
  const branchTruncationBase =
    Number(controller.snapshot.history.cursor) === controller.snapshot.history.entries.length &&
    Number(controller.snapshot.history.entries.length) === 1
  activeOpenStage = 'set-null-keyboard'
  const setNullKeyboard = await dispatchSetNull(grid, model, controller, targetId, columnIndex)
  if (!setNullKeyboard)
    throw new Error('Set NULL keyboard proof did not apply and undo exactly once')
  const branchTruncation = branchTruncationBase && setNullKeyboard

  activeOpenStage = 'proof-insert-delete'
  const queryStatePreserved = model.sort?.column === column.name && model.filters.length === 1
  await model.setFilters([])
  await waitForReadyRow(model)
  const rowCountBeforeInsert = model.totalRows ?? 0
  const insertRevision = controller.snapshot.revision
  grid.element.querySelector<HTMLButtonElement>('.assay-edit-insert')?.click()
  await waitForRevision(controller, insertRevision)
  const insertedState = stateAtCursor(base, controller.currentHistory)
  const insertedId = [...insertedState.inserts.values()].find((record) => record.live)?.id
  await waitUntil(
    () => insertedId !== undefined && findVisibleRowIndex(grid, model, insertedId) !== undefined,
  )
  await waitUntil(
    () => insertedId !== undefined && findRenderedRow(grid, insertedId)?.dataset.dirty === 'true',
  )
  const insertedIndex =
    insertedId === undefined ? undefined : findVisibleRowIndex(grid, model, insertedId)
  const insertedRow =
    insertedIndex === undefined
      ? null
      : grid.gridElement.querySelector<HTMLElement>(`[data-row-index="${String(insertedIndex)}"]`)
  const insertedDirty = insertedRow?.dataset.dirty === 'true'
  const inserted = (model.totalRows ?? 0) === rowCountBeforeInsert + 1 && insertedDirty
  if (!insertedDirty) throw new Error('inserted row dirty marker was not rendered')
  const insertUndoRevision = controller.snapshot.revision
  grid.element.querySelector<HTMLButtonElement>('.assay-edit-undo')?.click()
  await waitForRevision(controller, insertUndoRevision)
  const insertUndoCleared =
    insertedId !== undefined &&
    !isLiveRow(base, stateAtCursor(base, controller.currentHistory), insertedId)
  await waitUntil(
    () =>
      model.totalRows === rowCountBeforeInsert &&
      (insertedId === undefined || findRenderedRow(grid, insertedId) === undefined),
  )
  if (!insertUndoCleared) throw new Error('undo did not remove inserted row')
  const insertRedoRevision = controller.snapshot.revision
  grid.element.querySelector<HTMLButtonElement>('.assay-edit-redo')?.click()
  await waitForRevision(controller, insertRedoRevision)
  await waitUntil(
    () => insertedId !== undefined && findVisibleRowIndex(grid, model, insertedId) !== undefined,
  )
  await waitUntil(
    () => insertedId !== undefined && findRenderedRow(grid, insertedId)?.dataset.dirty === 'true',
  )
  const redoneInsertIndex =
    insertedId === undefined ? undefined : findVisibleRowIndex(grid, model, insertedId)
  const redoneInsert =
    redoneInsertIndex === undefined
      ? null
      : grid.gridElement.querySelector<HTMLElement>(
          `[data-row-index="${String(redoneInsertIndex)}"]`,
        )
  if (redoneInsert?.dataset.dirty !== 'true')
    throw new Error('redo did not restore inserted-row dirty marker')
  const insertRedoUndoRevision = controller.snapshot.revision
  grid.element.querySelector<HTMLButtonElement>('.assay-edit-undo')?.click()
  await waitForRevision(controller, insertRedoUndoRevision)
  const deleteRevision = controller.snapshot.revision
  await waitForReadyRow(model)
  const firstDeleteSlot = model.getRow(0)
  const deletedId = firstDeleteSlot.status === 'ready' ? firstDeleteSlot.key : undefined
  const row = grid.gridElement.querySelector<HTMLElement>('[data-row-index="0"]')
  row?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
  await waitForRevision(controller, deleteRevision)
  const deletedState = stateAtCursor(base, controller.currentHistory)
  const deletedIdentity =
    deletedId !== undefined && !isLiveRow(base, deletedState, deletedId as RowId)
  const deleted = (model.totalRows ?? 0) === rowCountBeforeInsert - 1 && deletedIdentity
  const deleteUndoRevision = controller.snapshot.revision
  grid.element.querySelector<HTMLButtonElement>('.assay-edit-undo')?.click()
  await waitForRevision(controller, deleteUndoRevision)
  const insertDelete =
    inserted &&
    deleted &&
    (model.totalRows ?? 0) === rowCountBeforeInsert &&
    readonlyInsertedRowDirty
  const sessionWarningVisible =
    grid.element
      .querySelector('.assay-session-warning')
      ?.textContent?.includes('Source is immutable') === true
  return {
    cellIdentity: cellIdentity && editedView,
    keyboardCancel,
    undoRedo,
    insertDelete,
    branchTruncation,
    queryStatePreserved,
    sessionWarningVisible,
    fullViewCastRefusal,
  }
}

async function proveReadonlyInsertedRowDirtyMarker(): Promise<boolean> {
  const insertedId = 'inserted-readonly-row' as RowId
  const provider: GridDataProvider = {
    rowCount: async () => 1,
    fetchRange: async (range) => ({
      startRow: range.startRow,
      rows: [[new Uint8Array([1])]],
      rowKeys: [insertedId],
    }),
    sort: async () => undefined,
    filter: async () => undefined,
    schema: async () => [{ name: 'payload', type: 'BLOB' }],
  }
  const model = new GridViewportModel(provider)
  await model.load()
  const grid = new WebviewDataGrid(model, {
    showToolbar: false,
    editing: {
      state: () => ({ busy: false, dirty: true, canUndo: true, canRedo: false }),
      isDirty: (rowId) => rowId === insertedId,
      onInsert: () => undefined,
      onUndo: () => undefined,
      onRedo: () => undefined,
      onCommitCell: () => undefined,
      onDeleteRow: () => undefined,
    },
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const firstRow = grid.whenFirstRowVisible()
  grid.mount(container)
  try {
    await firstRow
    const row = grid.gridElement.querySelector<HTMLElement>('[data-row-index="0"]')
    const cell = row?.querySelector<HTMLElement>('[data-col-index="0"]')
    const passed =
      row?.dataset.rowId === insertedId &&
      row.dataset.dirty === 'true' &&
      cell?.dataset.dirty === 'true' &&
      cell.title.startsWith('Read-only:') &&
      !cell.hasAttribute('aria-label')
    if (!passed) throw new Error('read-only inserted-row dirty annotation was not rendered')
    return true
  } finally {
    grid.dispose()
    container.remove()
  }
}

async function proveFullViewCastRefusal(
  model: GridViewportModel,
  provider: EngineGridProvider,
  controller: EditController,
  base: OverlayBase,
): Promise<boolean> {
  const schema = model.schema ?? []
  const numeric = schema.find((column) =>
    /^(TINYINT|SMALLINT|INTEGER|INT|BIGINT)/i.test(column.type),
  )
  const visible = schema.find((column) => column.name !== numeric?.name)
  if (numeric === undefined || visible === undefined || model.totalRows === null) return false
  const hiddenOrdinal = base.baseRowCount - 1
  activeOpenStage = 'wide-clear-filters'
  await model.setFilters([])
  activeOpenStage = 'wide-read-hidden-row'
  const page = await provider.fetchRange({
    startRow: hiddenOrdinal,
    endRow: hiddenOrdinal + 1,
    startCol: 0,
    endCol: schema.length,
  })
  const hiddenRowId = page.rowKeys?.[0] as RowId | undefined
  if (hiddenRowId === undefined) return false
  activeOpenStage = 'wide-filter-hidden-row'
  await model.setFilters([{ column: visible.name, predicate: "= 'shown'" }])
  const filteredCount = model.totalRows
  const cursorBefore = controller.snapshot.history.cursor
  activeOpenStage = 'wide-candidate-preflight'
  try {
    await controller.commitCell(hiddenRowId, numeric.name, { kind: 'text', text: 'invalid-cast' })
  } catch {
    // The proof below owns the value-free invariant outcome even if activation
    // itself rejects; never forward an engine error that could include data.
  }
  activeOpenStage = 'wide-check-status'
  const status = document.getElementById('edit-status')
  activeOpenStage = 'wide-check-history'
  const cursorStable = controller.snapshot.history.cursor === cursorBefore
  const historyEmpty = controller.snapshot.history.entries.length === 0
  activeOpenStage = 'wide-check-error'
  const castRefusalError =
    controller.snapshot.error?.includes('cannot be represented safely') === true
  const errorAlert = castRefusalError && status?.getAttribute('role') === 'alert'
  activeOpenStage = 'wide-check-count'
  let filteredCountStable = false
  try {
    filteredCountStable = model.totalRows === filteredCount
  } catch {
    // A poisoned effective view is a failed cast-refusal invariant too.
  }
  if (!(cursorStable && historyEmpty && errorAlert && filteredCountStable)) {
    throw new Error(
      `whole-view cast refusal invariant failed: cursor=${String(cursorStable)} historyEmpty=${String(historyEmpty)} castRefusalError=${String(castRefusalError)} errorAlert=${String(errorAlert)} filteredCountStable=${String(filteredCountStable)}`,
    )
  }
  return true
}

async function dispatchCellCancel(
  grid: WebviewDataGrid,
  model: GridViewportModel,
  rowId: RowId,
  columnIndex: number,
  type: string,
): Promise<boolean> {
  const { cell, selector } = await openCellEditor(grid, model, rowId, columnIndex)
  const input = cell.querySelector<HTMLInputElement>('.assay-cell-editor')
  if (input === null) return false
  const originalDraft = input.value
  const invalidDraft = invalidDraftForTest(type)
  if (invalidDraft === undefined) return false
  input.value = invalidDraft
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  const invalidRetained =
    input.isConnected &&
    document.activeElement === input &&
    input.value === invalidDraft &&
    grid.element.querySelector<HTMLElement>('.assay-grid-command-error')?.hidden === false
  for (const key of ['Delete', 'ArrowLeft', 'ArrowRight', 'Home', 'End']) {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  }
  const nativeKeysIsolated = input.isConnected && document.activeElement === input
  input.value = originalDraft
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await waitUntil(
    () => grid.gridElement.querySelector(selector)?.querySelector('.assay-cell-editor') === null,
  )
  if (!invalidRetained) {
    throw new Error(
      `invalid editor retention check failed: connected=${String(input.isConnected)} focused=${String(document.activeElement === input)} unchanged=${String(input.value === invalidDraft)} error=${String(grid.element.querySelector<HTMLElement>('.assay-grid-command-error')?.hidden === false)}`,
    )
  }
  if (!nativeKeysIsolated) throw new Error('native editing keys escaped the cell editor')
  return true
}

function invalidDraftForTest(type: string): string | undefined {
  const normalized = type.toUpperCase()
  if (/^(BOOLEAN|BOOL|LOGICAL)$/.test(normalized)) return 'not-a-boolean'
  if (
    /^(TINYINT|SMALLINT|INTEGER|INT|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|DECIMAL|NUMERIC|FLOAT|REAL|DOUBLE)/.test(
      normalized,
    )
  ) {
    return 'not-a-number'
  }
  return undefined
}

async function dispatchCellEdit(
  grid: WebviewDataGrid,
  model: GridViewportModel,
  rowId: RowId,
  columnIndex: number,
  draft: string,
): Promise<number> {
  const { cell } = await openCellEditor(grid, model, rowId, columnIndex)
  const input = cell.querySelector<HTMLInputElement>('.assay-cell-editor')
  if (input === null) throw new Error('Enter did not open the production cell editor')
  activeOpenStage = 'proof-cell-dispatch'
  const revision = activeController?.snapshot.revision
  if (revision === undefined) throw new Error('test proof controller is unavailable')
  input.value = draft
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  return revision
}

async function dispatchSetNull(
  grid: WebviewDataGrid,
  model: GridViewportModel,
  controller: EditController,
  rowId: RowId,
  columnIndex: number,
): Promise<boolean> {
  activeOpenStage = 'set-null-editor-open'
  const { cell } = await openCellEditor(grid, model, rowId, columnIndex)
  await waitUntil(() => cell.querySelector<HTMLButtonElement>('.assay-cell-set-null') !== null)
  const button = cell.querySelector<HTMLButtonElement>('.assay-cell-set-null')
  if (button === null) throw new Error('set-null-button-not-opened')
  const revision = controller.snapshot.revision
  button.focus()
  activeOpenStage = 'set-null-dispatch'
  button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  activeOpenStage = 'set-null-await-commit'
  await waitForRevision(controller, revision)
  const op = controller.currentHistory.entries.at(-1)?.op
  const setNullApplied = op?.kind === 'cell-set' && op.value.kind === 'null'
  const undoRevision = controller.snapshot.revision
  grid.element.querySelector<HTMLButtonElement>('.assay-edit-undo')?.click()
  await waitForRevision(controller, undoRevision)
  if (!setNullApplied) throw new Error('set-null-operation-not-recorded')
  if (controller.snapshot.history.cursor !== 1)
    throw new Error('set-null-undo-did-not-restore-cursor')
  return true
}

function findRenderedRow(grid: WebviewDataGrid, rowId: RowId): HTMLElement | undefined {
  return [...grid.gridElement.querySelectorAll<HTMLElement>('[data-row-id]')].find(
    (row) => row.dataset.rowId === rowId,
  )
}

function findVisibleRowIndex(
  grid: WebviewDataGrid,
  model: GridViewportModel,
  rowId: RowId,
): number | undefined {
  for (const row of grid.gridElement.querySelectorAll<HTMLElement>('[data-row-index]')) {
    const index = Number(row.dataset.rowIndex)
    const slot = model.getRow(index)
    if (slot.status === 'ready' && slot.key === rowId) return index
  }
  return undefined
}

async function openCellEditor(
  grid: WebviewDataGrid,
  model: GridViewportModel,
  rowId: RowId,
  columnIndex: number,
): Promise<{ readonly cell: HTMLElement; readonly selector: string }> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const rowIndex = findVisibleRowIndex(grid, model, rowId)
    if (rowIndex !== undefined) {
      const selector = `[data-row-index="${String(rowIndex)}"] [data-col-index="${String(columnIndex)}"]`
      const cell = grid.gridElement.querySelector<HTMLElement>(selector)
      if (cell?.getAttribute('aria-label')?.startsWith('Edit ') === true) {
        const input = cell.querySelector<HTMLInputElement>('.assay-cell-editor')
        if (input !== null) return { cell, selector }
        activeOpenStage = 'proof-cell-editor-open'
        cell.focus()
        cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        if (cell.isConnected) {
          const openedInput = cell.querySelector<HTMLInputElement>('.assay-cell-editor')
          if (openedInput !== null) return { cell, selector }
        }
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('test proof editor did not render for the logical row')
}

function draftForTest(type: string, alternate = false): string {
  const normalized = type.toUpperCase()
  if (/^(BOOLEAN|BOOL|LOGICAL)$/.test(normalized)) return alternate ? 'false' : 'true'
  if (/^(VARCHAR|TEXT|STRING|CHAR|BPCHAR|NVARCHAR|JSON|UUID)/.test(normalized)) {
    return alternate ? '__assay_branch__' : '__assay_edit__'
  }
  if (/^(FLOAT|REAL|DOUBLE)/.test(normalized)) return alternate ? '912.5' : '911.25'
  return alternate ? '9007199254740994' : '9007199254740993'
}

async function waitForReadyRow(model: GridViewportModel): Promise<void> {
  await waitUntil(() => model.totalRows !== null && model.getRow(0).status === 'ready')
}

async function waitForRevision(controller: EditController, revision: number): Promise<void> {
  try {
    await waitUntil(
      () =>
        !controller.snapshot.busy &&
        (controller.snapshot.revision > revision || controller.snapshot.error !== null),
    )
  } catch {
    const snapshot = controller.snapshot
    throw new Error(
      `test proof revision timeout busy=${String(snapshot.busy)} advanced=${String(snapshot.revision > revision)} rejected=${String(snapshot.error !== null)}`,
    )
  }
  if (controller.snapshot.revision <= revision) {
    throw new Error(
      controller.snapshot.error?.includes('cannot be represented safely')
        ? 'test proof candidate cast was rejected'
        : 'test proof operation was rejected',
    )
  }
}

async function waitRevisionPromise(controller: EditController, revision: number): Promise<boolean> {
  await waitForRevision(controller, revision)
  return controller.snapshot.revision > revision
}

function clickAndWait(
  grid: WebviewDataGrid,
  selector: string,
  controller: EditController,
  revision: number,
): void {
  const button = grid.element.querySelector<HTMLButtonElement>(selector)
  if (button === null || button.disabled)
    throw new Error('test proof history control is unavailable')
  button.click()
  void waitForRevision(controller, revision)
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('test proof timed out')
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
}

let datasetReceived = false
// True when this panel was opened by the compare COMMAND (test mode): the
// harness runs a REDUCED diff proof instead of the full exercise.
let commandOpenedDataset = false

window.addEventListener('message', (event) => {
  const data = event.data as {
    kind?: string
    context?: unknown
    name?: string
    bytes?: ArrayBuffer
    errorKind?: string
    message?: string
    id?: string
    generation?: number
    displayName?: string
    status?: string
    commandOpened?: boolean
  }
  if (data?.kind === 'comparison-stage-request') {
    // The compare command stages as soon as the panel is ready, but the
    // open-flow harness exercises may still hold busy states — a click can
    // be accepted (request sent) and the staging still refused later while
    // an edit is pending, with nobody left to re-click. Gate on completion:
    // re-click whenever idle and no comparison is staged yet, until the
    // staging actually lands (or the bounded window closes; the reduced
    // command proof's own wait then surfaces the honest failure).
    void (async () => {
      const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline && comparisonDiff === null) {
        if (!comparisonBusy && !diffBusy) {
          elementOrThrow('comparison-select').dispatchEvent(new Event('click'))
        }
        await sleep(200)
      }
    })()
    return
  }
  if (data?.kind === 'git-context') {
    const block = document.getElementById('git-context')
    const context = data.context as
      { state?: unknown; detail?: unknown; branch?: unknown } | undefined
    if (context !== null && typeof context === 'object') {
      gitContextView = {
        state: typeof context.state === 'string' ? context.state : 'unknown',
        hasBranch: typeof context.branch === 'string' && context.branch.length > 0,
      }
    }
    if (block !== null && typeof context?.detail === 'string') {
      const state = typeof context.state === 'string' ? context.state : 'unknown'
      const branch = typeof context.branch === 'string' ? ` · ${context.branch}` : ''
      block.textContent = `${context.detail}${branch}`
      block.hidden = state === 'no-git' || state === 'no-repository'
    }
    return
  }
  if (
    (data?.kind === 'comparison-loaded' ||
      data?.kind === 'comparison-cancelled' ||
      data?.kind === 'comparison-error') &&
    typeof data.id === 'string' &&
    Number.isSafeInteger(data.generation)
  ) {
    const expected = comparisonRequest
    if (expected === null || data.id !== expected.id || data.generation !== expected.generation)
      return
    if (
      data.kind === 'comparison-loaded' &&
      data.bytes instanceof ArrayBuffer &&
      typeof data.name === 'string' &&
      typeof data.displayName === 'string'
    ) {
      stageComparisonHandler?.({
        id: data.id,
        generation: data.generation!,
        name: data.name,
        displayName: data.displayName,
        bytes: data.bytes,
      })
    } else {
      comparisonBusy = false
      elementOrThrow('diff-status').textContent =
        data.kind === 'comparison-cancelled'
          ? 'Comparison selection cancelled.'
          : 'Comparison file is unsupported, empty, too large, or could not be read.'
    }
    return
  }
  if (
    data?.kind === 'report-export-result' &&
    reportExportRequest !== null &&
    data.id === reportExportRequest.id &&
    data.generation === reportExportRequest.generation
  ) {
    reportExportRequest = null
    const message =
      data.status === 'created'
        ? 'JSON report created as a new local file.'
        : data.status === 'cancelled'
          ? 'Report export cancelled.'
          : data.status === 'busy'
            ? 'Report export refused: another export is pending.'
            : data.status === 'refused'
              ? 'Report export refused: destination exists, aliases a source, or is not a local file.'
              : 'Report export failed; no success was reported.'
    elementOrThrow('diff-status').textContent = message
    return
  }
  if (
    data?.kind === 'contract-loaded' ||
    data?.kind === 'contract-cancelled' ||
    data?.kind === 'contract-error'
  ) {
    const expected = validationRequest
    if (expected === null) return
    const correlated =
      acceptsValidationFrame(expected, data) ||
      ((data.kind === 'contract-cancelled' || data.kind === 'contract-error') &&
        data.id === expected.id &&
        data.generation === expected.generation)
    if (!correlated) return
    validationRequest = null
    if (data.kind === 'contract-loaded' && acceptsValidationFrame(expected, data)) {
      contractText = data.text
      validationReport = null
      elementOrThrow('validation-results').replaceChildren()
      elementOrThrow('validation-stale').hidden = true
      elementOrThrow('validate-button').removeAttribute('disabled')
      elementOrThrow('validation-status').textContent =
        'Contract selected. Validate the effective view when ready.'
    } else if (
      data.kind === 'contract-cancelled' &&
      data.id === expected.id &&
      data.generation === expected.generation
    ) {
      elementOrThrow('validation-status').textContent = 'Contract selection cancelled.'
    } else if (
      data.kind === 'contract-error' &&
      data.id === expected.id &&
      data.generation === expected.generation
    ) {
      elementOrThrow('validation-status').textContent =
        'Contract could not be read (empty, too large, or unavailable).'
    }
    return
  }
  if (
    typeof data?.id === 'string' &&
    [
      'export-ready',
      'export-credit',
      'export-complete',
      'export-cancelled',
      'export-error',
    ].includes(String(data.kind))
  ) {
    const response = data as ExportHostResponse
    if (data.kind === 'export-cancelled' || data.kind === 'export-error') {
      for (const [key, reject] of exportWaiters) {
        if (key.startsWith(`${data.id}:`)) reject(response)
      }
    } else {
      exportWaiters.get(`${data.id}:${String(data.kind)}`)?.(response)
    }
    return
  }
  if (data?.kind === 'dataset' && !datasetReceived && data.bytes instanceof ArrayBuffer) {
    // One dataset per panel (the bridge's contract); the engine persists for
    // the panel's whole life (EngineSession) — the grid lives on it.
    datasetReceived = true
    commandOpenedDataset = data.commandOpened === true
    openDataset(data.name ?? 'dataset', data.bytes).catch((error: unknown) => {
      const testErrorCategory =
        error instanceof Error && error.message === 'test proof candidate cast was rejected'
          ? 'candidate-cast-rejected'
          : error instanceof Error && error.message === 'test proof operation was rejected'
            ? 'operation-rejected'
            : error instanceof Error && error.message.startsWith('test proof revision timeout ')
              ? 'proof-revision-timeout'
              : error instanceof Error && error.message.startsWith('set-null-')
                ? error.message
                : error instanceof Error && error.message.startsWith('Set NULL keyboard proof')
                  ? 'set-null-assertion'
                  : error instanceof Error && error.message === 'test proof timed out'
                    ? 'proof-timeout'
                    : error instanceof Error
                      ? 'operation-error'
                      : 'unknown'
      const castInvariantFailure =
        error instanceof Error &&
        error.message.startsWith('whole-view cast refusal invariant failed: ')
      let message: string
      if (config.testHarness && castInvariantFailure && error instanceof Error) {
        message = error.message
      } else if (config.testHarness) {
        message = `test-only open failure stage=${activeOpenStage} category=${testErrorCategory}`
      } else {
        message = error instanceof Error ? error.message : String(error)
      }
      renderError('engine-failed', message)
      vscodeApi.postMessage({ kind: 'engine-error', message })
    })
    return
  }
  if (data?.kind === 'error' && typeof data.errorKind === 'string') {
    renderError(data.errorKind, data.message ?? '')
    vscodeApi.postMessage({ kind: 'error-shown', errorKind: data.errorKind })
    return
  }
  if (data?.kind === 'dispose') {
    validationGeneration++
    validationRequest = null
    if (activeExportId !== undefined) {
      exportCancelled = true
      postExportMessage({ kind: 'export-cancel', id: activeExportId, generation: exportGeneration })
    }
    comparisonGeneration++
    if (comparisonRequest !== null)
      vscodeApi.postMessage({ kind: 'comparison-cancel', ...comparisonRequest })
    comparisonRequest = null
    diffGeneration++
    diffBusy = false
    if (reportExportRequest !== null)
      vscodeApi.postMessage({ kind: 'report-export-cancel', ...reportExportRequest })
    reportExportRequest = null
    // Host-orchestrated panel close (see EngineSession for the ownership
    // model; the custom-editor path tears the page — and the engine worker —
    // down with the panel regardless).
    activeController?.dispose()
    activeController = null
    activeGrid?.dispose()
    activeGrid = null
    void engineSession.dispose()
  }
})

vscodeApi.postMessage({ kind: 'ready' })

export {}
