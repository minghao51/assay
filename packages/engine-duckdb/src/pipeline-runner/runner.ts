// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pipeline runner (p-3; p2-4 gate execution + materialization).
 *
 * ## Contract
 *
 * `executePipeline` takes a pipeline IR (compiled here with the pure p-2
 * `compilePipeline` for its data subgraph) or a compiled plan, one explicit
 * user-triggered call — no scheduling, retries, sensors, or run-state
 * persistence (ADR 0032). Data nodes materialize per their ADR 0033 mode: a
 * `source` registers its file and becomes a view; `view`/`ephemeral` a
 * session view; `table` a DuckDB table; `export` a Parquet artifact under
 * `assay-exports/` (the artifact path is returned, value-free). A re-run
 * recreates relations, never appends.
 *
 * ## Gates (p2-4; ADR 0035)
 *
 * `validate` nodes run the EXISTING M5 machinery: the host supplies the
 * parsed contract (C2 — the engine never resolves paths), the runner reads
 * the input relation's schema, compiles the contract plan through the injected
 * {@link PipelineRunCompilers.validate}, and executes it over the relation
 * (`ops.validate`). A rule violation stops the run at that gate as the
 * first-class {@link PipelineRunGated} outcome. `diff` nodes run the M6
 * row-diff machinery against two session relations (`ops.diff`); their
 * value-free aspect counts are surfaced in the node result. `publish` nodes
 * are gate evaluation only — every `requires` edge must have SUCCEEDED; a
 * blocked publish is the gated outcome, and publish-MODE materialization is a
 * typed refusal at plan resolution (the P3/DCR boundary, product/04).
 *
 * ## Outcomes
 *
 * - `completed` — every node executed; data nodes carry their relation and
 *   row count, gates their value-free verdict.
 * - `gated` — a gate stopped the run: `gatedAt` names where evaluation
 *   stopped and `nodes` is every executed node in execution order (a failed
 *   validate consumed by a publish is included; the publish's own result is
 *   the gate for a blocked publish). No downstream node runs.
 * - `canceled` — the supplied {@link PipelineRunGuard} was invalidated at a
 *   node boundary; `nodes` is the named partial state.
 * - a thrown {@link PipelineRunError} — a node failed. The failing node is
 *   named and the completed prefix is left as named partial state (value-free).
 *
 * Invalid requests (uncompilable IR, inconsistent plan, unknown/missing
 * source/contract/diff-key binding, reserved relation, refused SQL,
 * unmappable mode, export with consumers) throw a
 * {@link PipelineRunRefusalError} before any engine call.
 *
 * ## Lanes (ADR 0040)
 *
 * The heavy work the runner issues (source registration, materialization,
 * export, validate, diff) is query-lane, so a pipeline run can never starve
 * the grid's registry-lane windows. Gate execution additionally resolves each
 * input relation through the cheap registry-lane handle/schema probe (p2-1)
 * before compiling its plan; that probe is one metadata op, not a scan.
 */
import type { EngineRowDiffPlan, EngineRowDiffResult } from '../diff-plan-wire.js'
import type { EngineValidationPlan, EngineValidationResult } from '../validate-plan-wire.js'
import { PipelineRunError, PipelineRunRefusalError } from './errors.js'
import { PipelineRunGuard } from './guard.js'
import { assertRunnableRelation, assertSqlAccepted, resolvePlan } from './plan.js'
import type {
  PipelineRunColumn,
  PipelineRunContractBinding,
  PipelineRunDiffKeysBinding,
  PipelineRunInput,
  PipelineRunPlan,
  PipelineRunPlanNode,
} from './plan.js'

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

/** One executed node's addressable outcome. */
export interface PipelineRunNodeResult {
  readonly nodeId: string
  /** The output relation (the node id); for a gate, the input relation. */
  readonly relation: string
  readonly rowCount: number
  /**
   * How the node materialized: `source`, the effective ADR 0033 data mode, or
   * `gate` for a validate/diff/publish verdict.
   */
  readonly materialization: 'source' | 'view' | 'ephemeral' | 'table' | 'export' | 'gate'
  /** An export node's OPFS artifact path (value-free; export only). */
  readonly exportPath?: string
  /** A gate node's value-free verdict (validate/diff/publish only). */
  readonly gate?: PipelineRunGateResult
}

