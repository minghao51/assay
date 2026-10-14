# Changelog

All notable changes to this project are documented here.

Product-level narrative changes live in this file (Keep a Changelog style).
Package version bumps are managed with [Changesets](https://github.com/changesets/changesets) —
run `pnpm changeset` alongside a PR to describe releasable changes (see
[docs/process/contributing.md](docs/process/contributing.md)).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Until the first tagged release, everything accumulates under _Unreleased_.

## [Unreleased]

### Changed — VS Code build and CI verification (2026-10-14)

- Root build includes the desktop extension/webview and checks vendored assets.
  Both real-host runners share a pinned offline-first VS Code cache; CI rejects
  executable overrides and unpinned fallback, guarded by native policy tests.
- Dedicated headless CI job enforces real-VSCode e2e and the offline exit
  harness. Local equivalents and negative drills pass; remote execution awaits
  a push. Vendored runtime bytes are excluded from formatter rewriting.

### Fixed — packed CLI dependency closure (2026-10-14)

- Metadata-derived local runtime closure includes pipeline and telemetry;
  pipeline gains compiled tsc artifacts, engine tarballs carry the nested Node
  runner graph, and CLI telemetry imports resolve under plain Node ESM.
- Installed-consumer checks cover standalone grid, validation, diff, pipeline
  execution and golden DCR bytes/refusals, without a TypeScript loader. Private
  runtime-package registry distribution remains a separate release decision.

### Docs — current-state maintenance (2026-10-14)

- Compact current-state handoff with preserved historical evidence; front-door
  docs distinguish implemented pipeline/DCR and desktop VS Code viewing from
  pending slice-2 parity. Obsolete pickup prompts are explicitly historical.
- Release/CI gaps are recorded rather than hidden by older readiness claims:
  packed CLI dependency closure needs repair and VS Code harnesses need CI.

### Added — pipeline, local DCR and desktop VS Code (2026-09-30 → 2026-10-11)

- Pipeline P1–P3: portable IR, compilation, local execution, validation/publish
  gates, materialization, preview and canonical DCR v1 generation from web/CLI.
- Desktop VS Code slice 1: supported-format read-only custom editor, offline
  vendored engine, virtualized grid and sort/filter-lite, verified in the real
  extension host. Edit/validate/diff and Git integration are still pending.

### Changed — audit round 2, AU-2 (2026-09-27)

- **CI now gates what was honor-system:** `format:check` and `adr:index:check`
  run in the verify job; the ar-5 pack-consumer smoke (packed-tarball install +
  plain-node CLI run) runs after build; the DuckDB CLI installer is a shared
  sha256-pinned composite action; Playwright gains `forbidOnly` in CI and an
  HTML reporter so failure artifacts carry a report.
- **`@assay/engine` target-compat type pin (D13 interim):** engine-duckdb's
  public types are compile-time-pinned against the `DataEngine` target
  interface — the documented compat now fails CI on drift (positive pins plus
  honest `@ts-expect-error` negatives recording the known divergences).
- **Lint:** `eslint-plugin-react-hooks` (rules-of-hooks error,
  exhaustive-deps warn) and a scoped `@assay/web`/`@assay/cli` app-import ban
  that also fixes a flat-config shadowing hole (the relative-path ban was
  silently inert for `domain`/`grid`).
- **Packaging:** `sideEffects: false` on the six library packages.
- **Docs truth pass:** D10 recorded resolved (roadmap §7), stale PT-0 queue row
  fixed, post-MVP §2/§4/§9 staleness repaired, four broken links fixed, legacy
  "docs NN" shorthand legend added, process index completed; ADR 0043
  (changesets = intake ledger until first publish) proposed.

### Fixed — post-MVP PT-0 (2026-09-24)

- Two real accessibility defects caught by the new axe-core e2e scans and fixed at the root: the
  grid's per-row actions container is now a conforming gridcell (critical
  `aria-required-children` on every scanned surface), and the filter bar's "No active filters"
  text was raised from 4.29:1 to 7.14:1 contrast (serious `color-contrast`). The scans gate CI
  with an empty deferred-findings allowlist plus a non-vacuity canary (e2e 131 → 136).

### Docs — post-MVP PT-0 (2026-09-24)

- README front door completed (pt0-3): explicit not-on-npm install truth (npm org claim M1
  pending) and a from-source CLI invocation section (`pnpm build` → `node --import tsx
dist/index.js` in `apps/cli`). Every command the README documents was execution-verified fresh
  by two independent sessions (web dev server, full gates, e2e, fixture regeneration, CLI
  `--help`/`profile`).

### Docs — documentation audit + remediation (doc queue dr-0…dr-4, 2026-09-23)

