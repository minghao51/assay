/**
 * Worker-side operation channel (T2, revisited by m2-7): the per-connection
 * FIFO lane that serializes engine operations through pending-query slots.
 *
 * Why lanes and not per-op connections — duckdb-wasm 1.32 polls ONE pending
 * query per connection: `AsyncDuckDBConnection.send()` calls
 * `startPendingQuery`, which yields `null` while the connection's single
 * pending-query slot is occupied, and then busy-polls `pollPendingQuery`
 * until it is free; result draining (`fetchQueryResults`) is likewise
 * connection-scoped, not query-scoped. Two ops interleaving on one connection
 * can therefore misattribute each other's result batches, and the mvp bundle's
 * emscripten layer (`_setThrew`) surfaces such collisions as opaque errors.
 * The decision history:
 *
 * (T2, single channel) Originally every operation ran through ONE channel:
 *     start-to-finish serialization with no protocol or client change and
 *     per-op error isolation. Cost, accepted while ops were short: a long
 *     user `query()` delayed every op queued behind it (grid windows,
 *     rowCount, schema) until it completed.
 *
 * (m2-7, two channels) Once interactive queries exist (m2-4 SQL editor) that
 *     cost is real and measured: in e2e (tests/e2e/engine-head-of-line.spec.ts,
 *     5 repeats per run, mvp bundle, ~2.4–2.5 s aggregate query), an
 *     interactive burst fired while the query ran waited a median of
 *     2360–2369 ms per op (p95 2390–2508 ms across two measurement runs)
 *     against an idle baseline of ~2–6 ms — ~96 % of the query's duration, a
 *     ~400–1400× penalty on exactly the ops a virtualized grid needs for
 *     responsive scrolling. Deferral was therefore
 *     not justified; per-op connections stay rejected (a nested-worker round
 *     trip plus connection allocation per operation, and it would silently
 *     change the single-connection reuse semantics the T1 conformance suite
 *     locks in). The adopted middle path — already documented as the option
 *     worth revisiting — is a SECOND connection dedicated to an op class:
 *     the executor (`./engine-executor`) owns two `OpChannel` lanes, one per
 *     connection. The query lane (user SQL, profile — heavy scans) and the
 *     registry lane (open/schema/range/rowCount/dispose — the short,
 *     latency-sensitive metadata and window traffic) serialize within
 *     themselves exactly as before; across lanes, duckdb-wasm's per-connection
 *     pending slots keep results attributable, and the mvp bundle's polling
 *     architecture lets the two connections' pending queries interleave at
 *     task/poll granularity (each poll is an event-loop turn in the nested
 *     DuckDB worker). Measured in the same e2e, three runs: while the query
 *     runs, the burst's median wait is ~208 / ~511 / ~613 ms per op
 *     (fetchRange / rowCount / schema; run-to-run spread ≤ 1 ms) — a fixed
 *     band, ~8–25 % of the query's time instead of ~96 %, that no longer
 *     scales with the query's duration (the waits stayed flat while the long
 *     query's own median varied 2448–3464 ms under CPU contention, and the
 *     query itself is unaffected: 2448–2487 ms median with lanes vs 2460 ms
 *     single-FIFO).
 *     Protocol, client, and wire format are unchanged: routing is
 *     worker-internal, so this is not a new concurrency surface exposed to
 *     callers — it is two of the T2 channels, each preserving the T2
 *     guarantees (per-connection single pending query, per-lane error
 *     isolation, FIFO order within a lane).
 *
 * Error isolation (per lane): a task's rejection is delivered only to its own
 * caller; the lane's tail always settles, so the next queued operation starts
 * regardless — one op's error can never wedge its lane, and lanes share no
 * pending-query state, so one lane's error can never corrupt the other.
 */
export class OpChannel {
  /** Tail of the chain: settles only when every enqueued op has finished. */
  private tail: Promise<unknown> = Promise.resolve()

  /**
   * Enqueue `task`. Call this synchronously when the request arrives so the
   * queue order matches arrival order. The returned promise resolves with the
   * task's own result and rejects only with the task's own error — never with
   * a predecessor's failure.
   */
  run<T>(task: () => Promise<T>): Promise<T> {
    // Start the task once the tail settles either way (the previous op may
    // have failed; its error belongs to its own caller, not to us).
    const result = this.tail.then(task, task)
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
