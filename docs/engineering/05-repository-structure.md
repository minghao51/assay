# Data Workbench Repository Structure

## 1. Recommended Monorepo

```text
assay/
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
│   ├── pipeline/
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

> **Scaffold today** — application use cases and orchestration land with the
> post-MVP/gated tracks that need them.

Intended responsibility:

- open dataset,
- compare versions,
- run validation,
- apply transform,
- prepare DCR.

### `engine`

Interfaces only — the _target_ shapes:

- DataEngine,
- QueryRequest,
- TableHandle,
- ArrowBatchStream.

> **Honest status (audit AR-D7; decision D13 pending):** nothing implements
> or imports these types today — the real engine surface is the
> `@assay/engine-duckdb` client, and `@assay/testing`'s conformance suite
> pins a mirror of _that_ interface, not `DataEngine`. Realigning, deleting,
> or type-pinning the relationship is open decision D13.

### `engine-duckdb`

The real engine: DuckDB-WASM running in a Web Worker behind a typed
postMessage protocol (ADR 0002/0021), plus a Node seam (`./node`) for the
CLI (ADR 0041).

### `engine-parquet`

> **Scaffold today** — any Parquet-native engine work belongs to a post-MVP
> track (the editing model stays overlay-based per ADR 0012 regardless).

### `grid`

Owned grid model:

- viewport,
- selection,
- editing,
- clipboard,
- annotations,
- DataProvider interface.

### `ui`

> **Scaffold today** — reusable presentation components land when a second
> surface needs them.

### `data-sources`

Adapters for:

- browser file,
- browser directory,
- VS Code workspace,
- future remote systems.

(Real today: `BrowserFileSource` + capability detection + fallback picker,
with the `@assay/testing` behavior suite pinning the contract.)

> **Entry-point convention (raw-TS exports):** packages export TypeScript
> source, so every importer type-checks the package under its own `tsconfig`
> `lib` settings. Keep the root entry (`.`) environment-neutral (types/logic
> that compile DOM-less); put DOM-naming browser code behind a `./browser`
> subpath export (pattern introduced in m1-3, e.g. `@assay/data-sources/browser`).
> Applies to any package whose consumers include DOM-less packages.

### `contracts`

Contract AST, parser, serializer, adapters.

### `validation`

Rule planning and execution.

### `diff`

Schema/profile/distribution/row diff.

### `transforms`

> **Scaffold today** — transform AST/compiler land with the post-MVP track
> that owns them (M4 editing shipped via the overlay/domain model instead).

### `security`

> **Scaffold today** — policy types, classifications, masking metadata, and
> future authorization adapters belong to the gated enterprise tracks.

### `ai`

> **Scaffold today** — AI provider abstractions and proposal schemas belong
> to a post-MVP track.

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

The parameterized suites in `@assay/testing` pin the **real engine client
surface** (`engine-duckdb`) — a mirror of the intended `DataEngine` target
interface (the type-level relationship is decision D13, see §2 `engine`).

Every DataSource adapter should pass the same source behavior suite.

Every contract adapter should round-trip supported semantics through the canonical contract AST.

This allows engines and adapters to evolve without changing product behavior.

---

## 5. Pipeline Package

> **Scaffold today** — the P-stage pipeline tracks own its realization.

### `pipeline`

Intended to own:

- Pipeline IR,
- DAG validation,
- planning,
- materialization semantics,
- local runner abstractions,
- external execution adapter interfaces.

It may depend on `domain`, `engine`, `contracts`, `validation`, and `transforms`.

It must not depend directly on dbt, SQLMesh, or Dagster-specific runtime concepts.
