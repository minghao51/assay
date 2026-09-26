---
'@assay/engine-duckdb': patch
---

perf(engine-duckdb) q-6: session cost budgets, insert-branch cap, compose/sort-key guards.

- Module docs now state the session-bounded engine costs (AR-E10): per-insert `UNION ALL` branches, deep-offset windows, effective-order sorts, and the composer's edit-map scan — each with the measured basis.
- Live-insert branches are capped at `MAX_OVERLAY_LIVE_INSERT_BRANCHES` (500) with the typed, value-free `OverlayLiveInsertLimitError` (the DuckDB-WASM `mvp` bundle aborts at ≥1000 branches; 500 is half the observed hard-failure boundary and far above realistic sessions). Composed SQL below the cap is byte-identical.
- `baseColumnEdits` is grouped once per compose by effective column (was O(columns × edited rows)); `insertSortKeys` shares one DFS path stack instead of copying the prefix per edge. Both are behavior-identical (existing byte pins unchanged).
