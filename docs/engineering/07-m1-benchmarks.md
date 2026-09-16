<!-- Renumbered to 07 at integration (06-testing-security-quality.md already
     exists). Gate G1 evidence per roadmap §5; reproduction: see the
     "Reproducing" section below. -->

# M1 benchmark: time-to-first-row and memory on big Parquet (1.09 GiB m1-7; 10.24 GiB G1-R)

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

Measured: **1.09 GiB** (m1-7 round, below) and — since 2026-09-16, task G1-R —
**10.24 GiB / 150,000,000 rows** (see the "G1-R multi-GB round" section
below). The m1-7 results and scaling-assumption framing are kept verbatim as
recorded history; what remains extrapolation after G1-R is listed at the end
of the G1-R section (and in the open questions).

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
1M-row m1-5 fixture). Generation took **~25 s** (25.9 s measured). Runs
reuse the file only after the sidecar meta verifies against it: `rows`,
`bytes`, and the stored `sha256` re-hashed from the file (~seconds for
~1 GiB) — a same-size corrupted fixture is rejected and regenerated instead
of poisoning the bench (negative-tested in
`tests/e2e/big-fixture-reuse.spec.ts`).

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

## Results (m1-7 round — 1.09 GiB)

> **Status (2026-09-16):** kept as the measured below-multi-GB baseline.
> The G1-R multi-GB round (10.24 GiB, same rig and methodology) is the next
> section; the maintainer's option-B policy (handoff §6) designated this
> round "extrapolation-below-multi-GB" for G1 purposes.

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

## G1-R multi-GB round (2026-09-16): 10.24 GiB / 150M rows

Task G1-R (handoff §6): the maintainer's option-B G1 policy requires a
measured ≥ 5–10 GiB round before the "multi-GB" claim is treated as measured
rather than extrapolated. Same machine, same harness path, same methodology
and metric definitions as the m1-7 round above; the only change is fixture
size via `ASSAY_E2E_BIG_ROWS=150000000`. Environment: **unchanged** from the
table above (Chromium 153.0.8010.12, Playwright 1.63.0, Node v24.13.0, DuckDB
CLI 1.5.5, mvp bundle single-threaded WASM, NVMe `/tmp`).

