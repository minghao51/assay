# Data Workbench Repository Structure

## 1. Recommended Monorepo

```text
dataworkbench/
├── apps/
│   ├── web/
│   ├── vscode/
│   └── cli/
│
├── packages/
│   ├── domain/
│   ├── core/
│   ├── ui/
│   ├── grid/
│   ├── engine/
│   ├── engine-duckdb/
│   ├── engine-parquet/
│   ├── data-sources/
│   ├── validation/
│   ├── diff/
│   ├── transforms/
│   ├── contracts/
│   ├── security/
│   ├── ai/
│   └── testing/
│
├── fixtures/
│   ├── csv/
│   ├── jsonl/
│   ├── nested-json/
│   ├── parquet/
│   ├── drift/
│   ├── diff/
│   └── llm/
│
├── docs/
│   └── adr/
│
├── tooling/
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
└── README.md
```

---

## 2. Package Responsibilities

### `domain`

Pure domain entities and types:

- DataProduct,
- Dataset,
- DatasetVersion,
- PhysicalAsset,
- Contract,
- Policy,
- DatasetChangeRequest.

No browser or React dependencies.

### `core`

Application use cases and orchestration.

Examples:

- open dataset,
- compare versions,
- run validation,
- apply transform,
- prepare DCR.

### `engine`

Interfaces only:

- DataEngine,
- QueryRequest,
- TableHandle,
- ArrowBatchStream.

### `engine-duckdb`

DuckDB-WASM implementation.

### `engine-parquet`

Parquet-specific metadata/read/write helpers.

### `grid`

Owned grid model:

- viewport,
- selection,
- editing,
- clipboard,
- annotations,
- DataProvider interface.

### `ui`

Reusable presentation components.

### `data-sources`

Adapters for:

- browser file,
- browser directory,
- VS Code workspace,
- future remote systems.

### `contracts`

Contract AST, parser, serializer, adapters.

### `validation`

Rule planning and execution.

### `diff`

Schema/profile/distribution/row diff.

### `transforms`

Transform AST, compiler, preview semantics.

### `security`

Policy types, classifications, masking metadata, future authorization adapters.

### `ai`

AI provider abstractions and proposal schemas.

### `testing`

Reusable fixtures, helpers, conformance suites.

---

## 3. Dependency Direction

Preferred direction:

```text
apps
 ↓
ui / core
 ↓
domain
```

and:

```text
core
 ↓
engine interfaces
 ↓
engine implementations
```

Avoid:

```text
domain -> React
domain -> browser APIs
domain -> DuckDB
```

The domain package should remain highly portable.

---

## 4. Conformance Tests

Every DataEngine implementation should pass the same conformance suite.

Every DataSource adapter should pass the same source behavior suite.

Every contract adapter should round-trip supported semantics through the canonical contract AST.

This allows engines and adapters to evolve without changing product behavior.


---

## 5. Pipeline Package

### `pipeline`

Owns:

- Pipeline IR,
- DAG validation,
- planning,
- materialization semantics,
- local runner abstractions,
- external execution adapter interfaces.

It may depend on `domain`, `engine`, `contracts`, `validation`, and `transforms`.

It must not depend directly on dbt, SQLMesh, or Dagster-specific runtime concepts.
