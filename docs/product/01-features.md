# Data Workbench Feature Specification

## 1. Feature Taxonomy

The product should be organized around six user intents:

1. Understand
2. Validate
3. Compare
4. Repair
5. Prepare
6. Govern

These are more important than individual file-format features.

---

## 2. Understand

### 2.1 Universal File Viewer

Formats:

- Parquet
- JSON
- JSONL / NDJSON
- CSV / TSV
- Arrow IPC
- Feather

Future:

- Avro
- ORC
- Delta
- Iceberg
- remote tables

### 2.2 Dataset Grid

Capabilities:

- virtualized rows,
- virtualized columns,
- frozen columns,
- column resize,
- column reorder,
- keyboard navigation,
- range selection,
- copy/paste,
- search,
- filter,
- sort,
- custom cell renderers,
- nested-value cells,
- editable cells,
- large-row-count paging.

### 2.3 Nested Data Views

Synchronized views:

- table,
- tree,
- raw JSON,
- semantic view.

Nested operations:

- flatten,
- explode,
- unnest,
- extract path,
- rename path,
- delete path,
- create nested field.

### 2.4 Schema Explorer

Display:

- physical type,
- logical type,
- nullability,
- nested structure,
- column statistics,
- distinct count,
- cardinality,
- semantic classification,
- security classification.

### 2.5 Profiling

Numeric:

- min,
- max,
- mean,
- median,
- percentiles,
- standard deviation,
- histogram.

Categorical:

- top values,
- frequency,
- cardinality,
- null percentage.

String:

- lengths,
- examples,
- inferred semantic type.

### 2.6 SQL

- read-only query mode,
- transformed view mode,
- result paging,
- result export,
- query history,
- saved queries,
- generated SQL from visual operations.

---

## 3. Validate

### 3.1 Rule Types

- required,
- unique,
- allowed values,
- min/max,
- regex,
- semantic formats,
- cross-column rules,
- cross-row rules,
- type constraints,
- null thresholds,
- uniqueness thresholds,
- distribution expectations.

### 3.2 Data Contracts

Potential formats:

- native YAML contract,
- JSON Schema,
- Arrow schema,
- Pydantic-compatible JSON Schema,
- dbt-style contracts,
- Pandera-style rules,
- Great Expectations import.

### 3.3 Invalid Row Explorer

For each rule:

- failure count,
- failure percentage,
- sample failures,
- filter to failures,
- export failures,
- suggested repair.

### 3.4 Validation Outputs

- UI report,
- JSON report,
- SARIF-like CI output,
- command-line exit codes.

---

## 4. Compare

### 4.1 Dataset Diff

Compare:

- row counts,
- columns,
- schema,
- types,
- nulls,
- duplicates,
- distributions,
- categories,
- ranges,
- summary statistics.

### 4.2 Row Diff

Detect:

- added rows,
- removed rows,
- changed rows.

Support explicit or inferred keys.

### 4.3 Schema Drift

Detect:

- added columns,
- removed columns,
- changed types,
- changed nullability,
- changed nested shape.

### 4.4 Distribution Drift

Potential methods:

- PSI,
- Jensen-Shannon divergence,
- KS test,
- categorical distance,
- mean/variance shifts.

### 4.5 Git-Aware Diff

VS Code and CLI should support dataset-aware diff views suitable for pull requests and local review.

---

## 5. Repair

### 5.1 Direct Editing

- edit cell,
- fill selection,
- insert row,
- delete row,
- rename column,
- cast column,
- replace values,
- set null.

### 5.2 Suggested Repair

Examples:

- normalize country codes,
- trim whitespace,
- standardize date formats,
- map categories,
- deduplicate,
- fill nulls,
- repair malformed nested fields.

### 5.3 Preview Before Apply

Every non-trivial repair should support:

- affected row count,
- before/after sample,
- undo,
- generated deterministic rule.

---

## 6. Prepare

### 6.1 Visual Transformations

