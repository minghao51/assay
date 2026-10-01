// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure model for the pipeline panel (p-5; extended p2-6) — the unit-tested
 * half of the panel, mirroring the house convention (thin components over
 * tested pure modules, like `sql/paged-query.ts`).
 *
 * Everything here is total and synchronous over already-validated inputs
 * (a compiled data-subgraph plan, the IR, a run-state value): no engine
 * calls, no React, no DOM. Rendering always goes through
 * `sanitizePipelineText` at the component boundary (see `sanitize.ts`); the
 * model only shapes data.
 *
 * p2-6 adds the arch §15/§16 core: per-node materialization badges, gate
 * verdicts (validate/diff/publish, value-free), lineage (dataset + node
 * level, ordered lists — never a visual graph per ADR 0032/queue discipline),
 * and a schema delta between a node's input and output schemas.
 */
import type { PipelineCompilePlan, PipelineNode, PipelineV1 } from '@assay/pipeline'
import type {
  NodeMaterialization,
  NodeRunStatus,
  PipelineRunGateVerdict,
  PipelineRunOutcome,
  PipelineRunState,
} from './pipeline-state'
import { initialNodeStatuses } from './pipeline-state'

/** A column name/type pair as the engine reports it. */
export interface PipelineColumn {
  readonly name: string
  readonly type: string
}

/** One inspect-list row: a node in the validated topological order. */
export interface PipelineNodeView {
  readonly nodeId: string
  readonly kind: 'source' | 'transform' | 'sql' | 'validate' | 'diff' | 'publish'
  /** The output relation the engine materializes (the node id, verbatim). */
  readonly relation: string
  /** The generated query for `transform`/`sql` nodes; `null` otherwise. */
  readonly sql: string | null
  /**
   * The node's materialization badge: `source`/`view`/`table`/`export` for
   * data nodes (from the p2-3 plan), or `gate` for the reserved classes.
   */
  readonly materialization: NodeMaterialization
  /** The node's data inputs (gates reference their single input too). */
  readonly inputs: readonly string[]
  /** For a `publish` node: its `requires` gate edges ([] otherwise). */
  readonly requires: readonly string[]
  /** The IR's authored contract reference (validate nodes only; never resolved). */
  readonly contract: string | null
  /** A terminal relation: no data node consumes this node's output. */
  readonly isOutput: boolean
}

/** The engine-visible materialization badge for one plan entry. */
function badgeForStatementKind(kind: string | undefined): NodeMaterialization {
  switch (kind) {
    case 'source':
      return 'source'
    case 'table':
      return 'table'
    case 'export':
      return 'export'
    default:
      return 'view'
  }
}

/** The data references one IR node consumes (gate nodes reference their input). */
function dataReferencesOf(node: PipelineNode): readonly string[] {
  switch (node.type) {
    case 'source':
      return []
    case 'transform':
    case 'sql':
      return node.inputs
    case 'validate':
    case 'publish':
      return [node.input]
    case 'diff':
      return [node.input, node.against]
  }
}

/**
 * The inspect view: one row per node in the validated topological order
 * (dependencies first), each flagged as an output when no DATA node
 * references it as an input. The compiled plan only contains the data
 * subgraph (gate nodes are bound by the runner, not compiled by p2-3), so
 * the view merges the full IR order with the plan's per-data-node details.
 */
export function buildNodeViews(
  pipeline: PipelineV1,
  order: readonly string[],
  plan: PipelineCompilePlan,
): readonly PipelineNodeView[] {
  const consumed = new Set<string>()
  for (const node of pipeline.nodes) {
    if (node.type === 'transform' || node.type === 'sql') {
      for (const input of node.inputs) consumed.add(input)
    }
  }
  const compiled = new Map(plan.nodes.map((node) => [node.nodeId, node]))
  const byId = new Map(pipeline.nodes.map((node) => [node.id, node]))
  return order.flatMap((nodeId) => {
    const ir = byId.get(nodeId)
    if (ir === undefined) return []
    const planNode = compiled.get(nodeId)
    const sql = planNode?.sql ?? null
    const materialization: NodeMaterialization =
      ir.type === 'source' || ir.type === 'transform' || ir.type === 'sql'
        ? badgeForStatementKind(planNode?.statementKind)
        : 'gate'
    return [
      {
        nodeId: ir.id,
        kind: ir.type,
        relation: ir.id,
        sql,
        materialization,
        inputs: dataReferencesOf(ir),
        requires: ir.type === 'publish' ? [...(ir.requires ?? [])] : [],
        contract: ir.type === 'validate' ? ir.contract : null,
        isOutput: !consumed.has(ir.id),
      },
    ]
  })
}

