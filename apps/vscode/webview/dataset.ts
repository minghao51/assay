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
 * D03b composition: this entry is WIRING. The cohesive presentation
 * controllers live beside it and take explicit inputs/outputs —
 * `webview/validation-panel.ts` (contract selection, run, report, stale),
 * `webview/diff-panel.ts` (staging, confirmed diff, report, report export),
 * `webview/dirty-history.ts` (grid editing state, dirty-cell predicate, edit
 * status). Their DOM-free decisions live in `src/pure/*-presenter.ts` and are
 * unit-tested in Node. Test-proof orchestration lives in `webview/test-proof/`
 * and is never reached from here (R-10): it arrives as an INJECTED runner, from
 * the test-only entry the pinned test host loads instead of this one.
 *
 * Typed host errors are rendered as text; every DOM update is
 * `textContent`/`hidden`/`setAttribute` (no `innerHTML` anywhere,
 * engineering/04 §6); dataset values are untrusted content rendered as text
 * only. No telemetry exists in this extension and none may be added
 * (ADR 0025/0037).
 */
import { GridViewportModel } from '@assay/grid'
import { emptyHistory, stateAtCursor } from '@assay/domain'
import type { OverlayBase } from '@assay/domain'
import type { WorkerDiagnostic } from './engine-boot'
import { EditController } from '../src/pure/edit-controller'
import { overlaySnapshot } from '../src/pure/overlay-snapshot'
import type {
  ExportHostRequest,
  ExportHostResponse,
  SafeExportFormat,
} from '../src/pure/export-transfer'
import { EngineSession } from './engine-session'
import { EngineGridProvider } from './grid-provider'
import { WebviewDataGrid } from './data-grid'
import { auditGridDom } from './grid-audit'
import { elementOrThrow } from './dom'
import { ValidationPanel } from './validation-panel'
import { DiffPanel } from './diff-panel'
import { DirtyHistoryView } from './dirty-history'

