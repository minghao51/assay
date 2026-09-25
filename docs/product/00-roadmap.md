# Assay Roadmap

> **Naming + status (2026-09-23):** the product was named **Assay** on 2026-09-14 (ADR 0039);
> this document predates the rename, so "Data Workbench" below means Assay. It is the vision
> record: the phases described here as the MVP (executed as milestones M0–M6) are **complete**
> (closed 2026-09-21). Live sequencing: [`03-execution-roadmap.md`](03-execution-roadmap.md) +
> [`04-post-mvp-track.md`](04-post-mvp-track.md).

## 1. Product Vision

Data Workbench is a local-first dataset workbench that evolves into a governed data workspace and, eventually, a lightweight enterprise data control plane.

The product should make structured datasets easy to:

- inspect,
- understand,
- validate,
- compare,
- repair,
- transform,
- review,
- secure,
- govern,
- and consume.

The initial wedge is developer productivity around local data files such as Parquet, JSONL, JSON, CSV, Arrow, and Feather.

The long-term direction is a developer-first path toward governed data products with workspaces, dataset lifecycle management, access control, encryption, auditability, connectors, AI-assisted data operations, and enterprise policy enforcement.

---

## 2. Product Positioning

### Initial positioning

> Understand any dataset before your code does.

### Extended positioning

> Inspect, validate, compare, repair, transform, and govern datasets locally in the browser or VS Code.

### Long-term positioning

> A developer-first control plane for trusted, governed data products.

The product should not position itself as merely a Parquet viewer or JSONL editor. Viewing, editing, filtering, SQL, and charts are baseline capabilities.

The differentiators should center on:

1. dataset lifecycle,
2. local-first execution,
3. data quality and contracts,
4. semantic dataset diffs,
5. Git and CI integration,
6. AI/ML dataset awareness,
7. security and governance,
8. workspace collaboration,
9. controlled access to remote enterprise datasets.

---

## 3. Product Evolution

```text
Data file viewer
      |
      v
Dataset workbench
      |
      v
Dataset lifecycle
      |
      v
Data products
      |
      v
Governed workspace
      |
      v
Enterprise data control plane
```

---

## 4. Roadmap Phases

### Phase 0 — Technical Spike

Goal: prove the browser-native architecture.

Deliverables:

- DuckDB-WASM query engine.
- Apache Arrow interchange.
- Browser file handling.
- Parquet and JSONL loading.
- Virtualized grid prototype.
- Web Worker isolation.
- Basic schema inspection.
- Query result paging.
- Local-only execution verification.

Exit criteria:

- Open a multi-GB Parquet file without loading all rows into JS memory.
- Query selected columns and filters through DuckDB-WASM.
- Render large results incrementally.
- Demonstrate that source files remain local.

---

### Phase 1 — Universal Local Dataset Inspector

Goal: create the free utility developers adopt.

Capabilities: [product/01 §2–§6](01-features.md#2-understand) — the inspector (formats, grid,
nested views, schema, profiling, SQL) plus editing/repair and export.

Important constraint:

Parquet should be treated as immutable input with an edit overlay and explicit rewrite/export.

Exit criteria:

- compelling alternative to opening data files in notebooks,
- practical for daily use,
- no backend required.

---

### Phase 2 — Dataset Workbench

Goal: move from file inspection to dataset engineering.

