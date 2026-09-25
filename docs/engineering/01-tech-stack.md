# Data Workbench Technology Stack

## 1. Purpose

This document defines the recommended technology stack for the first implementation of Data Workbench and the expected evolution toward team and enterprise deployments.

The goal is not to maximize technology novelty. The goal is to:

- ship the local-first product quickly,
- keep the data plane scalable,
- preserve architectural seams for future native and remote execution,
- share as much code as practical across Web and VS Code,
- avoid rebuilding mature infrastructure that is not part of the product moat.

---

## 2. Stack Strategy

The recommended strategy is **hybrid TypeScript + Rust/WASM**.

### TypeScript owns

- application UI,
- workspace UX,
- grid state,
- domain orchestration,
- browser integration,
- VS Code integration,
- control-plane workflows,
- contracts between UI and engines.

### Rust/WASM or native Rust owns

- performance-sensitive data primitives,
- low-level Parquet operations,
- future remote data gateway,
- future high-throughput native compute,
- format-specific or security-sensitive execution where native code provides a clear advantage.

### DuckDB-WASM owns initially

- analytical SQL,
- projection/filter pushdown,
- joins,
- aggregation,
- profiling,
- local file querying.

This avoids building a custom query engine prematurely.

---

## 3. High-Level Stack

| Layer                   | Initial choice                            | Future / alternatives                    |
| ----------------------- | ----------------------------------------- | ---------------------------------------- |
| Monorepo                | pnpm workspaces + Turborepo               | Nx if workflow complexity grows          |
| UI                      | React + TypeScript                        | —                                        |
| Build                   | Vite                                      | —                                        |
| Components              | Radix + shadcn/ui                         | Headless UI alternatives                 |
| Styling                 | Tailwind                                  | CSS modules where useful                 |
| Grid                    | owned `grid-core` + TanStack Virtual      | custom canvas renderer; AG Grid adapter  |
| Text/SQL editor         | CodeMirror 6                              | Monaco if language services justify cost |
| Local analytical engine | DuckDB-WASM                               | DataFusion WASM/native engine            |
| Parquet internals       | parquet-wasm                              | native Rust parquet crate                |
| Interchange             | Apache Arrow                              | —                                        |
| Worker boundary         | Web Workers + typed RPC                   | worker pool abstraction                  |
| Local persistence       | File System Access API + OPFS + IndexedDB | Tauri/native filesystem                  |
| Runtime schemas         | Zod or Valibot                            | generated schemas where practical        |
| JSON Schema             | Ajv                                       | —                                        |
| Visualization           | Vega-Lite / Vega                          | custom lightweight charts                |
| UI state                | Zustand                                   | XState for complex workflows             |
| Async/server state      | TanStack Query                            | —                                        |
| VS Code                 | Custom Editor + Webview                   | —                                        |
| CLI v1                  | TypeScript/Node                           | Rust native CLI later                    |
| Desktop later           | Tauri                                     | Electron only if required                |
| Enterprise metadata DB  | PostgreSQL                                | —                                        |
| Control-plane API       | TypeScript + Fastify/Hono                 | Rust if future need justifies            |
| Data gateway            | Rust + Axum                               | —                                        |
| Remote query engine     | DataFusion                                | source-native pushdown                   |
| Object storage          | Rust `object_store`                       | cloud SDKs where needed                  |
| Authentication          | OIDC/OAuth2                               | SAML/SCIM for enterprise                 |
| Authorization           | simple RBAC first                         | Cedar / OpenFGA / OPA evaluation         |
| Key management          | cloud KMS / Vault adapters                | BYOK/HSM                                 |
| Observability           | OpenTelemetry                             | Sentry/Prometheus/Grafana adapters       |
| TS testing              | Vitest + Playwright + fast-check          | —                                        |
| Rust testing            | cargo test + proptest + fuzzing           | criterion benchmarks                     |

**Adoption status (2026-09-23):** this table is the recommended target stack, not a shipping list.
Adopted and shipping today: pnpm workspaces + Turborepo, React + TypeScript, Vite, DuckDB-WASM,
parquet-wasm, Apache Arrow, Web Workers + typed RPC, Vitest + Playwright + fast-check, and the
TypeScript/Node CLI. Not yet adopted (recommendations only): Radix/shadcn, Tailwind, CodeMirror 6
(the shipped SQL editor is a dependency-free textarea), Vega-Lite, Zustand, TanStack Query, and
everything from "Desktop later" down.

---

## 4. Frontend Runtime

### Recommended

```text
React
TypeScript
Vite
pnpm
Turborepo
```

### Why React

The product needs:

- complex interactive state,
- custom editors,
- reusable Web/VS Code UI,
- broad library compatibility,
- mature accessibility ecosystem.

### Why Vite

