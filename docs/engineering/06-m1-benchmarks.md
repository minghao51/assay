<!-- Numbered 06 per the m1-7 orchestrator dispatch; note that
     docs/engineering/06-testing-security-quality.md already exists —
     consider renumbering this file to 07 at integration. -->

# M1 benchmark: time-to-first-row and memory on a ~1 GiB Parquet

**Task:** M1 §6 #7 ("Measure: time-to-first-row + memory on 1 GB file; record
results"). **Gate evidence for:** G1 — "multi-GB Parquet opens; column/filter
queries stream; grid stays responsive; no data leaves the browser"
([roadmap §5](../product/10-execution-roadmap.md)), with risk R1 (browser
memory ceilings — measure early) and R4 (DuckDB-WASM startup cost) in scope.

Everything here was measured through the real engine path in the
`@assay/engine-duckdb` browser harness: pick (input fallback, same
`EngineFileSource` seam as the app) → `open()` → `schema()`/`rowCount()` →
first `fetchRange` window → projected `query` → filtered `query` → 12
sequential windows. The grid-responsiveness half of G1 is **not** re-measured
here — the m1-5 e2e already proves it on a 1M-row dataset (DOM < 100 rows,
0.26 % of rows fetched, median frame 16.7 ms; see
`tests/e2e/grid-virtualization.spec.ts`).

