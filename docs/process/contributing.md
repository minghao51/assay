# Contributing to Assay

This document covers developer setup, commands, conventions, and process. For product direction see [`../product/00-roadmap.md`](../product/00-roadmap.md); for the current delivery plan see [`../product/03-execution-roadmap.md`](../product/03-execution-roadmap.md).

## Prerequisites

- Node.js ≥ 22 (see `.node-version`; the repo currently develops on Node 24)
- pnpm ≥ 10 (`corepack enable` provides it automatically via `packageManager`)

## Setup

Install dependencies and start the dev server with the root scripts `pnpm install` and
`pnpm dev`. The full command table (install, dev, build, gates, e2e, format, changeset,
fixture regeneration) is owned by [AGENTS.md § Commands](../../AGENTS.md#commands).

### Why `pnpm test` builds the CLI first (and stays outside the Turborepo graph)

The root `test` script is `pnpm exec tsc --build apps/cli/tsconfig.build.json && vitest run`. The CLI
integration tests spawn the **compiled** CLI (`apps/cli/dist/index.js`), so the build must complete
before vitest starts. This pre-build deliberately stays in the root script rather than becoming a
Turborepo `test` task: there is no per-package test script — vitest runs **once** at the repo root
over all workspace packages — so wiring a `turbo run test` graph would add per-package `test`
scripts and a task for a single root invocation, with no caching or parallelism benefit. The e2e
specs run the CLI from source (`node --import tsx src/index.ts`); `pnpm build` compiles the bin for
the verify lane regardless. Keep the pre-build in the root script; if the CLI ever gains
per-package tests, revisit this decision.

## Repository layout

See [`../engineering/03-repository-structure.md`](../engineering/03-repository-structure.md) for the authoritative layout and package responsibilities. In brief: `apps/` (web, cli, vscode placeholder), `packages/` (16 domain-to-testing packages), `fixtures/` (golden datasets, see `fixtures/README.md`), and `docs/`.

## Dependency rules (enforced by lint where practical)

- `domain` must not import React, browser APIs, or any engine. Keep it portable types and pure logic.
- Dependency direction: `apps → ui/core → domain`, and `core → engine interfaces → engine implementations`.
- Shared behavior is validated through **conformance suites** in `packages/testing` — every `DataEngine` implementation, every `DataSource` adapter, and every contract adapter passes the same suite.
- Never introduce a dependency on dbt/SQLMesh/Dagster runtimes inside `packages/pipeline` (ADR 0031/0032).

## Conventions

- **TypeScript**: strict mode is non-negotiable (see `tsconfig.base.json`). No `any` without a comment explaining why.
- **Formatting**: Prettier (no semicolons, single quotes, 100 cols). Formatting is not review content — run `pnpm format`.
- **Commits**: Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `perf:`).
- **Tests**: every bug fix for a dataset-shape issue adds a minimal golden fixture + regression test (docs `04-testing-security-quality.md` §3).
- **Privacy**: never add telemetry that includes dataset contents, filenames where sensitive, raw SQL results, cell values, or PII (ADR 0025).

## Architecture Decision Records

Durable decisions (technology choices, boundary changes, model semantics) are recorded as ADRs in `docs/adr/`:

1. Copy [`../adr/template.md`](../adr/template.md) to `docs/adr/NNNN-short-name.md` (next free number, four digits).
2. Fill in Status (Proposed), Context, Decision, Consequences.
3. PR it; once accepted, flip Status to Accepted and add a row to `docs/adr/README.md`.

If a core document and an ADR conflict, the ADR wins and the document must be updated in the same PR.

## Release and versioning

- Publishing is **npm-only** (decision D10). Since ar-5 (2026-09-23, ADR 0042) the five pure libraries (`@assay/domain`, `@assay/contracts`, `@assay/validation`, `@assay/diff`, `@assay/grid`) and the CLI are publish-ready — `0.x.y`, no longer `private`, compiled via tsc project references with a pack/consumer smoke harness. The remaining 11 packages stay private workspaces; nothing publishes until the npm org claim (manual-actions, pre-G0).
- **Changesets** manage package versions: run `pnpm changeset` in a PR that changes a workspace package and describe the change (patch/minor/major). `pnpm version-packages` consumes changesets and writes per-package changelogs.
- Product-level narrative changes go into the root [`CHANGELOG.md`](../../CHANGELOG.md) (Keep a Changelog format).
- The publishing workflow (npm publish, tags, GitHub Releases) lands with the first tagged release — the npm org claim is the remaining gate (roadmap §6, manual-actions).

## Review gates before implementing

Before starting work on editing, validation, collaboration, enterprise access, or pipelines, re-read the ADR-gate map in [`project-start-checklist.md`](project-start-checklist.md) and check the [handoff](handoff.md) §6 index for in-flight queues. They exist to prevent re-litigating settled decisions in code.
