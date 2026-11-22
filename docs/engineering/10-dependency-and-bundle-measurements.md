# Dependency and bundle measurements (E02 baseline)

**Added:** 2026-11-21 (improvement-plan row E02 — measure before streamlining).
**Baseline commit:** `06d8e20c918ce488c4c359158358e630941cae3e` (main, after A02/A04).
**Status:** measurement baseline. **No dependency was added, removed or
upgraded for this record, and no budget is set** (see §12). Every number below
came from a local build in a scrub worktree; nothing was fetched from a registry
and nothing was published.

E02 exists because the accepted 31-name dependency review proved that no
external direct dependency has a verified behaviour-equivalent built-in or
<20-line replacement, and because installed own-package bytes are routinely
mistaken for bundle weight. This record separates the two, and pairs the numbers
with a committed manifest of what each dependency is actually used for.

---

## 1. What is measured, and what is not

| Quantity                     | Where it comes from                               | Claim it supports                                               |
| ---------------------------- | ------------------------------------------------- | --------------------------------------------------------------- |
| Browser entry/chunk bytes    | `apps/web/dist` after `pnpm build`                | static boot cost vs lazily fetched code, raw/gzip/brotli        |
| Lazy wasm/worker bytes       | the same `dist/`, separated by reference kind     | what a first paint does **not** download                        |
| CLI payload                  | `apps/cli/dist` filtered by the `files` allowlist | publishable payload bytes and contents                          |
| CLI tarball                  | one explicit `pnpm pack`, recorded below          | the artifact a consumer actually installs                       |
| Desktop extension payload    | `apps/vscode/dist` (no `.vsix` step exists)       | extension package weight and where it goes                      |
| Publishable library payloads | each package's `files` allowlist                  | per-package publish size                                        |
| Installed own-package bytes  | resolved `node_modules/<name>` directories        | **install size** of the direct dependencies — not bundle weight |
| Dependency use sites         | `docs/engineering/dependency-use-manifest.json`   | which dependency is used where, with file/line/symbol evidence  |

Explicitly **not** claimed anywhere in this document:

- **No tree-shaking claim.** Bytes are measured, not attributed to modules that
  were included or excluded. Nothing here says a chunk is minimal.
- **No runtime claims.** No parse/execute cost, memory, time-to-first-row,
  startup or fetch-order measurement. The M1 benchmark record
  ([05-m1-benchmarks.md](05-m1-benchmarks.md)) owns runtime performance.
- **No served-transfer claim.** Per-file gzip/brotli is a property of the bytes,
  not of any server configuration.
- **No e2e-harness weight.** `packages/engine-duckdb/dist` and
  `packages/data-sources/dist` are Playwright harness builds that duplicate the
  engine wasm for tests. They are excluded so shared assets are not counted
  twice.

## 2. Environment and exact commands

| Item        | Value                                                                        |
| ----------- | ---------------------------------------------------------------------------- |
| Commit      | `06d8e20c918ce488c4c359158358e630941cae3e`                                   |
| OS / arch   | linux x64 (numbers are byte counts, not timings — they are platform-neutral) |
| Node        | 24.13.0 (root `engines.node: ^24.0.0`)                                       |
| pnpm        | 11.26.0 (`packageManager` pin)                                               |
| Build tools | turbo 2.11.3, vite 8.3.0, esbuild 0.28.2, typescript 6.0.3                   |
| Compression | `zlib.gzipSync` level 6, `zlib.brotliCompressSync` quality 6 (per file)      |
| Lockfile    | `pnpm-lock.yaml` `lockfileVersion: '9.0'`, unmodified                        |

```bash
# 1. Produce the build output this record measures (a cached turbo replay is not
#    a rebuild, so the baseline was taken with --force).
rm -rf apps/web/dist apps/cli/dist apps/vscode/dist packages/*/dist
pnpm build --force

# 2. Read the output and print exactly the tables in §4–§9.
node scripts/measure-bundle.mjs
node scripts/measure-bundle.mjs --json

# 3. One-off CLI tarball (not run by the script; see §6).
pnpm --filter @assay/cli pack --pack-destination /tmp/assay-pack
```

