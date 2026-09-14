import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  report: 'list',
  use: {
    baseURL: 'http://localhost:4173',
  },
  webServer: {
    command: 'pnpm --filter @dataworkbench/web exec vite preview --port 4173 --strictPort',
    port: 4173,
    reuseExistingServer: !process.env['CI'],
  },
})
