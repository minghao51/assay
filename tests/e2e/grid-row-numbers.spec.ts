import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { openCustomersFixture } from './support/fixtures'
import { row } from './support/grid'

// ug-11 (UG-12) — row identity made visible, end to end against the committed
// synthetic `fixtures/parquet/customers.parquet` (5 rows):
//
//   (a) the sticky gutter numbers rows 1-based, in the header AND every body
//       row, and the record dock's title uses the SAME number;
//   (b) the dock's ▶ Next / ◀ Prev step to the adjacent row without closing
//       the dock, and the control is disabled at the dataset bounds.
//
// The grid's `data-row-index` stays the 0-based effective index (the jump /
// scroll contract); the user-facing number is index + 1 everywhere. ug-12's
// `base #N` logical-ordinal announcements are a different identity and are
// pinned in their own specs.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
    } catch {
      // Non-configurable global would be a Chromium change; fail loudly later.
    }
  })
})

/** The gutter cell of one rendered row. */
function gutter(page: Page, rowIndex: number): Locator {
  return row(page, rowIndex).getByTestId('grid-row-number')
}

/** The record dock's visible title number. */
function dockNumber(page: Page): Locator {
  return page.getByTestId('record-title-row')
}

test('the gutter numbers rendered rows 1-based and the dock title agrees', async ({ page }) => {
  await openCustomersFixture(page)

  // The header leads with the row-number columnheader (visible `#`).
  const header = page.getByTestId('grid-row-number-header')
  await expect(header).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Row number' })).toBeVisible()
  const headerBox = await header.boundingBox()
  const firstColumnBox = await page
    .locator('[data-testid="grid-header-cell"]')
    .first()
    .boundingBox()
  if (headerBox === null || firstColumnBox === null) throw new Error('missing bounding box')
  expect(headerBox.x).toBeLessThan(firstColumnBox.x)

  // Every rendered row carries the 1-based number as its leading rowheader.
  const gutters = page.getByTestId('grid-row-number')
  await expect(gutters).toHaveCount(5)
  await expect(gutters).toHaveText(['1', '2', '3', '4', '5'])
  await expect(page.getByRole('rowheader')).toHaveCount(5)

  // …on an OPAQUE, striped background: the gutter paints over the cells that
  // scroll underneath it, so it must never be transparent, and it must keep
  // the row alternation (odd/even surfaces) it is covering.
  const backgrounds = await gutters.evaluateAll((elements) =>
    elements.map((element) => getComputedStyle(element).backgroundColor),
  )
  expect(new Set(backgrounds).size).toBe(2)
  for (const background of backgrounds) expect(background).not.toBe('rgba(0, 0, 0, 0)')

  // Open row 2 (index 1): the dock's title is the SAME number the gutter shows.
  await row(page, 1).click()
  const panel = page.getByTestId('record-inspector')
  await expect(panel).toBeVisible()
  await expect(panel).toHaveAttribute('data-row-index', '1')
  await expect(dockNumber(page)).toHaveText('2')
  await expect(gutter(page, 1)).toHaveText('2')
  await expect(page.getByRole('region', { name: 'Record inspector — row 2' })).toBeVisible()
})

test('Next steps to the adjacent row in the same dock; Prev returns; bounds disable', async ({
  page,
}) => {
  await openCustomersFixture(page)

  // Row 1 (index 0) is where the stepping walk starts.
  await row(page, 0).click()
  const panel = page.getByTestId('record-inspector')
  await expect(panel).toBeVisible()
  await expect(dockNumber(page)).toHaveText('1')
  await expect(page.getByTestId('record-prev')).toBeDisabled()
  await expect(page.getByTestId('record-next')).toBeEnabled()

  // ▶ Next: row 2 opens in the SAME dock — title/gutter agree, no close.
  await page.getByTestId('record-next').click()
  await expect(panel).toHaveAttribute('data-row-index', '1')
  await expect(dockNumber(page)).toHaveText('2')
  await expect(gutter(page, 1)).toHaveText('2')
  // The dock never closed for the step: the closed-state hint never appears
  // and there is still exactly one inspector.
  await expect(page.getByTestId('record-hint')).toHaveCount(0)
  await expect(page.getByTestId('record-inspector')).toHaveCount(1)
  // The grid moved to the same row through the existing jump path (roving
  // focus lands on it), so a step is visible and keyboard-continuable.
  await expect(row(page, 1)).toBeFocused()

  // ◀ Prev returns to row 1.
  await page.getByTestId('record-prev').click()
  await expect(panel).toHaveAttribute('data-row-index', '0')
  await expect(dockNumber(page)).toHaveText('1')
  await expect(page.getByTestId('record-prev')).toBeDisabled()

  // Bounds: the last row has no Next.
  await row(page, 4).click()
  await expect(panel).toHaveAttribute('data-row-index', '4')
  await expect(dockNumber(page)).toHaveText('5')
  await expect(page.getByTestId('record-next')).toBeDisabled()
  await expect(page.getByTestId('record-prev')).toBeEnabled()
})