`pnpm build --force` took 28 s wall on this host with a warm pnpm store. A cached
`pnpm build` restores identical artifact bytes but does not prove a rebuild, so
the baseline uses `--force`.

## 3. Method: static vs lazy, and how double counting is avoided

`scripts/measure-bundle.mjs` reads the emitted files and assigns **every file to
exactly one bucket**, so a chunk shared by two entries is counted once:

1. `index.html` is parsed for `<script src>`, `rel="modulepreload"` and
   `rel="stylesheet"` in document order. Those files are the entry set.
2. Each emitted JS file is searched for the emitted file names it mentions.
   Every occurrence is classified:

   | Occurrence context                     | Edge kind | Meaning                          |
   | -------------------------------------- | --------- | -------------------------------- |
   | `import … from "./x.js"`, `import "x"` | `static`  | parsed and executed at boot      |
   | `import("./x.js")`                     | dynamic   | fetched when the panel is opened |
   | `new Worker(new URL("…/x.js", …))`     | worker    | separate thread, loaded later    |
   | `new URL("…/x.wasm", …)`, plain string | url       | fetched by URL at runtime        |

   The **laziest** occurrence wins. This matters: Vite also lists a dynamic
   chunk's URL inside a `__vite__mapDeps` preload array, so a naive
   first-occurrence scan would report panel chunks as static boot cost.

