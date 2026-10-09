# PT-V slice-1 queue — VS Code desktop webview (engine in the webview)

Opened 2026-10-02 off ruling **D18(a)** — PT-V slice 1 starts on the **desktop-extension webview**;
**vscode-web stays RE-SCOPE and is OUT OF SCOPE for this queue** (uncommitted per D18) — reading
the R4 report
([08-vscode-webview-feasibility.md](../../engineering/08-vscode-webview-feasibility.md);
[rulings file](20260926-maintainer-rulings.md)). Spike evidence this slice builds on: **no COI
needed for the `mvp` build**; a **blob-URL bootstrap + CSP `'wasm-unsafe-eval'`/`blob:`** are
required; **OPFS works**; 1M rows ≈41–48 ms TTFR / 1.14 MB live heap; one ~40 MB bundle; the
**Parquet extension autoloads from the CDN — must be vendored**. Five rows, serialized. Operating
model: [`operating-model.md`](operating-model.md) §7.1–7.6 (worker → independent reviewer →
orchestrator-integrate; one task per dispatch). Slice-1 scope per
[post-MVP §5](../../product/04-post-mvp-track.md) and the report §8/§10 mandatory items.

**Entry condition:** met — rulings D17/D18 passed 2026-10-02 on a green tree. Baseline at open:
`main` = `6daa81c`; the full eight gates green at `a02ba9d` (unit **2681**/168 files, e2e
**170+1**, lint 0-0, typecheck 20, build 10, coverage 90.11/84.02/89.59/91.62, docs:links 99
files/0 broken, adr:index 46 records — 38 accepted/8 proposed), **141** changesets; the two
commits since are docs-only (format/docs:links/adr:index verified).

## 1. Queue

