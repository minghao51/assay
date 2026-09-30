// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pipeline-runner error surface (p-3).
 *
 * Two typed, **value-free** classes, mirroring the engine's error discipline
 * (ADR 0025): a refusal is an invalid *request* the runner rejects before any
 * engine call, and a failure is a *node* that the engine could not
 * materialize after a run began. Neither ever carries SQL text, node ids in a
 * message body, dataset values, or the raw DuckDB error text — DuckDB errors
 * can embed offending values or composed statements, so they are dropped
 * rather than attached as a cause.
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

/**
 * A run request the runner refused before any engine call. Value-free: the
 * `reason` is a fixed discriminant and the message names only the class of
 * the problem. `nodeId` (when present) is the node the refusal concerns —
 * node ids are schema, never dataset values.
 */
export class PipelineRunRefusalError extends Error {
  constructor(
    readonly reason: PipelineRunRefusalReason,
    readonly nodeId: string | null = null,
    message?: string,
  ) {
    super(message ?? refusalMessage(reason))
    this.name = 'PipelineRunRefusalError'
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
  }
}

/**
 * A node the engine could not materialize after a run began. The failing
 * node is named by `nodeId` (schema, never data); `partial` is the named
 * partial state the run leaves in the session (the nodes materialized before
 * the failure), so the caller can inspect/export it and a re-run can replace
 * it. The message is a fixed, value-free class — the raw engine error is
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