3. The static bucket is the transitive closure of `static` edges from the entry
   set only. Everything else is bucketed as a lazy chunk, lazy worker or lazy
   wasm. A file that names itself nowhere is marked `unreferenced` instead of
   being guessed into a bucket by name — with one deliberate name-based
   exception: a chunk whose basename contains `worker` is a worker even when the
   reference is a plain URL string (DuckDB-WASM's own worker bundle).
4. `dist` totals are the sum of the buckets, i.e. `index.html` + every chunk and
   asset exactly once.

`gzip`/`brotli` columns are per file, of that file's own bytes. Their sums are
**not** a tarball size (no tar headers, no npm `pack` normalization) and not a
served transfer size.

## 4. Browser web app — `apps/web/dist`

20 emitted files, 76,608,859 B raw (73.06 MiB). Per-file compression of the whole
directory is **not** a transfer number: the two wasm pairs are alternatives
(§5), so a real load fetches one pair, not both.

| Bucket         | Files |    Raw (B) |   gzip (B) | brotli (B) | Share of raw |
| -------------- | ----: | ---------: | ---------: | ---------: | -----------: |
| `document`     |     1 |        932 |        399 |        294 |        <0.1% |
| `static-entry` |     9 |  1,015,562 |    278,735 |    257,356 |         1.3% |
| `lazy-chunk`   |     5 |     73,654 |     20,886 |     19,915 |         0.1% |
| `lazy-worker`  |     3 |  1,913,474 |    455,098 |    418,337 |         2.5% |
| `lazy-wasm`    |     2 | 73,605,237 | 16,491,437 | 13,000,977 |        96.1% |
| **total**      |    20 | 76,608,859 | 17,246,555 | 13,696,879 |         100% |

Static boot cost, per file:

| File                                  | Kind | Raw (B) | gzip (B) | brotli (B) |
| ------------------------------------- | ---- | ------: | -------: | ---------: |
| `assets/index-CZf9hCuj.js`            | js   | 932,605 |  260,063 |    239,686 |
| `assets/index-C7Lu6eOJ.css`           | css  |  55,874 |    8,753 |      8,298 |
| `assets/overlay-DiPZvCj_.js`          | js   |   9,386 |    2,649 |      2,523 |
| `assets/jsx-runtime-DMdw0baZ.js`      | js   |   9,559 |    3,628 |      3,501 |
| `assets/save-destination-DVNEpaig.js` | js   |   2,826 |    1,278 |      1,160 |
| `assets/literals-1vN-wlYG.js`         | js   |   2,669 |    1,111 |      1,047 |
| `assets/issues-3tNlIn8S.js`           | js   |   1,372 |      605 |        566 |
| `assets/diff-plan-wire-BbJxI8In.js`   | js   |   1,131 |      524 |        475 |
| `assets/guarded-run-DDNsz-Tr.js`      | js   |     140 |      124 |        100 |

Lazy route/panel chunks (opened on demand): `DiffPanel` 15,333 B,
`PipelinePanel` 25,627 B, `ProfilePanel` 11,271 B, `ValidationPanel` 14,808 B,
`SqlPanel` 6,615 B — 73,654 B raw / 20,886 B gzip in total.

Brotli is consistently ~7% smaller than gzip here; neither is asserted to be
served.

## 5. Lazy assets, separated: workers and wasm

| Asset                                          | Role                                |    Raw (B) |  gzip (B) | brotli (B) |
| ---------------------------------------------- | ----------------------------------- | ---------: | --------: | ---------: |
| `assets/worker-DgybM4mz.js`                    | the app's engine worker bundle      |    296,071 |    70,975 |     66,353 |
| `assets/duckdb-browser-eh.worker-hQa-dcAV.js`  | DuckDB-WASM `eh` worker (preferred) |    772,759 |   189,221 |    173,282 |
| `assets/duckdb-browser-mvp.worker-C9hF7LGh.js` | DuckDB-WASM `mvp` worker (fallback) |    844,644 |   194,902 |    178,702 |
| `assets/duckdb-eh-9ubY-jlA.wasm`               | DuckDB-WASM `eh` runtime            | 34,242,586 | 7,712,125 |  6,097,983 |
| `assets/duckdb-mvp-BP0pRkMH.wasm`              | DuckDB-WASM `mvp` runtime           | 39,362,651 | 8,779,312 |  6,902,994 |

**The two pairs are alternatives, not additive.** At runtime
`bundle-select.ts` asks the same capability question DuckDB-WASM's own
`selectBundle()` asks (`WebAssembly.validate` of the wasm-EH probe) and picks the
`eh` pair when it passes, the `mvp` pair otherwise (ADR 0048 / R1-A). A modern
Chromium therefore fetches 34.2 MB raw (7.35 MiB gzip) of wasm, an older engine
39.4 MB (8.38 MiB gzip). Both pairs are emitted by the build, so both are
measured; neither is boot cost.

The desktop package does **not** ship the `mvp` pair (R1-B, ADR 0048 decision 3)
— Electron's Chromium is fixed and validates wasm EH — which is why the desktop
wasm figure in §7 is exactly the `eh` figure above.

## 6. CLI — `apps/cli/dist` and the tarball

`apps/cli/package.json` publishes only `dist/**/*.js`, `*.js.map`, `*.d.ts`,
`*.d.ts.map`. The whole directory also contains `.tsbuildinfo`, which is build
metadata and stays out of the package.

| Quantity                      | Files |     Raw (B) |    gzip (B) |  brotli (B) |
| ----------------------------- | ----: | ----------: | ----------: | ----------: |
| `dist/` (everything)          |   101 |     638,250 |     185,698 |     176,577 |
| **`files` allowlist payload** |   100 | **509,314** | **153,920** | **146,543** |
| excluded (`.tsbuildinfo`)     |     1 |     128,936 |           — |           — |

Payload contents: `.js` 25 files / 245,340 B, `.js.map` 25 / 157,803 B, `.d.ts`
25 / 75,333 B, `.d.ts.map` 25 / 30,838 B.

The published tarball, measured once with
`pnpm --filter @assay/cli pack --pack-destination /tmp/assay-pack`:

| Quantity              | Value                                                                         |
| --------------------- | ----------------------------------------------------------------------------- |
| `assay-cli-0.0.0.tgz` | **138,019 B** compressed, 626,176 B uncompressed                              |
| Entries               | 103 = 100 allowlisted `dist` files + `package.json` + `LICENSE` + `README.md` |
| Compression ratio     | 78%                                                                           |

`pnpm measure:bundle` does **not** produce a tarball: it must not pack, install,
download or publish, so the repeatable number it prints is the 509,314 B
allowlist payload. The 138,019 B tarball is a recorded one-off with the exact
command above; reproducing it needs `pnpm pack` (a pack step, no registry read
observed), which is deliberately outside the measurement script.

## 7. Desktop extension — `apps/vscode/dist`

There is no `.vsix` packaging step in this repository (`apps/vscode` has no
`vsce`/`vsce package` script and no `files` allowlist), so `dist/` **is** the
payload under measurement. 14 files, 41,341,914 B raw (39.43 MiB).

| Bucket             | Files |    Raw (B) |  gzip (B) | brotli (B) | Contents                                                                                   |
| ------------------ | ----: | ---------: | --------: | ---------: | ------------------------------------------------------------------------------------------ |
| `host-bundle`      |     2 |     56,720 |    13,650 |     12,747 | `extension.cjs` 53,246, `cli-agreement.cjs` 3,474                                          |
| `webview-script`   |     4 |  3,142,259 |   660,347 |    608,626 | `dataset.js` 1,053,371, `main.js` 660,188, `worker.js` 655,941, DuckDB `eh` worker 772,759 |
| `test-bundle`      |     2 |     32,891 |     8,792 |      8,358 | `e2e-test.cjs`, `spike-test.cjs` — test entries, not shipped code                          |
| `duckdb-runtime`   |     1 | 34,242,586 | 7,712,125 |  6,097,983 | vendored `duckdb-eh.wasm`                                                                  |
| `duckdb-extension` |     2 |  3,865,685 |   899,847 |    727,790 | `parquet.duckdb_extension.wasm` 3,045,039, `json.duckdb_extension.wasm` 820,646            |
| `metadata`         |     3 |      1,773 |       809 |        723 | `vendored-assets.json`, `spike-artifacts.json`, `probe.json`                               |
| **total**          |    14 | 41,341,914 | 9,295,570 |  7,456,227 |                                                                                            |

Notes that matter for a future packaging step (not done here):

- 82.8% of the payload is the vendored DuckDB runtime; a `.vsix` would be
  dominated by it.
- The two `*-test.cjs` bundles (32,891 B) are e2e/spike entries that sit in
  `dist/`. A packaging step would need to exclude them; today they are only
  reachable from the test harness, so they are bucketed separately rather than
  counted as shipped code.
- `webview/dataset.js` and `webview/main.js` are separate esbuild bundles for the
  dataset surface and the spike harness; they are not a shared chunk.

## 8. Publishable library payloads

`files` allowlist payload of every non-private workspace package (the CLI has its
own row in §6):

| Package               | Files | Raw (B) | gzip (B) |
| --------------------- | ----: | ------: | -------: |
| `packages/diff`       |    68 | 332,784 |  105,534 |
| `packages/contracts`  |    44 | 259,673 |   75,325 |
| `packages/validation` |    32 | 188,904 |   58,382 |
| `packages/domain`     |    24 | 162,888 |   48,722 |
| `packages/telemetry`  |    48 | 127,653 |   45,948 |
| `packages/grid`       |    12 |  66,787 |   21,181 |

`packages/diff` is 68 files for 17 modules: 130,437 B of JavaScript, 88,099 B of
`.d.ts`, 91,735 B of `.js.map` and 22,513 B of `.d.ts.map` — source maps are 34%
of that payload. None of it is bundle weight: these packages are consumed as
TypeScript source inside the workspace (`exports` → `src/index.ts`), and only
the published artifacts carry `dist/`.

## 9. Install size (not bundle weight)

Own regular-file bytes of each direct external dependency's installed directory,
as resolved from the lockfile-consistent `node_modules`. This figure includes
typings, tests, source maps, native bindings and every published bundle variant,
**so it must never be quoted as bundle weight.**

| Package                     | Installed (B) |     | Package                   |   Installed (B) |
| --------------------------- | ------------: | --- | ------------------------- | --------------: |
| `@duckdb/duckdb-wasm`       |   144,178,808 |     | `@types/react`            |         408,108 |
| `typescript`                |    24,346,827 |     | `tsx`                     |         398,542 |
| `esbuild`                   |    11,565,963 |     | `@testing-library/react`  |         339,581 |
| `prettier`                  |     9,958,929 |     | `react`                   |         178,663 |
| `happy-dom`                 |     8,576,237 |     | `@vscode/test-electron`   |         118,150 |
| `react-dom`                 |     8,063,782 |     | `@changesets/cli`         |          90,864 |
| `apache-arrow`              |     5,308,201 |     | `@tanstack/react-virtual` |          60,900 |
| `eslint-plugin-react-hooks` |     4,100,639 |     | `turbo`                   |          58,672 |
| `eslint`                    |     2,946,272 |     | `typescript-eslint`       |          49,773 |
| `@types/node`               |     2,545,731 |     | `@axe-core/playwright`    |          49,576 |
| `vite`                      |     2,369,495 |     | `@vitejs/plugin-react`    |          49,036 |
| `vitest`                    |     1,914,376 |     | `@types/react-dom`        |          32,862 |
| `eslint-plugin-import-x`    |     1,088,020 |     | `@playwright/test`        |          30,850 |
| `@types/vscode`             |       744,874 |     | `@vitest/coverage-v8`     |          26,975 |
| `yaml`                      |       686,297 |     | `@eslint/js`              |          15,798 |
| `@duckdb/node-api`          |       651,541 |     | **total (31 names)**      | **230,954,342** |

For contrast, the browser app's static boot cost is 1,015,562 B raw (278,735 B
gzip), 0.4% of that install total, and its whole emitted `dist/` is 76,608,859 B
(33.2%). The desktop payload is 17.9%. One package (`@duckdb/duckdb-wasm`,
144 MB installed) is 62% of all install bytes and accounts for every wasm byte
and both DuckDB worker bundles measured in §5.

