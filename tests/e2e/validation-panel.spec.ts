import { mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { parseContract } from '../../packages/contracts/src/index.ts'
import { writeValidationDatasetA } from './support/validation-datasets'
import { expandAllSections, openFixture } from './support/fixtures'

// m5-3 journey 1 (handoff §6 done-when): open a dirty dataset → import a
// contract → validate → EXACT counts → jump to a failing row → fix the cell
// via M4 editing → re-validate → clean. The app under test is the real
// composition root; the engine is the real DuckDB-WASM validate op on the
// query lane; the contract is compiled by the real m5-1 compiler against
// the effective schema; every expected number below is CLI-derived (see
// support/validation-datasets.ts).
//
// Pinned beyond the counts: the severity ordering (failing before passing,
// dataset facts before row rules, frozen failPercent desc, ruleId asc), the
// honest zero-states (per-rule "0 of 7 rows", the final "Valid: 0 violations
// across 9 rules"), values rendered as text with an explicit NULL marker,
// the stale-verdict banner after every edit (m4-3 verdict freshness), and
// the privacy sweep (no file names in the page).
//
// The dataset rides the hidden-input fallback (m1-5 pattern), so BOTH pick
// gestures (dataset, contract) arrive as filechooser events.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
    } catch {
      // Non-configurable global would be a Chromium change; fail loudly later.
    }
  })
})

async function openDataset(page: Page, dataPath: string, contractPath: string): Promise<void> {
  await page.goto('/')
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'idle', {
    timeout: 20_000,
  })

  let chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('open-button').click()
  await (await chooserPromise).setFiles(dataPath)
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'ready', {
    timeout: 20_000,
  })
  await expect(page.getByTestId('grid-total-rows')).toHaveText('7')
  // q-15: expand the two-pane tool sections this journey drives (validation).
  await expandAllSections(page)

  chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('validation-open-contract').click()
  await (await chooserPromise).setFiles(contractPath)
  await expect(page.getByTestId('validation-contract-name')).toHaveText('orders-basic')
  await expect(page.getByTestId('validation-contract-info')).toContainText('9 rules')
}

function ruleRow(page: Page, ruleId: string): Locator {
  return page.locator(`[data-testid="validation-rule"][data-rule-id="${ruleId}"]`)
}

/** ruleIds of the rendered report, in on-screen (severity) order. */
async function reportOrder(page: Page): Promise<string[]> {
  const rows = page.locator('[data-testid="validation-rule"]')
  const count = await rows.count()
  const ids: string[] = []
  for (let index = 0; index < count; index++) {
    ids.push((await rows.nth(index).getAttribute('data-rule-id')) ?? '')
  }
  return ids
}

test('zero state downloads a starter contract built from the open schema', async ({ page }) => {
  test.setTimeout(120_000)
  const fixture = path.join(process.cwd(), 'fixtures', 'parquet', 'customers.parquet')
  await openFixture(page, fixture)

  // The zero state is the on-ramp: no contract is loaded yet.
  await expect(page.getByTestId('validation-contract-none')).toBeVisible()
  const starter = page.getByTestId('validation-starter-contract')
  await expect(starter).toBeVisible()
  await expect(starter).toHaveText('Download a starter contract')
  await expect(starter).toBeEnabled()

  const downloadPromise = page.waitForEvent('download')
  await starter.click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('assay-starter-contract.yaml')
  await expect(page.getByTestId('validation-starter-contract-status')).toHaveText(
    'Starter contract downloaded — edit it, then open it here.',
  )

  const dir = path.join(tmpdir(), 'assay-ug20-starter')
  mkdirSync(dir, { recursive: true })
  const target = path.join(dir, `starter-${String(Date.now())}.yaml`)
  await download.saveAs(target)
  const text = readFileSync(target, 'utf8')

  // Real contract parse, then the fixture's confidently mappable schema.
  const parsed = parseContract(text)
  if (!parsed.ok)
    throw new Error(`starter contract did not parse: ${JSON.stringify(parsed.errors)}`)
  expect(parsed.contract.metadata).toEqual({ name: 'starter-contract', version: 1 })
  expect(parsed.contract.dataset).toEqual({ minRows: 1 })
  expect(parsed.contract.columns).toEqual([
    { name: 'customer_id', type: 'BIGINT' },
    { name: 'country', type: 'VARCHAR' },
    { name: 'income', type: 'BIGINT' },
    { name: 'signup_date', type: 'DATE' },
  ])
  // No dataset identity in the document (ADR 0025).
  expect(text).not.toContain(path.basename(fixture))
})

