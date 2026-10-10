// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pipeline-runner error surface (p-3; p2-4 gate extensions).
 *
 * Two typed, **value-free** classes, mirroring the engine's error discipline
 * (ADR 0025): a refusal is an invalid *request* the runner rejects before any
 * engine call, and a failure is a *node* that the engine could not execute
 * after a run began. Neither ever carries SQL text, node ids in a message
 * body, dataset values, or the raw DuckDB error text — DuckDB errors can
 * embed offending values or composed statements, so they are dropped rather
 * than attached as a cause.
 *
 * p2-4 adds the gate preconditions: the surface must bind a parsed contract
 * per `validate` node and an explicit key set per `diff` node (C2 — never
 * guess), and the local backend must be able to map every declared
 * materialization mode. Missing bindings and unmappable modes are collected
 * and refused here, before any engine call, never discovered mid-run.
 *
 * p2c-1: a failed run's named partial state now carries each executed gate's
 * value-free verdict (`PipelineRunPartialNode.gate`), so a caller can honestly
 * report what an executed gate decided even though a later node failed. The
 * field is optional and additive (data nodes carry none; the failing node is
 * never in `partial` because it never completed).
 */
import type { PipelineRunGateResult } from './runner.js'

/** Why the runner refused a request before touching the engine. */
export type PipelineRunRefusalReason =
  /** The pipeline failed DAG/compilation validation. */
  | 'not-runnable'
  /** The supplied compile plan is internally inconsistent. */
  | 'invalid-plan'
  /** A source binding names a node that is not a source in the plan. */
  | 'unknown-source'
  /** A source node has no file binding. */
  | 'missing-source'
  /** Two bindings were supplied for the same source node. */
  | 'duplicate-source'
  /** A node relation uses the reserved `assay_*` namespace. */
  | 'forbidden-relation'
  /** A verbatim `sql` node was refused by the p-2 safety classifier. */
  | 'forbidden-sql'
  /** A declared materialization mode is not mappable by the local backend (ADR 0033). */
  | 'unsupported-materialization'
  /** An `export` node is consumed by another node, but exports materialize no relation. */
  | 'export-with-consumers'
  /** A `validate` node has no supplied parsed contract (C2: never guess). */
  | 'missing-contract'
  /** A contract binding names a node that is not a `validate` node. */
  | 'unknown-contract'
  /** A `diff` node has no supplied key set (C2: never guess). */
  | 'missing-diff-keys'
  /** A diff-key binding names a node that is not a `diff` node. */
  | 'unknown-diff-keys'
  /** A gate node cannot be evaluated: the host supplied no compiler/schema/exec ops. */
  | 'gate-unsupported'
  /** A candidate-reference request names a node that is not a data node of the supplied plan (p3-2). */
  | 'candidate-node-unknown'
  /** A candidate reference was asked for a canceled run — only completed/gated runs carry one (p3-2). */
  | 'candidate-run-canceled'
  /** The candidate node is in the plan but did not execute in the run (gated/canceled before it) (p3-2). */
  | 'candidate-node-absent'
  /** The candidate node executed but produced no materialized output (a gate or source result) (p3-2). */
  | 'candidate-not-materialized'
  /** The candidate node declares publish-mode materialization — the explicit P3/DCR boundary (ADR 0033/0035) (p3-2). */
  | 'publish-materialization'
  /** The materialized relation's schema could not be introspected for the fingerprint (p3-2). */
  | 'candidate-schema-unavailable'
  /** A candidate identity string is empty, NUL-bearing, or otherwise unusable (p3-2). */
  | 'candidate-identity-invalid'

/**
 * A run request the runner refused before any engine call. Value-free: the
 * `reason` is a fixed discriminant and the message names only the class of
 * the problem. `nodeId` (when present) is the node the refusal concerns —
 * node ids are schema, never dataset values. `nodeIds` names every node a
 * collected precondition refused (e.g. all missing contracts), so a caller
 * can disclose the full set at once.
 */