`@duckdb/node-api` carries a platform binding
(`@duckdb/node-bindings-linux-x64`), so this column is x64-specific and not a
portable number.

## 10. Dependency-use manifest

**Location:** [`dependency-use-manifest.json`](dependency-use-manifest.json)
(committed, machine-readable, offline).
**Derivation and check:** `scripts/dependency-report.mjs` — `--check` (default),
`--write`, `--json`, `--help`. Exit `0` clean, `1` drift, `2` usage error.

### Method

Every field except per-name intent is derived, never typed by hand:

| Field                               | Source                                                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `importer`, `section`, `declared`   | each root/workspace `package.json`                                                                                                   |
| `declaredRange`, `locked`           | `pnpm-lock.yaml` `importers:` (`specifier` + resolved `version`), `catalogs:` for `catalog:`                                         |
| `catalog` + resolved range          | `pnpm-workspace.yaml` `catalog:` block                                                                                               |
| `engines`, `peerDependencies`       | the installed package's own `package.json` (installed-metadata snapshot, no registry read)                                           |
| `useSites`                          | line-anchored scan of repository source/config files                                                                                 |
| `kind`, `rationale`, `pinRationale` | **hand-verified** in `annotations` (no file records why a dependency is kept); copied into each entry so every row is self-contained |

