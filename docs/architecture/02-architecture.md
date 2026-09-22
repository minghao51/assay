# Data Workbench Architecture

## 1. Architectural Goals

The architecture must support:

- browser-local execution,
- very large datasets,
- multiple file formats,
- web and VS Code reuse,
- future CLI reuse,
- deterministic validation,
- dataset-level abstractions,
- enterprise policy enforcement,
- remote data access,
- secure AI integration.

---

## 2. Core Principles

1. The grid never owns the dataset.
2. File is not the primary domain object.
3. Query and transformation run outside the UI thread.
4. Arrow is the preferred in-memory interchange.
5. Local-first is the default execution model.
6. Remote enterprise access requires enforceable policy boundaries.
7. AI suggestions compile to reviewable deterministic artifacts.
8. UI, core domain, engine, and policy layers remain separable.

---

## 3. High-Level Architecture

```text
                         Applications
        +----------------+----------------+----------------+
        |                |                |                |
       Web           VS Code            CLI              CI
        |                |                |                |
        +----------------+----------------+----------------+
                         |
                      UI Core
                         |
                    Domain Core
                         |
        +----------------+----------------+----------------+
        |                |                |                |
      Query          Validation          Diff        Transform
        |                |                |                |
        +----------------+----------------+----------------+
                         |
                     DataEngine
                         |
          +--------------+--------------+
          |                             |
     DuckDB-WASM                   parquet-wasm
          |                             |
          +--------------+--------------+
                         |
                   Apache Arrow
                         |
                    Data Sources
```

---

## 4. Application Surfaces

### 4.1 Web

Responsibilities:

- browser file access,
- local workspace,
- browser storage,
- local rendering,
- local WASM execution.

### 4.2 VS Code

Responsibilities:

- custom file editors,
- workspace file access,
- Git integration,
- editor commands,
- dataset-aware diffs,
- local project metadata.

### 4.3 CLI

Responsibilities:

- profile,
- validate,
- diff,
- transform,
- CI output.

---

## 5. Core Domain Model

```text
DataProduct
   |
   +-- Dataset
   |     +-- DatasetVersion
   |     +-- Schema
   |     +-- Partitions
   |     +-- PhysicalAsset[]
   |
   +-- Contract
   +-- QualityPolicy
   +-- AccessPolicy
   +-- EncryptionPolicy
   +-- Owner
   +-- Lineage
   +-- Review[]
```

### PhysicalAsset

Examples:

- local Parquet file,
- JSONL file,
- S3 object,
- ADLS path,
- Hugging Face split,
- Snowflake table,
- Databricks table.

---

## 6. Data Source Abstraction

```ts
interface DataSource {
  id: string
  kind: string
  open(): Promise<DataHandle>
  metadata(): Promise<DataSourceMetadata>
}
```

Implementations:

- BrowserFileSource,
- BrowserDirectorySource,
- VSCodeWorkspaceSource,
- HuggingFaceSource,
- S3Source,
- ADLSSource,
- SnowflakeSource,
- DatabricksSource.

---

## 7. Data Engine Abstraction

```ts
interface DataEngine {
  open(source: DataSource): Promise<TableHandle>
  query(sql: string): Promise<ArrowBatchStream>
  schema(table: TableHandle): Promise<Schema>
  profile(table: TableHandle): Promise<DatasetProfile>
  export(table: TableHandle, format: ExportFormat, options?: ExportOptions): Promise<ReadableStream>
}
```

Initial engine:

- DuckDB-WASM.

Additional specialized engine:

- parquet-wasm for low-level Parquet metadata, rewriting, and format-specific operations.

Future options:

- DataFusion WASM,
- remote query gateway,
- native desktop engine.

---

## 8. Grid Architecture

```text
DatasetGrid (packages/grid — read-only, rendering-replaceable ADR 0022)
    |
    v
GridDataProvider (the contract the grid consumes — DEFINED in
    |              packages/grid/contracts.ts, IMPLEMENTED by the host app,
    |              never by the grid itself)
    +-- rowCount() / fetchRange() / sort() / filter() / schema()
    ^
    |
Host app (apps/web) composes the provider over the engine client and the
edit overlay — cell edits are overlay ops addressed by logical RowId
(ADR 0011/0012), never positional mutations on the grid contract.
    |
    v
EngineClient (packages/engine-duckdb, Web Worker)
```

The grid should request only visible or nearby data ranges.

The grid must not materialize the full dataset in React state.

---

## 9. Editing Model

Parquet and similar immutable file formats should use an overlay.

