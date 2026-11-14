---
'@assay/engine-duckdb': patch
'@assay/web': patch
---

fix(r1-a): select the DuckDB-WASM bundle by capability and surface the engine's real error text (ADR 0048). The engine worker now ships both DuckDB-WASM pairs and picks `eh` when `WebAssembly.validate` accepts the package's own wasm exception-handling probe (`mvp` otherwise), so failures on EH-capable browsers reject with the engine's real first message line (`Catalog Error`, `Invalid Input Error: No magic bytes found at end of file`) instead of the `mvp` glue's `ReferenceError: _setThrew is not defined`. The e2e extension fixture serves the pinned binary for the requested platform tag (`wasm_eh` → `*.eh.pinned`) and the `wasm_eh` Parquet/JSON extension binaries are committed; user-visible failure text and open-failure classification now follow the engine (no `@assay/web` source change). Non-EH browsers keep the existing opaque-error fallback; no dependency, protocol or lockfile change.
