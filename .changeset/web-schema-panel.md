---
'@assay/web': minor
---

feat(m1-6): schema panel with a navigable DuckDB type tree beside the grid. Adds a total (never-throwing) recursive-descent parser for the type strings the engine's `schema()` passes through (m1-4) — structs expand/collapse via accessible disclosure buttons (`aria-expanded`/`aria-controls`, risk R8), lists render their element type plus dimension suffix (`VARCHAR[]`, `INT[2][3]`), parameterized primitives (`DECIMAL(21,1)`) and multi-word names (`TIMESTAMP WITH TIME ZONE`) render as type badges, and anything unparseable (future/unknown types, malformed strings) degrades gracefully to a displayable untyped leaf. The panel is toggleable, surfaces the column count, and receives only schema names/types — never a file name (ADR 0025). Proven in e2e against the committed `fixtures/parquet/nested.parquet` (payload struct tree: geo → lat/lon `DECIMAL(21,1)`, tags list-of-VARCHAR, scores → q1/q2) and the flat `customers.parquet`.
