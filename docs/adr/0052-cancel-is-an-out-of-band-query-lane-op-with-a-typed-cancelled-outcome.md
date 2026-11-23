# ADR 0052: Cancel is an out-of-band query-lane op that settles the parked op as a typed `cancelled` outcome

## Status

Accepted

## Date

Proposed 2026-11-23 · **Accepted 2026-11-23**

## Deciders

- Maintainer (acceptance owner). The probe that gates this record is the
  [B7 SQL-interrupt probe](../process/handoff/20261123-b7-sql-interrupt-probe.md); the
  [R-9 brief](../process/handoff/20261122-h2-technical-carry-briefs.md#r-9--b7-sql-true-interrupt)
  makes acceptance a separate act from the draft. **Accepted 2026-11-23**, which unblocks the
  implementing dispatch and the dependent row R-14.

**Implementation is a separate dispatch. Nothing described here is implemented by this record** —
acceptance is the decision, not the code.

## Context

Today "Cancel" is UI-level abandonment and nothing else: it invalidates the run's generation token,
shows a `Cancelled` state, and emits `query_run` with `outcome: 'cancelled'` — it sends nothing to the
engine (`apps/web/src/sql/SqlPanel.tsx`; token mechanics `apps/web/src/sql/run-guard.ts`; the late
result is discarded by `apps/web/src/sql/guarded-run.ts`). Because every query-lane op serialises on
one DuckDB connection (`packages/engine-duckdb/src/engine-executor.ts` lane routing,
`./op-channel.ts`), an abandoned query keeps occupying the connection and the next Run, the next page,
`engine/profile` and everything else queues behind it. The current Cancel copy says exactly that — "The
engine has no query interrupt, so this query may still run to completion in the background (a following
run queues behind it); its result is discarded and will not be shown" — and that copy is the standing
floor ([B7 decision request](../process/handoff/20261121-b7-sql-interrupt-decision.md) §1, §2(c), §5).

[ADR 0040](0040-two-op-lanes-in-engine-worker.md) recorded the resulting limit and deliberately left
the answer undecided: "No query interrupt exists … A true interrupt would need connection-level
cancellation or a third lane — future work, deliberately not decided here." This record is that
decision, and only that decision.

The choice rested on one unverified platform claim: the pinned `@duckdb/duckdb-wasm@1.32.0` exposes
`AsyncDuckDBConnection.cancelSent(): Promise<boolean>` → `cancelPendingQuery(conn)` (the connection seam
already carries it, `packages/engine-duckdb/src/executor-context.ts`), but its mid-execution effect was
unverified — the only in-repo use was post-first-batch tail cleanup. The
[probe](../process/handoff/20261123-b7-sql-interrupt-probe.md) answers the three questions on the
pinned EH bundle the app ships, in real Chromium:

1. the parked `send()` **rejects** with `Error: query was canceled` ~1–3 ms after the cancel, and
   `cancelSent()` resolves `true`;
2. the compute **is** interrupted, not merely abandoned — the browser process tree burns 1.02–1.04
   cores while the query computes and returns to its 0.06-core idle baseline in the quiet window after
   the cancel (9 cancelled runs across 3 sessions);
3. the connection is **immediately reusable** — millisecond follow-ups and the next identical long
   query at its normal duration.

The goal this satisfies is the one the word "Cancel" promises: **stopping the compute** (B7 §4 Q1),
not isolation of other work.

## Decision

We add a typed cancel request to the engine protocol, dispatched **out of band** to the query-lane
connection, and settle the parked op as a typed `cancelled` outcome.

- **Out-of-band dispatch.** The cancel must reach the query-lane connection without queueing behind the
  query it cancels; the `OpChannel` single-pending rule therefore cannot apply to the cancel itself.
  This amends [ADR 0040](0040-two-op-lanes-in-engine-worker.md)'s "deliberately not decided here"
  clause for connection-level cancellation, and only for that.
- **Scope is `engine/query` only.** Not every query-lane op: an interrupted export (`COPY … TO`) or
  pipeline materialisation has different failure semantics from a discarded SELECT, and neither is
  probed. Widening the scope is a later decision with its own evidence.
- **Typed outcome.** The parked op settles as `cancelled` — the `query_run` telemetry enum already
  carries `cancelled` (`docs/engineering/06-telemetry-design.md` §3.9) — never a masked engine error
  (the AR-2/R1 honest-error posture).
- **Delivered rows are never retracted.** A cancel can only discard a late result; pages already
  returned to the pane stay rendered, and the RunGuard keeps discarding only late results.
- **The Cancel copy does not change.** Acceptance question Q4 is **not** selected: the current copy is
  pinned and stays byte-identical under this decision. Re-selecting copy is its own decision, after
  this lands and only if desired.

## Consequences

### Positive

- Cancel stops the compute, which is the promise the button makes, and it stops head-of-line blocking
  for the query lane: the next Run / page / profile scan starts immediately after the cancel instead
  of behind an abandoned query.
- The telemetry and outcome vocabulary already exist (`cancelled` in the `query_run` enum), so the
  honest-outcome requirement adds no schema change.
- The change is additive at the wire: one new request type plus its response, with parse-time
  refusals; no persisted format moves.

### Negative / risks

- The engine contract grows a request type and the executor grows a dispatch path that deliberately
  bypasses the lane's serialization — a second way for work to touch the query connection. That path
  must be the only one, narrow, and pinned by a drill that proves it does not queue behind the running
  query (see "Verification").
- Cancellation is only as good as the platform call: this ADR rests on one probe of one bundle
  (`eh`), one query shape and one Chromium build. If a future bundle or the `mvp` pair behaves
  differently, the op degrades to "parked op settles immediately, compute continues" — which is why
  the implementation must surface `cancelSent()`'s boolean and the typed outcome honestly rather than
  assuming the compute stopped.
- The window between "cancel requested" and "op settled" is a new state the UI must tolerate; nothing
  here changes copy, so the UI may briefly show the existing `Cancelled` state while the engine is still
  winding down.
- Option (a) is **not** chosen: a second connection/worker would be isolation, not interruption, and
  its concurrent-scan memory risk remains unmeasured. Option (d) remains rejected: disposing and
  re-creating the worker destroys the session and re-binds `assay_tN` ids (the page-mixture hazard).
- No memory, latency or CPU claim is made by this decision; the probe's figures are measurements of a
  probe query on a shared machine, not a performance promise for the feature.

### Neutral

- Byte surfaces that stay untouched: the Cancel copy (`apps/web/src/sql/SqlPanel.tsx`), the RunGuard
  semantics (`apps/web/src/sql/guarded-run.ts`), the two-lane routing of every other op (ADR 0040
  otherwise stands), persisted formats, and the existing post-first-batch tail-cleanup
  `cancelSent()` call.

## Verification this ADR will require when implemented

None of this exists yet; it is the acceptance bar for the implementing dispatch, not a claim that it
was done:

- A conformance case (real engine) where a cancel settles the parked op as `cancelled` and the
  connection is reusable for the next query.
- Wire-refusal cases: malformed identifiers and unknown request types refused at parse time, before
  anything executes.
- A mutation drill on the out-of-band dispatch: route the cancel through the normal queue and the
  "cancel queues behind the running query" test must fail. That drill is what pins the ADR 0040
  amendment.
- The pinned Cancel-copy tests stay green unchanged (copy freeze).

## Alternatives considered

- **(c) Status quo with honest copy** — zero change and already truthful, and it remains the floor
  until this decision is implemented (accepted 2026-11-23; the floor stands while no op ships).
  Rejected as the target only because the probe showed the interrupt
  is real and cheap: the only cost is one additive op plus a dispatch path.
- **(a) Second connection/worker for read-only queries** — unblocks other work without stopping the
  user's query; it amends ADR 0040 and adds a concurrent-scan memory risk whose magnitude is
  unmeasured. Not chosen: isolation is not interruption.
- **(d) Dispose and reboot the worker** — the only option that bounds pathological CPU use, but it
  destroys the working session and re-binds `assay_tN` ids. Rejected.
