---
'@assay/web': patch
---

perf(q-1): precompute each column's parsed DuckDB type once per schema (memoized parser + a per-schema parsed-type array threaded through editor kind, decimal, and object formatting) and narrow App's model subscription to the schema/sort/filters slices, so a viewport fetch notify no longer re-renders the whole panel tree.
