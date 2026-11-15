# Architecture Decision Records

ADRs capture durable product and architecture decisions.

New ADRs are created from [`template.md`](template.md); see `../process/contributing.md` for the process.

## Conventions

- ADRs 0001–0039 predate the `Date` field: backfill dates opportunistically when an ADR is next legitimately edited — never bulk-rewrite. The same rule applies to early ADRs that lack an Alternatives section.
- Run `pnpm adr:index` before committing an ADR change; the tables below are generated from each file's H1 and Status, and `pnpm adr:index:check` fails on drift.

<!-- adr-index:begin -->

## Accepted

| ADR  | Decision                                                                                 |
| ---- | ---------------------------------------------------------------------------------------- |
| 0001 | Local-First Execution by Default                                                         |
| 0002 | DuckDB-WASM as the Initial Analytical Engine                                             |
| 0003 | The Grid Is a View, Not the Dataset                                                      |
| 0004 | Data Product Is the Primary Domain Concept                                               |
| 0005 | Separate Control Plane and Data Plane                                                    |
| 0006 | Support RBAC and ABAC with Explicit Enforcement Boundaries                               |
| 0007 | Use Standard Encryption and KMS Patterns                                                 |
| 0008 | Share Core Logic Across Web, VS Code, CLI, and CI                                        |
| 0009 | AI Proposes; Deterministic Systems Enforce                                               |
| 0011 | Dataset Identity and Versioning Are Logical, Not File-Based                              |
| 0012 | Use an Edit Overlay with Transaction-Like Semantics                                      |
| 0013 | Define a Small Native Data Contract Format with Adapters                                 |
| 0014 | Dataset Change Request Is the Primary Review Artifact                                    |
| 0017 | Local Workspace Metadata Is Portable and Human-Readable                                  |
| 0019 | React, TypeScript, and Vite for Product Surfaces                                         |
| 0020 | Apache Arrow Is the Primary Tabular Interchange Format                                   |
| 0021 | Expensive Local Computation Runs in Workers                                              |
| 0022 | Own a Headless Grid Model and Keep Rendering Replaceable                                 |
| 0024 | Separate Authentication from Authorization                                               |
| 0025 | Product Telemetry Must Exclude Dataset Contents                                          |
| 0026 | Validation Contracts Compile to Deterministic Execution Plans                            |
| 0029 | SQL Is the Canonical Transformation Target                                               |
| 0030 | Data Workbench Owns a Portable Pipeline IR                                               |
| 0031 | dbt and SQLMesh Are Compatibility and Execution Adapters, Not Core Dependencies          |
| 0032 | Separate Transformation DAG Semantics from Production Orchestration                      |
| 0033 | Materialization Is a Logical Pipeline Property                                           |
| 0034 | Ingestion Is Separate from Transformation                                                |
| 0035 | Validation and Publish Gates Are First-Class Pipeline Semantics                          |
| 0036 | AGPL-3.0-or-later for the Open-Core Repository                                           |
| 0037 | Product Telemetry Is Opt-Out                                                             |
| 0038 | Golden Parquet Fixtures Are Generated with the DuckDB CLI                                |
| 0039 | The Product Name Is Assay                                                                |
| 0040 | Two Op Lanes in the Engine Worker (Query Lane + Registry Lane)                           |
| 0041 | CLI validation runs on @duckdb/node-api behind the engine's `./node` seam                |
| 0042 | Library Builds Use tsc Project References                                                |
| 0044 | Grid-Centric Two-Pane Workbench Shell                                                    |
| 0045 | Telemetry Design Adopted (Typed Allowlisted Schema, Self-Hosted Collector)               |
| 0046 | Define a Canonical Local DCR Artifact Format (v1)                                        |
| 0047 | Web session replacement retains retired engine tables                                    |
| 0048 | The engine selects its DuckDB-WASM bundle by capability, and engine error text is honest |

## Proposed

| ADR  | Decision                                                                          |
| ---- | --------------------------------------------------------------------------------- |
| 0010 | Open-Core Local Product, Paid Collaboration and Governance                        |
| 0015 | Use Capability-Based Connectors and Plugins                                       |
| 0016 | Build a Dataset-Native Grid Layer Incrementally                                   |
| 0018 | Enterprise Policies Use a Declarative, Engine-Neutral Model                       |
| 0023 | Rust and DataFusion for the Future Governed Data Gateway                          |
| 0027 | TypeScript and PostgreSQL for the Initial Hosted Control Plane                    |
| 0028 | Tauri Is the Preferred Future Desktop Shell                                       |
| 0043 | Changesets Are the Change-Intake Ledger Until First Publish                       |
| 0049 | CSV options ride a typed allowlist on a preview op that owns its own registration |

<!-- adr-index:end -->
