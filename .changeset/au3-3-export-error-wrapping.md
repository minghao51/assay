---
'@assay/engine-duckdb': patch
---

fix(au3-3): map every engine-touching step of the export/rewrite path to the
value-free failure class `the view could not be exported` before it is posted,
instead of forwarding the raw engine text. The arrow SELECT drain, the COPY
statement, the defensive fallback count, and the wasm-side byte read all go
through the same q-8 `validationStep` discipline as the other overlay ops:
DuckDB conversion/binder errors can embed offending cell values or the composed
statement, so the raw text never leaves the worker (ADR 0025). Composer output
stays outside the wrap (its errors are already fixed, value-free strings), and
the `dropFile` cleanup seam is unchanged. Tests: hostile-value probes pin the
class-only protocol reply for the COPY, arrow-drain, and fallback-count steps;
the former raw byte-read passthrough pin now expects the class.
