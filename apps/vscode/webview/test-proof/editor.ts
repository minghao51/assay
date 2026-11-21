// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Session-editing proof orchestration (D03b) — the `exercise*` half of the
 * desktop webview's editor acceptance: Escape-cancel retention, logical row
 * identity, dirty markers, undo/redo/branch truncation, Set NULL, insert and
 * delete, plus the read-only inserted-row annotation and whole-view cast
 * refusal probes.
 *
 * TEST-PROOF code: reachable only through `webview/test-proof/index.ts`, which
 * the entry calls only when `config.testHarness` is set (host:
 * `ExtensionMode.Test`). Every assertion drives the REAL production controls;
 * the `setStage` seam only labels the step for the host's failure report.
 */
import { emptyHistory, isLiveRow } from '@assay/domain'
import type { OverlayBase, RowId } from '@assay/domain'
import { GridViewportModel } from '@assay/grid'
import type { GridDataProvider } from '@assay/grid'
import { supportsCellDraft } from '../../src/pure/cell-input'
import type { EditController } from '../../src/pure/edit-controller'
import { stateAtCursor } from '@assay/domain'
import { overlaySnapshot } from '../../src/pure/overlay-snapshot'
import { WebviewDataGrid } from '../data-grid'
import type { EngineGridProvider } from '../grid-provider'
import {
  clickAndWait,
  draftForTest,
  findRenderedRow,
  findVisibleRowIndex,
  invalidDraftForTest,
  openCellEditor,
  waitForReadyRow,
  waitForRevision,
  waitRevisionPromise,
  waitUntil,
} from './harness'

/** Editor proof result (the `editProof` payload of the `opened` message). */
export interface EditProofResult {
  cellIdentity: boolean
  undoRedo: boolean
  insertDelete: boolean
  branchTruncation: boolean
  queryStatePreserved: boolean
  sessionWarningVisible: boolean
  keyboardCancel: boolean
  fullViewCastRefusal: boolean
}

/** Explicit inputs of the editor proof. */
export interface EditorProofInput {
  readonly grid: WebviewDataGrid
  readonly model: GridViewportModel
  readonly provider: EngineGridProvider
  readonly controller: EditController
  readonly base: OverlayBase
  readonly setStage: (stage: string) => void
}