/** A gate node's value-free result (never dataset values). */
export type PipelineRunGateResult =
  | {
      readonly class: 'validate'
      readonly input: string
      readonly valid: boolean
      /** How many rules were violated (0 when valid). */
      readonly violatedRules: number
    }
  | {
      readonly class: 'diff'
      readonly input: string
      readonly against: string
      readonly added: number
      readonly removed: number
      readonly changed: number
    }
  | {
      readonly class: 'publish'
      readonly input: string
      /** The `requires` edges that had not succeeded ([] when the gate passed). */
      readonly blockedGates: readonly string[]
    }

export interface PipelineRunCompleted {
  readonly status: 'completed'
  readonly nodes: readonly PipelineRunNodeResult[]
}

export interface PipelineRunCanceled {
  readonly status: 'canceled'
  /** Named partial state: nodes executed before cancellation. */
  readonly nodes: readonly PipelineRunNodeResult[]
  /** The node that was not executed, or `null` on a trailing cancellation. */
  readonly nextNodeId: string | null
}

/**
 * A gate stopped the run (p2-4): `gatedAt` names where evaluation stopped and
 * `nodes` is every executed node in execution order — including a failed
 * validate consumed by a publish (whose own result is the gate for a blocked
 * publish). No downstream node executed. `nextNodeId` mirrors `canceled` (the
 * next unexecuted node) so existing surfaces that render either outcome
 * compile unchanged.
 */
export interface PipelineRunGated {
  readonly status: 'gated'
  readonly nodes: readonly PipelineRunNodeResult[]
  /** The gate node the run stopped at. */
  readonly gatedAt: string
  /** Which gate class stopped the run. */
  readonly gate: 'validation-failed' | 'publish-blocked'
  /** The next unexecuted node, or `null` on a trailing gate. */
  readonly nextNodeId: string | null
}

export type PipelineRunResult = PipelineRunCompleted | PipelineRunCanceled | PipelineRunGated

/** A compiled export artifact (value-free: an OPFS path and counts). */
export interface PipelineRunExport {
  readonly path: string
  readonly rowCount: number
  readonly bytes: number
}

/** The input to a host-supplied M5 validation-plan compiler (C2). */
export interface PipelineRunValidationCompilerInput {
  /** The reserved binding-view name the plan validates through. */
  readonly relation: string
  readonly columns: readonly PipelineRunColumn[]
  /** The parsed contract AST the host bound to this node. */
  readonly contract: unknown
}

/** The input to a host-supplied M6 row-diff-plan compiler. */
export interface PipelineRunDiffCompilerInput {
  /** The reserved binding-view names the plan renders. */
  readonly relationA: string
  readonly relationB: string
  readonly schemaA: readonly PipelineRunColumn[]
  readonly schemaB: readonly PipelineRunColumn[]
  readonly keys: readonly string[]
}

/**
 * Host-supplied pure plan compilers. They live outside this package so the
 * engine stays dependency-free of `@assay/validation`/`@assay/diff` (the
 * `validate-plan-wire`/`diff-plan-wire` boundary); the compiled plans are the
 * same structural wire mirrors the engine ops already execute.
 */
export interface PipelineRunCompilers {
  readonly validate?: (
    input: PipelineRunValidationCompilerInput,
  ) => { readonly ok: true; readonly plan: EngineValidationPlan } | { readonly ok: false }
  readonly diff?: (
    input: PipelineRunDiffCompilerInput,
  ) => { readonly ok: true; readonly plan: EngineRowDiffPlan } | { readonly ok: false }
}

export interface PipelineRunOptions<TSource extends PipelineRunSourceFile = PipelineRunSourceFile> {
  /** Dataset binding for every `source` node; required for each source. */
  readonly sources?: readonly PipelineRunSource<TSource>[]
  /** Cancellation guard; omit for an uncancellable run. */
  readonly guard?: PipelineRunGuard
  /**
   * Progress hook: called with each node id at its execution boundary, after
   * the guard check and before the node's engine op.
   */
  readonly onNode?: (nodeId: string) => void
  /** Parsed contract bindings for `validate` nodes (C2: supplied, never resolved). */
  readonly contracts?: readonly PipelineRunContractBinding[]
  /** Explicit key-set bindings for `diff` nodes (C2: supplied, never inferred). */
  readonly diffKeys?: readonly PipelineRunDiffKeysBinding[]
  /** Pure plan compilers for gate nodes (see {@link PipelineRunCompilers}). */
  readonly compilers?: PipelineRunCompilers
}

