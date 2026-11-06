import { expect, test } from './support/fixture'
import type { Page } from '@playwright/test'
import { openSection } from './support/fixtures'
import { writeValidationDatasetA } from './support/validation-datasets'

// ug-17 / UG-27: state summaries on the shell-owned collapsed section toggles.
// The app under test is the real composition root and the real DuckDB-WASM
// engine; the dataset + contract are the runtime-built, CLI-pinned m5-3
// fixtures (never committed). This spec proves the rendered, COLLAPSED
// summary: `Validation · 4 failing` (the pinned 4-of-9-rules verdict) lives
// inside the section toggle while the section body is `hidden`, joins the
// toggle's description after the R-14 purpose id, and never renders at 0 —
// plus the `History · N pending` source through a staged edit and undo.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      delete (window as { showOpenFilePicker?: unknown }).showOpenFilePicker
    } catch {
      // Non-configurable global would be a Chromium change; fail loudly later.
    }
  })
})

/** Open a dataset through the hidden-input fallback and wait for ready. */
async function openDataset(page: Page, dataPath: string): Promise<void> {
  await page.goto('/')
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'idle', {
    timeout: 20_000,
  })
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('open-button').click()
  await (await chooserPromise).setFiles(dataPath)
  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'ready', {
    timeout: 20_000,
  })
}

test('collapsed section toggles carry value-free state summaries', async ({ page }) => {
  test.setTimeout(180_000)
  const dataset = writeValidationDatasetA()
  await openDataset(page, dataset.dataPath)

  // --- Default (no user expansion): no summary anywhere, purpose only. ---
  const validationToggle = page.getByTestId('section-toggle-validation')
  const historyToggle = page.getByTestId('section-toggle-history')
  await expect(validationToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(historyToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('[data-testid^="section-summary-"]')).toHaveCount(0)
  await expect(validationToggle).toHaveAttribute('aria-describedby', 'section-validation-purpose')

  // --- Validation verdict: 4 of 9 rules fail (the CLI-pinned counts). ---
  await openSection(page, 'validation')
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByTestId('validation-open-contract').click()
  await (await chooserPromise).setFiles(dataset.contractPath)
  await expect(page.getByTestId('validation-contract-name')).toHaveText('orders-basic')
  await page.getByTestId('validation-run').click()
  await expect(page.getByTestId('validation-verdict')).toHaveText(
    '4 of 9 rules fail (7 rows checked).',
  )

  // Collapse the section again: the summary stays VISIBLE inside the toggle
  // (the body is hidden — that is the whole point of the summary).
  await validationToggle.click()
  await expect(validationToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page.locator('#section-validation-content')).toBeHidden()

  const validationSummary = page.getByTestId('section-summary-validation')
  await expect(validationSummary).toHaveText('Validation · 4 failing')
  await expect(validationSummary).toBeVisible()
  await expect(page.locator('#section-validation-summary')).toBeVisible()

  // A11y: description order (purpose, then summary); name unchanged.
  await expect(validationToggle).toHaveAttribute(
    'aria-describedby',
    'section-validation-purpose section-validation-summary',
  )
  await expect(page.getByRole('button', { name: 'Expand Validation' })).toBeVisible()

  // No summary on inner-disclosure sections or on the untouched managed ones.
  for (const id of ['schema', 'filters', 'profile', 'record', 'compare', 'history']) {
    await expect(page.getByTestId(`section-summary-${id}`)).toHaveCount(0)
  }

  // --- History pending: a staged edit is visible while History is collapsed. ---
  await openSection(page, 'editing')
  await page.getByTestId('edit-insert-row').click()
  const historySummary = page.getByTestId('section-summary-history')
  await expect(historySummary).toHaveText('History · 1 pending')
  // ug-6: the FIRST appended op now auto-expands History (the 0 → >0 cue).
  // Collapse it again so this spec still pins the COLLAPSED summary it owns;
  // the cue is one-shot, so nothing later here can re-open it.
  await expect(historyToggle).toHaveAttribute('aria-expanded', 'true')
  await historyToggle.click()
  await expect(historyToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(historySummary).toBeVisible()
  await expect(page.locator('#section-history-content')).toBeHidden()
  await expect(historyToggle).toHaveAttribute(
    'aria-describedby',
    'section-history-purpose section-history-summary',
  )

  // Undo back to zero: the summary element disappears (never "0 pending").
  await openSection(page, 'history')
  await page.getByTestId('history-undo').click()
  await expect(page.getByTestId('section-summary-history')).toHaveCount(0)
  await expect(historyToggle).toHaveAttribute('aria-describedby', 'section-history-purpose')
})
