import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  DEFERRED_A11Y,
  assertNoCriticalOrSerious,
  scanA11y,
  summarizeViolations,
} from './support/a11y'
import { writeValidationDatasetA } from './support/validation-datasets'
import { writeDiffDatasetPair } from './support/diff-datasets'
import { openFixture } from './support/fixtures'

// pt0-4 (O3): real axe-core scans of the four load-bearing surfaces — grid
// with a fixture open, the schema tree expanded, the validation report, and
// the diff report — plus a non-vacuity canary proving the scanner is alive.
//
// Each scan first drives the existing journeys (reusing the same picker
// path and dataset helpers as grid-filter-sort / schema-panel /
// validation-panel / diff-panel) so the target panel is really open and
// populated, then asserts zero UNALLOWLISTED critical/serious violations.
// Minor/moderate findings are logged but do not gate (task row bar).
//
// The canary injects a nameless <button> (axe `button-name`, critical) into a
// fresh per-test page, scans it, and asserts the scanner reports it AND that
// the gate helper rejects it — if the scanner silently stopped working
// (blank-page scans, removed scan targets), this test fails loudly.
//
// Privacy (ADR 0025): everything runs on synthetic/committed fixtures in the
// local Chromium; axe-core is bundled and makes no network calls.

const FIXTURES_DIR = path.join(process.cwd(), 'fixtures')
const CSV_FIXTURE = path.join(FIXTURES_DIR, 'csv', 'customers.csv')
const NESTED_FIXTURE = path.join(FIXTURES_DIR, 'parquet', 'nested.parquet')

test.beforeEach(async ({ page }) => {
  // Hidden-<input type="file"> fallback (m1-5 pattern): Playwright's
  // filechooser event reaches the input, not window.showOpenFilePicker.
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
      delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker
    } catch {
      // Non-configurable globals would be a Chromium change; fail loudly at
      // the chooser rather than silently taking a different path.
    }
  })
})

/** Run axe over the whole page, log all impacts, and gate on critical/serious. */
async function scanAndGate(page: Page, target: string): Promise<void> {
  const results = await scanA11y(page)
  console.log(`[a11y] ${target}\n${summarizeViolations(results.violations)}`)
  assertNoCriticalOrSerious(results.violations)
}

test('grid with a fixture open has no unallowlisted critical/serious violations', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await openFixture(page, CSV_FIXTURE, { assertFileNameHidden: true })

  // Non-vacuity: the grid is populated before we scan it.
  await expect(page.getByTestId('grid')).toBeVisible()
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')
  await expect(page.locator('[data-testid="grid-row"][data-status="ready"]')).toHaveCount(5)

  await scanAndGate(page, 'grid (customers.csv)')
})

test('expanded schema tree has no unallowlisted critical/serious violations', async ({ page }) => {
  test.setTimeout(120_000)
  await openFixture(page, NESTED_FIXTURE, { assertFileNameHidden: true })

  // Non-vacuity: the nested struct subtree is actually expanded before scanning.
  await expect(page.getByTestId('schema-panel')).toBeVisible()
  await expect(page.getByTestId('schema-column')).toHaveCount(2)
  const payloadToggle = page.getByRole('button', { name: 'payload STRUCT' })
  await payloadToggle.click()
  await expect(payloadToggle).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByTestId('schema-field')).toHaveCount(4)

  await scanAndGate(page, 'schema tree (nested.parquet payload)')
})

test('populated validation report has no unallowlisted critical/serious violations', async ({
  page,
}) => {
  test.setTimeout(240_000)
  const dataset = writeValidationDatasetA()
  await openFixture(page, dataset.dataPath, { assertFileNameHidden: true })
  await expect(page.getByTestId('grid-total-rows')).toHaveText('7')

  // Import the contract and run the real validation op.
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('validation-open-contract').click()
  await (await chooserPromise).setFiles(dataset.contractPath)
  await expect(page.getByTestId('validation-contract-name')).toHaveText('orders-basic')
  await page.getByTestId('validation-run').click()
  await expect(page.getByTestId('validation-verdict')).toHaveText(
    '4 of 9 rules fail (7 rows checked).',
  )

  // Non-vacuity: the report is populated with failing rule rows before scanning.
  await expect(page.getByTestId('validation-rule')).toHaveCount(9)
  await expect(page.getByTestId('validation-sample').first()).toBeVisible()

  await scanAndGate(page, 'validation report (4/9 failing)')
})

test('completed diff report has no unallowlisted critical/serious violations', async ({ page }) => {
  test.setTimeout(240_000)
  const pair = writeDiffDatasetPair()
  await openFixture(page, pair.aPath, { assertFileNameHidden: true })
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')

  // Stage side B, confirm the inferred key (default: id), and run the diff.
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('diff-open-comparison').click()
  await (await chooserPromise).setFiles(pair.bPath)
  await expect(page.getByTestId('diff-comparison-rows')).toHaveText('5 rows')
  await page.getByTestId('diff-run').click()
  await expect(page.getByTestId('diff-verdict')).toContainText('2 added, 2 removed, 2 changed')

  // Non-vacuity: the report has populated aspects and samples before scanning.
  await expect(page.getByTestId('diff-aspect')).toHaveCount(3)
  await expect(page.getByTestId('diff-sample').first()).toBeVisible()

  await scanAndGate(page, 'diff report (2/2/2)')
})

test('canary: axe reports an injected nameless button and the gate rejects it', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await page.goto('/')
  await expect(page.getByTestId('open-status')).toHaveText('idle', { timeout: 20_000 })

  // Inject a deliberately inaccessible control into this test's own page
  // (fresh context per test — no cross-test pollution).
  await page.evaluate(() => {
    const broken = document.createElement('button')
    broken.type = 'button'
    broken.id = 'a11y-canary-broken'
    // No text/content → no accessible name: axe `button-name` (critical).
    document.body.appendChild(broken)
  })

  const results = await scanA11y(page, { include: ['#a11y-canary-broken'] })
  console.log(`[a11y] canary\n${summarizeViolations(results.violations)}`)

  const canary = results.violations.find((violation) => violation.id === 'button-name')
  expect(canary, 'axe must report the injected nameless button').toBeDefined()
  expect(canary?.impact).toBe('critical')
  expect(canary?.nodes.length).toBeGreaterThan(0)

  // And the gate helper must NOT swallow it (proves "zero violations" is a
  // live assertion, not a disabled scanner).
  expect(() => {
    assertNoCriticalOrSerious(results.violations, DEFERRED_A11Y)
  }).toThrow()
})
