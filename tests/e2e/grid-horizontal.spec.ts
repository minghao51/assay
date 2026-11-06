import path from 'node:path'
import { expect, test } from './support/fixture'
import type { Locator, Page } from '@playwright/test'
import { cell, headerCell, openEditor, row } from './support/grid'
import { openFixture } from './support/fixtures'

// ux-1 regression (audit UX-1, P1): wide datasets must be horizontally
// reachable. Before the fix the grid sized columns `repeat(N, minmax(9rem,
// 1fr))` under `overflow-x: hidden` with the header as a sibling of the
// virtualized body, so everything past ~8-10 columns rendered clipped and
// unreachable — no scroll, no keyboard path, no editing path. The fix puts the
// header inside the scroll element (shared horizontal scroll context, header
// `position: sticky`) and gives header and body the same deterministic track
// floor (`calc(N * 9rem [+ 5rem])`) so neither regime clips and both stay
// aligned.
//
// The fixture is synthetic (fixtures/csv/wide.csv, 20 columns × 3 rows). The
// picker path is the usual hidden-`<input type="file">` fallback.

const WIDE_FIXTURE = path.join(process.cwd(), 'fixtures', 'csv', 'wide.csv')
const WIDE_COLUMNS = 20
const LAST_COLUMN = 'note'
const LAST_COLUMN_INDEX = WIDE_COLUMNS - 1

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
    } catch {
      // Non-configurable global would be a Chromium change; fail loudly later.
    }
  })
})

/** The element's box must sit fully inside the scroll container's visible box. */
async function expectWithinBox(element: Locator, container: Locator): Promise<void> {
  const box = await element.boundingBox()
  const containerBox = await container.boundingBox()
  if (box === null || containerBox === null) throw new Error('missing bounding box')
  expect(box.x).toBeGreaterThanOrEqual(containerBox.x - 1)
  expect(box.y).toBeGreaterThanOrEqual(containerBox.y - 1)
  expect(box.x + box.width).toBeLessThanOrEqual(containerBox.x + containerBox.width + 1)
  expect(box.y + box.height).toBeLessThanOrEqual(containerBox.y + containerBox.height + 1)
}

/**
 * uxc-5 (a) occlusion pin. `expectWithinBox` only checks a cell's border box
 * against the scroll viewport's box, so it stays green while the sticky header
 * paints over that box (row 0 under the header is still "within" the
 * viewport). Sample the point a user actually clicks — the cell's visual
 * center — through hit-testing and require it to resolve to the cell (or one
 * of its descendants), never to a header element. A body row whose track box
 * is shifted up under the pinned header fails here; the mutant drill sets
 * `scrollMargin` back to 0 in `DataGrid.tsx`.
 */
async function expectNotOccludedByHeader(target: Locator): Promise<void> {
  const hit = await target.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return {
      found: top !== null,
      inside: top === element || element.contains(top),
      inHeader:
        top instanceof Element &&
        top.closest('.grid-header, [data-testid="grid-header-cell"]') !== null,
      hitTestId: top instanceof HTMLElement ? (top.dataset.testid ?? null) : null,
      // `getAttribute` rather than `.className`: class is a plain string on
      // HTML elements but an `SVGAnimatedString` on SVG ones, and the message
      // below must never receive an object.
      hitClass: top instanceof Element ? top.getAttribute('class') : null,
    }
  })
  const label = hit.hitTestId ?? hit.hitClass ?? 'an unlabelled element'
  expect(
    hit.inside && !hit.inHeader,
    hit.found
      ? `cell center is occluded by ${label}`
      : 'cell center hit no element (cell is offscreen or not hit-testable)',
  ).toBe(true)
}

/** Pan the grid to the far right with real wheel gestures (never scripted). */
async function panToFarRight(page: Page): Promise<void> {
  const viewport = page.getByTestId('grid-viewport')
  await viewport.hover()
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(1000, 0)
  }
}

