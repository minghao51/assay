---
'@assay/engine-duckdb': patch
---

fix(m3-1): harden the profile column classifier against fixed-size-array type strings — `classifyProfileColumnType` now scans the type string structurally (bracket- and quote-aware single pass) instead of substring matching: any top-level array dimension (`INTEGER[]`, and fixed-size `INTEGER[2]`, `VARCHAR[4]`, `DECIMAL(21,1)[3]`, `STRUCT(a INTEGER)[2]`, `INTEGER[2][3]` — DuckDB 1.5.5 DESCRIBE spellings) classifies the column as `other` before any paren-stripping, so a parameterized-base fixed-size list can no longer reduce to `DECIMAL` and misroute a LIST column into the numeric aggregate path (where its `avg()`/`quantile_cont()` binder error would escape `profile()`). Hostile near-misses (unbalanced/stray brackets, unterminated quoted identifiers, dimensions inside parens) degrade to `other`; the never-throws contract is unchanged, and scalar classifications (`DECIMAL(21,1)`, `TIMESTAMP WITH TIME ZONE`, …) are preserved.
