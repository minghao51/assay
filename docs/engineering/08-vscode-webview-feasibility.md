# R4 webview feasibility — VS Code hosting targets (ptv-1 spike)

**Status:** spike evidence record (queue row **ptv-1**, ruling **D15**). This report answers the
R4 questions empirically for the two PT-V hosting targets and lands a **GO / NO-GO / RE-SCOPE**
recommendation per target. It does **not** commit PT-V (D15 decouples the track commitment from
the spike); the track-start ruling reads this evidence.

- **Row:** [ptv-m9 queue ptv-1](../process/handoff/20261002-ptv-m9-queue.md)
- **Ruling:** [D15](../process/handoff/20260926-maintainer-rulings.md)
- **Gating ADRs:** [0008 (shared core)](../adr/0008-shared-core-web-vscode-cli.md),
  [0022 (headless grid / replaceable renderer)](../adr/0022-headless-grid-and-renderer-strategy.md)
- **Baseline:** `main` = `7654810`; the spike was built and run on branch `ptv-1`.
- **Harness (committed):** [`apps/vscode/`](../../apps/vscode/) — `pnpm --filter @assay/vscode run:spike`.

**Evidence tags used below** (never mixed):

| Tag                 | Meaning                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **MEASURED**        | The value was produced by running the committed harness in the real host on this machine; the raw JSON is the citation.         |
| **REPRO'D**         | The committed harness reproduces the claim deterministically; the reviewer re-runs `run:spike`.                                 |
| **VENDOR-DOC-ONLY** | Not verifiable in this environment; the blocker is stated and a concrete reproduction path is given. Never dressed as measured. |

The machine-readable run output is `apps/vscode/dist/spike-results.json` (git-ignored; regenerated
by `run:spike`). The raw file is the authority. Ranges below span **observed runs on this machine**
(worker runs plus an independent reviewer re-run), not one harness execution, and are honest
envelopes rather than tight bounds. Boot/TTFR move with machine load. `pickerToFirstRowMs` also
includes a cold network fetch of the Parquet extension from `extensions.duckdb.org` (see §6b), so it
is the most load/network-sensitive number here.

---

## 0. Environment

| Component           | Value                                                                             |
| ------------------- | --------------------------------------------------------------------------------- |
| OS / CPU            | Linux x86_64, 16 cores                                                            |
| RAM                 | 30 GiB                                                                            |
| VS Code             | **1.130.0** (system install `/usr/share/code/code`)                               |
| Electron / Chromium | Electron 42.6.0 / Chrome 148.0.7778.280                                           |
| DuckDB-WASM         | `@duckdb/duckdb-wasm` 1.32.0, engine reports DuckDB **v1.4.3**                    |
| Fixture             | on-demand 1M-row Parquet (`/tmp/assay-e2e-m1-5/million.parquet`, 2,636,355 bytes) |
| DuckDB CLI          | v1.5.5 (`DUCKDB=/tmp/duckdb`)                                                     |

Webview origin per load: `vscode-webview://<per-load-uuid>` (protocol `vscode-webview:`), i.e. a
**distinct origin** from the extension's resource host
(`https://file+.vscode-resource.vscode-cdn.net/...`). This single fact drives most of Q1/Q3.

---

## 1. Evidence matrix

| Q   | Question                                                             | Desktop-extension webview                           | vscode-web                                           |
| --- | -------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------- |
| Q1  | DuckDB-WASM boots in a Web Worker in the webview? which build? COI?  | **YES — MEASURED** (`mvp` and `eh`, no COI)         | **VENDOR-DOC-ONLY** (expected yes, `mvp`; not run)   |
| Q2  | vscode-web COOP/COEP allowance                                       | n/a                                                 | **PARTIAL — MEASURED host headers + UNKNOWN iframe** |
| Q3  | OPFS reachable from the webview origin?                              | **YES — MEASURED** (write/read/delete round-trip)   | **VENDOR-DOC-ONLY** (likely session-scoped)          |
| Q4  | File System Access API available?                                    | **PRESENT — MEASURED; usability UNKNOWN**           | **VENDOR-DOC-ONLY**                                  |
| Q5  | 1M-row fixture memory ceiling + TTFR                                 | **MEASURED** (TTFR 40.7–47.6 ms; live heap 1.14 MB) | **NOT RUN**                                          |
| Q6  | esbuild packaging incl. WASM; artifact sizes; vscode-web loadability | **MEASURED sizes**; desktop loadable — REPRO'D      | **NOT RUN** (needs a browser entry point)            |

