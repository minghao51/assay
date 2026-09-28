import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { openFixture } from './support/fixtures'

// Task m2-6 proof (handoff §6): the profile panel + distribution charts over
// the full stack — trigger → engineClient.profile() (the m2-5 `engine/profile`
// FIFO op) → per-column stats + dependency-free SVG charts. The app under
// test is the real composition root served at '/' by the first webServer in
// playwright.config.ts, opened on the COMMITTED golden fixtures:
//
// customers.parquet (5 rows) — expected profile pinned against DuckDB CLI
// 1.5.5 (the same values as tests/e2e/engine-profile.spec.ts): customer_id
// numeric (min 1, max 5, mean 3, stddev 1.5811388300841898 → displayed
// 1.58114, quantiles 3/4.6/4.8/4.96), country categorical (SG 2, US 2, DE 1 —
// the SG/US tie broken by value ascending), income numeric with one NULL
// (quantiles 56500/70800/72900/74580), signup_date DATE-as-categorical.
//
// ux-3: display rounding keeps six significant digits (format-stats.ts); the
// engine/JSON values above stay exact, so the pins below are the ROUNDED text.
//
// nested.parquet (50 rows) — the payload STRUCT column must degrade to kind
// 'other' (null/distinct only, no stats, no charts) while id stays numeric
// (min 0, max 49, mean 24.5, stddev 14.577379737113251 → displayed 14.5774,
// quantiles 24.5/44.1/46.55/48.51).
//
// NOT asserted here: the profile error path. No cheap in-app error exists
// (the panel only profiles a valid open handle), so the error/retry path is
// unit-covered in apps/web/src/profile/profile-state.test.ts, and the guard
// discard itself is pinned by runGuarded's Node tests. The re-open property
// IS asserted here (m2-6 fix round, last spec): a profile started on table
// A never renders after the table is re-opened, and the panel returns to
// idle. Honest mechanics: today the App phase machine upholds that
// structurally — the whole panel composition unmounts during
// `ready → opening → ready` — while the panel's RunGuard invalidation is
// the defensive second layer, operative only if the panel is ever kept
// mounted across re-opens (e.g. to avoid the grid remount). The spec pins
// the property so that plausible refactor cannot silently regress it.
//
// Picker path (m1-5/m1-6 pattern): an init script removes the FSA global so
// the app takes the hidden-<input type="file"> fallback. Privacy (ADR 0025):
// the panel never renders the picked file's name, and nothing is logged.
// Rendering is data-only (ADR 0007 spirit): every value, label, and error is
// React text interpolation — profile outputs are never markup.

const FIXTURES_DIR = path.join(process.cwd(), 'fixtures', 'parquet')
const CUSTOMERS_FIXTURE = path.join(FIXTURES_DIR, 'customers.parquet')
const NESTED_FIXTURE = path.join(FIXTURES_DIR, 'nested.parquet')

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
    } catch {
      // Non-configurable global would be a Chromium change; the fallback
      // would then be skipped and the test would fail loudly at the chooser.
    }
  })
})

/**
 * Open a second file in the SAME page session (no reload): the re-open spec
 * needs the app to survive a re-open while engine ops are in flight — a
 * reload would reset the worker and prove nothing about the panel.
 */
async function reopenFixture(page: Page, fixturePath: string): Promise<void> {
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('open-button').click()
  const chooser = await chooserPromise
  await chooser.setFiles(fixturePath)
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'ready', {
    timeout: 20_000,
  })
}

/** Column-scoped locator: the panel tags every per-column element. */
function column(page: Page, name: string) {
  return page.locator(`[data-testid="profile-column"][data-col-name="${name}"]`)
}

function stat(page: Page, columnName: string, statTestId: string) {
  return column(page, columnName).locator(`[data-testid="${statTestId}"]`)
}

