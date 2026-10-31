import path from 'node:path'
import { expect, test } from '@playwright/test'
import { cell, row, waitForReadyRow } from './support/grid'
import { openSection } from './support/fixtures'

// q-3 (PT-Q a11y polish pack, AR-W10): the keyboard and live-region contract
// for the two interactive surfaces the audit flagged.
//
//  1. ExportDialog is a real modal dialog: `aria-modal`, initial focus, a
//     Tab/Shift+Tab trap that cycles inside while open, Escape-to-close, and
//     focus returned to the trigger afterward.
//  2. Grid edit commit and client-side rejection announce through the SINGLE
//     `aria-live="polite"` region (`edit-live-region`); the rejection reason
//     is value-free (never the typed draft or a cell value, ADR 0025).
//  3. An end-to-end keyboard-only journey — open → edit → export — with every
//     activation performed through the keyboard.
//
// The picker path is the usual hidden-`<input type="file">` fallback.
// Privacy (ADR 0025): the suite runs on the committed synthetic fixture; the
// live-region assertions prove no typed value leaks into the announcement.

const FIXTURE = path.join(process.cwd(), 'fixtures', 'parquet', 'customers.parquet')

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
      delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker
    } catch {
      // Non-configurable globals would be a Chromium change; the test then
      // fails loudly at the chooser/download rather than silently.
    }
  })
})

test('ExportDialog is a modal dialog: initial focus, Tab trap, Escape, focus return', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'idle', {
    timeout: 20_000,
  })
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('open-button').click()
  await (await chooserPromise).setFiles(FIXTURE)
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'ready', {
    timeout: 20_000,
  })
  await openSection(page, 'export')

  const trigger = page.getByTestId('export-open')
  await trigger.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByTestId('export-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveAttribute('role', 'dialog')
  await expect(dialog).toHaveAttribute('aria-modal', 'true')

  // Initial focus lands inside the dialog (the checked format radio).
  await expect(page.getByTestId('export-format-parquet')).toBeFocused()

  // Shift+Tab from the first control wraps to the last (Close)…
  await page.keyboard.press('Shift+Tab')
  await expect(page.getByTestId('export-close')).toBeFocused()
  // …and Tab from the last wraps back to the first.
  await page.keyboard.press('Tab')
  await expect(page.getByTestId('export-format-parquet')).toBeFocused()

  // Every forward Tab stays inside the open dialog.
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab')
    expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true)
  }

  // Escape closes and returns focus to the trigger that opened it.
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

test('grid edit commit and rejection announce through one polite, value-free live region', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'idle', {
    timeout: 20_000,
  })
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('open-button').click()
  await (await chooserPromise).setFiles(FIXTURE)
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'ready', {
    timeout: 20_000,
  })
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')

  const live = page.getByTestId('edit-live-region')
  await expect(live).toHaveAttribute('aria-live', 'polite')

  // Commit path: a cell edit lands and the region announces it.
  // uxc-1: wait for the row's window data before focusing — a row is rendered
  // as a placeholder before its fetch lands, and an editor cannot open on a
  // not-yet-ready slot. Without this the test raced the initial fetch under
  // load and timed out waiting for `grid-editor-input`.
  await waitForReadyRow(page, 0)
  await cell(page, 0, 2).focus()
  await page.keyboard.press('Enter')
  const editor = page.getByTestId('grid-editor-input')
  await editor.press('Control+a')
  await page.keyboard.type('60000')
  await editor.press('Enter')
  await expect(cell(page, 0, 2)).toHaveText('60000')
  await expect(live).toHaveText('Edit committed.')

  // Reject path: a non-numeric draft keeps the editor open and announces the
  // value-free reason. The typed draft must never appear in the region.
  await waitForReadyRow(page, 1)
  await cell(page, 1, 2).focus()
  await page.keyboard.press('Enter')
  const rejected = page.getByTestId('grid-editor-input')
  await rejected.fill('not-a-number')
  await rejected.press('Enter')
  await expect(page.getByTestId('grid-edit-error')).toHaveText('That is not a number.')
  await expect(live).toHaveText('That is not a number.')
  await expect(live).not.toContainText('not-a-number')
})