- Six-lane documentation audit (~55k words, every claim verified against tree/git/CI); remediation
  landed as five tasks: front-door/truth repairs, a one-shot per-category doc renumber (legacy-path
  redirect table in `docs/README.md`), handoff §9 converted to one-line entries with queue-row
  authority, single-ownership dedup across the doc set (one owner per topic), an ADR index generated
  from ADR headers with a drift check (`pnpm adr:index`), READMEs for the five publishable libraries
  - the CLI (pack-verified), and ADR 0013 (native data contract format) accepted.

### Whole-repo audit remediation — AR queue (2026-09-22 → 2026-09-23, ar-1…ar-6)

- **Security:** the CSV formula-injection bypass in the engine's BLOB export
  path is closed — the formula-safe guard is now total over all cell families,
  fixture-pinned (ar-1, `eec593d`).
- **Fixed:** the web cell editor could commit an edit to the **wrong row**
  after sort/filter churn; logical-row-key discipline is now enforced
  end-to-end (ar-2, `0caa73e`).
- **Hardened:** the pure packages (`@assay/domain`, `contracts`, `validation`,
  `diff`, `grid`) — literal/clone/type hardening with golden-fixture
  regressions; the fixture-manifest check is now bidirectional (ar-4,
  `cbdd433`).
- **Docs:** truthfulness sweep over the doc set (stale phase claims, dead
  pre-rename identifiers, broken pointers) (ar-3, `78b20e4`).
- **CI:** Dependabot (npm + actions) enabled and verified end-to-end (ar-6,
  `b1f1df1`).
- **Publish readiness:** the five pure libraries + the CLI compile and pack
  cleanly via tsc project references (ADR 0042) and a real installed-CLI smoke
  harness — publish-ready, not yet published (ar-5, `f3691b8`).

### Added — M6, dataset diff (m6-0…m6-5) — completes the MVP feature milestones

- **Compare any two dataset versions, honestly.** The diff always discloses in the documented
  order — **schema drift first, then distribution deltas, then key-based row diff** — so you get
  useful schema/profile change information before any row-level comparison (the product's diff
  honesty rule, made structural in both surfaces). Schema drift reuses the validation
  type-family classifier (added/removed columns, same-family vs cross-family type changes,
  nested textual drift, profile-derived nullability). Distribution deltas are deterministic
  (checkpoint C1): PSI/Jensen–Shannon over documented side-A quantile bins, standardized
  mean/variance shifts (ratio-form, exact at identity), p50/p90 shifts, categorical
  total-variation over top-k∪other with new/vanished lists — no p-value machinery.
- **Key-based row diff you can trust.** Added = B-keys anti-join, removed = A-keys anti-join,
  changed = full outer join with `IS DISTINCT FROM` per shared column and per-row
  changed-column lists; NULL keys group (`IS NOT DISTINCT FROM`); exact counts with K-bounded
  samples carrying side-qualified keys — A-side rows jump straight into the grid via the
  logical row-key channel; B-side rows are report content. Keys are never guessed: pick them,
  or confirm the deterministic C2 inference proposal (unique + non-null per profiles,
  minimal-first, evidence shown; the CLI `--infer` discloses its choice verbatim).
- **Both surfaces agree exactly.** The pure `@assay/diff` model compiles a deterministic,
  injection-safe DiffPlan (identifiers only through escaped helpers; hostile plans rejected
  before any SQL); the engine executes it byte-identically over your effective view (edits
  included) inside a rollback-contained op; the CLI gains `assay diff <a> <b>` (`--key`,
  `--infer`, `--format json`, `--sample-limit`; exit codes 0 identical / 1 differences / 2
  usage-or-binding). The M6 exit journey proves the web panel's exported report and the CLI
  JSON agree field-for-field on every schema-drift finding, every column's drift metrics, and
  every row-diff count and sample — asserted, not sampled — with an honest zero-state for
  identical files and reports that never name your files.

### Added — M5, validation and contracts (m5-0…m5-6)

- **Data quality contracts, end to end.** Author a contract in human-readable YAML
  (`@assay/contracts`: canonical typed AST, total parser with located errors, byte-stable
  serializer, documented 21-spelling type vocabulary, exact-or-rejected numerics) or import
  an existing JSON Schema (documented 2020-12 subset — every unsupported key is reported as
  a typed error with its JSON Pointer path, never silently dropped; non-RE2-safe `pattern`
  keys refused at import, dialect-honest). Compile it against your dataset's real schema
  (`@assay/validation`): binding errors (missing column, inapplicable type) are typed and
  collected before anything runs; identical inputs compile to byte-identical, injection-safe
  DuckDB SQL (range-qualified references, escaped literals, RE2-subset regex validation with
  a documented nesting bound).
