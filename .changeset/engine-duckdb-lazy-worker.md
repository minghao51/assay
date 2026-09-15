---
'@assay/engine-duckdb': minor
---

Add `@duckdb/duckdb-wasm` (stable 1.32.x, `mvp` browser bundle) and a lazy engine bootstrap: the first use boots DuckDB inside a dedicated Web Worker behind a typed postMessage protocol owned by `@assay/engine-duckdb` (ADR 0002/0021; no RPC library). Smoke queries return bounded scalar results — the Arrow record-batch transport lands with M1-2 (ADR 0020).
