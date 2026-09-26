---
'@assay/engine-duckdb': patch
---

fix(q-8): map every DuckDB error on the edit-overlay materialization path
(schema, row-count, window, and the cast check) to the single value-free
failure class `the edited view could not be materialized` before it is posted,
instead of forwarding the raw engine text. DuckDB conversion/binder errors can
embed offending cell values or the composed statement, so the raw text never
leaves the worker (ADR 0025); the web edit session renders the readable class
and the failed op still rolls back to the previous effective view. The
conformance `committedCastFails` ground-truth probe recognizes the class as the
conversion-rejection signal. Tests: a quote-laden hostile-value probe is
class-only at the protocol reply for the window, schema, and cast-check ops; the
web renders the class with no value fragment and restores the previous view; the
existing m4-3 e2e pin moves from the old `the column's type rejected the value`
glue translation to the class.
