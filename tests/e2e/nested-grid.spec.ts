import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import path from 'node:path'

// Task m3-2 (handoff §6): nested cell previews in the grid. Opens the
// committed `fixtures/jsonl/nested.jsonl` golden fixture (m3-1) through the
// app's real fixture-loading path (pickDataFile → engine open → provider →
// viewport model → DataGrid) and pins the exact preview strings for the known
// nested cells. Previews are deterministic (pure module, property-tested), so
// the strings are pinned exactly (m2-6 CLI-pinning spirit): they were derived
// from `formatNestedPreview`'s own output and cross-checked against the
// DuckDB CLI (v1.5.5) on the same fixture:
//
//   /tmp/duckdb -c "SELECT deep, meta, tags FROM read_json_auto(
//     'fixtures/jsonl/nested.jsonl', format='newline_delimited') WHERE id = 1;"
//   → deep {'a': {'b': {'c': 1}}} · meta {'src': sensor-a, 'ver': 1} · tags [x, y]
//   /tmp/duckdb -c "SELECT list_transform(events, e -> epoch_ms(e.at)),
//     list_transform(events, e -> e.ok) FROM read_json_auto(
//     'fixtures/jsonl/nested.jsonl', format='newline_delimited') WHERE id = 1;"
//   → [1740823200000, 1740823500000], [true, false]
//
// (epoch ms — the m3-1 worker-boundary contract for Arrow
// Timestamp(MICROSECOND) `.get()`; mirrored in the engine client's
// `fetchRange` doc comment.)
//
// The app under test is the real composition root served at '/' by the first
// webServer in playwright.config.ts. Picker path: window.showOpenFilePicker
// does not fire Playwright's filechooser (probed in m1-5), so the FSA global
// is removed via an init script and the app takes its hidden-input fallback
// (m1-3 style), which IS interceptable.
const FIXTURE_PATH = path.resolve(import.meta.dirname, '../../fixtures/jsonl/nested.jsonl')

const HEADER_NAMES = [
  'id',
  'kind',
  'label',
  'score',
  'deep',
  'meta',
  'tags',
  'events',
  'hole',
  'weird "quoted" key',
]

/** Exact cell previews for fixture rows, in schema order (`''` = NULL cell). */
const ROW_ID_1 = [
  '1',
  'alpha',
  'plain alpha row',
  '10',
  '{"a":{"b":{"c":…}}}', // depth-3 struct: shape visible, leaf elided at the cap
  '{"src":"sensor-a","ver":1}',
  '["x","y"]',
  '[{"at":1740823200000,"ok":true},{"at":1740823500000,"ok":false}]', // list-of-structs, epoch ms
  '', // `hole` (all-NULL column): NULL renders as an empty cell (m1-5 contract)
  '1', // the quoting-hostile key's value, rendered as plain data
]

const ROW_ID_2 = [
  '2',
  'beta',
  'héllo → 世界 🚀', // unicode label survives as exact text
  '20',
  '{"a":{"b":{"c":…}}}',
  '{"src":"sensor-b","ver":2}',
  '[]', // the empty list — visually distinct from a NULL list
  '[{"at":1740906000000,"ok":true},{"at":1740907800000,"ok":null}]', // NULL field inside a struct
  '',
  '2',
]

const ROW_ID_3 = [
  '3',
  'alpha',
  'quote " inside',
  '', // NULL score
  '{"a":{"b":{"c":…}}}',
  '{"src":null,"ver":3}', // NULL struct field distinct from a whole-NULL struct
  '["x",null,"z"]', // NULL element inside a list
  '[{"at":null,"ok":true},{"at":1740988800000,"ok":true}]',
  '',
  '3',
]

test.beforeEach(async ({ page }) => {
  // Inject "no FSA picker" capabilities so the app takes its hidden-input
  // fallback; the filechooser event then carries the file (m1-5 precedent).
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
    } catch {
      // Non-configurable global would be a Chromium change; the fallback
      // would then be skipped and the test would fail loudly at the chooser.
    }
  })
})

async function openNestedFixture(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByTestId('open-status')).toHaveText('idle')
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('open-button').click()
  const chooser = await chooserPromise
  await chooser.setFiles(FIXTURE_PATH)
  await expect(page.getByTestId('open-status')).toHaveText('ready')
  await expect(page.getByTestId('grid-total-rows')).toHaveText('12')
  await expect(page.getByTestId('grid-column-count')).toHaveText('10')
  // Privacy (ADR 0025): the picked file name is never rendered.
  await expect(page.getByTestId('table-info')).not.toContainText('nested.jsonl')
}

test('nested cells render pinned, bounded previews (structs, lists, NULLs, hostile key)', async ({
  page,
}) => {
  await openNestedFixture(page)

  // Column headers, including the quoting-hostile key as exact header text.
  const headerNames = await page
    .getByTestId('grid-header-cell')
    .evaluateAll((cells) => cells.map((cell) => cell.getAttribute('data-col-name')))
  expect(headerNames).toEqual(HEADER_NAMES)

  // Row id 1: the depth-3 struct, the list-of-structs, and the hostile key.
  const row1 = page.locator('[data-testid="grid-row"][data-row-index="0"]')
  await expect(row1).toHaveAttribute('data-status', 'ready')
  await expect(row1.getByTestId('grid-cell')).toHaveText(ROW_ID_1)

  // Row id 2: unicode label + the empty list.
  const row2 = page.locator('[data-testid="grid-row"][data-row-index="1"]')
  await expect(row2).toHaveAttribute('data-status', 'ready')
  await expect(row2.getByTestId('grid-cell')).toHaveText(ROW_ID_2)

  // Row id 3: NULLs *inside* structures stay distinct.
  const row3 = page.locator('[data-testid="grid-row"][data-row-index="2"]')
  await expect(row3).toHaveAttribute('data-status', 'ready')
  await expect(row3.getByTestId('grid-cell')).toHaveText(ROW_ID_3)

  // Row id 4: the NULL list and the whole-NULL struct render as empty cells
  // (the top-level NULL contract), while its list-of-structs keeps the NULL
  // element visible.
  const row4 = page.locator('[data-testid="grid-row"][data-row-index="3"]')
  await expect(row4).toHaveAttribute('data-status', 'ready')
  const row4Cells = row4.getByTestId('grid-cell')
  await expect(row4Cells.nth(4)).toHaveText('') // deep: whole-NULL struct
  await expect(row4Cells.nth(6)).toHaveText('') // tags: NULL list
  await expect(row4Cells.nth(7)).toHaveText('[{"at":1741071600000,"ok":false},null]')
})

