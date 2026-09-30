import path from 'node:path'
import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'

/**
 * Shared pipeline-panel drive (p-5). Every pick gesture — dataset, pipeline
 * file, per-source dataset — rides the hidden-`<input type="file">` fallback
 * (the m1-5 pattern: `showOpenFilePicker` is deleted in `beforeEach`), so
 * each arrives as a `filechooser` event. All in-app activations are plain
 * buttons/links, so the keyboard journey can `focus()` + `Enter` the same
 * controls a mouse user clicks.
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
 * Open the app with a dataset (the workbench frame exists only ready),
 * navigate to the provisional Pipeline section by its keyboard-reachable
 * nav link, and open the pipeline file through the real picker path.
 */
export async function openPipelineDocument(page: Page): Promise<void> {
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
  await (await chooserPromise).setFiles(PIPELINE_FIXTURE)
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

/** Run the pipeline and wait for the runner's completed outcome. */
export async function runPipelineToCompletion(page: Page): Promise<void> {
  await page.getByTestId('pipeline-run').focus()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('pipeline-run-status')).toHaveAttribute('data-state', 'completed', {
    timeout: 60_000,
  })
}