---

## 2. Q1 — DuckDB-WASM in a Web Worker inside the desktop webview

**Verdict: YES for both `mvp` and `eh`, with a required bootstrap workaround. MEASURED.**

### Q1a — direct worker construction fails (MEASURED)

`new Worker(webview.asWebviewUri('…/worker.js'), { type: 'module' })` throws synchronously:

```text
Failed to construct 'Worker': Script at
'https://file+.vscode-resource.vscode-cdn.net/…/dist/webview/worker.js' cannot be accessed
from origin 'vscode-webview://<uuid>'.
```

The webview resource host is cross-origin to the `vscode-webview://` document, and Chromium
requires a worker script to be same-origin (or CORS-enabled) — the resource server does not
authorize a cross-origin worker fetch. This is a **real blocker** for the naive PT-V bootstrap and
is the reason the spike carries a blob-URL bootstrap.

### Q1b — blob-URL workaround (MEASURED, REPRO'D)

Fetch each worker script (and WASM) as a Blob and construct the worker from a same-origin `blob:`
URL. This is the same technique DuckDB-WASM itself uses internally (`createWorker` in
`duckdb-browser.mjs`: `URL.createObjectURL(await (await fetch(url)).blob())`). It works for the
spike's own ESM worker and for DuckDB's nested classic glue worker.

### Q1c — DuckDB-WASM boot (MEASURED)

| Bundle | Result | Boot time (range) | Engine version | COI required?                        |
| ------ | ------ | ----------------- | -------------- | ------------------------------------ |
| `mvp`  | OK     | 564–721 ms        | v1.4.3         | **no** (`crossOriginIsolated=false`) |
| `eh`   | OK     | 470–537 ms        | v1.4.3         | **no** (`crossOriginIsolated=false`) |

`crossOriginIsolated` was `false` and `SharedArrayBuffer` was `undefined` in the webview
(MEASURED). The `eh` (exception-handling) bundle is **not** the cross-origin-isolation bundle —
only the separate `coi`/threads bundle requires COI, and it was not probed. So the `mvp` bundle
(the one the real engine already uses in `packages/engine-duckdb/src/worker.ts`) is the correct
choice for the webview, and `eh` is a viable later swap for exception handling, not for threads.

### Q1d — the CSP the bootstrap requires (MEASURED)

The spike's extension sets a strict webview CSP. Two directives are load-bearing:

```text
default-src 'none';
script-src 'nonce-<nonce>' 'wasm-unsafe-eval' blob:;
style-src 'unsafe-inline';
worker-src <cspSource> blob:;
connect-src <cspSource> blob: https://extensions.duckdb.org;
img-src <cspSource> data:
```

Two failures were reproduced and then fixed:

1. **Missing `blob:` in `connect-src`** → DuckDB's nested worker fetch of the blob-WASM URL is
   blocked (`Failed to fetch`), and `AsyncDuckDB` hangs forever (its error path clears the pending
   request without rejecting). `blob:` in `connect-src` is required.
2. **Missing `https://extensions.duckdb.org` in `connect-src`** → opening Parquet fails because
   `read_parquet` autoloads the Parquet extension over the network (see Q5).

`'wasm-unsafe-eval'` is required for WebAssembly compilation under the strict `script-src`.

---

## 3. Q2 — vscode-web (COOP/COEP allowance)

**Verdict: PARTIAL. The webview iframe was not exercised; a RE-SCOPE is recommended on the
OPFS/file-bridge grounds regardless. Not dressed as measured.**

What was **MEASURED** (host headers, this machine, 2026-10-08):

