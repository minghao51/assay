---
'@assay/vscode': patch
---

feat(ptv-1): R4 webview feasibility spike (D15 entry work). Adds a spike-labeled VS Code scaffold under `apps/vscode/` — one command that boots `@duckdb/duckdb-wasm` inside a Web Worker inside a desktop webview, opens the on-demand 1M-row Parquet fixture, and emits a machine-readable evidence report (`pnpm --filter @assay/vscode run:spike`). No production extension features; no PT-V commitment. The deliverable report is `docs/engineering/08-vscode-webview-feasibility.md`.

**DevDependencies deviation note (reviewer-visible).** The spike adds six devDependencies to `@assay/vscode`, all spike-only and not part of any production dependency graph:

- `@duckdb/duckdb-wasm@^1.32.0` — the WASM engine the spike must boot in the webview (mirrors `@assay/engine-duckdb`'s dependency; duplicated here because the spike bundles its own worker entry).
- `@vscode/test-electron@^3.1.0` — launches the real VS Code desktop extension host (the only way to measure inside a genuine webview).
- `esbuild@^0.28.2` — bundles the extension host (CJS), webview main thread (ESM) and DuckDB worker (ESM), and copies the WASM assets; the spike must not depend on root/other packages' build tooling.
- `@types/vscode@^1.90.0` — extension API types for typechecking the extension host.
- `@types/node` (`catalog:`) — Node types for the Node-side test-host entry and the spike scripts.
- `typescript` (`catalog:`) — the spike's own `tsc --noEmit` typecheck gate for the extension, webview and test-host entries; not part of any runtime graph.

No runtime `dependencies` are added.
