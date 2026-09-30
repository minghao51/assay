// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure model for the pipeline panel (p-5) — the unit-tested half of the
 * panel, mirroring the house convention (thin components over tested pure
 * modules, like `sql/paged-query.ts`).
 *
 * Everything here is total and synchronous over already-validated inputs
 * (a compiled plan, a run-state value): no engine calls, no React, no DOM.
 * Rendering always goes through `sanitizePipelineText` at the component
 * boundary (see `sanitize.ts`); the model only shapes data.
 */
import type { PipelineCompilePlan, PipelineV1 } from '@assay/pipeline'
import { quotePortIdentifier } from '@assay/pipeline'
import type { NodeRunStatus, PipelineRunState } from './pipeline-state'
import { initialNodeStatuses } from './pipeline-state'

/** One inspect-list row: a node in the plan's deterministic topological order. */
export interface PipelineNodeView {
  readonly nodeId: string
  readonly kind: 'source' | 'transform' | 'sql'
  /** The output relation the engine materializes (the node id, verbatim). */
  readonly relation: string
  /** A terminal relation: no other node consumes this node's output. */
  readonly isOutput: boolean
}

/**
 * The inspect view: one row per executable node, in the plan's topological
 * order (dependencies first), each flagged as an output when no other node
 * references it as an input. Inputs are read from the IR (the compiled plan
 * does not carry them); a compiled plan only contains executable nodes, and
 * of those only `transform`/`sql` have declared inputs.
 */
export function buildNodeViews(
  pipeline: PipelineV1,
  plan: PipelineCompilePlan,
): readonly PipelineNodeView[] {
  const consumed = new Set<string>()
  for (const node of pipeline.nodes) {
    if (node.type === 'transform' || node.type === 'sql') {
      for (const input of node.inputs) consumed.add(input)
    }
  }
  return plan.nodes.map((compiled) => ({
    nodeId: compiled.nodeId,
    kind: compiled.kind,
    relation: compiled.relation,
    isOutput: !consumed.has(compiled.nodeId),
  }))
}

/**
 * The SQL that inspects one materialized relation through the existing SQL
 * result surface. Quoting goes through the pipeline package's shared
 * `quotePortIdentifier` — the SAME `quoteIdentifier` implementation the
 * compiler and runner execute against (never hand-rolled, the m4-2 lesson).
 */
export function inspectRelationSql(relation: string): string {
  return `SELECT * FROM ${quotePortIdentifier(relation)}`
}

/**
 * The per-node display statuses for a run state. During a run the live
 * `statuses` map is authoritative; a completed run marks every node done;
 * a canceled/failed outcome marks the named partial materialized (and the
 * failed node failed) with everything else still pending — honest about the
 * fact that counts for partial nodes are unknown (`rowCount: null` at the
 * report surface, the p-4 carry-over).
 */
export function nodeStatusesForRun(
  runState: PipelineRunState,
  order: readonly string[],
): Readonly<Record<string, NodeRunStatus>> {
  switch (runState.kind) {
    case 'running':
      return runState.statuses
    case 'completed': {
      const statuses = initialNodeStatuses(order)
      for (const nodeId of order) statuses[nodeId] = 'done'
      return statuses
    }
    case 'canceled':
    case 'failed': {
      const statuses = initialNodeStatuses(order)
      for (const entry of runState.partial) statuses[entry.nodeId] = 'done'
      if (runState.kind === 'failed' && runState.nodeId !== null) {
        statuses[runState.nodeId] = 'failed'
      }
      return statuses
    }
    default:
      return initialNodeStatuses(order)
  }
}

/** Relations addressable after a settled run, with row counts when known. */
export interface ViewableRelation {
  readonly relation: string
  /** Known only for a completed run — partial state carries no counts. */
  readonly rowCount: number | null
}

/**
 * Which materialized relations the user can inspect right now, keyed by
 * node id: every node of a completed run (with counts), or the named
 * partial state of a canceled/failed run (counts unknown — the views exist
 * in the session, so inspecting them is honest; the runner documents this).
 */
export function viewableRelationsForRun(
  runState: PipelineRunState,
): Readonly<Record<string, ViewableRelation>> {
  switch (runState.kind) {
    case 'completed':
      return Object.fromEntries(
        Object.entries(runState.results).map(([nodeId, entry]) => [
          nodeId,
          { relation: entry.relation, rowCount: entry.rowCount },
        ]),
      )
    case 'canceled':
    case 'failed':
      return Object.fromEntries(
        runState.partial.map((entry) => [
          entry.nodeId,
          { relation: entry.relation, rowCount: null },
        ]),
      )
    default:
      return {}
  }
}
