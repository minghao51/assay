import { mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Download, Page } from '@playwright/test'
import { writeDiffDatasetPair, writeIdenticalDiffPair } from './support/diff-datasets'

// m6-4 done-when journeys (handoff §6):
//
// 1. full journey — open dataset → stage comparison → schema drift visible →
//    confirm the inferred key → row diff runs with exact counts → jump to an
//    A-side row in the diff report (the grid shows it) → export the report
//    with its content pinned;
// 2. identical-files zero-state — schema drift none, deltas flat, row diff
//    0/0/0 → the explicit "No differences" verdict.
//
// The app under test is the real composition root; the engine is the real
// DuckDB-WASM comparison staging + row-diff op on the query lane; the diff
// model/key inference/plan compiler are the real `@assay/diff` package (the
// same code the CLI runs — m6-5's agreement source). Every expected count is
// CLI-derived (see support/diff-datasets.ts).
//
// Wording note (C3): "added" samples are B-side rows — the staged comparison
// is report content and is never added to the grid, so the journey jumps to
// an A-SIDE row (the removed `base #4`); the added B samples are asserted to
// have NO jump affordance and to say "report only".
//
// Privacy: no file name may reach the page or the exported report (ADR 0025).

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
      delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker
    } catch {
      // Non-configurable globals would be a Chromium change; the test then
      // fails loudly at the chooser/download rather than silently.
    }
  })
})

async function openDatasetA(page: Page, aPath: string): Promise<void> {
  await page.goto('/')
  await expect(page.getByTestId('open-status')).toHaveText('idle')
  const chooser = page.waitForEvent('filechooser')
  await page.getByTestId('open-button').click()
  await (await chooser).setFiles(aPath)
  await expect(page.getByTestId('open-status')).toHaveText('ready')
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')
}

async function stageComparison(page: Page, bPath: string): Promise<void> {
  const chooser = page.waitForEvent('filechooser')
  await page.getByTestId('diff-open-comparison').click()
  await (await chooser).setFiles(bPath)
  await expect(page.getByTestId('diff-comparison-info')).toBeVisible()
  await expect(page.getByTestId('diff-comparison-rows')).toHaveText('5 rows')
}

/** Export the report through the panel, persist the download, return its path. */
let exportSeq = 0
async function exportReportJson(page: Page): Promise<string> {
  await page.getByTestId('diff-export-format-json').check()
  const downloadPromise = page.waitForEvent('download')
  await page.getByTestId('diff-export-run').click()
  const download: Download = await downloadPromise
  await expect(page.getByTestId('diff-export-result')).toContainText('new file')
  await expect(page.getByTestId('diff-export-result')).toContainText('The opened file is unchanged')
  const dir = path.join(tmpdir(), 'assay-m6-4-export')
  mkdirSync(dir, { recursive: true })
  exportSeq += 1
  const target = path.join(dir, `${String(exportSeq)}-${download.suggestedFilename()}`)
  await download.saveAs(target)
  return target
}