Measured: **1.09 GiB**. Multi-GB is **extrapolation** — see
[Scaling assumptions and their limits](#scaling-assumptions-and-their-limits).

## Environment

| Component                       | Value                                                                                                             |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| OS                              | Linux x86_64                                                                                                      |
| CPU                             | AMD Eng Sample: 100-000000829-32_N, 16 cores                                                                      |
| RAM                             | 30.7 GiB total                                                                                                    |
| Browser                         | Chromium 153.0.8010.12 (Playwright-managed "Chrome for Testing", headless)                                        |
| Playwright                      | 1.63.0                                                                                                            |
| Node                            | v24.13.0                                                                                                          |
| DuckDB CLI (fixture generation) | 1.5.5 (Variegata), sha-pinned same as CI                                                                          |
| Fixture storage                 | NVMe SSD (`/tmp`, same filesystem as the repo)                                                                    |
| DuckDB-WASM                     | `@duckdb/duckdb-wasm` 1.32.0, **mvp bundle** (single-threaded, no cross-origin isolation — see ADR context below) |

## Fixture

Generated on demand by `tests/e2e/support/big-fixture.ts` into
`/tmp/assay-e2e-m1-7/big.parquet` — **never committed** (same policy as the
1M-row m1-5 fixture). Generation took **~25 s** (25.9 s measured).

| Property      | Value                                                              |
| ------------- | ------------------------------------------------------------------ |
| Rows          | 16,000,000                                                         |
| Bytes on disk | 1,172,679,128 (1.092 GiB)                                          |
| Compression   | zstd, 122,880-row groups (131 groups)                              |
| sha256        | `9e41744571fde4726b71912c75aaff86634de808326e3995f690a40a60d001ed` |

Deterministic: two generations with the same CLI produce byte-identical files
(the SQL uses only row index `i` plus DuckDB's version-pinned `hash()`/`md5()`;
hash stability is a DuckDB implementation detail, so the claim is tied to the
CI-pinned 1.5.5).

Shape — chosen as a realistic mixed workload (the six types Assay's M1
surfaces must handle), not as a compression benchmark:

| Column       | Type        | Content                     | Why                                                |
| ------------ | ----------- | --------------------------- | -------------------------------------------------- |
| `id`         | `BIGINT`    | unique, ascending           | row anchor; zone-map friendly like typical keys    |
| `cat`        | `INTEGER`   | `i % 1000`                  | categorical column                                 |
| `value`      | `DOUBLE`    | pseudo-random via `hash(i)` | defeats zone maps — honest full-scan filter target |
| `label`      | `VARCHAR`   | 13–37 chars, md5-based      | varying-width strings, high entropy                |
| `note`       | `VARCHAR`   | ~72 chars, md5-based        | the compression payload (long free text)           |
| `maybe_null` | `DOUBLE`    | NULL every 10th row         | nullable column                                    |
| `tags`       | `VARCHAR[]` | 0–2 md5-based elements      | list (nested) column                               |

## Methodology

- **Repeats:** the full sequence runs **3×**, each on a fresh page (fresh
  engine worker ⇒ cold DuckDB state). Per-metric **median** across repeats is
  reported; per-repeat values below show spread.
- **Timing:** `performance.now()` **inside the page** around each client call
  (harness hooks in `packages/engine-duckdb/harness/main.ts`) — no CDP
  round-trip noise. Excludes Playwright click/dispatch overhead.
- **Metric definitions** (wall time per call):
  - `boot` — `ensureReady()`: worker spawn + DuckDB-WASM instantiate + connect (R4).
  - `open` — `getFile()` + worker-side registration (`BROWSER_FILEREADER`
    protocol: the engine slices the `File` lazily — **no upfront byte copy**)
    - `CREATE VIEW`.
  - `schema` — `DESCRIBE` round-trip. `rowCount` — metadata `count(*)`.
  - **TTFR** — `fetchRange(handle, {startRow: 0, endRow: 1000})`: request
    postMessage → windowed SQL (`LIMIT 1000`) over the Parquet view → first
    Apache Arrow record batch → zero-copy IPC transfer → main-thread
    `tableFromIPC` reconstitution. **`pickerToFirstRow` = boot + open +
    schema + rowCount + TTFR** — the app's pick→first-visible-row sequence.
  - `projected` — `SELECT "id", "label" … LIMIT 1000` (projection pushdown).
  - `filtered` — `SELECT count(*) … WHERE "value" > 142000`: ~0.6 %
    selectivity on the pseudo-random column ⇒ zone maps cannot prune ⇒
    a near-full scan returning a 1-row batch. Chosen deliberately: a
    row-returning `LIMIT`-ed filter short-circuits early and would measure a
    partial scan.
  - `windows` — 12 sequential 1000-row `fetchRange` windows at offsets
    0 %, 10 %, …, 95 %, 99 % of `rowCount` (grid-like access pattern).
- **Memory:** CDP `Performance.getMetrics` → `JSHeapUsedSize` on the page
  session at checkpoints (pre-boot, post-boot, post-open, post-first-row,
  post-windows), paired with the V8 heap limit from in-page
  `performance.memory.jsHeapSizeLimit` (Chromium removed the `JSHeapSizeLimit`
  metric from `Performance.getMetrics` on current versions — verified on the
  153 build used here). **Worker-thread heaps are not captured**: the
  DuckDB-WASM heap lives in dedicated worker threads; CDP sessions routed to
  worker targets do not answer commands on current Chromium (probed:
  `Target.attachToTarget` succeeds but `Performance.enable`/`Runtime.evaluate`
  never reply) and Playwright exposes page-scoped sessions only. Recorded as
  an open question below.
- **Sanity bounds in the spec** (`tests/e2e/bench-ttfr.spec.ts`): generous but
  real — TTFR < 10 s, boot < 20 s, open < 10 s, schema/rowCount < 5 s,
  projected < 10 s, filtered < 60 s, window median < 15 s / max < 60 s, heap
  < 50 % of limit, plus correctness anchors (`rowCount` = 16,000,000; TTFR
  window full and starting at id 0; projected window full; filtered batch = 1
  row with a plausible match count).

## Results

Medians of 3 cold repeats (per-repeat values in `min–max`):

| Metric                              | Median                 | Spread             |
| ----------------------------------- | ---------------------- | ------------------ |
| boot (R4)                           | **659 ms**             | 643–723 ms         |
| open (registration)                 | **857 ms**             | 796–885 ms         |
| schema                              | **18.6 ms**            | 18.6–21.1 ms       |
| rowCount                            | **18.7 ms**            | 18.1–20.3 ms       |
| **time-to-first-row**               | **308 ms**             | 299–322 ms         |
| picker → first row (sum)            | **1.88 s**             | 1.85–1.88 s        |
| projected query (2 cols, 1000 rows) | **25.2 ms**            | 24.9–25.3 ms       |
| filtered query (near-full scan)     | **2.29 s**             | 2.23–2.48 s        |
| window median / p95 / max           | **228 / 274 / 274 ms** | —                  |
| window min (offset 0)               | **59 ms**              | 58.5–63.1 ms       |
| Main-thread heap post-first-row     | **3 MB**               | 3 MB (all repeats) |
| Main-thread heap post-windows       | **4 MB**               | 4 MB (all repeats) |
| JS heap limit                       | 3,586 MB               | —                  |

A second full run (first generation-from-scratch run) reproduced these within
noise (medians: TTFR 306 ms, filtered 2.27 s, windows median 225 ms,
picker→first-row 1.85 s).

Window latency by depth (median of 3 repeats, offset → ms): 0 → 62, 10 % →
255, 20 % → 218, 30 % → 218, 40 % → 234, 50 % → 216, 60 % → 226, 70 % → 253,
80 % → 224, 90 % → 227, 95 % → 236, 99 % → 236. Beyond the first window the
latency is **flat** (~210–270 ms) rather than growing with offset at this
scale — do not extrapolate that flatness far beyond 1 GiB without
re-measuring (see open questions).

## Interpretation against G1

- **"Multi-GB Parquet opens"** — the open path is lazy by construction
  (registration copies no bytes; schema/rowCount are metadata-only): 0.86 s to
  open 1.09 GiB, and those costs are size-_flat_ (see scaling section). The
  full multi-GB claim remains **extrapolation** until a ≥ 5–10 GiB re-run;
  nothing measured here blocks it.
- **"Column/filter queries stream"** — proven: projection is cheap (25 ms) and
  full scans stream through the first-batch Arrow transport at ~0.48 GiB/s
  (single-threaded WASM). A worst-case full-scan filter on 10 GiB would be
  ~21 s — interactive-hostile, but selective predicates (typical grid/filter
  use) prune via row-group statistics and avoid full scans; the projected and
  windowed paths never scan.
- **"Grid stays responsive"** — covered by m1-5's e2e (1M rows, median frame
  16.7 ms, 0.26 % fetched); the engine-side window latencies here (median
  228 ms worst-case cold across a 1.09 GiB file) are consistent with that
  result and well under a scroll-frame budget when windows are prefetched —
  the m1-5 viewport model issues windowed fetches off the render path.