/**
 * The per-node display statuses for a run state. During a run the live
 * `statuses` map is authoritative; a completed run marks every node done; a
 * gated run marks every executed node done and the gate the run stopped at
 * as `gated`; a canceled/failed outcome marks the named partial materialized
 * (and the failed node failed) with everything else still pending — honest
 * about the fact that counts for partial nodes are unknown.
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
    case 'gated': {
      const statuses = initialNodeStatuses(order)
      for (const outcome of runState.outcomes) statuses[outcome.nodeId] = 'done'
      statuses[runState.gatedAt] = 'gated'
      return statuses
    }
    case 'canceled':
    case 'failed': {
      const statuses = initialNodeStatuses(order)
      for (const outcome of runState.partial) statuses[outcome.nodeId] = 'done'
      if (runState.kind === 'failed' && runState.nodeId !== null) {
        statuses[runState.nodeId] = 'failed'
      }
      return statuses
    }
    default:
      return initialNodeStatuses(order)
  }
}

/** Relations addressable after a settled run, with the runner's outcome. */
export type ViewableRelation = PipelineRunOutcome

/**
 * Which executed nodes the user can address right now, keyed by node id:
 * every executed node of a completed/gated run, or the named partial state of
 * a canceled/failed run. The relations exist in the session, so inspecting
 * them is honest; the runner documents that partial state carries no counts.
 */
export function viewableRelationsForRun(
  runState: PipelineRunState,
): Readonly<Record<string, ViewableRelation>> {
  const outcomes =
    runState.kind === 'completed' || runState.kind === 'gated'
      ? runState.outcomes
      : runState.kind === 'canceled' || runState.kind === 'failed'
        ? runState.partial
        : []
  return Object.fromEntries(outcomes.map((outcome) => [outcome.nodeId, outcome]))
}

/** A gate node's value-free verdict after a settled run, or `null`. */
export function gateVerdictForRun(
  runState: PipelineRunState,
  nodeId: string,
): PipelineRunGateVerdict | null {
  const viewable = viewableRelationsForRun(runState)
  return viewable[nodeId]?.gate ?? null
}

/**
 * Whether a node's relation can be opened in the grid-native preview: it
 * must have materialized a session relation. `export` nodes write an OPFS
 * artifact and gate nodes only inspect their input — neither addresses a
 * new relation to preview (the export path and gate verdict are shown
 * instead).
 */
export function isPreviewable(outcome: PipelineRunOutcome | undefined): boolean {
  if (outcome === undefined) return false
  return outcome.materialization !== 'export' && outcome.materialization !== 'gate'
}

/**
 * The node ids whose relations could be previewed right now (executed data
 * nodes that materialized a session relation), in the given order.
 */
export function previewableNodeIds(
  runState: PipelineRunState,
  order: readonly string[],
): readonly string[] {
  const viewable = viewableRelationsForRun(runState)
  return order.filter((nodeId) => isPreviewable(viewable[nodeId]))
}

/* ------------------------------------------------------------------ */
/* Schema delta (arch §15: schema changes between input and output)    */
/* ------------------------------------------------------------------ */

/** One output column whose type changed relative to the input schema. */
export interface SchemaTypeChange {
  readonly name: string
  readonly from: string
  readonly to: string
}

/** The difference between a node's input schema and its output schema. */
export interface SchemaDelta {
  readonly added: readonly PipelineColumn[]
  readonly removed: readonly PipelineColumn[]
  readonly changed: readonly SchemaTypeChange[]
}

