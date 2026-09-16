/**
 * Generation guard for SQL runs (m2-4) — the same pattern as the grid's
 * epoch guard, extracted as a pure class so it is unit-testable in Node.
 *
 * Honest cancel semantics: the engine worker exposes no client-facing query
 * interrupt (the FIFO OpChannel holds its single pending-query slot until
 * the first batch arrives), so "Cancel" is *UI-level abandonment*: the guard
 * invalidates the in-flight run's token, the pane shows a cancelled state,
 * and the late result is discarded when it eventually arrives. The query
 * itself keeps running worker-side — a true interrupt / second-connection
 * decision belongs to the FIFO head-of-line task (m2-7). A follow-up run
 * still works: it simply queues behind the abandoned query on the worker's
 * FIFO.
 */
export class RunGuard {
  /** Monotonic generation counter; 0 = nothing ever began. */
  private current = 0

  /**
   * Begin a run and return its token. Any previously begun token becomes
   * inactive (a newer run supersedes older ones).
   */
  begin(): number {
    this.current += 1
    return this.current
  }

  /** True only for the most recently begun, not-yet-invalidated token. */
  isActive(token: number): boolean {
    return token > 0 && token === this.current
  }

  /**
   * Invalidate the current token without beginning a new run (the Cancel
   * path): the abandoned run's late result/rejection must never render.
   */
  invalidate(): void {
    this.current += 1
  }
}
