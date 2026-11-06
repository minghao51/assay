import { expect, test } from './support/fixture'

/**
 * Telemetry surface e2e (design §6/§8; ADR 0037/0045).
 *
 * The e2e server runs the STOCK build: no collector endpoint is configured at
 * build time, so telemetry is inert (R6). These pins assert that externally —
 * no disclosure appears, the Settings affordance is present and persists an
 * opt-out, and no collector-shaped request is ever made.
 */

const COLLECTOR_REQUEST = /collector\.example|\/telemetry\/ingest|\/collect$/i

test('stock build is inert: no disclosure and no collector requests', async ({ page }) => {
  const telemetryRequests: string[] = []
  page.on('request', (request) => {
    if (COLLECTOR_REQUEST.test(request.url())) telemetryRequests.push(request.url())
  })

  await page.goto('/')
  await expect(page.getByTestId('settings-toggle')).toBeVisible()
  // No endpoint is baked into the stock build, so the first-run disclosure
  // must not render.
  await expect(page.getByTestId('telemetry-disclosure')).toHaveCount(0)
  expect(telemetryRequests).toEqual([])
})

test('Settings toggle persists the opt-out across a reload', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('settings-toggle').click()
  const toggle = page.getByTestId('telemetry-toggle')
  await expect(toggle).toBeVisible()
  await expect(toggle).toBeChecked()
  await toggle.click()
  await expect(toggle).not.toBeChecked()

  await page.reload()
  await page.getByTestId('settings-toggle').click()
  await expect(page.getByTestId('telemetry-toggle')).not.toBeChecked()
})

test('opt-out never blocks the app: the open flow still works', async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem('assay.telemetry', 'off')
  })
  await page.goto('/')
  await expect(page.getByTestId('open-button')).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Assay')
})
