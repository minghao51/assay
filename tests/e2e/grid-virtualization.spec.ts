import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  ensureMillionFixture,
  expectedMillionRow,
  MILLION_ROW_COUNT,
  millionFixturePath,
} from './support/million-fixture'
import { readGridStats } from './support/grid-stats'
import { row } from './support/grid'
import { percentile } from './support/stats'

// Task M1-5 proof (handoff §6 #5): a 1M-row dataset scrolls smoothly in a
// virtualized DOM grid, and the grid never materializes the dataset. The app
// under test is the real composition root served at '/' by the first
// webServer in playwright.config.ts (apps/web/dist via vite preview):
// pickDataFile → engine open → GridDataProvider adapter → headless viewport
// model (packages/grid) → TanStack Virtual DOM rows.
//
// Deterministic assertions are primary:
//   1. exact cell values at several scroll offsets (deterministic generator),
//   2. bounded DOM row count across scripted scrolls,
//   3. bounded cumulative fetching (model stats), every span ≤ the cap.
// Frame timings are the CI-tolerant sanity signal, printed for the report.
//
// Picker path: Playwright's filechooser interception does NOT reach
// window.showOpenFilePicker (probed against this Chromium — the picker
// promise stays pending, no event fires). The spec therefore removes the
// FSA global via an init script, so the app's capability detection takes the
// hidden-<input type="file"> fallback (m1-3 style), which IS interceptable.
// The m1-3 task proved the FSA path itself for data-sources in Chromium.

/** Keep in sync with GRID_ROW_HEIGHT_PX in apps/web/src/grid/DataGrid.tsx. */
const ROW_HEIGHT_PX = 28
/** Upper bound for rendered rows: viewport (~17) + overscan on both edges. */
const MAX_DOM_ROWS = 100
/** Cumulative fetched rows must stay far below the dataset (never ≈ 1M). */
const MAX_CUMULATIVE_FETCHED_ROWS = 25_000
/** Every provider request must be a bounded span (model cap = engine cap). */
const MAX_SPAN_ROWS = 1000

const FIXTURE_PATH = millionFixturePath()

/** Test-only rAF recorder installed in the page (no `any`: typed seam). */
interface FrameRecorder {
  deltas: number[]
  raf: number
  last: number
  running: boolean
}
type RecorderGlobal = typeof globalThis & { __assayFrameRecorder?: FrameRecorder }

test.beforeAll(() => {
  // Node-side, on-demand generation into the OS temp dir (never committed).
  ensureMillionFixture()
})

test.beforeEach(async ({ page }) => {
  // Inject "no FSA picker" capabilities at the window level so the app takes
  // its hidden-input fallback; the filechooser event then carries the file.
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
    } catch {
      // Non-configurable global would be a Chromium change; the fallback
      // would then be skipped and the test would fail loudly at the chooser.
    }
  })
})

async function openMillionFixture(page: Page): Promise<void> {
  await page.goto('/')
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'idle', {
    timeout: 20_000,
  })
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('open-button').click()
  const chooser = await chooserPromise
  await chooser.setFiles(FIXTURE_PATH)
  // Engine boot + open + schema + count: the ready phase is fully loaded.
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'ready', {
    timeout: 20_000,
  })
  await expect(page.getByTestId('sql-table-id')).toHaveText('t1')
  await expect(page.getByTestId('grid-total-rows')).toHaveText(String(MILLION_ROW_COUNT))
  await expect(page.getByTestId('grid-column-count')).toHaveText('4')
  // Privacy (ADR 0025): the picked file name is never rendered.
  await expect(page.getByTestId('table-info')).not.toContainText('million.parquet')
}

async function scrollToRow(page: Page, rowIndex: number): Promise<void> {
  await page.evaluate(
    ({ index, rowHeight }) => {
      const viewport = document.querySelector('[data-testid="grid-viewport"]')
      if (viewport === null) throw new Error('grid viewport not found')
      viewport.scrollTop = index * rowHeight
    },
    { index: rowIndex, rowHeight: ROW_HEIGHT_PX },
  )
}

