# ADR 0040: Two Op Lanes in the Engine Worker (Query Lane + Registry Lane)

## Status

Accepted (2026-09-17)

Supersedes the scheduling note in `packages/engine-duckdb/src/op-channel.ts` (T2, 2026-09-15): the single-FIFO choice was recorded there as provisional pending interactive queries; M2 shipped them (SQL editor + profiling), the revisit this ADR records is the m2-7 task.

## Context

Since T2 (2026-09-15), every engine-duckdb connection-touching op flows through one FIFO `OpChannel` — one pending query per DuckDB connection at a time (duckdb-wasm 1.32 constraint, recorded in T2). That preserved correctness (no pending-query collisions, error isolation) but introduced head-of-line latency: any long op delays every queued op behind it.

M2 made this user-visible (measured in `tests/e2e/engine-head-of-line.spec.ts`, mvp bundle, medians of repeats): with a ~2.5 s user SQL query running, grid `fetchRange`/`rowCount`/`schema` ops waited ~2.36 s median (~96% of the query's duration; ~400–1400× their 2–6 ms idle baselines). Users scrolling while a query or profile scan runs would see multi-second stalls.

Constraints: T2's guarantees must hold (per-connection single pending query; one op's error never corrupts another; graceful dispose); the typed postMessage protocol and the Arrow first-batch transport (ADR 0020/0021) should not change; everything stays inside the existing single Web Worker (ADR 0021).

## Decision

The engine worker runs **two DuckDB connections, each with its own serialized `OpChannel` ("lane")**, and routes op classes to lanes:

- **Query lane** — `engine/query` (user SQL) and `engine/profile` (profiling scans): the long-running, user-initiated ops.
- **Registry lane** — `engine/open`, `engine/schema`, `engine/range`, `engine/rowCount`, `engine/dispose`: the interactive, metadata/window ops the grid needs.

Routing is worker-internal (wire protocol unchanged); each lane's connection is derived from the lane (`OpLane` bundles channel + connection) so routing and connection choice cannot diverge. `dispose` places a barrier on the query lane so in-flight queries settle before views drop, bounded by the existing client dispose timeout.

## Consequences

### Positive

- Head-of-line cost becomes duration-decoupled: measured waits behind a running query drop from ~2.36 s to ~0.21–0.62 s (fetchRange/rowCount/schema medians 208/511/615 ms), flat while the query's own duration varied 2.4–3.5 s; the query itself is unaffected.
- T2 guarantees preserved and pinned per lane: collision-throwing fake tests assert both lanes stay collision-free; error isolation per lane; dispose barrier deadlock-free (the query lane never awaits the registry lane).
- No protocol, client, or transport change; conformance suite (10 scenarios) passes unchanged.

### Negative / risks

- Two connections double some per-op scheduling state; residual ~0.2–0.6 s interactive waits under a running query are mvp-bundle-bound (single nested DuckDB worker task/poll granularity) — shrinking further means the eh-bundle swap, which stays a recorded option, not a decision.
- No query interrupt exists: an abandoned user query still occupies the query lane (the web SQL pane's cancel is UI-level abandonment, m2-4). A true interrupt would need connection-level cancellation or a third lane — future work, deliberately not decided here.
- Registry-mutating ops (open/dispose) remain serialized on their lane; a second concurrent file open still queues behind the first.

### Neutral

- Profile deliberately sits on the query lane: it must never block grid windows, and its scans are query-like in cost.
- Per-op connections (the other T2-recorded option) remain rejected: same rationale as T2 (unbounded connection growth, no ordering guarantees).

## Alternatives considered

- **Status quo (single FIFO)** — rejected on measurement: ~2.36 s median interactive waits behind one user query.
- **Op priority / preemption** — not viable without connection-level cancellation in duckdb-wasm; out of scope.
- **Per-op connections** — still rejected (T2 rationale unchanged).