```text
$ curl -sI https://vscode.dev/
cross-origin-opener-policy: same-origin
cross-origin-embedder-policy: require-corp
content-security-policy: frame-ancestors 'none'

$ curl -sI https://vscode-cdn.net/     # bare static host: no COOP/COEP returned
```

So the vscode.dev **top-level workbench page is cross-origin isolated**, while the bare static CDN
host returns no COOP/COEP. vscode-web webviews are sandboxed **iframes** served from a
`*.vscode-cdn.net` origin; whether a given webview iframe response carries `COEP: require-corp`
(and therefore whether `crossOriginIsolated` is `true` inside it) is **not knowable from a bare
`curl`** and was **not measured**.

Why this does not block a recommendation: the desktop measurement proves the **`mvp` bundle needs
no COI**, so the safe default holds under either iframe answer. A future vscode-web round should
still measure the iframe directly (see §8).

**Blocker:** vscode-web needs a **web extension** (`browser` entry point, ESM) and a browser test
host; the spike ships a Node/CJS desktop extension only, and `@vscode/test-web` was not wired
(queue row marks it optional). The report does not claim vscode-web behavior beyond the header
measurement above.

---

## 4. Q3 — OPFS reachability

**Desktop webview: YES — MEASURED.** From the DuckDB worker (same origin as the page), the probe
created a directory and file, wrote 4 bytes, read them back, verified the round-trip, and deleted
the entry:

```json
{
  "available": true,
  "wroteBytes": 4,
  "roundTrip": true,
  "estimate": {
    "quota": 649502358405,
    "usage": 40676229,
    "usageDetails": { "caches": 40655872, "fileSystem": 168, "serviceWorkerRegistrations": 20189 }
  }
}
```

This is the precondition the m4-2 export path depends on; the desktop webview satisfies it. Note
the `usageDetails.fileSystem` is tiny (168 bytes) because OPFS quota is per-origin and the webview
origin is **per-load** — persistent exports need a deliberate story (the engine's `assay-exports/`
scratch is disposable by ADR 0017, so this is acceptable, but it must be stated in PT-V design).

**vscode-web: VENDOR-DOC-ONLY.** In vscode-web the webview origin is session-scoped, so OPFS is
not a durable store across sessions. The m4-2 export path (disposable scratch) may still function
within a session, but this is unverified. Reproduction is the §8 `@vscode/test-web` route.

---

## 5. Q4 — File System Access API in a webview

**Verdict: the API is PRESENT in the webview realm — MEASURED — but "present" is not "usable", and
the extension-host bridge remains the supported path.**

```json
{
  "showOpenFilePicker": true,
  "showSaveFilePicker": true,
  "showDirectoryPicker": true,
  "fileSystemHandle": true
}
```

This is a correction to the row's expectation ("expected: no"). Modern Electron/Chromium exposes
the File System Access API to secure contexts, and `vscode-webview://` is a secure context. What
was **not** measured (honest unknown): whether a picker call actually succeeds from a sandboxed
webview iframe, since it requires transient user activation and the webview's permissions policy
may deny it. A picker that opens a **host** file dialog from the renderer would also bypass VS
Code's own file-trust model.

**Recommendation:** do not build PT-V on the FSA API. Use the extension-host bridge — the shape
the row names — because it is the VS Code-native, permission-mediated path:

```text
vscode.window.showOpenDialog({ canSelectMany, filters })
  → vscode.workspace.fs.readFile(uri)          // extension host, Node/browser-neutral
  → postMessage bytes into the webview
  → engine.registerFileBuffer / registerFileHandle
```

This maps onto the existing `@assay/data-sources` capability model as a **workspace adapter**
(ADR 0008): the extension host is the capability provider, the webview is the renderer. The spike
already proves the byte-transfer leg of this bridge (the 2.6 MB fixture was read via
`vscode.workspace.fs.readFile` and posted into the webview, then transferred to the worker).

---

## 6. Q5 — 1M-row fixture memory ceiling + TTFR

**MEASURED.** Fixture: 1,000,000 rows, 2,636,355 bytes (zstd Parquet), generated on demand and
never committed.

