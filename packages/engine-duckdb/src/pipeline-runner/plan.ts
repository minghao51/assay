// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure plan resolution and boundary gates for the pipeline runner (p-3;
 * p2-4 gate execution).
 *
 * This module never touches an engine. It turns the runner's input — a
 * validated `PipelineV1` IR or an already-compiled plan — into the
 * deterministic {@link PipelineRunPlan} the executor drives, and enforces
 * every precondition the runner owns:
 *
 * - the **verbatim-SQL gate**: every materialized query must pass the p-2
 *   `classifyVerbatimSql` classifier before it can reach an engine call
 *   (the p-2 compiler already ran it for IR inputs; a plan input or a
 *   programmatic IR is re-checked here, and again worker-side);
 * - the **reserved-relation gate**: a node relation is the node id and may
 *   never enter the engine-managed `assay_*` namespace;
 * - the **materialization gate** (p2-4): only the local modes the runner can
 *   map (`view`/`ephemeral`/`table`/`export`) pass; `cache`/`incremental`/
 *   `publish` are typed refusals (ADR 0033);
 * - the **export-consumer gate** (p2-4): an `export` node materializes no
 *   relation, so a node consumed by another node is refused;
 * - the **gate-binding gate** (p2-4, C2): every `validate` node has a parsed
 *   contract binding and every `diff` node an explicit key set — missing or
 *   misaddressed bindings are collected and refused before any engine call.
 *
 * ## Two-gate spelling split (p2-3 carry-over c)
 *
 * The p2-3 carry-over noted that parse and compile classify a garbage
 * materialization spelling differently (the parser rejects it as
 * `out-of-range`/`unknown-key`; the compiler's defensive path would reuse
 * `unsupported-materialization`). This runner never sees a garbage spelling
 * from an IR input (parse is total and upstream), and a caller-supplied plan
 * is held to the *presence/consistency* check in {@link validateCompilePlan}
 * rather than re-classifying spellings. The split is therefore documented,
 * not re-decided: parse owns spelling classification; this module owns
 * supportability.
 */
import { classifyVerbatimSql, compilePipeline, validatePipeline } from '@assay/pipeline'
import type {
  CompiledNode,
  MaterializationMode,
  PipelineCompilePlan,
  PipelineV1,
} from '@assay/pipeline'
import { PipelineRunRefusalError } from './errors.js'
import type { PipelineRunRefusalReason } from './errors.js'

/** The runner's input: a pipeline IR or a plan the p-2/p2-3 compiler produced. */
export type PipelineRunInput = PipelineV1 | PipelineCompilePlan

/** A column name/type pair as the engine reports it (structural mirror). */
export interface PipelineRunColumn {
  readonly name: string
  readonly type: string
}

/** A parsed contract bound to a `validate` node (C2: supplied, never resolved). */
export interface PipelineRunContractBinding {
  readonly nodeId: string
  /** The parsed contract AST (`@assay/contracts` `ContractV1`); opaque here. */
  readonly contract: unknown
}

/** An explicit key set bound to a `diff` node (C2: supplied, never inferred). */
export interface PipelineRunDiffKeysBinding {
  readonly nodeId: string
  readonly keys: readonly string[]
}

/** The runtime bindings the surface supplies for gate nodes. */
export interface PipelineRunBindings {
  readonly contracts?: readonly PipelineRunContractBinding[]
  readonly diffKeys?: readonly PipelineRunDiffKeysBinding[]
}

/** The materialization modes the local runner maps to engine statements. */
export const LOCAL_RUN_MATERIALIZATION_MODES = ['view', 'ephemeral', 'table', 'export'] as const

export type LocalRunMaterializationMode = (typeof LOCAL_RUN_MATERIALIZATION_MODES)[number]

/** A data node prepared for execution (a source registers; others materialize). */
export interface PipelineRunDataNode {
  readonly class: 'data'
  readonly nodeId: string
  readonly relation: string
  readonly quotedRelation: string
  readonly sql: string | null
  readonly materialization: LocalRunMaterializationMode
  /** The p2-3 statement; `null` for a source. Validated, not re-executed. */
  readonly statement: string | null
  readonly statementKind: 'source' | 'view' | 'table' | 'export'
}

