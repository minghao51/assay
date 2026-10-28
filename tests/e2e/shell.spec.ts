import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { row, waitForReadyRow } from './support/grid'
import {
  RECORD_CLOSED_HINT,
  SECTION_PURPOSES,
  expandAllSections,
  openFixture,
} from './support/fixtures'

// q-15 — workbench shell slice 2, the ≥1024px grid-centric two-pane shell
// (spec docs/product/05-workbench-shell.md §3; ADR 0044). This journey pins
// the browser-layout facts the component suite cannot:
//
//   1. At ≥1024px the tool pane (left, sticky, own scroll) and the center
//      column (right: grid + docked record inspector) are side by side; the
//      grid never unmounts or reorders when tools are used.
//   2. First paint expands exactly one tool section (Schema); the managed tool
//      sections are collapsed and expansion is non-exclusive.
//   3. The pane collapses to a rail without moving the center column.
//   4. Below 1024px the SAME DOM renders as the slice-1 single-column stack
//      (schema → grid → the tool sections), scroll-never-clip.
//   5. The complete heading map holds in BOTH layouts (open state).
//
// Assertions stay on stable testids/ARIA; no dataset values are read or
// logged (ADR 0025).

const CUSTOMERS = path.join(process.cwd(), 'fixtures', 'parquet', 'customers.parquet')

/** Sticky-nav reading order (slice-1 order, grid promoted). */
const NAV_ORDER = [
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
  'pipeline',
] as const

/** Two-pane DOM order: tool pane first (tools-left), then the center column. */
const DOM_ORDER = [
  'schema',
  'editing',
  'export',
  'history',
  'validation',
  'compare',
  'filters',
  'sql',
  'profile',
  'pipeline',
  'grid',
  'record',
] as const

/** The complete h2 map in open state (record open), in two-pane DOM order. */
const HEADING_MAP = [
  'Schema',
  'Editing',
  'Export',
  'History',
  'Validation',
  'Compare',
  'Filters',
  'SQL',
  'Profile',
  'Pipeline',
  'Grid',
  'Record',
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

/** Open a dataset without the test-only expand-all step (pin the real default). */
async function openDefault(page: Page): Promise<void> {
  await openFixture(page, CUSTOMERS, { assertFileNameHidden: true, expandSections: false })
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')
}

/** Open a record through the real row-click gesture (record dock). */
async function openRecord(page: Page): Promise<void> {
  await waitForReadyRow(page, 0)
  await row(page, 0).click()
  await expect(page.getByTestId('record-inspector')).toBeVisible()
}

test('two-pane shell at ≥1024px: tools left, persistent grid center, rail', async ({ page }) => {
  await openDefault(page)

  // Two-pane structure: the tool pane and the center column are real boxes.
  await expect(page.locator('.workbench-tools')).toBeVisible()
  await expect(page.locator('.workbench-center')).toBeVisible()
  const toolsBox = await page.locator('.workbench-tools').boundingBox()
  const gridBox = await page.locator('#section-grid').boundingBox()
  if (toolsBox === null || gridBox === null) throw new Error('missing bounding box')
  // Grid is to the right of the tool pane (tools-left, ADR 0044).
  expect(gridBox.x).toBeGreaterThan(toolsBox.x + toolsBox.width - 1)
  // Sticky pane so tools stay reachable while the center scrolls.
  expect(
    await page
      .locator('.workbench-tools')
      .evaluate((element) => getComputedStyle(element).position),
  ).toBe('sticky')

  // Sticky in-pane nav, reading order, resolving anchors.
  const nav = page.getByTestId('section-nav')
  await expect(nav).toBeVisible()
  expect(await nav.evaluate((element) => getComputedStyle(element).position)).toBe('sticky')
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
    'Pipeline',
  ])
  for (const id of NAV_ORDER) {
    await expect(page.getByTestId(`section-nav-${id}`)).toHaveAttribute('href', `#section-${id}`)
  }

  // Anchoring does not hide the target under the pinned nav.
  await page.getByTestId('section-nav-profile').click()
  await expect(page.getByTestId('profile-section')).toBeInViewport()
  const navBox = await nav.boundingBox()
  const targetBox = await page.getByTestId('profile-section').boundingBox()
  if (navBox === null || targetBox === null) throw new Error('missing bounding box')
  expect(targetBox.y).toBeGreaterThanOrEqual(navBox.y + navBox.height - 2)
  expect(
    await page.locator('#section-grid').evaluate((el) => getComputedStyle(el).scrollMarginTop),
  ).not.toBe('0px')

  // One-section first paint: Schema open, every managed tool section
  // collapsed, grid (the persistent center) open.
  await expect(page.getByTestId('schema-toggle')).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByTestId('profile-toggle')).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByTestId('section-toggle-grid')).toHaveAttribute('aria-expanded', 'true')
  for (const id of ['editing', 'export', 'history', 'validation', 'compare', 'sql', 'pipeline']) {
    await expect(page.getByTestId(`section-toggle-${id}`)).toHaveAttribute('aria-expanded', 'false')
  }

  // Non-exclusive expansion: opening two sections keeps both open.
  await page.getByTestId('section-toggle-validation').click()
  await page.getByTestId('section-toggle-compare').click()
  await expect(page.getByTestId('section-toggle-validation')).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  await expect(page.getByTestId('section-toggle-compare')).toHaveAttribute('aria-expanded', 'true')

  // Grid persistent center: collapsing its section leaves it MOUNTED.
  const gridToggle = page.getByTestId('section-toggle-grid')
  await gridToggle.click()
  await expect(gridToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByTestId('grid')).toBeHidden()
  await expect(page.getByTestId('grid')).toHaveCount(1)
  await gridToggle.click()
  await expect(page.getByTestId('grid')).toBeVisible()
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')

  // Complete heading map (open state), including the docked Record heading.
  await expandAllSections(page)
  await openRecord(page)
  await expect(page.getByRole('heading', { level: 2 })).toHaveText([...HEADING_MAP])

  // Pane rail: the tool pane collapses to a rail; the center column stays put.
  const centerBefore = await page.locator('.workbench-center').boundingBox()
  await page.getByTestId('pane-toggle').click()
  await expect(page.getByTestId('pane-toggle')).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('#workbench-tools-body')).toBeHidden()
  await expect(page.getByTestId('grid')).toBeVisible()
  const centerAfter = await page.locator('.workbench-center').boundingBox()
  if (centerBefore === null || centerAfter === null) throw new Error('missing bounding box')
  // The center grows leftward but is never unmounted or reordered.
  expect(centerAfter.x).toBeLessThanOrEqual(centerBefore.x + 1)
})