| Metric                                     | This spike (1M rows, desktop webview) | G1-R web reference (150M rows) |
| ------------------------------------------ | ------------------------------------- | ------------------------------ |
| First-window TTFR (`ttfrMs`)               | **40.7–47.6 ms**                      | 411 ms                         |
| picker → first row (`pickerToFirstRowMs`)  | **794–1,015 ms**                      | ~2.11 s                        |
| open (register + view; incl. 1st ext load) | 781–867 ms                            | —                              |
| rowCount                                   | 14.7–19 ms                            | —                              |
| Live main-thread heap after first row      | **1.14 MB** (with forced GC)          | 3 MB                           |
| JS heap limit                              | 4,294,967,296 bytes (4 GiB)           | —                              |

**These are not like-for-like:** G1-R measured 150M rows through the real engine with the WASM
loaded **directly by URL** in a page; this spike measures 1M rows through a webview that must
blob-wrap its WASM. `pickerToFirstRowMs` includes the first `read_parquet` open, which autoloads the
Parquet extension from `extensions.duckdb.org` — it is network- and load-sensitive, so treat it as
an envelope, not a bound (see §6b). TTFR is dataset-dependent and load-sensitive, so 40.7–47.6 ms
vs 411 ms says little; the comparable signal is the **heap** — the live main-thread heap
(~1.14 MB) is in the same class as G1-R's 3 MB, i.e. opening the dataset does **not** inflate the
renderer's JS heap. The DuckDB engine heap lives in the worker and is **not measured** (the same
limitation recorded as G1-R open question OQ #1).

Methodology note (the **~42 MB** figure is a one-off worker observation, **not reproducible from the
committed harness**): without an explicit GC the post-first-row sample read ~42 MB, almost exactly
the 39.4 MB `mvp` WASM blob. The committed harness always launches VS Code with
`--js-flags=--expose-gc` and calls `window.gc()` before sampling, which drops the reading to
1.14 MB — evidence that the workaround's blob is reclaimable and that the 42 MB figure was
unreclaimed allocation, not live state. The harness records `preBoot`, `postBoot` and `postFirstRow`
so the reviewer can see the delta; it cannot emit the no-GC number without a harness change.

**Re-measured 2026-10-11 (the ptv1-5 slice-1 exit harness):** after slice 1 (vendored assets, the
real adapter, the headless-grid surface), the same envelopes re-measure as — boot **592.5–649.4 ms**
(`mvp`) / **492.8–542.4 ms** (`eh`); picker → first row **165.7–192.4 ms** (the CDN autoload is gone —
the extension is served locally — and the harness now emits the decomposition
`openMs + rowCountMs + ttfrMs`); grid first row **209–253.5 ms** against the slice-1 1 s budget; live
main-thread heap pinned as the same-run forced-GC **delta**, measured 0 against the 2.28 MB budget
(the R4 1.14 MB × 2). The spike figures above remain the historical R4 record.

### Q5b — the Parquet extension is a runtime network dependency (MEASURED — important)

Opening Parquet requires `read_parquet`, which in DuckDB-WASM 1.32.0 **autoloads the Parquet
extension from `https://extensions.duckdb.org/v1.4.3/wasm_mvp/parquet.duckdb_extension.wasm`**:

```json
"parquetExtension": { "name": "parquet", "loaded": true, "installed": false }
```

`loaded: true, installed: false` = fetched and loaded on demand, not vendored. The first open
(847 ms) includes that download. This is a **local-first concern** for PT-V (and is pre-existing in
the web app): the extension must either (a) keep the CSP allowance for `extensions.duckdb.org`, or
(b) **vendor the extension WASM** into the extension package and load it locally. The spike took
(a) to measure the rest of the path; (b) is a PT-V slice-1 requirement.

---

## 7. Q6 — packaging (esbuild) and artifact sizes

**MEASURED sizes** from `apps/vscode/dist/spike-artifacts.json` (esbuild, single-pass, no
minification):

