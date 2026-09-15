import { defineConfig } from 'vite'

/**
 * Harness-only build: bundles the M1-1 e2e harness (plus the engine worker
 * and the DuckDB-WASM assets referenced via `?url`) into dist/. The root
 * Playwright config serves it with `vite preview` for
 * tests/e2e/engine-duckdb.spec.ts. The library surface itself is consumed as
 * TypeScript source via the package `exports` and is not built here.
 */
export default defineConfig({
  root: 'harness',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
})
