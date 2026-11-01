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
import { openFixture, openFilterBar, openFixtureAndGetTableId } from './support/fixtures'
import {
  bindContract,
  bindSourceDataset,
  openNodePreview,
  openPipelineDocument,
  pipelineNode,
  runPipelineToCompletion,
  runPipelineToGate,
  writeGatePipelineFixture,
} from './support/pipeline-panel'

// pt0-4 (O3): real axe-core scans of the four load-bearing surfaces — grid
// with a fixture open, the schema tree expanded, the validation report, and
// the diff report — plus a non-vacuity canary proving the scanner is alive.
//
// q-2: every scan now runs in BOTH colour schemes. Contrast is checked per
// scheme by axe, so the dark-mode tokens must clear AA independently of the
// light values (a dark-mode contrast failure is a q-2 defect — fix the token,
// never the scan). The same journeys and the same empty allowlist apply.
//
// Each scan first drives the existing journeys (reusing the same picker
// path and dataset helpers as grid-filter-sort / schema-panel /
// validation-panel / diff-panel) so the target panel is really open and
// populated, then asserts zero UNALLOWLISTED critical/serious violations.
// Minor/moderate findings are logged but do not gate (task row bar).
//
// uxc-3: the grid scan additionally drives the expanded ux-4 filter bar into
// its builder, fragment-escape-hatch, and client-side rejection states before
// scanning, so the promoted scan exercises the whole expanded bar (both
// schemes), not just the collapsed summary.
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
async function scanAndGate(page: Page, target: string, scheme: 'light' | 'dark'): Promise<void> {
  // Non-vacuity for the dark pass: prove the emulated scheme really reached
  // the page, so a dark scan cannot silently re-run the light one.
  const prefersDark = await page.evaluate(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  )
  expect(prefersDark, `emulated colour scheme must be ${scheme}`).toBe(scheme === 'dark')

  const results = await scanA11y(page)
  console.log(`[a11y] ${target}\n${summarizeViolations(results.violations)}`)
  assertNoCriticalOrSerious(results.violations)
}

/**
 * uxc-3: drive the expanded ux-4 filter bar into the three scan-relevant
 * states — an applied type-aware compose-row filter (operator + value controls
 * and an active chip), the populated SQL-fragment escape hatch, and a readable
 * client-side rejection message — asserting each is really visible so a
 * silently-collapsed bar cannot false-pass the promoted scan. Every value is
 * synthetic customers.csv fixture data only (ADR 0025).
 *
 * Interaction patterns mirror tests/e2e/filter-builder.spec.ts. ug-18
 * (UG-16/UG-17) replaced the per-column builder wall with one compose row and
 * moved the SQL-fragment inputs behind their own `SQL predicates` disclosure,
 * so this helper drives those two surfaces explicitly.
 */
async function expandFilterBarStates(page: Page): Promise<void> {
  await openFilterBar(page)

  const composeColumn = page.getByTestId('filter-compose-column')
  const composeOperator = page.getByTestId('filter-compose-operator')
  const composeValue = page.getByTestId('filter-compose-value')
  const composeApply = page.getByTestId('filter-compose-apply')
  // Scoped to the column the rejection is about (`data-col-name` on the
  // single-line builder error), so the association survives any future error
  // element in the bar — the same scoping the old per-column builder carried.
  const builderError = page.locator('[data-testid="filter-builder-error"][data-col-name="income"]')

  // Builder state: numeric `income > 50000` (type-aware operator + value input).
  await expect(composeOperator).toBeVisible()
  await composeColumn.selectOption('income')
  await composeOperator.selectOption('gt')
  await composeValue.fill('50000')
  await composeApply.click()
  await expect(page.locator('[data-testid="filter-chip"][data-col-name="income"] code')).toHaveText(
    'income > 50000',
  )
  // Non-vacuity: the applied builder filter really narrowed the grid, which
  // therefore has populated rows while the expanded bar is scanned.
  await expect(page.getByTestId('grid-total-rows')).toHaveText('3')
  await expect(page.locator('[data-testid="grid-row"][data-status="ready"]')).toHaveCount(3)

  // Fragment mode: the SQL escape hatch is its own disclosure; open it and
  // populate it (synthetic predicate) but do not apply — applying would
  // replace the builder filter the scan is meant to see.
  const disclosure = page.getByTestId('filter-sql-disclosure')
  if ((await disclosure.getAttribute('open')) === null) {
    await disclosure.locator('summary').click()
  }
  const fragment = page.locator('[data-testid="filter-input"][data-col-name="country"]')
  await expect(fragment).toBeVisible()
  await fragment.fill("= 'US'")
  await expect(fragment).toHaveValue("= 'US'")
  await expect(page.locator('[data-testid="filter-apply"][data-col-name="country"]')).toBeVisible()

  // Rejection state: an invalid numeric value is rejected client-side and the
  // readable inline alert (role=alert) is on screen before we scan.
  await expect(composeValue).toBeEnabled()
  await composeValue.fill('abc')
  await composeApply.click()
  await expect(builderError).toBeVisible()
  await expect(builderError).toHaveText('That is not a number.')
}

