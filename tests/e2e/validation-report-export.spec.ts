import { mkdirSync, readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import type { Download, Locator, Page } from '@playwright/test'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { writeValidationDatasetB } from './support/validation-datasets'

// m5-3 journey 2: the failure report + the invalid-row explorer's honesty
// edges. On the 120-row dataset B (CLI-derived counts in
// support/validation-datasets.ts):
//
// 1. exact verdict + severity order: 3 of 12 rules fail
//    (tag 110/92% → region 24/20% → amount 12/10%);
// 2. bounded-set honesty: the tag rule returns 100 of 110 samples (the
//    engine's clamp) → its "Show only failing rows" is DISABLED with the
//    partial-sample copy; the complete rules offer it ENABLED;
// 3. filter-to-failures: the region filter narrows the grid to exactly 24
//    rows (the bait first), the chip appears, dismissing it restores 120;
// 4. export the failure report as a NEW file, CSV and JSON, through the m4-5
//    download fallback: the file's counts match the on-screen report
//    exactly, the CSV sanitizes the formula-bait sample value while the JSON
//    keeps it raw and typed, and a stale verdict exports flagged stale.
//
// The dataset rides the hidden-input fallback, so exports ride the anchor
// download (an input-fallback session is download-only by construction).

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
      delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker
    } catch {
      // Non-configurable global would be a Chromium change; fail loudly later.
    }
  })
})

async function openDatasetB(page: Page): Promise<{ dataName: string; contractName: string }> {
  const dataset = writeValidationDatasetB()
  await page.goto('/')
  let chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('open-button').click()
  await (await chooserPromise).setFiles(dataset.dataPath)
  await expect(page.getByTestId('open-status')).toHaveText('ready', { timeout: 20_000 })
  await expect(page.getByTestId('grid-total-rows')).toHaveText('120')
  chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('validation-open-contract').click()
  await (await chooserPromise).setFiles(dataset.contractPath)
  await expect(page.getByTestId('validation-contract-name')).toHaveText('orders-audit')
  return {
    dataName: dataset.dataPath.split('/').pop() ?? '',
    contractName: dataset.contractPath.split('/').pop() ?? '',
  }
}

function ruleRow(page: Page, ruleId: string): Locator {
  return page.locator(`[data-testid="validation-rule"][data-rule-id="${ruleId}"]`)
}

/** Export through the panel, capturing the download the fallback triggers. */
async function exportReport(
  page: Page,
  format: 'csv' | 'json',
): Promise<{ download: Download; resultText: string }> {
  await page.getByTestId(`validation-export-format-${format}`).check()
  const downloadPromise = page.waitForEvent('download')
  await page.getByTestId('validation-export-run').click()
  const download = await downloadPromise
  const result = page.getByTestId('validation-export-result')
  await expect(result).toContainText('Exported the failure report (12 rules)')
  await expect(result).toContainText('new file')
  await expect(result).toContainText('The opened file is unchanged')
  return { download, resultText: (await result.textContent()) ?? '' }
}

/** Persist a download under its suggested name (Playwright path is temp). */
async function saveDownload(download: Download): Promise<string> {
  const dir = path.join(tmpdir(), 'assay-m5-3-export')
  mkdirSync(dir, { recursive: true })
  const target = path.join(dir, `m5-3-${String(Date.now())}-${download.suggestedFilename()}`)
  await download.saveAs(target)
  return target
}

