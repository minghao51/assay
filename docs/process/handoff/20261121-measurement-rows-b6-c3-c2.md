# B6 / C3 / C2 — measurement record: diff scale, second bundle baseline, test-proof cost

**Date:** 2026-11-21. **Status:** MEASUREMENT RECORD — no behaviour change, no budget set, no
threshold set, no dependency added/removed/upgraded. **Rows:** B6, C3, C2 of the
[successor queue](20261121-successor-queue.md) §1. **Measurement commit:**
`129e3ef3acc3d91ed568644daf39168f47ea2d1b` (clean `/tmp` worktree). Nothing in the product or its
tests was edited; the only committed change is this file.

This record supplies numbers and their limits. It deliberately contains no budget, no threshold and
no decision — each row states what is still missing before one can be set.

## 0. Environment

| Component                       | Value                                                                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Host                            | `howt-N7`, Linux Mint 22.2 (Ubuntu 24.04 base), kernel 6.14.0-29-generic, x86_64                                                  |
| CPU                             | 16 logical cores (AMD, `nproc` = 16), shared with other agent sessions                                                            |
| RAM                             | 30.7 GiB total                                                                                                                    |
| Storage                         | NVMe SSD, `/dev/nvme0n1p2` (repo and `/tmp` on the same filesystem)                                                               |
| Node                            | v24.13.0 (nvm, `/home/howt/.nvm/versions/node/v24.13.0/bin/node`)                                                                 |
| pnpm                            | 11.26.0 (corepack `packageManager` pin)                                                                                           |
| DuckDB CLI (fixture generation) | v1.5.5 (Variegata) `d8cdaa33fd`, `/tmp/duckdb` — the pinned CLI                                                                   |
| DuckDB runtime under test (CLI) | `@duckdb/node-api` 1.5.5-r.5 (native bindings, `apps/cli` dependency)                                                             |
| Build tools                     | turbo 2.11.3, vite 8.3.0, esbuild 0.28.2, typescript 6.0.3                                                                        |
| Measurement commit              | `129e3ef3acc3d91ed568644daf39168f47ea2d1b` (detached worktree `/tmp/assay-measure-wt`)                                            |
| Bundle baseline commit          | `06d8e200c918ce488c4c359158358e630941cae3e` (as recorded in [doc 10](../../engineering/10-dependency-and-bundle-measurements.md)) |
| Host load during timing runs    | 1-minute load average **38.6 – 59.2** on 16 cores (other agents building/testing concurrently)                                    |

Two facts about the working tree matter for reproducibility and are stated up front:

- `HEAD` moved from `42c04ff` to `129e3ef` while this pass was running (a peer commit), and the
  checkout carries a peer agent's **in-flight, uncommitted** work (`apps/web/src/App.tsx`,
  `profile/ProfilePanel.tsx`, `sessions/useValidationSession.ts`, `validation/ValidationPanel.tsx`,
  a new `apps/web/src/grid/filter-recovery.ts`, plus `packages/engine-duckdb/src/*`). A build of the
  live checkout therefore is **not** attributable to a commit. All three rows were measured in a
  clean detached worktree pinned at `129e3ef` (`git worktree add /tmp/assay-measure-wt 129e3ef`,
  `pnpm install --frozen-lockfile --offline`, `pnpm build --force`), reused for every row. The
  live-checkout build was also taken first, as a control (§2.4): its only differences from
  `129e3ef` are the peer's in-flight web edits, quantified below.
- `pnpm build --force` on the clean worktree: **11.4 s** wall, 12/12 tasks, 0 cached (turbo caches a
  plain `pnpm build`). The build left `git status` clean; `dist/` is ignored.
- `HEAD` advanced again (`d457eec`) before this record was committed, so the record's own commit sits
  on a later tree than the one measured. That is harmless — the record is documentation-only and
  every number in it names the tree it came from — but the measurement commit is `129e3ef`, not the
  record's parent.

`pnpm-lock.yaml` is byte-identical between `06d8e20` and `129e3ef`
(`git diff 06d8e20 129e3ef -- pnpm-lock.yaml` is empty), so every C3 delta below is a build-output
delta, not a dependency delta.

---

## 1. B6 — diff performance at scale