test('m6-4 journey: stage → schema drift → confirm key → row diff → jump A-side → export', async ({
  page,
}) => {
  test.setTimeout(240_000)
  const pair = writeDiffDatasetPair()
  const aName = path.basename(pair.aPath)
  const bName = path.basename(pair.bPath)
  await openDatasetA(page, pair.aPath)

  // --- Stage the comparison (C3: typed engine op; the grid keeps A). ---
  await stageComparison(page, pair.bPath)
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')

  // --- Progressive disclosure order: schema drift is before the row diff. ---
  const order = await page.evaluate(() => {
    const drift = document.querySelector('[data-testid="diff-schema-drift"]')
    const keys = document.querySelector('[data-testid="diff-key-selection"]')
    if (drift === null || keys === null) return 'missing'
    return drift.compareDocumentPosition(keys) & Node.DOCUMENT_POSITION_FOLLOWING
      ? 'drift-first'
      : 'key-first'
  })
  expect(order).toBe('drift-first')

  // --- Schema drift: the added `region` column, exact kind. ---
  const regionFinding = page.locator(
    '[data-testid="diff-schema-finding"][data-column="region"][data-kind="column-added"]',
  )
  await expect(regionFinding).toHaveCount(1)
  await expect(regionFinding).toContainText('added column region')

  // --- Distribution deltas: the shared columns, with a non-zero numeric shift. ---
  await expect(page.getByTestId('diff-column-delta')).toHaveCount(3)
  const idDelta = page.locator('[data-testid="diff-column-delta"][data-column="id"]')
  await expect(idDelta).toHaveAttribute('data-differs', 'true')
  await expect(idDelta).toContainText('mean shift 0.505964')
  await expect(page.locator('[data-testid="diff-column-delta"][data-column="name"]')).toContainText(
    'total variation 0.6',
  )
  // The added `region` column is schema drift, not a shared delta.
  await expect(page.locator('[data-testid="diff-column-delta"][data-column="region"]')).toHaveCount(
    0,
  )

  // --- C2 key selection: minimal-first candidates with evidence; id first. ---
  await expect(page.getByTestId('diff-key-outcome')).toContainText('3 key candidate(s) proposed')
  const candidateIds = await page
    .locator('[data-testid="diff-key-candidate"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-column')))
  expect(candidateIds).toEqual(['id', 'name', 'amount'])
  const idRadio = page.locator(
    '[data-testid="diff-key-candidate"][data-column="id"] [data-testid="diff-key-candidate-radio"]',
  )
  await expect(idRadio).toBeChecked()
  await expect(
    page.locator(
      '[data-testid="diff-key-candidate"][data-column="id"] [data-testid="diff-key-evidence"]',
    ),
  ).toContainText('0 nulls, 5 distinct of 5 rows')

  // --- Confirm the inferred key → the row diff runs. ---
  await page.getByTestId('diff-run').click()
  await expect(page.getByTestId('diff-verdict')).toContainText(
    '2 added, 2 removed, 2 changed — rows 5 → 5 (keys: id, inferred).',
  )

  const aspect = (name: string) =>
    page.locator(`[data-testid="diff-aspect"][data-aspect="${name}"]`)
  await expect(aspect('added').getByTestId('diff-aspect-count')).toHaveText('added (2)')
  await expect(aspect('removed').getByTestId('diff-aspect-count')).toHaveText('removed (2)')
  await expect(aspect('changed').getByTestId('diff-aspect-count')).toHaveText('changed (2)')

  // Added samples are B-side: report-only, no jump affordance (C3).
  const addedSamples = aspect('added').getByTestId('diff-sample')
  await expect(addedSamples).toHaveCount(2)
  await expect(addedSamples.nth(0).getByTestId('diff-sample-key')).toHaveText('b #3')
  await expect(addedSamples.nth(0).getByTestId('diff-sample-report-only')).toBeVisible()
  await expect(addedSamples.nth(0).getByTestId('diff-sample-jump')).toHaveCount(0)

  // Changed samples carry the A-side row and its changed columns.
  const changedSamples = aspect('changed').getByTestId('diff-sample')
  await expect(changedSamples.nth(0).getByTestId('diff-sample-key')).toHaveText('base #1')
  await expect(changedSamples.nth(0).getByTestId('diff-sample-changed')).toHaveText('name')
  await expect(changedSamples.nth(1).getByTestId('diff-sample-key')).toHaveText('base #2')
  await expect(changedSamples.nth(1).getByTestId('diff-sample-changed')).toHaveText('amount')

  // --- Jump to an A-side removed row (base #4 → grid row index 4). ---
  const removedSamples = aspect('removed').getByTestId('diff-sample')
  await expect(removedSamples.nth(1).getByTestId('diff-sample-key')).toHaveText('base #4')
  await removedSamples.nth(1).getByTestId('diff-sample-jump').click()
  const jumped = page.locator('[data-testid="grid-row"][data-row-index="4"]')
  await expect(jumped).toHaveAttribute('data-status', 'ready')
  await expect(jumped).toBeInViewport()
  await expect(page.getByTestId('record-inspector')).toBeVisible()
  await expect(page.getByTestId('record-inspector')).toContainText('a5')

  // --- Export the report: the frozen on-screen counts + samples. ---
  const reportPath = await exportReportJson(page)
  const payload = JSON.parse(readFileSync(reportPath, 'utf8')) as {
    report: string
    baseViewOnly: boolean
    stale: boolean
    identical: boolean
    keys: string[]
    keySource: string
    sampleLimitRequested: number
    sampleLimitEffective: number
    inference: { columns: string[]; candidateDisclosure: string } | null
    schemaDrift: { kind: string; column: string }[]
    columnDeltas: { column: string; numeric: Record<string, number | null> | null }[]
    rowDiff: {
      rowCountA: number
      rowCountB: number
      changedComparable: boolean
      added: { count: number; samples: { side: string; rowKey: string }[] }
      removed: { count: number; samples: { side: string; rowKey: string }[] }
      changed: {
        count: number
        samples: { side: string; rowKey: string; changedColumns: string[] }[]
      }
    }
  }
  expect(payload.report).toBe('assay-diff-report')
  expect(payload.baseViewOnly).toBe(true)
  expect(payload.stale).toBe(false)
  expect(payload.identical).toBe(false)
  expect(payload.keys).toEqual(['id'])
  expect(payload.keySource).toBe('inferred')
  expect(payload.inference?.columns).toEqual(['id'])
  expect(payload.sampleLimitRequested).toBe(100)
  expect(payload.sampleLimitEffective).toBe(100)
  expect(payload.schemaDrift).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: 'column-added', column: 'region' })]),
  )
  expect(payload.columnDeltas.map((delta) => delta.column)).toEqual(['id', 'name', 'amount'])
  expect(payload.rowDiff.rowCountA).toBe(5)
  expect(payload.rowDiff.rowCountB).toBe(5)
  expect(payload.rowDiff.changedComparable).toBe(true)
  expect(payload.rowDiff.added.count).toBe(2)
  expect(payload.rowDiff.added.samples.map((sample) => sample.rowKey)).toEqual(['b:3', 'b:4'])
  expect(payload.rowDiff.removed.count).toBe(2)
  expect(payload.rowDiff.removed.samples.map((sample) => sample.rowKey)).toEqual([
    'base:3',
    'base:4',
  ])
  expect(payload.rowDiff.changed.count).toBe(2)
  expect(
    payload.rowDiff.changed.samples.map((sample) => [sample.rowKey, sample.changedColumns]),
  ).toEqual([
    ['base:1', ['name']],
    ['base:2', ['amount']],
  ])
  const reportText = readFileSync(reportPath, 'utf8')
  expect(reportText).not.toContain('anchor')
  expect(reportText).not.toContain(aName)
  expect(reportText).not.toContain(bName)

  // --- Privacy: neither file name reaches the page. ---
  const bodyText = (await page.locator('main').textContent()) ?? ''
  expect(bodyText).not.toContain(aName)
  expect(bodyText).not.toContain(bName)
})

