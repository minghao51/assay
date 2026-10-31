import { mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { Download, Page } from '@playwright/test'
import {
  writeDiffDatasetPair,
  writeIdenticalDiffPair,
  writeSwappedDiffPair,
} from './support/diff-datasets'
import { expandAllSections } from './support/fixtures'

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
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'idle', {
    timeout: 20_000,
  })
  const chooser = page.waitForEvent('filechooser')
  await page.getByTestId('open-button').click()
  await (await chooser).setFiles(aPath)
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'ready', {
    timeout: 20_000,
  })
  await expect(page.getByTestId('grid-total-rows')).toHaveText('5')
  // q-15: the two-pane pane starts with only Schema expanded; this journey
  // needs the Compare panel open (shared open-section step).
  await expandAllSections(page)
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

/**
 * Count the `engine/diff` requests the page posts to its worker(s). The m6-4
 * no-auto-run pins (stale banner, empty-key Run) need a direct count of the
 * typed op, not an inference from UI timing: patch `postMessage` before any
 * app script runs and tally the request `type`.
 */
async function installDiffOpCounter(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const holder = window as unknown as { __assayDiffOps: number }
    holder.__assayDiffOps = 0
    const original = Worker.prototype.postMessage as unknown as (
      this: Worker,
      message: unknown,
      options?: StructuredSerializeOptions,
    ) => void
    Worker.prototype.postMessage = function (
      this: Worker,
      message: unknown,
      options?: StructuredSerializeOptions,
    ): void {
      if (
        message !== null &&
        typeof message === 'object' &&
        (message as { type?: unknown }).type === 'engine/diff'
      ) {
        holder.__assayDiffOps += 1
      }
      original.call(this, message, options)
    } as typeof Worker.prototype.postMessage
  })
}

/** The `engine/diff` ops posted so far (0 without the counter installed). */
async function diffOpsSent(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __assayDiffOps?: number }).__assayDiffOps ?? 0)
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

  // --- EDIT BEFORE THE JUMP. Delete base #0 (id 1): every later base ordinal
  // then maps to one less effective row index. base #3 (a4) is now effective
  // index 2, while a positional (ordinal-as-index) resolver would land on
  // index 3 (a5). The edit also marks the frozen result stale (m4-3 freshness),
  // which stays viewable under the banner. ---
  await page
    .locator('[data-testid="grid-row"][data-row-index="0"] [data-testid="grid-row-delete"]')
    .click()
  await expect(page.getByTestId('grid-total-rows')).toHaveText('4')
  await expect(page.getByTestId('diff-stale')).toBeVisible()

  // --- Jump to an A-side removed row by LOGICAL key: base #3 → effective row
  // index 2 (the row a4), not position 3. ---
  const removedSamples = aspect('removed').getByTestId('diff-sample')
  await expect(removedSamples.nth(0).getByTestId('diff-sample-key')).toHaveText('base #3')
  await removedSamples.nth(0).getByTestId('diff-sample-jump').click()
  const jumped = page.locator('[data-testid="grid-row"][data-row-index="2"]')
  await expect(jumped).toHaveAttribute('data-status', 'ready')
  await expect(jumped).toBeInViewport()
  // ug-12 (UG-26): the same contract as the validation jump — the single
  // polite region announces the sample's domain display key and roving focus
  // lands on the target grid row.
  await expect(page.getByTestId('edit-live-region')).toHaveText(
    'Showing base #3 in the grid and record inspector',
  )
  await expect(jumped).toBeFocused()
  await expect(jumped).toHaveAttribute('tabindex', '0')
  await expect(page.getByTestId('record-inspector')).toBeVisible()
  await expect(page.getByTestId('record-inspector')).toContainText('a4')

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
  // The journey deliberately edits (deletes base #0) before the jump so the
  // jump pin is falsifiable; the frozen report is honestly marked stale and
  // still carries the pre-edit exact counts.
  expect(payload.stale).toBe(true)
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
    stale: boolean
    schemaDrift: unknown[]
    rowDiff: { added: { count: number }; removed: { count: number }; changed: { count: number } }
  }
  expect(payload.identical).toBe(true)
  expect(payload.stale).toBe(false)
  expect(payload.schemaDrift).toEqual([])
  expect(payload.rowDiff.added.count).toBe(0)
  expect(payload.rowDiff.removed.count).toBe(0)
  expect(payload.rowDiff.changed.count).toBe(0)
})