- **Run validation on both surfaces — web and CLI agree exactly.** The engine executes the
  plan on the query lane against the effective view (your in-progress edits included):
  per-rule counts, integer half-up fail percentages, K-bounded failure samples carrying
  logical row keys that resolve to grid rows. The CLI gains `assay validate <path>
--contract <file>` (`--format json`, exit codes 0/1/2) on a Node DuckDB runtime behind a
  shared seam (ADR 0041) — the M5 exit journey proves web and CLI agree exactly on every
  rule for the same contract + file.
- **Explore and fix violations.** The web panel orders failing rules by a documented
  severity policy, lists sample failures as text with jump-to-row, filters the grid to
  failing rows (only when the sample set is complete — honest partial-set copy otherwise),
  exports the failure report as a sanitized new CSV/JSON file, and marks verdicts stale
  under editing until you re-validate. Fix violations in place via M4 editing and watch the
  verdict flip to clean.

### Added — M4, editing and transforms (m4-0…m4-6)

- **Grid editing with an immutable overlay.** Click-to-edit cells with per-type editors and
  validation, row insert/tombstone, full undo/redo history; edits never touch the source —
  the engine composes an effective view (ADR 0012) so every surface (grid, profiling,
  export, validation) sees base-plus-edits consistently, and logical row identity (ADR 0011)
  keeps rows addressable across edits.
- **Export and save-as.** Export the current view as Parquet/CSV/JSONL/JSON/Arrow through a
  save dialog or download fallback, with formula-injection-safe CSV sanitization, engine-
  numbered feedback, and re-open journeys that prove the round trip; "save as" writes to a
  new file and refuses to overwrite the opened source.
- **Milestone exit proof.** An M4 exit journey verifies open → edit → export → re-open →
  content matches byte-for-byte; an M5 journey extends the discipline to validation
  (see above).

### Added — M3, nested data (m3-0…m3-5)

- **Nested data is first-class in the explorer.** Engine-conformance pins now prove
  struct/list values survive the Arrow worker boundary exactly (NULLs at every depth;
  timestamps as epoch-ms). The grid renders **bounded, depth-aware previews** for nested
  cells (no more raw JSON walls — and never a silent truncation); the **record
  inspector** discloses a full row to any depth with per-value degradation and an
  epoch-freshness close policy. The schema tree and nested column headers offer
  **one-click Flatten / Explode / Extract-path** actions that compose exact,
  injection-probed SQL (visible verbatim in the editor) and run it in the paged result
  pane — explode keeps row context + element positions and never silently drops
  NULL-list rows. Profiling now classifies fixed-size array types robustly (fail-closed
  to `other`).

### Changed

- **Product named Assay** (D6, ADR 0039): workspace scope
  `@dataworkbench/*` → `@assay/*`, CLI banner/binary `assay`, web app
  identity, local metadata dir `.assay/`, telemetry opt-out env var
  `ASSAY_NO_TELEMETRY`. Historical docs keep "Data Workbench" wording per
  the naming-convention note in `docs/README.md`. Caveat: the unscoped npm
  name `assay` is taken; claim the `@assay` org before first publish.
- Repository scaffold switched from an accidental Python skeleton to the
  documented TypeScript monorepo (review finding C1).

### Added

- **M2 begins — sort, filter, profile (m2-1…m2-5):** the web grid gains
  **sorting and filtering** — a header toggle cycles asc→desc→cleared, a
  per-column predicate editor applies SQL fragments (`> 50000`, `= 'US'`)
  with dismissible active-filter chips, and the row count re-reads live
  under filters; windows stay bounded and virtualized. Under it, `@assay/grid`
  owns real sort/filter model state (epoch rebuild, stale-page guard) and
  `@assay/engine-duckdb` composes filtered/sorted window SQL over registered
  views with quoted identifiers (predicates are engine-SQL text — user input
  is untrusted content, never executed or rendered as markup), covered by an
  engine conformance suite with injection probes. The engine also gained
  **column profiling** (`profile()`): numeric min/max/mean/stddev +
  p50/p90/p95/p99 quantiles, categorical top-k, null/distinct counts —
  single-scan aggregates, graceful degradation on exotic types. A **SQL
  editor** runs queries against the opened table (`assay_tN` views) with
  paged results, readable errors, and cancel-as-abandonment (honest v1:
  the engine has no query interrupt yet). A **profile panel** renders the
  per-column stats with dependency-free SVG distribution charts (top-k
  bars, quantile strips), fully labeled and accessible. The engine now
  schedules ops on **two lanes** (ADR 0040): grid windows no longer queue
  behind long queries (measured: ~2.4 s stalls → ~0.2–0.6 s).

