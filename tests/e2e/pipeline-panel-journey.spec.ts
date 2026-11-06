import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import {
  PIPELINE_DATASET_FIXTURE,
  bindContract,
  bindLoadedContractViaPrimary,
  bindOpenDatasetViaPrimary,
  bindSourceDataset,
  openNodePreview,
  openPipelineDocument,
  openPipelineOnOpenDataset,
  pipelineNode,
  runPipelineToCompletion,
  runPipelineToGate,
  watchFileChoosers,
  writeGatePipelineFixture,
} from './support/pipeline-panel'
import { activateTask, openFixture } from './support/fixtures'

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

/**
 * ug-9 / R-15 (c): the DCR purpose sentence, verbatim from the implementation
 * spec §2. Written out here so a copy regression cannot agree with itself.
 */
const DCR_PURPOSE_SENTENCE =
  'A Dataset Change Request packages a proposed dataset change for review — like a pull request for data.'

/** The DCR expansion (the first mention in the pipeline panel). */
const DCR_EXPANSION = 'Dataset Change Request (DCR)'

/** One validation rule row, resolved fresh. */
function validationRule(page: Page, ruleId: string): Locator {
  return page.locator(`[data-testid="validation-rule"][data-rule-id="${ruleId}"]`)
}

/**
 * R-15 (a): the pipeline continues the journey. With the dataset open AND a
 * contract already loaded in Validation, both bindings — the source node's
 * "Use the open dataset" and the validate node's "Use the loaded contract" —
 * complete from App-held state. The file-chooser spy is armed BEFORE either
 * primary, so ANY OS dialog opened by a binding (or by the subsequent run)
 * fails the test instead of being silently absorbed by a picker fallback.
 */
test('R-15 (a): source + validate nodes bind from App-held state with no file chooser', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const fixture = writeGatePipelineFixture()

  // Open the dataset, then load the passing contract in Validation (the two
  // legitimate setup picks — both happen before the spy is armed). rd-3b:
  // Validation is a Check section, so that leg activates Check; the pipeline
  // document leg then activates Prepare (inside `openPipelineOnOpenDataset`).
  await openFixture(page, PIPELINE_DATASET_FIXTURE)
  await activateTask(page, 'check')
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('validation-open-contract').click()
  await (await chooserPromise).setFiles(fixture.passingContractPath)
  await expect(page.getByTestId('validation-contract-name')).toHaveText('gate-pass')

  // Open the pipeline document on the SAME session (no dataset re-open).
  await openPipelineOnOpenDataset(page, fixture.pipelinePath)

  // Both primaries carry the exact R-15 copy.
  await expect(page.getByTestId('pipeline-bind-open-dataset')).toHaveText('Use the open dataset')
  await expect(page.getByTestId('pipeline-bind-loaded-contract')).toHaveText(
    'Use the loaded contract',
  )

  const choosers = watchFileChoosers(page)
  await bindOpenDatasetViaPrimary(page)
  await bindLoadedContractViaPrimary(page)
  // Bindings landed without a picker.
  await expect(page.getByTestId('pipeline-source-bound')).toBeVisible()
  await expect(page.getByTestId('pipeline-contract-bound')).toBeVisible()
  choosers.expectNone()

  // Run to a settled verdict on the real engine (validate passes over the SG
  // subset, so the publish gate is satisfied).
  await runPipelineToCompletion(page)
  choosers.expectNone()

  // R-15 (c) text pin on the panel's rendered text: the FIRST "DCR" token is
  // inside the expansion, and the purpose sentence is present verbatim.
  const panelText = await page.getByTestId('pipeline-panel').innerText()
  const expansionIndex = panelText.indexOf(DCR_EXPANSION)
  expect(expansionIndex).toBeGreaterThanOrEqual(0)
  expect(panelText.indexOf('DCR')).toBe(expansionIndex + 'Dataset Change Request ('.length)
  expect(panelText).toContain(DCR_PURPOSE_SENTENCE)
  await expect(page.getByTestId('pipeline-dcr-export').locator('legend')).toHaveText(
    'Export the Dataset Change Request (DCR)',
  )
})

