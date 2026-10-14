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
│   ├── telemetry/
│   └── testing/
│
├── fixtures/
│   ├── csv/
│   ├── jsonl/
│   ├── nested-json/
│   ├── parquet/
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

> **Current status (D13):** retained as a target, not the real engine's
> complete runtime interface. `engine-target-compat.test.ts` pins documented
> compatibility/divergences at compile time; `@assay/testing` conformance
> exercises the real `@assay/engine-duckdb` client surface.

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
with the `@assay/testing` behavior suite pinning the contract. The desktop
VS Code workspace byte bridge lives in `apps/vscode`, not this package.)

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
surface** (`engine-duckdb`), not full implementation of the `DataEngine`
target. D13 retains the target and its compatibility pins (see §2 `engine`).

Every DataSource adapter should pass the same source behavior suite.

Every contract adapter should round-trip supported semantics through the canonical contract AST.

This allows engines and adapters to evolve without changing product behavior.

---

## 5. Pipeline Package

> **Implemented:** P1 IR/DAG/compiler/runner integration, P2 gate and
> materialization semantics, and P3 canonical local DCR artifact generation.
> The package holds portable planning/building logic; engine execution lives
> in `engine-duckdb`. Compiled tsc packaging and the full local CLI runtime
> closure are verified by the rm-2 consumer smoke; registry publication of
> private dependencies is not authorized by that proof.

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

## 6. Telemetry Package

`telemetry` owns the typed allowlisted operational-metadata schema, validation
and privacy-safe transport helpers (ADRs 0025/0037/0045). Web/CLI provide the
emission and opt-out integrations; collector deployment remains human-gated.

## 7. Product Surfaces

`web` and `cli` implement the local workbench plus pipeline/DCR workflows.
`vscode` implements the desktop read-only dataset editor with a vendored engine
and headless grid; edit/validate/diff/Git parity is PT-V slice-2 work.