Use sites are recorded as `{file, line, via, symbols}` where `via` is one of
`import`, `import-type`, `dynamic-import`, `require`, `require-resolve`,
`tsconfig-types`, `module-types`, `config-string`, `script`. `module-types` is
the TypeScript resolution rule (an import of `react` is evidence for
`@types/react`, `vscode` for `@types/vscode`, `node:*` for `@types/node`), not an
invented reference. `script` matches the dependency's package name **or** its
declared `bin` names, which is how `"typecheck": "tsc --noEmit"` counts as
evidence for `typescript`.

`--check` fails when a declaration is missing from the manifest, when a manifest
entry is no longer declared, when a locked version or a stored use site changes,
when installed `engines`/`peerDependencies` differ, when an external dependency
has no annotation (so a new dependency cannot be merged without a written
reason), when a `kind` is outside the allowed set, when a per-entry copy and its
annotation disagree, and when an annotation is stale. `--write` regenerates the derived fields and preserves the annotations; it
refuses to write while any external name is unannotated.

### Current contents

| Quantity                                           | Value                                                     |
| -------------------------------------------------- | --------------------------------------------------------- |
| Entries (one per importer × declared dependency)   | **114**                                                   |
| External entries / hand-verified annotations       | **74 / 31**                                               |
| Internal `@assay/*` workspace links                | **40**                                                    |
| Importers (root + 20 workspace packages)           | 21                                                        |
| Recorded use sites (stored head; counts are exact) | 927 (`useSiteCount` sum)                                  |
| Entries with zero literal sites                    | 1 (`apps/web` → `happy-dom`, explained in its annotation) |

Kind distribution over the 31 external names: `bin` 8, `runtime` 7, `test` 7,
`config` 5, `type-only` 4. `bin` means "invoked as an executable", so the build
toolchain (`typescript`, `vite`, `turbo`, `esbuild`, `prettier`, `eslint`,
`tsx`, `@changesets/cli`) is classified by how it runs, not by what it produces.

