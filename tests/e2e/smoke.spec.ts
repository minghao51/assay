import { test, expect } from '@playwright/test'

// Scaffold smoke test — grows with each M-milestone (see docs/process/project-start-checklist.md).
test('web app renders the scaffold landing page', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Assay')
})
