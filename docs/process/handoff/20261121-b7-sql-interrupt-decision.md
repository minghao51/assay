# B7 decision request — SQL true interrupt / second connection

**Date:** 2026-11-21. **Status:** DECISION REQUEST — design only; no implementation authorized.
Subject: PT-H carry-over B7 ([successor queue](20261121-successor-queue.md) §3 B7;
[post-MVP §6](../../product/04-post-mvp-track.md#6-pt-h--hardening--backlog-inventory-recorded-carry-overs)).
This record enumerates options and costs for the maintainer; selecting an option does not by
itself authorize code — see the stop conditions in §5.

## 1. Verified current behaviour (at this revision)

| Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Evidence                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Cancel is UI-level abandonment, nothing more.** It invalidates the run's generation token, shows a `Cancelled` state, and emits `query_run` with `outcome: 'cancelled'`; it sends nothing to the engine                                                                                                                                                                                                                                                                                           | `apps/web/src/sql/SqlPanel.tsx:253-264`; token mechanics `apps/web/src/sql/run-guard.ts:17-41`                                                                                                                                                                                                                                                                     |
| The late result is discarded, never rendered: a cancelled/superseded run's result or rejection never reaches the handlers                                                                                                                                                                                                                                                                                                                                                                           | `apps/web/src/sql/guarded-run.ts:25-40` (pinned by `guarded-run.test.ts`, per its header)                                                                                                                                                                                                                                                                          |
| **Why it cannot interrupt: the wire has no cancel/interrupt op.** The request union is init → dispose with no cancellation member; the client `send()` awaits a response with no abort path                                                                                                                                                                                                                                                                                                         | `packages/engine-duckdb/src/protocol.ts:466-488`; `packages/engine-duckdb/src/client.ts:416` (`engine/query`), no `AbortController` anywhere in `apps/web/src/sql/**` or `packages/engine-duckdb/src/**` (grep, 2026-11-21)                                                                                                                                        |
| **What queues behind a running query:** every query-lane op — `engine/query`, `engine/profile`, `engine/export`, `engine/overlay-cast-check`, `engine/validate`, `engine/diff-stage`, `engine/diff`, `engine/pipeline-*`, `engine/csv-preview` — serializes on one DuckDB connection (one pending query per connection, the T2/duckdb-wasm 1.32 constraint). A follow-up Run or a next result page queues behind the abandoned query; the registry lane (grid windows) is unaffected since ADR 0040 | `packages/engine-duckdb/src/engine-executor.ts:343-362` (lane routing), `:384-387`; `packages/engine-duckdb/src/op-channel.ts:1-12`; `apps/web/src/sql/SqlPanel.tsx:30-38` ("A follow-up Run still works — it queues behind the abandoned query"); paging is web-side LIMIT/OFFSET composition re-issued as fresh queries, `apps/web/src/sql/paged-query.ts:72-81` |
| **Existing timeout/abort:** the only engine timeout is the 5 s dispose handshake (`DEFAULT_DISPOSE_TIMEOUT_MS`); there is no query timeout. The one engine-level "cancel" is `cancelSent()` after the **first batch**, used to free the connection from a discarded result tail — not a mid-query interrupt                                                                                                                                                                                         | `packages/engine-duckdb/src/client.ts:366`, `:259-263`; `packages/engine-duckdb/src/engine-executor.ts:1984-2013` (stream-first-batch + `cancelSent` at `:2011`)                                                                                                                                                                                                   |
| The current Cancel copy already tells the truth: "The engine has no query interrupt, so this query may still run to completion in the background (a following run queues behind it); its result is discarded and will not be shown."                                                                                                                                                                                                                                                                | `apps/web/src/sql/SqlPanel.tsx:353-358`; design note `apps/web/src/sql/SqlPanel.tsx:30-38`                                                                                                                                                                                                                                                                         |
| ADR 0040 deliberately left this undecided: "No query interrupt exists… A true interrupt would need connection-level cancellation or a third lane — future work, deliberately not decided here"                                                                                                                                                                                                                                                                                                      | [ADR 0040](../../adr/0040-two-op-lanes-in-engine-worker.md) "Consequences/Negative"                                                                                                                                                                                                                                                                                |
| Telemetry already admits a `cancelled` outcome for `query_run` (closed enum `success`/`error`/`cancelled`) — any option can report cancellation without a schema change                                                                                                                                                                                                                                                                                                                             | [06-telemetry-design.md](../../engineering/06-telemetry-design.md) §3.9                                                                                                                                                                                                                                                                                            |

**Platform probe (verified API, unverified effect):** the pinned `@duckdb/duckdb-wasm@1.32.0`
(`pnpm-lock.yaml:631`) exposes `AsyncDuckDBConnection.cancelSent(): Promise<boolean>` — "Cancel a
query that was sent earlier" — delegating to the `cancelPendingQuery(conn)` binding
(`node_modules/.pnpm/@duckdb+duckdb-wasm@1.32.0/node_modules/@duckdb/duckdb-wasm/dist/types/src/parallel/async_connection.d.ts:24-26`,
`.../parallel/async_bindings.d.ts:94`; the `CANCEL_PENDING_QUERY` task is visible in the bundled
`dist/duckdb-browser.mjs`). The repo's connection seam already carries `cancelSent`
(`packages/engine-duckdb/src/executor-context.ts:54`). **Unverified:** whether `cancelPendingQuery`
interrupts a query still computing _before_ the first batch (the only in-repo use is post-first-
batch tail cleanup, `engine-executor.ts:2011`), the error a parked `send()` surfaces after a
cancel, and whether the connection is immediately reusable. Do not assume any of these.

## 2. Options (all DESIGN-ONLY; each names its ADR answer)

### (a) Second connection/worker for read-only queries

Route user SQL (and optionally other heavy scans) onto a dedicated connection so an abandoned
query occupies only its own connection.

| Dimension                   | Assessment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine/lane contract change | Yes — extends ADR 0040's two-lane routing to a third connection/lane ("a third lane" is exactly ADR 0040's named future work). **Requires an ADR.**                                                                                                                                                                                                                                                                                                                                                                          |
| Wire / persisted format     | None — routing is worker-internal (ADR 0040 precedent); but the "read-only" claim needs enforcement that does not exist today (`engine/query` sends SQL verbatim, `client.ts:416`; the pane's wrap constrains but is not a security boundary, `paged-query.ts:15-22`)                                                                                                                                                                                                                                                        |
| Memory cost                 | One more DuckDB connection state plus the real risk of two concurrent heavy scans (abandoned query + profile) doubling peak memory — magnitude unmeasured here                                                                                                                                                                                                                                                                                                                                                               |
| Failure modes               | **No interrupt** — the abandoned query still runs to completion; "Cancel" would still stop nothing. Read/write ordering now spans two connections (a new interleave for any write-shaped callers). Partially-consumed result: unchanged (tail discarded, `engine-executor.ts:2002-2012`). Registry handles: shared catalog — a close/drop on one connection while the other scans is a new race surface. Page mixtures: pages keep re-issuing LIMIT/OFFSET queries and would at least stop queueing behind the abandoned run |
| Testability                 | Extend the head-of-line e2e pattern (`tests/e2e/engine-head-of-line.spec.ts`); add two-connection interleave tests                                                                                                                                                                                                                                                                                                                                                                                                           |
| ADR                         | **Yes** — amends ADR 0040's lane contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

### (b) Cooperative cancel via the DuckDB cancel API (exists in the pinned version — effect unverified)

A `engine/query-cancel` (name open) request that reaches the query connection **out of band**
(it must not queue behind the query it cancels) and calls `cancelSent()`/`cancelPendingQuery` on it.

| Dimension                   | Assessment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine/lane contract change | Yes — one new request type, out-of-band dispatch to the query-lane connection (the OpChannel single-pending rule cannot apply to the cancel itself), and a defined cancelled outcome for the parked op. **Requires an ADR** (engine contract + ADR 0040's "deliberately not decided here" clause)                                                                                                                                                                                                                                                                                                                                                                                                    |
| Wire / persisted format     | Additive request/response types only (`protocol.ts` union + parse); no persisted-format change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Memory cost                 | Negligible (one control call)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Failure modes               | **All hinges on the unverified platform claim** (§1): if `cancelPendingQuery` does not interrupt mid-compute, this degrades to option (c) with extra machinery. Partially-consumed result: the parked op must settle as an honest `cancelled` outcome (the telemetry enum already has it, 06-telemetry-design.md §3.9), never as a masked engine error. Registry handles: untouched. In-flight writes/edits: query-lane writes (export COPY, pipeline materialisation) would become interruptible mid-write — scope must decide which ops are cancelable (§4 Q2). Page mixtures: none — the RunGuard discards the cancelled run's result (`guarded-run.ts:25-40`) and the next page is a fresh query |
| Testability                 | Real-engine probe first (does the parked `send()` settle? how? is the connection reusable?); then conformance + wire-refusal tests; a mutation drill on the out-of-band dispatch path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ADR                         | **Yes**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### (c) Status quo with copy honesty (zero-change floor)

Keep UI-level abandonment. The copy is **already honest** (`SqlPanel.tsx:353-358` quotes no
interrupt, background completion, queued follow-up, discarded result).

| Dimension                   | Assessment                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Engine/lane contract change | None                                                                                                                                       |
| Wire / persisted format     | None                                                                                                                                       |
| Memory cost                 | None                                                                                                                                       |
| Failure modes               | Unchanged: a pathological query can occupy the query lane indefinitely (no query timeout exists, §1); all query-lane work queues behind it |
| Testability                 | The copy is already pinned by tests; nothing new                                                                                           |
| ADR                         | **No**                                                                                                                                     |

### (d) Hard-terminate / recreate the worker

Cancel = `dispose()` the engine and boot a fresh one, re-opening the dataset.

| Dimension                   | Assessment                                                                                                                                                                                                                                                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine/lane contract change | No new op, but session semantics invert: `dispose` is terminal, wired to unload events "exactly once" (`App.tsx:1150-1171`) and the client is a module singleton (`apps/web/src/lib/engine.ts:9`)                                                                                                                                |
| Wire / persisted format     | No wire change; but the table-id sequence restarts, so `assay_t1` can come to denote a different table — stale UI references (SQL hint, saved pages) can silently rebind (**page-mixture hazard**)                                                                                                                               |
| Memory cost                 | Full WASM re-instantiation (unmeasured — unknown) and a transient spike; every view/file registration dies (`engine-executor.ts:1923-1950`)                                                                                                                                                                                      |
| Failure modes               | All in-flight ops fail; staged comparison and every ADR 0047 retained table are reclaimed (consistent with ADR 0047's "until the worker is torn down"); session rebuild must re-open the file (File handle retention needs checking); export/OPFS writes mid-flight unverified; also entangles the open U-1 hung-engine question |
| Testability                 | E2E-heavy (reboot journeys, state rebuild)                                                                                                                                                                                                                                                                                       |
| ADR                         | **Yes** (worker/session lifecycle)                                                                                                                                                                                                                                                                                               |

## 3. Recommendation (a recommendation, not a decision)

**Cheapest defensible option: (b), gated on one bounded probe — with (c) as the standing floor
until the probe answers.** Reasoning: (b) is the only option that delivers the stated goal (a true
interrupt) without restructuring lanes or destroying the session; its cost is one additive wire op
plus out-of-band dispatch. Its deliverability rests entirely on the unverified platform claim in
§1, so the probe is step zero, not step ten. If the probe fails or is ambiguous, the
recommendation **falls back to (c)** — which requires no work and is already truthful.

Rejected alternatives and why: **(a)** is isolation, not interruption — it leaves every promise of
the word "Cancel" unmet while amending ADR 0040 and adding a concurrent-scan memory risk; it is
worth considering only if the maintainer's actual goal is head-of-line relief for profile/validate
rather than stopping the user's query. **(d)** destroys the working session to kill one query; its
only unique virtue is bounding pathological CPU use, which no other option promises.

## 4. Acceptance questions the maintainer must answer

1. Is the goal **stopping the compute** (→ (b)) or **unblocking other work** (→ (a))? The word
   "interrupt" promises the former.
2. If (b): what is the cancel scope — `engine/query` only, or every query-lane op (profile,
   validate, diff, export, pipeline)? An interrupted export/pipeline write has different failure
   semantics than a discarded SELECT.
3. Is an additive wire op acceptable (protocol tests + `@assay/engine-duckdb` changeset)?
4. Cancel copy: keep the current copy unchanged (default, and required unless this option is
   explicitly selected) or re-select copy only once an interrupt demonstrably lands?
5. What is the cancelled op's outcome — a typed `cancelled` outcome (preferred; telemetry enum
   already has it) or an error string?

## 5. Stop conditions (exact)

- **ADR needed:** options (a), (b) and (d) each require an ADR before any implementation (per §2);
  stop and draft it rather than coding from this record. Option (c) needs nothing.
- **Engine contract change:** any new wire request/response or lane-routing change stops the task
  for an ADR + changesets first.
- **Unverified platform claim:** the mid-execution effect of `cancelPendingQuery` in duckdb-wasm
  1.32.0 (§1) is unverified — stop and probe on the pinned bundle before selecting (b); never
  implement on the assumption it interrupts.
- **Copy freeze:** no change to the current Cancel copy (`SqlPanel.tsx:353-358`) unless the copy
  option (Q4) is explicitly selected.

## 6. What is NOT claimed / preserved invariants

- **No claim of interrupt exists today.** Cancel is UI-level abandonment and nothing else
  (`SqlPanel.tsx:253-264`; `run-guard.ts:6-16`). This record does not change that.
- **No recall of already-returned rows.** Pages already delivered to the pane stay rendered under
  every option; cancellation can only discard late results (`guarded-run.ts:25-40`), never retract
  delivered ones.
- **The current Cancel copy is unchanged** unless the copy option is selected (§5).
- **Unverified, deliberately labelled:** mid-execution `cancelPendingQuery` behaviour; the error
  shape a cancelled `send()` surfaces; connection reusability after a cancel; WASM
  re-instantiation cost (option (d)); peak-memory effect of a concurrent second scan (option (a));
  read-only enforcement for a second connection. No memory, latency or CPU numbers are claimed —
  none were measured in this record.
- ADR 0040 stands as accepted; nothing here amends its two-lane decision — the amendment, if
  selected, comes with its own ADR.

## 7. Authority and sources

- Authority order per [AGENTS.md](../../../AGENTS.md): accepted ADRs first; this record is a
  decision request and outranks nothing.
- [Successor queue](20261121-successor-queue.md) §3 B7 row ("Design first, likely ADR… Return a
  decision request… do not implement from this index"); [post-MVP §6](../../product/04-post-mvp-track.md#6-pt-h--hardening--backlog-inventory-recorded-carry-overs).
- [ADR 0040](../../adr/0040-two-op-lanes-in-engine-worker.md) — the no-hard-cancel constraint and
  the "third lane / connection-level cancellation… deliberately not decided here" boundary.
- [06-telemetry-design.md](../../engineering/06-telemetry-design.md) §3.9 — `query_run` outcome
  enum (cited only because the Cancel path emits it; no other telemetry-lane claim is made here).
- Code anchors as cited in §1 and §2 (verified at this revision by read/grep of the named files;
  line numbers drift and must be re-verified before any implementation).
- Pinned dependency evidence: `@duckdb/duckdb-wasm@1.32.0` typings and browser bundle as cited in
  §1 (read from `node_modules/.pnpm` at this revision).
- Related record: [B3 registry lifecycle spec](20261121-b3-registry-lifecycle-spec.md) (separate
  carry-over; shares the engine package but no contract surface with this request).
