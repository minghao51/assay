# Data Workbench

> Understand any dataset before your code does.

Data Workbench is a **local-first dataset workbench**: inspect, understand,
validate, compare, repair, transform, review, and govern structured datasets
(Parquet, JSONL, JSON, CSV, Arrow/Feather) directly in the browser or VS Code —
with no data leaving your machine, and a long-term path toward governed data
products and an enterprise data control plane.

**Status: pre-MVP.** Milestone M0 (repository bootstrap) is complete; the next
milestone is M1 — the local file explorer (virtualized grid + DuckDB-WASM
worker). See the [execution roadmap](docs/product/10-execution-roadmap.md).

## Quickstart

```bash
pnpm install   # requires Node >= 22 (see .node-version); pnpm via corepack
pnpm dev       # start the web app
```

| Command          | Purpose                                          |
| ---------------- | ------------------------------------------------ |
| `pnpm build`     | Build all buildable packages/apps                |
| `pnpm typecheck` | TypeScript check across the monorepo             |
| `pnpm lint`      | ESLint (incl. package dependency-boundary rules) |
| `pnpm test`      | Unit tests (Vitest)                              |
| `pnpm test:e2e`  | Playwright E2E                                   |
| `pnpm format`    | Prettier                                         |

## Documentation

Start at [`docs/README.md`](docs/README.md). Highlights:

- [Product roadmap (vision, phases 0–7)](docs/product/00-roadmap.md)
- [Execution roadmap (canonical sequencing, gates, risks)](docs/product/10-execution-roadmap.md)
- [MVP scope and acceptance criteria](docs/product/07-mvp-scope-and-acceptance.md)
- [Architecture](docs/architecture/02-architecture.md) · [Pipeline/DAG/ETL](docs/architecture/09-pipeline-dag-etl.md)
- [Tech stack](docs/engineering/03-tech-stack.md) · [Repository structure](docs/engineering/05-repository-structure.md)
- [ADRs](docs/adr/README.md) (35 decisions)
- [Documentation & setup review (2026-09-14)](docs/reviews/2026-09-14-documentation-and-setup-review.md)

## Repository layout

```text
apps/        web (Vite/React), cli, vscode (placeholder until M7)
packages/    domain, core, ui, grid, engine, engine-duckdb, engine-parquet,
             data-sources, validation, diff, transforms, contracts,
             security, ai, pipeline, testing
fixtures/    golden datasets for tests
docs/        product / architecture / engineering / process / reviews / adr
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Durable decisions are recorded as
[ADRs](docs/adr/README.md).

## License

Not yet chosen — this is open decision **D1** (see the
[execution roadmap §7](docs/product/10-execution-roadmap.md)), to be resolved
before any public release given the open-core commercial model.