/**
 * Register the four load-bearing scans for one colour scheme. Called once per
 * `test.describe` so `test.use({ colorScheme })` scopes each run; the journey
 * bodies are identical across schemes (only the resolved tokens differ).
 */
function defineScans(scheme: 'light' | 'dark'): void {
  test(`[${scheme}] zero-result state has no unallowlisted critical/serious violations`, async ({
    page,
  }) => {
    test.setTimeout(180_000)
    // ug-19 (UG-37): the empty-state token sweep's driven scan. A filter that
    // matches nothing is a real, reachable state — it is where empty-state copy
    // renders — so it gets the same both-scheme, empty-allowlist bar as the
    // populated surfaces. No allowlist entry is added and no text size changes.
    const tableId = await openFixtureAndGetTableId(page, CSV_FIXTURE, {
      assertFileNameHidden: true,
    })
    await expect(page.getByTestId('grid-total-rows')).toHaveText('5')

    // 1. The grid's existing zero-result state: a compose-row filter that
    // matches no fixture row leaves the grid with zero rows and no copy of its
    // own (the honest counter is the empty state).
    await openFilterBar(page)
    await page.getByTestId('filter-compose-column').selectOption('country')
    await page.getByTestId('filter-compose-operator').selectOption('eq')
    await page.getByTestId('filter-compose-value').fill('ZZ')
    await page.getByTestId('filter-compose-apply').click()
    await expect(page.getByTestId('grid-total-rows')).toHaveText('0')
    await expect(page.locator('[data-testid="grid-row"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="filter-chip"] code').first()).toHaveText(
      "country = 'ZZ'",
    )

    // 2. The SQL pane's empty-result state renders the moved empty-state rule
    // (`.sql-result-empty`: ug-19 took it off `--color-text-faint`, which
    // measured 4.29:1 on this surface) so the scan really covers it.
    const sqlTable = `assay_${tableId}`
    await page
      .getByTestId('sql-input')
      .fill(`SELECT country FROM "${sqlTable}" WHERE country = 'ZZ'`)
    await page.getByTestId('sql-run').click()
    await expect(page.getByTestId('sql-panel')).toHaveAttribute('data-state', 'done')
    await expect(page.getByTestId('sql-result-empty')).toBeVisible()

    await scanAndGate(
      page,
      `zero-result grid + SQL empty result (customers.csv, ${scheme})`,
      scheme,
    )
  })

  test(`[${scheme}] grid with a fixture open and the filter bar expanded has no unallowlisted critical/serious violations`, async ({
    page,
  }) => {
    test.setTimeout(120_000)
    await openFixture(page, CSV_FIXTURE, { assertFileNameHidden: true })

    // Non-vacuity: the grid is populated before we scan it.
    await expect(page.getByTestId('grid')).toBeVisible()
    await expect(page.getByTestId('grid-total-rows')).toHaveText('5')
    await expect(page.locator('[data-testid="grid-row"][data-status="ready"]')).toHaveCount(5)

    // uxc-3: promote the expanded ux-4 filter bar into the durable scan. The
    // helper expands the bar and asserts its builder, fragment, and rejection
    // states are really visible (and the grid still populated) before scanning.
    await expandFilterBarStates(page)

    await scanAndGate(page, `grid + expanded filter bar (customers.csv, ${scheme})`, scheme)
  })

  test(`[${scheme}] expanded schema tree has no unallowlisted critical/serious violations`, async ({
    page,
  }) => {
    test.setTimeout(120_000)
    await openFixture(page, NESTED_FIXTURE, { assertFileNameHidden: true })

    // Non-vacuity: the nested struct subtree is actually expanded before scanning.
    await expect(page.getByTestId('schema-panel')).toBeVisible()
    await expect(page.getByTestId('schema-column')).toHaveCount(2)
    const payloadToggle = page.getByRole('button', { name: 'payload STRUCT' })
    await payloadToggle.click()
    await expect(payloadToggle).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByTestId('schema-field')).toHaveCount(4)

    await scanAndGate(page, `schema tree (nested.parquet payload, ${scheme})`, scheme)
  })

  test(`[${scheme}] populated validation report has no unallowlisted critical/serious violations`, async ({
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

    await scanAndGate(page, `validation report (4/9 failing, ${scheme})`, scheme)
  })

  test(`[${scheme}] completed diff report has no unallowlisted critical/serious violations`, async ({
    page,
  }) => {
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

    await scanAndGate(page, `diff report (2/2/2, ${scheme})`, scheme)
  })

  test(`[${scheme}] completed pipeline run has no unallowlisted critical/serious violations`, async ({
    page,
  }) => {
    test.setTimeout(240_000)
    // The p-6 surface in its richest honest state: the golden pipeline
    // opened, its source bound (C2 pick), the run completed with per-node
    // counts, and the grid-native preview open (p2-6 ruling: the allowlist
    // stays empty for the new surface).
    await openPipelineDocument(page)
    await expect(page.getByTestId('pipeline-source-pending')).toBeVisible()
    await bindSourceDataset(page)
    await runPipelineToCompletion(page)
    await openNodePreview(page, 'by_country')

    // Non-vacuity: the ordered node list is populated with settled statuses
    // and the preview grid is rendered before scanning.
    await expect(page.locator('[data-testid="pipeline-node"]')).toHaveCount(4)
    await expect(
      page.locator('[data-testid="pipeline-node"][data-node-status="done"]'),
    ).toHaveCount(4)
    await expect(page.getByTestId('pipeline-preview-grid')).toBeVisible()
    await expect(page.getByTestId('pipeline-lineage-nodes')).toBeVisible()

    await scanAndGate(page, `pipeline panel (run completed + preview, ${scheme})`, scheme)
  })

  test(`[${scheme}] gated pipeline run has no unallowlisted critical/serious violations`, async ({
    page,
  }) => {
    test.setTimeout(240_000)
    // The p2-6 gated surface: the run stopped at the blocked publish, with
    // the failed validate verdict and blocked-gate detail rendered.
    const fixture = writeGatePipelineFixture()
    await openPipelineDocument(page, fixture.pipelinePath)
    await bindSourceDataset(page)
    await bindContract(page, fixture.failingContractPath)
    await runPipelineToGate(page)

    await expect(page.getByTestId('pipeline-run-gated')).toBeVisible()
    await expect(pipelineNode(page, 'gate').getByTestId('pipeline-node-gate')).toContainText(
      'Validate: failed',
    )
    await scanAndGate(page, `pipeline panel (gated, ${scheme})`, scheme)
  })
}