- **M1 begins — DuckDB runs in the browser (m1-1/m1-2):** `@assay/engine-duckdb`
  boots DuckDB-WASM lazily inside a dedicated Web Worker behind a typed
  postMessage protocol owned by us (ADR 0002/0021); `query()` streams via
  DuckDB's record-batch API and returns the first Apache Arrow record batch to
  the main thread, transferred zero-copy (ADR 0020) — proven end-to-end in
  Chromium via Playwright (idle-before-boot, Arrow-API assertions, multi-batch
  `hasMore` + tail-cancel reuse).
- **Local file picking (m1-3):** `@assay/data-sources` ships
  `BrowserFileSource` built from either a File System Access handle or a plain
  `File` (hidden-`<input>` fallback), with structural capability detection and
  a `pickDataFile` helper; both pick paths are proven in Chromium e2e
  (OPFS-staged genuine handles for the FSA branch — the `DataTransfer`
  synthesis trick does not work for JS-constructed files).
  DOM-naming code lives behind the `@assay/data-sources/browser` subpath so
  DOM-less importers keep type-checking the neutral root entry.
- **Open files, read windows (m1-4):** `@assay/engine-duckdb` registers a picked
  file inside the worker (engine-generated names; user strings never enter
  SQL), exposes `schema()` with DuckDB type strings passed through (incl.
  nested `STRUCT(...)`/`LIST`), and serves Arrow-backed row windows
  (`fetchRange`, validated + clamped ≤ 1000 rows, zero-copy IPC) with
  graceful async `dispose()` — proven in Chromium against checksum-pinned
  golden Parquet fixtures (first + middle windows, NULL via Arrow validity,
  failed-query reuse).
- **The grid is alive (m1-5):** `@assay/grid` owns a headless viewport model
  (zero dependencies; windowed span fetches, LRU cache, stale-epoch guard)
  and `apps/web` renders a TanStack-Virtual grid over the engine's Arrow
  windows, with file picking through the real capability-detected flow. A
  1M-row on-demand fixture (never committed) scrolls with bounded DOM
  (< 100 rows), bounded fetching (0.26% of the dataset), and median 16.7 ms
  frames in the e2e suite; the engine gained `rowCount()` for virtualization
  sizing.
- **CI guards golden fixtures (m1-8):** the CI workflow installs a
  sha256-pinned DuckDB 1.5.5, regenerates the golden Parquet fixtures, and
  fails on any drift; the e2e job installs the CLI for on-demand fixture
  generation. (CI has run remotely on GitHub Actions since 2026-09-21.)
- **Schema panel (m1-6):** the web app renders the dataset schema as a
  navigable, keyboard-accessible tree (disclosure pattern) built from a
  total DuckDB type-string parser that degrades verbatim on unknown types —
  nested `STRUCT`/`LIST`/`UNION`/`MAP` shapes expand and collapse, proven
  against the committed `nested.parquet` fixture.
- **First scale benchmark (m1-7, gate G1 evidence):** a reproducible,
  env-gated benchmark measures a 1.09 GiB / 16M-row Parquet end-to-end in
  Chromium: time-to-first-row ~0.3 s (picker→first row ~2 s), filtered
  full-scan ~2.3 s, sequential windows ~0.23 s, main-thread heap 4 MB of a
  3.6 GB limit. Numbers, methodology, and honest multi-GB extrapolation in
  `docs/engineering/05-m1-benchmarks.md`; a multi-GB re-run remains open
  before G1 sign-off.

- **Decisions recorded (2026-09-14):** AGPL-3.0-or-later license for the open
  core (ADR 0036); opt-out telemetry consent model with first-run disclosure
  and in-product opt-out (ADR 0037); DuckDB CLI as the golden Parquet fixture
  generator with committed checksum manifest (ADR 0038); changesets for
  package versioning plus this product changelog; capacity-based roadmap
  sequencing.
- `AGENTS.md` guidance for AI coding agents.
- Changesets configuration (`.changeset/`).
- `fixtures/parquet/generate.sh` — deterministic DuckDB-based Parquet fixture
  generator with `manifest.json` checksums.
- Milestone M0 — pnpm/Turborepo/TypeScript monorepo: 16 `@assay/*`
  packages, `apps/web` (Vite/React), `apps/cli`, VS Code placeholder, strict
  shared TypeScript config, ESLint with dependency-boundary rules, Prettier,
  Vitest, Playwright E2E, GitHub Actions CI (verify + e2e), golden text
  fixtures, root README/CONTRIBUTING/SECURITY.
- Canonical execution roadmap (`docs/product/03-execution-roadmap.md`) with
  phase↔milestone↔ADR mapping, decision gates G0–G4, risk register, decision
  backlog.
- Documentation reorganized into `docs/{product,architecture,engineering,process,reviews}`
  with a full index, contributing guide, ADR template, and the 2026-09-14
  documentation & setup review.