/** A `validate` node: run the M5 machinery over `input` with `contract`. */
export interface PipelineRunValidateNode {
  readonly class: 'validate'
  readonly nodeId: string
  readonly input: string
  readonly contract: unknown
}

/** A `diff` node: run the M6 row-diff machinery over `input` vs `against`. */
export interface PipelineRunDiffNode {
  readonly class: 'diff'
  readonly nodeId: string
  readonly input: string
  readonly against: string
  readonly keys: readonly string[]
}

/** A `publish` node: gate evaluation — every `requires` edge must have succeeded. */
export interface PipelineRunPublishNode {
  readonly class: 'publish'
  readonly nodeId: string
  readonly input: string
  readonly requires: readonly string[]
}

export type PipelineRunPlanNode =
  PipelineRunDataNode | PipelineRunValidateNode | PipelineRunDiffNode | PipelineRunPublishNode

/** The runner's resolved, executable plan. */
export interface PipelineRunPlan {
  readonly order: readonly string[]
  readonly nodes: readonly PipelineRunPlanNode[]
}

function isCompilePlan(input: PipelineRunInput): input is PipelineCompilePlan {
  return Array.isArray((input as { order?: unknown }).order)
}

function isLocalMaterializationMode(
  mode: MaterializationMode,
): mode is LocalRunMaterializationMode {
  return (LOCAL_RUN_MATERIALIZATION_MODES as readonly string[]).includes(mode)
}

/** The effective materialization mode of a data node (absent = `view`). */
function effectiveMaterialization(node: {
  readonly materialization?: MaterializationMode
}): MaterializationMode {
  return node.materialization ?? 'view'
}

/**
 * Resolve the input to a runnable {@link PipelineRunPlan}, collecting and
 * refusing every precondition failure before returning. An IR input is
 * compiled (its data subgraph — gates are typed separately; a data node can
 * never depend on a gated node by port rule) and its gates are bound; a plan
 * input is validated structurally (it carries no gates).
 */
export function resolvePlan(
  input: PipelineRunInput,
  bindings: PipelineRunBindings = {},
): PipelineRunPlan {
  if (isCompilePlan(input)) {
    validateCompilePlan(input)
    return {
      order: input.order,
      nodes: input.nodes.map((node) => dataNodeFromCompiled(node)),
    }
  }
  return resolveIrPlan(input, bindings)
}

/** Map one compiled data entry to its run-plan node (defensive defaults). */
function dataNodeFromCompiled(node: CompiledNode): PipelineRunDataNode {
  const mode = effectiveMaterialization(node)
  return {
    class: 'data',
    nodeId: node.nodeId,
    relation: node.relation,
    quotedRelation: node.quotedRelation,
    sql: node.sql,
    materialization: isLocalMaterializationMode(mode) ? mode : 'view',
    statement: node.sql === null ? null : (node.statement ?? null),
    statementKind: node.sql === null ? 'source' : (node.statementKind ?? 'view'),
  }
}