/**
 * The engine operations the runner drives. Kept structural (and separate from
 * the client) so the orchestration is pure and Node-testable: the real client
 * binds these to its typed postMessage ops, the CLI seam to a Node connection.
 */
export interface PipelineRunEngineOps<
  TSource extends PipelineRunSourceFile = PipelineRunSourceFile,
> {
  /** Register a dataset as the relation name; resolve its row count. */
  registerSource(relation: string, source: TSource): Promise<number>
  /** Materialize a view/ephemeral/table relation; resolve its row count. */
  materialize(
    relation: string,
    sql: string,
    materialization: 'view' | 'ephemeral' | 'table',
  ): Promise<number>
  /** Export a query to the given OPFS path (optional: a host may not support export). */
  exportRelation?(relation: string, sql: string, path: string): Promise<PipelineRunExport>
  /** The schema of an existing session relation (gate-plan compilation input). */
  schemaOf?(relation: string): Promise<readonly PipelineRunColumn[]>
  /** Execute a compiled M5 validation plan over a session relation. */
  validate?(relation: string, plan: EngineValidationPlan): Promise<EngineValidationResult>
  /** Execute a compiled M6 row-diff plan over two session relations. */
  diff?(
    inputRelation: string,
    againstRelation: string,
    plan: EngineRowDiffPlan,
  ): Promise<EngineRowDiffResult>
}

/** The reserved binding-view names gate plans render through. */
const PIPELINE_VALIDATION_RELATION = 'assay_pipeline_validation'
const PIPELINE_DIFF_RELATION_A = 'assay_pipeline_diff_a'
const PIPELINE_DIFF_RELATION_B = 'assay_pipeline_diff_b'

/**
 * The deterministic, path-safe OPFS destination for an export node (p2-4).
 * The `assay-pipeline-export-` prefix is distinct from the `engine/export`
 * op's `assay-export-<seq>` sequence, and the stem encoding mirrors the
 * p2-3 compiler's (ASCII letters/digits/`-`/`_`, every other UTF-16 code
 * unit as `~XXXX`). This is where the RUNNER owns path resolution — the
 * compiler's composed destination is a pure mapping, not an OPFS path.
 */
export function pipelineExportPath(relation: string): string {
  return `assay-exports/assay-pipeline-export-${encodeExportStem(relation)}.parquet`
}

function encodeExportStem(id: string): string {
  let out = ''
  for (let index = 0; index < id.length; index++) {
    const code = id.charCodeAt(index)
    const ch = id[index] as string
    const safe =
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      ch === '-' ||
      ch === '_'
    out += safe ? ch : `~${code.toString(16).padStart(4, '0')}`
  }
  return out
}

function indexSources<TSource extends PipelineRunSourceFile>(
  sources: readonly PipelineRunSource<TSource>[] | undefined,
  nodes: readonly PipelineRunPlanNode[],
): Map<string, TSource> {
  const sourceNodes = new Set(
    nodes
      .filter((node) => node.class === 'data' && node.statementKind === 'source')
      .map((node) => node.nodeId),
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
    if (node.class === 'data' && node.statementKind === 'source' && !byNode.has(node.nodeId)) {
      throw new PipelineRunRefusalError('missing-source', node.nodeId)
    }
  }
  return byNode
}

/**
 * Precondition check (before any engine call): every gate/export node has the
 * ops and compilers it needs. Missing support is a typed refusal, never a
 * mid-run surprise.
 */
