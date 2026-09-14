# Changelog

All notable changes to this project are documented here.

Product-level narrative changes live in this file (Keep a Changelog style).
Package version bumps are managed with [Changesets](https://github.com/changesets/changesets) —
run `pnpm changeset` alongside a PR to describe releasable changes (see
[docs/process/contributing.md](docs/process/contributing.md)).

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Until the first tagged release, everything accumulates under _Unreleased_.

## [Unreleased]

### Added

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
- Milestone M0 — pnpm/Turborepo/TypeScript monorepo: 16 `@dataworkbench/*`
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