export async function exerciseRealEditor(input: EditorProofInput): Promise<EditProofResult> {
  const { grid, model, provider, controller, base, setStage } = input
  const readonlyInsertedRowDirty = await proveReadonlyInsertedRowDirtyMarker()
  const schema = model.schema ?? []
  const fullViewCastRefusal =
    base.baseRowCount > 32
      ? await proveFullViewCastRefusal({ model, provider, controller, base, setStage })
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
  setStage('proof-sort-filter')
  await model.setSort({ column: column.name, direction: 'desc' })
  await model.setFilters([{ column: column.name, predicate: 'IS NOT NULL' }])
  await waitForReadyRow(model)
  const firstSlot = model.getRow(0)
  if (firstSlot.status !== 'ready' || firstSlot.key === undefined) {
    throw new Error('test proof could not resolve a logical row identity')
  }
  const targetId = firstSlot.key as RowId
  setStage('proof-editor-cancel')
  const keyboardCancel = await dispatchCellCancel({
    grid,
    model,
    rowId: targetId,
    columnIndex,
    type: column.type,
    setStage,
  })
  if (!keyboardCancel || controller.snapshot.history.entries.length !== 0) {
    throw new Error('Escape did not cancel the production cell editor')
  }
  setStage('proof-identity-check')
  const identityMatchesEngine = await provider.verifyRowId(
    overlaySnapshot(base, emptyHistory()),
    0,
    targetId,
  )
  if (!identityMatchesEngine) throw new Error('test proof found a position-derived row identity')
  setStage('proof-cell-commit')
  const expected = draftForTest(column.type)
  const entriesBefore = controller.currentHistory.entries.length
  const initialRevision = await dispatchCellEdit({
    grid,
    model,
    controller,
    rowId: targetId,
    columnIndex,
    draft: expected,
    setStage,
  })
  setStage('proof-cell-await-commit')
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
  setStage('proof-cell-view-check')
  const editedView = await provider.verifyCellValue(
    overlaySnapshot(base, controller.currentHistory),
    targetId,
    columnIndex,
    expected,
  )
  if (!editedView) throw new Error('test proof did not observe the edited effective row')

  setStage('proof-undo-redo')
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

  setStage('proof-branch-and-null')
  const beforeBranchUndo = controller.snapshot.revision
  clickAndWait(grid, '.assay-edit-undo', controller, beforeBranchUndo)
  await waitRevisionPromise(controller, beforeBranchUndo)
  const alternate = draftForTest(column.type, true)
  const alternateRevision = await dispatchCellEdit({
    grid,
    model,
    controller,
    rowId: targetId,
    columnIndex,
    draft: alternate,
    setStage,
  })
  await waitForRevision(controller, alternateRevision)
  const branchTruncationBase =
    Number(controller.snapshot.history.cursor) === controller.snapshot.history.entries.length &&
    Number(controller.snapshot.history.entries.length) === 1
  setStage('set-null-keyboard')
  const setNullKeyboard = await dispatchSetNull({
    grid,
    model,
    controller,
    rowId: targetId,
    columnIndex,
    setStage,
  })
  if (!setNullKeyboard)
    throw new Error('Set NULL keyboard proof did not apply and undo exactly once')
  const branchTruncation = branchTruncationBase && setNullKeyboard

  setStage('proof-insert-delete')
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

/**
 * Read-only inserted-row annotation: a grid mounted on a provider whose single
 * row is a live insert must mark BOTH the row and the cell dirty and title the
 * cell as read-only (no `aria-label`, so the editor is not offered).
 */
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

/**
 * Whole-view cast refusal on a filtered wide view: a candidate edit on a row
 * the filter hides must be refused by activation, leaving the history cursor,
 * the history itself, the filtered row count, and the error alert unchanged.
 */
async function proveFullViewCastRefusal(input: {
  readonly model: GridViewportModel
  readonly provider: EngineGridProvider
  readonly controller: EditController
  readonly base: OverlayBase
  readonly setStage: (stage: string) => void
}): Promise<boolean> {
  const { model, provider, controller, base, setStage } = input
  const schema = model.schema ?? []
  const numeric = schema.find((column) =>
    /^(TINYINT|SMALLINT|INTEGER|INT|BIGINT)/i.test(column.type),
  )
  const visible = schema.find((column) => column.name !== numeric?.name)
  if (numeric === undefined || visible === undefined || model.totalRows === null) return false
  const hiddenOrdinal = base.baseRowCount - 1
  setStage('wide-clear-filters')
  await model.setFilters([])
  setStage('wide-read-hidden-row')
  const page = await provider.fetchRange({
    startRow: hiddenOrdinal,
    endRow: hiddenOrdinal + 1,
    startCol: 0,
    endCol: schema.length,
  })
  const hiddenRowId = page.rowKeys?.[0] as RowId | undefined
  if (hiddenRowId === undefined) return false
  setStage('wide-filter-hidden-row')
  await model.setFilters([{ column: visible.name, predicate: "= 'shown'" }])
  const filteredCount = model.totalRows
  const cursorBefore = controller.snapshot.history.cursor
  setStage('wide-candidate-preflight')
  try {
    await controller.commitCell(hiddenRowId, numeric.name, { kind: 'text', text: 'invalid-cast' })
  } catch {
    // The proof below owns the value-free invariant outcome even if activation
    // itself rejects; never forward an engine error that could include data.
  }
  setStage('wide-check-status')
  const status = document.getElementById('edit-status')
  setStage('wide-check-history')
  const cursorStable = controller.snapshot.history.cursor === cursorBefore
  const historyEmpty = controller.snapshot.history.entries.length === 0
  setStage('wide-check-error')
  const castRefusalError =
    controller.snapshot.error?.includes('cannot be represented safely') === true
  const errorAlert = castRefusalError && status?.getAttribute('role') === 'alert'
  setStage('wide-check-count')
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

async function dispatchCellCancel(input: {
  readonly grid: WebviewDataGrid
  readonly model: GridViewportModel
  readonly rowId: RowId
  readonly columnIndex: number
  readonly type: string
  readonly setStage: (stage: string) => void
}): Promise<boolean> {
  const { grid, model, rowId, columnIndex, type, setStage } = input
  const { cell, selector } = await openCellEditor(grid, model, rowId, columnIndex, setStage)
  const inputEl = cell.querySelector<HTMLInputElement>('.assay-cell-editor')
  if (inputEl === null) return false
  const originalDraft = inputEl.value
  const invalidDraft = invalidDraftForTest(type)
  if (invalidDraft === undefined) return false
  inputEl.value = invalidDraft
  inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  const invalidRetained =
    inputEl.isConnected &&
    document.activeElement === inputEl &&
    inputEl.value === invalidDraft &&
    grid.element.querySelector<HTMLElement>('.assay-grid-command-error')?.hidden === false
  for (const key of ['Delete', 'ArrowLeft', 'ArrowRight', 'Home', 'End']) {
    inputEl.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  }
  const nativeKeysIsolated = inputEl.isConnected && document.activeElement === inputEl
  inputEl.value = originalDraft
  inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await waitUntil(
    () => grid.gridElement.querySelector(selector)?.querySelector('.assay-cell-editor') === null,
  )
  if (!invalidRetained) {
    throw new Error(
      `invalid editor retention check failed: connected=${String(inputEl.isConnected)} focused=${String(document.activeElement === inputEl)} unchanged=${String(inputEl.value === invalidDraft)} error=${String(grid.element.querySelector<HTMLElement>('.assay-grid-command-error')?.hidden === false)}`,
    )
  }
  if (!nativeKeysIsolated) throw new Error('native editing keys escaped the cell editor')
  return true
}

async function dispatchCellEdit(input: {
  readonly grid: WebviewDataGrid
  readonly model: GridViewportModel
  readonly controller: EditController
  readonly rowId: RowId
  readonly columnIndex: number
  readonly draft: string
  readonly setStage: (stage: string) => void
}): Promise<number> {
  const { grid, model, controller, rowId, columnIndex, draft, setStage } = input
  const { cell } = await openCellEditor(grid, model, rowId, columnIndex, setStage)
  const inputEl = cell.querySelector<HTMLInputElement>('.assay-cell-editor')
  if (inputEl === null) throw new Error('Enter did not open the production cell editor')
  setStage('proof-cell-dispatch')
  const revision = controller.snapshot.revision
  inputEl.value = draft
  inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  return revision
}

async function dispatchSetNull(input: {
  readonly grid: WebviewDataGrid
  readonly model: GridViewportModel
  readonly controller: EditController
  readonly rowId: RowId
  readonly columnIndex: number
  readonly setStage: (stage: string) => void
}): Promise<boolean> {
  const { grid, model, controller, rowId, columnIndex, setStage } = input
  setStage('set-null-editor-open')
  const { cell } = await openCellEditor(grid, model, rowId, columnIndex, setStage)
  await waitUntil(() => cell.querySelector<HTMLButtonElement>('.assay-cell-set-null') !== null)
  const button = cell.querySelector<HTMLButtonElement>('.assay-cell-set-null')
  if (button === null) throw new Error('set-null-button-not-opened')
  const revision = controller.snapshot.revision
  button.focus()
  setStage('set-null-dispatch')
  button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  setStage('set-null-await-commit')
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
