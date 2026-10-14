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

## Pure bridge unit tests (ptv2-1)

`src/pure/` owns format/name mapping and typed path-free webview error contracts;
`src/dataset.ts` retains compatibility exports and host-only I/O. Root
`corepack pnpm test` discovers the 13 Vitest regression cases without importing
`vscode`. Coverage includes and thresholds are unchanged.

The [desktop slice-2 queue](../../docs/process/handoff/20261014-ptv-slice2-queue.md)
records implementation status. Only its foundation row is integrated so far;
overlay editing, validation, diff and Git workflows are still pending.

## ptv1-3 e2e (real VS Code, `@vscode/test-electron`)

```bash
# From the repo root. Both real-VSCode runners share the pinned 1.130.0
# runtime and canonical ~/.vscode-test/vscode-linux-x64-1.130.0 cache.
# The cache is checked first (offline-safe); a pinned download provisions it
# only when absent. Headless runs add xvfb-run themselves.
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
and writes `dist/spike-results.json`. Its VS Code executable resolution is shared with
e2e through `scripts/vscode-runtime.mjs`: canonical pinned cache first, exact-version
download only if absent, and no system/unpinned fallback when `CI=1`. Outside CI, a
labeled system fallback is allowed only after pinned provisioning fails. Setting
`VSCODE_EXECUTABLE=/path/to/code` is a local-only explicit override; CI rejects the
variable before checking or launching it, so strict CI always uses the pinned
1.130.0 cache/provisioning path. Runtime policy tests run without VS Code or network:
`corepack pnpm --filter @assay/vscode run test:runtime`.

Notable measured findings (full detail in the report):

- `new Worker(webview.asWebviewUri(...))` **fails cross-origin** in a desktop webview;
  the harness blob-wraps the worker scripts and WASM.
- The webview CSP must include `'wasm-unsafe-eval'` and `blob:` in
  `script-src`/`worker-src`/`connect-src`.
- DuckDB-WASM `mvp` (and `eh`) boot without cross-origin isolation; OPFS works.
- `read_parquet` autoloads the Parquet extension from `extensions.duckdb.org` unless it
  is vendored — a PT-V slice-1 requirement.

### Drills

```bash
# ptv1-2 offline drill — NO vendored Parquet bytes, so the stock CDN autoload
# path runs into the armed network block; the harness then asserts the Q5b
# failure mode is REPRODUCED (the open fails with the assay-netblock-refusal
# marker). Expected: drill headline PASS, exit 0.
ASSAY_SPIKE_DRILL=missing-extension DUCKDB=/path/to/duckdb \
  corepack pnpm --filter @assay/vscode run:spike

# R1 exit-code drill (ptv1-5) — sabotages ONLY the built `eh` glue bundle, so
# the mvp path (boot, vendored serve, 1M open, grid surface) stays green while
# the eh boot fails. Expected: headline FAIL naming `bundles.eh.ok`, NON-ZERO
# exit (the ptv-1 review carry-over: an eh-only boot failure must not pass).
ASSAY_SPIKE_DRILL=eh-boot-failure DUCKDB=/path/to/duckdb \
  corepack pnpm --filter @assay/vscode run:spike
```

## Slice-1 exit harness — clean-worktree runbook (ptv1-5)

`run:spike` is the PT-V slice-1 exit harness: it asserts the ptv1-1…ptv1-4
headline claims and exits non-zero otherwise. The done-when bar is
**reviewer-reproducible from a clean worktree via committed commands only** —
verified end-to-end for this exact sequence (ptv1-5, 2026-10-13):

```bash
# 1. A clean tree — fresh clone, or a worktree pinned to the slice-1 tip:
git clone <repo-url> /tmp/assay-slice1-verify
#    (or: git worktree add /tmp/assay-slice1-verify <slice-1 tip>)
cd /tmp/assay-slice1-verify

# 2. Install (Node >= 22 via corepack; no other setup):
corepack pnpm install

# 3. The exit harness — expected: headline PASS, exit 0. DUCKDB points at a
#    DuckDB CLI (used only to generate the 1M-row SYNTHETIC fixture on demand;
#    the system `duckdb` is used when DUCKDB is unset). Headless boxes are
#    handled: the script adds xvfb-run itself; both harnesses use the exact
#    pinned 1.130.0 runtime in ~/.vscode-test (provisioned if absent).
DUCKDB=/path/to/duckdb corepack pnpm --filter @assay/vscode run:spike

# 4. The two drills (expected exits as annotated above):
ASSAY_SPIKE_DRILL=missing-extension DUCKDB=/path/to/duckdb \
  corepack pnpm --filter @assay/vscode run:spike
ASSAY_SPIKE_DRILL=eh-boot-failure DUCKDB=/path/to/duckdb \
  corepack pnpm --filter @assay/vscode run:spike
```

Every run writes value-free evidence to `dist/spike-results.json` and prints
the summary (including the R2 timing envelopes: mvp/eh boot ms, the open
envelope, TTFR picker→first-row, the live-heap delta) plus a final
`headline evidence: PASS (…)` line listing every asserted check.

### Headline assertion inventory (claim → check)

| Claim (row)                                                             | Headline check(s)                                                                                                          |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Real `@assay/engine-duckdb` adapter, not spike-local (ptv1-1)           | `bundles.mvp.adapter` (+ `bundles.mvp.ok`)                                                                                 |
| Engine boots in the webview, BOTH bundles (ptv-1; R1 carry-over)        | `bundles.mvp.ok`, `bundles.eh.ok`                                                                                          |
| Zero network fetches; vendored Parquet served locally (ptv1-2)          | `vendored.parquet.servedLocally`, `vendored.engineVersionPin`, `offline.blockedHostPinned` + the `missing-extension` drill |
| 1M-row synthetic opens; rows > 0; OPFS round-trip (ptv-1/ptv1-3/ptv1-4) | `fixture.rows`, `opfs.roundTrip`                                                                                           |
| TTFR open→first-row < 1 s (ptv1-4)                                      | `grid.firstRowVisible`                                                                                                     |
| Live-heap delta within the pinned budget (ptv1-4)                       | `grid.heapWithinBudget`                                                                                                    |
| Grid a11y STRUCTURE — roving-tabindex audit (ptv1-4)                    | `grid.domAudit`                                                                                                            |
| Grid a11y BEHAVIOR — real-keydown probe (ptv1-4)                        | `grid.keyboardNavigation` — the audit + probe pair is COMPLEMENTARY (each catches what the other misses); keep BOTH        |
| Virtualized bounded DOM (ptv1-4)                                        | `grid.virtualized`                                                                                                         |
| Sort/filter-lite contracts (ptv1-4)                                     | `grid.sortFilterLite`                                                                                                      |

Later PT-V rows add a workspace filesystem adapter (`@assay/data-sources`),
edit/validate/diff in VS Code (MVP scenario 11), Git context integration and
a dataset diff command, reusing `@assay/core`, `@assay/ui` (ADR 0008), with
the security constraints of
`docs/engineering/04-testing-security-quality.md` §6 (minimal filesystem
permissions, strict CSP, validated webview messages).
