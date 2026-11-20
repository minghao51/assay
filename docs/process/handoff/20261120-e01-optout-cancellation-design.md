# E01 design — optional opt-out cancellation strengthening (options only)

**Date:** 2026-11-20. **Status:** `PROPOSED` — design deliverable for improvement-plan row E01
(Q6 selected design-only; **no implementation is selected**). Every option below awaits a separate
maintainer selection; nothing here authorizes a runtime, schema or collector change. Companion
design: [E04 bounded-UX](20261120-e04-bounded-ux-design.md).

## 1. Authority and scope

- Plan row E01 and decision Q6: [implementation-plan.md](improvement-plan-20261120/implementation-plan.md)
  §5 E01 ("Optional opt-out cancellation strengthening") and the Q6 row of its decision table;
  selected policy recorded in [20261120-improvement-plan-execution.md](20261120-improvement-plan-execution.md)
  §2: "abort active send and stop retries; no recall claim. Implementation is not selected by this
  batch."
- Q6's named alternative — keep the current policy with an accurate in-flight limitation — remains
  available (see §6). No egress incident has been observed (plan evidence); this design is a
  hardening option, not an incident response.
- In scope: the web telemetry runtime/transport seam, opt-out/dispose semantics, disclosure
  wording, and the test matrix. Out of scope: event schema, sampling rates, buffer caps, the
  collector, and any persistent queue (design §6.5 "no persistent queue" stands,
  [06-telemetry-design.md](../../engineering/06-telemetry-design.md) §6.5).

## 2. Current behavior (verified at this baseline)

| Fact                                                                                                                                                                                                                                                                                                                           | Evidence                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **One default batch.** Buffer caps equal batch caps (`MAX_BUFFERED_EVENTS`/`MAX_BATCH_EVENTS` = 32, `MAX_BUFFERED_BYTES`/`MAX_BATCH_BYTES` = 256 KiB), and the buffer cannot exceed them (oldest dropped first, design §5.2), so `splitIntoBatches(buffer.drain())` yields exactly one batch at default caps                   | `packages/telemetry/src/buffer.ts:20-29`, pinned by `packages/telemetry/src/buffer.test.ts:74-79`; `apps/web/src/telemetry/runtime.ts:252-256`                                         |
| **Off clears the queue.** `setPreference('off')` sets the in-memory preference and clears the buffer synchronously; `shouldSend()` clears again on every later check                                                                                                                                                           | `apps/web/src/telemetry/runtime.ts:319-324`, `214-220`; design §6.5/R8                                                                                                                 |
| **No handle for an active send.** `flush()` drains the buffer and then awaits `transport.send(batch)`; neither `setPreference` nor `dispose` can reach the awaited send, so a send already in flight runs its full policy to completion                                                                                        | `apps/web/src/telemetry/runtime.ts:240-256`, `334`                                                                                                                                     |
| **Transport retries continue after opt-out.** Per attempt: a fresh `AbortController` + timeout timer used **only** for the per-attempt timeout; network error/timeout is retryable; 5xx retryable; 4xx drops; at most `DEFAULT_RETRIES` = 2 retries with exponential backoff (base 250 ms), then drop; every failure swallowed | `apps/web/src/telemetry/transport.ts:68-95` (`controller` at 71-75, `keepalive: true` at 82, retry decision at 84-92, backoff at 95); `apps/web/src/telemetry/transport.test.ts:28-97` |
| **`dispose()` clears only the pending flush timer**                                                                                                                                                                                                                                                                            | `apps/web/src/telemetry/runtime.ts:334` (`dispose: clearTimer`), `223-228`; `App.tsx:1565-1574` (`pagehide` flush + unmount dispose)                                                   |
| **Current disclosure copy** ends "Turning it off takes effect immediately and nothing further is sent."                                                                                                                                                                                                                        | `packages/telemetry/src/copy.ts:32-34` (body at 19-34; `DISCLOSURE_REVISION = 1` at 16)                                                                                                |
| **CLI has a parallel seam** (own `send(batch)` interface, 1,500 ms timeout, 200 ms backoff base, bounded exit flush)                                                                                                                                                                                                           | `apps/cli/src/telemetry/transport.ts:11-28`, `apps/cli/src/telemetry/runtime.ts:113-114`                                                                                               |

The documented contract (design §6.5: clear buffer, block all future sends, no opt-out event; R8)
already promises everything except the in-flight window: between `transport.send` entering its
retry loop and its final drop, bytes may still leave the machine after the user has opted out. The
window is bounded (≤ 3 attempts, seconds not minutes) but non-zero, and today's disclosure sentence
("nothing further is sent") does not name it.

## 3. Proposed design — optional cancellation parameter

All items in this section are **PROPOSED** (option A of §6). Nothing is implemented.

### 3.1 Transport interface (compatibility approach)

