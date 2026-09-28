# @assay/engine-duckdb

DuckDB-WASM implementation of Assay's `DataEngine` — the primary engine
(ADR 0002). DuckDB runs inside a Web Worker (ADR 0021); query results cross
the main-thread boundary as Apache Arrow record batches (ADR 0020) over this
package's own typed `postMessage` protocol (no RPC library — the protocol
stays swappable).

- **Status:** part of the Assay monorepo — the real engine the web app and CLI
  execute against; workspace-private for now.
- **API surface:** [`src/index.ts`](src/index.ts) is the browser/public entry;
  [`src/node.ts`](src/node.ts) is the environment-neutral seam (see below).
- **Repository:** [Assay monorepo](../../README.md).

## Entry points

- **`@assay/engine-duckdb`** (`src/index.ts`) — the browser surface:
  `DuckDbEngineClient`, the typed protocol parsers, and the worker-backed
  query/range/profile/overlay/validate/row-diff helpers. The worker entry
  (`src/worker.ts`) is loaded by the client via
  `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`
  and is intentionally not part of the main-thread surface.
- **`@assay/engine-duckdb/node`** (`src/node.ts`) — the environment-neutral
  seam (m5-4): the pure, host-free half of the engine (validate/row-diff/
  profile SQL composition, wire validators, result readers) re-exported for
  NON-BROWSER hosts such as the CLI's Node executor and its agreement tests.
  It deliberately excludes the worker client/protocol modules. Additive
  re-exports only — no behavior.

## Builds and `dist/`

`dist/` is shared by two builds (see [`vite.config.ts`](vite.config.ts)):

- `vite build` bundles the M1 e2e/conformance harness (plus the engine worker
  and the DuckDB-WASM assets referenced via `?url`) into `dist/`, served by
  the root Playwright config on port 4179.
- `tsc --build tsconfig.build.json` emits the library at the `dist/` root.

The `files` globs in [`package.json`](package.json) are flat (non-recursive)
deliberately: they match only the library's top-level emit and exclude the
harness's nested output (e.g. `assets/`), so a packed tarball stays
library-only (au2-2 pack finding). During development the library surface is
consumed directly as TypeScript source via `exports`.

## Harness (M1 e2e + conformance)

`harness/` builds the engine proof page — lazy worker boot and the first
Arrow batch (M1-1/M1-2) — and hosts the shared engine conformance suite from
`@assay/testing` via [`harness/conformance-subject.ts`](harness/conformance-subject.ts).
The root Playwright config serves it on port 4179; see
`tests/e2e/engine-duckdb.spec.ts` and `tests/e2e/engine-conformance.spec.ts`.

## License

[AGPL-3.0-or-later](../../LICENSE) — decision record: [ADR 0036](../../docs/adr/0036-agpl-license.md).
