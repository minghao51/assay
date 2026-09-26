import { expect } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'

/**
 * Shared grid locators and inline-edit / column-op flows (q-5, AR-F4). These
 * were re-declared verbatim across the grid, editing, column-ops, export, and
 * journey specs; this module is the single definition.
 *
 * Consolidation keeps locator construction identical — no spec may loosen an
 * assertion — and every helper preserves the exact readiness/commit steps the
 * duplicated copies performed.
 */

/** The grid row carrying `data-row-index=index`. */
export function row(page: Page, index: number): Locator {
  return page.locator(`[data-testid="grid-row"][data-row-index="${String(index)}"]`)
}

/** The `columnIndex`-th cell of the given row. */
export function cell(page: Page, rowIndex: number, columnIndex: number): Locator {
  return row(page, rowIndex).getByTestId('grid-cell').nth(columnIndex)
}

/** The header cell for the named column. */
export function headerCell(page: Page, name: string): Locator {
  return page.locator(`[data-testid="grid-header-cell"][data-col-name="${name}"]`)
}

/** Wait until a rendered row has its data (the window fetch landed). */
export async function waitForReadyRow(page: Page, rowIndex: number): Promise<void> {
  await expect(row(page, rowIndex)).toHaveAttribute('data-status', 'ready')
}

/** Double-click a ready cell and wait for its inline editor. */
export async function openEditor(page: Page, rowIndex: number, columnIndex: number): Promise<void> {
  await waitForReadyRow(page, rowIndex)
  await cell(page, rowIndex, columnIndex).dblclick()
  await expect(page.getByTestId('grid-cell-editor')).toBeVisible()
}

/** Commit a typed value into a cell through the inline editor. */
export async function editCell(
  page: Page,
  rowIndex: number,
  columnIndex: number,
  value: string,
): Promise<void> {
  await openEditor(page, rowIndex, columnIndex)
  const editor = page.getByTestId('grid-editor-input')
  await editor.fill(value)
  await editor.press('Enter')
  await expect(page.getByTestId('grid-cell-editor')).toHaveCount(0)
}

/** Open the per-column rename editor and commit a new name. */
export async function renameColumn(page: Page, from: string, to: string): Promise<void> {
  const panel = page.getByTestId('schema-panel')
  await panel.locator(`[data-testid="column-rename-open"][data-col-name="${from}"]`).click()
  const input = panel.locator('[data-testid="column-rename-input"]')
  await input.fill(to)
  await input.press('Enter')
}

/** Open the per-column cast editor, choose a target, and commit. */
export async function castColumn(page: Page, column: string, target: string): Promise<void> {
  const panel = page.getByTestId('schema-panel')
  await panel.locator(`[data-testid="column-cast-open"][data-col-name="${column}"]`).click()
  await panel.locator('[data-testid="column-cast-select"]').selectOption(target)
  await panel.locator('[data-testid="column-cast-commit"]').click()
}
