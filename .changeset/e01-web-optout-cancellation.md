---
'@assay/web': patch
---

feat(e01): abort in-flight telemetry delivery on opt-out (option A of
`docs/process/handoff/20261120-e01-optout-cancellation-design.md`). The
transport seam gains an **optional** `TelemetryTransport.send(batch, options?)`
with `options.signal`, so every existing one-argument transport (including the
test fakes) stays assignable and behaves exactly as before; a transport that
accepts the parameter contracts to honor it. The runtime now owns one
`AbortController` per send generation — created lazily when a send starts,
aborted by `setPreference('off')` and `dispose()`, and **replaced** (never
reused) when sending resumes — so a batch already drained before the opt-out is
dropped, never re-queued, re-sent or re-slept, and off → on sends only newly
emitted events. Caller cancellation is deliberately distinct from the
per-attempt timeout: it is checked before every attempt and after the backoff,
it aborts the in-flight attempt, and it drops the batch without a retry, while a
timeout stays retryable under the unchanged 2xx/4xx/5xx policy and bounded
backoff. The backoff sleep settles early on abort (the `Sleep` seam receives the
signal; a seam that ignores it still cannot let a fetch start), and every
attempt timer and caller-signal listener is removed in `finally`, so repeated
sends never accumulate listeners. `flush()` checks the generation between
batches (future-proofing: a single batch at default caps). The production
transport still never rejects (R9), `keepalive: true` is unchanged, and nothing
in the event schema, sampling, caps, collector or CLI is touched. Remainder
named, not claimed: a transport that ignores the signal still runs its own retry
loop to completion, and whether an abort issued during page unload stops a
request already handed to the network stack is platform-defined and unverified.
