---
'@assay/engine-duckdb': patch
---

feat(t2): worker-side operation serialization — every engine request now runs through a single pending-query channel in the worker (`EngineOpExecutor` + `OpChannel`), since duckdb-wasm 1.32 polls one pending query per connection; concurrent `query`/`fetchRange`/`rowCount`/`schema`/`open`/`dispose` calls can no longer collide on the shared connection (misattributed result batches, opaque `_setThrew`-style failures). One operation's error is always delivered to its own caller, the channel drains through failures (never wedges), dispose runs FIFO after in-flight ops settle, and first-batch Arrow transport (ADR 0020) plus reader/cancelSent cleanup are unchanged. Deterministic fake-connection concurrency unit tests assert no-overlap (the fake connection fails the test if two ops are ever pending at once), and a parallel-calls harness scenario + e2e prove four concurrent calls settle correctly against real DuckDB-WASM in Chromium.
