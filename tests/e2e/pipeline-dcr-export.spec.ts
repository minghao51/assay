import { mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Download, Page } from '@playwright/test'
import {
  bindContract,
  bindSourceDataset,
  openPipelineDocument,
  runPipelineToCompletion,
  runPipelineToGate,
} from './support/pipeline-panel'

// p3-4 journey: the DCR artifact export off a gated run (and its completed
// twin), in the m5-3/m6-4 export-journey style. Every activation is focus +
// Enter or a native control (the p2-6 keyboard-parity pattern).
//
// THE LOAD-BEARING PIN: the same golden gated run
// (`fixtures/pipeline/cli_dcr_gated.yaml` over `fixtures/csv/customers.csv`
// with the failing `sg_min_rows_fail` contract — the p3-3 CLI golden
// journey) exports BYTE-IDENTICAL artifact bytes from the web panel and the
// CLI: the downloaded file is compared byte-for-byte against the committed
// golden `fixtures/dcr/cli-gated-run.yaml` (the M5/M6 exact-agreement
// precedent). One shared builder — the bytes can only agree if the whole
// derivation path agrees.
//
// Also pinned here:
// - delivery is always a NEW file (the download fallback; the result line
//   says the opened file is unchanged and never names a path);
// - the value-free content pin (ADR 0025): no dataset cell value anywhere
//   in the delivered bytes or the result line;
// - the typed refusal UX: a same-node spec refuses in-panel with nothing
//   written (no download event fires at all);
// - run-to-run stability: two exports of the same settled run are
//   byte-identical (no wall-clock).
//
// The datasets ride the hidden-input fallback, so exports ride the anchor
// download (an input-fallback session is download-only by construction).

const FIXTURES_DIR = path.join(process.cwd(), 'fixtures')
const GOLDEN_GATED_PIPELINE = path.join(FIXTURES_DIR, 'pipeline', 'cli_dcr_gated.yaml')
const GOLDEN_COMPLETED_PIPELINE = path.join(FIXTURES_DIR, 'pipeline', 'cli_dcr_pass.yaml')
const GOLDEN_CSV_DATASET = path.join(FIXTURES_DIR, 'csv', 'customers.csv')
const FAILING_CONTRACT = path.join(FIXTURES_DIR, 'pipeline', 'contracts', 'sg_min_rows_fail.yaml')
const PASSING_CONTRACT = path.join(
  FIXTURES_DIR,
  'pipeline',
  'contracts',
  'by_country_min_rows_pass.yaml',
)
const COMMITTED_GOLDEN = path.join(FIXTURES_DIR, 'dcr', 'cli-gated-run.yaml')

/** Distinctive synthetic cell values of the CSV fixture (never real data). */
const CELL_VALUES = [
  'SG',
  'US',
  'DE',
  '52000',
  '61000',
  '48000',
  '75000',
  '2025-01-04',
  '2025-02-02',
  '2025-02-19',
  '2025-03-01',
]

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
      delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker
    } catch {
      // Non-configurable globals would be a Chromium change.
    }
  })
})

/** State the two sides explicitly (keyboard-operable native controls). */
async function stateSides(
  page: Page,
  baseNode: string,
  baseDatasetId: string,
  candidateNode: string,
  candidateDatasetId: string,
): Promise<void> {
  await page.getByTestId('pipeline-dcr-base-node').selectOption(baseNode)
  await page.getByTestId('pipeline-dcr-base-dataset').fill(baseDatasetId)
  await page.getByTestId('pipeline-dcr-candidate-node').selectOption(candidateNode)
  await page.getByTestId('pipeline-dcr-candidate-dataset').fill(candidateDatasetId)
}

/** Export through the panel, persisting the download next to its siblings. */
async function exportArtifact(page: Page, downloads: Download[]): Promise<string> {
  const downloadPromise = page.waitForEvent('download')
  await page.getByTestId('pipeline-dcr-export-run').focus()
  await page.keyboard.press('Enter')
  const download = await downloadPromise
  downloads.push(download)
  const result = page.getByTestId('pipeline-dcr-export-result')
  await expect(result).toContainText('new file')
  await expect(result).toContainText('The opened file is unchanged')
  const dir = path.join(tmpdir(), 'assay-p3-4-export')
  mkdirSync(dir, { recursive: true })
  const target = path.join(dir, `p3-4-${String(downloads.length)}-${download.suggestedFilename()}`)
  await download.saveAs(target)
  return target
}