The core workbench is a client-heavy SPA:

- WASM,
- Web Workers,
- local filesystem,
- local database engine,
- VS Code webview reuse.

SSR is not a primary requirement for the workbench itself.

A separate marketing/docs/control-plane application may use another framework later.

---

## 5. UI and Component Layer

Recommended:

```text
Radix UI
shadcn/ui
Tailwind CSS
Lucide
```

Principles:

- prefer headless primitives,
- keep product styling owned by the project,
- avoid becoming dependent on a component framework's layout model,
- prioritize keyboard and screen-reader accessibility from v1.

---

## 6. Grid Architecture

The grid is a core product surface, but should not own the dataset.

```text
Grid UI
   |
Grid Model
   |
GridDataProvider
   |
DataEngine / Remote Gateway
```

### Initial implementation

Use:

```text
TanStack Virtual
+
owned grid-core
+
DOM rendering
```

The owned `grid-core` should contain:

- viewport model,
- row/column coordinates,
- selection,
- editing state,
- keyboard commands,
- clipboard operations,
- column metadata,
- validation annotations,
- diff annotations,
- semantic cell types.

### Later

Introduce:

- canvas renderer for very dense views,
- DOM overlay editor,
- accessibility bridge,
- renderer plugins for nested structures,
- diff cells,
- quality cells,
- LLM conversation cells.

### Why not build the full grid immediately

Production grids include large hidden complexity:

- IME/CJK input,
- focus management,
- selection semantics,
- clipboard behavior,
- accessibility,
- keyboard navigation,
- variable dimensions,
- drag/reorder/resize,
- rendering performance.

The grid should be modernized incrementally behind our own interfaces.

---

## 7. Local Analytical Engine

### DuckDB-WASM

Use as the first analytical engine for SQL, filters, sorts, joins, aggregation, profiling,
Parquet/CSV/JSON querying, and multi-file logical datasets.

