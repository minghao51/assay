// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pipeline runner (p-3): execute a validated P1 DAG on the engine,
 * node-by-node, in the compiler's deterministic topological order.
 *
 * ## Contract
 *
 * `executePipeline` takes a pipeline IR (compiled here with the pure p-2
 * `compilePipeline`) or a compiled plan, one explicit user-triggered call —
 * no scheduling, retries, sensors, or run-state persistence (ADR 0032). It
 * materializes each node's relation as a named view: a `source` node's file
 * is registered through the engine's registration path bound to the node
 * relation, and every other node's SQL becomes `CREATE OR REPLACE VIEW
 * "<relation>" AS <sql>`. A re-run recreates views, never appends
 * (idempotent by construction).
 *
 * ## Outcomes
 *
 * - `completed` — every node materialized; the result carries each node's
 *   relation name and cheap row count so outputs are addressable for
 *   inspection/export.
 * - `canceled` — the supplied {@link PipelineRunGuard} was invalidated at a
 *   node boundary (the generation-guard pattern: UI-level abandonment, not a
 *   worker interrupt). `nodes` is the named partial state and `nextNodeId`
 *   names the node that was not executed.
 * - a thrown {@link PipelineRunError} — a node failed to materialize. The
 *   failing node is named and the already-materialized prefix is left in the
 *   session as named partial state; the raw engine error is discarded
 *   (value-free).
 *
 * Invalid requests (uncompilable IR, inconsistent plan, unknown/missing
 * source binding, reserved relation, refused verbatim SQL) throw a
 * {@link PipelineRunRefusalError} before any engine call.
 *
 * ## Lanes (ADR 0040)
 *
 * Every engine operation the runner issues is a query-lane op, so a pipeline
 * run can never starve the grid's registry-lane windows. See the engine's
 * `client.runPipeline` for the wire binding.
 */
import type { CompiledNode } from '@assay/pipeline'
import { PipelineRunError, PipelineRunRefusalError } from './errors.js'
import { PipelineRunGuard } from './guard.js'
import { assertRunnableRelation, assertSqlAccepted, resolvePlan } from './plan.js'
import type { PipelineRunInput } from './plan.js'

/** The file-source seam the runner hands to the engine's registration path. */
export interface PipelineRunSourceFile {
  readonly name: string
  getFile(): Promise<File>
}

/** One source node's dataset binding. */
export interface PipelineRunSource<TSource extends PipelineRunSourceFile = PipelineRunSourceFile> {
  readonly nodeId: string
  readonly source: TSource
}

/** One materialized node's addressable output. */
export interface PipelineRunNodeResult {
  readonly nodeId: string
  /** The output relation name (the node id). */
  readonly relation: string
  /** Cheap `count(*)` over the materialized relation (safe non-negative int). */
  readonly rowCount: number
}

export interface PipelineRunCompleted {
  readonly status: 'completed'
  readonly nodes: readonly PipelineRunNodeResult[]
}

export interface PipelineRunCanceled {
  readonly status: 'canceled'
  /** Named partial state: nodes materialized before cancellation. */
  readonly nodes: readonly PipelineRunNodeResult[]
  /** The node that was not executed, or `null` on a trailing cancellation. */
  readonly nextNodeId: string | null
}

export type PipelineRunResult = PipelineRunCompleted | PipelineRunCanceled

export interface PipelineRunOptions<TSource extends PipelineRunSourceFile = PipelineRunSourceFile> {
  /** Dataset binding for every `source` node; required for each source. */
  readonly sources?: readonly PipelineRunSource<TSource>[]
  /** Cancellation guard; omit for an uncancellable run. */
  readonly guard?: PipelineRunGuard
  /**
   * Progress hook: called with each node id at its execution boundary, after
   * the guard check and before the node's engine op. Hosts use it for live
   * per-node status (p-5); the conformance cancel scenario uses it to
   * invalidate the guard deterministically at a boundary.
   */
  readonly onNode?: (nodeId: string) => void
}

/**
 * The engine operations the runner drives. Kept structural (and separate from
 * the client) so the orchestration is pure and Node-testable: the real client
 * binds these to its typed postMessage ops.
 */
export interface PipelineRunEngineOps<
  TSource extends PipelineRunSourceFile = PipelineRunSourceFile,
> {
  /** Register a dataset as the relation name; resolve its row count. */
  registerSource(relation: string, source: TSource): Promise<number>
  /** `CREATE OR REPLACE VIEW "<relation>" AS <sql>`; resolve its row count. */
  materialize(relation: string, sql: string): Promise<number>
}

function indexSources<TSource extends PipelineRunSourceFile>(
  sources: readonly PipelineRunSource<TSource>[] | undefined,
  nodes: readonly CompiledNode[],
): Map<string, TSource> {
  const sourceNodes = new Set(
    nodes.filter((node) => node.kind === 'source').map((node) => node.nodeId),
  )
  const byNode = new Map<string, TSource>()
  for (const binding of sources ?? []) {
    if (!sourceNodes.has(binding.nodeId)) {
      throw new PipelineRunRefusalError('unknown-source', binding.nodeId)
    }
    if (byNode.has(binding.nodeId)) {
      throw new PipelineRunRefusalError('duplicate-source', binding.nodeId)
    }
    byNode.set(binding.nodeId, binding.source)
  }
  for (const node of nodes) {
    if (node.kind === 'source' && !byNode.has(node.nodeId)) {
      throw new PipelineRunRefusalError('missing-source', node.nodeId)
    }
  }
  return byNode
}

/** Execute a pipeline (or plan) once, node-by-node, in topological order. */
export async function executePipeline<TSource extends PipelineRunSourceFile>(
  input: PipelineRunInput,
  options: PipelineRunOptions<TSource>,
  ops: PipelineRunEngineOps<TSource>,
): Promise<PipelineRunResult> {
  const plan = resolvePlan(input)
  const bindings = indexSources(options.sources, plan.nodes)
  for (const node of plan.nodes) assertRunnableRelation(node.nodeId, node.relation)

  const guard = options.guard ?? new PipelineRunGuard()
  const token = guard.begin()
  const done: PipelineRunNodeResult[] = []

  for (const node of plan.nodes) {
    if (!guard.isActive(token)) {
      return { status: 'canceled', nodes: done, nextNodeId: node.nodeId }
    }
    options.onNode?.(node.nodeId)
    // Re-check after the hook: a hook that invalidates the guard cancels
    // before this node's engine op runs.
    if (!guard.isActive(token)) {
      return { status: 'canceled', nodes: done, nextNodeId: node.nodeId }
    }
    let rowCount: number
    try {
      if (node.kind === 'source') {
        const source = bindings.get(node.nodeId)
        if (source === undefined) {
          // Guaranteed by indexSources; kept as a defensive refusal, never a
          // crash, so a future change cannot send an undefined binding on.
          throw new PipelineRunRefusalError('missing-source', node.nodeId)
        }
        rowCount = await ops.registerSource(node.relation, source)
      } else {
        assertSqlAccepted(node.nodeId, node.sql as string)
        rowCount = await ops.materialize(node.relation, node.sql as string)
      }
    } catch (error) {
      if (error instanceof PipelineRunRefusalError) throw error
      // Value-free node failure: the raw engine text never leaves this catch.
      throw new PipelineRunError(
        node.nodeId,
        done.map((entry) => ({ nodeId: entry.nodeId, relation: entry.relation })),
      )
    }
    done.push({ nodeId: node.nodeId, relation: node.relation, rowCount })
  }

  if (!guard.isActive(token)) {
    return { status: 'canceled', nodes: done, nextNodeId: null }
  }
  return { status: 'completed', nodes: done }
}
