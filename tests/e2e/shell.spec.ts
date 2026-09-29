import path from 'node:path'
import { expect, test } from '@playwright/test'
import { openFixture } from './support/fixtures'

// ux-6 — workbench shell slice 1 (spec docs/product/05-workbench-shell.md §3).
// This journey pins the parts of the slice-1 acceptance list that are
// browser-layout facts rather than component structure:
//
//   1. every top-level section is a collapsible disclosure (`aria-expanded`);
//   2. a sticky section nav lists the sections in DOM order and is
//      keyboard-operable (plain anchors, no focus trap);
//   3. anchored sections are not obscured by the pinned nav (`scroll-margin`);
//   4. the grid renders immediately after the Schema section and stays
//      MOUNTED when its section is collapsed (rendering position only).
//
// Assertions stay on stable testids/ARIA; no dataset values are read or
// logged (ADR 0025).

const CUSTOMERS = path.join(process.cwd(), 'fixtures', 'parquet', 'customers.parquet')

const SECTION_ORDER = [
  'schema',
  'grid',
  'editing',
  'export',
  'history',
  'validation',
  'compare',
  'filters',
  'record',
  'sql',
  'profile',
] as const

test.beforeEach(async ({ page }) => {
  // Hidden-<input type="file"> fallback (m1-5 pattern): Playwright's
  // filechooser event reaches the input, not window.showOpenFilePicker.
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
    } catch {
      // Non-configurable global would be a Chromium change; fail loudly later.
    }
  })
})

test('slice-1 shell: sticky nav, collapsible sections, hoisted mounted grid', async ({ page }) => {
  await openFixture(page, CUSTOMERS, { assertFileNameHidden: true })
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')

  const nav = page.getByTestId('section-nav')
  await expect(nav).toBeVisible()
  // Sticky positioning is the mechanism that keeps the nav in reach.
  expect(await nav.evaluate((element) => getComputedStyle(element).position)).toBe('sticky')

  // Nav order === section DOM order, both pinned to the slice-1 order.
  await expect(nav.locator('a')).toHaveText([
    'Schema',
    'Grid',
    'Editing',
    'Export',
    'History',
    'Validation',
    'Compare',
    'Filters',
    'Record',
    'SQL',
    'Profile',
  ])
  await expect(page.locator('.workbench-section')).toHaveCount(SECTION_ORDER.length)
  const rendered = await page
    .locator('.workbench-section')
    .evaluateAll((sections) => sections.map((section) => section.getAttribute('data-section')))
  expect(rendered).toEqual([...SECTION_ORDER])

  // Each managed section exposes one shared aria-expanded toggle; the
  // inner-disclosure sections keep their own and get no second toggle.
  for (const id of [
    'grid',
    'editing',
    'export',
    'history',
    'validation',
    'compare',
    'record',
    'sql',
  ]) {
    await expect(page.getByTestId(`section-toggle-${id}`)).toHaveAttribute('aria-expanded', 'true')
  }
  await expect(page.getByTestId('section-toggle-schema')).toHaveCount(0)
  await expect(page.getByTestId('schema-toggle')).toHaveAttribute('aria-expanded', 'true')

  // Anchors are keyboard-operable in order (native links, no focus trap).
  const firstLink = page.getByTestId('section-nav-schema')
  await firstLink.focus()
  await expect(firstLink).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByTestId('section-nav-grid')).toBeFocused()

  // Anchoring does not hide the target under the pinned nav.
  await page.getByTestId('section-nav-profile').click()
  await expect(page.getByTestId('profile-section')).toBeInViewport()
  const navBox = await nav.boundingBox()
  const targetBox = await page.getByTestId('profile-section').boundingBox()
  if (navBox === null || targetBox === null) throw new Error('missing bounding box')
  expect(targetBox.y).toBeGreaterThanOrEqual(navBox.y + navBox.height - 2)
  // And every section carries the scroll-margin that makes that true.
  expect(
    await page.locator('#section-grid').evaluate((el) => getComputedStyle(el).scrollMarginTop),
  ).not.toBe('0px')

  // Collapse the grid: it leaves the accessibility tree but stays MOUNTED —
  // the same grid, so fetch/virtualization/data-flow are unchanged.
  const gridToggle = page.getByTestId('section-toggle-grid')
  await gridToggle.click()
  await expect(gridToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByTestId('grid')).toBeHidden()
  await expect(page.getByTestId('grid')).toHaveCount(1)
  // Re-expand: the mounted grid is intact and still shows the same table.
  await gridToggle.click()
  await expect(gridToggle).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByTestId('grid')).toBeVisible()
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')
  // The re-expanded mounted grid still renders its virtualized rows (no
  // zero-measure stall from the display:none window).
  await expect(page.locator('[data-testid="grid-row"]').first()).toBeVisible()

  // Collapsing keeps a visible name in the toggle row for every section
  // (uniform affordance). Pin the two that previously rendered a bare
  // chevron — Validation and Compare.
  for (const [id, name] of [
    ['validation', 'Validation'],
    ['compare', 'Compare'],
  ] as const) {
    const toggle = page.getByTestId(`section-toggle-${id}`)
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(toggle).toContainText(name)
  }
})
