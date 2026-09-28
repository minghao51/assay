import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.{ts,tsx}'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // Modest floor with ≈5 pts of headroom below the 2026-09-28 measured
      // totals (statements 90.19 / branches 83.44 / functions 89.16 /
      // lines 91.60); bump deliberately as coverage improves, never lower
      // it to make a red run pass.
      thresholds: {
        statements: 85,
        branches: 78,
        functions: 84,
        lines: 86,
      },
    },
  },
})