function assertExecutionSupport<TSource extends PipelineRunSourceFile>(
  plan: PipelineRunPlan,
  ops: PipelineRunEngineOps<TSource>,
  compilers: PipelineRunCompilers | undefined,
): void {
  for (const node of plan.nodes) {
    if (node.class === 'validate') {
      if (
        ops.schemaOf === undefined ||
        ops.validate === undefined ||
        compilers?.validate === undefined
      ) {
        throw new PipelineRunRefusalError('gate-unsupported', node.nodeId)
      }
    } else if (node.class === 'diff') {
      if (ops.schemaOf === undefined || ops.diff === undefined || compilers?.diff === undefined) {
        throw new PipelineRunRefusalError('gate-unsupported', node.nodeId)
      }
    } else if (
      node.class === 'data' &&
      node.statementKind !== 'source' &&
      node.materialization === 'export' &&
      ops.exportRelation === undefined
    ) {
      throw new PipelineRunRefusalError('unsupported-materialization', node.nodeId)
    }
  }
}

function partialOf(
  nodes: readonly PipelineRunNodeResult[],
): readonly { readonly nodeId: string; readonly relation: string }[] {
  return nodes.map((entry) => ({ nodeId: entry.nodeId, relation: entry.relation }))
}

/** Sum a diff result's three aspects, value-free. */
function diffCounts(result: EngineRowDiffResult): {
  added: number
  removed: number
  changed: number
} {
  const counts = { added: 0, removed: 0, changed: 0 }
  for (const aspect of result.aspects) {
    if (aspect.aspect === 'added') counts.added = aspect.count
    else if (aspect.aspect === 'removed') counts.removed = aspect.count
    else counts.changed = aspect.count
  }
  return counts
}

