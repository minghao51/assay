# Project Start Checklist

Updated 2026-09-14 after the repository bootstrap (see `../reviews/2026-09-14-documentation-and-setup-review.md`). Checked items are complete; remaining items are next actions.

## Before First Feature PR

- [x] Create pnpm/Turborepo monorepo.
- [x] Create `apps/web`, `apps/vscode`, `apps/cli`.
- [x] Create core packages from `../engineering/05-repository-structure.md`.
- [x] Add TypeScript project references/path aliases. _(Source-export packages with `moduleResolution: bundler`; revisit as buildable packages when needed.)_
- [x] Add ESLint/formatter policy.
- [x] Add Vitest.
- [x] Add Playwright.
- [x] Add GitHub Actions for typecheck, lint, unit tests, build.
- [x] Add ADR link in root README.
- [x] Add fixture directory.
- [x] Define `DataSource`, `DataEngine`, and `GridDataProvider` interfaces.
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