- Extend the seam to `send(batch, options?)` with `options?: { signal?: AbortSignal }`
  (`TelemetryTransport`, `apps/web/src/telemetry/transport.ts:19-21`).
- **Compatibility:** the parameter is optional. Every existing injected transport — including the
  one-parameter test fakes (`apps/web/src/telemetry/runtime.test.ts`) — remains assignable and
  keeps compiling and behaving exactly as today; a transport that ignores the signal simply has no
  cancellation, and its own retry loop is not the runtime's to stop (see §5). Conversely,
  accepting the parameter is a contract: a transport that takes `options.signal` must honor it per
  §3.3 — the runtime cannot enforce that (it never sees inside `send`), so "stop retries" (Q6's
  direction) is delivered by transports that honor the signal, not by runtime power. No existing
  test rewrites.
- Unchanged by contract: the never-reject production policy (R9), the 2xx/4xx/5xx decision
  (`transport.ts:84-92`), the empty-batch no-op (`transport.ts:61`), and the strict no-reject rule
  for the shipped transport.

### 3.2 Runtime-owned AbortController ("generation")

- The runtime owns one `AbortController` per send generation (the window in which `flush()` is
  handing batches to the transport). It is created lazily on send, aborted by `setPreference('off')`
  and `dispose()`, and replaced — never reused — when sending resumes.
- **Off/dispose abort the current send and clear the queue:** `setPreference('off')` keeps its
  synchronous `buffer.clear()` (`runtime.ts:324`) and additionally aborts the active generation;
  `dispose()` keeps its timer cleanup (`runtime.ts:334`) and additionally aborts.