- filter,
- select,
- rename,
- cast,
- derive,
- aggregate,
- join,
- deduplicate,
- sort,
- explode,
- flatten,
- pivot/unpivot where feasible.

### 6.2 Transformation Recipes

Visual actions should compile to reproducible forms:

- SQL,
- native declarative YAML,
- future language adapters.

### 6.3 Export

Formats:

- Parquet,
- JSONL,
- JSON,
- CSV,
- Arrow.

Settings:

- compression,
- row group size,
- partitioning,
- schema enforcement.

---

## 7. AI / ML Dataset Features

### 7.1 Semantic Dataset Recognition

Recognize common schemas automatically.

Examples:

- chat messages,
- prompt/completion,
- tool-call traces,
- eval records,
- classification datasets,
- instruction tuning.

### 7.2 Conversation Viewer

Render chat-oriented datasets semantically.

### 7.3 LLM Dataset Diagnostics

- missing roles,
- invalid role order,
- empty content,
- duplicated prompts,
- duplicated conversations,
- malformed tool calls,
- invalid structured outputs,
- excessive token counts,
- context overflow risk.

### 7.4 Evaluation Comparison

Compare:

- accuracy,
- pass rates,
- rubric results,
- grader distributions,
- latency,
- token use,
- cost fields.

---

## 8. AI Assistance

AI should assist with:

- schema mapping,
- semantic classification,
- validation-rule generation,
- anomaly explanation,
- repair proposals,
- transformation suggestions,
- metadata generation.

AI should not directly mutate governed datasets without producing a deterministic transformation that can be reviewed.

---

## 9. Dataset-Level Features

### 9.1 Directory as Dataset

Support:

- glob patterns,
- partitions,
- shards,
- train/validation/test splits,
- multi-file logical tables.

### 9.2 Dataset Versioning

Track:

- dataset identity,
- version,
- schema,
- profile snapshot,
- validation result,
- provenance.

### 9.3 Dataset Change Request

A review object containing:

- source version,
- target version,
- changes,
- quality impact,
- drift,
- privacy findings,
- reviewers,
- approvals.

---

## 10. Governance Features

### 10.1 Classification

Labels such as:

- public,
- internal,
- confidential,
- restricted,
- PII,
- PHI,
- financial-sensitive.

### 10.2 RBAC

Role-based dataset and feature access.

### 10.3 ABAC

Policy based on attributes such as:

- user region,
- department,
- dataset classification,
- data domain,
- environment.

### 10.4 Row-Level Policies

For governed remote data only.

### 10.5 Column Masking

Examples:

- redact,
- hash,
- partial reveal,
- tokenize.

### 10.6 Audit

Track:

- access,
- exports,
- policy changes,
- approvals,
- AI actions,
- transformation executions.

---

## 11. Encryption Features

### 11.1 Local

- browser-local processing,
- optional encrypted local workspace metadata.

### 11.2 Enterprise

- object-store encryption,
- TLS,
- KMS integration,
- BYOK,
- envelope encryption,
- Parquet modular encryption where supported,
- column-specific encryption keys.

---

## 12. Surfaces

### Web

Primary onboarding and local-first interface.

### VS Code

Primary developer workflow integration.

### CLI

Automation and CI.

### CI

Validation, policy enforcement, and dataset-change reporting.

### Enterprise Web Workspace

Collaboration, governance, audit, and administration.

---

## 13. Visual Pipeline and DAG

### Visual Authoring

- source nodes,
- transform nodes,
- SQL nodes,
- validation nodes,
- publish nodes,
- drag-and-drop dependencies,
- preview at every step,
- generated SQL visibility.

### Pipeline Intelligence

- schema propagation,
- DAG validation,
- lineage,
- impact analysis,
- materialization,
- validation gates,
- publish gates.

### Ecosystem Compatibility

- dbt project inspection/import,
- dbt export,
- SQLMesh integration,
- dlt ingestion adapters,
- Dagster orchestration adapters.

### Non-Technical UX

Structured forms generate SQL for common operations while advanced users can switch to SQL without leaving the same pipeline model.