async function expectKnownRow(page: Page, rowIndex: number): Promise<void> {
  const expected = expectedMillionRow(rowIndex)
  const target = row(page, rowIndex)
  await expect(target).toHaveAttribute('data-status', 'ready')
  await expect(target.getByTestId('grid-cell')).toHaveText([
    expected.id,
    expected.bucket,
    expected.label,
    expected.valueMaybeNull,
  ])
}

test('opens the 1M-row fixture and renders exact known rows at several scroll offsets', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await openMillionFixture(page)

  // Headers: generator columns with DuckDB type strings (m1-6 renders the
  // full schema tree; here the grid headers are the correctness anchor).
  // m2-3: each header cell now also carries a sort toggle, so the column
  // names are asserted on the name spans inside the cells.
  const headers = page.getByTestId('grid-header-cell')
  await expect(
    page.locator('[data-testid="grid-header-cell"] [data-testid="grid-header-name"]'),
  ).toHaveText(['id', 'bucket', 'label', 'value_maybe_null'])
  await expect(headers.nth(0)).toHaveAttribute('data-col-type', 'BIGINT')
  await expect(headers.nth(3)).toHaveAttribute('data-col-type', 'DOUBLE')

  // Top, deep-middle (proves OFFSET correctness far from row 0), the exact
  // last row (proves the count-clamped window reaches the end), and the
  // generator's first NULL row (proves NULL → empty cell on a ready row).
  for (const rowIndex of [0, 123_456, 500_000, 999_999, 100_000]) {
    await scrollToRow(page, rowIndex)
    await expectKnownRow(page, rowIndex)
  }
})

