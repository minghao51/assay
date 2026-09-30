// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure plan resolution and boundary gates for the pipeline runner (p-3).
 *
 * This module never touches an engine. It turns the runner's input — a
 * validated `PipelineV1` IR or an already-compiled plan — into the
 * deterministic `PipelineCompilePlan` the executor materializes, and enforces
 * the two gates the runner owns:
 *
 * - the **verbatim-SQL gate**: every materialized query must pass the p-2
 *   `classifyVerbatimSql` classifier before it can reach an engine call
 *   (the p-2 compiler already ran it for IR inputs; a plan input or a
 *   programmatic IR is re-checked here, and again worker-side);
 * - the **reserved-relation gate**: a node relation is the node id and may
 *   never enter the engine-managed `assay_*` namespace.
 */
import { classifyVerbatimSql, compilePipeline } from '@assay/pipeline'
import type { CompiledNode, PipelineCompilePlan, PipelineV1 } from '@assay/pipeline'
import { PipelineRunRefusalError } from './errors.js'

/** The runner's input: a pipeline IR or a plan the p-2 compiler produced. */
export type PipelineRunInput = PipelineV1 | PipelineCompilePlan

function isCompilePlan(input: PipelineRunInput): input is PipelineCompilePlan {
  return Array.isArray((input as { order?: unknown }).order)
}

/**
 * Resolve the input to a runnable plan. An IR input is compiled with the pure
 * `compilePipeline` (re-running DAG validation); a plan input is validated
 * structurally. Every failure is a value-free {@link PipelineRunRefusalError}
 * thrown before any engine call.
 */
export function resolvePlan(input: PipelineRunInput): PipelineCompilePlan {
  if (isCompilePlan(input)) {
    validateCompilePlan(input)
    return input
  }
  const result = compilePipeline(input)
  if (!result.ok) {
    throw new PipelineRunRefusalError('not-runnable')
  }
  return result.plan
}

/**
 * Structural integrity check for a caller-supplied compile plan: exactly one
 * node per topological entry, ids consistent, relations equal to node ids,
 * sources query-free, executable nodes carrying non-empty SQL. A plan that
 * fails any of these cannot be compiler output, so it is refused before any
 * engine call.
 */
export function validateCompilePlan(plan: PipelineCompilePlan): void {
  const { order, nodes } = plan
  if (!Array.isArray(order) || !Array.isArray(nodes) || nodes.length !== order.length) {
    throw new PipelineRunRefusalError('invalid-plan')
  }
  const seen = new Set<string>()
  for (let index = 0; index < order.length; index++) {
    const nodeId = order[index]
    const node: CompiledNode | undefined = nodes[index]
    if (typeof nodeId !== 'string' || nodeId.length === 0 || seen.has(nodeId)) {
      throw new PipelineRunRefusalError('invalid-plan')
    }
    seen.add(nodeId)
    if (node === undefined || node.nodeId !== nodeId || node.relation !== nodeId) {
      throw new PipelineRunRefusalError('invalid-plan', nodeId)
    }
    if (node.kind === 'source') {
      if (node.sql !== null) throw new PipelineRunRefusalError('invalid-plan', nodeId)
    } else if (node.kind === 'transform' || node.kind === 'sql') {
      if (typeof node.sql !== 'string' || node.sql.length === 0) {
        throw new PipelineRunRefusalError('invalid-plan', nodeId)
      }
    } else {
      throw new PipelineRunRefusalError('invalid-plan', nodeId)
    }
  }
}

/**
 * The reserved-relation gate: node relations are user text and are rendered
 * as SQL identifiers by the engine, so they must never collide with the
 * engine-managed `assay_*` namespace (`assay_tN`, staged comparisons, overlay
 * helpers). The p-1 parser already rejects such ids in IR; this re-checks a
 * programmatic plan.
 */
export function assertRunnableRelation(nodeId: string, relation: string): void {
  const normalized = relation.trim().toLowerCase()
  if (normalized.length === 0 || normalized.startsWith('assay_')) {
    throw new PipelineRunRefusalError('forbidden-relation', nodeId)
  }
}

/**
 * The verbatim-SQL gate (p-2 classifier, applied at the runner boundary): a
 * node's query may only be sent once `classifyVerbatimSql` accepts it as a
 * single read-only statement. Applied to every materialized query, so a
 * hostile plan cannot smuggle side effects through a forged node kind.
 */
export function assertSqlAccepted(nodeId: string, sql: string): void {
  if (!classifyVerbatimSql(sql).ok) {
    throw new PipelineRunRefusalError('forbidden-sql', nodeId)
  }
}
