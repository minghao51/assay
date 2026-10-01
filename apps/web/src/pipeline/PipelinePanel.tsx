// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useMemo, useRef, useState } from 'react'
import type { PipelineError } from '@assay/pipeline'
import {
  buildLineage,
  buildNodeViews,
  isPreviewable,
  isSchemaDeltaEmpty,
  nodeStatusesForRun,
  schemaDelta,
  viewableRelationsForRun,
} from './pipeline-model'
import type { PipelineNodeView } from './pipeline-model'
import type {
  ContractBindingState,
  NodeRunStatus,
  PipelineFileState,
  PipelinePreviewState,
  PipelineRunOutcome,
  PipelineRunState,
  SourceBindingState,
} from './pipeline-state'
import { sanitizePipelineText } from './sanitize'
import { DataGrid } from '../grid/DataGrid'

/**
 * The Pipeline workbench section body (p-5; p2-6 preview/gates/lineage).
 *
 * A **list, not a graph**: the validated DAG renders as one accessible
 * ordered list (`<ol>`) in the plan's deterministic topological order —
 * per node: id, kind, relation, materialization badge, live status, gate
 * verdict. Lineage is likewise ordered lists (arch §16) — there is
 * deliberately NO visual graph editor (ADR 0032; the panel stays an ordered
 * list until q-15 possibly re-homes it).
 *
 * States (all honest, value-free — ADR 0025): none / opening / read-failed /
 * parse-error / invalid / loaded, plus the run lifecycle (idle / refused /
 * running / completed / gated / canceled / failed) and the per-node preview
 * (closed / loading / ready / failed).
 *
 * Preview (arch §15): a materialized data node's relation opens grid-native
 * through the p2-1 `registerPipelineRelation` op — the returned handle drives
 * the EXISTING `DataGrid` renderer over the existing grid model (the same
 * path a dataset open uses), never a SQL-result detour. The preview shows
 * sample rows, the output schema, a schema delta against the single input,
 * and the p2-3 generated query (transform/sql nodes). Relations live for the
 * engine session (disclosed).
 *
 * Gates (ADR 0035): validate pass/fail is surfaced value-free (violated-rule
 * count, never rule values), a blocked publish lists its missing gates, and a
 * run that stops at a gate is the honest `gated` state (what completed, what
 * was not executed, what a re-run needs).
 *
 * Privacy: picked file names and contract names are never rendered; no
 * telemetry is emitted from this panel (`pipeline_run` is reserved).
 */

export interface PipelinePanelProps {
  readonly fileState: PipelineFileState
  readonly bindings: Readonly<Record<string, SourceBindingState>>
  readonly contractBindings: Readonly<Record<string, ContractBindingState>>
  readonly runState: PipelineRunState
  readonly preview: PipelinePreviewState
  readonly onOpenPipelineFile: () => void
  readonly onBindSource: (nodeId: string) => void
  readonly onBindContract: (nodeId: string) => void
  readonly onRun: () => void
  readonly onCancel: () => void
  readonly onOpenPreview: (nodeId: string) => void
  readonly onClosePreview: () => void
}

/** One sanitized, located pipeline-error line (the p-1 canonical form). */
function errorLine(error: PipelineError): string {
  const location =
    error.line !== undefined && error.column !== undefined
      ? `${error.path}:${String(error.line)}:${String(error.column)}`
      : error.path
  return sanitizePipelineText(`${location}: ${error.message}`)
}

function errorList(errors: readonly PipelineError[]): readonly string[] {
  return errors.map(errorLine)
}

/** The materialization badge label (text-only, dual-scheme legible). */
function materializationLabel(materialization: string): string {
  switch (materialization) {
    case 'source':
      return 'source'
    case 'table':
      return 'table'
    case 'export':
      return 'export'
    case 'gate':
      return 'gate'
    case 'ephemeral':
      return 'ephemeral'
    default:
      return 'view'
  }
}