test('profiles the customers fixture: exact numeric stats, quantile strip, categorical top-k with accessible names', async ({
  page,
}) => {
  await openFixture(page, CUSTOMERS_FIXTURE)

  // The panel is a disclosure section, open by default, idle until triggered.
  const section = page.getByTestId('profile-section')
  await expect(page.getByTestId('profile-toggle')).toHaveAttribute('aria-expanded', 'true')
  await expect(section).toHaveAttribute('data-state', 'idle')
  await expect(page.getByTestId('profile-hint')).toBeVisible()

  await page.getByTestId('profile-run').click()
  await expect(section).toHaveAttribute('data-state', 'done', { timeout: 30_000 })
  await expect(page.getByTestId('profile-rowcount-value')).toHaveText('5')

  // Privacy (ADR 0025): the panel never contains the picked file's name.
  await expect(section).not.toContainText('customers.parquet')

  // --- numeric column (customer_id BIGINT): exact pinned stats, nulls as '—' ---
  await expect(column(page, 'customer_id')).toHaveAttribute('data-col-kind', 'numeric')
  await expect(stat(page, 'customer_id', 'profile-null-count')).toHaveText('0')
  await expect(stat(page, 'customer_id', 'profile-distinct-count')).toHaveText('5')
  await expect(stat(page, 'customer_id', 'profile-stat-min')).toHaveText('1')
  await expect(stat(page, 'customer_id', 'profile-stat-max')).toHaveText('5')
  await expect(stat(page, 'customer_id', 'profile-stat-mean')).toHaveText('3')
  await expect(stat(page, 'customer_id', 'profile-stat-stddev')).toHaveText('1.58114')
  await expect(stat(page, 'customer_id', 'profile-stat-p50')).toHaveText('3')
  await expect(stat(page, 'customer_id', 'profile-stat-p90')).toHaveText('4.6')
  await expect(stat(page, 'customer_id', 'profile-stat-p95')).toHaveText('4.8')
  await expect(stat(page, 'customer_id', 'profile-stat-p99')).toHaveText('4.96')

  // Quantile distribution strip: named chart (role img, full text alternative
  // as its accessible name), five proportional boundary segments, tick labels.
  const customerIdStrip = column(page, 'customer_id').getByTestId('profile-strip')
  await expect(
    customerIdStrip.getByRole('img', {
      name: 'Quantile distribution of column customer_id: min 1, p50 3, p90 4.6, p95 4.8, p99 4.96, max 5',
    }),
  ).toBeVisible()
  await expect(customerIdStrip.getByTestId('profile-strip-segment')).toHaveCount(5)
  // Per-segment text alternative (SVG <title> restates boundary pair + values).
  await expect(customerIdStrip.locator('title')).toHaveText([
    'min–p50: 1 – 3',
    'p50–p90: 3 – 4.6',
    'p90–p95: 4.6 – 4.8',
    'p95–p99: 4.8 – 4.96',
    'p99–max: 4.96 – 5',
  ])
  await expect(customerIdStrip.getByTestId('profile-strip-tick').first()).toHaveText('min 1')
  await expect(customerIdStrip.getByTestId('profile-strip-tick').last()).toHaveText('max 5')

  // --- numeric column with a NULL (income): null count shown, exact stats ---
  await expect(stat(page, 'income', 'profile-null-count')).toHaveText('1')
  await expect(stat(page, 'income', 'profile-distinct-count')).toHaveText('4')
  await expect(stat(page, 'income', 'profile-stat-min')).toHaveText('48000')
  await expect(stat(page, 'income', 'profile-stat-stddev')).toHaveText('11972.2')
  await expect(stat(page, 'income', 'profile-stat-p50')).toHaveText('56500')
  await expect(stat(page, 'income', 'profile-stat-p99')).toHaveText('74580')
  await expect(
    column(page, 'income').getByRole('img', {
      name: 'Quantile distribution of column income: min 48000, p50 56500, p90 70800, p95 72900, p99 74580, max 75000',
    }),
  ).toBeVisible()

  // --- categorical column (country): top-k bars with accessible names ---
  await expect(column(page, 'country')).toHaveAttribute('data-col-kind', 'categorical')
  // The chart container itself is the named img (role + full text alternative).
  const countryChart = column(page, 'country').getByTestId('profile-topk')
  await expect(
    column(page, 'country').getByRole('img', {
      name: 'Bar chart of top values in column country: SG 2, US 2, DE 1 (3 of 3 distinct non-null values shown)',
    }),
  ).toBeVisible()
  await expect(countryChart.getByTestId('profile-topk-row')).toHaveCount(3)
  await expect(countryChart.getByTestId('profile-topk-value')).toHaveText(['SG', 'US', 'DE'])
  await expect(countryChart.getByTestId('profile-topk-count')).toHaveText(['2', '2', '1'])
  // Bars scale to the largest count: the two tied leaders span the track, the
  // third is half width.
  const barFractions = await countryChart
    .getByTestId('profile-topk-bar')
    .evaluateAll((rects) => rects.map((rect) => rect.getAttribute('data-bar-fraction')))
  expect(barFractions).toEqual(['1', '1', '0.5'])
  // Per-bar text alternative (SVG <title> restates value + count).
  await expect(countryChart.getByTestId('profile-topk-bar').first().locator('title')).toHaveText(
    'SG: 2',
  )

  // --- DATE renders as categorical (the m2-5 temporal decision) ---
  await expect(column(page, 'signup_date')).toHaveAttribute('data-col-kind', 'categorical')
  await expect(column(page, 'signup_date').getByTestId('profile-topk-row')).toHaveCount(5)
  await expect(column(page, 'signup_date').getByTestId('profile-topk-value').first()).toHaveText(
    '2025-01-04',
  )
})

