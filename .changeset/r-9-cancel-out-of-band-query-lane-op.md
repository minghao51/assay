---
'@assay/engine-duckdb': minor
'@assay/web': patch
'@assay/testing': minor
---

feat(engine-duckdb): cancel is an out-of-band query-lane op that settles the
parked query as a typed `cancelled` outcome (R-9 / ADR 0052).

The engine protocol gains one additive request, `engine/cancel-query`, which
names the parked `engine/query` it targets (both ids are engine request ids;
an absent, malformed or extra field is refused at parse time — value-free and
before anything touches DuckDB). Its answer, `engine/cancel-query-result`,
carries the connection's own `cancelSent()` boolean unchanged: `true` means the
engine had a pending query and cancelled it, `false` means nothing was pending.
The parked op settles through the new `engine/query-cancelled` response, so the
client resolves a typed `cancelled` result — no rows, `hasMore: false`, never a
masked engine error. Delivered rows are never retracted.

The worker handles the cancel **out of band**: it calls the query-lane
connection directly instead of taking a slot in that lane's single-pending
queue, so it cannot queue behind the query it cancels. Scope is `engine/query`
only — a cancel that arrives while a non-query op (export, profile scan,
pipeline materialisation, validation, diff, preview) holds the lane is refused
with a typed, value-free error rather than attempted, and a cancel naming an op
that is no longer parked answers `cancelSent: false` without touching the
connection. No other op's lane routing changes.

`DuckDbEngineClient` gains `cancelQuery(queryRequestId?)` (omitted: the most
recent in-flight query; nothing in flight resolves `{ cancelSent: false }`
without sending anything) and `EngineQueryResult` gains the optional
`cancelled: true` marker. `@assay/web`'s SQL panel sends the cancel **after**
it has abandoned the run — the RunGuard invalidation, the cancelled state and
the `query_run{cancelled}` emit are unchanged, and a refused or throwing cancel
cannot unwind them. The Cancel copy is byte-identical and no duration is
promised anywhere.

`@assay/testing`'s conformance surface gains `cancelQuery()` plus
`ConformanceBatchResult.cancelled`, and a `query-cancel` scenario (parked query
cancelled mid-flight → typed outcome, reusable connection, honest
`cancelSent: false` when nothing is pending). The fake engine's `ignoresCancel`
mutation proves the scenario bites.