/** A gate node's value-free status line, or `null` before a verdict exists. */
function gateStatusText(outcome: PipelineRunOutcome | undefined): string | null {
  const gate = outcome?.gate
  if (gate === undefined) return null
  switch (gate.class) {
    case 'validate':
      return gate.valid
        ? 'Validate: passed'
        : `Validate: failed — ${String(gate.violatedRules)} rule${
            gate.violatedRules === 1 ? '' : 's'
          } violated`
    case 'diff':
      return `Diff: ${String(gate.added)} added, ${String(gate.removed)} removed, ${String(
        gate.changed,
      )} changed`
    case 'publish':
      return gate.blockedGates.length === 0
        ? 'Publish: gate passed'
        : `Publish: blocked by ${gate.blockedGates
            .map((gateId) => sanitizePipelineText(gateId))
            .join(', ')}`
  }
}

function statusText(status: NodeRunStatus, outcome: PipelineRunOutcome | undefined): string {
  switch (status) {
    case 'pending':
      return 'Pending'
    case 'running':
      return 'Running…'
    case 'failed':
      return 'Failed'
    case 'gated':
      return 'Stopped at gate'
    case 'done':
      return outcome !== undefined && outcome.materialization !== 'gate'
        ? `Done · ${String(outcome.rowCount)} row${outcome.rowCount === 1 ? '' : 's'}`
        : 'Done'
  }
}