**OS page-cache state (open question #7):** warm. The fixture was generated
on the same NVMe immediately before the repeats; `free -g` at run time showed
20 GiB buff/cache of 30.7 GiB RAM with 4 GiB free, so the 10.24 GiB file
plausibly sat (near-)fully in cache — but nothing was dropped or forced and
other pages compete for the same RAM, so partial caching cannot be ruled out
either. Treat the numbers as warm-cache, like every m1-7 number above; a
cold-cache first open remains unmeasured.

### Fixture

| Property      | Value                                                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rows          | 150,000,000 (`ASSAY_E2E_BIG_ROWS=150000000`)                                                                                                         |
| Bytes on disk | 10,993,919,271 (10.239 GiB) — ~2× the 5 GiB floor                                                                                                    |
| Compression   | zstd, 122,880-row groups — **1,221 row groups** (131 at m1-7 size)                                                                                   |
| sha256        | `f5e5f0e488c564cd44e6016c6a3146442b518163494d85295b272de7d0d13006`                                                                                   |
| Generation    | 239.5 s — 25.5 s per 16M rows (m1-7: 25.9 s) ⇒ per-row cost linear                                                                                   |
| sha256 verify | ~7–11 s through the rig's fixed-1-MiB-window hasher (measured twice on the finished file; a whole-file read would allocate the entire 10 GiB in RAM) |

Same deterministic SQL shape as the m1-7 fixture (above); determinism per
ADR 0038 (DuckDB CLI 1.5.5). Correctness anchors passed in all repeats:
`rowCount` = 150,000,000; TTFR window full and starting at id 0; projected
window full; filtered aggregate a 1-row batch with a plausible selective
match count.

### Results (medians of 3 cold repeats, per-repeat spread in `min–max`)

| Metric                              | Median                 | Spread             |
| ----------------------------------- | ---------------------- | ------------------ |
| boot (R4)                           | **649 ms**             | 648–697 ms         |
| open (registration)                 | **911 ms**             | 835–916 ms         |
| schema                              | **47.2 ms**            | 44.4–47.6 ms       |
| rowCount                            | **59.2 ms**            | 59.2–59.8 ms       |
| **time-to-first-row**               | **411 ms**             | 409–445 ms         |
| picker → first row (sum)            | **2.11 s**             | 2.00–2.13 s        |
| projected query (2 cols, 1000 rows) | **114 ms**             | 113.8–115.1 ms     |
| filtered query (near-full scan)     | **21.0 s**             | 20.95–21.77 s      |
| window median / p95 / max           | **415 / 452 / 463 ms** | —                  |
| window min (offset 0)               | **297 ms**             | 291–301 ms         |
| Main-thread heap post-first-row     | **3 MB**               | 3 MB (all repeats) |
| Main-thread heap post-windows       | **3 MB**               | 3 MB (all repeats) |
| JS heap limit                       | 3,586 MB               | —                  |

All pre-existing sanity bounds held without recalibration (filtered < 60 s,
window median < 15 s / max < 60 s, heap < 50 % of limit — the spec's BOUNDS
are untouched). A second full run reproduced the medians within noise
(filtered 20.8 s, TTFR 410 ms, windows median 412 ms, picker → first-row
2.00 s).

### Window latency by depth (absolute row offsets; median of 3 repeats)

| Offset (rows) | 0       | 15M | 30M | 45M | 60M | 75M | 90M | 105M | 120M | 135M | 142.5M | 148.5M |
| ------------- | ------- | --- | --- | --- | --- | --- | --- | ---- | ---- | ---- | ------ | ------ |
| Latency (ms)  | **297** | 338 | 361 | 367 | 387 | 439 | 409 | 422  | 440  | 441  | 449    | 452    |

Same mild depth-gradient shape as the m1-7 round (62 → 236 ms over the same
fractions of 16M rows): the deepest window (offset 148,500,000 rows, 99 % of
the file) took 452 ms — 1.52× the offset-0 window, vs 3.8× at m1-7. The
cost tracks the growing **row-group metadata skip** (1,221 groups), not file
bytes, and absolute per-window latency stays in the hundreds of milliseconds
(< 0.47 s) — budget-irrelevant with prefetched windows. The m1-7 warning
("do not extrapolate that flatness far beyond 1 GiB without re-measuring") is
answered at 10.24 GiB: flat in practice, with a deeper absolute floor
(offset-0 297 ms vs 62 ms) consistent with more per-query row-group metadata
work — the same pattern visible in TTFR (308 → 411 ms) and projected
(25 → 114 ms).

### Scaling analysis: the three recorded assumptions at 10.24 GiB

- **(a) Size-flat metadata ops — confirmed.** boot 659 → 649 ms (unchanged),
  open 857 → 911 ms, schema 18.6 → 47.2 ms, rowCount 18.7 → 59.2 ms while row
  groups grew 131 → 1,221 (9.3×). Every metadata op stayed in the
  tens-to-hundreds of ms; growth is sublinear in group count and negligible
  inside the picker → first-row sum, which moved only 1.88 → 2.11 s (+12 %)
  for 9.4× the bytes. Opening 10.24 GiB takes 0.91 s.
- **(b) Scan-throughput linearity — confirmed.** Filtered near-full scan
  2.29 s @ 1.09 GiB → 21.0 s @ 10.24 GiB: 9.18× time for 9.38× bytes ⇒
  0.477 → 0.487 GiB/s (+2 %). The recorded linear worst-case model
  ("~23 s at 10 GiB") predicted 21–23 s; measured 21.0 s. Interactive-hostile
  for unselective scans, as recorded; selective predicates prune via row-group
  statistics and never full-scan.
- **(c) Windowed access O(window) + main-thread heap flatness — confirmed.**
  12 windows across 10.24 GiB: median 415 ms / p95 452 / max 463, depth
  gradient bounded (297 → 452 ms). Main-thread heap flat at **3 MB**
  post-first-row and post-windows (3,586 MB limit) — no measurable
  main-thread growth at 9.4× the dataset. The number still missing remains
  the **worker-side** DuckDB heap (open question #1, deferred by maintainer
  decision to a dedicated eh-bundle round so this round's measured
  configuration stays identical to the shipped mvp bundle).

### What remains extrapolation after G1-R

- **Beyond ~10.24 GiB:** all measured curves (metadata ops, scan throughput,
  window cost vs group count) look linear-to-sublinear, but nothing above
  10.24 GiB / 1,221 row groups is measured; the ~60 GiB point (~2 min
  worst-case full scan at 0.487 GiB/s, ~7,100 row groups) is still an
  extrapolation.
- **Worker-side memory (open question #1):** DuckDB's buffer manager lives in
  the worker thread; its heap/cache growth with file size is unmeasured
  (deferred to the eh-bundle round). R1's residual risk sits exactly there.
- **eh-bundle configuration (parallel scan):** unmeasured — this round is
  single-threaded mvp bundle by design (maintainer decision, OQ #1).
- **CSV/JSONL** paths (open question #5) and **true streaming transport**
  beyond the first batch (open question #6): unmeasured; TTFR/window numbers
  are first-batch-transport numbers.
- **Cold-cache first open:** every number in this note (m1-7 and G1-R) is
  warm-cache; a fresh-boot / evicted-cache open is unmeasured.

### Pass/pivot framing (measurement record only — not a gate decision)

Nothing in this round stresses the recorded pivot paths: the measurable
main-thread footprint stayed flat at 3 MB across a 10.24 GiB session, window
access stayed O(window) with deep-offset cost in the hundreds of ms, and
worst-case full-scan throughput held linear (~0.49 GiB/s). The stress points
that would activate the pivots — main-thread memory ceiling, non-linear
window/metadata growth, sub-linear scan collapse — showed no signal at
10.24 GiB. If larger scales, the unmeasured worker-side heap, or parallelism
needs produce such a signal later, the recorded paths apply unchanged: OPFS
spill-over or an earlier Tauri shell ([ADR 0028](../adr/0028-tauri-as-future-desktop-shell.md)),
and the eh-bundle two-URL swap for parallelism. Whether G1 passes is the
maintainer's call (manual-actions M5); this section records measurements and
framing only.

## Interpretation against G1

- **"Multi-GB Parquet opens"** — the open path is lazy by construction
  (registration copies no bytes; schema/rowCount are metadata-only): 0.86 s to
  open 1.09 GiB, and those costs are size-_flat_ (see scaling section). The
  full multi-GB claim remains **extrapolation** until a ≥ 5–10 GiB re-run;
  nothing measured here blocks it. _(2026-09-16: closed by the G1-R 10.24 GiB
  round below — metadata ops, windows, and scan linearity re-measured at
  multi-GB.)_
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

1.09 GiB was measured; multi-GB numbers below assume: _(2026-09-16: all three
assumptions were re-measured at 10.24 GiB in the G1-R round below; each bullet
records the outcome — all three held.)_

- **Size-flat operations stay flat:** boot/open/schema/rowCount do no
  dataset-sized work. Limit: Parquet footer + row-group metadata grows with
  the number of groups (131 here; ~1,310 at ~11 GiB with identical row-group
  size) — still metadata-scale, but unmeasured beyond 1.09 GiB. _(2026-09-16
  G1-R: confirmed at 1,221 groups — boot 649 ms, open 911 ms, schema 47 ms,
  rowCount 59 ms.)_
- **Scan throughput is linear in bytes:** filtered full-scan ≈ 2.29 s/GiB
  (0.48 GiB/s) ⇒ ~11 s at 5 GiB, ~23 s at 10 GiB, ~2 min at 60 GiB.
  Limits: single-threaded mvp-bundle WASM; the eh-bundle (parallelism) is a
  recorded two-URL change in the worker; and real selective filters + zone
  maps avoid the full scan entirely, so the linear number is a worst case.
  _(2026-09-16 G1-R: confirmed — 21.0 s at 10.24 GiB ⇒ 0.487 GiB/s vs
  0.477 GiB/s at 1.09 GiB, +2 %.)_
- **Windowed access stays O(window):** main-thread heap was flat (3→4 MB over
  the whole session) and window latency flat across depth at this scale.
  Limits: DuckDB's buffer manager lives in the worker, whose heap and cache
  growth with file size could not be measured here (see above) — this is the
  one R1-relevant number still missing. _(2026-09-16 G1-R: main-thread heap
  still flat at 3 MB across a 10.24 GiB session; window latency flat in
  practice across 148.5M-row offsets; the worker-side number remains missing
  — OQ #1, deferred.)_

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

# 2. full suite WITHOUT the big bench (bench spec skips: 16 pass, 1 skipped)
ASSAY_E2E_PORT_WEB=4273 ASSAY_E2E_PORT_ENGINE=4279 ASSAY_E2E_PORT_DS=4280 \
DUCKDB=/tmp/duckdb pnpm test:e2e

# 3. WITH the m1-7 ~1 GiB bench (default ASSAY_E2E_BIG_ROWS=16,000,000; adds
#    the 17th spec; ~1 min incl. one-time fixture generation of ~25 s; the
#    fixture is reused across runs — reuse re-verifies the stored sha256,
#    a few seconds — delete /tmp/assay-e2e-m1-7 to force regeneration)
ASSAY_E2E_BIG_BENCH=1 ASSAY_E2E_PORT_WEB=4273 ASSAY_E2E_PORT_ENGINE=4279 \
ASSAY_E2E_PORT_DS=4280 DUCKDB=/tmp/duckdb pnpm test:e2e

# 3b. G1-R multi-GB round (2026-09-16): 150M rows ≈ 10.24 GiB — one-time
#     fixture generation ~4 min + sha256 verification ~7–11 s + ~1.5–2 min
#     bench (3 cold repeats on the reference rig). The exact combo used for
#     the G1-R numbers (bench spec only; with pnpm the positional filter goes
#     WITHOUT `--`):
ASSAY_E2E_BIG_BENCH=1 ASSAY_E2E_BIG_ROWS=150000000 DUCKDB=/tmp/duckdb \
  pnpm test:e2e tests/e2e/bench-ttfr.spec.ts

# bench spec only: append tests/e2e/bench-ttfr.spec.ts to either command
```

Machine-readable output: each repeat prints `[m1-7 bench] …`, the medians
print as `[m1-7 bench median] …`, window detail as `[m1-7 bench windows] …`,
and the fixture facts as `[m1-7 fixture] …` — the tables above are those
lines transcribed. Env knobs: `ASSAY_E2E_BIG_ROWS` (row-count override for
smaller fallback rigs; the m1-7 numbers assume the default 16,000,000 and the
G1-R round used 150,000,000), `ASSAY_E2E_PORT_ENGINE` (harness port),
`DUCKDB` (CLI path).

## Open questions for the next measurement round

1. **Worker-side DuckDB heap** (the real R1 number): needs either the
   eh-bundle + COOP/COEP (unlocking `measureUserAgentSpecificMemory` in the
   worker) or measurement in a native shell (Tauri, ADR 0028). _(2026-09-16: deferred to a dedicated eh-bundle measurement round — not part of G1 evidence, so the measured configuration stays identical to the shipped mvp bundle.)_
2. **≥ 5–10 GiB re-run** on this rig before G1's "multi-GB" claim is treated
   as measured rather than extrapolated — open/schema/rowCount flatness and
   window flatness are the specific things to confirm. _(2026-09-16 maintainer decision: G1 passage requires this re-run — queued as task G1-R in handoff §6; deep-offset windows (OQ #3) are exercised by it at ≥160M rows.)_
   **Addressed by G1-R (2026-09-16):** the 10.24 GiB / 150M-row round above —
   metadata-op flatness, scan linearity, and window flatness all confirmed at
   1,221 row groups; see the G1-R section's scaling analysis.
3. **Deep-offset windows at much larger scales** (100M+ rows): flatness here
   should not be assumed to hold once row-group metadata and buffer pressure
   grow. **Addressed by G1-R (2026-09-16):** measured at absolute offsets
   0 → 148,500,000 rows on 150M rows — a mild depth gradient that tracked
   row-group metadata (1,221 groups), not file size; see the G1-R section.
4. **Per-cell projection cost** (m1-5 carry-over): the app's grid reads cells
   via Arrow `vector.get()` per cell; this bench measures the engine
   transport only. The m1-6 schema panel has landed, so the composed app
   path is now measurable end-to-end — still an open measurement (nothing
   recorded yet).
5. **CSV/JSONL paths** were not measured — Parquet only (zstd row groups have
   different statistics/pruning behavior than CSV).
6. **First-batch-only transport** currently cancels the query tail
   (`hasMore=true`); when true streaming lands, TTFR and window latency should
   be re-baselined.
7. **Warm OS page cache** (m1-7 carry-over): every number above ran with the
   fixture fresh in the OS page cache — it was generated immediately before
   the repeats on the same machine/SSD — so boot/open and window latencies
   are warm-cache numbers; a cold-cache first open (fresh reboot, or the file
   evicted) may be slower. The next round should record the cache state
   alongside the results. _(2026-09-16: the G1-R round recorded it — warm,
   fixture generated immediately before the repeats, buff/cache state noted
   in its page-cache paragraph; cold-cache first open remains unmeasured.)_
