import { test, expect } from '@playwright/test'

// Cold-start smoke test. ug-2/R-03 also pins the first-run contract here: the
// idle screen explains the capability and formats, and the old
// milestone/roadmap/docs scaffolding is gone from the visible DOM.
test('web app renders the scaffold landing page', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Assay')
})

test('cold start shows task-oriented idle copy, not roadmap/docs copy', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByTestId('idle-capability')).toHaveText(
    'Inspect, query, validate, compare, and repair local datasets.',
  )
  await expect(page.getByTestId('idle-formats')).toHaveText(
    'Opens .parquet · .csv · .jsonl · .json',
  )
  await expect(page.getByTestId('open-button')).toHaveText('Open a data file…')
  await expect(page.getByTestId('open-status')).toHaveText('No file open')

  const visible = await page.locator('main').innerText()
  for (const forbidden of [
    'MVP complete',
    'PT-0',
    'G0',
    'D12',
    'docs/',
    'Documentation lives',
    'Next:',
    'post-MVP',
    'milestone',
    'roadmap',
  ]) {
    expect(visible).not.toContain(forbidden)
  }
})
