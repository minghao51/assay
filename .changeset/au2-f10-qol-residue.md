---
'@assay/engine-duckdb': patch
'@assay/data-sources': patch
---

chore(au2-f10): QoL residue batch.

- `@assay/engine-duckdb`, `@assay/data-sources`, and `@assay/web` now declare
  the `node: ">=22"` engines floor (AGENTS.md support floor; `.node-version`
  `24` stays the dev/CI pin within that range).
- `@assay/engine-duckdb` gains a package `README.md` documenting the
  DuckDB-WASM worker engine (ADR 0002/0020/0021), the two `dist/` build
  outputs (vite e2e harness vs. the tsc library), the flat `files`-glob
  rationale that keeps the packed tarball library-only (au2-2 pack finding),
  the `./node` environment-neutral seam (m5-4), and the M1 e2e/conformance
  harness.
- `@assay/data-sources` documents in-package why its `build` script stays
  named `build`: it bundles the M1-3 e2e harness (vite) into `dist/` and is
  required by both the turbo `build` graph and the Playwright preview
  webServer; the library surface is consumed as TypeScript source. The script
  is not renamed.

No runtime or product behavior change.
