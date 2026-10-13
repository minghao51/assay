# Assay — VS Code extension (PT-V)

This package is the **PT-V** surface of the post-MVP plan
(`docs/product/04-post-mvp-track.md`). Since **ptv1-3** it carries a
**production-shape dataset surface** (below) alongside the R4 webview
feasibility spike (queue row **ptv-1**, ruling **D15**; recommendation recorded in
[`docs/engineering/08-vscode-webview-feasibility.md`](../../docs/engineering/08-vscode-webview-feasibility.md)).

## Dataset surface (ptv1-3 bridge + ptv1-4 grid)

- **`Assay: Open dataset` command** — `showOpenDialog` (supported-format filters)
  or an explicit URI, then `vscode.workspace.fs.readFile` and a BYTES bridge
  into the webview.
- **`assay.datasetViewer` custom read-only editor** for the web app's supported
  open set: `*.parquet`, `*.csv`, `*.jsonl`, `*.ndjson`, `*.json`, `*.arrow`,
  `*.feather`, `*.ipc` (contributed with `priority: option`, so VS Code's text
  editor stays the default for text formats).
- **The grid (ptv1-4)** — the headless `GridViewportModel` (`@assay/grid`,
  ADR 0022: rendering replaceable) drives a dependency-free virtualized DOM
  renderer (`webview/data-grid.ts`, the webview twin of the web app's
  `DataGrid`): fixed 28 px rows, viewport + overscan window absolutely
  positioned in a spacer, so DOM nodes stay bounded regardless of dataset
  size (1M rows → ~31 rendered). Sort (header toggles, asc → desc → clear)
  and filter-lite (column + engine-SQL predicate, Apply/Clear) go through the
  model's `setSort`/`setFilters` per the grid contracts; the provider is the
  real `@assay/engine-duckdb` client (`webview/grid-provider.ts`, base read
  path + the m2-1 sort/filter state; the `rowKeys` identity channel comes
  from `@assay/domain`'s `baseRowId`). **Out of slice 1** (recorded in the
  queue): edit/validate/diff in VS Code, Git context, the dataset diff
  command, settings/UI polish.
- **Engine ownership** — the webview session boots the vendored engine ONCE
  per panel (`webview/engine-session.ts`) and the grid fetches windows
  through it for the panel's whole life; disposal is host-orchestrated (the
  command path posts `dispose` before `panel.dispose()`) and the
  custom-editor path tears the page — and the engine worker — down with the
  panel.
- **Keyboard/a11y basics** (the web app's standards, `webview/grid-audit.ts`):
  `role="grid"` viewport with `aria-rowcount`/`aria-colcount`/accessible
  name; header rowgroup/row/columnheader with labeled sort toggles
  (`data-sort` + `aria-sort`); roving tabindex (exactly one rendered row is a
  tab stop, cells `tabindex="-1"` and arrow-addressable — ↑/↓ rows,
  ←/→ cells, Home/End, Ctrl+Home/End first/last row); visible focus outlines;
  labeled filter toolbar; a `role="status"` filter line and `role="alert"`
  command errors. The page audits its own DOM structure (the host cannot
  reach into a webview) and reports the result value-free.
- **Typed error paths surfaced in the webview** (rendered as text, acknowledged
  back to the host): `missing-file`, `unsupported-format` (validated before any
  I/O), `empty-file`, `read-failed`, `engine-failed` — as KIND + PATH-FREE
  text (`WEBVIEW_ERROR_TEXT` in `src/dataset.ts`); full messages stay
  host-side.
- **Posture (made literal in ptv1-4): no file paths in the webview DOM.** The
  bridge posts BYTES + a format-derived neutral name (`dataset.parquet` — the
  engine's format detection needs only the extension, never the user's file
  or folder name) + path-free typed errors. Security: strict shared CSP
  (`src/webview-html.ts`, byte-identical to the R4-measured string), static
  webview HTML, `textContent`/`setAttribute`-only DOM updates (no
  `innerHTML`), dataset values treated as untrusted content, **no telemetry**
  (ADR 0025/0037).

## ptv1-4 grid envelope (the row's done-when, harness-asserted)

`run:spike` mounts the REAL surface modules (`EngineGridProvider` +
`WebviewDataGrid`) over the opened 1M-row fixture and asserts, in the
headline evidence:

- **`grid.firstRowVisible`** — open (`client.open` start) → first ready row's
  cells in the grid DOM **< 1 s**. Method matches R4's `pickerToFirstRow`
  envelope (boot excluded, reported separately as `bootMs`); the spike's raw
  3-column probe fetch ran in between is INCLUDED, so the number is
  conservative. Measured 2026-10-13: **~226–230 ms**.
- **`grid.heapWithinBudget`** — the grid's live main-thread heap DELTA
  (`heap.postGrid − heap.postFirstRow`) **≤ 2.28 MB = R4's 1.14 MB × 2**
  (pinned as `GRID_HEAP_DELTA_BUDGET_BYTES` in `scripts/run-spike.mjs`).
  Method note (a documented deviation from R4's absolute figure): R4's
  1.14 MB was the absolute post-first-row `performance.memory.usedJSHeapSize`
  (forced `window.gc()`; VS Code launched with `--js-flags=--expose-gc`) of
  the PRE-ptv1-1 spike page; since ptv1-2 the vendored-asset plumbing lifts
  the absolute baseline to ~5.7 MB (ptv1-2 state, not grid state), so the
  honest grid-attributable measure is the delta — both samples forced-GC in
  the same run, the post-grid sample after the scroll/sort/filter sweeps
  (bounded steady state). Measured 2026-10-13: **delta 0 bytes** (the grid's
  live set fits inside already-committed heap pages after GC).
- **`grid.domAudit`** (11 structural checks — roles/aria counts/labels/
  roving tabindex/bounded DOM/text-only cells), **`grid.keyboardNavigation`**
  (real ArrowDown/ArrowRight keydowns move the roving focus), and
  **`grid.virtualized`** (a scroll sweep to row 500,000 keeps the rendered
  window bounded — measured 31 rows), **`grid.sortFilterLite`** (the real
  header-button sort cycle asc→desc→clear and the toolbar filter
  `id <= 9` → exactly 10 rows, then clear → 1,000,000 — value-free counts).

## ptv1-3 e2e (real VS Code, `@vscode/test-electron`)

```bash
# From the repo root. First run downloads VS Code 1.130.0 ONCE into the
# canonical cache (~/.vscode-test); every later run is offline-safe.
# (adds xvfb-run itself when headless)
corepack pnpm --filter @assay/vscode run e2e
```

Scenarios (`test/e2e/dataset-runner.ts`, runner `scripts/run-e2e.mjs`, results in
`dist/e2e-results.json`): command open end-to-end (5×4 synthetic Parquet →
vendored engine → rows/columns counts **+ ptv1-4: grid rendered, the webview's
DOM a11y audit held, open→first-row ms**), the custom editor surface
(`vscode.openWith` + tab presence **+ the same grid pins**), and the three
typed error paths (`missing-file`, `unsupported-format`, `empty-file`) each
asserted as **acknowledged by the webview**. Fixtures are committed under `test/fixtures/`
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

Later PT-V rows add the evidence-harness hardening (ptv1-5), a workspace
filesystem adapter (`@assay/data-sources`), edit/validate/diff in VS Code
(MVP scenario 11), Git context integration and a dataset diff command,
reusing `@assay/core`, `@assay/ui` (ADR 0008), with the security constraints
of `docs/engineering/04-testing-security-quality.md` §6 (minimal filesystem
permissions, strict CSP, validated webview messages).
