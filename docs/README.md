# Assay — Project Documentation

This documentation set is intended to be sufficient to start implementation while preserving the long-term product direction.

## Document Index

### Product (`product/`)

| Doc                                                                                | Contents                                                                                                                                                                 |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`product/00-roadmap.md`](product/00-roadmap.md)                                   | Product vision, positioning, evolution phases 0–7, commercial model, strategic non-goals, north-star principles.                                                         |
| [`product/01-features.md`](product/01-features.md)                                 | Feature taxonomy (Understand / Validate / Compare / Repair / Prepare / Govern), surface capabilities, AI/ML dataset features, governance.                                |
| [`product/02-mvp-scope-and-acceptance.md`](product/02-mvp-scope-and-acceptance.md) | MVP boundary, exclusions, acceptance criteria, target demo scenario.                                                                                                     |
| [`product/03-execution-roadmap.md`](product/03-execution-roadmap.md)               | **Canonical execution roadmap**: phase↔milestone↔ADR mapping, delivery tracks, decision gates, risk register, open decision backlog.                                     |
| [`product/04-post-mvp-track.md`](product/04-post-mvp-track.md)                     | **Post-MVP execution track** (D11): PT-0 launch readiness to G0, PT-V VS Code, PT-P pipeline, PT-H hardening carry-overs, PT-Q QoL queue; open decisions D12/D13/C-ar-5. |

### Architecture (`architecture/`)

| Doc                                                                          | Contents                                                                                                                                                 |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`architecture/01-architecture.md`](architecture/01-architecture.md)         | Core architecture, domain model, control/data plane, engine and grid architecture, security boundaries.                                                  |
| [`architecture/02-pipeline-dag-etl.md`](architecture/02-pipeline-dag-etl.md) | Visual pipeline architecture, SQL-first transformations, portable Pipeline IR, dbt/SQLMesh compatibility, dlt ingestion, Dagster orchestration boundary. |

### Engineering (`engineering/`)

| Doc                                                                                        | Contents                                                                                                                                                       |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`engineering/01-tech-stack.md`](engineering/01-tech-stack.md)                             | Recommended stack, alternatives, library choices, frontend/data/enterprise technologies.                                                                       |
| [`engineering/02-implementation-plan.md`](engineering/02-implementation-plan.md)           | Milestone sequence M0–M11 from repo bootstrap through enterprise gateway.                                                                                      |
| [`engineering/03-repository-structure.md`](engineering/03-repository-structure.md)         | Monorepo layout, package ownership, dependency direction, conformance testing.                                                                                 |
| [`engineering/04-testing-security-quality.md`](engineering/04-testing-security-quality.md) | Testing strategy, privacy rules, fuzz/property testing, accessibility, performance benchmarks.                                                                 |
| [`engineering/05-m1-benchmarks.md`](engineering/05-m1-benchmarks.md)                       | M1 grid/engine benchmarks: 1.09 GiB/16M-row + G1-R 10.24 GiB/150M-row measurements (TTFR, picker→first-row, scan throughput, deep offsets, heap).              |
| [`engineering/06-telemetry-design.md`](engineering/06-telemetry-design.md)                 | Telemetry design (D2 tail; design-only pending C-pt0-1): 10 allowlisted metadata-only events, no free-form strings, opt-out mechanics, ADR 0025 privacy table. |

### Process (`process/`)

| Doc                                                                                    | Contents                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`process/handoff.md`](process/handoff.md)                                             | **Start here when picking up the project**: current state, decision ledger, environment quirks, definition of done, active-queue index, recent changelog. Active task queues live in dated files under [`process/handoff/`](process/handoff/) (completed queues archived there); the multi-agent protocol is [`process/handoff/operating-model.md`](process/handoff/operating-model.md). |
| [`process/handoff/20260924-open-threads.md`](process/handoff/20260924-open-threads.md) | **Open-threads pickup map** — post-audit continuation: PT-0 finish, PT-Q, Dependabot, publish-day + carry-overs, all as pointers to authoritative rows.                                                                                                                                                                                                                                  |
| [`process/project-start-checklist.md`](process/project-start-checklist.md)             | Pre-implementation checklist and architecture-review gates.                                                                                                                                                                                                                                                                                                                              |
| [`process/contributing.md`](process/contributing.md)                                   | Developer setup, commands, conventions, ADR process, dependency rules, release conventions.                                                                                                                                                                                                                                                                                              |

### Reviews (`reviews/`)

| Doc                                                                                                              | Contents                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`reviews/2026-09-14-documentation-and-setup-review.md`](reviews/2026-09-14-documentation-and-setup-review.md)   | Full documentation/setup review: strengths, findings, opportunities, open decisions.                                                                                                                                                                                                                     |
| [`reviews/2026-09-22-whole-repo-implementation-audit.md`](reviews/2026-09-22-whole-repo-implementation-audit.md) | Whole-repo implementation audit (7 lanes, all packages/apps/infra): 2 criticals, ~35 warnings with stable `AR-*` IDs; findings feed the handoff §6 AR queue and the PT-Q track.                                                                                                                          |
| [`reviews/2026-09-23-documentation-audit.md`](reviews/2026-09-23-documentation-audit.md)                         | Documentation audit (6 lanes, whole doc set): 16 truth defects, 3 contradictions, 14 duplication pairs, 10 structure findings (`DC/DX/DD/DS` IDs) + 7 maintainer decisions (`DM`); fed the doc-remediation queue (closed 2026-09-23, all five tasks merged — archived under `process/handoff/archive/`). |