Method reference: the M1 record's discipline — per-metric **median of 3 repeats** with the observed
range, warm page cache, correctness anchors checked against an independently derived expectation
([05-m1-benchmarks.md](../../engineering/05-m1-benchmarks.md) §Methodology). Risk R7 itself records
the _intent_ to benchmark and no numbers
([roadmap §6 R7](../../product/03-execution-roadmap.md#6-risks-and-mitigations)); there is no
recorded M6 diff measurement to reproduce (§1.6).

### 1.1 Fixtures (generated, never committed)

Generated with the pinned CLI under `/tmp/assay-bench/`; nothing was written inside the repository.
Shape: an ascending unique `BIGINT` key (zone-map friendly, like a real primary key), one categorical
`INTEGER`, one pseudo-random `DOUBLE` (`hash()`-derived, so value predicates cannot prune), and a
high-entropy 37-char `VARCHAR`.

```sql
-- small pair (A = 10,000 rows; B = 10,000 rows)
COPY (
  SELECT i AS id, CAST(i % 17 AS INTEGER) AS cat,
         (hash(i) % 100000) / 1000.0 AS value, 'row-' || md5(i::VARCHAR) AS label
  FROM range(1, 10001) t(i)
) TO '/tmp/assay-bench/small-a.parquet' (FORMAT parquet, COMPRESSION zstd);

COPY (
  SELECT id, cat, CASE WHEN id % 500 = 3 THEN value + 1000 ELSE value END AS value, label
  FROM read_parquet('/tmp/assay-bench/small-a.parquet') WHERE id % 1000 <> 7
  UNION ALL
  SELECT 20000 + i, CAST(i % 17 AS INTEGER), (hash(20000 + i) % 100000) / 1000.0,
         'row-' || md5((20000 + i)::VARCHAR)
  FROM range(1, 11) t(i)
) TO '/tmp/assay-bench/small-b.parquet' (FORMAT parquet, COMPRESSION zstd);
```

The large pair is the same SQL with `range(1, 250001)`, `id % 20000 = 3` for changed rows,
`id % 10000 <> 7` for removed rows, added ids `250001 … 250050`; the 1M pair is the same again with
`range(1, 1000001)`, `id % 20000 = 3`, `id % 40000 <> 7`, added ids `1000001 … 1000200`
(files `/tmp/assay-bench/gen-{small,large,xl}.sql`, re-runnable as `/tmp/duckdb -c '.read <file>'`).

| Pair             |    A rows |    B rows |    A bytes |    B bytes | added | removed | changed |
| ---------------- | --------: | --------: | ---------: | ---------: | ----: | ------: | ------: |
| small            |    10,000 |    10,000 |    239,420 |    240,199 |    10 |      10 |      20 |
| large            |   250,000 |   250,025 |  5,809,549 |  5,805,393 |    50 |      25 |      50 |
| xl (extra point) | 1,000,000 | 1,000,175 | 23,095,178 | 23,093,101 |   200 |      25 |      50 |

The added/removed/changed columns are **not** taken from `assay`: they were derived independently
with the pinned DuckDB CLI (`EXCEPT` both ways plus
`a JOIN b USING (id) WHERE a.value IS DISTINCT FROM b.value`) and only then compared with the CLI's
own report (§1.4).

### 1.2 Invocation

The repository does **not** support running `apps/cli/dist` from a workspace checkout (`@assay/*`
exports point at `src/index.ts` in-repo; `apps/cli/src/index.ts:339` says so explicitly). The
supported path is the packed consumer, so the measured CLI is the installed artefact: every package
in the CLI runtime closure was packed
(`pnpm pack --pack-destination /tmp/assay-bench/tarballs` from each package directory) and installed
into a throwaway consumer (`npm install --no-audit --no-fund --prefer-offline`, 42 packages, 3 s,
no registry read observed). `/tmp/assay-bench/consumer/node_modules/.bin/assay --version` →
`assay 0.0.0`.

```bash
# end-to-end diff (the row's (b))
assay diff /tmp/assay-bench/<pair>-a.parquet /tmp/assay-bench/<pair>-b.parquet --key id
# peak memory of the CLI process (the row's (c))
/usr/bin/time -v assay diff …          # parsed: Elapsed (wall clock), Maximum resident set size
```

`(a)` time-to-first-result for a key-filtered read has no CLI command: the CLI exposes `validate`,
`diff`, `profile`, `pipeline`, `dcr` and no filtered-read verb. It was therefore measured at the
seam the CLI itself uses — the packed `@assay/cli/dist/connection.js` (`openConnection` →
`registerDataset` → one keyed query), timed with `performance.now()` from process start so Node
startup and the eager native bindings load are **inside** the number (that is the honest analogue of
"process start to first result", and it is what a `assay` invocation pays before any dataset work).
A separate `assay profile` run per side is used to size the profiling leg.

### 1.3 Results

Warm page cache throughout (fixtures generated on the same NVMe immediately before the runs). One
discarded warm-up per measurement, then three recorded repeats. **Batch A** and **batch B** are two
independent full repeats, taken minutes apart, so their spread is the two-run stability of §1.5.

| Measurement                               | Batch A repeats (s) | A median | A range   | Batch B repeats (s) | B median | B range   |
| ----------------------------------------- | ------------------- | -------: | --------- | ------------------- | -------: | --------- |
| (a) TTFR, key-filtered, small (10k)       | 0.25, 0.21, 0.22    | **0.22** | 0.21–0.25 | 0.27, 0.36, 0.30    | **0.30** | 0.27–0.36 |
| (a) TTFR, key-filtered, large (250k)      | 0.28, 0.26, 0.23    | **0.26** | 0.23–0.28 | 0.30, 0.35, 0.25    | **0.30** | 0.25–0.35 |
| (b) `assay diff`, small pair              | 0.47, 0.60, 0.71    | **0.60** | 0.47–0.71 | 0.54, 0.49, 0.57    | **0.54** | 0.49–0.57 |
| (b) `assay diff`, large pair              | 1.06, 0.95, 0.93    | **0.95** | 0.93–1.06 | 1.12, 1.32, 1.16    | **1.16** | 1.12–1.32 |
| (b) `assay diff`, xl pair (1M, one batch) | 1.87, 1.87, 2.00    | **1.87** | 1.87–2.00 | —                   |        — | —         |
| `assay profile`, large A (one side)       | 0.44, 0.46, 0.48    | **0.46** | 0.44–0.48 | —                   |        — | —         |
| `assay profile`, xl A (one side)          | 0.76, 0.69, 0.67    | **0.69** | 0.67–0.76 | —                   |        — | —         |

Outliers, labelled as such: `diff` on the small pair, batch A repeat 3 (**0.71 s**, +18 % over its
batch median) and `diff` on the large pair, batch B repeat 2 (**1.32 s**, +14 %) — both are positive
wall-time outliers with no matching CPU-time spike pattern, consistent with scheduler contention on
an oversubscribed host (§4), not with a workload difference.

Peak memory (`/usr/bin/time -v`, maximum resident set size of the whole process):

| Measurement             |   Peak RSS per repeat (KiB) |                Median | Range          |
| ----------------------- | --------------------------: | --------------------: | -------------- |
| (a) TTFR small          | 104,772 / 105,200 / 106,056 | **105,200** (103 MiB) | 104.8–106.1 MB |
| (a) TTFR large          | 108,204 / 107,172 / 107,556 | **107,556** (105 MiB) | 107.2–108.2 MB |
| (b) `diff` small pair   | 148,944 / 143,740 / 149,752 | **148,944** (145 MiB) | 143.7–149.8 MB |
| (b) `diff` large pair   | 381,888 / 377,924 / 376,680 | **377,924** (369 MiB) | 376.7–381.9 MB |
| (b) `diff` xl pair (1M) | 813,188 / 815,808 / 757,128 | **813,188** (794 MiB) | 757.1–815.8 MB |
| `assay profile` large A | 212,936 / 218,216 / 221,768 | **218,216** (213 MiB) | 212.9–221.8 MB |
| `assay profile` xl A    | 460,552 / 467,088 / 446,256 | **460,552** (450 MiB) | 446.3–467.1 MB |

CPU time is recorded next to wall time because the host was contended: `diff` on the large pair used
**1.13–1.29 s user + 0.23–0.29 s sys** (batch A) and **1.47–1.51 s user + 0.30–0.41 s sys** (batch B);
`diff` on the xl pair used 3.54–3.93 s user + 0.58–0.64 s sys — user time exceeds wall time, i.e.
DuckDB's native side is already parallel inside one CLI process. Batch B's higher CPU time is the
reason its wall numbers are also higher; it is a real second-run difference, not only queueing.

TTFR legs from one representative run (internal `performance.now()`, small pair, 10,000 rows):

| Leg (cumulative from process start)             |        ms |
| ----------------------------------------------- | --------: |
| module load + native bindings import            |     250.1 |
| `openConnection()` (DuckDB instance)            |     306.2 |
| `registerDataset()` (parquet view + `DESCRIBE`) |     319.6 |
| keyed query → first row (`WHERE "id" = 5000`)   | **322.8** |

So on the keyed-read path the fixed startup is essentially the whole TTFR: instance boot ≈ 56 ms,
registration of a 10k-row parquet ≈ 13 ms, the key-filtered read itself ≈ 3 ms. At 250,000 rows the
same legs are 244.1 / 251.9 / 258.5 ms — registration grows by ~8 ms, the keyed read stays ~7 ms.

The two-sided diff is dominated by profiling, not by the row diff: one `assay profile` pass costs
0.46 s at 250k rows and 0.69 s at 1M rows as a standalone process, and `assay diff` (0.95 s / 1.87 s)
is approximately two profile passes plus boot and a small row-diff term. The weak inference is
recorded as such: the CLI emits no per-aspect instrumentation, so this is a subtraction over separate
processes, not a stage breakdown from one run (named as a remaining measurement in §4).

### 1.4 The diff's own reported counts (correctness anchor)

All three pairs agree **exactly** with the independently derived DuckDB expectation of §1.1; exit
code 1 (`differences`) for each:

| Pair  | CLI `row diff:` line                                         | Independent expectation | Exit |
| ----- | ------------------------------------------------------------ | ----------------------- | ---: |
| small | `10 added, 10 removed, 20 changed` (rows 10000 → 10000)      | 10 / 10 / 20            |    1 |
| large | `50 added, 25 removed, 50 changed` (rows 250000 → 250025)    | 50 / 25 / 50            |    1 |
| xl    | `200 added, 25 removed, 50 changed` (rows 1000000 → 1000175) | 200 / 25 / 50           |    1 |

`schema drift: none` and `profile deltas: 3 columns` (small) / `4 columns` (large, xl) were reported
for every pair; the changed rows name the changed column (`changed: value`), matching the fixture
construction. This is a correctness anchor, not a gate: no diff behaviour was changed by this row.

### 1.5 Two-run stability observed

| Measurement  | Batch A median | Batch B median |  Move |
| ------------ | -------------: | -------------: | ----: |
| TTFR small   |         0.22 s |         0.30 s | +36 % |
| TTFR large   |         0.26 s |         0.30 s | +15 % |
| `diff` small |         0.60 s |         0.54 s | −10 % |
| `diff` large |         0.95 s |         1.16 s | +22 % |

**Verdict: not yet stable.** Two full repeat batches on the same host, same fixtures, same
artefacts move the medians by 10–36 %, and the widest single-measurement range (small diff,
0.47–0.71 s) is ±20 % of its median. The cause is visible and external: the host carried a 1-minute
load average of 38–59 on 16 cores for the whole pass, because other agent sessions were building and
testing at the same time. CPU time (which contention inflates far less) still moved between batches
(`diff` large: 1.13–1.29 s user vs 1.47–1.51 s user), so neither wall nor CPU time is inside a band
narrow enough to justify a threshold. **No threshold is set**, per the row's instruction: a
threshold needs two _stable_ baselines, and this pass produced two noisy ones.

### 1.6 What is comparable to the recorded M1/M6 numbers, and what is not

| Recorded number                                                                             | Source                                                                            | Comparable to this row?                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| TTFR 308 ms (1.09 GiB) / 411 ms (10.24 GiB); picker→first-row 1.88 s / 2.11 s               | [M1 record](../../engineering/05-m1-benchmarks.md) §Results, G1-R                 | **Not directly.** Those are in-page `performance.now()` numbers for `fetchRange(0, 1000)` inside an already-booted DuckDB-WASM worker in Chromium. This row's TTFR is process-start → first row of a _single-key_ read on Node + native `@duckdb/node-api`, including Node startup and native-bindings load. Different surface, runtime, and metric definition; only the order of magnitude is comparable, and even that only for the startup-dominated shape (both are ~0.2–0.4 s). |
| Filtered near-full scan 2.29 s/GiB → 21.0 s at 10.24 GiB (0.48 GiB/s, single-threaded WASM) | M1 record §Scaling analysis                                                       | **Not comparable.** Nothing in this row forces a full scan: the row diff joins on an ascending unique key, so zone maps prune; no filter-only workload was measured.                                                                                                                                                                                                                                                                                                                 |
| Main-thread heap 3 MB (flat); worker heap unmeasured (OQ #1)                                | M1 record                                                                         | **Not comparable — and not a substitute.** This row measures whole-process RSS of a Node process (105–815 MB), which includes the native buffer manager and V8. M1 explicitly could not capture the DuckDB worker heap; OQ #1 stays open.                                                                                                                                                                                                                                            |
| Schema drift / profile deltas / row diff _counts_                                           | M6 (m6-1…m6-5) as recorded in [roadmap §4](../../product/03-execution-roadmap.md) | **Comparable as correctness, not as speed.** M6's record asserts web ≡ CLI field-for-field agreement; this row re-derives the counts independently with DuckDB and gets the same numbers.                                                                                                                                                                                                                                                                                            |
| Any M6 diff latency / memory number                                                         | —                                                                                 | **Does not exist.** Risk R7 records the benchmark as remaining work; there is no recorded M6 diff timing to reproduce, so no gap is being hidden here — the gap is that R7's benchmark had never been run.                                                                                                                                                                                                                                                                           |

Also not comparable: M1 used 16 M / 150 M rows (1.09 GiB / 10.24 GiB) with seven typed columns
including a nullable and a list column; this row uses 10 k / 250 k / 1 M rows with four columns and
no NULLs and no non-unique keys. The fixtures are deliberately honest about being synthetic (§4).

---

## 2. C3 — second bundle baseline and two-run determinism

Method, buckets and commands are exactly
[doc 10](../../engineering/10-dependency-and-bundle-measurements.md) §2–§3; the bucket definitions
were not changed, so the numbers are comparable with the 2026-11-20 baseline. No budget is set
(§2.5).

### 2.1 Determinism verdict (two runs, same built tree)

`pnpm measure:bundle --json` was run **twice** on each of two independently built trees (the clean
`129e3ef` worktree and the live checkout), plus twice more invoking `node scripts/measure-bundle.mjs
--json` directly in the worktree. Every pair was **byte-identical**:

| Tree                                   | Run 1 sha256         | Run 2 sha256         | Verdict        |
| -------------------------------------- | -------------------- | -------------------- | -------------- |
| live checkout (`42c04ff` + peer edits) | `c049a3de…5b7ba1054` | `c049a3de…5b7ba1054` | byte-identical |
| clean worktree `129e3ef` (via `pnpm`)  | `6641c7e8…e805b9c5`  | `6641c7e8…e805b9c5`  | byte-identical |
| clean worktree `129e3ef` (via `node`)  | `0d1f7b6c…f6ee091e`  | `0d1f7b6c…f6ee091e`  | byte-identical |

**The measurement is deterministic at byte level for a fixed built tree and a fixed install.** Two
qualifications, both of which matter to a future budget:

1. **The install-size table is not reproducible across two independent installs** of the _same_
   lockfile. Comparing the worktree install with the live-checkout install, **12 of 31** names move
   (`eslint-plugin-react-hooks` +112 B, `vite` −66, `vitest` −400, `eslint-plugin-import-x` −130,
   `tsx`/`@vscode/test-electron`/`@changesets/cli`/`@axe-core/playwright`/`@vitejs/plugin-react`/
   `@playwright/test`/`@vitest/coverage-v8` ±56 each, `typescript-eslint` +168), net +76 B, absolute
   swing ~1.2 kB, on a 230.95 MB total. Every other section (`web`, `cli`, `desktop`, `packages`) is
   identical between the two trees apart from the peer's in-flight web edits (§2.4). Root cause was
   not established; the practical reading is that the install-size row includes install-path- or
   metadata-dependent bytes and must be quoted with a noise band, never a budget.
2. **Two independent builds of the same sources are byte-identical per file except
   `dist/spike-artifacts.json`**, which embeds `generatedAt: new Date().toISOString()`
   (`apps/vscode/scripts/build.mjs`). Its _size_ is stable (879 B), so the measurement output is
   unaffected — but a byte-level dist diff across builds will always show it.

A third, build-side caveat found while doing this: esbuild writes relative **source-path comments**
into the unminified webview bundles, so `apps/vscode/dist` bytes depend on the build's working
directory. `node apps/vscode/scripts/build.mjs` from the repository root produced
`dataset.js` = 1,078,384 B, while the package-script invocation (`pnpm build`, `cwd` = `apps/vscode`)
produced 1,079,542 B; the only difference is comment paths (`../../packages/grid/…` vs
`packages/grid/…`). Only the documented invocation is comparable — the numbers below use it.

Minor tooling note: `pnpm measure:bundle --json` passes the script's JSON through pnpm, which prefixes
a `$ node scripts/measure-bundle.mjs --json` banner line, so the piped output is not parseable JSON as
is; call `node scripts/measure-bundle.mjs --json` directly (or drop line 1) when consuming it
mechanically.

### 2.2 Tables: `129e3ef` against the `06d8e20` baseline

Commit pair: baseline **`06d8e200c918ce488c4c359158358e630941cae3e`** (doc 10, "main after A02/A04") →
current **`129e3ef3acc3d91ed568644daf39168f47ea2d1b`**. Both sides built with `pnpm build --force`;
lockfile identical. Raw bytes unless marked.

**Browser web app — `apps/web/dist`** (20 files)

| Bucket         | Baseline (B) | Current (B) |                      Δ | Δ gzip |
| -------------- | -----------: | ----------: | ---------------------: | -----: |
| `document`     |          932 |         932 |                      0 |     +1 |
| `static-entry` |    1,015,562 |   1,025,224 |             **+9,662** | +3,167 |
| `lazy-chunk`   |       73,654 |      73,654 |                      0 |     +4 |
| `lazy-worker`  |    1,913,474 |   1,914,091 |               **+617** |   +220 |
| `lazy-wasm`    |   73,605,237 |  73,605,237 |                      0 |      0 |
| **total**      |   76,608,859 |  76,619,138 | **+10,279** (+0.013 %) | +3,392 |

Per-file movement: entry JS `index-*.js` 932,605 → **942,134** (+9,529; gzip 260,063 → 263,211) and
entry CSS `index-*.css` 55,874 → **56,007** (+133; gzip +19); app worker `worker-*.js` 296,071 →
**296,688** (+617). Every panel chunk (`DiffPanel`, `PipelinePanel`, `ProfilePanel`, `SqlPanel`,
`ValidationPanel`) and both DuckDB worker/wasm pairs are byte-for-byte the same size as the baseline
(chunk hashes changed where content changed, sizes did not).

**CLI — `apps/cli/dist` and the packed tarball**

| Quantity                             | Baseline (B) | Current (B) |        Δ |
| ------------------------------------ | -----------: | ----------: | -------: |
| `files` allowlist payload            |      509,314 | **509,757** | **+443** |
| — `.js` (25)                         |      245,340 |     245,706 |     +366 |
| — `.js.map` (25)                     |      157,803 |     157,865 |      +62 |
| — `.d.ts` (25)                       |       75,333 |      75,348 |      +15 |
| — `.d.ts.map` (25)                   |       30,838 |      30,838 |        0 |
| packed tarball `assay-cli-0.0.0.tgz` |      138,019 | **138,242** | **+223** |

(`pnpm pack` was run once for this row to obtain the tarball — it is not part of
`measure:bundle`; the repeatable number remains the 509,757 B allowlist payload.)

**Desktop extension — `apps/vscode/dist`** (14 files)

| Bucket                 | Baseline (B) | Current (B) |                      Δ |  Δ gzip |
| ---------------------- | -----------: | ----------: | ---------------------: | ------: |
| `host-bundle`          |       56,720 |      58,391 |             **+1,671** |    +669 |
| `webview-script`       |    3,142,259 |   3,179,889 |            **+37,630** | +11,261 |
| — `webview/dataset.js` |    1,053,371 |   1,079,542 |            **+26,171** |  +8,120 |
| — `webview/main.js`    |      660,188 |     672,698 |            **+12,510** |  +3,658 |
| — `webview/worker.js`  |      655,941 |     654,890 |             **−1,051** |    +197 |
| `test-bundle`          |       32,891 |      32,891 |                      0 |       0 |
| `duckdb-runtime`       |   34,242,586 |  34,242,586 |                      0 |       0 |
| `duckdb-extension`     |    3,865,685 |   3,865,685 |                      0 |       0 |
| `metadata`             |        1,773 |       1,773 |                      0 |      −1 |
| **total**              |   41,341,914 |  41,381,215 | **+39,301** (+0.095 %) | +11,929 |

**Publishable library payloads** (`files` allowlist)

| Package               | Baseline (B) | Current (B) |           Δ | Δ gzip |
| --------------------- | -----------: | ----------: | ----------: | -----: |
| `packages/diff`       |      332,784 |     335,349 |  **+2,565** | +1,159 |
| `packages/grid`       |       66,787 |      84,136 | **+17,349** | +5,386 |
| `packages/telemetry`  |      127,653 |     128,926 |  **+1,273** |   +512 |
| `packages/contracts`  |      259,673 |     259,673 |           0 |      0 |
| `packages/domain`     |      162,888 |     162,888 |           0 |      0 |
| `packages/validation` |      188,904 |     188,904 |           0 |      0 |

`packages/grid` is 12 files in both cases; the growth is inside `viewport-model.js`
(30,897 B) and its `.d.ts`/map siblings, not new modules.

**Install size** (install size, **not** bundle weight): 230,954,342 → 230,953,502 B, Δ **−840 B** —
inside the cross-install noise of §2.1, and consistent with an unchanged lockfile: **no dependency
was added, removed or upgraded**, so there is no install-size delta to attribute.

### 2.3 Attribution of the deltas (which closed rows plausibly moved them)

Rule zero: these are attributions by path and commit, not by module-level attribution — the build
emits no per-module metafile (only C2's experiment does, and only for the webview). Commits between
`06d8e20` and `129e3ef` touching each path:

| Delta                                                                                                       | Plausible cause (closed rows / commits since `06d8e20`)                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| web entry JS **+9,529** and CSS **+133**                                                                    | WF-O1 `030aa87` (the `Not applied` filter-draft marker: control + value-free live region, and its CSS), C02b (`dbb37b9`/`94e558f`/`f81e904` atomic whole-list filter capability + phase-aware failure copy), D02b/D02c (`12e2981`/`fb10abe` replacement controller and one session owner), E01 `048b70a` (abort in-flight telemetry on opt-out), `42c04ff` (in-flight-limit disclosure copy), `617ea11` (exact UHUGEINT cell rendering), `129e3ef` (prettier). |
| web worker **+617**                                                                                         | D04a `8b290c0` / D04b `1d5fec3` (CSV-dispatch and COPY/export SQL emission extracted out of the worker bundle) — pure refactors, but module boundaries changed what the bundler keeps.                                                                                                                                                                                                                                                                         |
| CLI payload **+443**                                                                                        | B4 `82e9973` (explicit side-A base view in `runDiffPlan`) plus the `129e3ef` prettier pass; +366 B of it is emitted JS.                                                                                                                                                                                                                                                                                                                                        |
| desktop `dataset.js` **+26,171**, `main.js` **+12,510**, `worker.js` **−1,051**, `extension.cjs` **+1,671** | D03a `1d76fed`/`2e46573` (export-transfer controller), D03b `6a48583` (webview presentation controllers split — this is where the host bundle grows and the webview worker shrinks), C02c `3b239f2`/`1c3b77f`/`d1e5c28` (desktop atomic whole-list filter + phase-derived failure copy), `d9e23e3` (proof-gate predicate stated in the module doc). None of these is a vendored asset: the DuckDB runtime, extensions and both worker pins are unchanged.      |
| `packages/diff` **+2,565**                                                                                  | B5 `f020cde` (ordinal scan now catches same-scope JOIN/HAVING/GROUP BY/QUALIFY) + `acdb19d` (hostile-generator refactor) + `129e3ef` prettier.                                                                                                                                                                                                                                                                                                                 |
| `packages/grid` **+17,349**                                                                                 | C02a `d6430d6` (atomic whole-list filter transactions in the headless viewport model) with its T9 interleave pins `a4ba9b6`/`9738d49`.                                                                                                                                                                                                                                                                                                                         |
| `packages/telemetry` **+1,273**                                                                             | `42c04ff` (in-flight limit stated in the disclosure copy).                                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/{contracts,domain,validation}`, `test-bundle`, both DuckDB pairs, `metadata`                      | Unchanged — no row in this batch touched those build outputs.                                                                                                                                                                                                                                                                                                                                                                                                  |

Two notes for the orchestrator: (i) **ENG-2 did not land** (it is recorded but unselected), so no
engine op was added to any payload in this batch — `packages/engine-duckdb` is not a publishable
payload in §8, so an engine op would not appear in this table anyway; (ii) the B6 fixture/consumer
work of this pass wrote nothing into the repository, so it contributes zero bytes here.

### 2.4 Control: the live checkout's build (peer in-flight work, excluded above)

The first build of this pass was taken in the live checkout (`42c04ff` + a peer agent's uncommitted
A3/C02-parity edits, 255 added lines across four web files + one new module). Its web table differs
from the clean `129e3ef` table by **+1,930 B raw**: entry JS 942,134 → 943,220 (+1,086),
`ProfilePanel` 11,271 → 11,701 (+430), `ValidationPanel` 14,808 → 15,222 (+414). Those bytes belong
to the uncommitted peer work and are **not** attributed to any closed row; they would enter the next
baseline when that work merges. Everything outside `apps/web` was identical (CLI payload byte-for-byte
equal; the 8 B `dist/` total difference is `.tsbuildinfo`).

### 2.5 E02 position: budgets still await a second _stable_ baseline

Stated precisely, so the next pass is falsifiable. A second baseline counts as **stable** for E02
only when all of the following hold:

1. **Same invocation and same artefacts**: `pnpm build --force` followed by `pnpm measure:bundle`
   (package-script `cwd`, not a root-level `node <script>` call — see §2.1), on the same host class
   and OS, with a lockfile-identical tree.
2. **Reproduced buckets**: every section reproduces its predecessor byte-for-byte except for deltas
   attributable to named commits. Untouched pins (DuckDB worker/wasm pairs, vendored extensions) must
   be **0 Δ**; source-derived buckets must be explained commit-by-commit, as in §2.3.
3. **A stated tolerance for the two known non-reproducible rows**: the CLI tarball (a `pnpm pack`
   one-off) and the install-size table (12/31 names moving ±56–400 B across installs, §2.1) — either
   re-normalise the install-size section or exclude it from budgeting, and either re-pack both sides
   or drop the tarball row.
4. **Two consecutive rounds and no free-floating number**: the 2026-11-20 tables, this second set
   and the round after it, all under 1–3. Then a budget candidate from the buckets doc 10 §12 names —
   `static-entry`, `lazy-chunk`, `host-bundle` + `webview-script`, CLI `files` payload — can be set
   from observed movement, not from a single sample.

Until then this record only adds the second data point. The two passes now on file differ by
+10,279 B raw web (+0.013 %), +443 B CLI payload (+0.087 %), +39,301 B desktop (+0.095 %), and they
are attributable to the rows listed in §2.3 — which is encouraging, not a budget.

---

## 3. C2 — TEST-PROOF code in the production webview bundle

Scope: `apps/vscode/webview/test-proof/index.ts` (the D03b proof orchestration) as it reaches
`apps/vscode/dist/webview/dataset.js` through the single call site
`apps/vscode/webview/dataset.ts:416` (`const proofs = await runOpenProofs({ … })`).

### 3.1 Presence in the built output (static, marker-based)

Marker strings chosen from the module's own literals and identifiers: `validation-proof` (a stage
string set inside `runOpenProofs`), `runOpenProofs`, and the three `exercise*` entry points.

| Built file                | Bucket (doc 10 §7)              | `validation-proof` | `runOpenProofs` | `exercise{RealEditor,StagedDiff,Acceptance}` |      Size (B) |
| ------------------------- | ------------------------------- | -----------------: | --------------: | -------------------------------------------: | ------------: |
| `dist/webview/dataset.js` | `webview-script`                |                  1 |               2 |                                    2 / 2 / 2 | **1,079,542** |
| `dist/webview/main.js`    | `webview-script`                |                  0 |               0 |                                            0 |       672,698 |
| `dist/webview/worker.js`  | `webview-script`                |                  0 |               0 |                                            0 |       654,890 |
| `dist/extension.cjs`      | `host-bundle`                   |                  0 |               0 |                                            0 |        54,917 |
| `dist/e2e-test.cjs`       | `test-bundle` (test-only entry) |                  0 |               0 |                                            0 |        30,576 |
| `dist/spike-test.cjs`     | `test-bundle` (test-only entry) |                  0 |               0 |                                            0 |         2,315 |

**Exactly one shipped chunk contains the proof code: `webview/dataset.js`** — 1,079,542 B raw /
221,965 B gzip / 204,726 B brotli, the webview entry script. Nothing in the DuckDB worker, the spike
harness or the extension host carries it; `e2e-test.cjs` (the VS Code e2e runner, already bucketed as
`test-bundle` and not shipped to the webview) is also clean. `extension.cjs` contains the _gate_
(`ASSAY_E2E_EDIT_PROOF`, 5 occurrences) but no proof code.

### 3.2 Attribution: bytes from `webview/test-proof/**`

The build emits **no sourcemap and no metafile**
(`apps/vscode/scripts/build.mjs`: `sourcemap: false`, no `metafile` option), so attribution is not
available from the shipped build. It was obtained in the `/tmp` worktree by re-running the _same_
esbuild options for the `dataset.js` entry with `metafile: true` added (a scratch script, deleted
afterwards; the product build config was not touched):

| Input                              | `bytesInOutput` |
| ---------------------------------- | --------------: |
| `webview/test-proof/editor.ts`     |          18,382 |
| `webview/test-proof/diff.ts`       |          11,096 |
| `webview/test-proof/acceptance.ts` |           5,809 |
| `webview/test-proof/harness.ts`    |           3,916 |
| `webview/test-proof/validation.ts` |           3,406 |
| `webview/test-proof/index.ts`      |           2,046 |
| **6 inputs total**                 |      **44,655** |
| all 275 inputs                     |       1,058,283 |

**44,655 B = 4.22 % of summed `bytesInOutput`.** That denominator is esbuild's per-input accounting,
not the emitted file size (esbuild adds its own glue/comments), which is why the file-level check
below matters.

### 3.3 The stub experiment (only in the worktree, and it agrees)

`runOpenProofs` was replaced in the `/tmp` worktree by a no-op that keeps the exported types and
returns `{}`; `node scripts/build.mjs` was re-run with the documented invocation and the original
module restored afterwards (the worktree's own `git status` and the pre-stub per-file hashes were used
to verify the restore).

| File                                      | Before (B) | After no-op stub (B) |                     Δ |
| ----------------------------------------- | ---------: | -------------------: | --------------------: |
| `dist/webview/dataset.js`                 |  1,079,542 |        **1,034,813** | **−44,729 (−4.14 %)** |
| `dist/webview/dataset.js` (gzip level 6)  |    221,652 |              213,406 |      −8,246 (−3.72 %) |
| `dist/webview/main.js`                    |    672,698 |              672,698 |                     0 |
| `dist/webview/worker.js`                  |    654,890 |              654,890 |                     0 |
| `dist/extension.cjs`                      |     54,917 |               54,917 |                     0 |
| marker `validation-proof` in `dataset.js` |          1 |                    0 |                     — |

Two independent methods (`metafile` 44,655 B; stubbed build 44,729 B) agree to within 74 B (0.17 %),
which is the cross-check that the attribution is not a guess. The `exercise*` imports disappear with
the stub because esbuild drops imports that become unused — i.e. the delta _is_ the dead-code
elimination result, not an estimate.

### 3.4 The gate: verified mechanism (not merely asserted)

Three independent layers, all verified in source at `129e3ef`:

1. **Host computes the flag**: `apps/vscode/src/dataset.ts:174-177`
   `testHarness: context.extensionMode === vscode.ExtensionMode.Test && process.env['ASSAY_E2E_EDIT_PROOF'] === '1'`
   — the same predicate is repeated on the five other harness-gated paths (`:265-266`, `:329-330`,
   `:456-457`, `:560-561`, and the proof-normalisation branch at `:690`). `ExtensionMode.Test` is only
   set by the VS Code test host, and the environment variable is an internal proof switch, so a
   production (`Production`) or development (`Development`) extension instance always computes
   `false`.
2. **Webview passes the flag through and nothing else**: `webview/dataset.ts:417`
   `testHarness: config.testHarness`, where `config` is the host-injected message payload
   (`DatasetWebviewConfig`), not something the dataset content can influence.
3. **The module refuses unless the flag is exactly `true`**: `webview/test-proof/index.ts:74`
   `if (input.testHarness !== true) return {}` — a second, independent check, so a truthy
   non-boolean cannot open it either (pinned by the module's own test).

Consequence: in production the proof code is **shipped and parseable but unreachable** — no
`exercise*` call can execute. The cost is therefore static (bytes, parse/compile), not behavioural.
Note also the small non-`test-proof` `testHarness` branches that stay in the entry
(`webview/dataset.ts:178`, `:432`, `:568-570`): they are part of the same gate surface but are not
attributed by §3.2's measurement.

### 3.5 Decision input (not a decision)

- **Is the cost material?** On its own terms: **44,729 B raw / 8,246 B gzip** — 4.14 % of the webview
  entry script. Relative to what a desktop install actually downloads it is small: 0.108 % of the
  41.38 MB `apps/vscode/dist` payload, which is 82.8 % vendored DuckDB runtime. Relative to _code_
  the webview runs it is not negligible: `dataset.js` is the largest hand-written script in the
  extension (1.08 MB), and one 44.7 kB block of it can never execute in production. Parse/compile
  cost of that block is **not** measured here and is not claimed.
- **Does `config.testHarness` keep it unreachable?** Yes — verified at all three layers above
  (§3.4). The flag is computed by the extension host from `ExtensionMode` and an internal env var;
  the webview cannot forge it, and the module re-checks `!== true` itself.
- **What would removal change — build config or dead-code elimination?** DCE alone cannot remove it
  today: the call site is unconditional (`const proofs = await runOpenProofs({ … })` always runs) and
  the gate is a _runtime_ value, so no bundler can prove the branches dead. Two real shapes:
  (i) **build config** — alias `./test-proof` to a no-op in the production build (or gate the call
  site on a compile-time define), which is exactly the experiment measured in §3.3:
  −44,729 B raw / −8,246 B gzip, one build-file change, no runtime behaviour change; or
  (ii) **move the proofs to a test-only entry** (the shape `e2e-test.cjs` already has) and load it
  only from the test host — a larger change (webview entry split + host wiring) but it makes the gate
  structural rather than conventional, and then DCE _can_ drop everything, as §3.3 shows.
- **Named remaining decision input (the one thing this row does not answer):** the maintainer's
  judgement on whether 44.7 kB raw / 8.2 kB gzip of unreachable-but-shipped webview code justifies a
  build-config seam, weighed against the gate-integrity cost of a stub — a stub must be provably
  wired to the _same_ predicate, or a future refactor could ship the no-op in test mode and silently
  stop exercising the acceptance suite. Recording the cost does not answer that.

No code change was made for C2 in this task.

---

## 4. Evidence limits

- **Single host, heavily contended.** All B6 timings ran at a 1-minute load average of 38–59 on 16
  cores (other agent sessions building/testing). Wall times are therefore inflated and noisy: the
  two batches move by 10–36 % (§1.5). CPU time is reported alongside and was also not constant, so
  even "CPU-stable" medians are not established. These are not two stable baselines.
- **Warm cache only.** Fixtures were generated on the same NVMe immediately before the runs and
  re-read within seconds; no cold-cache or fresh-boot number exists. Same limitation as the M1 record.
- **Synthetic fixtures.** Deterministic `hash()`/`md5()` values, an ascending unique `BIGINT` key
  with no NULLs and no duplicates, four columns, no skew, no wide/embedded-newline strings, no
  schema drift. Real datasets can defeat the zone maps this row benefits from, and NULL-key groups,
  non-unique keys, multi-column keys, `--infer`, CSV/JSONL inputs, mixed-type columns and schema drift
  are all unmeasured.
- **CLI path only.** Nothing here measures the browser/WASM engine, so no comparison with M1's
  in-page TTFR or heap is possible. M1's worker-side heap (OQ #1) remains unmeasured and this row's
  whole-process RSS is not a substitute for it.
- **One process-wide metric, no per-stage instrumentation.** Peak RSS and wall time are for the whole
  CLI process; the "profiling dominates" reading in §1.3 is a subtraction across separate processes,
  not an instrumented stage breakdown. No concurrency, no repeated invocation in one process, no
  overlay/editing session, no `--sample-limit` variation, no aspect-isolated timing.
- **No e2e, no gate run.** This pass measured artefacts; it did not run the e2e suite, the VS Code
  host leg or the packed-consumer smoke. It changed no source and no test.
- **C3 attribution is by path and commit, not by module.** The build emits no metafile for `apps/web`
  or `apps/cli`, so §2.3 is "these commits touched these files", not "this module costs these bytes".
  C2's metafile attribution exists only because it was measured explicitly, in a worktree.
- **Two numbers in E02 are not byte-reproducible by construction**: the CLI tarball (a `pnpm pack`
  one-off) and the install-size table (12/31 names move 56–400 B between installs of the same
  lockfile). `spike-artifacts.json` embeds a timestamp, and esbuild output embeds source paths, so
  dist bytes depend on the invoking `cwd`. All four are stated in §2.1/§2.5 because they decide what
  "stable" can mean.
- **Peer work in flight.** The checkout carried another agent's uncommitted edits to `apps/web/**`
  and `packages/engine-duckdb/src/**` throughout; they were never touched and are excluded from the
  tables (§2.4 quantifies them). If they merge, they change the next baseline's web numbers by
  ~+1.9 kB raw.
- **Nothing here is a budget, a threshold, a gate or a decision**, and no comparable-baseline claim is
  made across hosts or commits: the only cross-commit comparison is C3's, and both sides are named by
  SHA and rebuilt with the documented command.

## 5. Reproduce

```bash
# 0. pinned tools
node -v && pnpm -v && /tmp/duckdb --version          # v24.13.0 / 11.26.0 / v1.5.5

# 1. a clean tree at the measurement commit, built once and reused for every row
git worktree add /tmp/assay-measure-wt 129e3ef
cd /tmp/assay-measure-wt
pnpm install --frozen-lockfile --offline
pnpm build --force                                    # 11.4 s, 12/12 tasks, 0 cached

# 2. C3 — the second baseline, twice, and diff the two runs
pnpm measure:bundle
node scripts/measure-bundle.mjs --json > /tmp/run1.json
node scripts/measure-bundle.mjs --json > /tmp/run2.json
cmp /tmp/run1.json /tmp/run2.json                      # byte-identical

# 3. B6 — fixtures (pinned CLI, /tmp only), consumer install, timings
/tmp/duckdb -c '.read /tmp/assay-bench/gen-small.sql'   # and gen-large.sql, gen-xl.sql
for p in packages/{contracts,diff,domain,engine-duckdb,pipeline,telemetry,validation,grid} apps/cli; do
  ( cd "$p" && pnpm pack --pack-destination /tmp/assay-bench/tarballs ); done
# consumer: package.json with file: deps on every tarball, then
npm install --no-audit --no-fund --prefer-offline        # 42 packages, no registry read observed
/usr/bin/time -v /tmp/assay-bench/consumer/node_modules/.bin/assay \
  diff /tmp/assay-bench/large-a.parquet /tmp/assay-bench/large-b.parquet --key id

# 4. C2 — presence, attribution, stub delta (worktree only)
grep -c -F 'validation-proof' apps/vscode/dist/webview/dataset.js      # 1 → only dataset.js
# metafile: re-run the dataset.js entry with `metafile: true` (scratch script, deleted after)
# stub:     replace runOpenProofs with a no-op, `node scripts/build.mjs`, compare sizes, restore
```

Artifacts of this pass (not committed): `/tmp/assay-bench/{gen-*.sql,*-{a,b}.parquet,results*.tsv,
run-*}`, `/tmp/c2-dist-before.sha256`, `/tmp/bundle-run1.json`, `/tmp/wt-m1.json`,
`/tmp/wt-bundle.txt`. The `/tmp` worktree was removed after the pass.