| Artifact                               | Bytes      |
| -------------------------------------- | ---------- |
| `extension.cjs` (extension host)       | 5,447      |
| `spike-test.cjs` (test host entry)     | 2,315      |
| `webview/main.js`                      | 7,634      |
| `webview/worker.js` (engine worker)    | 434,649    |
| `webview/duckdb-browser-mvp.worker.js` | 844,644    |
| `webview/duckdb-mvp.wasm`              | 39,362,651 |
| `webview/duckdb-browser-eh.worker.js`  | 772,759    |
| `webview/duckdb-eh.wasm`               | 34,242,586 |
| `webview/probe.json`                   | 15         |

**Observations:**

- The extension-host bundle is trivial (~5 KB); the **WASM dominates** (~39 MB for `mvp`, ~34 MB
  for `eh`). A slice-1 package should ship **one** bundle (`mvp`) plus the vendored Parquet
  extension, not both — roughly **~40 MB** before compression.
- The engine worker bundle is only ~435 KB because DuckDB-WASM's glue is loaded as a separate
  worker script, not inlined.
- esbuild bundles the webview ESM worker and the extension CJS entry with no custom loaders; the
  DuckDB assets are copied and their `vscode-webview-resource:` URIs are injected from the
  extension host. The reviewer reproduces the sizes with `run:spike` (build step).
- **vscode-web loadability: NOT RUN.** A vscode-web extension needs a `browser` entry point (ESM)
  in `package.json` and browser-safe imports; the spike's `main` is Node/CJS and uses
  `vscode.workspace.fs` (available in web extensions) but was not repackaged for the browser. The
  webview side (ESM + WASM assets) is already browser-shaped, so the delta is the extension-host
  entry, not the webview.

---

## 8. Recommendations per hosting target

### Desktop-extension webview — **GO (with two mandatory RE-SCOPE items)**

The desktop webview is **feasible today**: DuckDB-WASM `mvp` boots in a worker, OPFS works, the
1M-row fixture opens with a sub-1 s picker→first-row and a ~1 MB live renderer heap, and the
extension-host file bridge is proven end-to-end. The bootstrap must carry two non-obvious pieces,
both now committed and reproducible: the **blob-URL worker/WASM bootstrap** and a **CSP with
`'wasm-unsafe-eval'`, `blob:` in `script-src`/`worker-src`/`connect-src`**.

Mandatory before calling PT-V slice 1 done:

1. **Vendor the Parquet (and any other required) DuckDB extension** into the package so opening a
   dataset does not require a network fetch to `extensions.duckdb.org` (local-first). If vendoring
   is infeasible, the CDN allowance must be an explicit, disclosed dependency.
2. **Ship the blob-URL bootstrap + CSP as the engine's webview adapter**, not as spike code, so
   the real `@assay/engine-duckdb` worker (which currently relies on Vite `?url` imports) can boot
   in the webview.

### vscode-web — **RE-SCOPE (not a NO-GO)**

Do not commit to vscode-web parity now. The blockers are not DuckDB (the `mvp` bundle needs no
COI) but the **host integration surface**: the extension needs a browser entry point, the webview
origin is session-scoped (OPFS durability is unresolved), and the vscode-web webview iframe's
COOP/COEP posture is unmeasured. A focused follow-up (one spike task with `@vscode/test-web`) can
settle it cheaply; the webview-side code is already browser-shaped, so the work is the host entry
and the OPFS policy, not the engine.

---

## 9. Honest unknowns (and how to close each)

