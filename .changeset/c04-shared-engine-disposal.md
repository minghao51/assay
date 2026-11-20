---
'@assay/engine-duckdb': patch
---

fix(c04): make every `DuckDbEngineClient.dispose()` caller await the same teardown settlement. The terminal-status short-circuit used to run _before_ the cached disposal promise was consulted, so a second (or racing) caller resolved immediately while the first caller was still in the graceful `engine/dispose` handshake and the `worker.terminate()` — a caller could then install a new engine instance while the old worker was still alive. `dispose()` now checks the in-flight disposal promise first and returns it on every re-entry, including one that arrives after the status is already `'disposed'`.

Unchanged: immediate terminal status and the pending-work rejection with `EngineDisposedError`, exactly one graceful request, the existing bounded `disposeTimeoutMs` (not touched), exactly one `worker.terminate()`, and honest propagation of a teardown failure to every caller (never swallowed). Covers dispose-before-boot and the boot/dispose race; a failed boot still cannot resurrect `'ready'`. Unit worker-fake coverage plus a real DuckDB-WASM e2e regression (two concurrent `dispose()` calls; the first must settle first) in `tests/e2e/engine-duckdb.spec.ts`.
