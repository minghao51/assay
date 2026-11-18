import path from 'node:path'
import { expect, test } from './support/fixture'
import { openFixture } from './support/fixtures'
import type { Page } from './support/fixture'

/**
 * EW-03I-b — the CSV review journey against the REAL engine, in Chromium.
 *
 * The RTL legs (`apps/web/src/csv/*.test.tsx`, `App.csv-review.test.tsx`) pin
 * the copy, the option matrix and the adoption contract with a faked engine
 * boundary. This spec proves the parts only a real browser can: the review
 * reads the committed fixture through DuckDB-WASM, `sniff_csv` really reports
 * the semicolon dialect, an option change really re-reads the head, and the
 * adopted open really carries the reviewed option set into `engine/open`.
 *
 * The `engine/open` / `engine/csv-preview` requests are observed by wrapping
 * `Worker.prototype.postMessage` in an init script (the `open-cancel.spec.ts`
 * precedent) and reading the messages back — so "the reviewed options rode the
 * adoption" and "quick open sends no options field at all" are asserted on the
 * WIRE, not inferred from rendering.
 *
 * No copy is imported from the app: the literals below are the independent
 * pins. Nothing here asserts a filename in the app's UI (ADR 0025).
 */

const SEMICOLON_FIXTURE = path.join(process.cwd(), 'fixtures', 'csv', 'semicolon.csv')
const CUSTOMERS_FIXTURE = path.join(process.cwd(), 'fixtures', 'csv', 'customers.csv')

const REVIEW_ACTION = 'Review CSV options…'
const ADOPT = 'Open this file'
const STOP = 'Stop reviewing'
const STOPPED_IDLE = 'You stopped reviewing. Nothing was opened.'
const SAMPLE_CAP = 'Sample cap: the first 50 rows of the file.'
const PROHIBITED_WORDING = /validated|checked|verified|confirmed/i

/** One observed engine request (only the fields this spec asserts). */
interface ObservedRequest {
  readonly type: string
  /** True when the message carried an `options` field at all. */
  readonly hasOptions: boolean
  readonly options: Record<string, unknown> | null
  readonly sampleRows: number | null
}

type ProbeWindow = typeof window & {
  __assayCsvProbe?: { requests: ObservedRequest[] }
}

test.beforeEach(async ({ page }) => {
  // The hidden-input fallback is the picker path every spec drives.
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
    } catch {
      // A non-configurable global would fail loudly at the chooser instead.
    }
    const probe: { requests: ObservedRequest[] } = { requests: [] }
    ;(window as ProbeWindow).__assayCsvProbe = probe
    const prototype = Worker.prototype as unknown as {
      postMessage: (message: unknown, transfer?: Transferable[]) => void
    }
    const originalPostMessage = prototype.postMessage
    prototype.postMessage = function postMessage(
      this: Worker,
      message: unknown,
      transfer?: Transferable[],
    ): void {
      if (typeof message === 'object' && message !== null) {
        const request = message as { type?: unknown; options?: unknown; sampleRows?: unknown }
        if (typeof request.type === 'string') {
          if (request.type === 'engine/open' || request.type === 'engine/csv-preview') {
            probe.requests.push({
              type: request.type,
              hasOptions: Object.prototype.hasOwnProperty.call(request, 'options'),
              options: (request.options as Record<string, unknown> | undefined) ?? null,
              sampleRows: typeof request.sampleRows === 'number' ? request.sampleRows : null,
            })
          }
        }
      }
      originalPostMessage.call(this, message, transfer)
    }
  })
})

function observed(page: Page): Promise<readonly ObservedRequest[]> {
  return page.evaluate(() => (window as ProbeWindow).__assayCsvProbe?.requests ?? []) as Promise<
    readonly ObservedRequest[]
  >
}

async function waitForPhase(page: Page, phase: 'idle' | 'ready'): Promise<void> {
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', phase, {
    timeout: 20_000,
  })
}

/** Open the review through the idle control and pick `fixturePath`. */
async function openIdleReview(page: Page, fixturePath: string): Promise<void> {
  await page.goto('/')
  await waitForPhase(page, 'idle')
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('csv-review-button').click()
  const chooser = await chooserPromise
  await chooser.setFiles(fixturePath)
  await expect(page.getByTestId('csv-review')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('csv-review-sample-table')).toBeVisible({ timeout: 20_000 })
}

