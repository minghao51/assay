# Changelog

All notable changes to this project are documented here.

Product-level narrative changes live in this file (Keep a Changelog style).
Package version bumps are managed with [Changesets](https://github.com/changesets/changesets) —
run `pnpm changeset` alongside a PR to describe releasable changes (see
[docs/process/contributing.md](docs/process/contributing.md)).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Until the first tagged release, everything accumulates under _Unreleased_.

## [Unreleased]

### Changed

- **Product named Assay** (D6, ADR 0039): workspace scope
  `@dataworkbench/*` → `@assay/*`, CLI banner/binary `assay`, web app
  identity, local metadata dir `.assay/`, telemetry opt-out env var
  `ASSAY_NO_TELEMETRY`. Historical docs keep "Data Workbench" wording per
  the naming-convention note in `docs/README.md`. Caveat: the unscoped npm
  name `assay` is taken; claim the `@assay` org before first publish.

### Added

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
  generation. (CI has still never run remotely — no git remote configured.)

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
- Canonical execution roadmap (`docs/product/10-execution-roadmap.md`) with
  phase↔milestone↔ADR mapping, decision gates G0–G4, risk register, decision
  backlog.
- Documentation reorganized into `docs/{product,architecture,engineering,process,reviews}`
  with a full index, contributing guide, ADR template, and the 2026-09-14
  documentation & setup review.

### Changed

- Repository scaffold switched from an accidental Python skeleton to the
  documented TypeScript monorepo (review finding C1).