It stays behind the `DataEngine` interface; the authoritative target shape, its D13-pending
status, and the exact interface text live in
[architecture/01 §7](../architecture/01-architecture.md#7-data-engine-abstraction). That
abstraction exists because browser WASM constraints should not become product constraints.

---

## 8. Apache Arrow

Arrow is the preferred tabular interchange between:

- DuckDB-WASM,
- the UI data provider,
- parquet-wasm,
- future Rust engines,
- future DataFusion services.

Avoid moving large datasets around as:

```ts
Array<Record<string, unknown>>
```

unless the result set is intentionally small.

---

## 9. Parquet Layer

Use `parquet-wasm` where low-level file operations matter.

Potential responsibilities:

- metadata inspection,
- row groups,
- physical/logical schema,
- compression details,
- rewriting,
- optimization,
- format-specific diagnostics.

Conceptually:

```text
                 DataEngine
                     |
          +----------+----------+
          |                     |
     DuckDB-WASM           parquet-wasm
          |                     |
    logical queries         physical file
          |                     |
          +------ Arrow --------+
```

---

## 10. Worker Model

All expensive work should execute away from the UI thread.

```text
Main Thread
  |
  +-- React
  +-- Grid
  +-- interaction
  |
  v
Typed Worker RPC
  |
  +-- query worker
  +-- profile worker
  +-- validation worker
  +-- diff/hash worker
```

A light RPC library such as Comlink may be used initially, but application protocol types must remain independent from it.

---

## 11. Local Storage

### File System Access API

Use for user-approved source files and project directories where supported.

### OPFS

Use for:

- temporary analytical state,
- large local caches,
- derived artifacts,
- scratch databases.

### IndexedDB

Use for:

- preferences,
- lightweight metadata,
- handles,
- recent-workspace references.

Portable project semantics should remain in `.assay/` files (ADR 0039) rather than being trapped in browser storage.

---

## 12. Editor Layer

**Shipped today: a dependency-free textarea** (`apps/web/src/sql/SqlPanel.tsx`). **Recommended
upgrade: CodeMirror 6** — modular, lightweight relative to Monaco — for SQL, YAML contracts,
JSON, policy expressions, and transformation recipes, adopted once the editing surface justifies
it. **Alternative: Monaco**, only if richer IDE-style language services become central.

---

## 13. Validation and Contracts

Recommended stack:

```text
Zod/Valibot
  |
application/runtime schemas

Ajv
  |
JSON Schema interoperability

Native Contract AST
  |
dataset validation
```

Dataset contracts should compile to execution primitives such as:

- SQL checks,
- Arrow operations,
- JSON Schema checks,
- connector-native checks.

Do not use arbitrary embedded JavaScript or Python in the contract format.

---

## 14. Diff Engine

The high-level dataset diff engine should be product-owned.

Use libraries only for primitives.

Suggested components:

- DuckDB for aggregate/profile comparison,
- BLAKE3 or xxHash for fingerprints,
- jsondiffpatch for nested record presentation,
- product-owned schema/distribution/row diff logic.

Progressive strategy:

```text
metadata
   |
schema
   |
profile fingerprints
   |
partition fingerprints
   |
row-level diff
```

Expensive comparison should only occur when cheaper levels indicate meaningful change.

---

## 15. Visualization

Use Vega-Lite / Vega for:

- distributions,
- profiling,
- drift,
- quality summaries,
- diff summaries.

A declarative spec is preferred over arbitrary React chart code.

This also supports safe AI-generated visualization proposals.

---

## 16. VS Code

Use:

```text
TypeScript
VS Code Custom Editor
Webview
```

Reuse:

- `@assay/core`,
- `@assay/domain`,
- `@assay/ui`,
- `@assay/grid`.

VS Code-specific adapters should provide:

- workspace filesystem,
- Git context,
- editor commands,
- diff providers.

---

## 17. CLI

### Initial

TypeScript/Node CLI for speed of implementation and code reuse.

Example:

```bash
assay profile ./data
assay validate ./data
assay diff baseline.parquet candidate.parquet
```

### Later

A Rust-native CLI may be added where:

- binary distribution,
- startup time,
- huge local datasets,
- native threading,
- security requirements

justify it.

---

## 18. Desktop

Tauri is the preferred future desktop shell.

It allows:

- shared React/Vite UI,
- Rust-native engine access,
- full filesystem,
- credential storage,
- higher memory ceilings,
- native threading,
- offline enterprise deployment.

Desktop is not required for the initial MVP.

---

## 19. Enterprise Control Plane

Recommended:

```text
TypeScript API
PostgreSQL
```

Potential API frameworks:

- Fastify,
- Hono.

Responsibilities:

- organizations,
- users,
- workspaces,
- dataset metadata,
- comments,
- reviews,
- contracts,
- policy metadata,
- audit metadata,
- billing,
- approvals.

The control plane should not become the analytical data plane.

---

## 20. Enterprise Data Plane

Recommended:

```text
Rust
Axum
DataFusion
Arrow
object_store
```

Responsibilities:

- governed query execution,
- remote object-store reads,
- policy enforcement,
- filtering/masking,
- source connectors,
- streaming Arrow results,
- secure credential boundaries.

Remote sources may also use source-native query pushdown rather than DataFusion where that is preferable.

---

## 21. Authentication and Authorization

### Authentication

Use standard protocols:

- OIDC,
- OAuth2,
- SAML where needed,
- SCIM for enterprise lifecycle management.

Potential providers:

- Keycloak,
- WorkOS,
- Auth0,
- other enterprise identity providers.

### Authorization

Start with:

- simple RBAC,
- explicit resource ownership.

Evaluate:

- Cedar for attribute/policy authorization,
- OpenFGA for relationship-based authorization,
- OPA/Rego for broad policy scenarios.

Do not commit to multiple policy engines in v1.

---

## 22. Encryption

Use existing security infrastructure.

### Browser/local

- WebCrypto where local encryption is required.

### Enterprise

Adapters for:

- AWS KMS,
- Azure Key Vault,
- Google Cloud KMS,
- HashiCorp Vault.

Use:

- TLS,
- storage encryption,
- envelope encryption,
- BYOK where required,
- Parquet modular encryption where supported.

Never create custom cryptographic algorithms.

---

## 23. Observability

Recommended foundation:

- OpenTelemetry.

Optional integrations:

- Sentry,
- Prometheus,
- Grafana.

Telemetry must not include:

- raw rows,
- cell values,
- SQL result contents,
- secrets,
- PII.

Prefer operational metadata such as:

- operation,
- format,
- duration,
- approximate size bucket,
- success/failure,
- feature path.

---

## 24. Testing

### TypeScript

- Vitest,
- Playwright,
- fast-check.

### Rust

- cargo test,
- proptest,
- cargo-fuzz,
- criterion.

### Golden datasets

Maintain fixtures covering:

- malformed JSONL,
- deeply nested JSON,
- large Parquet,
- dictionary encoding,
- unusual logical types,
- schema drift,
- row diff,
- partitioned datasets,
- LLM datasets,
- encrypted/sensitive metadata cases.

---

## 25. What We Intentionally Do Not Build Initially

Do not build from scratch:

- SQL/query engine,
- Parquet parser,
- authentication server,
- cryptographic primitives,
- complete policy engine,
- chart engine,
- full grid renderer,
- distributed storage layer.

Own the product moat instead:

- dataset domain model,
- dataset-native UX,
- diff,
- contracts,
- validation,
- edit overlay,
- semantic views,
- Dataset Change Requests,
- policy translation,
- governance workflow.
