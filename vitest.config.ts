import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
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
    // f-7: environment by glob instead of per-file happy-dom docblocks — a
    // forgotten docblock can no longer silently run a DOM test in Node. The
    // two include sets are disjoint, so no test is double-run.
    projects: [
      {
        test: {
          name: 'web',
          include: ['apps/web/src/**/*.test.{ts,tsx}'],
          environment: 'happy-dom',
        },
      },
      {
        test: {
          name: 'node',
          include: ['packages/*/src/**/*.test.ts', 'apps/cli/src/**/*.test.{ts,tsx}'],
          environment: 'node',
        },
      },
    ],
  },
})