test('m6-4 zero-state: a flat schema/profile view names only the post-run caveat', async ({
  page,
}) => {
  test.setTimeout(240_000)
  const pair = writeSwappedDiffPair()
  await openDatasetA(page, pair.aPath)
  await stageComparison(page, pair.bPath)

  // Schema drift is explicitly none and every distribution delta is flat:
  // swapping two `amount` values preserves the multiset (and therefore the
  // profile aggregates) while still changing two rows.
  await expect(page.getByTestId('diff-schema-drift-none')).toBeVisible()
  await expect(page.getByTestId('diff-column-delta')).toHaveCount(3)
  for (const delta of await page.getByTestId('diff-column-delta').all()) {
    await expect(delta).toHaveAttribute('data-differs', 'false')
  }

  // BEFORE the row diff the full zero-state renders, including the next action.
  const preRun = page.getByTestId('diff-schema-profile-zero')
  await expect(preRun).toBeVisible()
  await expect(preRun).toContainText('Choose keys below to run the row diff.')

  // Confirm the inferred key; the row diff finds the two swapped rows.
  await expect(
    page.locator(
      '[data-testid="diff-key-candidate"][data-column="id"] [data-testid="diff-key-candidate-radio"]',
    ),
  ).toBeChecked()
  await page.getByTestId('diff-run').click()
  await expect(page.getByTestId('diff-verdict')).toContainText('0 added, 0 removed, 2 changed')

  // AFTER a row diff that found differences while schema/profile stayed flat,
  // the result note carries the caveat ALONE — the "Choose keys…" instruction
  // would be false (the keys were chosen and the diff already ran).
  const postRun = page.getByTestId('diff-schema-profile-none')
  await expect(postRun).toBeVisible()
  await expect(postRun).toContainText('row-only difference would not appear')
  await expect(postRun).not.toContainText('Choose keys')
  await expect(preRun).toHaveCount(0)
  await expect(page.locator('main')).not.toContainText('Choose keys below to run the row diff.')
})

test('m6-4 stale: an edit after a result marks it stale with no auto re-run', async ({ page }) => {
  test.setTimeout(240_000)
  const pair = writeDiffDatasetPair()
  await installDiffOpCounter(page)
  await openDatasetA(page, pair.aPath)
  await stageComparison(page, pair.bPath)

  await page.getByTestId('diff-run').click()
  await expect(page.getByTestId('diff-verdict')).toContainText('2 added, 2 removed, 2 changed')
  expect(await diffOpsSent(page)).toBe(1)
  await expect(page.getByTestId('diff-stale')).toHaveCount(0)

  // Edit a cell after the result. Wait for the commit to land (the op lane
  // drains: the grid cell shows the new value) BEFORE asserting the banner and
  // the absence of a second run — otherwise the no-auto-run claim races the
  // commit and could pass vacuously.
  const cell = page
    .locator('[data-testid="grid-row"][data-row-index="0"] [data-testid="grid-cell"]')
    .nth(1)
  await cell.dblclick()
  await page.getByTestId('grid-editor-input').fill('a1-edited')
  await page.getByTestId('grid-editor-input').press('Enter')
  await expect(page.getByTestId('grid-cell-editor')).toHaveCount(0)
  await expect(cell).toHaveText('a1-edited')

  // The frozen result is stale, stays viewable, and no second `engine/diff`
  // op was sent (the canary: exactly one plan send).
  await expect(page.getByTestId('diff-stale')).toBeVisible()
  await expect(page.getByTestId('diff-stale')).toContainText('stale')
  await expect(page.getByTestId('diff-verdict')).toContainText('2 added, 2 removed, 2 changed')
  expect(await diffOpsSent(page)).toBe(1)
})

test('m6-4 C2: an empty key set disables Run and sends no row-diff op', async ({ page }) => {
  test.setTimeout(240_000)
  const pair = writeDiffDatasetPair()
  await installDiffOpCounter(page)
  await openDatasetA(page, pair.aPath)
  await stageComparison(page, pair.bPath)

  // Manual entry that parses to no keys (only whitespace and commas).
  await page.getByTestId('diff-key-manual-radio').check()
  await page.getByTestId('diff-key-manual-input').fill('  ,  ')
  await expect(page.getByTestId('diff-run')).toBeDisabled()
  expect(await diffOpsSent(page)).toBe(0)

  // A real explicit key re-enables Run — the control is not simply dead.
  await page.getByTestId('diff-key-manual-input').fill('id')
  await expect(page.getByTestId('diff-run')).toBeEnabled()
  expect(await diffOpsSent(page)).toBe(0)
})
