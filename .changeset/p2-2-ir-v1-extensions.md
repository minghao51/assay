---
'@assay/pipeline': minor
---

feat(p2-2): IR v1 extensions (pure) — materialization field + reserved-node shape settlement

Per ADR 0033, every data-port node (`source`, `transform`, `sql`) accepts an
optional `materialization` mode from the seven logical modes
(`ephemeral`/`view`/`table`/`cache`/`incremental`/`export`/`publish`);
**absent means `view`** (the P1 session-view behavior), the AST keeps the
field optional so absent stays absent, and `materializationOf(node)` reads the
effective mode. Gated nodes (`validate`/`diff`/`publish`) reject the key.

Per the p-1 carry-over, the diff node's opaque body is replaced by the settled
typed shape `{ input, against }` — both table references, both consumed as
data ports by DAG validation; unknown keys and missing/ill-typed references
are typed, located parse errors. `validate` (`{ input, contract }`) and
`publish` (`{ input, requires? }`) shapes are unchanged and now pinned.

Additive only: the IR version stays 1, every existing fixture still parses to
the same AST and serializes to the same bytes, and the canonical codec,
property generators, and golden fixtures are extended with the new field and
shape. No dependency, engine, CLI, or web changes.
