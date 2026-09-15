import { expect, test } from '@playwright/test'

// Task M1-1 proof (handoff §6 #1): the engine boots lazily inside a Web
// Worker (never on the main thread) and DuckDB answers a smoke query.
// DuckDB-WASM cannot run under Node vitest — this e2e is the authoritative
// proof. Harness served from packages/engine-duckdb by the second webServer
// in playwright.config.ts.
const HARNESS_URL = 'http://localhost:4179/'

test('engine-duckdb boots lazily in a worker and SELECT 42 returns', async ({ page }) => {
  await page.goto(HARNESS_URL)

  // Laziness: loading the page must not boot the engine.
  await expect(page.getByTestId('engine-status')).toHaveText('idle')

  await page.getByRole('button', { name: 'Boot engine and run SELECT 42' }).click()

  // The real DuckDB engine answered: status is ready and the scalar came back.
  await expect(page.getByTestId('engine-status')).toHaveText('ready')
  const result = page.getByTestId('query-result')
  await expect(result).toContainText(/"duckdbVersion": "v\d+\.\d+/)
  await expect(result).toContainText('"rowCount": 1')
  await expect(result).toContainText('"rows": [\n    [\n      42\n    ]\n  ]')
})
