# Contributing to Data Workbench

This document covers developer setup, commands, conventions, and process. For product direction see [`../product/00-roadmap.md`](../product/00-roadmap.md); for the current delivery plan see [`../product/10-execution-roadmap.md`](../product/10-execution-roadmap.md).

## Prerequisites

- Node.js ≥ 22 (see `.node-version`; the repo currently develops on Node 24)
- pnpm ≥ 10 (`corepack enable` provides it automatically via `packageManager`)

## Setup

```bash
pnpm install        # install all workspace dependencies
pnpm dev            # start the web app (Vite)
```

Everything else runs from the repository root:

| Command                             | What it does                                       |
| ----------------------------------- | -------------------------------------------------- |
| `pnpm build`                        | Build all buildable packages/apps (Turborepo)      |
| `pnpm typecheck`                    | TypeScript check across all packages               |
| `pnpm lint`                         | ESLint across the repo                             |
| `pnpm test`                         | Unit/property tests (Vitest)                       |
| `pnpm test:watch`                   | Vitest in watch mode                               |
| `pnpm test:e2e`                     | Playwright E2E (build first; CI installs browsers) |
| `pnpm format` / `pnpm format:check` | Prettier                                           |

## Repository layout

See [`../engineering/05-repository-structure.md`](../engineering/05-repository-structure.md) for the authoritative layout and package responsibilities.

Quick orientation:

```text
apps/        web (Vite/React), cli, vscode (placeholder until M7)
packages/    domain, core, ui, grid, engine*, data-sources,
             validation, diff, transforms, contracts, security,
             ai, pipeline, testing
fixtures/    golden datasets (see fixtures/README.md)
docs/        product, architecture, engineering, process, reviews, adr
```

## Dependency rules (enforced by lint where practical)

- `domain` must not import React, browser APIs, or any engine. Keep it portable types and pure logic.
- Dependency direction: `apps → ui/core → domain`, and `core → engine interfaces → engine implementations`.
- Shared behavior is validated through **conformance suites** in `packages/testing` — every `DataEngine` implementation, every `DataSource` adapter, and every contract adapter passes the same suite.
- Never introduce a dependency on dbt/SQLMesh/Dagster runtimes inside `packages/pipeline` (ADR 0031/0032).

## Conventions

- **TypeScript**: strict mode is non-negotiable (see `tsconfig.base.json`). No `any` without a comment explaining why.
- **Formatting**: Prettier (no semicolons, single quotes, 100 cols). Formatting is not review content — run `pnpm format`.
- **Commits**: Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `perf:`).
- **Tests**: every bug fix for a dataset-shape issue adds a minimal golden fixture + regression test (docs `06-testing-security-quality.md` §3).
- **Privacy**: never add telemetry that includes dataset contents, filenames where sensitive, raw SQL results, cell values, or PII (ADR 0025).

## Architecture Decision Records

Durable decisions (technology choices, boundary changes, model semantics) are recorded as ADRs in `docs/adr/`:

1. Copy [`../adr/template.md`](../adr/template.md) to `docs/adr/NNNN-short-name.md` (next free number, four digits).
2. Fill in Status (Proposed), Context, Decision, Consequences.
3. PR it; once accepted, flip Status to Accepted and add a row to `docs/adr/README.md`.

If a core document and an ADR conflict, the ADR wins and the document must be updated in the same PR.

## Release and versioning

- All packages are `0.x.y` and `private` until publishing begins (decision D4, resolved 2026-09-14).
- **Changesets** manage package versions: run `pnpm changeset` in a PR that changes a workspace package and describe the change (patch/minor/major). `pnpm version-packages` consumes changesets and writes per-package changelogs.
- Product-level narrative changes go into the root [`CHANGELOG.md`](../../CHANGELOG.md) (Keep a Changelog format).
- The publishing workflow (npm publish, tags, GitHub Releases) is added when packages leave `private` — expected around M1–M5.

## Review gates before implementing

Before starting work on editing, validation, collaboration, enterprise access, or pipelines, re-read the ADR review gates in [`08-project-start-checklist.md`](08-project-start-checklist.md). They exist to prevent re-litigating settled decisions in code.
