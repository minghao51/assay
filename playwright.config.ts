import { defineConfig } from '@playwright/test'

// Ports are env-overridable so parallel agent batches can run the full e2e
// suite in isolated git worktrees without port collisions (handoff §7.4).
// Defaults are the canonical local ports.
const PORT_WEB = Number(process.env['ASSAY_E2E_PORT_WEB'] ?? 4173)
const PORT_ENGINE = Number(process.env['ASSAY_E2E_PORT_ENGINE'] ?? 4179)
const PORT_DS = Number(process.env['ASSAY_E2E_PORT_DS'] ?? 4180)

export default defineConfig({
  testDir: './tests/e2e',
  report: 'list',
  use: {
    baseURL: `http://localhost:${PORT_WEB}`,
  },
  webServer: [
    {
      command: `pnpm --filter @assay/web exec vite preview --port ${PORT_WEB} --strictPort`,
      port: PORT_WEB,
      reuseExistingServer: !process.env['CI'],
    },
    {
      // engine-duckdb M1 harness (m1-1/m1-2): lazy worker boot + first Arrow batch proof
      // (built by `pnpm build` via the package's `vite build`).
      command: `pnpm --filter @assay/engine-duckdb exec vite preview --port ${PORT_ENGINE} --strictPort`,
      port: PORT_ENGINE,
      reuseExistingServer: !process.env['CI'],
    },
    {
      // data-sources M1 harness (m1-3): BrowserFileSource FSA + input-fallback proof
      // (built by `pnpm build` via the package's `vite build`).
      command: `pnpm --filter @assay/data-sources exec vite preview --port ${PORT_DS} --strictPort`,
      port: PORT_DS,
      reuseExistingServer: !process.env['CI'],
    },
  ],
})
