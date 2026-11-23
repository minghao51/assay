---
'@assay/engine-duckdb': patch
---

fix(r-12): refuse two type spellings the DuckDB binder refuses, at the client boundary instead of after a statement is composed.

A `TIMESTAMP` column type may carry a precision only in `0..9`: the pinned DuckDB 1.5.5 binder rejects `TIMESTAMP(10)` (`TIMESTAMP only supports until nano-second precision (9)`). A `TIME` column type takes no type parameter at all: `TIME(3)` is rejected (`Type 'TIME' does not take any type parameters`). Both spellings are now refused with the same typed client-side error as any other malformed type, instead of being interpolated into a cast and failing later at the engine. `TIME`, `TIME WITH TIME ZONE` / `WITHOUT TIME ZONE`, `TIMESTAMP`, `TIMESTAMP(0)` … `TIMESTAMP(9)` and every other type keep their current behaviour, and the existing general modifier range for the remaining types is unchanged.