Capabilities: [product/01 §3–§4](01-features.md#3-validate) (validation, contracts,
invalid-row explorer; dataset/row/schema/distribution diff) and
[§9.1–§9.2](01-features.md#9-dataset-level-features) (directory-as-dataset, dataset versioning).

Directory support:

```text
dataset/
├── train-00000.parquet
├── train-00001.parquet
├── validation.parquet
└── test.parquet
```

The product should understand the directory as one logical dataset.

Exit criteria:

- user can determine what changed between dataset versions,
- user can explain why a dataset is invalid,
- user can reproduce transformations.

---

### Phase 3 — Developer Workflow Integration

Goal: make dataset workflows native to software development.

Surfaces:

- web application,
- VS Code extension,
- CLI,
- CI validation.

Capabilities:

- VS Code custom editor,
- dataset-aware Git diff,
- schema diff in pull requests,
- validation in CI,
- data contract checking,
- saved SQL,
- reusable rules,
- workspace-local recipes,
- machine-readable validation reports.

Example:

```bash
dataworkbench validate dataset.parquet
dataworkbench diff baseline.parquet candidate.parquet
assay profile dataset/
```

Exit criteria:

- dataset changes can be reviewed with the same discipline as code changes.

---

### Phase 4 — AI / ML Dataset Toolkit

Goal: become especially strong for modern ML and LLM data workflows.

Capabilities: [product/01 §7–§8](01-features.md#7-ai--ml-dataset-features) — semantic dataset
recognition, conversation viewer, LLM diagnostics (role/structured-output/tool-call checks,
duplicate and near-duplicate detection, token and context analysis, leakage/PII scanning),
evaluation comparison, and AI assistance. The governing principle: AI proposes; deterministic
systems enforce (recommendations must resolve into reviewable rules or transformations before
execution).

Exit criteria:

- users prefer the tool over raw JSONL for eval/training dataset review.

---

### Phase 5 — Team Workspaces

Goal: introduce monetizable collaboration. The phase adds shared datasets and versions,
comments, saved views, shared SQL/rules/contracts/transformations, review workflows, approvals,
ownership, and dataset change requests. Capabilities: [product/01 §9.3](01-features.md#93-dataset-change-request)
(DCR) and [§10](01-features.md#10-governance-features) (ownership, governed sharing). The
dataset change request is the dataset equivalent of a pull request.

Exit criteria:

- teams can review and approve dataset changes collaboratively.

---

### Phase 6 — Governed Data Products

Goal: treat datasets as governed reusable products rather than files.

Domain model:

```text
DataProduct
   |
   +-- Dataset
   |     +-- version
   |     +-- schema
   |     +-- partitions
   |     +-- physical assets
   |
   +-- Contract
   +-- QualityPolicy
   +-- AccessPolicy
   +-- EncryptionPolicy
   +-- Owner
   +-- Lineage
   +-- Reviews
```

Capabilities:

- catalog,
- ownership,
- data classification,
- contracts,
- policy enforcement,
- lineage,
- approval,
- version promotion,
- governed sharing.

Exit criteria:

- the logical dataset is independent from its physical representation.

---

### Phase 7 — Enterprise Control Plane

Goal: support regulated and large-scale enterprise usage. The phase spans identity
(SSO/SAML, SCIM, RBAC/ABAC, groups, service identities), central policy and contract registries,
privacy/retention policy, audit and lineage, approvals, row/column controls, encryption metadata
with BYOK/KMS, private/VPC/on-prem deployment, connectors (S3, ADLS, GCS, Snowflake, Databricks,
BigQuery, Postgres, Hugging Face), and enterprise AI governance (configurable/local providers,
approved endpoints, schema-only mode, raw-row access controls, prompt/action auditability).
Capabilities: [product/01 §10–§12](01-features.md#10-governance-features). Connector and
control-plane architecture: [architecture/01 §14](../architecture/01-architecture.md#14-enterprise-architecture).

Exit criteria:

- enterprise data can be governed without requiring users to download unrestricted raw files.

---

## 5. Commercial Model

### Free / Open Core

Recommended free capabilities:

- browser application,
- VS Code extension,
- CLI,
- local execution,
- core formats,
- grid,
- SQL,
- profile,
- diff,
- validation,
- transformations,
- local contracts.

The free product is the adoption engine.

### Team

Potential paid features:

- workspaces,
- dataset versions,
- shared rules,
- dataset change requests,
- collaboration,
- review,
- approvals,
- shared artifacts,
- hosted metadata.

### Enterprise

Potential paid features:

- SSO,
- SCIM,
- RBAC / ABAC,
- audit,
- connectors,
- remote query gateway,
- row and column policies,
- encryption integration,
- KMS / BYOK,
- private deployment,
- enterprise AI governance,
- lineage,
- SLA and support.

---

## 6. Strategic Non-Goals

The product should avoid becoming a full replacement for:

- Informatica ETL,
- enterprise MDM,
- Spark,
- Databricks compute,
- dbt,
- Airflow,
- Snowflake,
- lakehouse storage,
- BI dashboards.

Instead, integrate with those systems while owning the developer-facing workflow around trusted datasets.

---

## 7. North-Star Principles

1. Local-first by default.
2. Files are physical assets, not the core domain object.
3. Dataset changes should be reviewable.
4. Visual actions should be reproducible.
5. AI proposes; deterministic systems enforce.
6. Security must be enforced at the data boundary, not only hidden in the UI.
7. Web, VS Code, CLI, and CI should share the same core.
8. Enterprise features should extend the local experience rather than replace it.
