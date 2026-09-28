import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      // f-6 (round 2): pin a broad include so untested modules stay in the
      // denominator at 0% instead of silently dropping out of the report
      // (the default only measures files a test happened to load). Test/spec
      // files and build artefacts remain excluded by Vitest's hard-coded
      // coverage exclusions.
      include: ['packages/*/src/**/*.{ts,tsx}', 'apps/*/src/**/*.{ts,tsx}'],
      reporter: ['text', 'json-summary'],
      // Modest floor with ≈5 pts of headroom below the 2026-09-28 strict
      // totals (statements 88.05 / branches 81.84 / functions 85.60 /
      // lines 89.29) measured with the broad include above, so untested
      // modules count against the denominator at 0%. Bump deliberately as
      // coverage improves, never lower it to make a red run pass.
      thresholds: {
        statements: 83,
        branches: 76,
        functions: 80,
        lines: 84,
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
