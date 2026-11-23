# E02 — third bundle baseline, the stable-round verdict, and budget candidates (2026-11-23)

**Item:** **R-11** — E02 bundle budgets, the measurement protocol row
([brief](20261122-h2-technical-carry-briefs.md#r-11--e02-bundle-budgets)).
**Base:** `main` at `3a86ac2b50e8d0a1cc303c9a1b37ca0c31393146` — the tree was **clean when measured**
(`git status --porcelain` empty), and the only changes on top of it are the four documentation files
this item produces (§11). `pnpm install --frozen-lockfile` was already up to date, and the lockfile is
unmodified across the whole range (`git diff --name-only 129e3ef..3a86ac2 -- pnpm-lock.yaml` → 0
files).
**Status:** **MEASURED — rounds are stable; budget candidates proposed, none adopted, nothing wired
into a gate.** The only outstanding decision is the maintainer's, and it is named in §7.

**Authority order used here:** accepted ADRs → the [living handoff](../handoff.md) current-state block
→ [successor queue](20261121-successor-queue.md) §8/§9 → [decision round](20261121-decision-round.md)
→ the [2026-11-21 measurement record](20261121-measurement-rows-b6-c3-c2.md) §2/§2.5 →
[doc 10](../../engineering/10-dependency-and-bundle-measurements.md) §2–§3, §12–§13 (method, buckets,
candidates, reproduce) → this record.

No code, no config, no bucket definition and no script changed: this record only adds a data point
under the method doc 10 §2–§3 already fixes. `scripts/measure-bundle.mjs` is untouched and
`scripts/measure-bundle.test.mjs` (17 tests) passes unmodified.

## 0. Environment and invocation (the §2.5(1) condition)

| Item        | Value                                                                        |
| ----------- | ---------------------------------------------------------------------------- |
| Commit      | `3a86ac2b50e8d0a1cc303c9a1b37ca0c31393146`                                   |
| OS / arch   | linux x64 (byte counts, not timings — platform-neutral)                      |
| Node        | 24.13.0 (root `engines.node: ^24.0.0`)                                       |
| pnpm        | 11.26.0 (`packageManager` pin)                                               |
| Build tools | turbo 2.11.3, vite 8.3.0, esbuild 0.28.2, typescript 6.0.3 (from the report) |
| Compression | `zlib.gzipSync` level 6, `zlib.brotliCompressSync` quality 6 (per file)      |
| Lockfile    | `pnpm-lock.yaml` unmodified across `129e3ef..3a86ac2`                        |

Invocation, exactly as the method requires — package-script `cwd`, `--force` (a cached turbo replay
is not a rebuild), `rm -rf` of every measured `dist/` first:

```bash
rm -rf apps/web/dist apps/cli/dist apps/vscode/dist packages/*/dist
pnpm build --force            # 12/12 tasks, 0 cached, ~9–10 s wall on this host (warm store)
pnpm measure:bundle           # exit 0 — human tables §2
node scripts/measure-bundle.mjs --json   # exit 0 — the numbers below (pnpm's banner makes its stdout non-JSON)
```

## 1. Determinism: four runs, two builds, two checkouts

`node scripts/measure-bundle.mjs --json` was run **twice on each of three built trees**, and once more
by the independent reviewer on a **fourth** build of the same commit. Every run on a fixed tree is
byte-identical; a rebuild of the same commit is identical in every raw figure but not always in one
compressed one (below).

| Tree                                                                  | Runs | sha256 of `--json`                                                 |
| --------------------------------------------------------------------- | ---- | ------------------------------------------------------------------ |
| main checkout `3a86ac2`, build **A**                                  | 2    | `2f45e1efb9163eb141b029a1f67ebcbb66491a215c066a4362583775922e7d92` |
| main checkout `3a86ac2`, build **B** (dists deleted, `build --force`) | 2    | `2f45e1efb9163eb141b029a1f67ebcbb66491a215c066a4362583775922e7d92` |
| main checkout `3a86ac2`, build **C** (the reviewer's, same checkout)  | 1    | `9e786322c9bda869084e2e2350379c1244342767f5cab16999cab6fd8c550217` |
| independent worktree `/tmp/wt-attr`, independent install, `3a86ac2`   | 1    | `c2d086b1ffc88c374be60edfe18477b575c0b25549e1e15c1feac55997562ee5` |

**Verdict — and a limit this round found the hard way.** Repeated runs on a **fixed** built tree are
byte-identical, which is the method doc's determinism claim and held on every tree here. Against the
independent checkout the JSON differs **only inside `installSize`** (§5): `schemaVersion`, `tool`,
`method`, `environment` and all four `targets` compare equal. **Rebuilding** the same commit is
identical in every **raw** figure and every bucket total, but not always in one compressed figure:
`apps/vscode/dist/spike-artifacts.json` embeds `generatedAt` (`apps/vscode/scripts/build.mjs`) at a
fixed **879 B raw**, and its **brotli** size moves by **±1 B** with the timestamp's content (gzip
stayed 287 B across the builds observed). Builds A and B happened not to flip it; build C did —
`9e7863…` differs from `2f45e1ef…` **only** in that file's brotli 260 → 259, hence `metadata`
727 → 726 (desktop total brotli 7,470,471 → 7,470,470). Every raw byte, every bucket total, all six
package payloads, the CLI payload and the install-size row were identical.

**So a determinism verdict for E02 is a raw-bytes verdict.** Compressed totals are quoted with the
±1 B `metadata` tolerance and are never used for a ceiling (§8). The first draft of this record
claimed unconditional build-to-build byte identity on the strength of A and B alone; the independent
review falsified that by rebuilding, and §8 records the correction rather than re-running until the
hash matched.

**The recorded predecessor tables reproduce.** Building `129e3ef` in the worktree reproduces the
2026-11-21 record's `129e3ef` figures exactly on every **raw** quantity: web total **76,619,138**,
`static-entry` 1,025,224, `lazy-chunk` 73,654, `lazy-worker` 1,914,091, `lazy-wasm` 73,605,237, CLI
`files` payload **509,757**, desktop total **41,381,215** (`host-bundle` 58,391, `webview-script`
3,179,889, pins unchanged), all six publishable payloads unchanged. The earlier tables are therefore
environment-stable for raw bytes, not lucky single samples. One compressed figure does not reproduce;
it is corrected in §8.

## 2. Tables at `3a86ac2`, against `129e3ef`

Commit pair: second baseline **`129e3ef3acc3d91ed568644daf39168f47ea2d1b`** → third baseline
**`3a86ac2`**. Raw bytes unless marked. Every delta below is attributed in §3; there is no
unattributed movement.

**Browser web app — `apps/web/dist`** (20 files)

| Bucket         |  `129e3ef` |      `3a86ac2` |                     Δ | Δ gzip | Δ brotli |
| -------------- | ---------: | -------------: | --------------------: | -----: | -------: |
| `document`     |        932 |            932 |                     0 |     −1 |       −1 |
| `static-entry` |  1,025,224 |  **1,018,683** |            **−6,541** | −2,345 |   −2,250 |
| `lazy-chunk`   |     73,654 |     **74,498** |              **+844** |   +173 |     +160 |
| `lazy-worker`  |  1,914,091 |  **1,917,243** |            **+3,152** |   +765 |     +694 |
| `lazy-wasm`    | 73,605,237 |     73,605,237 |                     0 |      0 |        0 |
| **total**      | 76,619,138 | **76,616,593** | **−2,545** (−0.003 %) | −1,408 |   −1,397 |

Per-file movement (the entry/panel/worker chunks are content-hashed, so the bucket is the stable
unit): entry JS `index-*.js` 942,134 → **935,593** (−6,541; gzip 263,211 → 260,866), entry CSS
56,007 → 56,007 (**0**), app worker `worker-*.js` 296,688 → **299,840** (+3,152), `ProfilePanel`
11,271 → **11,701** (+430), `ValidationPanel` 14,808 → **15,222** (+414), `DiffPanel` / `SqlPanel` /
`PipelinePanel` byte-identical in size (15,333 / 6,615 / 25,627), and the four pinned DuckDB assets
identical in **both** name and size (`duckdb-browser-eh.worker-hQa-dcAV.js` 772,759,
`duckdb-browser-mvp.worker-C9hF7LGh.js` 844,644, `duckdb-eh-9ubY-jlA.wasm` 34,242,586,
`duckdb-mvp-BP0pRkMH.wasm` 39,362,651). Only the app worker's hash changed
(`worker-D7_dVcBC.js` → `worker-BpU2YaVC.js`).

**CLI — `apps/cli/dist` and the packed tarball**

| Quantity                              | `129e3ef` |   `3a86ac2` |     Δ |
| ------------------------------------- | --------: | ----------: | ----: |
| `files` allowlist payload             |   509,757 |     509,757 | **0** |
| — `.js` (25)                          |   245,706 |     245,706 |     0 |
| — `.js.map` (25)                      |   157,865 |     157,865 |     0 |
| — `.d.ts` (25)                        |    75,348 |      75,348 |     0 |
| — `.d.ts.map` (25)                    |    30,838 |      30,838 |     0 |
| measured `total` (payload + excluded) |   638,693 |     638,885 |  +192 |
| — excluded `.tsbuildinfo`             |   128,936 |     129,128 |  +192 |
| packed tarball `assay-cli-0.0.0.tgz`  |   138,242 | **138,235** |    −7 |

The payload is **0 Δ** and the only movement in the CLI section is `.tsbuildinfo` — TypeScript's
incremental state, excluded from the payload by definition. That is why the payload, not the `total`,
is the budget row; §3 shows the same 0 Δ for a reason that matters.

**Desktop extension — `apps/vscode/dist`** (14 files)

| Bucket                 |  `129e3ef` |      `3a86ac2` |                      Δ | Δ gzip |
| ---------------------- | ---------: | -------------: | ---------------------: | -----: |
| `host-bundle`          |     58,391 |         58,391 |                      0 |      0 |
| `webview-script`       |  3,179,889 |  **3,197,522** |            **+17,633** | +4,367 |
| — `webview/dataset.js` |  1,079,542 |      1,084,474 |                 +4,932 | +1,254 |
| — `webview/main.js`    |    672,698 |        677,627 |                 +4,929 | +1,221 |
| — `webview/worker.js`  |    654,890 |        662,662 |                 +7,772 | +1,892 |
| `test-bundle`          |     32,891 |         32,891 |                      0 |      0 |
| `duckdb-runtime`       | 34,242,586 |     34,242,586 |                      0 |      0 |
| `duckdb-extension`     |  3,865,685 |      3,865,685 |                      0 |      0 |
| `metadata`             |      1,773 |          1,773 |                      0 |     +1 |
| **total**              | 41,381,215 | **41,398,848** | **+17,633** (+0.043 %) | +4,367 |

`metadata` is stable at 1,773 B raw; its gzip moves by exactly +1 B and its brotli by +1 to +2 B
because `dist/spike-artifacts.json` embeds `generatedAt` — the caveat the second baseline documented,
now quantified by build C in §1.

**Publishable library payloads** (`files` allowlist) — all six byte-identical to `129e3ef`

| Package               | Raw (B) | Δ gzip |
| --------------------- | ------: | -----: |
| `packages/contracts`  | 259,673 |      0 |
| `packages/diff`       | 335,349 |      0 |
| `packages/domain`     | 162,888 |      0 |
| `packages/grid`       |  84,136 |      0 |
| `packages/telemetry`  | 128,926 |      0 |
| `packages/validation` | 188,904 |      0 |

**Install size** (install size, **not** bundle weight): 230,952,242 → 230,953,578 B, Δ **+1,336 B**
(+0.0006 %) — inside the band §5 states, and consistent with an unchanged lockfile: no dependency was
added, removed or upgraded in this range, so there is no install-size delta to attribute.

## 3. Attribution: build-bisected, commit by commit

Path-mapping alone is not attribution, so this round bisected instead: every commit in
`129e3ef..3a86ac2` that touches product source was **built and measured** in the worktree
(`git checkout --detach <sha>`, `rm -rf` the dists, `pnpm build --force`, `measure-bundle --json`),
and each step's delta is the row below. The 13 commits that touch no bundled source (docs, changesets,
`.changeset` metadata, `vitest.config.ts`, the e2e spec) were checked by difference: the last
source-touching commit's `targets` compare **equal** to `3a86ac2`'s.

| Commit    | Subject                                                  | What moved (raw B)                                                                                                                      |
| --------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `7f044d7` | A3/C02: phase recovery control in profile/validation     | web **+1,930** — entry JS +1,086, `ProfilePanel` +430, `ValidationPanel` +414, gzip +429                                                |
| `f4178d6` | A3/C02: drop a recovery that lands on a replaced session | web **+109** — entry JS +109, gzip +23                                                                                                  |
| `d457eec` | B1/ENG-2: typed `repair-preview-count` op                | web **+5,092** — entry JS +1,940, `lazy-worker` +3,152; desktop **+17,633** — `dataset.js` +4,932, `main.js` +4,929, `worker.js` +7,772 |
| `4de7233` | ENG-2 caller: read the count through the typed op        | web **−9,676** — entry JS −9,676, gzip −3,000                                                                                           |
| `6e7a6d2` | ENG-2: delete the host-composed repair count             | **0** — see below                                                                                                                       |
| 13 others | docs / changesets / `vitest.config.ts` / e2e spec        | **0 everywhere**                                                                                                                        |

Checks that make the table load-bearing rather than plausible:

- **The §2.4 control predicted `7f044d7` exactly.** The second baseline measured a peer's uncommitted
  A3/C02 edits in the live checkout and excluded them: "+1,930 B raw: entry JS +1,086, `ProfilePanel`
  +430, `ValidationPanel` +414". Those commits then merged, and this round's bisect reproduces
  **+1,930 / +1,086 / +430 / +414** to the byte. A future round should treat an unexplained mismatch
  against a recorded control as a failed round, not as noise.
- **`6e7a6d2` is 0 Δ for a verified reason.** It deletes `repairAffectedCountSql` (and its parity
  test) from `apps/web/src/edit/repair/preview-sql.ts`. At `4de7233` that symbol's only remaining
  references are test files (`grep -rn repairAffectedCountSql apps/web/src` → 16 hits, all
  `*.test.ts(x)` except the definition), so the emitted entry bundle had already dropped it. The
  deletion is a source-hygiene commit by construction; 0 Δ is confirmation, not a missed measurement.
- **ENG-2 does _not_ reach the CLI payload, contrary to the brief's expectation.** R-11's brief
  expected `recovery` — `lazy-worker` and the CLI payload — to move with `d457eec`. `lazy-worker` did
  (+3,152); the CLI payload did **not** (0). Cause: `apps/cli/src/node-executor.ts` imports
  `@assay/engine-duckdb/node` as a **runtime specifier**, so `apps/cli/dist` keeps the import and the
  new code lands in `packages/engine-duckdb/dist`. Verified directly: `grep -rl repairPreview
apps/cli/dist --include=*.js` → no file, and the 25 emitted `.js` are byte-identical in size.

## 4. What the table cannot see: the private engine package

`packages/engine-duckdb` is **private**, so it is not a publishable payload and doc 10 §8 does not
measure it. Its emitted allowlist-equivalent bytes moved **4,401,102 → 4,420,251 B** (+19,149) across
this range, and that whole delta is invisible in §2: only the bundled copies show up, as
`lazy-worker` +3,152 and the three desktop webview scripts +17,633.

This is a **coverage gap of the measurement, recorded not fixed** — changing the bucket set would
break comparability (§2.5(1)), and R-11's stop rule forbids changing the script or the definitions.
It matters for budgeting in one direction only: a future engine-side row can add tens of kilobytes
that no candidate bucket in §7 accounts for. The cheap remedy, if the maintainer wants it, is a
fourth data point measured by a _new_ section in a later record, not an edit to this one.

## 5. The two non-reproducible rows — tolerance statement (exact wording)

> **Tolerance statement.** Two rows in this measurement are not portable and are excluded from
> budgeting. **(a) Install size** is quoted only as a band: across two installs of the same lockfile at
> the same commit, at most **12 of 31** names moved, each by **≤ 357 B**, with a net total of
> **≤ ± 1.4 kB on 230.95 MB (± 0.001 %)**. The cause is identified rather than assumed: every mover is
> a `node_modules/.bin` shim file _inside_ an installed dependency directory, whose bytes encode an
> install-root-relative path — three of `typescript-eslint`'s shims differ by exactly **119 B** each
> (7 × the 17-character difference between the two checkout paths: `/home/howt/work/dataworkbench` vs
> `/tmp/wt-attr`), `eslint-plugin-react-hooks` moves by 2 × 119, and `vitest`'s / `vite`'s shims move in
> the _opposite_ direction, so the amount is a per-package function of the resolved path form, not of
> dependency content. **(b) The CLI tarball** is quoted only when **both** sides are re-packed with
> `pnpm --filter @assay/cli pack --pack-destination <dir>`; at this commit two packs in the same
> checkout and one pack from an independent checkout produced **byte-identical** archives (138,235 B,
> `sha256 c02bcf628217615e77e1fc09773c319499ae8b104fae9348ba825071ee18dfc4`), so a single-sided
> tarball number is treated as **invalid**, not as noise.

Evidence for (a), this run — main checkout vs independent worktree, **same commit, same lockfile**:

| Quantity          | Value                                                                                                                                                                                                                                                                             |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Names compared    | 31                                                                                                                                                                                                                                                                                |
| Names that moved  | 12                                                                                                                                                                                                                                                                                |
| Per-name movement | `typescript-eslint` +357, `vitest` −274, `eslint-plugin-react-hooks` +238, `vite` +186, `tsx` / `@vscode/test-electron` / `@changesets/cli` / `@axe-core/playwright` / `@vitejs/plugin-react` / `@playwright/test` / `@vitest/coverage-v8` +119 each, `eslint-plugin-import-x` −4 |
| Net total         | +1,336 B on 230,952,242 B (+0.0006 %)                                                                                                                                                                                                                                             |
| Absolute swing    | 1,892 B                                                                                                                                                                                                                                                                           |

This reproduces the second baseline's finding (12/31 names, ±56–400 B, net +76 B, ~1.2 kB swing) and
replaces its "root cause not established" with the shim explanation above. **Recommendation:
exclude the install-size row from budgeting** (the option §2.5(3) allows) rather than re-normalise it
— re-normalising needs a script change, which would invalidate comparability with the two rounds
already on file.

Evidence for (b): three packs, one file — same size, same sha256. `pnpm pack` normalises archive
metadata, so the tarball is deterministic for a fixed built tree; the earlier record's caution was
about it being a **one-off** measurement, and the fix is to pack both sides, which is now shown to be
exact rather than approximate.

Still true and unchanged from the second baseline (they do not affect any bucket total):

- `apps/vscode/dist/spike-artifacts.json` embeds `generatedAt` → a byte-level `dist/` diff across
  builds always shows it. Raw size is stable at 879 B; **its brotli size moves ±1 B** and its gzip
  287 B did not move in the four builds observed (§1's build C is the flip). This is why no candidate
  ceiling in §7 uses a compressed number.
- esbuild writes relative source-path comments into the unminified webview bundles, so
  `apps/vscode/dist` bytes depend on the build's working directory. Only the package-script `cwd`
  (`pnpm build`) is comparable; `apps/vscode/dist` builds from a _different checkout root_ are
  comparable (verified — the worktree matches the main checkout byte for byte), a root-level
  `node apps/vscode/scripts/build.mjs` invocation is not.
- `pnpm measure:bundle --json` prefixes a banner line; call `node scripts/measure-bundle.mjs --json`
  directly for machine consumption.

## 6. Stable-round verdict against the §2.5 conditions

| §2.5 condition                                                             | Verdict                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (1) same invocation and artefacts, same host class/OS, lockfile-identical  | **HOLDS** — §0: `build --force` + package-script `measure:bundle`, lockfile untouched, one host/OS.                                                                                                                                                                               |
| (2) reproduced buckets, deltas attributable to named commits, pins **0 Δ** | **HOLDS** — §3: all 6 source-touching commits built and bisected, 13 remaining commits contribute 0, no unattributed movement. Pins: `lazy-wasm` 73,605,237, `duckdb-runtime` 34,242,586, `duckdb-extension` 3,865,685, `test-bundle` 32,891, `metadata` 1,773 raw — **all 0 Δ**. |
| (3) a stated tolerance for the tarball and install-size rows               | **HOLDS** — §5 states both in full, with the install-size root cause identified and the tarball shown reproducible when both sides are packed.                                                                                                                                    |
| (4) two consecutive rounds, no free-floating number                        | **HOLDS** — rounds 2 (`129e3ef`) and 3 (`3a86ac2`) both satisfy (1)–(3), and both are reproduced in this environment (§1).                                                                                                                                                        |

**Verdict: two consecutive stable rounds are on file.** Budget candidates may now be proposed; they
are not set, and nothing in this record is a gate.

**Mutation drill (the round's own falsifiability check).** Two arbitrary mutations to the built
output, both restored byte-for-byte:

1. appended 1 byte to `apps/web/dist/assets/PipelinePanel-*.js` (25,627 → 25,628): `lazy-chunk`
   74,498 → **74,499**, web total 76,616,593 → **76,616,594** — the report reads disk, and a 1-byte
   artefact change is visible at bucket and total level.
2. appended 1 byte to a **pinned** artefact, `apps/web/dist/assets/duckdb-eh-*.wasm`
   (34,242,586 → 34,242,587): `lazy-wasm` 73,605,237 → **73,605,238** — the pin rows of §2 are
   measured, not asserted, so their 0 Δ is evidence.

Both restores re-measured byte-identical to the recorded report (`cmp`; no rebuild between the drill
and its restore, so that comparison is exact rather than luck), so the tables above describe the tree
as committed, not the drilled one.

## 7. Budget candidates — proposed, **not adopted**, not wired

Set from **observed movement across three rounds**, never from a single sample (doc 10 §12's rule).
Rule used, stated so it can be argued with:

> **Candidate ceiling = the highest value observed in the three rounds + the largest single-round
> movement observed in those rounds, rounded up to the next 100 B.** The second term is the honest
> headroom a legitimate feature row has already spent; the first is the current high-water mark. A
> candidate is an **alert threshold for a review**, not a CI failure: crossing it means "re-baseline
> with attribution, or the maintainer decides", never "BREAKING".

| Bucket                                    |              `06d8e20` |  `129e3ef` |  `3a86ac2` | Largest single-round movement | **Candidate ceiling** |
| ----------------------------------------- | ---------------------: | ---------: | ---------: | ----------------------------: | --------------------: |
| `static-entry` (boot cost)                |              1,015,562 |  1,025,224 |  1,018,683 |               +9,662 (0.95 %) |   **1,034,900 B** raw |
| `lazy-chunk` (panel code)                 |                 73,654 |     73,654 |     74,498 |                 +844 (1.15 %) |      **75,400 B** raw |
| `host-bundle` (extension host)            |                 56,720 |     58,391 |     58,391 |               +1,671 (2.95 %) |      **60,100 B** raw |
| `webview-script` (extension webview)      |              3,142,259 |  3,179,889 |  3,197,522 |              +37,630 (1.20 %) |   **3,235,200 B** raw |
| CLI `files` payload                       |                509,314 |    509,757 |    509,757 |                 +443 (0.09 %) |     **510,200 B** raw |
| **pins — not budgeted, tracked as drift** |                        |            |            |                               |                       |
| `lazy-wasm`                               |             73,605,237 | 73,605,237 | 73,605,237 |                             0 |          0 Δ required |
| `duckdb-runtime` / `duckdb-extension`     | 34,242,586 / 3,865,685 |       same |       same |                             0 |          0 Δ required |
| `lazy-worker` (engine-side; watch only)   |              1,913,474 |  1,914,091 |  1,917,243 |               +3,152 (0.16 %) |  not a candidate (§4) |

Explicitly **not** budgeted, per doc 10 §12 and §5 here: install size, the CLI tarball, the CLI
`total` row (it carries `.tsbuildinfo`), and `packages/engine-duckdb/dist` (§4 — it is invisible to
the table and needs its own measurement before it can have a number).

**What adoption would require, and what this record does not do:** no threshold is written into
`package.json`, CI, a script or a test; `measure:bundle` still exits 0 on any size. Adopting a
candidate is a maintainer decision, and the enforcement point would be a review instruction until a
remote CI exists again (it is billing-blocked — see the [entry point](20261122-remaining-work-handoffs.md) §0).

## 8. Corrections to the predecessor record (raw figures stand; one compressed figure did not)

- **`static-entry` gzip at `129e3ef`.** The second baseline records it as 279,557 B. The rebuild here
  gives **281,902 B**, which equals the sum of that bucket's nine files in the same report
  (`index-*.js` 263,211 — the record's own per-file figure — + CSS 8,772 + seven small chunks), so the
  absolute in the earlier table is short by 2,345 B; its **deltas** are internally consistent
  (`+3,148` entry JS + `+19` CSS = `+3,167`) and stand. Consequence: `06d8e20`'s `static-entry` gzip
  is 278,735, not 276,390. Raw bytes — which every candidate in §7 uses — are unaffected.
  The `document` row shows the same 1-byte compressed offset in the other direction (932 B raw; 400
  gzip here at `129e3ef` vs a recorded 399 for the same commit), which is why **compressed figures are
  quoted in this record but never used for a ceiling**.
- **The brief's ENG-2 expectation is falsified.** R-11 said ENG-2 "should move `lazy-worker` and the
  CLI payload". `lazy-worker` moved (+3,152); the CLI payload did not (0 Δ), because the CLI consumes
  `@assay/engine-duckdb/node` as a runtime specifier — §3 has the verification.
- **The build-to-build determinism claim was too strong, and the review caught it.** The first draft
  said two independent builds in one checkout produce byte-identical `--json`; that held for the pair
  built here and is **false in general**, because `spike-artifacts.json`'s embedded timestamp can flip
  its brotli size by 1 B (§1 has the third build and its hash). The determinism verdict is now scoped
  to raw bytes plus ±1 B on `metadata`; no other figure moved, and no candidate ceiling uses a
  compressed value.
- Nothing else in the predecessor record needed correcting: every other raw quantity reproduced.

## 9. Evidence limits

These are byte counts of static build output. They say nothing about parse/execute cost, memory,
startup, served transfer size, or runtime fetch order (doc 10 §1 makes the same disclaimer). No
timing was taken, so no performance claim of any kind follows from this record — the brief's stop rule
applies. The bisect builds were sequential on one host with no other workload recorded; because the
measurement is byte-deterministic (§1), concurrent load cannot move a number, but no timings were
claimed either way.

## 10. Reproduce

```bash
corepack pnpm install --frozen-lockfile
node -v && pnpm -v                 # 24.13.0 / 11.26.0
rm -rf apps/web/dist apps/cli/dist apps/vscode/dist packages/*/dist
pnpm build --force                 # 12/12 tasks, 0 cached
node scripts/measure-bundle.mjs --json > /tmp/m1.json
node scripts/measure-bundle.mjs --json > /tmp/m2.json
cmp /tmp/m1.json /tmp/m2.json      # byte-identical (same built tree)
# a REBUILD may differ by ±1 B brotli on desktop 'metadata' (spike-artifacts.json generatedAt):
# compare raw figures and bucket totals, not the whole-file hash, across builds.
pnpm exec vitest run --project node scripts/measure-bundle.test.mjs   # 17 passed, unmodified

# the per-commit attribution (§3) — one build per source-touching commit
git worktree add --detach /tmp/wt-attr 129e3ef
(cd /tmp/wt-attr && corepack pnpm install --frozen-lockfile)
for sha in 129e3ef 7f044d7 f4178d6 d457eec 4de7233 6e7a6d2; do
  (cd /tmp/wt-attr && git checkout --detach "$sha" -q \
     && rm -rf apps/web/dist apps/cli/dist apps/vscode/dist packages/*/dist \
     && pnpm build --force && node scripts/measure-bundle.mjs --json > "/tmp/j-$sha.json")
done

# the tarball row (§5) — pack both sides
pnpm --filter @assay/cli pack --pack-destination /tmp/pack-a
pnpm --filter @assay/cli pack --pack-destination /tmp/pack-b
sha256sum /tmp/pack-a/*.tgz /tmp/pack-b/*.tgz
```

## 11. Gates run for this item (own run, this tree)

`pnpm build --force` 12/12 (0 cached) · `pnpm measure:bundle` exit 0 · two-run and two-build
`--json` `cmp` byte-identical · `pnpm exec vitest run --project node scripts/measure-bundle.test.mjs`
**17 passed**, file untouched · `pnpm format:check`, `pnpm docs:links:check`, `pnpm adr:index:check`,
`pnpm current-state:check`, `pnpm assurance-map:check` — recorded in the closing ledger entry. No code
or config changed, so typecheck/lint/test are unaffected by this record; the merged-tree suite was run
separately and its tails are in the ledger (successor queue §10).

## 12. Done-when, restated

- Two consecutive stable rounds on file with attribution and tolerance — **yes** (§3, §5, §6).
- A budget-candidate table, or an honest not-yet verdict — **yes, candidates** (§7), labelled
  "candidate — not adopted", with the adoption decision left to the maintainer.
- Nothing wired, nothing weakened, no bucket definition or script touched — **yes**.