/** Mirror of the host-side config in `src/dataset.ts` (buildDatasetConfig). */
interface DatasetWebviewConfig {
  readonly target: 'desktop-webview'
  readonly vscodeVersion: string
  /** Host-injected module script URL (consumed by the HTML, not this script). */
  readonly mainScriptUrl: string
  readonly workerEntryUrl: string
  /**
   * The vendored DuckDB-WASM `eh` pair (ADR 0048 decision 3 — the desktop
   * package ships `eh` only; Electron's Chromium is fixed and EH-capable).
   */
  readonly glueUrl: string
  readonly wasmUrl: string
  readonly vendoredExtensions: readonly {
    readonly url: string
    readonly autoloadPath: string
  }[]
  readonly duckdbVersion: string
  readonly blockedExtensionHost: string
  /** Host-computed test predicate (see `installOpenProofs`). */
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
// The latest projected git context (value-free) received from the host.
let gitContextView: { readonly state: string; readonly hasBranch: boolean } | undefined
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
 * The D03b proof inputs this entry hands the INJECTED runner (R-10). The shape
 * is declared here rather than imported from `webview/test-proof/`: a
 * `import type` is erased, but the production entry must not name the proof
 * modules in any form, so this is the single seam. The test-only entry
 * (`webview/test-proof/entry.ts`) assigns `runOpenProofs` to
 * {@link OpenProofsRunner}, which makes a drift between the two declarations a
 * `pnpm typecheck` failure instead of a silent runtime mismatch.
 */
export interface OpenProofsInput {
  /** Gate flag copied from the injected webview config (layer 3 of the gate). */
  readonly testHarness: boolean
  readonly rows: number
  readonly columns: number
  readonly schema: readonly { readonly name: string; readonly type: string }[]
  readonly commandOpened: boolean
  readonly grid: WebviewDataGrid
  readonly model: GridViewportModel
  readonly provider: EngineGridProvider
  readonly controller: EditController
  readonly base: OverlayBase
  readonly validation: ValidationPanel
  readonly diff: DiffPanel
  readonly exportEffectiveCopy: () => Promise<void>
  readonly setStage: (stage: string) => void
}

/** The injected proof runner (the test-only entry's adapted `runOpenProofs`). */
export type OpenProofsRunner = (input: OpenProofsInput) => Promise<Record<string, unknown>>

/**
 * The installed proof runner — `undefined` in production, ALWAYS. No import in
 * this module's graph can install it: {@link installOpenProofs} is called only
 * by `webview/test-proof/entry.ts`, which esbuild emits as the separate
 * test-only `dist/webview/dataset-proof.js`. Because this entry has no edge to
 * `webview/test-proof/**`, dead-code elimination drops all six proof modules
 * from the production bundle (R-10) — the gate is structural, not a build
 * convention.
 */
let openProofsRunner: OpenProofsRunner | undefined

/**
 * Install the test-only proof runner. Only the test-only webview entry calls
 * this; the runtime gate is unchanged — the host still computes `testHarness`
 * as `ExtensionMode.Test && ASSAY_E2E_EDIT_PROOF === '1'`
 * (`apps/vscode/src/dataset.ts`), this entry still passes that flag through,
 * and the runner still refuses unless it is exactly `true`
 * (`webview/test-proof/index.ts`).
 *
 * Ordering: the runner is read only when the host's `dataset` frame arrives,
 * which is a later macrotask than module evaluation, so an install performed
 * while the test entry's module graph evaluates is always in place first.
 */
export function installOpenProofs(runner: OpenProofsRunner): void {
  openProofsRunner = runner
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
      glueUrl: config.glueUrl,
      wasmUrl: config.wasmUrl,
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
  let dirtyHistory: DirtyHistoryView | null = null
  const setStage = (stage: string): void => {
    activeOpenStage = stage
  }
  /** Resolve a logical row key by paging the provider, then scroll to it. */
  const navigateToLogicalRow = async (rowKey: string): Promise<boolean> => {
    const total = await provider.rowCount()
    for (let start = 0; start < total; start += 128) {
      const page = await provider.fetchRange({
        startRow: start,
        endRow: Math.min(total, start + 128),
        startCol: 0,
        endCol: (await provider.schema()).length,
      })
      const offset = (page.rowKeys ?? []).indexOf(rowKey)
      if (offset >= 0) {
        grid?.scrollToRow(start + offset)
        grid?.focusGrid()
        return true
      }
    }
    return false
  }
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
      dirtyHistory?.render(snapshot)
      validationPanel.refreshStale()
      diffPanel.refreshStale()
    },
  )
  activeController = controller
  const effectiveColumns = (): ReturnType<typeof stateAtCursor>['columns'] =>
    stateAtCursor(base, controller.currentHistory).columns
  const validationPanel = new ValidationPanel({
    post: (message) => vscodeApi.postMessage(message),
    currentRevision: () => controller.snapshot.revision,
    editPending: () => controller.snapshot.busy,
    effectiveColumns,
    overlay: () => overlaySnapshot(base, controller.currentHistory),
    validate: async (plan, overlay) => boot.client.validate(handle, plan, overlay),
    navigateToRow: navigateToLogicalRow,
    createId: () => crypto.randomUUID(),
  })
  const diffPanel = new DiffPanel({
    post: (message) => vscodeApi.postMessage(message),
    datasetHandle: handle,
    currentRevision: () => controller.snapshot.revision,
    editPending: () => controller.snapshot.busy,
    effectiveColumns,
    overlay: () => overlaySnapshot(base, controller.currentHistory),
    stageComparison: async (source) => boot.client.stageComparison(source),
    openComparison: async (source) => boot.client.open(source),
    schema: async (comparisonHandle) => boot.client.schema(comparisonHandle),
    profile: async (comparisonHandle) => boot.client.profile(comparisonHandle),
    runDiff: async (comparison, plan, overlay) =>
      boot.client.diff(handle, comparison, plan, overlay),
    navigateToRow: navigateToLogicalRow,
    createId: () => crypto.randomUUID(),
  })
  activeValidationPanel = validationPanel
  activeDiffPanel = diffPanel
  validationPanel.mount()
  diffPanel.mount()
  if (autoStageRequested) {
    autoStageRequested = false
    diffPanel.requestAutoStage()
  }
  dirtyHistory = new DirtyHistoryView({
    base,
    controller,
    grid: () => grid,
  })
  grid = new WebviewDataGrid(model, {
    ariaLabel: 'Assay dataset grid',
    editing: dirtyHistory.editing,
  })
  dirtyHistory.mountStatus()
  activeGrid = grid
  activeOpenStage = 'first-row-render'
  grid.mount(elementOrThrow('grid-root'))
  await grid.whenFirstRowVisible()
  const firstRowVisibleMs = performance.now() - started

  const exportEffectiveCopy = (): Promise<void> =>
    startExport('parquet', boot.client, handle, base, controller)
  const proofs =
    openProofsRunner === undefined
      ? {}
      : await openProofsRunner({
          testHarness: config.testHarness,
          rows,
          columns,
          schema: baseSchema,
          commandOpened: commandOpenedDataset,
          grid,
          model,
          provider,
          controller,
          base,
          validation: validationPanel,
          diff: diffPanel,
          exportEffectiveCopy,
          setStage,
        })
  if (config.testHarness) await exportEffectiveCopy()
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
    ...proofs,
    ...(gitContextView === undefined ? {} : { gitContext: gitContextView }),
  })
}

let datasetReceived = false
// True when this panel was opened by the compare COMMAND (test mode): the
// harness runs a REDUCED diff proof instead of the full exercise.
let commandOpenedDataset = false
// The panel controllers of the OPEN dataset (null before the dataset frame
// and after disposal); the message router delegates every correlated frame.
let activeValidationPanel: ValidationPanel | null = null
let activeDiffPanel: DiffPanel | null = null
// The compare command's auto-stage request can arrive BEFORE the dataset frame
// finishes opening (the host posts `dataset` then `comparison-stage-request`);
// replay it once the panels are mounted so the retry is never dropped.
let autoStageRequested = false

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
  if (activeDiffPanel?.handleHostFrame(data) === true) return
  if (activeValidationPanel?.handleHostFrame(data) === true) return
  if (data?.kind === 'comparison-stage-request' && activeDiffPanel === null) {
    // Panels not mounted yet: remember the request and replay after mount.
    autoStageRequested = true
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
    autoStageRequested = false
    activeValidationPanel?.dispose()
    activeValidationPanel = null
    if (activeExportId !== undefined) {
      exportCancelled = true
      postExportMessage({ kind: 'export-cancel', id: activeExportId, generation: exportGeneration })
    }
    activeDiffPanel?.cancelPendingOnDispose()
    activeDiffPanel?.dispose()
    activeDiffPanel = null
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
