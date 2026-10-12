# Assay — VS Code extension (PT-V)

This package is the **PT-V** surface of the post-MVP plan
(`docs/product/04-post-mvp-track.md`). Since **ptv1-3** it carries a
**production-shape dataset surface** (below) alongside the R4 webview
feasibility spike (queue row **ptv-1**, ruling **D15**; recommendation recorded in
[`docs/engineering/08-vscode-webview-feasibility.md`](../../docs/engineering/08-vscode-webview-feasibility.md)).

## Dataset surface (ptv1-3)

- **`Assay: Open dataset` command** — `showOpenDialog` (supported-format filters)
  or an explicit URI, then `vscode.workspace.fs.readFile` and a BYTES bridge
  into the webview (no file paths cross into the webview DOM).
- **`assay.datasetViewer` custom read-only editor** for the web app's supported
  open set: `*.parquet`, `*.csv`, `*.jsonl`, `*.ndjson`, `*.json`, `*.arrow`,
  `*.feather`, `*.ipc` (contributed with `priority: option`, so VS Code's text
  editor stays the default for text formats).
- The webview boots the **vendored local-first engine** (ptv1-1 seam + ptv1-2
  vendored assets — zero network fetches) through the real
  `@assay/engine-duckdb` client and reports value-free counts only (rows ×
  columns; the grid surface is ptv1-4).
- **Typed error paths surfaced in the webview** (rendered as text, acknowledged
  back to the host): `missing-file`, `unsupported-format` (validated before any
  I/O), `empty-file`, `read-failed`, `engine-failed`.
- Security: strict shared CSP (`src/webview-html.ts`), static webview HTML,
  `textContent`-only DOM updates (no `innerHTML`), dataset values treated as
  untrusted content, **no telemetry** (ADR 0025/0037).

## ptv1-3 e2e (real VS Code, `@vscode/test-electron`)

```bash
# From the repo root. First run downloads VS Code 1.130.0 ONCE into the
# canonical cache (~/.vscode-test); every later run is offline-safe.
# (adds xvfb-run itself when headless)
corepack pnpm --filter @assay/vscode run e2e
```

Scenarios (`test/e2e/dataset-runner.ts`, runner `scripts/run-e2e.mjs`, results in
`dist/e2e-results.json`): command open end-to-end (5×4 synthetic Parquet →
vendored engine → rows/columns counts), the custom editor surface
(`vscode.openWith` + tab presence), and the three typed error paths
(`missing-file`, `unsupported-format`, `empty-file`) each asserted as
**acknowledged by the webview**. Fixtures are committed under `test/fixtures/`
(`synthetic-smoke.parquet` 662 B sha256
`fe2e9ac437ff421a2441fce33c3d95f907b89eaf235e13a1225f54d76b4c9b98`, `empty.csv`
0 B) — regenerate ONLY deliberately via `pnpm --filter @assay/vscode run generate:fixtures`
(`DUCKDB=/path/to/duckdb`).

## R4 webview spike (ptv-1)

The scaffold is deliberately minimal: one command (`assay.spike.run`) that opens a
webview, hands it the 1M-row on-demand Parquet fixture, and returns a machine-readable
evidence report (DuckDB-WASM worker boot, cross-origin isolation, COOP/COEP headers,
OPFS reachability, File System Access API presence, heap/TTFR, packaging sizes). It is
**not** a product extension and does not commit PT-V.

```bash
# From the repo root; DUCKDB CLI required for the 1M-row fixture.
DUCKDB=/tmp/duckdb corepack pnpm --filter @assay/vscode run:spike
```

`run:spike` generates the fixture, esbuild-bundles the extension host, webview main
thread and DuckDB worker (plus the `mvp`/`eh` WASM assets), launches the real VS Code
desktop extension host via `@vscode/test-electron` (adding `xvfb-run` when headless),
and writes `dist/spike-results.json`.

Notable measured findings (full detail in the report):

- `new Worker(webview.asWebviewUri(...))` **fails cross-origin** in a desktop webview;
  the harness blob-wraps the worker scripts and WASM.
- The webview CSP must include `'wasm-unsafe-eval'` and `blob:` in
  `script-src`/`worker-src`/`connect-src`.
- DuckDB-WASM `mvp` (and `eh`) boot without cross-origin isolation; OPFS works.
- `read_parquet` autoloads the Parquet extension from `extensions.duckdb.org` unless it
  is vendored — a PT-V slice-1 requirement.

Later PT-V rows add the headless-grid dataset view (ptv1-4), the evidence
harness (ptv1-5), a workspace filesystem adapter (`@assay/data-sources`), Git
context integration and a dataset diff command, reusing `@assay/core`,
`@assay/ui`, `@assay/grid` (ADR 0008), with the security constraints of
`docs/engineering/04-testing-security-quality.md` §6 (minimal filesystem
permissions, strict CSP, validated webview messages).