- **"No data leaves the browser"** — every step runs in-browser (worker +
  WASM reading a local `File` through lazy slicing); the bench fixture is
  synthetic and nothing is logged but timings/counts (ADR 0001/0025).

### Scaling assumptions and their limits

1.09 GiB was measured; multi-GB numbers below assume:

- **Size-flat operations stay flat:** boot/open/schema/rowCount do no
  dataset-sized work. Limit: Parquet footer + row-group metadata grows with
  the number of groups (131 here; ~1,310 at ~11 GiB with identical row-group
  size) — still metadata-scale, but unmeasured beyond 1.09 GiB.
- **Scan throughput is linear in bytes:** filtered full-scan ≈ 2.29 s/GiB
  (0.48 GiB/s) ⇒ ~11 s at 5 GiB, ~23 s at 10 GiB, ~2 min at 60 GiB.
  Limits: single-threaded mvp-bundle WASM; the eh-bundle (parallelism) is a
  recorded two-URL change in the worker; and real selective filters + zone
  maps avoid the full scan entirely, so the linear number is a worst case.
- **Windowed access stays O(window):** main-thread heap was flat (3→4 MB over
  the whole session) and window latency flat across depth at this scale.
  Limits: DuckDB's buffer manager lives in the worker, whose heap and cache
  growth with file size could not be measured here (see above) — this is the
  one R1-relevant number still missing.

**Memory headroom vs R1:** the _measurable_ main-thread footprint is tiny
(4 MB of a 3,586 MB limit after 12 windows over 1.09 GiB) because windowed
fetching never materializes the dataset. The unmeasured worker-side DuckDB
heap is the residual risk. If ceilings do fail at larger scales, the recorded
pivot paths apply: OPFS spill-over design or moving to Tauri earlier
(ADR 0028), and the eh-bundle swap for parallelism (mvp bundle was chosen
because it needs no cross-origin isolation; `measureUserAgentSpecificMemory`
in the worker would become available behind COOP/COEP with the eh bundle).

## How to reproduce

```sh
# 0. one-time: Playwright Chromium + DuckDB CLI 1.5.5 (e.g. /tmp/duckdb)
pnpm exec playwright install chromium

# 1. build (the harness dist is served by the second webServer in playwright.config.ts)
pnpm build

# 2. full suite WITHOUT the big bench (bench spec skips: 12 pass, 1 skipped)
ASSAY_E2E_PORT_WEB=4273 ASSAY_E2E_PORT_ENGINE=4279 ASSAY_E2E_PORT_DS=4280 \
DUCKDB=/tmp/duckdb pnpm test:e2e

# 3. WITH the ~1 GiB bench (adds the 13th spec; ~1 min incl. one-time fixture
#    generation of ~25 s; the fixture is reused across runs, delete
#    /tmp/assay-e2e-m1-7 to force regeneration)
ASSAY_E2E_BIG_BENCH=1 ASSAY_E2E_PORT_WEB=4273 ASSAY_E2E_PORT_ENGINE=4279 \
ASSAY_E2E_PORT_DS=4280 DUCKDB=/tmp/duckdb pnpm test:e2e

# bench spec only: append -- tests/e2e/bench-ttfr.spec.ts to either command
```

Machine-readable output: each repeat prints `[m1-7 bench] …`, the medians
print as `[m1-7 bench median] …`, window detail as `[m1-7 bench windows] …`,
and the fixture facts as `[m1-7 fixture] …` — the tables above are those
lines transcribed. Env knobs: `ASSAY_E2E_BIG_ROWS` (row-count override for
smaller fallback rigs; the note's numbers assume the default 16,000,000),
`ASSAY_E2E_PORT_ENGINE` (harness port), `DUCKDB` (CLI path).

## Open questions for the next measurement round

1. **Worker-side DuckDB heap** (the real R1 number): needs either the
   eh-bundle + COOP/COEP (unlocking `measureUserAgentSpecificMemory` in the
   worker) or measurement in a native shell (Tauri, ADR 0028).
2. **≥ 5–10 GiB re-run** on this rig before G1's "multi-GB" claim is treated
   as measured rather than extrapolated — open/schema/rowCount flatness and
   window flatness are the specific things to confirm.
3. **Deep-offset windows at much larger scales** (100M+ rows): flatness here
   should not be assumed to hold once row-group metadata and buffer pressure
   grow.
4. **Per-cell projection cost** (m1-5 carry-over): the app's grid reads cells
   via Arrow `vector.get()` per cell; this bench measures the engine
   transport only. Measure the composed app path when the schema panel (m1-6)
   lands.
5. **CSV/JSONL paths** were not measured — Parquet only (zstd row groups have
   different statistics/pruning behavior than CSV).
6. **First-batch-only transport** currently cancels the query tail
   (`hasMore=true`); when true streaming lands, TTFR and window latency should
   be re-baselined.
