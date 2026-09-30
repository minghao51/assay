// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Generation guard for pipeline runs (p-3) — the same pure pattern as
 * `apps/web/src/sql/run-guard.ts` (m2-4), reimplemented here because the
 * engine package cannot import from an app (dependency direction). A run
 * begins a token; invalidating the guard abandons the run at the next node
 * boundary, and the runner reports a typed `canceled` outcome instead of
 * `completed`. This is UI-level abandonment matching the engine's honest
 * cancel semantics (ADR 0040: there is no client-facing query interrupt), not
 * a worker-side interrupt.
 */
export class PipelineRunGuard {
  /** Monotonic generation counter; 0 = nothing ever began. */
  private current = 0

  /** Begin a run and return its token; supersedes any earlier token. */
  begin(): number {
    this.current += 1
    return this.current
  }

  /** True only for the most recently begun, not-yet-invalidated token. */
  isActive(token: number): boolean {
    return token > 0 && token === this.current
  }

  /** Abandon the current token (the Cancel path) without beginning a run. */
  invalidate(): void {
    this.current += 1
  }
}
