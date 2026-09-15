---
'@assay/engine-duckdb': patch
---

test(t1): wire the data-engine conformance suite into the engine-duckdb browser harness — a DuckDB subject adapter (typed error-class matchers, OPFS staging of the golden fixture + runtime-built wide CSV + suite-truncated corrupt Parquet, DuckDB-specific SQL hooks incl. a deterministic mid-stream failure query) plus one harness button per scenario; `tests/e2e/engine-conformance.spec.ts` runs all seven scenarios against the real DuckDB-WASM client in Chromium and asserts each scenario's result and evidence facts.
