# Data Workbench — Project Documentation

This documentation set is intended to be sufficient to start implementation while preserving the long-term product direction.

## Core Product Documents

1. `00-roadmap.md`
   - product evolution,
   - phases,
   - commercial direction,
   - strategic non-goals.

2. `01-features.md`
   - feature taxonomy,
   - local workbench capabilities,
   - validation,
   - diff,
   - governance,
   - enterprise features.

3. `02-architecture.md`
   - core architecture,
   - domain model,
   - control/data plane,
   - data engine,
   - security boundaries.

4. `03-tech-stack.md`
   - recommended stack,
   - alternatives,
   - library choices,
   - frontend/data/enterprise technologies.

5. `04-implementation-plan.md`
   - milestone sequence from repo bootstrap through enterprise gateway.

6. `05-repository-structure.md`
   - monorepo layout,
   - package ownership,
   - dependency direction,
   - conformance testing.

7. `06-testing-security-quality.md`
   - testing strategy,
   - privacy rules,
   - fuzz/property testing,
   - accessibility,
   - performance benchmarks.

8. `07-mvp-scope-and-acceptance.md`
   - MVP boundary,
   - exclusions,
   - acceptance criteria,
   - target demo.


9. `09-pipeline-dag-etl.md`
   - visual pipeline architecture,
   - SQL-first transformations,
   - portable Pipeline IR,
   - dbt/SQLMesh compatibility,
   - dlt ingestion,
   - Dagster orchestration boundary.

## ADRs

See `adr/README.md`.

The ADR series covers:

- local-first execution,
- DuckDB-WASM,
- dataset identity,
- Arrow interchange,
- worker architecture,
- grid ownership,
- edit overlays,
- contracts,
- validation compilation,
- dataset change requests,
- connectors,
- enterprise policy,
- authentication/authorization,
- encryption/KMS,
- telemetry,
- hosted control plane,
- future Rust/DataFusion gateway,
- future Tauri desktop.

## Suggested Reading Order for Implementation

```text
00-roadmap
    ↓
07-mvp-scope-and-acceptance
    ↓
02-architecture
    ↓
03-tech-stack
    ↓
05-repository-structure
    ↓
04-implementation-plan
    ↓
06-testing-security-quality
    ↓
relevant ADRs during implementation
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
              └──────────────────── DataEngine ───────────────┘
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


## Pipeline ADRs

- `0029` — SQL-first pipeline semantics.
- `0030` — owned portable Pipeline IR.
- `0031` — dbt/SQLMesh as compatibility and execution adapters.
- `0032` — transformation DAG separated from production orchestration.
- `0033` — logical materialization model.
- `0034` — ingestion separated from transformation.
- `0035` — validation and publish gates as first-class DAG semantics.