- **Re-enable is a fresh generation:** `setPreference('on')` starts a new controller. The batch
  drained at `runtime.ts:252` before the abort is **dropped, never re-queued** — there is no replay
  of old events after off→on, consistent with design §6.5 ("no previously-buffered event survives an
  opt-out").
- The `flush()` batch loop (`runtime.ts:254-256`) checks the generation signal between batches and
  stops; at default caps this loop runs once (§2), so the check is a future-proofing guard, not a
  second observable batch (see §4 "no invented later-batch test").

### 3.3 Per-attempt timeout vs caller abort

- **Per-attempt timeout** keeps today's attempt-local controller + timer (`transport.ts:71-75`): a
  timeout abort is a retryable attempt failure (`transport.ts:90-92`) under the current bounded
  retry policy.
- **Caller cancellation** is distinct: when `options.signal` aborts, the transport returns
  immediately — the batch is dropped, **never retried, never re-slept**. Implementation options:
  combine the caller signal with the attempt signal (`AbortSignal.any` or one listener that aborts
  the attempt controller), or check `options.signal.aborted` at each decision point. Either is fine
  as long as the two abort causes cannot be confused (a timeout must not silently become "caller
  gave up", and vice versa).
- **Check cancellation before each attempt** (before each `fetch`) **and after backoff** (after
  `await sleep(...)`): once the caller aborts, no further fetch may start. Preferred: make the
  backoff sleep itself cancellable (settle early on abort); the minimum acceptable guarantee is the
  post-sleep check ("make backoff cancellable or at least guarantee no next fetch starts" — plan
  E01).
- **Cleanup:** every abort listener and the per-attempt timer are removed in `finally`
  (`transport.ts:87-90` clears the timer today; listeners are new and must be removed the same
  way). Repeated flushes and repeated sends must not accumulate listeners (§4).

### 3.4 Disclosure wording (exact, PROPOSED)

Rule (plan E01 acceptance): the disclosure says **"stops further attempts and attempts to abort
in-flight delivery"**, not "recalls data".

PROPOSED replacement for the final sentence pair of `WEB_DISCLOSURE_BODY`
(`packages/telemetry/src/copy.ts:32-34`, currently "Turning it off takes effect immediately and
nothing further is sent."):

> Turning it off stops further attempts and attempts to abort in-flight delivery; metadata already
> delivered is not recalled.

Points that must travel with this wording change:

- It touches the consent artifact (ADR 0037; `copy.ts:3-8` — surfaces may wrap the constants but
  must not paraphrase them). Whether the revision constant `DISCLOSURE_REVISION`
  (`copy.ts:16`) increments is a **separate selection**, not implied here.
- The CLI's parallel disclosure (`CLI_DISCLOSURE_COPY`, `copy.ts:37-41`) gets a matching sentence
  only if CLI parity is selected (§7). Until then, the web constant is the only one proposed to
  change, and the divergence must be named in the selection record.
- Wording is required under **both** §6 options: today's sentence overstates even if no cancellation
  is ever implemented, because an in-flight send can complete after opt-out.

## 4. Test matrix (PROPOSED; deterministic, local-only)

| #   | Scenario                       | Expected observation                                                                                                                                |
| --- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | off before any send            | buffer cleared; `flush()`/`emit()` produce zero transport calls (extends the existing opt-out tests, `runtime.test.ts`)                             |
| 2   | off while `fetch` is in flight | caller abort reaches the attempt; fetch rejects with abort; batch dropped; no further attempt; flush resolves (never rejects)                       |
| 3   | off during backoff             | no next fetch starts (post-sleep check or cancelled sleep); batch dropped; no timer left pending                                                    |
| 4   | off → on                       | new generation sends only newly emitted events; the aborted batch is never re-sent                                                                  |
| 5   | disposal during send           | same as off for the in-flight send, plus the existing timer cleanup (`runtime.test.ts` "disposes the pending flush timer")                          |
| 6   | repeated flush                 | a second `flush()` during/after an aborted send never re-sends dropped batches and never duplicates listeners                                       |
| 7   | timer/listener cleanup         | after settle, no pending timeout and no listener left on the caller signal (assert via injected seams, as the suite already does for `cancelFlush`) |

Privacy and environment constraints on any such test (plan E01 acceptance):

- **No payload in tests:** events carry synthetic canary values only (existing red-lines convention,
  `packages/telemetry/src/red-lines.test.ts`); no dataset contents, filenames, SQL or PII.
- **Local interception only:** a configured endpoint is exercised through local test interception
  with privacy canaries — **never a real endpoint**; the stock endpoint-free build must still be
  shown to deliver nothing.
- **No collector deployment**, no new events, no schema changes.
- **No invented later-batch regression test under unreachable defaults:** a second batch cannot
  occur at default caps (§2), so no test may pretend otherwise; multi-batch behavior is only
  exercised under explicitly injected smaller caps, if at all.
- The strict no-reject production transport policy remains asserted, not weakened.

## 5. What remains unsupported (with the proposed design)

- **Recalling delivered bytes is never claimed.** Anything the collector has received stays
  received; the disclosure says so (§3.4).
- **Transports that ignore the signal** (existing injected fakes; any future transport opting out of
  the parameter) keep exactly today's behavior, and the runtime cannot stop what it does not own.
  Runtime-side, opt-out can still drop queued events (the synchronous clear, `runtime.ts:324`) and
  stop starting new sends (`shouldSend()` blocks every later check; the §3.2 between-batches check
  ends the batch loop). But it **cannot stop a retry loop owned by the transport itself**: an
  ignoring transport runs its in-flight `send`'s full retry policy to completion (the §2 fact
  "Transport retries continue after opt-out"; loop at `apps/web/src/telemetry/transport.ts:68-95`),
  and bytes may still leave the machine after opt-out. Retries can only be stopped through the §3.3
  signal contract, which binds transports that accept the parameter — for transports that ignore
  it, retries cannot be stopped.
- **The `keepalive: true` exit flush** (`transport.ts:82`) is unchanged. Whether an abort issued
  during page unload stops a request already handed to the network stack is platform-defined and
  **unverified** — this design makes no claim about it.
- **No persistent queue** is introduced; design §6.5's "nothing survives an opt-out" stays true by
  construction.

## 6. Alternatives considered

- **A — optional cancellation parameter (§3). Recommended** because it matches Q6's selected
  direction ("abort active send and stop retries") for every transport that accepts and honors the
  signal, preserves every injected transport, and adds no surface beyond one optional parameter.
  The stop-retries half is a contract on conforming transports (§3.1), not a runtime power: for a
  transport that ignores the signal, only the runtime-side stops and queue drop hold (§5).
- **B — Q6's named alternative: no code change, accurate in-flight limitation in the disclosure
  only.** Rejected as the recommendation because Q6 selected the abort direction; still a valid
  minimal fallback if implementation is never selected. Note that the §3.4 disclosure correction is
  needed under B too.
- **C — replace `send` with a required-signal or handle-returning API.** Rejected: breaking for
  injected transports, more surface than the problem needs.
- **D — block or synchronously drain on opt-out.** Rejected: violates the non-blocking rule (R9).

## 7. CLI parity — decision deferred

The CLI owns a parallel transport/runtime pair (`apps/cli/src/telemetry/transport.ts:11-28`,
`runtime.ts`) with its own timeout/backoff and a bounded exit flush. Plan E01 sequences this as
"Web, then separate CLI parity review". Whether the same optional parameter, abort semantics and
disclosure sentence apply there is **deferred** and needs its own selection; this document decides
nothing for the CLI.

## 8. Explicitly unauthorized by this document

No implementation (Q6: not selected by this batch); no collector deployment or endpoint change; no
schema/event/rate/cap change; no recall claim; no persistent queue; no CLI change; no disclosure
revision bump without its own selection. Implementation, if ever selected, follows the plan's
acceptance paragraph (§4 matrix, privacy constraints, stock-build proof) in a separately reserved
row.