test('shows the running state while the profile queues behind an in-flight SQL query on the engine FIFO', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await openFixture(page, CUSTOMERS_FIXTURE)

  // Occupy the engine's single FIFO slot with a deliberately slow query
  // (~2.8 s, the same probe as sql-editor.spec.ts). The profile op must
  // queue behind it: the panel shows its running state (a polite live
  // region) until the slot frees and the scan completes.
  await page
    .getByTestId('sql-input')
    .fill('SELECT sum(a.i * b.i) FROM range(20000) AS a(i), range(20000) AS b(i)')
  await page.getByTestId('sql-run').click()
  await expect(page.getByTestId('sql-panel')).toHaveAttribute('data-state', 'running')

  await page.getByTestId('profile-run').click()
  const running = page.getByTestId('profile-running')
  await expect(running).toBeVisible()
  await expect(running).toHaveAttribute('role', 'status')

  // The queued profile completes once the engine frees up — result renders.
  await expect(page.getByTestId('profile-section')).toHaveAttribute('data-state', 'done', {
    timeout: 90_000,
  })
  await expect(page.getByTestId('profile-rowcount-value')).toHaveText('5')
})

test('a profile started on table A never renders after re-opening the table: the panel returns to idle (m2-6 fix-round pin)', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await openFixture(page, CUSTOMERS_FIXTURE)
  const tableIdA = await page.getByTestId('profile-table-id').textContent()
  expect(tableIdA).toBeTruthy()

  // Occupy the engine FIFO with the slow probe (~2.8 s, the sql-editor
  // probe), then start the profile behind it: it is demonstrably still
  // queued when the re-open happens.
  await page
    .getByTestId('sql-input')
    .fill('SELECT sum(a.i * b.i) FROM range(20000) AS a(i), range(20000) AS b(i)')
  await page.getByTestId('sql-run').click()
  await expect(page.getByTestId('sql-panel')).toHaveAttribute('data-state', 'running')
  await page.getByTestId('profile-run').click()
  await expect(page.getByTestId('profile-section')).toHaveAttribute('data-state', 'running')

  // Re-open (table B) while A's profile is still in flight.
  await reopenFixture(page, NESTED_FIXTURE)

  // Ordering guarantee: every engine op serializes through the single FIFO
  // (op-channel), and B's `engine/open` queued *behind* A's profile — so by
  // the time B is ready, A's profile has already settled and its guarded
  // delivery decision is final. Whatever the panel shows now is what it
  // will keep showing: it must be the fresh panel for B, back at idle, with
  // none of A's profile rendered.
  const section = page.getByTestId('profile-section')
  await expect(section).toHaveAttribute('data-state', 'idle')
  expect(await page.getByTestId('profile-table-id').textContent()).not.toEqual(tableIdA)
  await expect(page.getByTestId('profile-run')).toBeVisible() // the idle trigger is back
  await expect(page.getByTestId('profile-rowcount')).toHaveCount(0) // A's result never rendered
  await expect(page.getByTestId('profile-columns')).toHaveCount(0)
  await expect(section).not.toContainText('Bar chart of top values in column country')
})

test('degrades STRUCT columns to kind other (no stats, no charts) and pins the nested fixture numeric stats', async ({
  page,
}) => {
  await openFixture(page, NESTED_FIXTURE)

  await page.getByTestId('profile-run').click()
  await expect(page.getByTestId('profile-section')).toHaveAttribute('data-state', 'done', {
    timeout: 30_000,
  })
  await expect(page.getByTestId('profile-rowcount-value')).toHaveText('50')

  // --- numeric column (id BIGINT, 0..49): exact pinned stats + strip ---
  await expect(column(page, 'id')).toHaveAttribute('data-col-kind', 'numeric')
  await expect(stat(page, 'id', 'profile-stat-min')).toHaveText('0')
  await expect(stat(page, 'id', 'profile-stat-max')).toHaveText('49')
  await expect(stat(page, 'id', 'profile-stat-mean')).toHaveText('24.5')
  await expect(stat(page, 'id', 'profile-stat-stddev')).toHaveText('14.5774')
  await expect(stat(page, 'id', 'profile-stat-p50')).toHaveText('24.5')
  await expect(stat(page, 'id', 'profile-stat-p90')).toHaveText('44.1')
  await expect(stat(page, 'id', 'profile-stat-p95')).toHaveText('46.55')
  await expect(stat(page, 'id', 'profile-stat-p99')).toHaveText('48.51')
  await expect(
    column(page, 'id').getByRole('img', {
      name: 'Quantile distribution of column id: min 0, p50 24.5, p90 44.1, p95 46.55, p99 48.51, max 49',
    }),
  ).toBeVisible()

  // --- exotic column (payload STRUCT): degraded fields only, gracefully ---
  const payload = column(page, 'payload')
  await expect(payload).toHaveAttribute('data-col-kind', 'other')
  await expect(payload.getByTestId('profile-null-count')).toHaveText('0')
  await expect(payload.getByTestId('profile-distinct-count')).toHaveText('50')
  await expect(payload.getByTestId('profile-stat-min')).toHaveCount(0)
  await expect(payload.getByTestId('profile-strip')).toHaveCount(0)
  await expect(payload.getByTestId('profile-topk')).toHaveCount(0)
})
