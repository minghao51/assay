// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Worker-side registry of staged comparison datasets (m6-2, checkpoint C3).
 *
 * A comparison file staged for a row diff is deliberately NOT part of the
 * grid's table registry (the main-grid single-dataset model is unchanged):
 * it gets its own id sequence (`d1`, `d2`, …), its own engine-generated view
 * name (`assay_diff_d1`) and its own DuckDB file-registration name
 * (`diff_d1`). Only ONE comparison is staged at a time: the staging op
 * replaces the previous entry, so re-staging the same reference (or a
 * different one) cannot accumulate views or file registrations — the
 * idempotent-safe contract. All names are engine-generated; user file names
 * are never stored, logged, or echoed (ADR 0025).
 *
 * The class is pure bookkeeping — DuckDB calls live in `engine-executor.ts`
 * — so it is unit-testable under Node.
 */
import { detectFileFormat } from './format-view.js'

/** One staged comparison dataset. */
export interface StagedComparison {
  readonly comparisonId: string
  readonly viewName: string
  readonly registeredFileName: string
  readonly format: NonNullable<ReturnType<typeof detectFileFormat>>
}

/** View names are the comparison id with a namespaced prefix: `assay_diff_d1`. */
export function viewNameForComparisonId(comparisonId: string): string {
  return `assay_diff_${comparisonId}`
}

export class ComparisonRegistry {
  private nextSequence = 1
  private staged: StagedComparison | null = null

  /**
   * Reserve the next comparison id. Called *before* file/view creation so
   * the caller can name things; pair with `confirm()` on success or
   * `discard()` on failure so a failed stage cannot leave a phantom entry.
   */
  reserve(format: NonNullable<StagedComparison['format']>): StagedComparison {
    const comparisonId = `d${this.nextSequence++}`
    return {
      comparisonId,
      viewName: viewNameForComparisonId(comparisonId),
      registeredFileName: `diff_${comparisonId}`,
      format,
    }
  }

  /** Commit a reserved entry as the single staged comparison. */
  confirm(entry: StagedComparison): void {
    this.staged = entry
  }

  /** Look up a comparison handle sent from the main thread. */
  get(comparisonId: string): StagedComparison | null {
    return this.staged !== null && this.staged.comparisonId === comparisonId ? this.staged : null
  }

  /** The current staged comparison, if any. */
  current(): StagedComparison | null {
    return this.staged
  }

  /** Drop the staged entry (replace/dispose); returns what was held. */
  clear(): StagedComparison | null {
    const entry = this.staged
    this.staged = null
    return entry
  }

  /** The engine-generated view names the staged comparison currently holds. */
  viewNames(): readonly string[] {
    return this.staged === null ? [] : [this.staged.viewName]
  }
}
