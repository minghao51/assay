import { defineConfig } from 'vite'

/**
 * Harness-only build: bundles the M1-3 e2e harness (plus the fixture file in
 * harness/public/) into dist/. The root Playwright config serves it with
 * `vite preview` for tests/e2e/data-sources.spec.ts. The library surface
 * itself is consumed as TypeScript source via the package `exports` and is
 * not built here. (Same pattern as packages/engine-duckdb.)
 */
export default defineConfig({
  root: 'harness',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
})