test('open → validate → exact counts → jump to failing row → fix → re-validate → clean', async ({
  page,
}) => {
  test.setTimeout(240_000)
  const dataset = writeValidationDatasetA()
  await openDataset(page, dataset.dataPath, dataset.contractPath)
  const main = page.locator('main')

  // --- Validate: the verdict line and the EXACT per-rule counts. ---
  await page.getByTestId('validation-run').click()
  await expect(page.getByTestId('validation-verdict')).toHaveText(
    '4 of 9 rules fail (7 rows checked).',
  )
  // No stale banner on a fresh verdict.
  await expect(page.getByTestId('validation-stale')).toHaveCount(0)

  // Severity order (the documented four clauses; see report-model.ts).
  expect(await reportOrder(page)).toEqual([
    'columns[0].unique',
    'columns[0].required',
    'columns[1].allowed-values',
    'columns[2].max',
    'columns[0].type',
    'columns[1].type',
    'columns[2].type',
    'dataset.min-rows',
    'columns[1].required',
  ])

  // Exact counts — failCount AND the frozen integer failPercent.
  await expect(ruleRow(page, 'columns[0].unique').getByTestId('validation-rule-count')).toHaveText(
    '2 of 7 rows (29%)',
  )
  await expect(
    ruleRow(page, 'columns[0].required').getByTestId('validation-rule-count'),
  ).toHaveText('1 of 7 rows (14%)')
  await expect(
    ruleRow(page, 'columns[1].allowed-values').getByTestId('validation-rule-count'),
  ).toHaveText('1 of 7 rows (14%)')
  await expect(ruleRow(page, 'columns[2].max').getByTestId('validation-rule-count')).toHaveText(
    '1 of 7 rows (14%)',
  )

  // Honest zero-states: passing row rules show 0 counts; dataset facts Hold.
  await expect(
    ruleRow(page, 'columns[1].required').getByTestId('validation-rule-count'),
  ).toHaveText('0 of 7 rows (0%)')
  await expect(ruleRow(page, 'columns[0].type').getByTestId('validation-rule-count')).toHaveText(
    'Holds',
  )
  await expect(ruleRow(page, 'dataset.min-rows').getByTestId('validation-rule-count')).toHaveText(
    'Holds',
  )
  await expect(ruleRow(page, 'dataset.min-rows').getByTestId('validation-samples')).toHaveCount(0)

  // Sample-failure lists: values as text, NULL explicit, keys anchor-free.
  const uniqueSamples = ruleRow(page, 'columns[0].unique').getByTestId('validation-sample')
  await expect(uniqueSamples).toHaveCount(2)
  await expect(uniqueSamples.nth(0).getByTestId('validation-sample-key')).toHaveText('base #0')
  await expect(uniqueSamples.nth(0).getByTestId('validation-sample-value')).toHaveText('1001')
  await expect(uniqueSamples.nth(1).getByTestId('validation-sample-key')).toHaveText('base #5')
  await expect(
    ruleRow(page, 'columns[0].required').getByTestId('validation-sample-value'),
  ).toHaveText('NULL')
  await expect(
    ruleRow(page, 'columns[1].allowed-values').getByTestId('validation-sample-value'),
  ).toHaveText('emea')
  await expect(ruleRow(page, 'columns[2].max').getByTestId('validation-sample-value')).toHaveText(
    '999',
  )

  // --- Jump to the failing row: the allowed-values sample (base #2). ---
  await ruleRow(page, 'columns[1].allowed-values').getByTestId('validation-sample-jump').click()
  const jumpedRow = page.locator('[data-testid="grid-row"][data-row-index="2"]')
  await expect(jumpedRow).toHaveAttribute('data-status', 'ready')
  await expect(jumpedRow).toBeInViewport()
  // ug-12 (UG-26): the jump is announced through the SINGLE polite region in
  // the domain display grammar, and roving focus lands on the target row (not
  // on the panel button that fired the jump). The row owns the grid's tab stop.
  await expect(page.getByTestId('edit-live-region')).toHaveText(
    'Showing base #2 in the grid and record inspector',
  )
  await expect(jumpedRow).toBeFocused()
  await expect(jumpedRow).toHaveAttribute('tabindex', '0')
  // The record inspector opened on the same row and shows the offending text.
  await expect(page.getByTestId('record-inspector')).toBeVisible()
  await expect(page.getByTestId('record-inspector')).toContainText('emea')

  // --- Fix the cell via M4 editing (the row the jump targeted). ---
  await jumpedRow.getByTestId('grid-cell').nth(1).dblclick()
  const editor = page.getByTestId('grid-editor-input')
  await expect(editor).toHaveValue('emea')
  await editor.fill('EMEA')
  await editor.press('Enter')
  await expect(page.getByTestId('grid-cell-editor')).toHaveCount(0)

  // --- Verdict freshness: the edit STALES the verdict immediately. ---
  await expect(page.getByTestId('validation-stale')).toBeVisible()
  await expect(page.getByTestId('validation-stale')).toContainText('stale')
  // The stale verdict stays viewable (its counts are unchanged).
  await expect(page.getByTestId('validation-verdict')).toHaveText(
    '4 of 9 rules fail (7 rows checked).',
  )

  // --- Re-validate: exactly the fixed rule cleared. ---
  await page.getByTestId('validation-run').click()
  await expect(page.getByTestId('validation-verdict')).toHaveText(
    '3 of 9 rules fail (7 rows checked).',
  )
  await expect(page.getByTestId('validation-stale')).toHaveCount(0)
  expect(await reportOrder(page)).toEqual([
    'columns[0].unique',
    'columns[0].required',
    'columns[2].max',
    'columns[0].type',
    'columns[1].type',
    'columns[2].type',
    'dataset.min-rows',
    'columns[1].allowed-values',
    'columns[1].required',
  ])
  await expect(
    ruleRow(page, 'columns[1].allowed-values').getByTestId('validation-rule-count'),
  ).toHaveText('0 of 7 rows (0%)')

  // --- Fix the remaining three rules (one edit per violating cell). ---
  // amount 999 → 450 (base #1)…
  await page.locator('[data-testid="grid-row"][data-row-index="1"]').scrollIntoViewIfNeeded()
  const amountRow = page.locator('[data-testid="grid-row"][data-row-index="1"]')
  await expect(amountRow).toHaveAttribute('data-status', 'ready')
  await amountRow.getByTestId('grid-cell').nth(2).dblclick()
  await page.getByTestId('grid-editor-input').fill('450')
  await page.getByTestId('grid-editor-input').press('Enter')
  // …order_id 1001 → 1006 (base #5, the unique duplicate)…
  const duplicateRow = page.locator('[data-testid="grid-row"][data-row-index="5"]')
  await duplicateRow.scrollIntoViewIfNeeded()
  await expect(duplicateRow).toHaveAttribute('data-status', 'ready')
  await duplicateRow.getByTestId('grid-cell').nth(0).dblclick()
  await page.getByTestId('grid-editor-input').fill('1006')
  await page.getByTestId('grid-editor-input').press('Enter')
  // …and order_id NULL → 1009 (base #6).
  const nullRow = page.locator('[data-testid="grid-row"][data-row-index="6"]')
  await nullRow.scrollIntoViewIfNeeded()
  await expect(nullRow).toHaveAttribute('data-status', 'ready')
  await nullRow.getByTestId('grid-cell').nth(0).dblclick()
  await page.getByTestId('grid-editor-input').fill('1009')
  await page.getByTestId('grid-editor-input').press('Enter')

  // The verdict went stale with every edit and stays honest about it.
  await expect(page.getByTestId('validation-stale')).toBeVisible()

  // --- Re-validate → clean: the journey's done-when. ---
  await page.getByTestId('validation-run').click()
  await expect(page.getByTestId('validation-verdict')).toHaveText(
    'Valid: 0 violations across 9 rules (7 rows checked).',
  )
  await expect(page.getByTestId('validation-stale')).toHaveCount(0)
  for (const row of await page.locator('[data-testid="validation-rule"]').all()) {
    await expect(row).toHaveAttribute('data-failing', 'false')
  }

  // --- Privacy: no file name in the page (ADR 0025). ---
  const dataName = dataset.dataPath.split('/').pop() ?? ''
  const contractName = dataset.contractPath.split('/').pop() ?? ''
  const bodyText = (await main.textContent()) ?? ''
  expect(bodyText).not.toContain(dataName)
  expect(bodyText).not.toContain(contractName)
})