export function PipelinePanel({
  fileState,
  bindings,
  contractBindings,
  runState,
  preview,
  onOpenPipelineFile,
  onBindSource,
  onBindContract,
  onRun,
  onCancel,
  onOpenPreview,
  onClosePreview,
}: PipelinePanelProps) {
  /**
   * The inspect view (pure derivation over the loaded pipeline + plan).
   * `fileState` is a fresh object per load, so the memo recomputes exactly
   * once per pipeline open and never during run-state transitions.
   */
  const view = useMemo(
    () =>
      fileState.kind === 'loaded'
        ? buildNodeViews(fileState.pipeline, fileState.order, fileState.plan)
        : null,
    [fileState],
  )
  const order = useMemo(() => (view !== null ? view.map((node) => node.nodeId) : []), [view])
  const statuses = useMemo(
    () => (view !== null ? nodeStatusesForRun(runState, order) : null),
    [runState, order, view],
  )
  const viewable = useMemo(() => viewableRelationsForRun(runState), [runState])
  const lineage = useMemo(
    () => (fileState.kind === 'loaded' ? buildLineage(fileState.pipeline, fileState.order) : null),
    [fileState],
  )
  const outputs = useMemo(
    () => (view !== null ? view.filter((node) => node.isOutput) : null),
    [view],
  )
  const unboundSourceCount = useMemo(
    () =>
      view !== null
        ? view.filter((node) => node.kind === 'source' && bindings[node.nodeId]?.kind !== 'bound')
            .length
        : 0,
    [view, bindings],
  )
  const unboundContractCount = useMemo(
    () =>
      view !== null
        ? view.filter(
            (node) => node.kind === 'validate' && contractBindings[node.nodeId]?.kind !== 'bound',
          ).length
        : 0,
    [view, contractBindings],
  )

  const running = runState.kind === 'running'

  /**
   * ONE polite live region for run transitions (the q-3 house pattern:
   * kept per-panel here because the pipeline section can be collapsed
   * independently — collapsing hides the list but the section body stays
   * mounted, so the region still announces). Coarse transitions only;
   * per-node statuses are visible text in the list.
   */
  const [announcement, setAnnouncement] = useState<{ seq: number; text: string } | null>(null)
  const announceSeqRef = useRef(0)
  const lastRunKindRef = useRef<string>(runState.kind)
  useEffect(() => {
    if (runState.kind === lastRunKindRef.current) return
    lastRunKindRef.current = runState.kind
    if (view === null) return
    announceSeqRef.current += 1
    const seq = announceSeqRef.current
    switch (runState.kind) {
      case 'running':
        setAnnouncement({
          seq,
          text: `Pipeline run started: ${String(view.length)} nodes.`,
        })
        break
      case 'completed':
        setAnnouncement({
          seq,
          text: `Pipeline run completed: ${String(view.length)} nodes materialized.`,
        })
        break
      case 'gated':
        setAnnouncement({
          seq,
          text: `Pipeline run stopped at gate ${sanitizePipelineText(runState.gatedAt)} (${
            runState.gate === 'publish-blocked' ? 'publish blocked' : 'validation failed'
          }).`,
        })
        break
      case 'canceled':
        setAnnouncement({
          seq,
          text:
            runState.nextNodeId === null
              ? 'Pipeline run cancelled after the final node boundary.'
              : `Pipeline run cancelled before node ${sanitizePipelineText(runState.nextNodeId)}.`,
        })
        break
      case 'failed':
        setAnnouncement({
          seq,
          text:
            runState.nodeId === null
              ? 'Pipeline run failed.'
              : `Pipeline run failed at node ${sanitizePipelineText(runState.nodeId)}.`,
        })
        break
      case 'refused':
        setAnnouncement({ seq, text: 'Pipeline run refused before execution.' })
        break
      default:
        setAnnouncement(null)
    }
  }, [runState, view])

  const fileStatus =
    fileState.kind === 'none'
      ? 'No pipeline open'
      : fileState.kind === 'opening'
        ? 'Opening pipeline…'
        : fileState.kind === 'read-failed'
          ? 'The pipeline file could not be read'
          : fileState.kind === 'parse-error'
            ? 'The pipeline could not be parsed'
            : fileState.kind === 'invalid'
              ? 'The pipeline is not runnable'
              : 'Pipeline ready'

  const runStatus = (() => {
    switch (runState.kind) {
      case 'idle':
        return 'Not run yet.'
      case 'refused':
        return 'Refused — nothing was executed.'
      case 'running':
        return runState.cancelRequested
          ? 'Cancelling — takes effect at the next node boundary…'
          : 'Running…'
      case 'completed':
        return `Completed — ${String(view?.length ?? 0)} of ${String(view?.length ?? 0)} nodes materialized.`
      case 'gated':
        return `Stopped at gate ${sanitizePipelineText(runState.gatedAt)} — nothing downstream was executed.`
      case 'canceled':
        return 'Cancelled.'
      case 'failed':
        return 'Failed.'
    }
  })()

  return (
    <section className="pipeline" data-testid="pipeline-panel" aria-label="Pipeline">
      {/*
       * ux-3 heading map: this section's h2 lives here (visually hidden, the
       * SQL/Profile pattern) so the shell's complete heading map includes the
       * Pipeline section. Placement is PROVISIONAL (p-5): last in the v1
       * stack pending slice-2 tool-pane membership (ADR 0044 / q-15).
       */}
      <h2 className="visually-hidden">Pipeline</h2>

      <div className="pipeline-open-row">
        <button
          type="button"
          className="pipeline-open"
          data-testid="pipeline-open"
          disabled={fileState.kind === 'opening'}
          onClick={onOpenPipelineFile}
        >
          Open a pipeline file…
        </button>
        <span
          className="pipeline-file-status"
          data-testid="pipeline-file-status"
          data-state={fileState.kind}
        >
          {fileStatus}
        </span>
      </div>

      {fileState.kind === 'none' && (
        <p className="pipeline-zero-state" data-testid="pipeline-zero-state">
          No pipeline open. Open a pipeline YAML (.yaml/.yml) to inspect its nodes, bind its source
          datasets, and run it on the local engine.
        </p>
      )}
      {fileState.kind === 'opening' && (
        <p className="pipeline-opening" data-testid="pipeline-opening">
          Opening the picked pipeline file…
        </p>
      )}
      {fileState.kind === 'read-failed' && (
        <p className="pipeline-read-error" role="alert" data-testid="pipeline-read-error">
          The picked pipeline file could not be read as text. Nothing was parsed or executed.
        </p>
      )}
      {fileState.kind === 'parse-error' && (
        <div className="pipeline-parse-errors" role="alert" data-testid="pipeline-parse-errors">
          <p>The pipeline document could not be parsed — nothing was executed.</p>
          <ul>
            {errorList(fileState.errors).map((line, index) => (
              <li key={index} data-testid="pipeline-parse-error">
                {line}
              </li>
            ))}
          </ul>
        </div>
      )}
      {fileState.kind === 'invalid' && (
        <div className="pipeline-invalid" role="alert" data-testid="pipeline-invalid">
          <p>
            The pipeline is not runnable — DAG validation or compilation refused it. Nothing was
            executed.
          </p>
          <ul>
            {errorList(fileState.errors).map((line, index) => (
              <li key={index} data-testid="pipeline-invalid-error">
                {line}
              </li>
            ))}
          </ul>
        </div>
      )}

      {fileState.kind === 'loaded' && view !== null && statuses !== null && outputs !== null && (
        <>
          <p className="pipeline-summary" data-testid="pipeline-summary">
            Pipeline{' '}
            <code data-testid="pipeline-name">
              {sanitizePipelineText(fileState.pipeline.pipeline)}
            </code>{' '}
            · {String(view.length)} nodes in execution order · {String(outputs.length)} output
            {outputs.length === 1 ? '' : 's'}
            {unboundSourceCount > 0 && (
              <>
                {' '}
                · {String(unboundSourceCount)} source{unboundSourceCount === 1 ? '' : 's'} awaiting
                a dataset
              </>
            )}
            {unboundContractCount > 0 && (
              <>
                {' '}
                · {String(unboundContractCount)} validate node
                {unboundContractCount === 1 ? '' : 's'} awaiting a contract
              </>
            )}
          </p>
          {/*
           * The inspect list: topological (execution) order — dependencies
           * first. `list-style: none` is visual only; the <ol> keeps the
           * semantic order for assistive tech.
           */}
          <ol
            className="pipeline-nodes"
            data-testid="pipeline-nodes"
            aria-label="Pipeline nodes in execution order"
          >
            {view.map((node: PipelineNodeView) => {
              const status = statuses[node.nodeId] ?? 'pending'
              const outcome = viewable[node.nodeId]
              const binding = bindings[node.nodeId]
              const contractBinding = contractBindings[node.nodeId]
              const gateText = gateStatusText(outcome)
              return (
                <li
                  key={node.nodeId}
                  className="pipeline-node"
                  data-testid="pipeline-node"
                  data-node-id={node.nodeId}
                  data-node-kind={node.kind}
                  data-node-status={status}
                >
                  <code className="pipeline-node-id" data-testid="pipeline-node-id">
                    {sanitizePipelineText(node.nodeId)}
                  </code>{' '}
                  <span data-testid="pipeline-node-kind">kind {node.kind}</span>{' '}
                  <span
                    className="pipeline-node-materialization"
                    data-testid="pipeline-node-materialization"
                    data-materialization={node.materialization}
                  >
                    {materializationLabel(node.materialization)}
                  </span>{' '}
                  <span data-testid="pipeline-node-relation">
                    relation <code>{sanitizePipelineText(node.relation)}</code>
                  </span>{' '}
                  <span data-testid="pipeline-node-status">{statusText(status, outcome)}</span>
                  {node.isOutput && (
                    <span className="pipeline-node-output" data-testid="pipeline-node-output">
                      output
                    </span>
                  )}
                  {outcome?.materialization === 'export' && outcome.exportPath !== undefined && (
                    <span className="pipeline-node-export" data-testid="pipeline-node-export">
                      exported artifact <code>{sanitizePipelineText(outcome.exportPath)}</code>
                    </span>
                  )}
                  {gateText !== null && (
                    <span
                      className="pipeline-node-gate"
                      data-testid="pipeline-node-gate"
                      data-gate-class={outcome?.gate?.class}
                    >
                      {gateText}
                    </span>
                  )}
                  {node.kind === 'source' && (
                    <span className="pipeline-source-binding">
                      {binding?.kind === 'bound' ? (
                        <span data-testid="pipeline-source-bound" data-node-id={node.nodeId}>
                          Dataset bound.
                        </span>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="pipeline-bind"
                            data-testid="pipeline-bind"
                            data-node-id={node.nodeId}
                            onClick={() => {
                              onBindSource(node.nodeId)
                            }}
                          >
                            Choose dataset…
                          </button>{' '}
                          {binding?.kind === 'bind-failed' ? (
                            <span
                              role="alert"
                              data-testid="pipeline-source-bind-error"
                              data-node-id={node.nodeId}
                            >
                              The picked dataset could not be read — nothing was bound. Nothing has
                              been executed; choose the dataset again.
                            </span>
                          ) : (
                            <span data-testid="pipeline-source-pending" data-node-id={node.nodeId}>
                              No dataset bound yet — pick the dataset this source reads. The
                              pipeline’s authored source path is not used in the browser; nothing is
                              guessed.
                            </span>
                          )}
                        </>
                      )}
                    </span>
                  )}
                  {node.kind === 'validate' && (
                    <span className="pipeline-contract-binding">
                      {contractBinding?.kind === 'bound' && (
                        <span data-testid="pipeline-contract-bound" data-node-id={node.nodeId}>
                          Contract bound.{' '}
                        </span>
                      )}
                      <button
                        type="button"
                        className="pipeline-bind"
                        data-testid="pipeline-bind-contract"
                        data-node-id={node.nodeId}
                        onClick={() => {
                          onBindContract(node.nodeId)
                        }}
                      >
                        {contractBinding?.kind === 'bound'
                          ? 'Replace contract…'
                          : 'Choose contract…'}
                      </button>{' '}
                      {contractBinding?.kind === 'parse-error' ? (
                        <span
                          role="alert"
                          data-testid="pipeline-contract-parse-error"
                          data-node-id={node.nodeId}
                        >
                          The picked contract could not be parsed — nothing was bound. Nothing has
                          been executed; choose the contract again.
                        </span>
                      ) : contractBinding?.kind === 'read-failed' ? (
                        <span
                          role="alert"
                          data-testid="pipeline-contract-read-error"
                          data-node-id={node.nodeId}
                        >
                          The picked contract could not be read — nothing was bound. Nothing has
                          been executed; choose the contract again.
                        </span>
                      ) : contractBinding?.kind === 'pending' ? (
                        <span data-testid="pipeline-contract-pending" data-node-id={node.nodeId}>
                          No contract bound yet — pick the contract this validate node checks. The
                          pipeline’s authored contract path is not used in the browser; nothing is
                          guessed.
                        </span>
                      ) : null}
                    </span>
                  )}
                  {isPreviewable(outcome) && (
                    <span className="pipeline-preview-open-row">
                      <button
                        type="button"
                        className="pipeline-preview-open"
                        data-testid="pipeline-preview-open"
                        data-node-id={node.nodeId}
                        aria-expanded={preview.kind !== 'closed' && preview.nodeId === node.nodeId}
                        onClick={() => {
                          onOpenPreview(node.nodeId)
                        }}
                      >
                        Preview output
                      </button>
                    </span>
                  )}
                  {preview.kind !== 'closed' && preview.nodeId === node.nodeId && (
                    <PreviewBody preview={preview} onClose={onClosePreview} />
                  )}
                </li>
              )
            })}
          </ol>

          <div className="pipeline-run-controls">
            <button
              type="button"
              className="pipeline-run"
              data-testid="pipeline-run"
              disabled={running}
              onClick={onRun}
            >
              Run pipeline
            </button>
            <button
              type="button"
              className="pipeline-cancel"
              data-testid="pipeline-cancel"
              disabled={!running || (runState.kind === 'running' && runState.cancelRequested)}
              onClick={onCancel}
            >
              Cancel run
            </button>
            <span
              className="pipeline-run-status"
              data-testid="pipeline-run-status"
              data-state={runState.kind}
            >
              {runStatus}
            </span>
          </div>

          {runState.kind === 'refused' && (
            <p className="pipeline-run-refused" role="alert" data-testid="pipeline-run-refused">
              {runState.runnerMessage !== null ? (
                <>
                  The run was refused before execution —{' '}
                  {sanitizePipelineText(runState.runnerMessage)}. Nothing was executed.
                </>
              ) : (
                <>
                  Every source node needs a dataset and every validate node needs a contract before
                  the run.
                  {runState.missingSourceIds.length > 0 && (
                    <>
                      {' '}
                      Missing datasets:{' '}
                      {runState.missingSourceIds.map((nodeId, index) => (
                        <span key={nodeId}>
                          {index > 0 && ', '}
                          <code>{sanitizePipelineText(nodeId)}</code>
                        </span>
                      ))}
                      .
                    </>
                  )}
                  {runState.missingContractIds.length > 0 && (
                    <>
                      {' '}
                      Missing contracts:{' '}
                      {runState.missingContractIds.map((nodeId, index) => (
                        <span key={nodeId}>
                          {index > 0 && ', '}
                          <code>{sanitizePipelineText(nodeId)}</code>
                        </span>
                      ))}
                      .
                    </>
                  )}{' '}
                  Nothing was executed.
                </>
              )}
            </p>
          )}
          {runState.kind === 'gated' && (
            <div className="pipeline-run-gated" role="alert" data-testid="pipeline-run-gated">
              <p>
                The run stopped at gate <code>{sanitizePipelineText(runState.gatedAt)}</code> —{' '}
                {runState.gate === 'publish-blocked'
                  ? 'a publish gate is blocked.'
                  : 'a validation gate failed.'}{' '}
                {runState.nextNodeId === null ? (
                  'Every later node is gated.'
                ) : (
                  <>
                    The next node <code>{sanitizePipelineText(runState.nextNodeId)}</code> was not
                    executed.
                  </>
                )}
              </p>
              <p data-testid="pipeline-run-gated-completed">
                Completed before the stop:{' '}
                {runState.outcomes.length === 0
                  ? 'none'
                  : runState.outcomes.map((outcome, index) => (
                      <span key={outcome.nodeId}>
                        {index > 0 && ', '}
                        <code>{sanitizePipelineText(outcome.nodeId)}</code>
                      </span>
                    ))}
                . Re-run after fixing the gate — relations are recreated, never appended.
              </p>
              {(() => {
                const stop = runState.outcomes.find(
                  (outcome) => outcome.nodeId === runState.gatedAt,
                )
                const blocked = stop?.gate?.class === 'publish' ? stop.gate.blockedGates : []
                const failedValidate =
                  runState.gate === 'validation-failed'
                    ? runState.outcomes.find(
                        (outcome) => outcome.gate?.class === 'validate' && !outcome.gate.valid,
                      )
                    : undefined
                if (blocked.length === 0 && failedValidate === undefined) return null
                return (
                  <p data-testid="pipeline-run-gated-detail">
                    {blocked.length > 0 && (
                      <>
                        Blocked gates:{' '}
                        {blocked.map((gateId, index) => (
                          <span key={gateId}>
                            {index > 0 && ', '}
                            <code>{sanitizePipelineText(gateId)}</code>
                          </span>
                        ))}
                        .{' '}
                      </>
                    )}
                    {failedValidate?.gate?.class === 'validate' && (
                      <>
                        The contract failed {String(failedValidate.gate.violatedRules)} rule
                        {failedValidate.gate.violatedRules === 1 ? '' : 's'} (rule values are never
                        surfaced). Bind a passing contract and re-run.
                      </>
                    )}
                  </p>
                )
              })()}
            </div>
          )}
          {runState.kind === 'canceled' && (
            <p className="pipeline-run-cancelled" data-testid="pipeline-run-cancelled">
              Run cancelled
              {runState.nextNodeId === null ? (
                ' after the final node boundary — every node had already materialized.'
              ) : (
                <>
                  {' '}
                  before node <code>{sanitizePipelineText(runState.nextNodeId)}</code> was executed.
                </>
              )}{' '}
              Materialized so far:{' '}
              {runState.partial.length === 0
                ? 'none'
                : runState.partial.map((entry, index) => (
                    <span key={entry.nodeId}>
                      {index > 0 && ', '}
                      <code>{sanitizePipelineText(entry.relation)}</code>
                    </span>
                  ))}
              . Cancellation takes effect at node boundaries — the engine has no query interrupt, so
              the node running at cancel time finished before the run stopped.
            </p>
          )}
          {runState.kind === 'failed' && (
            <p className="pipeline-run-failed" role="alert" data-testid="pipeline-run-failed">
              {runState.nodeId === null ? (
                <>
                  The run failed before any node executed. {sanitizePipelineText(runState.message)}
                </>
              ) : (
                <>
                  The run failed at node <code>{sanitizePipelineText(runState.nodeId)}</code> —{' '}
                  {sanitizePipelineText(runState.message)}. Nodes materialized before the failure
                  remain as named relations:{' '}
                  {runState.partial.length === 0
                    ? 'none'
                    : runState.partial.map((entry, index) => (
                        <span key={entry.nodeId}>
                          {index > 0 && ', '}
                          <code>{sanitizePipelineText(entry.relation)}</code>
                        </span>
                      ))}{' '}
                  (row counts for the partial state are not reported). Nothing after the failing
                  node was executed.
                </>
              )}
            </p>
          )}
          {runState.kind === 'completed' && (
            <p className="pipeline-completed-note" data-testid="pipeline-completed-note">
              Output relations live in this app session — closing the tab discards them. “Preview
              output” opens a relation in the grid; a re-run replaces every relation (never
              appends).
            </p>
          )}

          {lineage !== null && (
            <section className="pipeline-lineage" aria-label="Pipeline lineage">
              <h3>Lineage</h3>
              <h4>Datasets</h4>
              {lineage.datasets.length === 0 ? (
                <p className="pipeline-lineage-empty" data-testid="pipeline-lineage-empty">
                  No source datasets in this pipeline.
                </p>
              ) : (
                <ol className="pipeline-lineage-list" data-testid="pipeline-lineage-datasets">
                  {lineage.datasets.map((dataset) => (
                    <li key={dataset.sourceId} data-testid="pipeline-lineage-dataset">
                      <code>{sanitizePipelineText(dataset.sourceId)}</code> →{' '}
                      {dataset.consumers.length === 0
                        ? 'no downstream nodes'
                        : dataset.consumers.map((nodeId, index) => (
                            <span key={nodeId}>
                              {index > 0 && ', '}
                              <code>{sanitizePipelineText(nodeId)}</code>
                            </span>
                          ))}
                    </li>
                  ))}
                </ol>
              )}
              <h4>Nodes</h4>
              <ol className="pipeline-lineage-list" data-testid="pipeline-lineage-nodes">
                {lineage.nodes.map((node) => (
                  <li key={node.nodeId} data-testid="pipeline-lineage-node">
                    <code>{sanitizePipelineText(node.nodeId)}</code>
                    {node.inputs.length > 0 && (
                      <>
                        {' '}
                        ←{' '}
                        {node.inputs.map((input, index) => (
                          <span key={input}>
                            {index > 0 && ', '}
                            <code>{sanitizePipelineText(input)}</code>
                          </span>
                        ))}
                      </>
                    )}
                    {node.requires.length > 0 && (
                      <>
                        {' '}
                        (requires{' '}
                        {node.requires.map((gate, index) => (
                          <span key={gate}>
                            {index > 0 && ', '}
                            <code>{sanitizePipelineText(gate)}</code>
                          </span>
                        ))}
                        )
                      </>
                    )}
                    {node.consumers.length > 0 && (
                      <>
                        {' '}
                        →{' '}
                        {node.consumers.map((consumer, index) => (
                          <span key={consumer}>
                            {index > 0 && ', '}
                            <code>{sanitizePipelineText(consumer)}</code>
                          </span>
                        ))}
                      </>
                    )}
                  </li>
                ))}
              </ol>
            </section>
          )}

          <span
            className="visually-hidden"
            aria-live="polite"
            aria-atomic="true"
            data-testid="pipeline-live-region"
          >
            {announcement === null ? null : <span key={announcement.seq}>{announcement.text}</span>}
          </span>
        </>
      )}
    </section>
  )
}

