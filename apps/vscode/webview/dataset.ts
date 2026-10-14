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
import { emptyHistory, isLiveRow, overlayEdit, stateAtCursor } from '@assay/domain'
import type { OverlayBase, RowId } from '@assay/domain'
import type { WorkerDiagnostic } from './engine-boot'
import { EditController } from '../src/pure/edit-controller'
import { overlaySnapshot } from '../src/pure/overlay-snapshot'
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
  readonly vendoredExtension: {
    readonly url: string
    readonly autoloadPath: string
    readonly duckdbVersion: string
  }
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

const config = window.__ASSAY_DATASET_CONFIG__
const vscodeApi = acquireVsCodeApi()

/** One engine per panel (see `EngineSession` — boot once, dispose on close). */
const engineSession = new EngineSession()
const diagnostics: Array<WorkerDiagnostic> = []
let activeController: EditController | null = null
let activeGrid: WebviewDataGrid | null = null
let activeOpenStage = 'engine-start'

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
      vendoredExtensionUrl: config.vendoredExtension.url,
      autoloadPath: config.vendoredExtension.autoloadPath,
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
    },
  )
  activeController = controller
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
        const overlay = stateAtCursor(base, controller.currentHistory)
        return overlayEdit(overlay, rowId, column) !== null
      },
      onInsert: () => void controller.insertRow(),
      onUndo: () => void controller.undo(),
      onRedo: () => void controller.redo(),
      onCommitCell: (rowId, column, value) => void controller.commitCell(rowId, column, value),
      onDeleteRow: (rowId) => void controller.deleteRow(rowId),
    },
  })
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
  })
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
  activeOpenStage = 'edit-proof-follow-up'
  await model.setSort({ column: column.name, direction: 'desc' })
  await model.setFilters([{ column: column.name, predicate: 'IS NOT NULL' }])
  await waitForReadyRow(model)
  const firstSlot = model.getRow(0)
  if (firstSlot.status !== 'ready' || firstSlot.key === undefined) {
    throw new Error('test proof could not resolve a logical row identity')
  }
  const targetId = firstSlot.key as RowId
  const keyboardCancel = await dispatchCellCancel(grid, model, targetId, columnIndex, column.type)
  if (!keyboardCancel || controller.snapshot.history.entries.length !== 0) {
    throw new Error('Escape did not cancel the production cell editor')
  }
  const identityMatchesEngine = await provider.verifyRowId(
    overlaySnapshot(base, emptyHistory()),
    0,
    targetId,
  )
  if (!identityMatchesEngine) throw new Error('test proof found a position-derived row identity')
  const initialRevision = controller.snapshot.revision
  const expected = draftForTest(column.type)
  const entriesBefore = controller.currentHistory.entries.length
  await dispatchCellEdit(grid, model, targetId, columnIndex, expected)
  await waitForRevision(controller, initialRevision)
  const active = controller.currentHistory
  const lastOp = active.entries[active.cursor - 1]?.op
  const cellIdentity =
    identityMatchesEngine &&
    active.entries.length === entriesBefore + 1 &&
    active.cursor === entriesBefore + 1 &&
    lastOp?.kind === 'cell-set' &&
    lastOp.rowId === targetId
  const editedView = await provider.verifyCellValue(
    overlaySnapshot(base, controller.currentHistory),
    targetId,
    columnIndex,
    expected,
  )
  if (!editedView) throw new Error('test proof did not observe the edited effective row')

  const beforeUndo = controller.snapshot.revision
  clickAndWait(grid, '.assay-edit-undo', controller, beforeUndo)
  await waitRevisionPromise(controller, beforeUndo)
  const undoWorked = controller.snapshot.history.cursor === 0
  const afterUndo = controller.snapshot.revision
  if (controller.snapshot.history.cursor !== 0)
    throw new Error('test proof undo did not move history cursor')
  clickAndWait(grid, '.assay-edit-redo', controller, afterUndo)
  await waitRevisionPromise(controller, afterUndo)
  const undoRedo = undoWorked && Number(controller.snapshot.history.cursor) === 1

  const beforeBranchUndo = controller.snapshot.revision
  clickAndWait(grid, '.assay-edit-undo', controller, beforeBranchUndo)
  await waitRevisionPromise(controller, beforeBranchUndo)
  const alternate = draftForTest(column.type, true)
  await dispatchCellEdit(grid, model, targetId, columnIndex, alternate)
  await waitForRevision(controller, controller.snapshot.revision)
  const branchTruncationBase =
    Number(controller.snapshot.history.cursor) === controller.snapshot.history.entries.length &&
    Number(controller.snapshot.history.entries.length) === 1
  activeOpenStage = 'set-null-keyboard'
  const setNullKeyboard = await dispatchSetNull(grid, model, controller, targetId, columnIndex)
  if (!setNullKeyboard)
    throw new Error('Set NULL keyboard proof did not apply and undo exactly once')
  const branchTruncation = branchTruncationBase && setNullKeyboard

  const queryStatePreserved = model.sort?.column === column.name && model.filters.length === 1
  await model.setFilters([])
  await waitForReadyRow(model)
  const rowCountBeforeInsert = model.totalRows ?? 0
  const insertRevision = controller.snapshot.revision
  grid.element.querySelector<HTMLButtonElement>('.assay-edit-insert')?.click()
  await waitForRevision(controller, insertRevision)
  const inserted = (model.totalRows ?? 0) === rowCountBeforeInsert + 1
  const insertUndoRevision = controller.snapshot.revision
  grid.element.querySelector<HTMLButtonElement>('.assay-edit-undo')?.click()
  await waitForRevision(controller, insertUndoRevision)
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
  const insertDelete = inserted && deleted && (model.totalRows ?? 0) === rowCountBeforeInsert
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
  await controller.commitCell(hiddenRowId, numeric.name, { kind: 'text', text: 'invalid-cast' })
  const status = document.getElementById('edit-status')
  const cursorStable = controller.snapshot.history.cursor === cursorBefore
  const historyEmpty = controller.snapshot.history.entries.length === 0
  const errorAlert = controller.snapshot.error !== null && status?.getAttribute('role') === 'alert'
  const filteredCountStable = model.totalRows === filteredCount
  if (!(cursorStable && historyEmpty && errorAlert && filteredCountStable)) {
    throw new Error(
      `whole-view cast refusal invariant failed: cursor=${String(cursorStable)} historyEmpty=${String(historyEmpty)} errorAlert=${String(errorAlert)} filteredCountStable=${String(filteredCountStable)}`,
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
  const rowIndex = findVisibleRowIndex(grid, model, rowId)
  if (rowIndex === undefined) return false
  const selector = `[data-row-index="${String(rowIndex)}"] [data-col-index="${String(columnIndex)}"]`
  await waitUntil(
    () =>
      grid.gridElement
        .querySelector<HTMLElement>(selector)
        ?.getAttribute('aria-label')
        ?.startsWith('Edit ') === true,
  )
  const cell = grid.gridElement.querySelector<HTMLElement>(selector)
  if (cell === null) return false
  cell.focus()
  cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
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
): Promise<void> {
  await waitUntil(() => findVisibleRowIndex(grid, model, rowId) !== undefined)
  const rowIndex = findVisibleRowIndex(grid, model, rowId)
  if (rowIndex === undefined)
    throw new Error('test proof logical row is not in the effective viewport')
  const selector = `[data-row-index="${String(rowIndex)}"] [data-col-index="${String(columnIndex)}"]`
  await waitUntil(
    () =>
      grid.gridElement
        .querySelector<HTMLElement>(selector)
        ?.getAttribute('aria-label')
        ?.startsWith('Edit ') === true,
  )
  const cell = grid.gridElement.querySelector<HTMLElement>(selector)
  if (cell === null) throw new Error('test proof could not find the real rendered cell')
  cell.focus()
  cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  const input = cell.querySelector<HTMLInputElement>('.assay-cell-editor')
  if (input === null) throw new Error('Enter did not open the production cell editor')
  input.value = draft
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
}

async function dispatchSetNull(
  grid: WebviewDataGrid,
  model: GridViewportModel,
  controller: EditController,
  rowId: RowId,
  columnIndex: number,
): Promise<boolean> {
  const rowIndex = findVisibleRowIndex(grid, model, rowId)
  if (rowIndex === undefined) throw new Error('set-null-row-not-visible')
  const cell = grid.gridElement.querySelector<HTMLElement>(
    `[data-row-index="${String(rowIndex)}"] [data-col-index="${String(columnIndex)}"]`,
  )
  if (cell === null) throw new Error('set-null-cell-not-rendered')
  cell.focus()
  cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  const button = cell.querySelector<HTMLButtonElement>('.assay-cell-set-null')
  if (button === null) throw new Error('set-null-button-not-opened')
  const revision = controller.snapshot.revision
  button.focus()
  button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
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
  await waitUntil(() => !controller.snapshot.busy && controller.snapshot.revision > revision)
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

window.addEventListener('message', (event) => {
  const data = event.data as {
    kind?: string
    name?: string
    bytes?: ArrayBuffer
    errorKind?: string
    message?: string
  }
  if (data?.kind === 'dataset' && !datasetReceived && data.bytes instanceof ArrayBuffer) {
    // One dataset per panel (the bridge's contract); the engine persists for
    // the panel's whole life (EngineSession) — the grid lives on it.
    datasetReceived = true
    openDataset(data.name ?? 'dataset', data.bytes).catch((error: unknown) => {
      const testErrorCategory =
        error instanceof Error && error.message.startsWith('set-null-')
          ? error.message
          : error instanceof Error && error.message.startsWith('Set NULL keyboard proof')
            ? 'set-null-assertion'
            : error instanceof Error && error.message === 'test proof timed out'
              ? 'proof-timeout'
              : error instanceof Error
                ? 'operation-error'
                : 'unknown'
      const message = config.testHarness
        ? `test-only open failure stage=${activeOpenStage} category=${testErrorCategory}`
        : error instanceof Error
          ? error.message
          : String(error)
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
