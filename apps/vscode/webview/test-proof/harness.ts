// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Test-proof harness primitives (D03b) — bounded waits and DOM lookups shared
 * by the desktop webview's `exercise*` orchestration.
 *
 * This whole module tree is TEST-PROOF code: it runs only behind the webview's
 * `config.testHarness` gate (host: `ExtensionMode.Test`, see
 * `src/dataset.ts`). It is still bundled with production (a separate measured
 * choice would exclude it); nothing here is imported by production code paths
 * that run for a real user open.
 */
import type { RowId } from '@assay/domain'
import type { GridViewportModel } from '@assay/grid'
import type { EditController } from '../../src/pure/edit-controller'
import type { WebviewDataGrid } from '../data-grid'

/** Wait for a predicate with a bounded (15 s) budget. */
export async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('test proof timed out')
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
}

/** Wait for the controller to leave `revision` (accepted or rejected). */
export async function waitForRevision(controller: EditController, revision: number): Promise<void> {
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

export async function waitRevisionPromise(
  controller: EditController,
  revision: number,
): Promise<boolean> {
  await waitForRevision(controller, revision)
  return controller.snapshot.revision > revision
}

export function clickAndWait(
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

export async function waitForReadyRow(model: GridViewportModel): Promise<void> {
  await waitUntil(() => model.totalRows !== null && model.getRow(0).status === 'ready')
}

export function findRenderedRow(grid: WebviewDataGrid, rowId: RowId): HTMLElement | undefined {
  return [...grid.gridElement.querySelectorAll<HTMLElement>('[data-row-id]')].find(
    (row) => row.dataset.rowId === rowId,
  )
}

export function findVisibleRowIndex(
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

export async function openCellEditor(
  grid: WebviewDataGrid,
  model: GridViewportModel,
  rowId: RowId,
  columnIndex: number,
  setStage: (stage: string) => void,
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
        setStage('proof-cell-editor-open')
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

export function draftForTest(type: string, alternate = false): string {
  const normalized = type.toUpperCase()
  if (/^(BOOLEAN|BOOL|LOGICAL)$/.test(normalized)) return alternate ? 'false' : 'true'
  if (/^(VARCHAR|TEXT|STRING|CHAR|BPCHAR|NVARCHAR|JSON|UUID)/.test(normalized)) {
    return alternate ? '__assay_branch__' : '__assay_edit__'
  }
  if (/^(FLOAT|REAL|DOUBLE)/.test(normalized)) return alternate ? '912.5' : '911.25'
  return alternate ? '9007199254740994' : '9007199254740993'
}

export function invalidDraftForTest(type: string): string | undefined {
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