| #   | Unknown                                                                 | Why it matters                                   | How to close                                                              |
| --- | ----------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------- |
| 1   | vscode-web webview iframe `crossOriginIsolated` / COOP+COEP             | decides `mvp` vs `eh`/`coi` and OPFS viability   | `@vscode/test-web` run of the same harness (see §10)                      |
| 2   | Whether FSA pickers actually succeed in a webview iframe                | whether the FSA path is ever an option           | call `showOpenFilePicker()` from a real user gesture in the webview       |
| 3   | DuckDB worker-side heap                                                 | true memory ceiling at scale                     | CDP worker-target metrics (blocked on Chromium ~150; see G1-R OQ #1)      |
| 4   | Vendored-extension loading mechanics (`INSTALL`/`LOAD` from virtual FS) | local-first requirement for Parquet              | a slice-1 task; DuckDB-WASM extension config / `registerFileBuffer`       |
| 5   | `coi` (threads) bundle under COI                                        | only if parallel scans are later needed          | requires a COI host; not available in the desktop webview                 |
| 6   | Webview resource-server CORS for the WASM URL                           | why the blob workaround is mandatory             | measured as _blocked_; re-verify per VS Code version                      |
| 7   | VS Code version sensitivity                                             | resource/CSP behavior can change across versions | re-run `run:spike` on the target VS Code; the harness records the version |

---

## 10. What a PT-V slice 1 needs (from this evidence)

1. **Extension host:** activation + a custom editor/command for supported formats; the
   `showOpenDialog` + `workspace.fs.readFile` → webview bytes bridge (workspace adapter).
2. **Webview bootstrap:** blob-URL worker/WASM loader + the measured CSP; a webview-specific
   engine-worker entry that does not depend on a bundler's `?url` asset convention.
3. **Engine:** reuse the real `@assay/engine-duckdb` client and worker logic; add a
   bundler-agnostic asset-injection seam so the worker can be built by esbuild (as the spike
   proves) as well as Vite.
4. **Assets:** vendor `duckdb-mvp.wasm` + `duckdb-browser-mvp.worker.js` + the Parquet extension;
   one bundle only; document the package size (~40 MB).
5. **Rendering:** reuse the headless grid + webview rendering (ADR 0022) — the spike did not
   exercise grid rendering, only the engine/memory path.
6. **Tests:** a committed `run:spike`-style evidence harness plus parity e2e for the docs-07 VS
   Code scenarios.

---

## 11. Reproduction

The reviewer reproduces every MEASURED/REPRO'D claim from the committed harness:

```bash
# In the ptv-1 worktree (or after cherry-pick to main):
corepack pnpm install
corepack pnpm --filter @assay/vscode typecheck

# One command: generates the 1M-row fixture (DUCKDB CLI required), esbuild-bundles the
# extension/webview/worker + DuckDB WASM assets, launches the real VS Code desktop
# extension host (adds xvfb-run when headless), and writes dist/spike-results.json.
DUCKDB=/tmp/duckdb corepack pnpm --filter @assay/vscode run:spike
```

Outputs:

- `apps/vscode/dist/spike-results.json` — the raw evidence (environment, headers, boot times,
  fixture metrics, heap checkpoints, OPFS round-trip, packaging sizes, diagnostics).
- `apps/vscode/dist/spike-artifacts.json` — Q6 byte sizes.
- stdout — the value-free summary the report quotes.

To reproduce only the build/sizes (no VS Code):

```bash
corepack pnpm --filter @assay/vscode run:build:spike
```

To settle the vscode-web unknowns (§9 #1–2), a follow-up task adds a `browser` entry point and
runs the same harness under `@vscode/test-web` against a local vscode-web; the webview code needs
no change. This is deliberately **not** part of ptv-1 (queue row marks it optional) and is left as
the first task of a vscode-web follow-up if the maintainer wants that target.

---

## 12. Boundary / scope notes

- This spike adds **no production extension features**. `apps/vscode` remains a spike-labeled
  scaffold (one command, no UX, no PT-V slice work).
- No `web`/`cli`/`engine`/`grid`/`domain` package changes; no root config changes; no `fixtures/**`
  changes (the 1M-row fixture is generated locally and never committed). `pnpm-lock.yaml` changed as
  the mechanical consequence of the declared spike devDependencies (`@vscode/test-electron`,
  `esbuild`, `@duckdb/duckdb-wasm`, `@types/vscode`, `@types/node`, `typescript`); those additions
  and their reasons are listed in the changeset for `@assay/vscode`.
- No telemetry, no dataset contents in committed files beyond non-sensitive shape metadata
  (row count, byte size, one fixture row's `id/bucket/label` shape check).
- Spike devDependencies and the reason for each are recorded in the changeset for
  `@assay/vscode`.
