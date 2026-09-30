// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Worker-side bookkeeping for pipeline materialization (p-3).
 *
 * Two pieces of engine-managed state, both keyed by the node relation (the
 * node id):
 *
 * - `sources` — the registered datasets behind `source` nodes. A second
 *   registration for the same relation is replaced (view + file), so a
 *   re-run never accumulates registrations and never appends.
 * - `views` — every relation the runner has materialized (sources and
 *   compiled nodes), so `engine/dispose` can drop them.
 *
 * All file-system names here are engine-generated (`assay_pipeline_src_N`),
 * never user text (ADR 0025); the relation name is rendered into SQL through
 * the shared identifier helper at the call site.
 *
 * Pure bookkeeping — no DuckDB calls — so it is Node-testable.
 */
import { detectFileFormat } from '../format-view.js'

export type PipelineSourceFormat = NonNullable<ReturnType<typeof detectFileFormat>>

export interface RegisteredPipelineSource {
  readonly relation: string
  readonly registeredFileName: string
  readonly format: PipelineSourceFormat
}

export class PipelineSourceRegistry {
  private nextSequence = 1
  private readonly sources = new Map<string, RegisteredPipelineSource>()
  private readonly views = new Set<string>()

  /** Reserve an engine-generated file name for a relation. */
  reserve(relation: string, format: PipelineSourceFormat): RegisteredPipelineSource {
    const registeredFileName = `assay_pipeline_src_${String(this.nextSequence++)}`
    return { relation, registeredFileName, format }
  }

  /** Record a successfully registered source. */
  confirm(entry: RegisteredPipelineSource): void {
    this.sources.set(entry.relation, entry)
    this.views.add(entry.relation)
  }

  /** Record a materialized (non-source) node view. */
  addView(relation: string): void {
    this.views.add(relation)
  }

  /** The current source behind a relation, or `null`. */
  get(relation: string): RegisteredPipelineSource | null {
    return this.sources.get(relation) ?? null
  }

  /** Drop one source's bookkeeping (replacement / rollback). */
  remove(relation: string): RegisteredPipelineSource | null {
    const entry = this.sources.get(relation) ?? null
    this.sources.delete(relation)
    return entry
  }

  /** Every relation the runner materialized (for dispose). */
  viewNames(): readonly string[] {
    return [...this.views]
  }

  /** Every registered source (oldest first). */
  sourceList(): readonly RegisteredPipelineSource[] {
    return [...this.sources.values()]
  }

  /** Drop all bookkeeping; returns what was held. */
  clear(): {
    readonly views: readonly string[]
    readonly sources: readonly RegisteredPipelineSource[]
  } {
    const views = this.viewNames()
    const sources = this.sourceList()
    this.views.clear()
    this.sources.clear()
    return { views, sources }
  }
}
