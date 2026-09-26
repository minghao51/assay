---
'@assay/domain': patch
'@assay/grid': patch
'@assay/web': patch
---

chore(q-7): tooling-strictness slice 1 — ESLint now errors on `console.*` in
package/app source, detects import cycles across `packages/**` and `apps/**`
(via `eslint-plugin-import-x`'s `import/no-cycle`), and enforces purity
boundaries on Node builtins, browser-only globals, and `fetch` for
`domain`/`grid`/`core`/`ui`. `packages/domain` and `packages/grid` adopt
`noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` and fix the fallout
inline (domain cursor-boundary reads degrade to `null`; grid row pages iterate
their entries instead of indexed reads). `@assay/web`'s error boundary carries
a targeted, commented `no-console` allowlist for its value-free diagnostic
sink. Strictness for `packages/testing` (which pulls contracts/diff/validation
sources through its program) is deferred to the q-7 slice-2 remainder.
