import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  report: 'list',
  use: {
    baseURL: 'http://localhost:4173',
  },
  webServer: [
    {
      command: 'pnpm --filter @assay/web exec vite preview --port 4173 --strictPort',
      port: 4173,
      reuseExistingServer: !process.env['CI'],
    },
    {
      // engine-duckdb M1-1 harness: lazy worker boot + SELECT-smoke proof
      // (built by `pnpm build` via the package's `vite build`).
      command: 'pnpm --filter @assay/engine-duckdb exec vite preview --port 4179 --strictPort',
      port: 4179,
      reuseExistingServer: !process.env['CI'],
    },
  ],
})