/** Resolve + precondition-check an IR input into a run plan. */
function resolveIrPlan(ir: PipelineV1, bindings: PipelineRunBindings): PipelineRunPlan {
  const validation = validatePipeline(ir)
  if (!validation.ok) {
    throw new PipelineRunRefusalError('not-runnable')
  }

  const failures: { reason: PipelineRunRefusalReason; nodeId: string }[] = []
  const collect = (reason: PipelineRunRefusalReason, nodeId: string): void => {
    failures.push({ reason, nodeId })
  }

  // Referenced ids: any consumer of an export relation, and gate addresses.
  const referenced = new Set<string>()
  for (const node of ir.nodes) {
    if (node.type === 'transform' || node.type === 'sql') {
      for (const input of node.inputs) referenced.add(input)
    } else if (node.type === 'validate' || node.type === 'publish') {
      referenced.add(node.input)
      if (node.type === 'publish') {
        for (const gate of node.requires ?? []) referenced.add(gate)
      }
    } else if (node.type === 'diff') {
      referenced.add(node.input)
      referenced.add(node.against)
    }
  }

  const dataNodes = ir.nodes.filter(
    (node) => node.type === 'source' || node.type === 'transform' || node.type === 'sql',
  )
  for (const node of dataNodes) {
    const mode = effectiveMaterialization(node)
    if (!isLocalMaterializationMode(mode)) {
      collect('unsupported-materialization', node.id)
    } else if (mode === 'export' && referenced.has(node.id)) {
      collect('export-with-consumers', node.id)
    }
  }

  // Gate bindings: unknown addresses and missing bindings, all collected.
  const contracts = new Map<string, unknown>()
  for (const binding of bindings.contracts ?? []) {
    if (!ir.nodes.some((node) => node.id === binding.nodeId && node.type === 'validate')) {
      collect('unknown-contract', binding.nodeId)
    } else {
      contracts.set(binding.nodeId, binding.contract)
    }
  }
  const diffKeys = new Map<string, readonly string[]>()
  for (const binding of bindings.diffKeys ?? []) {
    if (!ir.nodes.some((node) => node.id === binding.nodeId && node.type === 'diff')) {
      collect('unknown-diff-keys', binding.nodeId)
    } else {
      diffKeys.set(binding.nodeId, binding.keys)
    }
  }
  for (const node of ir.nodes) {
    if (node.type === 'validate' && !contracts.has(node.id)) collect('missing-contract', node.id)
    if (node.type === 'diff' && !diffKeys.has(node.id)) collect('missing-diff-keys', node.id)
  }

  if (failures.length > 0) {
    const [first, ...rest] = failures
    const all = [first, ...rest]
    const reason = first.reason
    throw new PipelineRunRefusalError(
      reason,
      first.nodeId,
      undefined,
      all.filter((entry) => entry.reason === reason).map((entry) => entry.nodeId),
    )
  }

  // The data subgraph never depends on a gated node (port rule), so it
  // compiles independently; gates are bound from the original IR.
  const compiled = compilePipeline({ ...ir, nodes: dataNodes })
  if (!compiled.ok) {
    throw new PipelineRunRefusalError('not-runnable')
  }
  const byId = new Map(compiled.plan.nodes.map((node) => [node.nodeId, node]))
  const nodes: PipelineRunPlanNode[] = []
  for (const id of validation.order) {
    const irNode = ir.nodes.find((node) => node.id === id)
    if (irNode === undefined) continue
    if (irNode.type === 'source' || irNode.type === 'transform' || irNode.type === 'sql') {
      const entry = byId.get(id)
      if (entry !== undefined) nodes.push(dataNodeFromCompiled(entry))
    } else if (irNode.type === 'validate') {
      nodes.push({
        class: 'validate',
        nodeId: id,
        input: irNode.input,
        contract: contracts.get(id),
      })
    } else if (irNode.type === 'diff') {
      nodes.push({
        class: 'diff',
        nodeId: id,
        input: irNode.input,
        against: irNode.against,
        keys: diffKeys.get(id) ?? [],
      })
    } else {
      nodes.push({
        class: 'publish',
        nodeId: id,
        input: irNode.input,
        requires: [...(irNode.requires ?? [])],
      })
    }
  }
  return { order: validation.order, nodes }
}

/**
 * Structural integrity + presence/consistency check for a caller-supplied
 * compile plan (p2-4 tightening): exactly one node per topological entry,
 * ids consistent, relations equal to node ids, sources query-free,
 * executable nodes carrying non-empty SQL **and** a materialization kind
 * consistent with their statement (`view`/`ephemeral` ⇒ `view`, `table` ⇒
 * `table`, `export` ⇒ `export`; sources ⇒ `source` with a `null` statement).
 * A non-local mode is a typed `unsupported-materialization` refusal. A plan
 * that fails any structural check cannot be compiler output.
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
      continue
    }
    if (node.kind !== 'transform' && node.kind !== 'sql') {
      throw new PipelineRunRefusalError('invalid-plan', nodeId)
    }
    if (typeof node.sql !== 'string' || node.sql.length === 0) {
      throw new PipelineRunRefusalError('invalid-plan', nodeId)
    }
    const mode = effectiveMaterialization(node)
    if (!isLocalMaterializationMode(mode)) {
      throw new PipelineRunRefusalError('unsupported-materialization', nodeId)
    }
    const expectedKind = mode === 'table' ? 'table' : mode === 'export' ? 'export' : 'view'
    if (typeof node.statement !== 'string' || node.statement.length === 0) {
      throw new PipelineRunRefusalError('invalid-plan', nodeId)
    }
    if (node.statementKind !== expectedKind) {
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
