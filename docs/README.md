# Assay — Project Documentation

This documentation set is intended to be sufficient to start implementation while preserving the long-term product direction.

## Document Index

### Product (`product/`)

| Doc                                                                                | Contents                                                                                                                                                                 |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`product/00-roadmap.md`](product/00-roadmap.md)                                   | Product vision, positioning, evolution phases 0–7, commercial model, strategic non-goals, north-star principles.                                                         |
| [`product/01-features.md`](product/01-features.md)                                 | Feature taxonomy (Understand / Validate / Compare / Repair / Prepare / Govern), surface capabilities, AI/ML dataset features, governance.                                |
| [`product/07-mvp-scope-and-acceptance.md`](product/07-mvp-scope-and-acceptance.md) | MVP boundary, exclusions, acceptance criteria, target demo scenario.                                                                                                     |
| [`product/10-execution-roadmap.md`](product/10-execution-roadmap.md)               | **Canonical execution roadmap**: phase↔milestone↔ADR mapping, delivery tracks, decision gates, risk register, open decision backlog.                                     |
| [`product/11-post-mvp-track.md`](product/11-post-mvp-track.md)                     | **Post-MVP execution track** (D11): PT-0 launch readiness to G0, PT-V VS Code, PT-P pipeline, PT-H hardening carry-overs, PT-Q QoL queue; open decisions D12/D13/C-ar-5. |

### Architecture (`architecture/`)

| Doc                                                                          | Contents                                                                                                                                                 |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`architecture/02-architecture.md`](architecture/02-architecture.md)         | Core architecture, domain model, control/data plane, engine and grid architecture, security boundaries.                                                  |
| [`architecture/09-pipeline-dag-etl.md`](architecture/09-pipeline-dag-etl.md) | Visual pipeline architecture, SQL-first transformations, portable Pipeline IR, dbt/SQLMesh compatibility, dlt ingestion, Dagster orchestration boundary. |

### Engineering (`engineering/`)

| Doc                                                                                        | Contents                                                                                                                                                       |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`engineering/03-tech-stack.md`](engineering/03-tech-stack.md)                             | Recommended stack, alternatives, library choices, frontend/data/enterprise technologies.                                                                       |
| [`engineering/04-implementation-plan.md`](engineering/04-implementation-plan.md)           | Milestone sequence M0–M11 from repo bootstrap through enterprise gateway.                                                                                      |
| [`engineering/05-repository-structure.md`](engineering/05-repository-structure.md)         | Monorepo layout, package ownership, dependency direction, conformance testing.                                                                                 |
| [`engineering/06-testing-security-quality.md`](engineering/06-testing-security-quality.md) | Testing strategy, privacy rules, fuzz/property testing, accessibility, performance benchmarks.                                                                 |
| [`engineering/07-m1-benchmarks.md`](engineering/07-m1-benchmarks.md)                       | M1 grid/engine benchmarks: 1.09 GiB/16M-row + G1-R 10.24 GiB/150M-row measurements (TTFR, picker→first-row, scan throughput, deep offsets, heap).              |
| [`engineering/08-telemetry-design.md`](engineering/08-telemetry-design.md)                 | Telemetry design (D2 tail; design-only pending C-pt0-1): 10 allowlisted metadata-only events, no free-form strings, opt-out mechanics, ADR 0025 privacy table. |

### Process (`process/`)

| Doc                                                                              | Contents                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`process/handoff.md`](process/handoff.md)                                       | **Start here when picking up the project**: current state, decision ledger, environment quirks, definition of done, active-queue index, recent changelog. Active task queues live in dated files under [`process/handoff/`](process/handoff/) (completed queues archived there); the multi-agent protocol is [`process/handoff/operating-model.md`](process/handoff/operating-model.md). |
| [`process/08-project-start-checklist.md`](process/08-project-start-checklist.md) | Pre-implementation checklist and architecture-review gates.                                                                                                                                                                                                                                                                                                                              |
| [`process/contributing.md`](process/contributing.md)                             | Developer setup, commands, conventions, ADR process, dependency rules, release conventions.                                                                                                                                                                                                                                                                                              |

### Reviews (`reviews/`)

| Doc                                                                                                              | Contents                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`reviews/2026-09-14-documentation-and-setup-review.md`](reviews/2026-09-14-documentation-and-setup-review.md)   | Full documentation/setup review: strengths, findings, opportunities, open decisions.                                                                                            |
| [`reviews/2026-09-22-whole-repo-implementation-audit.md`](reviews/2026-09-22-whole-repo-implementation-audit.md) | Whole-repo implementation audit (7 lanes, all packages/apps/infra): 2 criticals, ~35 warnings with stable `AR-*` IDs; findings feed the handoff §6 AR queue and the PT-Q track. |

### ADRs (`adr/`)

See [`adr/README.md`](adr/README.md). The ADR series (0001–0042, 42 accepted) covers local-first execution, DuckDB-WASM, dataset identity, Arrow interchange, worker architecture, grid ownership, edit overlays, contracts, validation compilation, dataset change requests, connectors, enterprise policy, authentication/authorization, encryption/KMS, telemetry, hosted control plane, pipeline IR and DAG semantics, two-op-lane engine wiring, the Node CLI backend, the product name (Assay), tsc
project-reference library builds (ADR 0042), and future Rust/DataFusion/Tauri directions. New ADRs use [`adr/template.md`](adr/template.md).

## Reading Orders

### For implementation (engineers)

```text
product/00-roadmap
    ↓
product/07-mvp-scope-and-acceptance
    ↓
architecture/02-architecture
    ↓
engineering/03-tech-stack
    ↓
engineering/05-repository-structure
    ↓
engineering/04-implementation-plan
    ↓
engineering/06-testing-security-quality
    ↓
relevant ADRs during implementation (see process/08 review gates)
```

### For new contributors (fastest path to a PR)

```text
product/00-roadmap (§1–2 only)
    ↓
process/contributing
    ↓
engineering/05-repository-structure
    ↓
process/08-project-start-checklist (remaining open items)
```

### For long-term planning

```text
product/00-roadmap  →  product/10-execution-roadmap  →  ADR index
```

## Current Architectural Summary

```text
                           Data Workbench

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

The project should win on:

> dataset understanding, validation, comparison, repair, review, and governance

rather than on rebuilding commodity infrastructure such as query engines, cryptography, storage systems, or generic charting.

## Documentation Conventions

- **Naming (ADR 0039):** the product is **Assay**. Documents written before 2026-09-14 use the old descriptive name "Data Workbench" and paths like `.dataworkbench/` — they refer to the same product and to today's `.assay/` workspace. Where a pre-rename document and a newer one disagree on naming, the newer one wins.
- Numbered documents (00–10) are strategic/engineering references; numbers encode reading order within their category, not importance.
- Durable decisions belong in ADRs, not in these documents; when a doc and an ADR conflict, the ADR wins and the doc should be updated.
- Reviews are dated snapshots and are not living documents.
