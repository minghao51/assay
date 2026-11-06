import { expect, test } from './support/fixture'
import type { Page } from '@playwright/test'
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

// p2-6 journey (arch §15/§16, ADR 0035): the full keyboard-operable
// pipeline-panel v2 flow at default and 900px:
//
//   open → inspect → run → gate failure surfaced → fix (re-bind contract)
//   → re-run → publish unblocked → preview output
//
// The pipeline is `source → filter(SG) → validate → publish(requires gate)`
// over the customers fixture (2 SG rows, one with a NULL income). The strict
// contract fails 1 rule and blocks the publish; the run stops as a `gated`
// outcome. Re-binding the passing contract and re-running completes and
// unblocks the publish. Every in-app activation is focus + Enter (the
// a11y-keyboard discipline); axe scans live in a11y.spec.

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

/** Drive the full gated journey once (keyboard-operable throughout). */
async function runGateJourney(page: Page): Promise<void> {
  const fixture = writeGatePipelineFixture()
  await openPipelineDocument(page, fixture.pipelinePath)

  // Inspect: the gated DAG loads with validate/publish nodes, badges, and
  // lineage (an ordered list — never a graph editor).
  await expect(page.locator('[data-testid="pipeline-node"]')).toHaveCount(4)
  await expect(pipelineNode(page, 'gate')).toHaveAttribute('data-node-kind', 'validate')
  await expect(pipelineNode(page, 'out')).toHaveAttribute('data-node-kind', 'publish')
  await expect(pipelineNode(page, 'gate').getByTestId('pipeline-node-materialization')).toHaveText(
    'gate',
  )
  await expect(page.getByTestId('pipeline-lineage-nodes')).toContainText('requires')

  await bindSourceDataset(page)
  await bindContract(page, fixture.failingContractPath)

  // Run → the failing gate is surfaced; the run stops at the blocked publish.
  await runPipelineToGate(page)
  const gated = page.getByTestId('pipeline-run-gated')
  await expect(gated).toBeVisible()
  await expect(gated).toContainText('out')
  await expect(gated).toContainText('publish gate is blocked')
  await expect(page.getByTestId('pipeline-run-gated-detail')).toContainText('gate')
  await expect(pipelineNode(page, 'gate').getByTestId('pipeline-node-gate')).toContainText(
    'Validate: failed — 1 rule violated',
  )
  await expect(pipelineNode(page, 'out').getByTestId('pipeline-node-gate')).toContainText(
    'Publish: blocked by gate',
  )
  await expect(pipelineNode(page, 'out')).toHaveAttribute('data-node-status', 'gated')

  // Fix: re-bind the passing contract and re-run → completed, publish
  // unblocked.
  await bindContract(page, fixture.passingContractPath)
  await runPipelineToCompletion(page)
  await expect(pipelineNode(page, 'gate').getByTestId('pipeline-node-gate')).toHaveText(
    'Validate: passed',
  )
  await expect(pipelineNode(page, 'out').getByTestId('pipeline-node-gate')).toHaveText(
    'Publish: gate passed',
  )

  // Preview output: the filtered relation opens grid-native through the
  // p2-1 handle op; the sample rows render in the existing grid.
  await openNodePreview(page, 'sg')
  const preview = page.getByTestId('pipeline-preview')
  await expect(preview.getByTestId('pipeline-preview-meta')).toContainText('sg')
  await expect(preview.getByTestId('pipeline-preview-sql')).toContainText('WHERE')
  // A filter does not change the schema, so the delta is honestly empty.
  await expect(preview.getByTestId('pipeline-preview-delta-empty')).toBeVisible()
  const grid = preview.getByTestId('pipeline-preview-grid')
  await expect(grid.getByTestId('grid-header-name')).toHaveText([
    'customer_id',
    'country',
    'income',
    'signup_date',
  ])
  await expect(grid.getByTestId('grid-row')).toHaveCount(2)
}

test('pipeline v2 gate journey: gate failure surfaced, fixed, publish unblocked, preview output', async ({
  page,
}) => {
  test.setTimeout(180_000)
  await runGateJourney(page)
})

test('pipeline v2 gate journey at 900px: scroll, never clip', async ({ page }) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 900, height: 900 })
  await runGateJourney(page)

  const viewportBox = { width: 900, height: 900 }
  for (const testId of [
    'pipeline-run',
    'pipeline-nodes',
    'pipeline-preview-grid',
    'pipeline-lineage-nodes',
  ]) {
    const box = await page.getByTestId(testId).boundingBox()
    if (box === null) throw new Error(`missing bounding box for ${testId}`)
    expect(box.x, testId).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width, testId).toBeLessThanOrEqual(viewportBox.width + 1)
  }
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth)
})