test('the review reads the semicolon fixture, follows an option change, and adopts it', async ({
  page,
}) => {
  await openIdleReview(page, SEMICOLON_FIXTURE)

  // The review is non-adopting and honest about the sample it can offer.
  await expect(page.getByTestId('csv-review-scope')).toHaveText(
    'This review opens nothing. The file stays a candidate until you choose Open this file.',
  )
  await expect(page.getByTestId('csv-review-sample-cap')).toHaveText(SAMPLE_CAP)
  await expect(page.getByTestId('csv-review-sample-scope')).toContainText(
    'A sample is not an evaluation of the whole file.',
  )
  // ADR 0049 item 6: no verdict wording anywhere on a successful sample.
  expect(await page.getByTestId('csv-review').innerText()).not.toMatch(PROHIBITED_WORDING)

  // The reader's own dialect for this fixture: ';' and three columns.
  await expect(page.getByTestId('csv-review-sniff-delimiter')).toHaveText(';')
  await expect(page.getByTestId('csv-review-sniff-column')).toHaveCount(3)
  await expect(page.getByTestId('csv-review-sniff-column-name').first()).toHaveText('id')
  await expect(page.getByTestId('csv-review-sample-column-name')).toHaveCount(3)
  await expect(page.getByTestId('csv-review-sample-row')).toHaveCount(2)

  // Nothing has been opened yet, and a preview request carries the sample cap.
  await expect(page.getByTestId('csv-review-adopt')).toHaveText(ADOPT)
  await expect(page.getByTestId('csv-review-stop')).toHaveText(STOP)
  let requests = await observed(page)
  expect(requests.filter((request) => request.type === 'engine/open')).toHaveLength(0)
  const firstPreview = requests.find((request) => request.type === 'engine/csv-preview')
  expect(firstPreview?.sampleRows).toBe(50)
  expect(firstPreview?.hasOptions).toBe(false)

  // Override the delimiter: the disclosure and the sample follow it.
  await page.getByTestId('csv-review-delim').fill(',')
  await page.getByTestId('csv-review-update').click()
  await expect(page.getByTestId('csv-review-sniff-delimiter')).toHaveText(',', { timeout: 20_000 })
  await expect(page.getByTestId('csv-review-sniff-column')).toHaveCount(1, { timeout: 20_000 })
  await expect(page.getByTestId('csv-review-sample-column-name')).toHaveCount(1)
  // The effective-option disclosure states what the read actually composed.
  await expect(page.getByTestId('csv-review-effective-delim')).toHaveText(',')

  // Adoption: one open, and it carries the reviewed option set on the wire.
  await page.getByTestId('csv-review-adopt').click()
  await waitForPhase(page, 'ready')
  requests = await observed(page)
  const opens = requests.filter((request) => request.type === 'engine/open')
  expect(opens).toHaveLength(1)
  expect(opens[0]?.hasOptions).toBe(true)
  expect(opens[0]?.options).toEqual({ delim: ',' })
  // The override is visible in the dataset: the engine's own ';' sniff would
  // have produced three columns.
  await expect(page.getByTestId('grid-column-count')).toHaveText('1')
  // Phase only: the review surface is gone and did not become a session.
  await expect(page.getByTestId('csv-review')).toHaveCount(0)
})

test('stopping a review opens nothing and says so', async ({ page }) => {
  await openIdleReview(page, SEMICOLON_FIXTURE)
  await page.getByTestId('csv-review-stop').click()
  await expect(page.getByTestId('csv-review')).toHaveCount(0)
  await expect(page.getByTestId('csv-review-stopped')).toHaveText(STOPPED_IDLE)
  await waitForPhase(page, 'idle')
  const requests = await observed(page)
  expect(requests.filter((request) => request.type === 'engine/open')).toHaveLength(0)
})

test('quick open stays the default and sends no options field', async ({ page }) => {
  await page.goto('/')
  await waitForPhase(page, 'idle')
  // The default control is present and unchanged beside the review entry.
  await expect(page.getByTestId('open-button')).toHaveText('Open a data file…')
  await expect(page.getByTestId('csv-review-button')).toHaveText(REVIEW_ACTION)
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('open-button').click()
  const chooser = await chooserPromise
  await chooser.setFiles(SEMICOLON_FIXTURE)
  await waitForPhase(page, 'ready')
  // No review surface, no preview call, and a request with no options field.
  await expect(page.getByTestId('csv-review')).toHaveCount(0)
  const requests = await observed(page)
  expect(requests.some((request) => request.type === 'engine/csv-preview')).toBe(false)
  const opens = requests.filter((request) => request.type === 'engine/open')
  expect(opens).toHaveLength(1)
  expect(opens[0]?.hasOptions).toBe(false)
  // The reader's own sniff (three columns) is what the default path uses.
  await expect(page.getByTestId('grid-column-count')).toHaveText('3')
  await expect(page.getByTestId('grid-total-rows')).toHaveText('2')
})

