import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import {
  bindSourceDataset,
  openNodePreview,
  openPipelineDocument,
  pipelineNode,
  runPipelineToCompletion,
} from './support/pipeline-panel'

// p-5/p2-6 journey: open a pipeline file → inspect the DAG → run it on the
// real engine → a node's output opens GRID-NATIVE (the p2-1 view-as-handle
// op; the same handle-based grid model a dataset open uses — no SQL-result
// detour). Every in-app activation is KEYBOARD-OPERABLE (focus + Enter on the
// same controls a mouse user clicks — the a11y-keyboard.spec discipline); the
// picker path is the hidden-`<input type="file">` fallback, so each pick
// arrives as a filechooser event. The engine is the real DuckDB-WASM client;
// the runner is the real p2-4 executePipeline bound to its postMessage ops.
//
// Pinned counts are the golden pipeline's (fixtures/pipeline/cli_run.yaml
// over the customers fixture): 5 source rows → 5 after the rename → 2 after
// the SG filter → 1 aggregate row.
//
// The Pipeline section is a tool-pane resident ordered last (after profile) in
// both layouts (q-15 ruling, 2026-10-02); the 900px test pins the ux-1
// scroll-never-clip discipline for the new section at the minimum supported
// width.

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
  return pipelineNode(page, nodeId).getByTestId('pipeline-node-status')
}

test('pipeline journey: open → inspect → run → preview output (keyboard-operable)', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await openPipelineDocument(page)

  // Inspect: the DAG renders as an ordered list in topological (execution)
  // order, every node pending, the source honestly unbound, the terminal
  // relation flagged as the output, and each node carries a materialization
  // badge.
  await expect(nodeRows(page)).toHaveCount(4)
  for (const [index, nodeId] of NODE_IDS.entries()) {
    await expect(nodeRows(page).nth(index)).toHaveAttribute('data-node-id', nodeId)
  }
  await expect(nodeRows(page).nth(0)).toHaveAttribute('data-node-kind', 'source')
  await expect(nodeRows(page).nth(3)).toHaveAttribute('data-node-kind', 'sql')
  await expect(nodeRows(page).nth(0).getByTestId('pipeline-node-materialization')).toHaveText(
    'source',
  )
  await expect(nodeRows(page).nth(3).getByTestId('pipeline-node-materialization')).toHaveText(
    'view',
  )
  for (const nodeId of NODE_IDS) {
    await expect(statusText(page, nodeId)).toHaveText('Pending')
  }
  await expect(page.getByTestId('pipeline-source-pending')).toBeVisible()
  await expect(page.getByTestId('pipeline-summary')).toContainText('1 output')
  // Lineage (arch §16) is an ordered list, not a graph.
  await expect(page.getByTestId('pipeline-lineage-datasets')).toContainText('customers')
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

  // Preview: the terminal relation opens grid-native through the p2-1
  // handle op — the EXISTING grid model/schema surfaces render it (no SQL
  // detour). The preview shows the sample rows, schema, and generated SQL.
  await openNodePreview(page, 'by_country')
  const preview = page.getByTestId('pipeline-preview')
  await expect(preview.getByTestId('pipeline-preview-meta')).toContainText('by_country')
  await expect(preview.getByTestId('pipeline-preview-columns')).toContainText('country')
  await expect(preview.getByTestId('pipeline-preview-sql')).toContainText('GROUP BY')
  const grid = preview.getByTestId('pipeline-preview-grid')
  await expect(grid.getByTestId('grid-header-name')).toHaveText(['country', 'customers'])
  await expect(grid.getByTestId('grid-cell')).toHaveText(['SG', '2'])

  // Close returns to the ordered list.
  await page.getByTestId('pipeline-preview-close').focus()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('pipeline-preview')).toHaveCount(0)
})

test('pipeline section at 900px: reachable by nav, controls never clipped', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 900 })
  await openPipelineDocument(page)
  await bindSourceDataset(page)

  // The keyboard journey completes at 900px (ux-1: scroll, never clip).
  await runPipelineToCompletion(page)
  await openNodePreview(page, 'by_country')

  // The run controls, the node list, the preview button, and the preview grid
  // sit fully inside the viewport box after the anchor navigation (no
  // clipping at the minimum width).
  const viewportBox = { width: 900, height: 900 }
  for (const testId of [
    'pipeline-run',
    'pipeline-cancel',
    'pipeline-nodes',
    'pipeline-preview-grid',
  ]) {
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