### ADRs (`adr/`)

See [`adr/README.md`](adr/README.md). The ADR series (0001–0042 — 35 accepted, 7 proposed) covers local-first execution, DuckDB-WASM, dataset identity, Arrow interchange, worker architecture, grid ownership, edit overlays, contracts, validation compilation, dataset change requests, connectors, enterprise policy, authentication/authorization, encryption/KMS, telemetry, hosted control plane, pipeline IR and DAG semantics, two-op-lane engine wiring, the Node CLI backend, the product name (Assay), tsc
project-reference library builds (ADR 0042), and future Rust/DataFusion/Tauri directions. New ADRs use [`adr/template.md`](adr/template.md).

## Reading Orders

### For implementation (engineers)

```text
product/00-roadmap
    ↓
product/02-mvp-scope-and-acceptance
    ↓
architecture/01-architecture
    ↓
engineering/01-tech-stack
    ↓
engineering/03-repository-structure
    ↓
engineering/02-implementation-plan
    ↓
engineering/04-testing-security-quality
    ↓
relevant ADRs during implementation (gate map: process/project-start-checklist;
current state + live queue: process/handoff.md §2/§6)
```

### For new contributors (fastest path to a PR)

```text
product/00-roadmap (§1–2 only)
    ↓
process/contributing
    ↓
process/handoff (§0–§2 + §6 — current state, decisions, live queues)
    ↓
engineering/03-repository-structure
    ↓
process/project-start-checklist (ADR-gate map)
```

### For long-term planning

```text
product/00-roadmap  →  product/03-execution-roadmap  →  ADR index
```

## Current Architectural Summary

```text
                              Assay

                 ┌──────────── Product Surfaces ────────────┐
                 │                                           │
               Web                VS Code                  CLI
                 │                    │                       │
                 └──────────── shared TypeScript core ────────┘
                                      │
                               Domain / Use Cases
                                      │
              ┌───────────────────────┼───────────────────────┐
              │                       │                       │
          Grid Core               Validation                Diff
              │                       │                       │
              └──────────────────── DataEngine ──────────────┘
                                      │
                       ┌──────────────┴───────────────┐
                       │                              │
                 DuckDB-WASM                    parquet-wasm
                       │                              │
                       └──────── Apache Arrow ────────┘

Future enterprise:

                  Hosted Control Plane
                 TypeScript + PostgreSQL
                           │
                    policy / metadata
                           │
                    Governed Gateway
                  Rust + Axum + DataFusion
                           │
               S3 / ADLS / GCS / Lakehouse
```

## Product Principle

Assay should win on dataset understanding, validation, comparison, repair, review, and governance
rather than on rebuilding commodity infrastructure such as query engines, cryptography, storage
systems, or generic charting. The full vision statement is owned by
[product/00-roadmap.md §1](product/00-roadmap.md#1-product-vision).

## Legacy document numbering (renumbered 2026-09-23, decision DM-4b)

The pre-2026-09-14 flat `00`–`11` series survived the category reorg with cross-category
collisions. On 2026-09-23 all numbered docs were renumbered **within their category by
reading order** (`product/` keeps `00` as its entry point; `process/` drops numbers — its
files are unnumbered). Immutable records — accepted ADRs, archived queues, dated review
snapshots — intentionally still cite the legacy paths; resolve them here:

| Legacy path (cited in ADRs/archives/reviews ≤ 2026-09-23) | Current path                                 |
| --------------------------------------------------------- | -------------------------------------------- |
| `product/07-mvp-scope-and-acceptance.md`                  | `product/02-mvp-scope-and-acceptance.md`     |
| `product/10-execution-roadmap.md`                         | `product/03-execution-roadmap.md`            |
| `product/11-post-mvp-track.md`                            | `product/04-post-mvp-track.md`               |
| `architecture/02-architecture.md`                         | `architecture/01-architecture.md`            |
| `architecture/09-pipeline-dag-etl.md`                     | `architecture/02-pipeline-dag-etl.md`        |
| `engineering/03-tech-stack.md`                            | `engineering/01-tech-stack.md`               |
| `engineering/04-implementation-plan.md`                   | `engineering/02-implementation-plan.md`      |
| `engineering/05-repository-structure.md`                  | `engineering/03-repository-structure.md`     |
| `engineering/06-testing-security-quality.md`              | `engineering/04-testing-security-quality.md` |
| `engineering/07-m1-benchmarks.md`                         | `engineering/05-m1-benchmarks.md`            |
| `engineering/08-telemetry-design.md`                      | `engineering/06-telemetry-design.md`         |
| `process/08-project-start-checklist.md`                   | `process/project-start-checklist.md`         |

(`product/00-roadmap.md` and `product/01-features.md` kept their numbers.)

## Documentation Conventions

- **Naming (ADR 0039):** the product is **Assay**. Documents written before 2026-09-14 use the old descriptive name "Data Workbench" and paths like `.dataworkbench/` — they refer to the same product and to today's `.assay/` workspace. Where a pre-rename document and a newer one disagree on naming, the newer one wins.
- Numbered documents are strategic/engineering references; numbers encode reading order within their category (per-category scheme re-established by the 2026-09-23 renumber — see the legacy table above), not importance.
- Durable decisions belong in ADRs, not in these documents; when a doc and an ADR conflict, the ADR wins and the doc should be updated.
- Reviews are dated snapshots and are not living documents.