test('a ready session reviews a CSV and adopts it through the existing replacement path', async ({
  page,
}) => {
  // A live session first (quick open of the committed customers CSV).
  await page.goto('/')
  await waitForPhase(page, 'idle')
  const firstChooser = page.waitForEvent('filechooser')
  await page.getByTestId('open-button').click()
  await (await firstChooser).setFiles(CUSTOMERS_FIXTURE)
  await waitForPhase(page, 'ready')
  const liveRows = await page.getByTestId('grid-total-rows').innerText()

  // The review runs in a ready session without touching it.
  const reviewChooser = page.waitForEvent('filechooser')
  await page.getByTestId('csv-review-open').click()
  await (await reviewChooser).setFiles(SEMICOLON_FIXTURE)
  await expect(page.getByTestId('csv-review')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('csv-review-sample-table')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('csv-review-adopt-helper')).toHaveText(
    'Opens the file with the options this sample used and replaces this session.',
  )
  // Catalog-neutral in the session sense: nothing adopted, nothing replaced.
  await waitForPhase(page, 'ready')
  await expect(page.getByTestId('grid-total-rows')).toHaveText(liveRows)
  expect((await observed(page)).filter((request) => request.type === 'engine/open')).toHaveLength(1)

  // Review an override of the reader's own guess, then adopt it.
  await page.getByTestId('csv-review-delim').fill(',')
  await page.getByTestId('csv-review-update').click()
  await expect(page.getByTestId('csv-review-sniff-delimiter')).toHaveText(',', { timeout: 20_000 })

  await page.getByTestId('csv-review-adopt').click()
  await waitForPhase(page, 'ready')
  await expect(page.getByTestId('csv-review')).toHaveCount(0)
  const requests = await observed(page)
  const opens = requests.filter((request) => request.type === 'engine/open')
  expect(opens).toHaveLength(2)
  // The adopted set is the reviewed one, and `sample_size` never rides it.
  expect(opens[1]?.options).toEqual({ delim: ',' })
  await expect(page.getByTestId('grid-column-count')).toHaveText('1')
})

test('stopping a review inside a ready session leaves the session as it is', async ({ page }) => {
  await page.goto('/')
  await waitForPhase(page, 'idle')
  const firstChooser = page.waitForEvent('filechooser')
  await page.getByTestId('open-button').click()
  await (await firstChooser).setFiles(CUSTOMERS_FIXTURE)
  await waitForPhase(page, 'ready')
  const liveRows = await page.getByTestId('grid-total-rows').innerText()

  const reviewChooser = page.waitForEvent('filechooser')
  await page.getByTestId('csv-review-open').click()
  await (await reviewChooser).setFiles(SEMICOLON_FIXTURE)
  await expect(page.getByTestId('csv-review')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('csv-review-sample-table')).toBeVisible({ timeout: 20_000 })

  await page.getByTestId('csv-review-stop').click()
  await expect(page.getByTestId('csv-review-stopped')).toHaveText(
    'You stopped reviewing. Nothing was opened. This session is unchanged.',
  )
  await waitForPhase(page, 'ready')
  await expect(page.getByTestId('grid-total-rows')).toHaveText(liveRows)
  expect((await observed(page)).filter((request) => request.type === 'engine/open')).toHaveLength(1)
})

test('a refused option never reaches the engine', async ({ page }) => {
  await openIdleReview(page, SEMICOLON_FIXTURE)
  await page.getByTestId('csv-review-sample-size').fill('-1')
  await expect(page.getByTestId('csv-review-refusal')).toContainText('CSV option sample_size = -1')
  await expect(page.getByTestId('csv-review-update')).toBeDisabled()
  await expect(page.getByTestId('csv-review-adopt')).toBeDisabled()
  const previews = (await observed(page)).filter((request) => request.type === 'engine/csv-preview')
  // The only preview is the initial one: the refused set was never dispatched.
  expect(previews).toHaveLength(1)
  // The older sample stays on screen but is marked as no longer matching the
  // form — it is never presented as current.
  await expect(page.getByTestId('csv-review-stale')).toBeVisible()
})

/* ---- Catalog neutrality, both directions (EW-03I-b done-when 6) -------------
 *
 * The preview's registration is proven not to grow the USER catalog, and the
 * same probe is proven not to be vacuous: adoption — a fresh `engine/open` —
 * moves it. Both are read through the app's own SQL surface in a READY session
 * (the only place that surface exists), on the real engine:
 *
 *   SELECT count(*) FROM duckdb_tables() WHERE NOT internal
 *   SELECT count(*) FROM duckdb_views()  WHERE NOT internal
 *
 * A session relation is a VIEW (`CREATE VIEW "assay_tN"`), so the expected
 * adoption delta is +1 view / +0 tables — and the retired session's view is
 * RETAINED (ADR 0047), so it is a true increment rather than a drop-and-add.
 * A proxy ("engine/open was not called") would not satisfy this leg; the
 * counts come from the catalog itself.
 */

