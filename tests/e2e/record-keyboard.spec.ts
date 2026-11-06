// SPDX-License-Identifier: AGPL-3.0-or-later

import path from 'node:path'
import { expect, test } from './support/fixture'
import type { Page } from '@playwright/test'
import { openFixture } from './support/fixtures'
import { row, waitForReadyRow } from './support/grid'

/**
 * ux-a3 — the record inspector's keyboard opening loop, on the BUILT output in
 * BOTH colour schemes.
 *
 * The recorded gap: activating a grid row with Enter opened the record
 * inspector but left DOM focus on the grid, so reaching the freshly opened
 * panel meant tabbing through the whole page again (18 Tab presses), and the
 * panel's own Escape handler could never fire. `RecordRequest.focusOnOpen` is
 * set only by explicit row activation (App's DataGrid `onOpenRecord`), so the
 * fresh panel takes focus once the requested record is honestly rendered, and
 * Escape closes it and hands focus back to the row.
 *
 * This spec pins the real browser loop for both explicit gestures — Enter on a
 * focused row (keyboard) and a row click (the same pointer affordance) — and
 * that the restored focus owner is the row, never `<body>`.
 *
 * Privacy (ADR 0025): the committed synthetic fixture only; nothing here reads
 * or asserts a cell value beyond the dock's own row number.
 */

const FIXTURE = path.join(process.cwd(), 'fixtures', 'parquet', 'customers.parquet')

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
    } catch {
      // Non-configurable global: the hidden-input fallback is then unavailable
      // and the test fails loudly at the chooser instead of silently skipping.
    }
  })
})

/** The DOM node that currently owns focus, or `null`. */
async function activeTag(page: Page): Promise<string | null> {
  return page.evaluate(() => document.activeElement?.tagName ?? null)
}

for (const scheme of ['light', 'dark'] as const) {
  test(`[${scheme}] Enter on a focused grid row moves focus into the inspector; Escape returns it to the row`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await openFixture(page, FIXTURE)

    await waitForReadyRow(page, 1)
    const target = row(page, 1)
    await target.focus()
    await expect(target).toBeFocused()

    // Keyboard activation only: the row is the grid's roving tab stop.
    await page.keyboard.press('Enter')

    const inspector = page.getByTestId('record-inspector')
    await expect(inspector).toBeVisible()
    await expect(inspector).toHaveAttribute('data-row-index', '1')
    await expect(page.getByTestId('record-title-row')).toHaveText('2')
    // The panel owns focus now — no walk from the grid back to the dock.
    await expect(inspector).toBeFocused()

    // The next Tab is an ordinary move INSIDE the non-modal panel: focus never
    // bounces out to the page while the inspector is the focus owner.
    await page.keyboard.press('Tab')
    expect(
      await page.evaluate(() => {
        const panel = document.querySelector('[data-testid="record-inspector"]')
        return panel !== null && panel.contains(document.activeElement)
      }),
      '[focus] Tab from the focused inspector must stay inside the panel',
    ).toBe(true)

    // Escape closes from inside the panel and restores the opening row.
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('record-inspector')).toHaveCount(0)
    await expect(target).toBeFocused()
    expect(await activeTag(page)).toBe('DIV')

    // The pointer affordance takes the same path (Enter and a row click are
    // one explicit row-activation gesture).
    await waitForReadyRow(page, 2)
    await row(page, 2).click()
    const pointerInspector = page.getByTestId('record-inspector')
    await expect(pointerInspector).toBeVisible()
    await expect(pointerInspector).toHaveAttribute('data-row-index', '2')
    await expect(pointerInspector).toBeFocused()

    await page.keyboard.press('Escape')
    await expect(page.getByTestId('record-inspector')).toHaveCount(0)
    // A pointer press focuses the CELL under the cursor, so the existing
    // focus-restore contract returns focus there — inside the row that opened
    // the dock, never to `<body>` and never to the removed panel.
    expect(
      await page.evaluate(() => {
        const active = document.activeElement
        const owning = active?.closest('[data-testid="grid-row"]') ?? null
        return owning?.getAttribute('data-row-index') ?? null
      }),
      '[focus] Escape must restore focus inside the row the pointer activated',
    ).toBe('2')
  })
}