/**
 * One node's grid-native preview (arch §15): the existing `DataGrid` over the
 * handle-backed model, plus the output schema, the schema delta against the
 * single input, and the generated query. All pipeline-derived text is
 * sanitized; the grid is read-only (no overlay state).
 */
function PreviewBody({
  preview,
  onClose,
}: {
  readonly preview: Exclude<PipelinePreviewState, { readonly kind: 'closed' }>
  readonly onClose: () => void
}) {
  return (
    <section
      className="pipeline-preview"
      data-testid="pipeline-preview"
      data-node-id={preview.nodeId}
      aria-label={`Preview of node ${sanitizePipelineText(preview.nodeId)}`}
    >
      <div className="pipeline-preview-head">
        <h3>Preview</h3>
        <button
          type="button"
          className="pipeline-preview-close"
          data-testid="pipeline-preview-close"
          onClick={onClose}
        >
          Close preview
        </button>
      </div>
      {preview.kind === 'loading' && (
        <p className="pipeline-preview-loading" data-testid="pipeline-preview-loading">
          Opening the relation for preview…
        </p>
      )}
      {preview.kind === 'failed' && (
        <p className="pipeline-preview-error" role="alert" data-testid="pipeline-preview-error">
          {sanitizePipelineText(preview.message)}. Nothing was changed.
        </p>
      )}
      {preview.kind === 'ready' && (
        <>
          <p className="pipeline-preview-meta" data-testid="pipeline-preview-meta">
            Relation <code>{sanitizePipelineText(preview.relation)}</code> ·{' '}
            {String(preview.rowCount)} row{preview.rowCount === 1 ? '' : 's'} ·{' '}
            {materializationLabel(preview.materialization)} · opened grid-native through the session
            handle. Relations live in this app session; closing the tab discards them.
          </p>
          <div className="pipeline-preview-schema">
            <h4>Output schema</h4>
            <ol className="pipeline-preview-columns" data-testid="pipeline-preview-columns">
              {preview.columns.map((column) => (
                <li key={column.name} data-testid="pipeline-preview-column">
                  <code>{sanitizePipelineText(column.name)}</code>{' '}
                  <span className="pipeline-preview-type">{sanitizePipelineText(column.type)}</span>
                </li>
              ))}
            </ol>
          </div>
          {preview.inputColumns !== null &&
            (() => {
              const delta = schemaDelta(preview.inputColumns, preview.columns)
              return (
                <div className="pipeline-preview-delta">
                  <h4>Schema delta vs input</h4>
                  {isSchemaDeltaEmpty(delta) ? (
                    <p data-testid="pipeline-preview-delta-empty">
                      No schema change from the input.
                    </p>
                  ) : (
                    <ul data-testid="pipeline-preview-delta">
                      {delta.added.map((column) => (
                        <li key={`add:${column.name}`} data-testid="pipeline-preview-added">
                          added <code>{sanitizePipelineText(column.name)}</code>{' '}
                          <span className="pipeline-preview-type">
                            {sanitizePipelineText(column.type)}
                          </span>
                        </li>
                      ))}
                      {delta.removed.map((column) => (
                        <li key={`remove:${column.name}`} data-testid="pipeline-preview-removed">
                          removed <code>{sanitizePipelineText(column.name)}</code>
                        </li>
                      ))}
                      {delta.changed.map((change) => (
                        <li key={`change:${change.name}`} data-testid="pipeline-preview-changed">
                          <code>{sanitizePipelineText(change.name)}</code>{' '}
                          <span className="pipeline-preview-type">
                            {sanitizePipelineText(change.from)}
                          </span>{' '}
                          →{' '}
                          <span className="pipeline-preview-type">
                            {sanitizePipelineText(change.to)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )
            })()}
          {preview.sql !== null && (
            <div className="pipeline-preview-sql">
              <h4>Generated SQL</h4>
              <pre data-testid="pipeline-preview-sql">
                <code>{sanitizePipelineText(preview.sql)}</code>
              </pre>
            </div>
          )}
          <div className="pipeline-preview-grid" data-testid="pipeline-preview-grid">
            <DataGrid model={preview.model} onNestedAction={() => {}} />
          </div>
        </>
      )}
    </section>
  )
}