test('wide grid: last column is reachable by pan, keyboard, and edit', async ({ page }) => {
  await openFixture(page, WIDE_FIXTURE)
  await expect(page.getByTestId('grid-total-rows')).toHaveText('3')
  await expect(page.getByTestId('grid-header-cell')).toHaveCount(WIDE_COLUMNS)

  const viewport = page.getByTestId('grid-viewport')
  const lastHeader = headerCell(page, LAST_COLUMN)
  const lastCell = cell(page, 0, LAST_COLUMN_INDEX)
  await expect(lastCell).toHaveText('alpha')

  // ug-11 (UG-12): the row-number gutter is pinned to the left edge. Capture
  // its position BEFORE the pan; a horizontal pan must not move it, and its
  // number must still name the same row afterwards.
  const gutter = row(page, 0).getByTestId('grid-row-number')
  const headerGutter = page.getByTestId('grid-row-number-header')
  await expect(gutter).toHaveText('1')
  const gutterBefore = await gutter.boundingBox()
  const headerGutterBefore = await headerGutter.boundingBox()
  if (gutterBefore === null || headerGutterBefore === null) throw new Error('missing gutter box')
  expect(await gutter.evaluate((el) => getComputedStyle(el).position)).toBe('sticky')

  // (b) scroll reachability — a genuine horizontal wheel must move the shared
  // scroller, and the last header + last cell end up inside the visible box.
  await panToFarRight(page)
  const scrollLeft = await viewport.evaluate((el) => el.scrollLeft)
  expect(scrollLeft).toBeGreaterThan(0)

  // ug-11: the gutter did NOT pan with the cells — same x, same number, and
  // still the leftmost element of the visible grid (header included).
  const gutterAfter = await gutter.boundingBox()
  const headerGutterAfter = await headerGutter.boundingBox()
  const containerBox = await viewport.boundingBox()
  if (gutterAfter === null || headerGutterAfter === null || containerBox === null) {
    throw new Error('missing gutter box after pan')
  }
  expect(Math.abs(gutterAfter.x - gutterBefore.x)).toBeLessThanOrEqual(1)
  expect(Math.abs(headerGutterAfter.x - headerGutterBefore.x)).toBeLessThanOrEqual(1)
  // Pinned to the scroll container's left edge (border included in the box).
  expect(gutterAfter.x - containerBox.x).toBeLessThanOrEqual(3)
  expect(headerGutterAfter.x - containerBox.x).toBeLessThanOrEqual(3)
  await expect(gutter).toHaveText('1')
  // …and it paints over the cells scrolling underneath (opaque sticky cell).
  const gutterHit = await gutter.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    return top === element || element.contains(top)
  })
  expect(gutterHit).toBe(true)

  await expectWithinBox(lastHeader, viewport)
  await expectWithinBox(lastCell, viewport)

  // Shared-context + deterministic sizing: the header's last column and the
  // body's last column land on the same x coordinate (they must never be a
  // content-sized mismatch).
  const headerBox = await lastHeader.boundingBox()
  const cellBox = await lastCell.boundingBox()
  if (headerBox === null || cellBox === null) throw new Error('missing bounding box')
  expect(Math.abs(headerBox.x - cellBox.x)).toBeLessThanOrEqual(2)

  // (a) uxc-5 occlusion pin: after the pan, lastCell is row 0 — the row that
  // sits immediately below the sticky header, i.e. exactly the row a
  // scroll-offset regression pushes *under* the header. Containment above
  // would still pass; hit-testing must not.
  await expectNotOccludedByHeader(lastCell)

  // (b) keyboard reachability — from the first cell, End jumps to the last
  // column and the focus-reveal auto-scrolls it into view.
  await viewport.evaluate((el) => {
    el.scrollLeft = 0
  })
  await cell(page, 0, 0).focus()
  await page.keyboard.press('End')
  await expect(lastCell).toBeFocused()
  await expect.poll(() => viewport.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0)
  await expectWithinBox(lastCell, viewport)

  // (b) editing reachability — commit an edit in the last column.
  await openEditor(page, 0, LAST_COLUMN_INDEX)
  const editor = page.getByTestId('grid-editor-input')
  await editor.fill('delta')
  await editor.press('Enter')
  await expect(page.getByTestId('grid-cell-editor')).toHaveCount(0)
  await expect(lastCell).toHaveText('delta')
  await expect(lastCell).toHaveAttribute('data-dirty', 'true')
})

test('wide grid at 900px scrolls, never clips', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 })
  await openFixture(page, WIDE_FIXTURE)
  await expect(page.getByTestId('grid-header-cell')).toHaveCount(WIDE_COLUMNS)

  const viewport = page.getByTestId('grid-viewport')
  const { scrollWidth, clientWidth } = await viewport.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }))
  expect(scrollWidth).toBeGreaterThan(clientWidth)

  // A real wheel pans to the end; the last header is then fully visible.
  await panToFarRight(page)
  await expect.poll(() => viewport.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0)
  await expectWithinBox(headerCell(page, LAST_COLUMN), viewport)
  await expectWithinBox(cell(page, 0, LAST_COLUMN_INDEX), viewport)

  // (b) uxc-5 pin: opening any fixture starts an overlay session, so the
  // trailing row-actions track (`+ 5rem`) is present. The body row must carry
  // the deterministic track floor (`calc(20 * 9rem + 5rem)`): its own track box
  // has to cover the trailing action cell, not let the grid tracks overflow a
  // 100%-wide row. Losing the body-row `minWidth` leaves the action cell (and
  // the row chrome behind it) hanging outside the row — this assertion fails.
  await expect(page.getByTestId('grid-actions-header')).toBeVisible()
  const bodyRow = row(page, 0)
  const rowActions = bodyRow.getByTestId('grid-row-actions')
  await expect(rowActions).toBeVisible()
  const rowBox = await bodyRow.boundingBox()
  const actionsBox = await rowActions.boundingBox()
  if (rowBox === null || actionsBox === null) throw new Error('missing bounding box')
  expect(rowBox.x).toBeLessThanOrEqual(actionsBox.x + 1)
  expect(rowBox.x + rowBox.width).toBeGreaterThanOrEqual(actionsBox.x + actionsBox.width - 1)
})
