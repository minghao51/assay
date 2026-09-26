---
'@assay/web': patch
---

fix(pt0-4): the two a11y defects the new axe-core e2e scans caught, fixed at the root. The grid's per-row delete control now lives in a `role="gridcell"` container, so every `role="row"` has only conforming children (axe `aria-required-children` critical ×N per surface; the grid's `aria-colcount` already counted the trailing actions column and no explicit `aria-colindex` is used, so DOM-order indexing stays correct with no other markup change). The filter bar's "No active filters" text goes `#777` → `#555` (the adjacent `.filter-hint` value): 4.29:1 failed AA for its size, 7.14:1 passes. Both findings now gate: the new `tests/e2e/a11y.spec.ts` scans grid, schema tree, validation panel, and diff panel with an empty deferred-findings allowlist, plus a non-vacuity canary (an injected nameless button must be reported). E2e count 131 → 136 (+1 env-gated skip unchanged).