/**
 * pt0-4/q-15: the <1024px stack viewport class. ADR 0044 mitigates the extra
 * class by keeping it to the existing 900px pin plus a journey smoke — the
 * grid + expanded filter bar and the populated validation report, both
 * schemes — so the empty allowlist holds at BOTH viewport classes (the ≥1024
 * scans are the `defineScans` set above).
 */
function defineNarrowScans(scheme: 'light' | 'dark'): void {
  test(`[${scheme}] 900px grid + expanded filter bar has no unallowlisted critical/serious violations`, async ({
    page,
  }) => {
    test.setTimeout(120_000)
    await page.setViewportSize({ width: 900, height: 900 })
    await openFixture(page, CSV_FIXTURE, { assertFileNameHidden: true })
    await expect(page.getByTestId('grid')).toBeVisible()
    await expect(page.getByTestId('grid-total-rows')).toHaveText('5')
    await expandFilterBarStates(page)
    await scanAndGate(page, `900px grid + expanded filter bar (${scheme})`, scheme)
  })

  test(`[${scheme}] 900px populated validation report has no unallowlisted critical/serious violations`, async ({
    page,
  }) => {
    test.setTimeout(240_000)
    await page.setViewportSize({ width: 900, height: 900 })
    const dataset = writeValidationDatasetA()
    await openFixture(page, dataset.dataPath, { assertFileNameHidden: true })
    await expect(page.getByTestId('grid-total-rows')).toHaveText('7')

    const chooserPromise = page.waitForEvent('filechooser')
    await page.getByTestId('validation-open-contract').click()
    await (await chooserPromise).setFiles(dataset.contractPath)
    await expect(page.getByTestId('validation-contract-name')).toHaveText('orders-basic')
    await page.getByTestId('validation-run').click()
    await expect(page.getByTestId('validation-verdict')).toHaveText(
      '4 of 9 rules fail (7 rows checked).',
    )
    await expect(page.getByTestId('validation-rule')).toHaveCount(9)

    await scanAndGate(page, `900px validation report (4/9 failing, ${scheme})`, scheme)
  })
}

test.describe('axe scans — light scheme', () => {
  test.use({ colorScheme: 'light' })
  defineScans('light')
})

test.describe('axe scans — dark scheme', () => {
  test.use({ colorScheme: 'dark' })
  defineScans('dark')
})

test.describe('axe scans at 900px — light scheme', () => {
  test.use({ colorScheme: 'light' })
  defineNarrowScans('light')
})

test.describe('axe scans at 900px — dark scheme', () => {
  test.use({ colorScheme: 'dark' })
  defineNarrowScans('dark')
})

test('canary: axe reports an injected nameless button and the gate rejects it', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await page.goto('/')
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'idle', {
    timeout: 20_000,
  })

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
