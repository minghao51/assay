---
'@assay/engine-duckdb': patch
---

feat(m1-5): add `rowCount(handle)` — the total row count of a registered table via a metadata-only `SELECT count(*)::BIGINT` (no data read), transported as a new typed protocol message (`engine/row-count` / `engine/row-count-result`) alongside the existing ones. The worker re-checks the value's shape (safe non-negative integer) before replying, and the protocol parser rejects anything else on the main-thread side. Virtualized grids need a total to size the scroll area without implying full-dataset materialization.
