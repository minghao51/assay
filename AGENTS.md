# AGENTS.md

Guidance for AI coding agents working in this repository. Read this before
making changes. Human contributors: see [CONTRIBUTING.md](CONTRIBUTING.md).

## What this project is

**Assay** — the local-first data workbench (inspect, validate, compare,
repair, transform, govern Parquet/JSONL/JSON/CSV/Arrow). **MVP complete
(M0–M6, 2026-09-21); post-MVP track underway** (PT-0 launch readiness to G0;
VS Code/pipeline/hardening tracks — see
[docs/product/04-post-mvp-track.md](docs/product/04-post-mvp-track.md)).
TypeScript + DuckDB-WASM + Arrow; browser-native; **data never leaves the
user's machine by default**.

> Historical note: docs written before 2026-09-14 call this product "Data
> Workbench" — same product (ADR 0039).

## Working as part of an agent team

If you are one of several agents (or sessions) working this repo, follow the
**multi-agent operating model** in `docs/process/handoff/operating-model.md`: orchestrator
dispatches tasks from §6, workers execute one task with full verification,
an independent reviewer applies the definition-of-done checklist. Never both
implement and approve the same change.

## Sources of truth (read before non-trivial work)

1. `docs/process/handoff.md` — current state, decision ledger, environment
   quirks, and the concrete next tasks (active queues live in
   `docs/process/handoff/<yyyymmdd>-*.md`). Start here.
2. `docs/product/03-execution-roadmap.md` — what to build next, gates, risks,
   and the **decision backlog (§7)**: never re-decide something recorded there
   or in an ADR.
3. `docs/adr/README.md` — architecture decisions. If a doc and an ADR
   conflict, the ADR wins; update the doc in the same PR.
4. `docs/engineering/03-repository-structure.md` — package layout and
   dependency rules.
5. `docs/product/02-mvp-scope-and-acceptance.md` — in/out of MVP scope.

## Commands

| Command                                      | Purpose                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `pnpm install`                               | Install everything (Node ≥ 22, pnpm via corepack)                                           |
| `pnpm dev`                                   | Web app dev server                                                                          |
| `pnpm typecheck` / `pnpm lint` / `pnpm test` | Gates — all must pass                                                                       |
| `pnpm build`                                 | Build buildable packages                                                                    |
| `pnpm test:e2e`                              | Playwright (needs `pnpm build` first; browsers via `pnpm exec playwright install chromium`) |
| `pnpm format`                                | Prettier — do not hand-format code                                                          |
| `pnpm changeset`                             | Record a releasable change (with PRs that change packages)                                  |
| `bash fixtures/parquet/generate.sh`          | Regenerate Parquet golden fixtures (needs DuckDB CLI)                                       |

## Hard rules

- **Privacy:** never add telemetry containing dataset contents, filenames
  where sensitive, raw SQL results, cell values, or PII (ADR 0025). Telemetry
  is opt-out (ADR 0037) — any new telemetry needs a disclosure and opt-out
  path.
- **Security:** never invent cryptographic primitives (ADR 0007); treat
  dataset values as untrusted content (no HTML/script execution from cells,
  formula-injection-safe CSV export).
- **Dependency direction (lint-enforced — encoding completed 2026-09-28 by AU-2 f-4):**
  `apps → ui/core → domain`; `domain` must never import React, browser APIs, or engines —
  and `packages/domain` src is a **dependency-free zone** (zero external imports, dev
  deps included; enforced by `import/no-extraneous-dependencies`). Packages must not
  import apps (enforced in **every** package block — relative `**/apps/*` specifiers
  included, no shadowing); `core` carries the same UI/engine/app bans as
  `domain`/`grid`. `packages/pipeline` must not depend on dbt/SQLMesh/Dagster
  runtimes (ADR 0031/0032).
- **Editing model:** immutable formats (Parquet) are edited via overlay, never
  in-place mutation (ADR 0012). Row identity is logical (ADR 0011).
- **ADRs:** durable decisions get an ADR (copy `docs/adr/template.md`, next
  free number). Never rewrite or renumber accepted ADRs.
- **Fixtures:** every dataset-shape bug fix ships a minimal golden fixture +
  regression test. Never commit real/sensitive data. Regenerate Parquet
  fixtures deliberately via the script; verify `manifest.json` checksums.
- **License:** the repo is AGPL-3.0-or-later (ADR 0036). Do not add
  dependencies whose licenses are incompatible with AGPL for core code.
- **Commits:** Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`…).
- **TypeScript:** strict; no `any` without an explanatory comment.

## Where things live

```text
apps/{web,cli,vscode}     web + cli real; desktop VS Code slice 2 closed 2026-10-19
                          (viewing, session editing, validation, confirmed-key
                          diff with CLI agreement, Git context, export)
packages/domain           portable domain types (pure; real)
packages/engine           DataEngine target interface retained per D13; compatibility pins
                          record the relationship to the real engine-duckdb client
packages/engine-duckdb    the real engine (DuckDB-WASM in a Web Worker)
packages/engine-parquet   scaffold (post-MVP track owns any Parquet-native engine)
packages/grid             headless grid model; rendering is replaceable (ADR 0022)
packages/{validation,diff,contracts,data-sources,testing}   real
packages/{pipeline,telemetry}                            real (P1–P3 + local DCR; allowlisted telemetry)
packages/{core,ui,transforms,security,ai}                 scaffolds (post-MVP/gated tracks own them)
fixtures/                 golden datasets; parquet/ generated via DuckDB script
docs/                     product / architecture / engineering / process / reviews / adr
.changeset/               changesets config
```

## Definitions agents often confuse

- **M-milestones** (M0–M6 = the MVP, complete; the former M7 VS Code surface
  is now the post-MVP **PT-V** track per D11 — older docs saying "M7" mean
  PT-V). **P-stages** (P1–P5): pipeline track. **G-gates** (G0–G4):
  investment gates — do not start gated work (hosted/enterprise) without the
  gate passing.
- **DCR** = Dataset Change Request (dataset pull-request, ADR 0014).
- **Contract** = native data contract format compiled to deterministic checks
  (ADR 0013/0026) — no embedded JS/Python in contracts.
