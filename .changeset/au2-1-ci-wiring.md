---
'@assay/contracts': patch
'@assay/domain': patch
'@assay/diff': patch
'@assay/grid': patch
'@assay/validation': patch
'@assay/engine-duckdb': patch
---

Packaging hygiene (audit au2-1): every entry index is a pure re-export
module, so all six packages now declare `sideEffects: false` — consumers'
bundlers can tree-shake and skip evaluation of untouched entry modules once
these ship. Verified empirically by the pack-consumer smoke (ar-5), which is
now wired into CI alongside `format:check` and `adr:index:check` (both were
honor-system before this change).