| task                                                                | scope/done-when                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | status           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| ptv1-1 — **Engine webview adapter (bundler-agnostic worker seam).** | `packages/engine-duckdb/**` + `apps/vscode/**`. Today the client hard-codes `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })` (`src/client.ts:308-311`; also `src/index.ts:287-290`; the inner DuckDB worker `src/worker.ts:86`). Add an injectable worker-factory + asset-URL seam so a host supplies blob-URL bootstrapping (the spike-proven `toBlobUrl` in `apps/vscode/webview/main.ts`) and the measured CSP (the spike's `buildHtml`). Worker entries: esbuild for the extension, Vite for web — one shared worker core. Done-when: the seam lands with default web behavior byte-identical (existing tests green, no Vite regression); headless unit pins for the injection logic (the `engine-target-compat.test.ts` patterns); the spike harness boots the real adapter, not spike-local code. `feat(ptv1-1):` + changeset (`@assay/engine-duckdb`, `@assay/vscode`). **First.** | **not started.** |
| ptv1-2 — **Vendored engine assets (local-first).**                  | `apps/vscode/**`. Vendor `duckdb-mvp.wasm` + `duckdb-browser-mvp.worker.js` + the Parquet extension; the webview opens datasets with ZERO network fetches. Done-when: the harness runs network-blocked (assert no request to `extensions.duckdb.org` — pin the spike's Q5b failure mode as fixed); the extension-version pin documented; a package-size report (~40 MB) in harness output; a license note (DuckDB-WASM MIT — AGPL-compatible per AGENTS.md). `feat(ptv1-2):` + changeset (`@assay/vscode`). **Second.**                                                                                                                                                                                                                                                                                                                                                                                            | **not started.** |
| ptv1-3 — **Extension host + workspace adapter.**                    | `apps/vscode/**`. Production-shape (no longer spike-only): activation, command/custom-editor surface for supported formats, `showOpenDialog` + `workspace.fs.readFile` → webview bytes bridge, error/empty-file handling. Done-when: real VS Code (`@vscode/test-electron`) opens a workspace file end-to-end; typed error paths (missing file, unsupported format) surface in the webview; no `innerHTML` violations; no telemetry. `feat(ptv1-3):` + changeset (`@assay/vscode`). **Third.**                                                                                                                                                                                                                                                                                                                                                                                                                     | **not started.** |
| ptv1-4 — **Webview dataset surface on the headless grid.**          | `apps/vscode/**` (reusing the `packages/grid` headless API — `GridViewportModel` + contracts are DOM-free — and `packages/domain`; ADR 0008/0022). Minimal open→inspect: file opens → grid renders (virtualized viewport) → sort/filter-lite per the grid contracts. **OUT OF SLICE 1 (recorded explicitly):** edit/validate/diff in VS Code (MVP scenario 11 = the track exit, later slices), Git context, the dataset diff command, settings/UI polish. Done-when: a 1M-row synthetic fixture opens → first row visible < 1 s (picker→first-row envelope) and live heap within the spike-measured budget in the harness; keyboard/a11y basics consistent with the web app's standards; a11y checks to the extent harness-testable. `feat(ptv1-4):` + changeset (`@assay/vscode`). **Fourth.**                                                                                                                    | **not started.** |
| ptv1-5 — **Evidence harness + carry-list hardening.**               | `apps/vscode/**`. Upgrade `run:spike` into the slice-1 exit harness: the pass/fail assertion extended with the ptv1-1…ptv1-4 headline claims; **R1 FIXED** — an `eh`-only boot failure exits non-zero (the ptv-1 review carry-over); **R2** timing envelopes re-measured in harness output (report text updated by the orchestrator at integration); offline + memory-budget + boot pins asserted. Done-when: the harness green end-to-end from a clean worktree via committed commands; reviewer-reproducible (the ptv-1 precedent); no production features beyond the ptv1-3/ptv1-4 scope. `test(ptv1-5):`/`chore(ptv1-5):` + changeset (`@assay/vscode`). **Last — closes the slice.**                                                                                                                                                                                                                          | **not started.** |

## 2. Ordering, parallelism & conflict rules

1. **The table order is the dispatch lane** (ptv1-1 seam → ptv1-2 assets → ptv1-3 extension host →
   ptv1-4 webview surface → ptv1-5 harness). One worker per row; worker → independent reviewer per
   [operating-model §7.1–7.3](operating-model.md); serialized subagent dispatches.
2. **Serialization rule (identical in both queues):** the two queues share the
   `packages/engine-duckdb` surface (P3's runner work; PT-V's client/worker seam) — per
   [operating-model §7.4](operating-model.md) they run on **ONE serialized dispatch lane**: one
   queue at a time, one row at a time. Default order: **P3 first** (the D17 chain), PT-V slice 1
   second; the orchestrator may interleave a PT-V row touching only `apps/vscode/**` if P3's
   in-flight row does not touch `engine-duckdb`. No worktree parallelism unless the orchestrator
   explicitly splits lanes.
3. **STOP boundaries:** any vscode-web work (RE-SCOPE, uncommitted per D18); any production
   feature beyond the row scope (the slice-2 items listed out in ptv1-4); any engine change
   altering web-app behavior (the seam defaults byte-identical for web); boundary crossings.

## 3. Standing notes (invariants every task respects)

- **D18 discipline:** desktop target only — vscode-web stays RE-SCOPE and out of scope for every
  row in this queue.
- **Privacy:** local fixtures only; no telemetry; nothing new (`pipeline_run` stays reserved).
- **ADR anchors:** [ADR 0008](../../adr/0008-shared-core-web-vscode-cli.md) (shared core) +
  [ADR 0022](../../adr/0022-headless-grid-and-renderer-strategy.md) (headless grid, replaceable
  rendering).
- The seam must not regress the web app — the web app's gates are the proof.
- One Conventional Commit + changeset (`@assay/vscode`; `@assay/engine-duckdb` as touched) per
  row; workers never touch `docs/**` (the orchestrator owns paperwork); tree clean after.
- **Gates per row:** the seven — `format:check / lint / typecheck / test / test:coverage / build /
docs:links:check`. Playwright e2e NOT required for PT-V rows (no shared web surface);
  verification is the committed harness (the reviewer re-runs it; the ptv-1 precedent).

## 4. Flake watch

Same carried list as the [q-15 queue §4](20261002-q15-queue.md) (`row-diff-agreement`,
`contracts/round-trip`, `validation/re2`, `validation/duckdb-agreement`, `ux.integration.test`) +
the e2e abort-under-load event, **plus** `@vscode/test-electron` download flakiness offline —
cache once. Re-run in isolation, note, escalate only on pattern.

## 5. Closure

_(placeholder — filled at slice close)_: per-row outcomes (commit, review rounds, counts), counts
at close, the **slice-2 candidate list** (edit/validate/diff in VS Code, Git context, dataset diff
command — per ptv1-4's out-of-slice record), and the **vscode-web re-scope spike note** (the
`@vscode/test-web` follow-up that could settle it).
