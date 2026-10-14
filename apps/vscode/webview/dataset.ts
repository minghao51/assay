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
