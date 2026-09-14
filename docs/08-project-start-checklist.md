# Project Start Checklist

## Before First Feature PR

- [ ] Create pnpm/Turborepo monorepo.
- [ ] Create `apps/web`, `apps/vscode`, `apps/cli`.
- [ ] Create core packages from `05-repository-structure.md`.
- [ ] Add TypeScript project references/path aliases.
- [ ] Add ESLint/formatter policy.
- [ ] Add Vitest.
- [ ] Add Playwright.
- [ ] Add GitHub Actions for typecheck, lint, unit tests, build.
- [ ] Add ADR link in root README.
- [ ] Add fixture directory.
- [ ] Define `DataSource`, `DataEngine`, and `GridDataProvider` interfaces.
- [ ] Implement one browser file source.
- [ ] Spike DuckDB-WASM worker initialization.
- [ ] Return first Arrow batch.
- [ ] Render first virtualized grid.
- [ ] Measure time-to-first-row and memory.
- [ ] Confirm no source file data leaves browser.

## First Architecture Review

Before implementing editing, review:

- ADR 0011,
- ADR 0012,
- ADR 0020,
- ADR 0022.

Before implementing validation, review:

- ADR 0013,
- ADR 0026.

Before implementing hosted collaboration, review:

- ADR 0010,
- ADR 0014,
- ADR 0027.

Before implementing enterprise data access, review:

- ADR 0005,
- ADR 0006,
- ADR 0007,
- ADR 0018,
- ADR 0023,
- ADR 0024.

## Pipeline Architecture Review

Before implementing the visual pipeline, review:

- ADR 0029,
- ADR 0030,
- ADR 0032,
- ADR 0033,
- ADR 0035.

Before implementing dbt/SQLMesh integration, review ADR 0031.

Before implementing external ingestion or orchestration, review ADR 0034 and ADR 0032.