test('DOM rows stay bounded, fetching stays windowed, and scroll frames stay smooth', async ({
  page,
}) => {
  test.setTimeout(180_000)
  await openMillionFixture(page)

  // Start the rAF delta recorder for the whole scripted scroll session.
  await page.evaluate(() => {
    const recorder: FrameRecorder = { deltas: [], raf: 0, last: 0, running: true }
    const tick = (time: number): void => {
      if (!recorder.running) return
      if (recorder.last !== 0) recorder.deltas.push(time - recorder.last)
      recorder.last = time
      recorder.raf = requestAnimationFrame(tick)
    }
    recorder.raf = requestAnimationFrame(tick)
    ;(globalThis as RecorderGlobal).__assayFrameRecorder = recorder
  })

  // Scripted scroll session: deep jumps across the whole dataset (each stop
  // re-renders a fresh window from a fresh SQL LIMIT/OFFSET fetch), fast
  // reverse jumps, plus a wheel burst at one position (continuous scroll).
  const jumpStops = [
    0, 83_333, 166_666, 250_000, 333_333, 416_666, 500_000, 583_333, 666_666, 750_000, 833_333,
    999_990, 999_000, 7, 456_789, 123_456, 876_543, 234_567, 999_999,
  ]
  for (const stop of jumpStops) {
    await scrollToRow(page, stop)
    const domRows = await page.locator('[data-testid="grid-row"]').count()
    expect(domRows).toBeLessThan(MAX_DOM_ROWS)
    // q-5: wait on the observable — the scrolled-to row has rendered — rather
    // than a fixed 90 ms settle between stops.
    await expect(row(page, stop)).toBeAttached()
  }
  await scrollToRow(page, 600_000)
  await page.getByTestId('grid-viewport').scrollIntoViewIfNeeded()
  // Wheel events fire at the current mouse position: hover the viewport so
  // the bursts scroll the grid itself — otherwise the cursor still sits over
  // the outer page (last positioned by the open-button click) and the bursts
  // would scroll window.scrollY while the grid's scrollTop never moves.
  await page.getByTestId('grid-viewport').hover()
  const viewport = page.getByTestId('grid-viewport')
  const scrollTopBeforeBursts = await viewport.evaluate((el) => el.scrollTop)
  const fetchesBeforeBursts = await readGridStats(page)
  for (let burst = 0; burst < 20; burst++) {
    const scrollTopBeforeWheel = await viewport.evaluate((el) => el.scrollTop)
    await page.mouse.wheel(0, 8000)
    // q-5: wait on the observable — the wheel advanced the grid viewport —
    // rather than a fixed 35 ms settle.
    await expect
      .poll(() => viewport.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(scrollTopBeforeWheel)
    const domRows = await page.locator('[data-testid="grid-row"]').count()
    expect(domRows).toBeLessThan(MAX_DOM_ROWS)
  }
  // Effectiveness guard: the bursts must provably drive the grid viewport —
  // scrollTop actually moved and the newly uncovered range issued real
  // windowed fetches (a no-op burst loop would fail both assertions).
  const scrollTopAfterBursts = await viewport.evaluate((el) => el.scrollTop)
  expect(scrollTopAfterBursts).toBeGreaterThan(scrollTopBeforeBursts)
  const stats = await readGridStats(page)
  expect(stats.fetches).toBeGreaterThan(fetchesBeforeBursts.fetches)

  // 2. Virtualization bound held for the whole session (asserted per stop).
  // 3. Never-materializes: cumulative provider-path fetching is far below the
  // dataset; no request ever exceeded the bounded span cap; UI row state is
  // bounded by the model's LRU cap (10_000), never the dataset size.
  expect(stats.requested).toBeLessThan(MAX_CUMULATIVE_FETCHED_ROWS)
  expect(stats.maxSpan).toBeLessThanOrEqual(MAX_SPAN_ROWS)
  expect(stats.cached).toBeLessThanOrEqual(10_000)
  const statsLine =
    `[m1-5 fetch stats] fetchCalls=${String(stats.fetches)} rowsRequested=${String(stats.requested)} ` +
    `rowsReceived=${String(stats.received)} maxSpanRows=${String(stats.maxSpan)} cachedRows=${String(stats.cached)} ` +
    `(dataset=${String(MILLION_ROW_COUNT)} rows; requested = ${(100 * stats.requested) / MILLION_ROW_COUNT}% of the dataset)`
  console.log(statsLine)

  // Cache/dedup: revisiting row 0 (still cached — the session touched ≪ the
  // LRU cap) must not issue a single new fetch or request a single new row.
  const beforeRevisit = await readGridStats(page)
  await scrollToRow(page, 0)
  await expectKnownRow(page, 0)
  const afterRevisit = await readGridStats(page)
  expect(afterRevisit.fetches).toBe(beforeRevisit.fetches)
  expect(afterRevisit.requested).toBe(beforeRevisit.requested)

  // 4. Smoothness sanity signal (deterministic assertions above are primary).
  const deltas = await page.evaluate(() => {
    const recorder = (globalThis as RecorderGlobal).__assayFrameRecorder
    if (!recorder) throw new Error('frame recorder missing')
    recorder.running = false
    cancelAnimationFrame(recorder.raf)
    return recorder.deltas
  })
  expect(deltas.length).toBeGreaterThan(100)
  const sorted = [...deltas].sort((a, b) => a - b)
  const median = percentile(deltas, 50)
  const p95 = percentile(deltas, 95)
  const observed = `[m1-5 frame timing] frames=${String(deltas.length)} median=${median.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${sorted[sorted.length - 1]?.toFixed(1) ?? String(Number.NaN)}ms`
  console.log(observed)
  expect(median, `median frame delta ${median.toFixed(1)}ms (${observed})`).toBeLessThan(33)
  expect(p95, `p95 frame delta ${p95.toFixed(1)}ms (${observed})`).toBeLessThan(100)
})
