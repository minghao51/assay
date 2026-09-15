---
'@assay/engine-duckdb': minor
---

feat(m1-2): `query()` now returns the first Apache Arrow record batch to the main thread (ADR 0020). The worker streams the query via DuckDB's record-batch API, serializes the first batch to an Arrow IPC stream, and transfers its buffer zero-copy over the owned postMessage protocol (ADR 0021 — no RPC library; Comlink rejected so the transfer list stays under our control). `hasMore` reports honestly when further batches were discarded (full streaming is a later task). The temporary bounded scalar-row surface from m1-1 (`EngineQueryResult.rows`, `MAX_RESULT_ROWS`, `QueryCell`) is removed; results must be read through the Arrow API.
