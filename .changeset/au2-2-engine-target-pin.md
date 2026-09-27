---
'@assay/engine-duckdb': patch
'@assay/engine': patch
---

test(au2-2): interim compiler-enforced `@assay/engine` target compatibility pin (D13-pending). New type-level `engine-target-compat.test.ts` turns engine-duckdb's prose "structurally compatible with @assay/engine" claims into compile-time assertions: table-handle identity, the schema cell, and the profile leaf types are pinned in both directions; `@assay/engine`'s `DatasetProfile` → engine-duckdb's readonly `EngineDatasetProfile` is pinned positively; and the documented divergences (the readonly profile container, `open`/`query`/`profile`/`exportView` versus `DataEngine`, and `DuckDbEngineClient` not satisfying `DataEngine`) are pinned as `@ts-expect-error` negatives, so both drift and reconciliation fail `pnpm typecheck`. `@assay/engine-duckdb` also adds a type-only devDependency on `@assay/engine` and documents its shared harness/library `dist/`; `@assay/engine` moves its type-only `@assay/data-sources` dependency from `dependencies` to `devDependencies`. No runtime behavior change.