/** The one-cell result of a catalog query, after running it. */
async function runCatalogQuery(
  page: Page,
  catalog: 'duckdb_tables' | 'duckdb_views',
): Promise<import('@playwright/test').Locator> {
  const sql = `SELECT count(*) FROM ${catalog}() WHERE NOT internal`
  const input = page.getByTestId('sql-input')
  // Type-then-run is retried as one unit: a new dataset session clears the SQL
  // pane's draft shortly after a replacement, and a fill that lands inside that
  // window would be discarded (pre-existing session-scoped behaviour, not this
  // row's).
  await expect(async () => {
    await input.fill(sql)
    await expect(input).toHaveValue(sql)
    await expect(page.getByTestId('sql-run')).toBeEnabled()
  }).toPass({ timeout: 20_000 })
  await page.getByTestId('sql-run').click()
  return page
    .locator('[data-testid="sql-result-row"]')
    .first()
    .locator('[data-testid="sql-result-cell"]')
    .first()
}

/** The SQL-facing count of one user-catalog function, read as a number. */
async function readUserCatalogCount(
  page: Page,
  catalog: 'duckdb_tables' | 'duckdb_views',
): Promise<number> {
  const cell = await runCatalogQuery(page, catalog)
  await expect(cell).toHaveText(/^\d+$/, { timeout: 20_000 })
  return Number(await cell.innerText())
}

/** The same probe, asserting an exact value (retried until it holds). */
async function expectUserCatalogCount(
  page: Page,
  catalog: 'duckdb_tables' | 'duckdb_views',
  expected: number,
): Promise<void> {
  const cell = await runCatalogQuery(page, catalog)
  await expect(cell).toHaveText(String(expected), { timeout: 20_000 })
}

test('a preview leaves the user catalog unchanged, and adoption moves it', async ({ page }) => {
  // A live session (the SQL surface exists only in a ready session). It is the
  // control for both directions: one session relation already exists.
  await openFixture(page, CUSTOMERS_FIXTURE)
  const tablesBefore = await readUserCatalogCount(page, 'duckdb_tables')
  const viewsBefore = await readUserCatalogCount(page, 'duckdb_views')
  expect(viewsBefore).toBeGreaterThanOrEqual(1)
  expect((await observed(page)).filter((request) => request.type === 'engine/open')).toHaveLength(1)

  // Direction 1 — the preview registers the candidate but adds no catalog
  // object. Assert the preview really landed before stopping (a vacuous probe
  // would leave the sample unread).
  const previewsBefore = (await observed(page)).filter(
    (request) => request.type === 'engine/csv-preview',
  ).length
  const reviewChooser = page.waitForEvent('filechooser')
  await page.getByTestId('csv-review-open').click()
  await (await reviewChooser).setFiles(SEMICOLON_FIXTURE)
  await expect(page.getByTestId('csv-review-sample-table')).toBeVisible({ timeout: 20_000 })
  await expect
    .poll(
      async () =>
        (await observed(page)).filter((request) => request.type === 'engine/csv-preview').length,
      { timeout: 20_000 },
    )
    .toBeGreaterThan(previewsBefore)
  await page.getByTestId('csv-review-stop').click()
  await expect(page.getByTestId('csv-review')).toHaveCount(0)
  await expectUserCatalogCount(page, 'duckdb_tables', tablesBefore)
  await expectUserCatalogCount(page, 'duckdb_views', viewsBefore)

  // Direction 2 — adoption DOES move it, so the probe above is not vacuous:
  // exactly one new user view (the adopted session relation), no user table,
  // and the previous session's view retained (ADR 0047).
  const adoptChooser = page.waitForEvent('filechooser')
  await page.getByTestId('csv-review-open').click()
  await (await adoptChooser).setFiles(SEMICOLON_FIXTURE)
  await expect(page.getByTestId('csv-review-sample-table')).toBeVisible({ timeout: 20_000 })
  await page.getByTestId('csv-review-adopt').click()
  await waitForPhase(page, 'ready')
  await expect(page.getByTestId('csv-review')).toHaveCount(0)
  // The adopted session clears the SQL pane's draft; wait for that reset so the
  // catalog reads below are typed into the settled pane.
  await expect(page.getByTestId('sql-input')).toHaveValue('', { timeout: 15_000 })
  await expectUserCatalogCount(page, 'duckdb_tables', tablesBefore)
  await expectUserCatalogCount(page, 'duckdb_views', viewsBefore + 1)
})