Internal `@assay/*` entries carry the structural rationale that they are
workspace links consuming TypeScript source through `exports` under the
lint-enforced `apps → ui/core → domain` direction; they are not third-party
dependencies and need no per-name annotation.

Six names carry a `pinRationale` because an exact or range pin has a technical
reason: `@duckdb/duckdb-wasm` (SHA-256-pinned vendored assets), `@duckdb/node-api`
(tracks DuckDB CLI v1.5.5), `apache-arrow` (arrow version matched to the engine's
client), `typescript` (one compiler for all project references), `yaml` (one
parser for both document consumers), `@types/vscode` (floor equals
`engines.vscode`).

### Retained review conclusion

The accepted 31-name dependency review found **no verified behaviour-equivalent
built-in module or <20-line replacement** for any external direct dependency, and
no name reached an "equivalence proven" verdict. This record **retains that
conclusion**: the manifest's own `annotations` record each name's observed role
and it sets `reviewConclusion.status: "retained"`. Nothing was removed,
replaced or upgraded by E02, and no contrary evidence was found while deriving
the manifest.

## 11. Dependency-removal policy

A dependency may be removed only when **all** of the following hold, and the
evidence is saved (not summarised):

1. **API behaviour parity.** The replacement implements the API surface actually
   consumed at the recorded use sites — the same inputs, outputs, error
   behaviour and edge cases — demonstrated by a driver script or test that runs
   the real dependency and the candidate side by side.
2. **All consumer tests pass** without weakening an assertion, a fixture or a
   threshold (`pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`,
   `pnpm test:e2e` where the surface is browser-reachable, and the desktop
   runtime suite where the surface is desktop-reachable).
3. **Saved bundle/install/startup evidence** produced by this record's own
   commands: before/after `node scripts/measure-bundle.mjs --json` under the same
   commit, a rebuilt `dist/`, the CLI tarball size, and install size for the
   affected package. A removal claimed from installed bytes alone is not
   evidence of a smaller bundle.
4. **Peer and engine ranges are reported as the real strings**, with the locked
   version that resolves inside them — never "major version looks wrong". The
   ranges observed at this baseline: `typescript-eslint` peer
   `typescript: >=4.8.4 <6.1.0` (locked 6.0.3), `eslint-plugin-import-x` peer
   `@typescript-eslint/utils: ^8.56.0` (locked 8.70.1), `vitest` peer
   `@types/node: ^20.0.0 || ^22.0.0 || >=24.0.0` (locked 26.6.2), `react-dom`
   peer `react: ^19.3.0` (locked 19.3.0), `@vitejs/plugin-react` peer
   `vite: ^4.2.0 || ^5.0.0 || ^6.0.0 || ^7.0.0 || ^8.0.0` (locked 8.3.0),
   `@axe-core/playwright` peer `playwright-core: >= 1.0.0` (locked 1.63.0). No
   mismatch exists among the direct set today. What does exist is a **dev/prod
   line** observation: the locked tools declare `engines.node` floors such as
   `vite` `^20.19.0 || >=22.12.0`, `eslint` `^20.19.0 || ^22.13.0 || >=24`,
   `@changesets/cli` `^22.11 || ^24 || >=26`, while the product manifests still
   declare `>=22`. The selected development line `^24.0.0` satisfies every one
   of them; a contributor on Node 22.0.0–22.11.x would not. That is the A03 node
   support record's call, not a dependency-removal argument.
5. **DuckDB/Arrow upgrades are not removals.** `@duckdb/duckdb-wasm`,
   `@duckdb/node-api` and `apache-arrow` move only with (a) byte-pin
   regeneration — committed SHA-256 for the vendored wasm/worker, re-vendored
   from the new package and verified by the build; (b) offline extension
   availability for the `wasm_eh` platform (the `parquet`/`json` extension wasm
   files are vendored too); and (c) cross-surface agreement — browser, CLI and
   desktop all on the same engine/Arrow generation with their suites green. A
   "latest tag" bump satisfies none of these.
