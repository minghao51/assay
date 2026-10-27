import { test, expect } from '@playwright/test'

// Cold-start smoke test. ug-2/R-03 also pins the first-run contract here: the
// idle screen explains the capability and formats, and the old
// milestone/roadmap/docs scaffolding is gone from the visible DOM.
test('web app renders the scaffold landing page', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Assay')
})

test('cold start example CTA opens the bundled nested fixture through the ready path', async ({
  page,
}) => {
  const fixtureRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('nested.jsonl')) fixtureRequests.push(request.url())
  })
  await page.goto('/')

  await expect(page.getByTestId('example-data-button')).toHaveText('Try with example data')
  await expect(page.getByTestId('example-data-helper')).toHaveText(
    'Explore nested fields with a small synthetic example.',
  )
  await page.getByTestId('example-data-button').click()

  await expect(page.getByTestId('open-status')).toHaveAttribute('data-phase', 'ready', {
    timeout: 20_000,
  })
  await expect(page.getByTestId('grid')).toBeVisible()
  await expect(page.getByTestId('grid-total-rows')).toHaveText('12')
  await expect(page.getByTestId('grid-column-count')).toHaveText('10')
  expect(fixtureRequests).toEqual([])
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