test('m6-4 zero-state: identical files → explicit "No differences" after the row diff', async ({
  page,
}) => {
  test.setTimeout(240_000)
  const pair = writeIdenticalDiffPair()
  await openDatasetA(page, pair.aPath)
  await stageComparison(page, pair.bPath)

  // Schema drift is explicitly none; the deltas are present but flat.
  await expect(page.getByTestId('diff-schema-drift-none')).toBeVisible()
  await expect(page.getByTestId('diff-column-delta')).toHaveCount(3)
  for (const delta of await page.getByTestId('diff-column-delta').all()) {
    await expect(delta).toHaveAttribute('data-differs', 'false')
  }

  // Confirm the inferred key and run: the row diff is the load-bearing check.
  await expect(
    page.locator(
      '[data-testid="diff-key-candidate"][data-column="id"] [data-testid="diff-key-candidate-radio"]',
    ),
  ).toBeChecked()
  await page.getByTestId('diff-run').click()
  const verdict = page.getByTestId('diff-verdict')
  await expect(verdict).toContainText('No differences')
  await expect(verdict).toContainText('row-level comparison (keys: id)')
  await expect(verdict).toContainText('every aspect that ran')
  for (const name of ['added', 'removed', 'changed']) {
    await expect(
      page.locator(
        `[data-testid="diff-aspect"][data-aspect="${name}"] [data-testid="diff-aspect-count"]`,
      ),
    ).toHaveText(`${name} (0)`)
    await expect(
      page.locator(
        `[data-testid="diff-aspect"][data-aspect="${name}"] [data-testid="diff-aspect-none"]`,
      ),
    ).toHaveText('none')
  }

  // The exported report agrees: identical, zero counts, no anchors.
  const reportPath = await exportReportJson(page)
  const payload = JSON.parse(readFileSync(reportPath, 'utf8')) as {
    identical: boolean
    schemaDrift: unknown[]
    rowDiff: { added: { count: number }; removed: { count: number }; changed: { count: number } }
  }
  expect(payload.identical).toBe(true)
  expect(payload.schemaDrift).toEqual([])
  expect(payload.rowDiff.added.count).toBe(0)
  expect(payload.rowDiff.removed.count).toBe(0)
  expect(payload.rowDiff.changed.count).toBe(0)
})