/**
 * R-15 (b): a validate-gate failure is no longer a dead end. The gate detail
 * offers "Inspect this contract in Validation"; activating it reveals +
 * expands the Validation section, loads the RUN's bound contract (no picker)
 * and focuses the section, so the user's next Validate names the failing
 * ruleIds. Loading is NOT validating — the cross-link itself runs nothing.
 *
 * Setup uses the existing gated fixture/helper posture: the pipeline's strict
 * contract is bound through the real contract picker BEFORE the spy is armed;
 * the cross-link and the subsequent explicit Validate must not pick anything.
 * Review round: the validate node is RE-BOUND to the passing contract after
 * the failed run, so this journey also pins that the cross-link loads the
 * run's start-of-run contract (the snapshot), never the new binding.
 */
test('R-15 (b): gate-failure cross-link loads the run contract into Validation, no picker', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const fixture = writeGatePipelineFixture()

  await openFixture(page, PIPELINE_DATASET_FIXTURE)
  // A DIFFERENT contract is loaded in Validation first, so the cross-link's
  // load is observable (the session visibly replaces it with the run's).
  // rd-3b: Validation is a Check section — that leg activates Check.
  await activateTask(page, 'check')
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('validation-open-contract').click()
  await (await chooserPromise).setFiles(fixture.passingContractPath)
  await expect(page.getByTestId('validation-contract-name')).toHaveText('gate-pass')

  await openPipelineOnOpenDataset(page, fixture.pipelinePath)
  await bindOpenDatasetViaPrimary(page)
  // The gate's failing contract is bound through the existing picker helper.
  await bindContract(page, fixture.failingContractPath)
  await runPipelineToGate(page)

  const gated = page.getByTestId('pipeline-run-gated')
  await expect(gated).toBeVisible()
  await expect(page.getByTestId('pipeline-run-gated-detail')).toContainText('failed 1 rule')

  // The section is collapsed before the cross-link, so reveal + expand is a
  // real state change rather than a vacuous "already open". rd-3b: the toggle
  // belongs to the Check frame, so Check is activated for the collapse and the
  // Prepare frame (the gated run below) is restored afterwards — the cross-link
  // itself must do the reveal from a filtered state.
  await activateTask(page, 'check')
  await page.getByTestId('section-toggle-validation').click()
  await expect(page.getByTestId('section-toggle-validation')).toHaveAttribute(
    'aria-expanded',
    'false',
  )
  await activateTask(page, 'prepare')

  // Review-round pin: RE-BIND the validate node to a DIFFERENT (passing)
  // contract AFTER the failed run. The gated detail still belongs to the old
  // run, so the cross-link must load the contract THAT RUN failed — not this
  // new binding (which would make the next Validate pass and misattribute
  // the failure).
  await bindContract(page, fixture.passingContractPath)

  const choosers = watchFileChoosers(page)
  await page.getByTestId('pipeline-inspect-contract').click()

  // Revealed + expanded + focused, and the RUN's contract is loaded — the
  // re-bind above did NOT replace it.
  await expect(page.getByTestId('section-toggle-validation')).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  await expect(page.getByTestId('validation-panel')).toBeVisible()
  await expect(page.getByTestId('validation-contract-name')).toHaveText('gate-strict')
  await expect(page.getByTestId('validation-panel')).toBeFocused()
  // Loading is not validating: no verdict exists yet.
  await expect(page.getByTestId('validation-verdict')).toHaveCount(0)
  choosers.expectNone()

  // The explicit Validate now names the failing ruleIds (the strict contract's
  // required-income rule over the base dataset).
  await page.getByTestId('validation-run').click()
  await expect(page.getByTestId('validation-verdict')).toContainText('rules fail', {
    timeout: 60_000,
  })
  await expect(validationRule(page, 'columns[2].required')).toHaveAttribute('data-failing', 'true')
  await expect(
    validationRule(page, 'columns[2].required').getByTestId('validation-rule-id'),
  ).toHaveText('columns[2].required')
  choosers.expectNone()
})
