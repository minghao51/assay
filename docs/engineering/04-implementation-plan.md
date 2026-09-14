# Data Workbench Implementation Plan

## 1. Objective

Build the smallest architecture that proves the product thesis while preserving the seams needed for the longer-term governed data platform.

The implementation should proceed vertically: each milestone should produce a usable product increment.

---

## 2. Milestone 0 — Repository Bootstrap

Deliver:

- monorepo,
- package boundaries,
- CI,
- linting/formatting,
- test harness,
- ADR/docs structure,
- shared TypeScript config,
- release/version conventions.

Suggested packages:

```text
apps/
  web/
  vscode/
  cli/

packages/
  domain/
  core/
  ui/
  grid/
  engine/
  engine-duckdb/
  engine-parquet/
  data-sources/
  validation/
  diff/
  transforms/
  contracts/
```

Exit criteria:

- all apps build,
- shared package import boundaries work,
- CI runs tests/lint/typecheck.

---

## 3. Milestone 1 — Local File Explorer

Deliver:

- drag/drop,
- browser file picker,
- Parquet,
- JSONL,
- CSV,
- schema display,
- first-row preview,
- DuckDB worker,
- Arrow batch transport,
- virtualized grid.

No editing yet.

Exit criteria:

- multi-GB Parquet can be opened without loading all rows into JS memory,
- grid remains responsive,
- no raw data leaves the browser.

---

## 4. Milestone 2 — Query and Profiling

Deliver:

- SQL editor,
- filters,
- sorting,
- result paging,
- numeric profiles,
- categorical profiles,
- null/distinct statistics,
- simple distribution charts.

Exit criteria:

- common notebook-style exploratory tasks can be done without Python.

---

## 5. Milestone 3 — Nested Data

Deliver:

- nested schema tree,
- JSON tree cell,
- flatten,
- explode,
- path extraction,
- raw record inspector.

Exit criteria:

- JSONL with nested fields is materially easier to inspect than plain text.

---

## 6. Milestone 4 — Editing and Transformations

Deliver:

- edit overlay,
- stable row identity strategy,
- cell edit,
- insert/delete rows,
- rename/cast columns,
- transformation history,
- preview,
- export/rewrite.

Exit criteria:

- edits are reversible,
- Parquet is rewritten rather than incorrectly treated as in-place mutable.

---

## 7. Milestone 5 — Validation and Contracts

Deliver:

- contract parser,
- initial native contract AST,
- required/unique/range/allowed-values rules,
- invalid-row explorer,
- validation summaries,
- CLI validation output.

Exit criteria:

- same validation semantics work in Web and CLI.

---

## 8. Milestone 6 — Dataset Diff

Deliver:

- schema diff,
- profile diff,
- distribution diff,
- key-based row diff,
- nested value diff,
- diff report export.

Exit criteria:

- users can answer “what changed?” without opening two notebooks.

---

## 9. Milestone 7 — VS Code Extension

Deliver:

- custom editors for supported formats,
- shared workbench UI,
- workspace file adapter,
- Git context integration,
- dataset diff command.

Exit criteria:

- local developer workflow works without opening a separate browser app.

---

## 10. Milestone 8 — AI Dataset Mode

Deliver:

- schema recognition,
- conversation viewer,
- role/turn validation,
- token estimates,
- duplicate prompts,
- malformed tool-call checks,
- eval result comparison.

Exit criteria:

- meaningful differentiation from generic table viewers.

---

## 11. Milestone 9 — Dataset Change Request

Deliver local DCR generation:

- base/candidate versions,
- schema changes,
- quality results,
- drift summary,
- row-change summary,
- report artifact.

This milestone does not require a hosted team workspace yet.

---

## 12. Milestone 10 — Team Workspace Prototype

Only after local adoption evidence.

Deliver:

- authentication,
- hosted workspace metadata,
- dataset versions,
- DCR review,
- comments,
- approval state,
- shared contracts.

Avoid hosting raw user data unless the use case explicitly requires it.

---

## 13. Milestone 11 — Enterprise Data Gateway

Only after a validated enterprise requirement.

Deliver:

- one object-store connector,
- one database/lakehouse connector,
- governed query gateway,
- policy enforcement proof,
- audit,
- Arrow streaming,
- identity propagation.

---

## 14. Definition of MVP

The first public MVP should include:

```text
Parquet / JSONL / CSV
virtualized grid
nested data
schema/profile
SQL
local-only processing
basic editing
export
validation
dataset diff
VS Code extension
```

AI, collaboration, remote connectors, RLS, KMS, and enterprise governance should not block the MVP.

---

## 15. Product Validation Metrics

Track privacy-safe product metrics such as:

- file open success rate,
- time to first rows,
- median query latency,
- profile completion time,
- validation usage,
- diff usage,
- VS Code repeat usage,
- export/transform completion,
- crash/failure rate.

Do not collect raw dataset values.

---

## 16. Risks to Validate Early

1. Browser memory ceilings.
2. Virtualized grid UX at very high row counts.
3. Nested data ergonomics.
4. Stable row identity for editing/diff.
5. DuckDB-WASM startup cost.
6. VS Code webview/WASM constraints.
7. Cross-browser filesystem behavior.
8. Contract language usability.
9. Diff performance.
10. Accessibility in custom grid interactions.

---

## 17. Pipeline / DAG Implementation Track

The pipeline layer should begin after the local explorer, SQL, and validation primitives are stable.

### Pipeline M1 — IR and Local Runner

- Pipeline IR schema,
- DAG validation,
- source nodes,
- SQL nodes,
- topological execution,
- DuckDB local runner.

### Pipeline M2 — Visual Transform Nodes

- filter,
- select,
- cast,
- rename,
- join,
- aggregate,
- deduplicate,
- generated SQL preview.

### Pipeline M3 — Quality and Publish

- validation nodes,
- publish nodes,
- materialization settings,
- preview,
- lineage,
- candidate DatasetVersion generation.

### Pipeline M4 — Dataset Change Request Integration

- automatic schema/profile/quality diff,
- DCR generation from candidate output.

### Pipeline M5 — Ecosystem Compatibility

- dbt project inspection,
- dbt export,
- SQLMesh adapter,
- external execution interface.

### Pipeline M6 — Ingestion and Orchestration

Only when validated by use cases:

- dlt-backed ingestion adapter,
- Dagster adapter,
- scheduling/backfill integration.
