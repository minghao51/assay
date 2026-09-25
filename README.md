# Assay

> Understand any dataset before your code does.

Assay is **the local-first data workbench**: inspect, understand,
validate, compare, repair, transform, review, and govern structured datasets
(Parquet, JSONL, JSON, CSV, Arrow/Feather) directly in the browser or the `assay` CLI —
with no data leaving your machine, and a long-term path toward governed data
products and an enterprise data control plane.

**Status: MVP feature milestones complete (M0–M6, closed 2026-09-21).** The
local-first core — inspect, nested data, edit, export, validate, and diff,
with exact agreement between the browser app and the CLI — works end-to-end;
the next milestone is launch readiness (PT-0 → gate G0). See the
[execution roadmap](docs/product/03-execution-roadmap.md) and the
[post-MVP track](docs/product/04-post-mvp-track.md).

**Picking the project up (handoff/onboarding)? Start with the
[project handoff](docs/process/handoff.md)** — current state, decisions,
environment setup (including quirks), and the concrete next tasks.

## Quickstart

```bash
pnpm install   # requires Node >= 22 (see .node-version); pnpm via corepack
pnpm dev       # start the web app
```

| Command                             | Purpose                                                    |
| ----------------------------------- | ---------------------------------------------------------- |
| `pnpm build`                        | Build all buildable packages/apps                          |
| `pnpm typecheck`                    | TypeScript check across the monorepo                       |
| `pnpm lint`                         | ESLint (incl. package dependency-boundary rules)           |
| `pnpm test`                         | Unit tests (Vitest)                                        |
| `pnpm test:e2e`                     | Playwright E2E                                             |
| `pnpm format`                       | Prettier                                                   |
| `pnpm changeset`                    | Record a releasable change (with PRs that change packages) |
| `bash fixtures/parquet/generate.sh` | Regenerate Parquet golden fixtures (needs DuckDB CLI)      |

## Documentation

Start at [`docs/README.md`](docs/README.md). Highlights:

- [Product roadmap (vision, phases 0–7)](docs/product/00-roadmap.md)
- [Execution roadmap (canonical sequencing, gates, risks)](docs/product/03-execution-roadmap.md)
- [MVP scope and acceptance criteria](docs/product/02-mvp-scope-and-acceptance.md)
- [Architecture](docs/architecture/01-architecture.md) · [Pipeline/DAG/ETL](docs/architecture/02-pipeline-dag-etl.md)
- [Tech stack](docs/engineering/01-tech-stack.md) · [Repository structure](docs/engineering/03-repository-structure.md)
- [ADRs](docs/adr/README.md) (42 records: 34 accepted, 8 proposed)
- [Documentation & setup review (2026-09-14)](docs/reviews/2026-09-14-documentation-and-setup-review.md)

## Repository layout

```text
apps/        web (Vite/React), cli, vscode (placeholder until PT-V)
packages/    domain, core, ui, grid, engine, engine-duckdb, engine-parquet,
             data-sources, validation, diff, transforms, contracts,
             security, ai, pipeline, testing
fixtures/    golden datasets for tests
docs/        product / architecture / engineering / process / reviews / adr
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Durable decisions are recorded as
[ADRs](docs/adr/README.md). To report a security issue privately, see
[SECURITY.md](SECURITY.md).

## License

[AGPL-3.0-or-later](LICENSE) — decision record: [ADR 0036](docs/adr/0036-agpl-license.md).
The open core is free software; hosted collaboration and enterprise surfaces
may be licensed separately (open-core model, [ADR 0010](docs/adr/0010-open-core-commercial-boundary.md)).