test('overflow stays a CSS concern; cells carry no title tooltips (m3-2 policy)', async ({
  page,
}) => {
  await openNestedFixture(page)
  const deepCell = page.locator('[data-testid="grid-row"][data-row-index="0"] .grid-cell').nth(4)
  // The grid's ellipsis pattern clips visually; the text node itself is the
  // bounded preview (≤ 120 chars — property-tested), never the full value.
  await expect(deepCell).toHaveCSS('text-overflow', 'ellipsis')
  await expect(deepCell).toHaveCSS('overflow', 'hidden')
  // Title policy: no `title` attribute anywhere on data cells — a title
  // mirroring cell text would duplicate previews into DOM attributes (and
  // pre-m3-2 risked multi-KB tooltips over raw JSON).
  const titles = await page
    .locator('[data-testid="grid-row"] [data-testid="grid-cell"]')
    .evaluateAll((cells) => cells.filter((cell) => cell.hasAttribute('title')).length)
  expect(titles).toBe(0)
})

/** Parse the footer's per-epoch counters (`fetches=N requested=N … cached=N`). */
async function readGridStats(page: Page): Promise<Record<'fetches' | 'cached', number>> {
  const text = await page.getByTestId('grid-stats').innerText()
  const field = (key: string): number => {
    const match = text.match(new RegExp(`${key}=(\\d+)`))
    if (match === null) throw new Error(`grid stats missing "${key}": ${text}`)
    return Number(match[1])
  }
  return { fetches: field('fetches'), cached: field('cached') }
}

async function scrollToTop(page: Page): Promise<void> {
  await page.evaluate(() => {
    const viewport = document.querySelector('[data-testid="grid-viewport"]')
    if (viewport === null) throw new Error('grid viewport not found')
    viewport.scrollTop = 0
  })
}

// m3-2 fix round: the previous draft claimed "row 0 is refetched from a fresh
// engine window" after a scroll tour — but 12 rows never exceed the model's
// 10 000-row LRU (cache-serve with zero provider fetches is pinned in
// packages/grid/src/viewport-model.test.ts), so that claim was never
// exercised. This test now proves determinism of a GENUINELY re-fetched cell:
// the scroll tour is kept as a control (counters must NOT move), and the
// refetch is forced the way the app really does it — an accepted sort starts
// a fresh data epoch (setSort → refresh(): cache dropped, per-epoch counters
// reset, visible window re-fetched from the provider; pinned in
// viewport-model.test.ts "clears cache and stats and refetches the current
// viewport"). The footer's fetch counters make the fetch observable.
test('previews are deterministic across a genuine provider refetch (sort-epoch refresh)', async ({
  page,
}) => {
  await openNestedFixture(page)
  const row1 = page.locator('[data-testid="grid-row"][data-row-index="0"]')
  await expect(row1.getByTestId('grid-cell')).toHaveText(ROW_ID_1)
  const statsAtOpen = await readGridStats(page)
  expect(statsAtOpen.fetches).toBeGreaterThanOrEqual(1)

  // Control: on a 12-row dataset a scroll tour can only ever be served from
  // the LRU cache — the fetch counters must stay untouched.
  await page.evaluate(() => {
    const viewport = document.querySelector('[data-testid="grid-viewport"]')
    if (viewport === null) throw new Error('grid viewport not found')
    viewport.scrollTop = 11 * 28
  })
  await expect(page.locator('[data-testid="grid-row"][data-row-index="11"]')).toHaveAttribute(
    'data-status',
    'ready',
  )
  await scrollToTop(page)
  const statsAfterTour = await readGridStats(page)
  expect(statsAfterTour.fetches).toBe(statsAtOpen.fetches)

  // The genuine refetch: sort by `id` ascending — DuckDB returns the fixture's
  // natural order, so row 0 is still id 1, but its cells now come from a fresh
  // epoch's provider page, not the pre-tour cache. The identical preview
  // strings prove the previews are deterministic under a real refetch.
  const idSort = page.locator('[data-testid="grid-sort-toggle"][data-col-name="id"]')
  await idSort.click()
  await expect(idSort).toHaveAttribute('data-sort', 'asc') // setSort accepted → refresh() ran
  await expect(row1.getByTestId('grid-cell')).toHaveText(ROW_ID_1)
  const statsAfterEpoch = await readGridStats(page)
  // Counters reset with the epoch (pinned unit behavior), so ≥ 1 here is a
  // fresh `fetchRange` — the row-0 page on screen was re-fetched, not cached.
  expect(statsAfterEpoch.fetches).toBeGreaterThanOrEqual(1)
  expect(statsAfterEpoch.cached).toBeGreaterThanOrEqual(1)
})