export class PipelineRunRefusalError extends Error {
  readonly nodeIds: readonly string[]

  constructor(
    readonly reason: PipelineRunRefusalReason,
    readonly nodeId: string | null = null,
    message?: string,
    nodeIds: readonly string[] = nodeId === null ? [] : [nodeId],
  ) {
    super(message ?? refusalMessage(reason))
    this.name = 'PipelineRunRefusalError'
    this.nodeIds = nodeIds
  }
}

function refusalMessage(reason: PipelineRunRefusalReason): string {
  switch (reason) {
    case 'not-runnable':
      return 'the pipeline is not runnable: DAG validation or compilation refused it'
    case 'invalid-plan':
      return 'the compiled pipeline plan is internally inconsistent'
    case 'unknown-source':
      return 'a source binding names a node that is not a source in the pipeline'
    case 'missing-source':
      return 'a source node has no dataset binding'
    case 'duplicate-source':
      return 'a source node was bound more than once'
    case 'forbidden-relation':
      return 'a pipeline node relation uses the reserved assay_ namespace'
    case 'forbidden-sql':
      return 'a verbatim SQL node was refused by the read-only safety classifier'
    case 'unsupported-materialization':
      return 'a declared materialization mode is not supported by the local runner'
    case 'export-with-consumers':
      return 'an export node is consumed by another node, but an export materializes no relation'
    case 'missing-contract':
      return 'a validate node has no parsed contract binding'
    case 'unknown-contract':
      return 'a contract binding names a node that is not a validate node'
    case 'missing-diff-keys':
      return 'a diff node has no key-set binding'
    case 'unknown-diff-keys':
      return 'a diff-key binding names a node that is not a diff node'
    case 'gate-unsupported':
      return 'a gate node cannot be evaluated: the host supplied no gate compiler or engine op'
    case 'candidate-node-unknown':
      return 'a candidate reference names a node that is not a data node of the supplied plan'
    case 'candidate-run-canceled':
      return 'a canceled run carries no candidate reference: only completed or gated runs do'
    case 'candidate-node-absent':
      return 'the candidate node did not execute in this run, so it left no materialized output'
    case 'candidate-not-materialized':
      return 'the candidate node produced no materialized output to reference'
    case 'publish-materialization':
      return 'a publish-mode materialization is never a candidate reference: the publish boundary stays explicit (ADR 0033/0035)'
    case 'candidate-schema-unavailable':
      return 'the materialized relation schema could not be introspected for the schema fingerprint'
    case 'candidate-identity-invalid':
      return 'a candidate identity string must be a non-empty NUL-free string'
  }
}

/**
 * One completed node in a failed run's named partial state (p2c-1).
 * `nodeId`/`relation` are schema (never dataset values). `gate` is the
 * executed gate's value-free verdict and is present exactly when the
 * completed node was a validate/diff/publish gate — the same
 * {@link PipelineRunGateResult} shape a successful run carries, one shape per
 * meaning. It is optional so existing callers that read only
 * `nodeId`/`relation` keep compiling (additive). The failing node is never in
 * `partial` (it never completed), so no verdict is fabricated for it.
 */
export interface PipelineRunPartialNode {
  readonly nodeId: string
  readonly relation: string
  /** The gate's value-free verdict (validate/diff/publish only). */
  readonly gate?: PipelineRunGateResult
}

/**
 * A node the engine could not execute after a run began. The failing node is
 * named by `nodeId` (schema, never data); `partial` is the named partial
 * state the run leaves in the session (the nodes completed before the
 * failure, with executed gates' value-free verdicts), so the caller can
 * inspect/export it and a re-run can replace it. The message is a fixed,
 * value-free class — the raw engine error is deliberately discarded.
 */
export class PipelineRunError extends Error {
  constructor(
    readonly nodeId: string,
    readonly partial: readonly PipelineRunPartialNode[],
  ) {
    super('the pipeline node could not be materialized')
    this.name = 'PipelineRunError'
  }
}
