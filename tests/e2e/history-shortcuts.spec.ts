import path from 'node:path'
import { expect, test } from './support/fixture'
import type { Page } from '@playwright/test'
import { activateTask, openFixture } from './support/fixtures'
import { cell, openEditor, waitForReadyRow } from './support/grid'

/**
 * ug-6 (UG-10) end-to-end pin: document-level Undo/Redo shortcuts plus the
 * first-append History cue, over the real composition root and the real
 * DuckDB-WASM engine on the committed `customers.parquet` golden fixture
 * (row 0, `income` = 52000).
 *
 * The fixture opens with `expandSections: false` so this leg sees the REAL
 * first paint (only Schema expanded, History collapsed) — the cue, not the
 * legacy shared helper, is what has to open History.
 *
 * Three legs:
 *
 * 1. the FIRST committed edit auto-expands the History section (the 0 → >0
 *    cue through the existing disclosure seam) and the logged op is reflected
 *    there;
 * 2. `Control+Z` reverts the edit, `Control+Shift+Z` re-applies it, and
 *    `Control+Y` is the equivalent redo path;
 * 3. the shortcut adds NO visible control: exactly the existing
 *    `history-undo` / `history-redo` pair exists (ux-3 ruling), and pressing
 *    `Control+Z` inside the open cell editor keeps the browser's native text
 *    undo — the staged history never moves while an editor (or any other
 *    editing surface) owns the key.
 *
 * Privacy (ADR 0025): assertions read the user's own local grid/history text
 * only; nothing is copied, announced or telemetered.
 */

const CUSTOMERS_FIXTURE = path.join(process.cwd(), 'fixtures', 'parquet', 'customers.parquet')

test.beforeEach(async ({ page }) => {
  // Take the hidden-`<input type="file">` fallback (m1-5 pattern), like the
  // other fixture-opening grid specs.
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
    } catch {
      // Non-configurable global would be a Chromium change; fail loudly later.
    }
  })
})

/** Commit one cell edit through the inline editor (double-click, type, Enter). */
async function editCell(page: Page, value: string): Promise<void> {
  await openEditor(page, 0, 2)
  const editor = page.getByTestId('grid-editor-input')
  await editor.fill(value)
  await editor.press('Enter')
  await expect(page.getByTestId('grid-cell-editor')).toHaveCount(0)
}

test('history auto-expands on the first edit and Undo/Redo shortcuts drive it', async ({
  page,
}) => {
  test.setTimeout(180_000)
  await openFixture(page, CUSTOMERS_FIXTURE, {
    assertFileNameHidden: true,
    expandSections: false,
  })
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')
  await waitForReadyRow(page, 0)

  // rd-3b: History is a Change section, so at ≥1024px it is exposed only while
  // Change is the active task. Choosing a task opens its manageable sections,
  // so the COLLAPSED precondition the cue must satisfy is restored explicitly;
  // a user collapse does not spend the one-shot cue (only the first appended
  // op does), so the cue below is still the only thing that can re-open it.
  await activateTask(page, 'change')
  const toggle = page.getByTestId('section-toggle-history')
  const body = page.locator('#section-history-content')
  if ((await toggle.getAttribute('aria-expanded')) === 'true') {
    await toggle.click()
  }
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(body).toBeHidden()
  await expect(page.getByTestId('history-item')).toHaveCount(0)

  // 1. First committed edit → History auto-expands (0 → >0) with the op logged.
  const income = cell(page, 0, 2)
  await expect(income).toHaveText('52000')
  await editCell(page, '99999')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await expect(body).toBeVisible()
  await expect(page.getByTestId('history-item')).toHaveCount(1)
  await expect(page.getByTestId('history-cursor')).toHaveText('Step 1 of 1 applied')
  await expect(income).toHaveText('99999')
  await expect(income).toHaveAttribute('data-dirty', 'true')

  // 2. Undo → redo → redo (the second convention), all from the keyboard.
  await page.keyboard.press('Control+Z')
  await expect(income).toHaveText('52000')
  await expect(income).toHaveAttribute('data-dirty', 'false')
  await expect(page.getByTestId('history-cursor')).toHaveText('Step 0 of 1 applied')

  await page.keyboard.press('Control+Shift+Z')
  await expect(income).toHaveText('99999')
  await expect(page.getByTestId('history-cursor')).toHaveText('Step 1 of 1 applied')

  await page.keyboard.press('Control+Z')
  await expect(income).toHaveText('52000')
  await page.keyboard.press('Control+Y')
  await expect(income).toHaveText('99999')
  await expect(page.getByTestId('history-cursor')).toHaveText('Step 1 of 1 applied')

  // 3a. ux-3: the shortcut pair is still the ONE visible control pair.
  await expect(page.getByTestId('history-undo')).toHaveCount(1)
  await expect(page.getByTestId('history-redo')).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Undo' })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Redo' })).toHaveCount(1)

  // 3b. Native text undo wins inside the open cell editor: the key is not
  // intercepted, so the staged history does not move and the editor stays.
  await openEditor(page, 0, 2)
  await expect(page.getByTestId('grid-editor-input')).toHaveValue('99999')
  await page.getByTestId('grid-editor-input').press('Control+Z')
  await expect(page.getByTestId('grid-cell-editor')).toBeVisible()
  await expect(page.getByTestId('history-cursor')).toHaveText('Step 1 of 1 applied')
  await page.getByTestId('grid-editor-input').press('Escape')
  await expect(page.getByTestId('grid-cell-editor')).toHaveCount(0)
  await expect(income).toHaveText('99999')
})