test('below 1024px: the slice-1 single-column stack is preserved', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 })
  await openDefault(page)

  // The pane rail affordance is a ≥1024px control; the stack shows everything.
  await expect(page.locator('.workbench-pane-head')).toBeHidden()

  // Single column: nav + every section span the page, and the grid is
  // visually promoted right after the schema section (slice-1 order), with the
  // tool sections after it. The DOM is tools-then-center; CSS `order` is what
  // restores the stack, so this measures geometry, not DOM order.
  const yOf = async (id: string): Promise<number> => {
    const box = await page.locator(`#section-${id}`).boundingBox()
    if (box === null) throw new Error(`missing bounding box for ${id}`)
    return box.y
  }
  expect(await yOf('schema')).toBeLessThan(await yOf('grid'))
  expect(await yOf('grid')).toBeLessThan(await yOf('editing'))
  expect(await yOf('record')).toBeGreaterThan(await yOf('filters'))
  expect(await yOf('pipeline')).toBeGreaterThan(await yOf('profile'))

  // Scroll, never clip (ux-1).
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth)

  // Keyboard-reachable nav at the stack; anchoring reaches the last section.
  await page.getByTestId('section-nav-pipeline').focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('#section-pipeline')).toBeInViewport()

  // The complete h2 map holds in the stack too (same DOM order, open state).
  await expandAllSections(page)
  await openRecord(page)
  await expect(page.getByRole('heading', { level: 2 })).toHaveText([...HEADING_MAP])
})

test('every section renders in the two-pane DOM order with matching anchors', async ({ page }) => {
  await openDefault(page)
  const rendered = await page
    .locator('.workbench-section')
    .evaluateAll((sections) => sections.map((section) => section.getAttribute('data-section')))
  expect(rendered).toEqual([...DOM_ORDER])
})

// ug-13 / R-14 (a): the purpose subtitle is visible on a COLLAPSED section
// immediately after open, with no expansion gesture. Managed sections keep
// their `Expand <Title>` accessible name (the subtitle is a description).
test('collapsed sections show their purpose subtitle right after open (no expansion)', async ({
  page,
}) => {
  await openDefault(page)

  const validationToggle = page.getByTestId('section-toggle-validation')
  await expect(validationToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByTestId('section-purpose-validation')).toBeVisible()
  await expect(page.getByTestId('section-purpose-validation')).toHaveText(
    SECTION_PURPOSES.validation,
  )
  // Name stays `Expand <Title>`; the subtitle is exposed as the description.
  await expect(page.getByRole('button', { name: 'Expand Validation' })).toBeVisible()
  await expect(validationToggle).toHaveAttribute('aria-describedby', 'section-validation-purpose')

  // All twelve subtitles are present post-open without any user expansion.
  for (const [id, copy] of Object.entries(SECTION_PURPOSES)) {
    await expect(page.getByTestId(`section-purpose-${id}`)).toHaveText(copy)
  }
})

// ug-13 / R-14 (b): the Record dock is not a dead end — its value-free
// closed-state hint is visible before any row is selected, then disappears
// once the real row gesture opens the inspector (no duplicate guidance).
test('record dock shows the closed-state hint until a row is selected', async ({ page }) => {
  await openDefault(page)

  const hint = page.getByTestId('record-hint')
  await expect(hint).toBeVisible()
  await expect(hint).toHaveText(RECORD_CLOSED_HINT)
  await expect(page.getByTestId('record-inspector')).toHaveCount(0)

  await waitForReadyRow(page, 0)
  await row(page, 0).click()
  await expect(page.getByTestId('record-inspector')).toBeVisible()
  await expect(hint).toHaveCount(0)
})
