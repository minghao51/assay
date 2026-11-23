// SPDX-License-Identifier: AGPL-3.0-or-later

import path from 'node:path'
import { expect, test } from './support/fixture'
import type { Locator, Page } from '@playwright/test'
import { waitForReadyRow } from './support/grid'
import { openFixture } from './support/fixtures'

/**
 * WF-07 (R-3) — the grid footer's visible row range, WFD-07 option A.
 *
 * The component pins live in `apps/web/src/grid/DataGrid.row-range.test.tsx`
 * (the state table, overscan exclusion, the all-fit `1–N` case and the
 * call-count pin). This leg adds the two facts only a real browser can give:
 *
 *   1. the footer still fits at the accepted 1024×700 desktop geometry
 *      (uxv-3) with the label in place — no CSS/geometry change, so the
 *      `shell-geometry.test.ts` source pins and the `shell.spec.ts` frame
 *      measurement stay the authority;
 *   2. X/Y in a real layout equal the rows whose data area actually
 *      intersects the scroll viewport, and the label never names an
 *      overscan-only row: the expected bounds are recomputed here from the
 *      rendered row boxes, independently of the implementation, at the top,
 *      the middle and the end of a 1000-row view.
 *
 * The label is static text: no live region, no announcement, no focus target.
 */

const CUSTOMERS = path.join(process.cwd(), 'fixtures', 'parquet', 'customers.parquet')
const WIDE = path.join(process.cwd(), 'fixtures', 'parquet', 'wide.parquet')

interface VisibleBounds {
  readonly start: number
  readonly end: number
  /** 1-based position of the LAST rendered row (overscan tail included). */
  readonly renderedEnd: number
  readonly renderedCount: number
}

/** Recompute the visible bounds from the real row boxes, independently. */
async function measureVisibleBounds(page: Page): Promise<VisibleBounds> {
  return page.getByTestId('grid-viewport').evaluate((container) => {
    const viewport = container.getBoundingClientRect()
    const header = container.querySelector('.grid-header')?.getBoundingClientRect()
    const visibleTop =
      header !== undefined && header !== null && header.bottom > viewport.top
        ? header.bottom
        : viewport.top
    const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-testid="grid-row"]'))
    const indices = rows.map((element) => Number(element.dataset['rowIndex']))
    const visible = rows
      .filter((element) => {
        const box = element.getBoundingClientRect()
        return box.bottom > visibleTop && box.top < viewport.bottom
      })
      .map((element) => Number(element.dataset['rowIndex']))
    if (visible.length === 0) throw new Error('no visible rows in the grid viewport')
    return {
      start: Math.min(...visible) + 1,
      end: Math.max(...visible) + 1,
      renderedEnd: Math.max(...indices) + 1,
      renderedCount: rows.length,
    }
  })
}

function rowRange(page: Page): Locator {
  return page.getByTestId('grid-row-range')
}

test.beforeEach(async ({ page }) => {
  // Hidden-<input type="file"> fallback: Playwright reaches the input, not
  // window.showOpenFilePicker (the m1-5 pattern every open journey uses).
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
    } catch {
      // Non-configurable global would be a Chromium change; fail loudly later.
    }
  })
})

test('WF-07: an all-fit view reads 1–N and the footer still fits at 1024×700', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 700 })
  await openFixture(page, CUSTOMERS, { expandSections: false, assertFileNameHidden: true })
  await waitForReadyRow(page, 0)

  await expect(rowRange(page)).toHaveText('Visible rows 1–5 of 5')
  // Static text only: no live region and no focus target on the label.
  await expect(rowRange(page)).not.toHaveAttribute('aria-live', /.*/)
  await expect(rowRange(page)).not.toHaveAttribute('role', /.*/)

  // uxv-3's accepted frame: the normal footer (edit hint + Keyboard +
  // Diagnostics + the new range label) is wholly inside the 700px viewport.
  const footer = page.locator('.grid-footer')
  await expect(footer).toBeInViewport({ ratio: 1 })
  await expect(rowRange(page)).toBeInViewport({ ratio: 1 })
  const box = await footer.boundingBox()
  if (box === null) throw new Error('missing grid footer box')
  expect(
    box.y + box.height,
    `grid footer bottom: measured ${String(box.y + box.height)}px of a 700px viewport`,
  ).toBeLessThanOrEqual(700)
})

test('WF-07: X–Y match the real viewport intersection and never the overscan tail', async ({
  page,
}) => {
  await openFixture(page, WIDE, { expandSections: false, assertFileNameHidden: true })
  await waitForReadyRow(page, 0)

  const viewport = page.getByTestId('grid-viewport')
  const scrollTo = async (fraction: number): Promise<void> => {
    await viewport.evaluate((element, at) => {
      element.scrollTop = (element.scrollHeight - element.clientHeight) * at
    }, fraction)
  }
  const assertMatches = async (): Promise<VisibleBounds> => {
    const bounds = await measureVisibleBounds(page)
    await expect(rowRange(page)).toHaveText(
      `Visible rows ${String(bounds.start)}–${String(bounds.end)} of 1000`,
    )
    return bounds
  }

  // Top of the view.
  const top = await assertMatches()
  expect(top.start).toBe(1)
  // The rendered window ends past the visible end (the overscan tail exists),
  // so the label must name the last VISIBLE row, never the last RENDERED one.
  expect(top.end).toBeLessThan(top.renderedEnd)
  expect(top.renderedCount).toBeGreaterThan(top.end - top.start + 1)

  // Middle of the view: the scroll-driven virtualizer re-render updates the
  // label through the same main-thread pass that paints the rows.
  await scrollTo(0.5)
  await expect
    .poll(async () => (await measureVisibleBounds(page)).start)
    .toBeGreaterThan(1)
  const middle = await assertMatches()
  expect(middle.end).toBeLessThan(middle.renderedEnd)
  expect(middle.end).toBeLessThan(1000)

  // End of the view: the end clamps to the known total (position 1000).
  await scrollTo(1)
  await expect.poll(async () => (await measureVisibleBounds(page)).end).toBe(1000)
  const end = await assertMatches()
  expect(end.end).toBe(1000)
  expect(end.renderedEnd).toBe(1000)
})
