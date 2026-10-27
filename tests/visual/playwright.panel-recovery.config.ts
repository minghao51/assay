// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineConfig } from '@playwright/test'

const PORT_WEB = Number(process.env['ASSAY_E2E_PORT_WEB'] ?? 4473)
const PORT_ENGINE = Number(process.env['ASSAY_E2E_PORT_ENGINE'] ?? 4479)
const PORT_DS = Number(process.env['ASSAY_E2E_PORT_DS'] ?? 4480)

/** Isolated browser proof; never expands stock tests/e2e discovery. */
export default defineConfig({
  // This config lives in tests/visual, so '.' keeps discovery isolated here.
  testDir: '.',
  testMatch: '**/panel-recovery.spec.ts',
  forbidOnly: !!process.env['CI'],
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT_WEB}`,
    serviceWorkers: 'block',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  webServer: [
    {
      command: `pnpm --filter @assay/web exec vite preview --config ../../tests/visual/vite.panel-recovery.config.ts --host 127.0.0.1 --port ${PORT_WEB} --strictPort`,
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