test('bounded sets, filter-to-failures, and the exported report match the screen exactly', async ({
  page,
}) => {
  test.setTimeout(240_000)
  const names = await openDatasetB(page)

  // --- Validate: exact verdict, order, and per-rule counts. ---
  await page.getByTestId('validation-run').click()
  await expect(page.getByTestId('validation-verdict')).toHaveText(
    '3 of 12 rules fail (120 rows checked).',
  )
  const rows = page.locator('[data-testid="validation-rule"]')
  const ids: string[] = []
  for (let index = 0; index < (await rows.count()); index++) {
    ids.push((await rows.nth(index).getAttribute('data-rule-id')) ?? '')
  }
  expect(ids.slice(0, 3)).toEqual([
    'columns[3].allowed-values',
    'columns[1].allowed-values',
    'columns[2].max',
  ])
  await expect(
    ruleRow(page, 'columns[3].allowed-values').getByTestId('validation-rule-count'),
  ).toHaveText('110 of 120 rows (92%)')
  await expect(
    ruleRow(page, 'columns[1].allowed-values').getByTestId('validation-rule-count'),
  ).toHaveText('24 of 120 rows (20%)')
  await expect(ruleRow(page, 'columns[2].max').getByTestId('validation-rule-count')).toHaveText(
    '12 of 120 rows (10%)',
  )

  // --- Bounded-set honesty: partial samples disable the filter, honestly. ---
  const tagSamples = ruleRow(page, 'columns[3].allowed-values').getByTestId('validation-sample')
  await expect(tagSamples).toHaveCount(100) // engine-clamped: 100 of 110
  const tagFilter = ruleRow(page, 'columns[3].allowed-values').getByTestId(
    'validation-filter-failures',
  )
  await expect(tagFilter).toBeDisabled()
  await expect(
    ruleRow(page, 'columns[3].allowed-values').getByTestId('validation-filter-reason'),
  ).toContainText('Sample is partial — 100 of 110 violations were returned')

  // Complete sample sets offer the control ENABLED.
  const regionFilter = ruleRow(page, 'columns[1].allowed-values').getByTestId(
    'validation-filter-failures',
  )
  await expect(regionFilter).toBeEnabled()
  await expect(
    ruleRow(page, 'columns[2].max').getByTestId('validation-filter-failures'),
  ).toBeEnabled()

  // --- Filter-to-failures: the grid narrows to exactly the failing rows. ---
  await regionFilter.click()
  await expect(page.getByTestId('grid-total-rows')).toHaveText('24')
  // The first failing row is the formula-bait (ordinal 4), rendered as text.
  const firstRow = page.locator('[data-testid="grid-row"][data-row-index="0"]')
  await expect(firstRow).toHaveAttribute('data-status', 'ready')
  await expect(firstRow.getByTestId('grid-cell').nth(1)).toHaveText('=SUM(A1)')
  // The filter is visible as a regular m2-2 chip (dismiss restores 120).
  const chip = page.locator('[data-testid="filter-chip"][data-col-name="region"]')
  await expect(chip).toHaveCount(1)
  await chip.getByTestId('filter-chip-remove').click()
  await expect(page.getByTestId('grid-total-rows')).toHaveText('120')

  // --- Export CSV: new file, sanitized bait, counts == the screen. ---
  const csv = await exportReport(page, 'csv')
  expect(csv.resultText).toContain('downloading it as a new file')
  const csvPath = await saveDownload(csv.download)
  expect(csvPath.endsWith('.csv')).toBe(true)
  const csvText = readFileSync(csvPath, 'utf8')
  const csvLines = csvText.trimEnd().split('\n')
  expect(csvLines).toHaveLength(13) // header + 12 rules, severity order
  expect(csvLines[0]).toBe(
    'rule_id,column,rule,fail_count,fail_percent,dataset_rows,valid,stale,samples_returned,samples_complete,sample_row_keys,sample_values',
  )
  expect(
    csvLines[1]?.startsWith(
      'columns[3].allowed-values,tag,allowed-values,110,92,120,false,false,100,false,',
    ),
  ).toBe(true)
  expect(
    csvLines[2]?.startsWith(
      'columns[1].allowed-values,region,allowed-values,24,20,120,false,false,24,true,',
    ),
  ).toBe(true)
  expect(csvLines[3]?.startsWith('columns[2].max,amount,max,12,10,120,false,false,12,true,')).toBe(
    true,
  )
  // Sanitized: the leading apostrophe marks the bait as text (m4-2 guard).
  expect(csvText).toContain("'=SUM(A1)")
  expect(csvText).not.toContain('"=SUM(A1)"')
  // Row keys exported anchor-free.
  expect(csvText).toContain('"base:4"')
  expect(csvText).not.toContain('fv-')

  // --- Export JSON: the same counts, raw typed values. ---
  const json = await exportReport(page, 'json')
  const jsonPath = await saveDownload(json.download)
  expect(jsonPath.endsWith('.json')).toBe(true)
  const payload = JSON.parse(readFileSync(jsonPath, 'utf8')) as {
    report: string
    contract: { name: string; version: number }
    valid: boolean
    stale: boolean
    datasetRows: number
    rules: {
      ruleId: string
      failCount: number
      failPercent: number
      samplesReturned: number
      sampleValues: (string | number | boolean | null)[]
    }[]
  }
  expect(payload.report).toBe('assay-validation-report')
  expect(payload.contract).toEqual({ name: 'orders-audit', version: 2 })
  expect(payload.valid).toBe(false)
  expect(payload.stale).toBe(false)
  expect(payload.datasetRows).toBe(120)
  expect(payload.rules).toHaveLength(12)
  const tag = payload.rules.find((rule) => rule.ruleId === 'columns[3].allowed-values')
  expect(tag).toMatchObject({ failCount: 110, failPercent: 92, samplesReturned: 100 })
  const region = payload.rules.find((rule) => rule.ruleId === 'columns[1].allowed-values')
  expect(region).toMatchObject({ failCount: 24, failPercent: 20 })
  // JSON is deliberately unguarded (the m4-5 precedent): raw, typed bait.
  expect(region?.sampleValues[0]).toBe('=SUM(A1)')

  // --- Stale export honesty: an edit flags the exported verdict stale. ---
  const firstDataRow = page.locator('[data-testid="grid-row"][data-row-index="0"]')
  await expect(firstDataRow).toHaveAttribute('data-status', 'ready')
  await firstDataRow.getByTestId('grid-cell').nth(2).dblclick()
  await page.getByTestId('grid-editor-input').fill('10')
  await page.getByTestId('grid-editor-input').press('Enter')
  await expect(page.getByTestId('validation-stale')).toBeVisible()
  const staleJson = await exportReport(page, 'json')
  const stalePath = await saveDownload(staleJson.download)
  const stalePayload = JSON.parse(readFileSync(stalePath, 'utf8')) as { stale: boolean }
  expect(stalePayload.stale).toBe(true)

  // --- Privacy: staged file names never reach the page (ADR 0025). ---
  const bodyText = (await page.locator('main').textContent()) ?? ''
  expect(bodyText).not.toContain(names.dataName)
  expect(bodyText).not.toContain(names.contractName)
})
