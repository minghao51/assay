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
//   6. uxv-3 / R-11 (spec §4 "Geometry"): the four-sample matrix (16/24px
//      gutters, fluid main, 320/360px pane, 16px gap, fluid grid column),
//      the ≤140px ready-workspace top budget, the clamped grid viewport
//      height and the 1024×700 first-paint acceptance — all real-browser box
//      measurements on the normal, no-disclosure ready frame.
//
// Assertions stay on stable testids/ARIA; no dataset values are read or
// logged (ADR 0025).

const CUSTOMERS = path.join(process.cwd(), 'fixtures', 'parquet', 'customers.parquet')

/**
 * Sticky-nav reading order — ug-22 (2026-11-02): schema, filters, grid,
 * validation, compare, sql, editing, history, export, record, profile, pipeline.
 * ADR 0044 / D14 + the q-15 placement ruling authorize the NAV order only; the
 * two-pane DOM order below (`DOM_ORDER`) is unchanged.
 */
const NAV_ORDER = [
  'schema',
  'filters',
  'sql',
  'profile',
  'validation',
  'compare',
  'editing',
  'history',
  'export',
  'pipeline',
  'grid',
  'record',
] as const

/** Two-pane DOM order: tool pane first (tools-left), then the center column. */
const DOM_ORDER = [
  'schema',
  'editing',
  'history',
  'export',
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
  'History',
  'Export',
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
    'Filters',
    'SQL',
    'Profile',
    'Validation',
    'Compare',
    'Editing',
    'History',
    'Export',
    'Pipeline',
    'Grid',
    'Record',
  ])
  // q-15 placement ruling: pipeline stays the last TOOL section; the
  // Grid/Record workspace anchors follow it.
  await expect(nav.locator('a').nth(9)).toHaveText('Pipeline')
  await expect(nav.locator('a').last()).toHaveText('Record')
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
  //
  // CO-3 (ug-23): the rail control names its ACTION and tracks `aria-expanded`;
  // it never reuses the in-pane nav's "Workbench sections" (one accessible name
  // over a button and a navigation could not be told apart).
  await expect(page.getByRole('navigation', { name: 'Workbench sections' })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Collapse workbench pane' })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Workbench sections' })).toHaveCount(0)
  const centerBefore = await page.locator('.workbench-center').boundingBox()
  await page.getByTestId('pane-toggle').click()
  await expect(page.getByTestId('pane-toggle')).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByTestId('pane-toggle')).toHaveAccessibleName('Expand workbench pane')
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

/* ---- uxv-3 / R-11: the spec §4 desktop geometry matrix ---------------------
 *
 * Real-browser box measurements at the four matrix samples, the ready-workspace
 * top budget, the bounded grid viewport height and the 1024×700 first-paint
 * acceptance. Everything below is a deterministic geometry read (bounding
 * boxes and `getComputedStyle`) on the committed 5-row fixture in the normal,
 * no-disclosure ready state — no screenshots, no pixel baselines, no dataset
 * values. Allowed tolerance is the spec's ±2px box-measurement window.
 */

/** Spec §4 geometry tolerance for box measurement. */
const GEOMETRY_TOLERANCE_PX = 2

/** Ready-workspace top budget (spec §4). */
const READY_TOP_BUDGET_PX = 140

/** One desktop matrix row from spec §4. */
interface DesktopSample {
  readonly label: string
  readonly width: number
  readonly height: number
  readonly gutters: number
  readonly mainWidth: number
  readonly paneWidth: number
  readonly gridColumnWidth: number
  readonly gridViewportHeight: number
}

/**
 * The three desktop samples. Gutter step 16 → 24 at 1440px; pane step
 * 320 → 360 at 1200px; 16px gap; grid column = main − pane − gap. The grid
 * viewport height is `clamp(280px, calc(100dvh − 360px), 640px)` (see the
 * `.grid-viewport` rule: the reserve includes the dataset context bar).
 */
const DESKTOP_SAMPLES: readonly DesktopSample[] = [
  {
    label: '1024×700',
    width: 1024,
    height: 700,
    gutters: 16,
    mainWidth: 992,
    paneWidth: 320,
    gridColumnWidth: 656,
    gridViewportHeight: 340,
  },
  {
    label: '1440×900',
    width: 1440,
    height: 900,
    gutters: 24,
    mainWidth: 1392,
    paneWidth: 360,
    gridColumnWidth: 1016,
    gridViewportHeight: 540,
  },
  {
    label: '1920×1080',
    width: 1920,
    height: 1080,
    gutters: 24,
    mainWidth: 1872,
    paneWidth: 360,
    gridColumnWidth: 1496,
    gridViewportHeight: 640,
  },
]

/** A measured box; every matrix assertion reads one of these. */
interface MeasuredBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Box of one selector inside the page; a missing box fails the test loudly. */
async function measure(page: Page, selector: string): Promise<MeasuredBox> {
  const box = await page.locator(selector).first().boundingBox()
  if (box === null) throw new Error(`missing bounding box for ${selector}`)
  return box
}

/** Assert one measurement against the matrix row within the ±2px tolerance. */
function expectMatrixValue(actual: number, expected: number, label: string): void {
  expect(
    Math.abs(actual - expected),
    `${label}: measured ${String(Math.round(actual * 100) / 100)}px, matrix ${String(expected)}px (±${String(GEOMETRY_TOLERANCE_PX)}px)`,
  ).toBeLessThanOrEqual(GEOMETRY_TOLERANCE_PX)
}

/** No horizontal document overflow anywhere: scroll, never clip (ux-1). */
async function expectNoHorizontalClip(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth)
}

