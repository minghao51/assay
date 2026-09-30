import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import {
  bindSourceDataset,
  openPipelineDocument,
  runPipelineToCompletion,
} from './support/pipeline-panel'

// p-5 journey: open a pipeline file → inspect the DAG → run it on the real
// engine → the output is visible in the SQL pane's result surface. Every
// in-app activation is KEYBOARD-OPERABLE (focus + Enter on the same controls
// a mouse user clicks — the a11y-keyboard.spec discipline); the picker path
// is the hidden-`<input type="file">` fallback, so each pick arrives as a
// filechooser event. The engine is the real DuckDB-WASM client; the runner
// is the real p-3 executePipeline bound to its postMessage ops.
//
// Pinned counts are the golden pipeline's (fixtures/pipeline/cli_run.yaml
// over the customers fixture, the same data `pipeline-runner-journey.spec`
// pins through the harness): 5 source rows → 5 after the rename → 2 after
// the SG filter → 1 aggregate row. Output = the terminal relation
// `by_country`, viewed through the EXISTING SQL result surface (the
// `runRequest` seam the nested actions use — no new grid pathway; p-5
// ruling 5's smallest-honest-reuse).
//
// The Pipeline section's placement is PROVISIONAL (last, pending slice-2
// tool-pane membership); the 900px test pins the ux-1 scroll-never-clip
// discipline for the new section at the minimum supported width.

const NODE_IDS = ['customers', 'renamed', 'sg_only', 'by_country']

test.beforeEach(async ({ page }) => {
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

/** All four node rows, resolved fresh on every call. */
function nodeRows(page: Page): Locator {
  return page.locator('[data-testid="pipeline-node"]')
}

/** Status text of one node row (resolved fresh). */
function statusText(page: Page, nodeId: string): Locator {
  return page
    .locator(`[data-testid="pipeline-node"][data-node-id="${nodeId}"]`)
    .getByTestId('pipeline-node-status')
}

test('pipeline journey: open → inspect → run → output visible (keyboard-operable)', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await openPipelineDocument(page)

  // Inspect: the DAG renders as an ordered list in topological (execution)
  // order, every node pending, the source honestly unbound, the terminal
  // relation flagged as the output.
  await expect(nodeRows(page)).toHaveCount(4)
  for (const [index, nodeId] of NODE_IDS.entries()) {
    await expect(nodeRows(page).nth(index)).toHaveAttribute('data-node-id', nodeId)
  }
  await expect(nodeRows(page).nth(0)).toHaveAttribute('data-node-kind', 'source')
  await expect(nodeRows(page).nth(3)).toHaveAttribute('data-node-kind', 'sql')
  for (const nodeId of NODE_IDS) {
    await expect(statusText(page, nodeId)).toHaveText('Pending')
  }
  await expect(page.getByTestId('pipeline-source-pending')).toBeVisible()
  await expect(page.getByTestId('pipeline-summary')).toContainText('1 output')
  // Privacy (ADR 0025): the picked pipeline file's name never renders.
  await expect(page.getByTestId('pipeline-panel')).not.toContainText('cli_run.yaml')

  // Run: bind the source through the real picker path, then run on the real
  // engine. The Run control is the serialized entry point (p-3 carry-over).
  await bindSourceDataset(page)
  await runPipelineToCompletion(page)

  for (const [index, expected] of [
    'Done · 5 rows',
    'Done · 5 rows',
    'Done · 2 rows',
    'Done · 1 row',
  ].entries()) {
    await expect(statusText(page, NODE_IDS[index])).toHaveText(expected)
  }
  await expect(page.getByTestId('pipeline-cancel')).toBeDisabled()
  // The output jump is reachable by keyboard on the terminal node.
  await expect(page.getByTestId('pipeline-view')).toBeVisible()

  await page.getByTestId('pipeline-view').focus()
  await page.keyboard.press('Enter')

  // Output visible: the EXISTING SQL result surface received the exact
  // quoted statement and renders the relation's rows (bounded page).
  await expect(page.getByTestId('sql-result')).toBeVisible()
  await expect(page.getByTestId('sql-result-header')).toHaveText(['country', 'customers'])
  await expect(page.getByTestId('sql-result-cell')).toHaveText(['SG', '2'])
  // The pane shows exactly what ran (the m3-5 honesty contract).
  await expect(page.getByTestId('sql-input')).toHaveValue('SELECT * FROM "by_country"')
})

test('pipeline section at 900px: reachable by nav, controls never clipped', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 })
  await openPipelineDocument(page)
  await bindSourceDataset(page)

  // The keyboard journey completes at 900px (ux-1: scroll, never clip).
  await runPipelineToCompletion(page)
  await expect(page.getByTestId('pipeline-view')).toBeVisible()

  // The run controls and the node list sit fully inside the viewport box
  // after the anchor navigation (no clipping at the minimum width).
  const viewportBox = { width: 900, height: 900 }
  for (const testId of ['pipeline-run', 'pipeline-cancel', 'pipeline-nodes', 'pipeline-view']) {
    const box = await page.getByTestId(testId).boundingBox()
    if (box === null) throw new Error(`missing bounding box for ${testId}`)
    expect(box.x, testId).toBeGreaterThanOrEqual(0)
    expect(box.y, testId).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width, testId).toBeLessThanOrEqual(viewportBox.width + 1)
    // Below the fold is fine (scroll, never clip): only horizontal
    // overflow would clip. Assert the page itself never overflows.
  }
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth)
})