test('the golden gated run exports the committed golden bytes (web ≡ CLI)', async ({ page }) => {
  test.setTimeout(240_000)
  await openPipelineDocument(page, GOLDEN_GATED_PIPELINE)
  await expect(page.getByTestId('pipeline-source-pending')).toBeVisible()
  await bindSourceDataset(page, GOLDEN_CSV_DATASET)
  await bindContract(page, FAILING_CONTRACT)
  await runPipelineToGate(page)

  // The export section is offered on the gated outcome, with the run's
  // materialized data nodes as sides (never the source or the gate node).
  await expect(page.getByTestId('pipeline-dcr-export')).toBeVisible()
  const choices = await page
    .getByTestId('pipeline-dcr-base-node')
    .locator('option')
    .allTextContents()
  expect(choices).toContain('renamed')
  expect(choices).toContain('by_country')
  expect(choices).not.toContain('customers')
  expect(choices).not.toContain('quality')

  // Refusal UX first: the same node on both sides refuses loudly with
  // nothing written (no download event fires at all).
  let downloadFired = false
  page.on('download', () => {
    downloadFired = true
  })
  await stateSides(page, 'renamed', 'customers_base', 'renamed', 'customers_other')
  await page.getByTestId('pipeline-dcr-export-run').focus()
  await page.keyboard.press('Enter')
  const refused = page.getByTestId('pipeline-dcr-export-refused')
  await expect(refused).toBeVisible()
  expect(await refused.getAttribute('data-reason')).toBe('same-node')
  await expect(refused).toContainText('Nothing was written')
  expect(downloadFired).toBe(false)

  // Now the golden sides — the CLI's exact --base/--candidate flags.
  const downloads: Download[] = []
  await stateSides(page, 'renamed', 'customers_base', 'by_country', 'customers_by_country')
  const first = await exportArtifact(page, downloads)

  // THE PIN: web bytes ≡ the committed CLI-minted golden bytes.
  const webBytes = readFileSync(first)
  const committed = readFileSync(COMMITTED_GOLDEN)
  expect(webBytes.equals(committed)).toBe(true)

  // The value-free content pin: no dataset cell value in the bytes.
  const text = webBytes.toString('utf8')
  for (const value of CELL_VALUES) {
    expect(text).not.toContain(value)
  }

  // Run-to-run stability: a second export of the SAME settled run is
  // byte-identical (no wall-clock in the canonical bytes).
  const second = await exportArtifact(page, downloads)
  expect(readFileSync(second).equals(webBytes)).toBe(true)

  // The result line stays value-free too (no cell values, no file names).
  const resultText = (await page.getByTestId('pipeline-dcr-export-result').textContent()) ?? ''
  for (const value of CELL_VALUES) {
    expect(resultText).not.toContain(value)
  }
  expect(resultText).not.toContain('customers.csv')
})

test('a completed run exports a stable, value-free artifact too (the other exportable class)', async ({
  page,
}) => {
  test.setTimeout(240_000)
  await openPipelineDocument(page, GOLDEN_COMPLETED_PIPELINE)
  await bindSourceDataset(page, GOLDEN_CSV_DATASET)
  await bindContract(page, PASSING_CONTRACT)
  await runPipelineToCompletion(page)

  await expect(page.getByTestId('pipeline-dcr-export')).toBeVisible()
  const downloads: Download[] = []
  await stateSides(page, 'renamed', 'customers_base', 'by_country', 'customers_by_country')
  const first = await exportArtifact(page, downloads)
  const bytes = readFileSync(first)
  const text = bytes.toString('utf8')
  // The canonical stamp (one shared builder; no web-side re-serialization).
  expect(text.startsWith('format: assay-dcr\nversion: 1\n')).toBe(true)
  for (const value of CELL_VALUES) {
    expect(text).not.toContain(value)
  }
  const second = await exportArtifact(page, downloads)
  expect(readFileSync(second).equals(bytes)).toBe(true)
})