for (const sample of DESKTOP_SAMPLES) {
  test(`uxv-3 geometry at ${sample.label}: gutters, main, pane, gap, grid column`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: sample.width, height: sample.height })
    await openDefault(page)
    // Normal ready state: no telemetry disclosure, no open error, no extra
    // guidance — the frame the matrix is defined on.
    await expect(page.getByTestId('telemetry-disclosure')).toHaveCount(0)
    await expect(page.getByTestId('open-error')).toHaveCount(0)

    const main = await measure(page, 'main')
    const pane = await measure(page, '.workbench-tools')
    const gridColumn = await measure(page, '#section-grid')
    const center = await measure(page, '.workbench-center')
    const layout = await measure(page, '.workbench-layout')

    // Outer gutters: the page inset is the only horizontal inset (no
    // `main { max-width }` cap), so both gutters equal the gutter step.
    expectMatrixValue(main.x, sample.gutters, 'left gutter')
    expectMatrixValue(sample.width - (main.x + main.width), sample.gutters, 'right gutter')
    expectMatrixValue(main.width, sample.mainWidth, 'main width')

    // Two-pane tracks: fixed pane, 16px gap, fluid center column.
    expectMatrixValue(pane.width, sample.paneWidth, 'pane width')
    expectMatrixValue(gridColumn.x - (pane.x + pane.width), 16, 'pane/grid gap')
    expectMatrixValue(gridColumn.width, sample.gridColumnWidth, 'grid column width')

    // The pane, and the center COLUMN, start at the same top edge. The grid
    // section sits below the dataset context bar inside that column.
    expect(Math.abs(center.y - pane.y)).toBeLessThanOrEqual(GEOMETRY_TOLERANCE_PX)
    expect(gridColumn.y).toBeGreaterThan(center.y)

    // Ready workspace top budget (compact header) and the bounded grid height.
    expect(
      layout.y,
      `ready workspace top: measured ${String(layout.y)}px, budget ≤${String(READY_TOP_BUDGET_PX)}px`,
    ).toBeGreaterThan(0)
    expect(layout.y).toBeLessThanOrEqual(READY_TOP_BUDGET_PX)
    const gridViewport = await measure(page, '[data-testid="grid-viewport"]')
    expectMatrixValue(gridViewport.height, sample.gridViewportHeight, 'grid viewport height')

    // Scroll, never clip, with the wide canvas in place.
    await expectNoHorizontalClip(page)
  })
}

test('uxv-3 geometry at 900×900: 16px gutters and the single-column stack', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 })
  await openDefault(page)
  await expect(page.getByTestId('telemetry-disclosure')).toHaveCount(0)

  const main = await measure(page, 'main')
  const gridColumn = await measure(page, '#section-grid')
  const layout = await measure(page, '.workbench-layout')

  expectMatrixValue(main.x, 16, 'left gutter')
  expectMatrixValue(900 - (main.x + main.width), 16, 'right gutter')
  expectMatrixValue(main.width, 868, 'main width')

  // Below the 1024px breakpoint there is no pane box: the same DOM renders as
  // the slice-1 stack, so the grid column IS the available stack width.
  await expect(page.locator('.workbench-pane-head')).toBeHidden()
  expectMatrixValue(gridColumn.width, 868, 'grid column (available stack width)')
  expectMatrixValue(gridColumn.x, main.x, 'grid column left edge')
  expect(layout.y).toBeLessThanOrEqual(READY_TOP_BUDGET_PX)

  await expectNoHorizontalClip(page)
})

test('uxv-3: 1024×700 first paint shows heading, column headers, first row and the whole footer', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 700 })
  await openDefault(page)
  await waitForReadyRow(page, 0)

  // Section heading (the shell's Grid toggle, title + purpose) …
  await expect(page.getByTestId('section-toggle-grid')).toBeInViewport({ ratio: 1 })
  await expect(page.getByTestId('section-purpose-grid')).toBeInViewport({ ratio: 1 })
  // … the column headers …
  await expect(page.locator('[data-testid="grid-viewport"] .grid-header')).toBeInViewport({
    ratio: 1,
  })
  await expect(page.locator('[data-testid="grid-header-cell"]').first()).toBeInViewport({
    ratio: 1,
  })
  // … the first ready data row, fully inside the vertical viewport. The row's
  // column track is wider than a 1024px center column (that is what
  // `grid-horizontal.spec.ts` pins), so this is a vertical-containment
  // assertion plus a presence-in-viewport one — never a horizontal one.
  await expect(row(page, 0)).toBeInViewport()
  const gridViewport = await measure(page, '[data-testid="grid-viewport"]')
  const firstRow = await measure(page, '[data-testid="grid-row"][data-row-index="0"]')
  expect(firstRow.y).toBeGreaterThanOrEqual(gridViewport.y)
  expect(firstRow.y + firstRow.height).toBeLessThanOrEqual(gridViewport.y + gridViewport.height + 1)
  expect(firstRow.y + firstRow.height).toBeLessThanOrEqual(700)
  // … and the NORMAL grid footer (edit hint + the Keyboard/Diagnostics
  // disclosures), entirely inside the 700px-tall viewport.
  const footer = page.locator('.grid-footer')
  await expect(footer).toBeInViewport({ ratio: 1 })
  await expect(page.getByTestId('grid-edit-hint')).toBeInViewport({ ratio: 1 })
  await expect(page.getByTestId('grid-diagnostics')).toBeVisible()

  const footerBox = await measure(page, '.grid-footer')
  expect(
    footerBox.y + footerBox.height,
    `grid footer bottom: measured ${String(footerBox.y + footerBox.height)}px of a 700px viewport`,
  ).toBeLessThanOrEqual(700)
})
