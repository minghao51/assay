# Assay — VS Code extension (PT-V)

This package is the **PT-V** surface of the post-MVP plan
(`docs/product/04-post-mvp-track.md`). It is currently a **spike scaffold only**: the
R4 webview feasibility spike (queue row **ptv-1**, ruling **D15**) lives here. The
recommendation from that spike is recorded in
[`docs/engineering/08-vscode-webview-feasibility.md`](../../docs/engineering/08-vscode-webview-feasibility.md).

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

When PT-V proper starts, this package will contain a Custom Editor + Webview for the
supported formats, a workspace filesystem adapter (`@assay/data-sources`), Git context
integration and a dataset diff command, reusing `@assay/core`, `@assay/ui`,
`@assay/grid` (ADR 0008), with the security constraints of
`docs/engineering/04-testing-security-quality.md` §6 (minimal filesystem permissions,
strict CSP, validated webview messages).
