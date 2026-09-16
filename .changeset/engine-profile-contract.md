---
'@assay/engine': minor
---

feat(m2-5): profiling contract — `ColumnProfile` gains a `kind` discriminator (`numeric` / `categorical` / `other`) with kind-specific payloads: `NumericColumnStats` (min/max/mean/stddev plus exact p50/p90/p95/p99 quantiles, each finite-or-null) for numeric columns and `CategoricalColumnStats` (ordered top-k as rendered text + exact counts, ties by value ascending, NULLs excluded) for scalar non-numeric columns; nested/exotic types degrade gracefully to name/type/nullCount/distinctCount only (never a throw). `nullCount`/`distinctCount` stay on every column; `DatasetProfile` carries the total rowCount. Plain, portable data — engines classify from their own type strings and every number is a finite JSON number or `null`.
