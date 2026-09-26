---
'@assay/domain': patch
'@assay/grid': patch
'@assay/validation': patch
---

chore(q-13): upgrade vitest and the `@vitest/*` runtime from 3.2.7 to 4.1.11 across the workspace catalog, clearing GHSA-82fw-gwwq-j7x9 (Path Traversal / Arbitrary File Read via the `@vitest/mocker` redirect mock). Dev-only workspace change: no runtime dependency changes and no published artifact changes, except that the `vite` 7 copy vitest 3 pinned is dropped in favour of the workspace's vite 8. The vitest 4 major no longer leaks Node's ambient globals into test files: `@assay/validation` declares `@types/node` (its gated real-DuckDB tests import node builtins) and `@assay/domain`/`@assay/grid` tests declare the platform `structuredClone`/`setTimeout` globals locally (type-only; no assertion changes).