test('ready grid shows the editing hint as its description, and a Keyboard shortcut list', async ({
  page,
}) => {
  // ug-4 (UG-9/UG-33): the interaction language is on screen, not comment-only.
  await page.goto('/')
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'idle', {
    timeout: 20_000,
  })
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('open-button').click()
  await (await chooserPromise).setFiles(FIXTURE)
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'ready', {
    timeout: 20_000,
  })
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')

  // First ready paint: the hint is visible text (not screen-reader-only) and
  // byte-exact (U+00B7 separators, single spaces).
  const hint = page.getByTestId('grid-edit-hint')
  await expect(hint).toBeVisible()
  await expect(hint).toHaveText(
    'Double-click a cell to edit · Enter edits the focused cell · Esc cancels',
  )

  // The role=grid element is described by exactly that hint, and the hint
  // lives outside the grid subtree (grid-owned children stay rowgroups).
  const grid = page.getByTestId('grid-viewport')
  await expect(grid).toHaveAttribute('role', 'grid')
  const describedBy = await grid.getAttribute('aria-describedby')
  expect(describedBy).not.toBeNull()
  expect(describedBy).toBe(await hint.getAttribute('id'))
  const resolved = await grid.evaluate((element, id) => {
    const description = document.getElementById(id)
    return {
      text: description?.textContent ?? null,
      insideGrid: description === null ? null : element.contains(description),
    }
  }, describedBy as string)
  expect(resolved.text).toBe(
    'Double-click a cell to edit · Enter edits the focused cell · Esc cancels',
  )
  expect(resolved.insideGrid).toBe(false)

  // The footer's Keyboard disclosure is collapsed by default and is opened
  // through the keyboard itself (native <details>), then reveals the pinned
  // edit / inspect / navigate list.
  const help = page.getByTestId('grid-keyboard-help')
  await expect(help.locator('summary')).toHaveText('Keyboard')
  await expect(help).not.toHaveAttribute('open', '')
  await help.locator('summary').focus()
  await page.keyboard.press('Enter')
  await expect(help).toHaveAttribute('open', '')

  await expect(help.locator('dt')).toHaveText([
    'Double-click a cell',
    'Enter on a focused cell',
    'Esc',
    'Enter on a focused row',
    '↑ ↓ ← →',
    'Home / End',
    'Ctrl+Home / Ctrl+End',
    'Tab / Shift+Tab',
  ])
  await expect(help.locator('dd')).toHaveText([
    'Edit the cell — nested columns stay read-only.',
    'Open the inline editor.',
    'Cancel the open edit.',
    'Open it in the record inspector (no cell focused).',
    'Move between cells.',
    'Jump to the row’s first or last cell.',
    'Jump to the grid’s first or last cell (Cmd on macOS).',
    'Enter or leave the grid.',
  ])

  // No layout regression: the grid body still paints below its header and the
  // rows remain usable after the new footer text.
  await expect(page.locator('[data-testid="grid-row"][data-status="ready"]')).toHaveCount(5)
  await waitForReadyRow(page, 0)
  await expect(row(page, 0)).toBeVisible()
})

test('grid roving tabindex: Tab enters/leaves at the row, arrows reach cells, one tab stop', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'idle', {
    timeout: 20_000,
  })
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('open-button').click()
  await (await chooserPromise).setFiles(FIXTURE)
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'ready', {
    timeout: 20_000,
  })
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')

  // The last header control is the tab stop immediately before the roving
  // grid row; Tab enters the grid at the remembered row and Shift+Tab leaves
  // it again from that same row.
  const headerControls = page.locator('.grid-header-row button')
  await headerControls.last().focus()
  await page.keyboard.press('Tab')
  await expect(row(page, 0)).toBeFocused()
  await expect(page.locator('[data-testid="grid-row"][tabindex="0"]')).toHaveCount(1)
  await page.keyboard.press('Shift+Tab')
  await expect(headerControls.last()).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(row(page, 0)).toBeFocused()

  // ArrowRight reaches the focused row's cells; the row stays the single tab
  // stop (cells are tabindex=-1).
  await page.keyboard.press('ArrowRight')
  await expect(cell(page, 0, 0)).toBeFocused()
  await expect(page.locator('[data-testid="grid-row"][tabindex="0"]')).toHaveCount(1)
  await page.keyboard.press('ArrowRight')
  await expect(cell(page, 0, 1)).toBeFocused()

  // ArrowDown carries the focused column to the next row.
  await page.keyboard.press('ArrowDown')
  await expect(cell(page, 1, 1)).toBeFocused()
  await expect(page.locator('[data-testid="grid-row"][tabindex="0"]')).toHaveCount(1)

  // Home/End jump to the row's first/last cell; Ctrl+Home/Ctrl+End reach the
  // grid corners.
  await page.keyboard.press('Home')
  await expect(cell(page, 1, 0)).toBeFocused()
  await page.keyboard.press('End')
  await expect(cell(page, 1, 3)).toBeFocused()
  await page.keyboard.press('Control+Home')
  await expect(cell(page, 0, 0)).toBeFocused()
  await page.keyboard.press('Control+End')
  await expect(cell(page, 4, 3)).toBeFocused()
})

test('keyboard-only journey: open → edit → export', async ({ page }) => {
  test.setTimeout(120_000)

  // Open by keyboard through the real picker path.
  await page.goto('/')
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'idle', {
    timeout: 20_000,
  })
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('open-button').focus()
  await page.keyboard.press('Enter')
  await (await chooserPromise).setFiles(FIXTURE)
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'ready', {
    timeout: 20_000,
  })
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')
  await openSection(page, 'export')

  // Edit by keyboard: focus a cell, Enter opens the editor, select-all + type
  // + Enter commits. No pointer event in the whole journey.
  // uxc-1: the row must be data-ready first (see the live-region test above).
  await waitForReadyRow(page, 0)
  await cell(page, 0, 2).focus()
  await page.keyboard.press('Enter')
  const editor = page.getByTestId('grid-editor-input')
  await editor.press('Control+a')
  await page.keyboard.type('60000')
  await editor.press('Enter')
  await expect(cell(page, 0, 2)).toHaveText('60000')
  await expect(page.getByTestId('edit-live-region')).toHaveText('Edit committed.')

  // Export by keyboard: Enter opens the dialog, ArrowDown picks CSV, Tab
  // reaches the confirm button, Enter exports, Escape closes.
  await page.getByTestId('export-open').focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByTestId('export-dialog')
  await expect(dialog).toBeVisible()
  await expect(page.getByTestId('export-format-parquet')).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByTestId('export-format-csv')).toBeChecked()
  await page.keyboard.press('Tab')
  await expect(page.getByTestId('export-confirm')).toBeFocused()
  const downloadPromise = page.waitForEvent('download')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('export-result')).toContainText('Exported 5 rows as CSV')
  await downloadPromise
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('export-open')).toBeFocused()
})