```text
Original Dataset
      |
      v
Read-only base
      |
      +---- Edit Overlay
      |       +-- changed cells
      |       +-- deleted rows
      |       +-- inserted rows
      |
      v
Logical Dataset
      |
      v
Export / Rewrite
```

This enables:

- undo,
- diff,
- preview,
- explicit save-as behavior.

---

## 10. Validation Architecture

```text
Dataset
   |
   +-- Schema
   +-- Contract
   +-- QualityPolicy
   |
   v
Validation Engine
   |
   +-- rule results
   +-- failing rows
   +-- summary metrics
   +-- repair suggestions
```

Rules should be deterministic and serializable.

---

## 11. Diff Architecture

The diff layer should compare dataset versions at multiple levels:

1. metadata,
2. schema,
3. profile,
4. distribution,
5. row identity,
6. row values.

This allows fast summaries before expensive row-level comparison.

---

## 12. Transformation Architecture

Visual transformations produce a logical plan.

```text
Visual Action
      |
      v
Transform Operation
      |
      +-- SQL
      +-- Declarative Recipe
      |
      v
Preview
      |
      v
Apply / Export
```

Transformation history should be versionable and reproducible.

---

## 13. Local Workspace Architecture

Suggested structure:

```text
project/
├── datasets/
├── .assay/
│   ├── workspace.json
│   ├── contracts/
│   ├── rules/
│   ├── queries/
│   ├── recipes/
│   └── profiles/
```

The metadata should remain human-readable where possible.

---

## 14. Enterprise Architecture

```text
                  CONTROL PLANE

       +----------------------------------+
       | Workspace                        |
       | Identity                         |
       | Dataset Catalog                  |
       | Contracts                        |
       | Policies                         |
       | Lineage                          |
       | Audit                            |
       | AI Policy                        |
       +----------------+-----------------+
                        |
                 policy decisions
                        |
========================+========================

                    DATA PLANE
                        |
                 Data Gateway
                        |
        +---------------+----------------+
        |               |                |
      S3/ADLS        Snowflake        Databricks
```

The control plane manages metadata and policy.

The data plane enforces access to governed data.

---

## 15. Security Boundary

A local file already possessed by the user cannot have meaningful row-level security enforced by the UI.

Therefore:

### Local Mode

- masking and row filters are convenience or presentation controls only.

### Governed Mode

- row filters and masking must be enforced by:
  - the source database,
  - a policy gateway,
  - or a controlled query service.

---

## 16. Encryption Architecture

Layers:

- TLS in transit,
- provider-managed storage encryption,
- KMS-managed keys,
- envelope encryption,
- optional column encryption,
- Parquet modular encryption where applicable.

Do not implement custom cryptographic primitives.

---

## 17. AI Architecture

```text
Dataset Metadata
       |
       +-- schema
       +-- statistics
       +-- validation failures
       +-- selected rows (policy-controlled)
       |
       v
AI Provider Adapter
       |
       v
Suggestion
       |
       v
Deterministic Artifact
       |
       +-- validation rule
       +-- transform
       +-- mapping
       +-- explanation
       |
       v
Preview / Human Approval
```

AI providers should be pluggable.

---

## 18. Suggested Monorepo Structure

```text
assay/

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
  security/
  ai/
  pipeline/
  testing/

docs/
  adr/
```

Package scope: all workspace packages use the `@assay/*` npm scope; the repository/directory name is `assay`; the display name is "Assay" (ADR 0039). See `05-repository-structure.md` for the authoritative layout.

---

## 19. Technology Direction

Initial recommendations:

- TypeScript for application and shared UI.
- React for web/webview UI.
- DuckDB-WASM for analytical execution.
- Apache Arrow JS for data interchange.
- parquet-wasm for low-level Parquet operations.
- Monaco for SQL and structured text editing.
- Ajv for JSON Schema.
- Web Workers for compute isolation.
- OPFS / File System Access API for browser-local state.
- VS Code Custom Editor + Webview for extension integration.

The grid layer should be abstracted from day one to allow progressive replacement or modernization of existing open-source grid implementations.

---

## 20. Pipeline and DAG Layer

Data Workbench owns a portable logical Pipeline IR.

```text
Visual DAG / SQL Editor
          |
          v
      Pipeline IR
          |
          v
     Pipeline Planner
          |
    +-----+------+
    |            |
 Local Runner   External Adapter
    |            |
 DuckDB       dbt / SQLMesh / Dagster
```

SQL is the canonical target for relational transformations. The Pipeline IR additionally captures dependencies, validation, materialization, publish semantics, lineage, and non-SQL nodes.

Transformation DAG semantics remain separate from scheduling/orchestration.

See `09-pipeline-dag-etl.md` and ADRs 0029-0035.
