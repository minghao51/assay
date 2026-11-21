import { configDefaults, defineConfig } from 'vitest/config'

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
    // include sets are disjoint, so no test is double-run.
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
          include: [
            'packages/*/src/**/*.test.ts',
            'apps/cli/src/**/*.test.{ts,tsx}',
            'apps/vscode/src/pure/**/*.test.ts',
            // A02/A04: the repo's zero-dependency tooling scripts are plain
            // Node ESM with injected seams; their tests live beside them and
            // need the node environment. No coverage impact — the coverage
            // include is `src/**` only.
            'scripts/**/*.test.mjs',
          ],
          // gd-1: keep the include sets disjoint — the spawn-heavy CLI
          // integration files belong to the `cli-integration` project below
          // (running them here too would double-run them and re-mix budgets).
          exclude: [...configDefaults.exclude, 'apps/cli/src/**/*.integration.test.ts'],
          environment: 'node',
        },
      },
      {
        // D03b: the desktop webview's extracted presentation controllers
        // (`apps/vscode/webview/{validation-panel,diff-panel,dirty-history}.ts`)
        // are DOM-bound, so their tests need a DOM. They add NO coverage
        // denominator and claim none: the coverage include is
        // `apps/*/src/**`, and `apps/vscode/webview` stays outside it (a
        // browser coverage collector is the separate D03/A04 decision). The
        // include set is disjoint from the other projects, so nothing is
        // double-run.
        test: {
          name: 'vscode-webview',
          include: ['apps/vscode/webview/**/*.test.ts'],
          environment: 'happy-dom',
        },
      },
      {
        // gd-1 (2026-10-28): the CLI integration gate is the only spawn-heavy
        // suite. Every test shells out to the COMPILED CLI in a fresh process
        // (`node --import tsx dist/index.js …`, ADR 0042), and the tsx + module
        // load costs ≈300 ms per spawn solo (measured n=3: 306/310/330 ms).
        // The grouped `diff` usage-error test (six spawns) measures 1.75–1.80 s
        // solo, so at vitest's default 16 workers on this host peak contention
        // pushed the SAME test past the 5000 ms default ceiling (reproduced
        // 2026-10-28: 3070 passed / 1 failed; neighbours with three and six
        // spawns measured 1.2 s and 1.5 s in that run ⇒ ≥2.8x per-spawn
        // inflation). A 20 s budget is ~4x the failing ceiling and ~11x the
        // solo cost — a budget, never 0/Infinity, and scoped to this project
        // only (every other project keeps the 5000 ms default). It absorbs
        // scheduler contention; it relaxes no expected byte, exit code, stream
        // or assertion. 20 s matches the already-documented budget of
        // `test:coverage` (`--testTimeout=20000`).
        test: {
          name: 'cli-integration',
          include: ['apps/cli/src/**/*.integration.test.ts'],
          environment: 'node',
          testTimeout: 20_000,
        },
      },
    ],
  },
})