/**
 * Compare two schemas by column name (order-insensitive): column names present
 * only downstream are "added", only upstream "removed", and a name in both
 * with a different (case-sensitive) type is "changed". Duplicate names are a
 * host contract violation; the last occurrence wins, deterministically.
 */
export function schemaDelta(
  before: readonly PipelineColumn[],
  after: readonly PipelineColumn[],
): SchemaDelta {
  const beforeByName = new Map(before.map((column) => [column.name, column]))
  const afterByName = new Map(after.map((column) => [column.name, column]))
  const added: PipelineColumn[] = []
  const removed: PipelineColumn[] = []
  const changed: SchemaTypeChange[] = []
  for (const column of after) {
    if (!beforeByName.has(column.name)) added.push(column)
  }
  for (const column of before) {
    const downstream = afterByName.get(column.name)
    if (downstream === undefined) {
      removed.push(column)
    } else if (downstream.type !== column.type) {
      changed.push({ name: column.name, from: column.type, to: downstream.type })
    }
  }
  return { added, removed, changed }
}

/** Whether a schema delta is empty (no added/removed/changed columns). */
export function isSchemaDeltaEmpty(delta: SchemaDelta): boolean {
  return delta.added.length === 0 && delta.removed.length === 0 && delta.changed.length === 0
}

/* ------------------------------------------------------------------ */
/* Lineage (arch §16: dataset + node level, ordered lists)             */
/* ------------------------------------------------------------------ */

/** One dataset (source) and the nodes that consume it transitively. */
export interface DatasetLineage {
  readonly sourceId: string
  readonly consumers: readonly string[]
}

/** One node's inputs, gate requirements, and direct consumers. */
export interface NodeLineage {
  readonly nodeId: string
  readonly inputs: readonly string[]
  /** A `publish` node's `requires` gate edges ([] otherwise). */
  readonly requires: readonly string[]
  /** Nodes that reference this node (data inputs and gate inputs). */
  readonly consumers: readonly string[]
}

export interface PipelineLineage {
  readonly datasets: readonly DatasetLineage[]
  readonly nodes: readonly NodeLineage[]
}

/**
 * Derive lineage from the plan/IR (arch §16), ordered by the validated
 * topological order. Dataset lineage names, for each SOURCE, every node that
 * consumes it transitively (e.g. `customers + policies → customer_portfolio`).
 * Node lineage names each node's direct data inputs, gate requirements, and
 * direct consumers. Pure, total, and graph-free at the render layer (ADR
 * 0032: the panel is an ordered list, never a visual graph editor).
 */
export function buildLineage(pipeline: PipelineV1, order: readonly string[]): PipelineLineage {
  const byId = new Map(pipeline.nodes.map((node) => [node.id, node]))
  const consumersOf = new Map<string, string[]>()
  for (const nodeId of order) consumersOf.set(nodeId, [])
  for (const node of pipeline.nodes) {
    for (const ref of dataReferencesOf(node)) {
      const list = consumersOf.get(ref)
      if (list !== undefined && !list.includes(node.id)) list.push(node.id)
    }
  }

  const datasets: DatasetLineage[] = []
  for (const nodeId of order) {
    const node = byId.get(nodeId)
    if (node?.type !== 'source') continue
    // Transitive closure over consumer edges, preserving order.
    const seen = new Set<string>()
    const queue = [...(consumersOf.get(nodeId) ?? [])]
    while (queue.length > 0) {
      const current = queue.shift()
      if (current === undefined || seen.has(current)) continue
      seen.add(current)
      for (const next of consumersOf.get(current) ?? []) {
        if (!seen.has(next)) queue.push(next)
      }
    }
    datasets.push({
      sourceId: nodeId,
      consumers: order.filter((id) => seen.has(id)),
    })
  }

  const nodes: NodeLineage[] = order.flatMap((nodeId) => {
    const node = byId.get(nodeId)
    if (node === undefined) return []
    return [
      {
        nodeId,
        inputs: dataReferencesOf(node),
        requires: node.type === 'publish' ? [...(node.requires ?? [])] : [],
        consumers: [...(consumersOf.get(nodeId) ?? [])],
      },
    ]
  })

  return { datasets, nodes }
}