6. **Type-only and tooling dependencies are not "unused" for having no runtime
   import.** `@types/*` are consumed through tsc's module resolution; `eslint`,
   `prettier`, `turbo`, `typescript` are consumed through their binaries. The
   manifest records those sites; a zero-site entry must carry an explanation
   (today: one, `apps/web` → `happy-dom`, whose selecting string lives in the
   root `vitest.config.ts`).

No automatic upgrade job, registry probe or update bot is introduced by this
record. If an update lane is ever selected, it needs its own explicit network
disclosure and approval.

## 12. Budgets: deliberately not set

This is a single measured baseline on one host at one commit. A budget set here
would be a number with no representative history behind it, and a threshold
chosen to fit today's output would silently accept tomorrow's regression. E02
therefore records numbers only; budgets arrive after repeated stable baselines on
a stated platform, with the measurement command unchanged and the bucket
definitions above as the contract.

If budgets are later set, the defensible candidates are the buckets that a change
can move without touching the engine: `static-entry` (boot cost),
`lazy-chunk` (panel code), `host-bundle` + `webview-script` (extension code) and
the CLI `files` payload. Wasm/worker bytes are pinned artifacts and should be
tracked as pin drift, not as a budget.

**Second data point (2026-11-21).** The successor batch's measurement row re-ran this method on a
later tree and recorded the deltas against the 2026-11-20 baseline, plus the two-run determinism
verdict and the precise definition of a *stable* second baseline —
[20261121 measurement record](../process/handoff/20261121-measurement-rows-b6-c3-c2.md) §2. **No budget
is set by it**: the two passes differ by named feature work (+10,279 B raw web, +443 B CLI payload,
+39,301 B desktop), and the CLI tarball / install-size rows remain non-reproducible until they are
re-normalised as that record states.

## 13. Reproduce, and how it fails safely

```bash
pnpm build                                   # or `pnpm build --force` for a real rebuild
pnpm measure:bundle                          # human tables (§4–§9)
pnpm measure:bundle --json                   # same numbers, machine-readable
node scripts/measure-bundle.mjs --help
node scripts/dependency-report.mjs --check    # manifest drift check (not wired into pnpm scripts)
```

Exit codes for `measure-bundle`: `0` measured, `1` build output missing, `2`
usage error. When `dist/` is absent it prints the missing targets and the remedy
(`pnpm build`) instead of building anything:

```text
measure-bundle: missing build output for: web (apps/web/dist/), cli (apps/cli/dist/), desktop (apps/vscode/dist/)
This command reads existing dist/ only; it does not build.
Run `pnpm build` first, then re-run `pnpm measure:bundle`.
```

Numbers are deterministic for a given build output and Node version: no
timestamps, no ordering from the filesystem (every list is sorted), fixed gzip
level 6 and brotli quality 6. Two consecutive runs produce byte-identical
`--json` output.

`scripts/dependency-report.test.mjs` runs in the `node` vitest project, so
`pnpm test` includes the manifest drift check: a dependency declaration, lock
resolution, use site or annotation that is not reflected in the committed
manifest fails the suite. The CLI command stays available for a targeted check
and is intentionally not a `pnpm` script (the measurement command is the only
one wired in root `package.json`).

### Deliberate limits

- **Reference detection is textual.** A file name mentioned in a comment or a
  string would count as a reference; a computed URL that never spells the emitted
  name would not. Every emitted file is still listed, so a missed edge moves a
  file between buckets but cannot hide bytes.
- **Worker detection is partly name-based** (`worker` in the basename) because
  DuckDB-WASM's own worker is referenced as a URL string, not `new Worker(...)`.
- **Install size is platform-specific** where a package ships native binaries
  (`@duckdb/node-api` → linux-x64 here) and includes every published variant.
- **The CLI tarball is not reproduced by the script** (§6): the repeatable number
  is the allowlist payload.
- **No `.vsix` is produced** (§7), so the desktop number is `dist/`, not an
  installable artifact, and it currently includes two test-only bundles.
- **The manifest's use-site scan is line-anchored text, not an AST.** At most 10
  sites are stored per entry with an exact count; a dependency consumed only
  through implicit typing has no site and must say so in `annotations`.
- **Nothing here measures runtime behaviour**, and no `dist/` from another commit
  may be compared with these numbers without rebuilding (`pnpm build --force`).
