// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineConfig } from '@playwright/test'

/**
 * uxv-1 / R-09 configured-disclosure leg (implementation spec §6).
 *
 * The stock e2e suite runs the STOCK build, where no collector endpoint is
 * baked in, so the first-run disclosure deliberately never renders
 * (`tests/e2e/telemetry.spec.ts` pins that). The disclosure's theme therefore
 * cannot be proved there — it needs a build with `ASSAY_TELEMETRY_ENDPOINT`
 * set, and the stock telemetry spec must never run against such a build.
 *
 * This config is the isolated home of that proof: it lives in `tests/visual`,
 * keeps discovery to its own spec via an explicit `testDir`/`testMatch`
 * (outside the default `tests/e2e` testDir), and reuses the base settings
 * posture while adding the two safety rails the spec mandates — service
 * workers blocked and a context route that aborts every collector request
 * before any navigation (registered by the spec itself).
 *
 * Assigned ports for this leg: web 4473 / engine 4479 / data-sources 4480
 * (never the stock 4273/4279/4280 set, so a configured preview can never be
 * mistaken for the stock one).
 */

const PORT_WEB = Number(process.env['ASSAY_E2E_PORT_WEB'] ?? 4473)
const PORT_ENGINE = Number(process.env['ASSAY_E2E_PORT_ENGINE'] ?? 4479)
const PORT_DS = Number(process.env['ASSAY_E2E_PORT_DS'] ?? 4480)

export default defineConfig({
  // This config lives in tests/visual, so '.' keeps discovery isolated here;
  // `testMatch` pins it to the single configured-disclosure spec.
  testDir: '.',
  testMatch: '**/telemetry-disclosure-theme.spec.ts',
  // Never inherit a committed `.only`.
  forbidOnly: !!process.env['CI'],
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT_WEB}`,
    // No service worker may stand between the page and the aborted collector.
    serviceWorkers: 'block',
    // Fresh storage per test (each test gets its own context, and the spec
    // clears local storage at document start) so the disclosure is always the
    // genuine first-run state.
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  webServer: [
    {
      // Serves the CONFIGURED web build (`apps/web/dist`, built by
      // `ASSAY_TELEMETRY_ENDPOINT=… pnpm build`) — no custom vite config, so
      // the app source under test is the production source, unchanged.
      command: `pnpm --filter @assay/web exec vite preview --host 127.0.0.1 --port ${PORT_WEB} --strictPort`,
      port: PORT_WEB,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `pnpm --filter @assay/engine-duckdb exec vite preview --host 127.0.0.1 --port ${PORT_ENGINE} --strictPort`,
      port: PORT_ENGINE,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `pnpm --filter @assay/data-sources exec vite preview --host 127.0.0.1 --port ${PORT_DS} --strictPort`,
      port: PORT_DS,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
})
