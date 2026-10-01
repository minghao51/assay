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
 */

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
  }
}

/**
 * A node the engine could not execute after a run began. The failing node is
 * named by `nodeId` (schema, never data); `partial` is the named partial
 * state the run leaves in the session (the nodes completed before the
 * failure), so the caller can inspect/export it and a re-run can replace it.
 * The message is a fixed, value-free class — the raw engine error is
 * deliberately discarded.
 */
export class PipelineRunError extends Error {
  constructor(
    readonly nodeId: string,
    readonly partial: readonly { readonly nodeId: string; readonly relation: string }[],
  ) {
    super('the pipeline node could not be materialized')
    this.name = 'PipelineRunError'
  }
}