/** Execute a pipeline (or plan) once, node-by-node, in topological order. */
export async function executePipeline<TSource extends PipelineRunSourceFile>(
  input: PipelineRunInput,
  options: PipelineRunOptions<TSource>,
  ops: PipelineRunEngineOps<TSource>,
): Promise<PipelineRunResult> {
  const plan = resolvePlan(input, {
    ...(options.contracts === undefined ? {} : { contracts: options.contracts }),
    ...(options.diffKeys === undefined ? {} : { diffKeys: options.diffKeys }),
  })
  const bindings = indexSources(options.sources, plan.nodes)
  for (const node of plan.nodes) {
    if (node.class === 'data') assertRunnableRelation(node.nodeId, node.relation)
  }
  assertExecutionSupport(plan, ops, options.compilers)

  const guard = options.guard ?? new PipelineRunGuard()
  const token = guard.begin()
  const done: PipelineRunNodeResult[] = []
  const succeeded = new Set<string>()
  const rowCounts = new Map<string, number>()
  /** Validate nodes a publish depends on: their failure is reported at the publish. */
  const requiredByPublish = new Set<string>()
  for (const node of plan.nodes) {
    if (node.class === 'publish') for (const gate of node.requires) requiredByPublish.add(gate)
  }
  const failedValidates: string[] = []

  const gated = (
    gate: 'validation-failed' | 'publish-blocked',
    gatedAt: string,
  ): PipelineRunGated => {
    const index = plan.order.indexOf(gatedAt)
    const next = index >= 0 && index + 1 < plan.order.length ? plan.order[index + 1]! : null
    return { status: 'gated', nodes: [...done], gatedAt, gate, nextNodeId: next }
  }

  for (const node of plan.nodes) {
    if (!guard.isActive(token)) {
      return { status: 'canceled', nodes: done, nextNodeId: node.nodeId }
    }
    options.onNode?.(node.nodeId)
    if (!guard.isActive(token)) {
      return { status: 'canceled', nodes: done, nextNodeId: node.nodeId }
    }
    let result: PipelineRunNodeResult
    try {
      if (node.class === 'data') {
        result = await runDataNode(node, bindings, ops)
      } else if (node.class === 'validate') {
        const columns = await ops.schemaOf!(node.input)
        const compiled = options.compilers!.validate!({
          relation: PIPELINE_VALIDATION_RELATION,
          columns,
          contract: node.contract,
        })
        if (!compiled.ok) {
          throw new PipelineRunError(node.nodeId, partialOf(done))
        }
        const verdict = await ops.validate!(node.input, compiled.plan)
        const violatedRules = verdict.rules.filter((rule) => rule.failCount > 0).length
        result = {
          nodeId: node.nodeId,
          relation: node.input,
          rowCount: verdict.rowCount,
          materialization: 'gate',
          gate: {
            class: 'validate',
            input: node.input,
            valid: verdict.valid,
            violatedRules,
          },
        }
        if (!verdict.valid) {
          failedValidates.push(node.nodeId)
          done.push(result)
          // A validate no publish depends on stops the run at the gate; a
          // validate that a publish consumes is reported by that publish
          // (the publish's `requires` evaluation is the gate).
          if (!requiredByPublish.has(node.nodeId)) {
            return gated('validation-failed', node.nodeId)
          }
          continue
        }
      } else if (node.class === 'diff') {
        const schemaA = await ops.schemaOf!(node.input)
        const schemaB = await ops.schemaOf!(node.against)
        const compiled = options.compilers!.diff!({
          relationA: PIPELINE_DIFF_RELATION_A,
          relationB: PIPELINE_DIFF_RELATION_B,
          schemaA,
          schemaB,
          keys: node.keys,
        })
        if (!compiled.ok) {
          throw new PipelineRunError(node.nodeId, partialOf(done))
        }
        const diffResult = await ops.diff!(node.input, node.against, compiled.plan)
        const counts = diffCounts(diffResult)
        result = {
          nodeId: node.nodeId,
          relation: node.input,
          rowCount: diffResult.rowCountA,
          materialization: 'gate',
          gate: {
            class: 'diff',
            input: node.input,
            against: node.against,
            added: counts.added,
            removed: counts.removed,
            changed: counts.changed,
          },
        }
      } else {
        const blockedGates = node.requires.filter((gate) => !succeeded.has(gate))
        result = {
          nodeId: node.nodeId,
          relation: node.input,
          rowCount: rowCounts.get(node.input) ?? 0,
          materialization: 'gate',
          gate: { class: 'publish', input: node.input, blockedGates },
        }
        if (blockedGates.length > 0) {
          done.push(result)
          return gated('publish-blocked', node.nodeId)
        }
      }
    } catch (error) {
      if (error instanceof PipelineRunRefusalError) throw error
      if (error instanceof PipelineRunError) throw error
      // Value-free node failure: the raw engine text never leaves this catch.
      throw new PipelineRunError(node.nodeId, partialOf(done))
    }
    done.push(result)
    succeeded.add(node.nodeId)
    rowCounts.set(node.nodeId, result.rowCount)
  }

  if (!guard.isActive(token)) {
    return { status: 'canceled', nodes: done, nextNodeId: null }
  }
  if (failedValidates.length > 0) {
    // Defensive: every failed validate was either returned above or consumed
    // by a publish; this keeps a future plan shape from completing silently.
    return gated('validation-failed', failedValidates[0]!)
  }
  return { status: 'completed', nodes: done }
}

/** Execute one data node (source registration, materialization, or export). */
async function runDataNode<TSource extends PipelineRunSourceFile>(
  node: Extract<PipelineRunPlan['nodes'][number], { class: 'data' }>,
  bindings: Map<string, TSource>,
  ops: PipelineRunEngineOps<TSource>,
): Promise<PipelineRunNodeResult> {
  if (node.statementKind === 'source') {
    const source = bindings.get(node.nodeId)
    if (source === undefined) {
      throw new PipelineRunRefusalError('missing-source', node.nodeId)
    }
    const rowCount = await ops.registerSource(node.relation, source)
    return {
      nodeId: node.nodeId,
      relation: node.relation,
      rowCount,
      materialization: 'source',
    }
  }
  assertSqlAccepted(node.nodeId, node.sql as string)
  if (node.materialization === 'export') {
    const path = pipelineExportPath(node.relation)
    const exported = await ops.exportRelation!(node.relation, node.sql as string, path)
    return {
      nodeId: node.nodeId,
      relation: node.relation,
      rowCount: exported.rowCount,
      materialization: 'export',
      exportPath: exported.path,
    }
  }
  const mode = node.materialization as 'view' | 'ephemeral' | 'table'
  const rowCount = await ops.materialize(node.relation, node.sql as string, mode)
  return {
    nodeId: node.nodeId,
    relation: node.relation,
    rowCount,
    materialization: mode,
  }
}
