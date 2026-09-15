/**
 * Worker-side operation channel (T2): the single pending-query channel that
 * serializes every engine operation through one FIFO queue.
 *
 * Why a queue and not per-op connections — duckdb-wasm 1.32 polls ONE pending
 * query per connection: `AsyncDuckDBConnection.send()` calls
 * `startPendingQuery`, which yields `null` while the connection's single
 * pending-query slot is occupied, and then busy-polls `pollPendingQuery`
 * until it is free; result draining (`fetchQueryResults`) is likewise
 * connection-scoped, not query-scoped. Two ops interleaving on one connection
 * can therefore misattribute each other's result batches, and the mvp bundle's
 * emscripten layer (`_setThrew`) surfaces such collisions as opaque errors.
 * The options:
 *
 * (a) single pending-query channel (this file): every operation runs
 *     start-to-finish before the next begins — the busy window (send → drain
 *     → cancel) is never shared. Sequential traffic behaves exactly as
 *     before; no protocol or client change; `reader.cancel()` /
 *     `cancelSent()` cleanup ordering (m1-4) is untouched; one op's error is
 *     always delivered to its own caller. Cost: a long user `query()` delays
 *     ops queued behind it (grid windows) until it completes — acceptable
 *     while ops are short (windowed LIMIT queries, DESCRIBE, count(*)) and
 *     revisitable with a worker pool when real parallelism is needed.
 * (b) per-op connections: each operation gets its own `db.connect()`.
 *     Rejected: a nested-worker round trip plus connection allocation per
 *     operation; it would silently change the single-connection reuse
 *     semantics that the T1 conformance suite locks in (mid-stream
 *     error-then-reuse); and cancel/drain bookkeeping multiplies for no
 *     benefit until ops genuinely need to run in parallel.
 *
 * Error isolation: a task's rejection is delivered only to its own caller;
 * the channel tail always settles, so the next queued operation starts
 * regardless — one op's error can never wedge the queue.
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
