import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'

/**
 * Shared pipeline-panel drive (p-5; p2-6 gates/preview). Every pick gesture —
 * dataset, pipeline file, per-source dataset, per-validate contract — rides
 * the hidden-`<input type="file">` fallback (the m1-5 pattern:
 * `showOpenFilePicker` is deleted in `beforeEach`), so each arrives as a
 * `filechooser` event. All in-app activations are plain buttons/links, so the
 * keyboard journey can `focus()` + `Enter` the same controls a mouse user
 * clicks.
 */

/** The golden runnable pipeline (p-4 fixture; its authored source path is
 * deliberately NOT used in the browser — sources are picked per node, C2). */
export const PIPELINE_FIXTURE = path.join(process.cwd(), 'fixtures', 'pipeline', 'cli_run.yaml')

/** The dataset bound to the pipeline's `customers` source node (5 rows). */
export const PIPELINE_DATASET_FIXTURE = path.join(
  process.cwd(),
  'fixtures',
  'parquet',
  'customers.parquet',
)

/**
 * A gated pipeline + its failing/passing contracts, staged into a fresh temp
 * dir (never committed — the m5-3 validation-dataset pattern). The pipeline
 * is `source → filter(SG) → validate → publish(requires gate)` over the
 * customers fixture: the SG filter leaves 2 rows, one with a NULL income, so
 * the strict contract fails 1 rule and blocks the publish; the passing
 * contract unblocks it on the re-run.
 */
export interface GatePipelineFixture {
  readonly pipelinePath: string
  readonly failingContractPath: string
  readonly passingContractPath: string
}

const GATE_PIPELINE_YAML = `version: 1
pipeline: gate_e2e
nodes:
  customers:
    type: source
    source:
      kind: file
      path: ./customers.parquet
  gate:
    type: validate
    input: sg
    contract: contracts/strict.yaml
  out:
    type: publish
    input: sg
    requires: [ gate ]
  sg:
    type: transform
    inputs: [ customers ]
    operation:
      filter:
        predicates:
          - column: country
            operator: equals
            value: SG
`

const FAILING_CONTRACT_YAML = `format: v1
name: gate-strict
version: 1
columns:
  - name: customer_id
    type: BIGINT
    required: true
  - name: country
    type: VARCHAR
    required: true
  - name: income
    type: BIGINT
    required: true
dataset:
  min-rows: 1
`

const PASSING_CONTRACT_YAML = `format: v1
name: gate-pass
version: 1
columns:
  - name: customer_id
    type: BIGINT
    required: true
  - name: country
    type: VARCHAR
    required: true
dataset:
  min-rows: 1
`

/** Stage the gated pipeline + both contracts into a fresh temp dir. */
export function writeGatePipelineFixture(): GatePipelineFixture {
  const dir = mkdtempSync(path.join(tmpdir(), 'assay-p2-6-gate-'))
  const pipelinePath = path.join(dir, 'gate-pipeline.yaml')
  const failingContractPath = path.join(dir, 'strict.contract.yaml')
  const passingContractPath = path.join(dir, 'passing.contract.yaml')
  writeFileSync(pipelinePath, GATE_PIPELINE_YAML)
  writeFileSync(failingContractPath, FAILING_CONTRACT_YAML)
  writeFileSync(passingContractPath, PASSING_CONTRACT_YAML)
  return { pipelinePath, failingContractPath, passingContractPath }
}

/**
 * Open the app with a dataset (the workbench frame exists only ready),
 * navigate to the provisional Pipeline section by its keyboard-reachable nav
 * link, and open the pipeline file through the real picker path.
 */
export async function openPipelineDocument(
  page: Page,
  pipelinePath: string = PIPELINE_FIXTURE,
): Promise<void> {
  await page.goto('/')
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'idle', {
    timeout: 20_000,
  })
  let chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('open-button').click()
  await (await chooserPromise).setFiles(PIPELINE_DATASET_FIXTURE)
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'ready', {
    timeout: 20_000,
  })

  // Keyboard-reachable navigation to the section (the sticky nav's anchor
  // link — the scroll-never-clip gesture at any viewport).
  await page.getByTestId('section-nav-pipeline').focus()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('pipeline-panel')).toBeVisible()

  // Open the pipeline through the real picker path.
  chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('pipeline-open').focus()
  await page.keyboard.press('Enter')
  await (await chooserPromise).setFiles(pipelinePath)
  await expect(page.getByTestId('pipeline-summary')).toBeVisible()
}

/** Bind the pipeline's single source node through the real picker path. */
export async function bindSourceDataset(page: Page): Promise<void> {
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('pipeline-bind').focus()
  await page.keyboard.press('Enter')
  await (await chooserPromise).setFiles(PIPELINE_DATASET_FIXTURE)
  await expect(page.getByTestId('pipeline-source-bound')).toBeVisible()
}

/** Bind (or replace) one validate node's contract through the real picker. */
export async function bindContract(page: Page, contractPath: string): Promise<void> {
  const bound = page.getByTestId('pipeline-contract-bound')
  // The span renders whenever ANY contract is bound, so on a re-bind its mere
  // visibility is vacuous: the replacement's readContractFile+parseContract
  // lands asynchronously after it. Capture the value-free bind revision first
  // and, on a re-bind, wait for it to advance past the pre-bind value.
  const revisionBefore =
    (await bound.count()) > 0 ? await bound.getAttribute('data-bind-revision') : null
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('pipeline-bind-contract').focus()
  await page.keyboard.press('Enter')
  await (await chooserPromise).setFiles(contractPath)
  await expect(bound).toBeVisible()
  if (revisionBefore !== null) {
    await expect
      .poll(async () => bound.getAttribute('data-bind-revision'), { timeout: 20_000 })
      .not.toBe(revisionBefore)
  }
}

/** Run the pipeline and wait for the runner's completed outcome. */
export async function runPipelineToCompletion(page: Page): Promise<void> {
  await page.getByTestId('pipeline-run').focus()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('pipeline-run-status')).toHaveAttribute('data-state', 'completed', {
    timeout: 60_000,
  })
}

/** Run the pipeline and wait for the runner's gated (stopped-at-gate) outcome. */
export async function runPipelineToGate(page: Page): Promise<void> {
  await page.getByTestId('pipeline-run').focus()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('pipeline-run-status')).toHaveAttribute('data-state', 'gated', {
    timeout: 60_000,
  })
}

/** One node row, resolved fresh. */
export function pipelineNode(page: Page, nodeId: string): Locator {
  return page.locator(`[data-testid="pipeline-node"][data-node-id="${nodeId}"]`)
}

/**
 * Open one materialized node's grid-native preview (keyboard-operable) and
 * wait for the handle-backed grid to render.
 */
export async function openNodePreview(page: Page, nodeId: string): Promise<void> {
  const button = pipelineNode(page, nodeId).getByTestId('pipeline-preview-open')
  await button.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('pipeline-preview-meta')).toBeVisible({ timeout: 20_000 })
}
