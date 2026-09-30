// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useMemo, useRef, useState } from 'react'
import type { PipelineError } from '@assay/pipeline'
import {
  buildNodeViews,
  inspectRelationSql,
  nodeStatusesForRun,
  viewableRelationsForRun,
} from './pipeline-model'
import type { PipelineNodeView } from './pipeline-model'
import type { PipelineFileState, PipelineRunState, SourceBindingState } from './pipeline-state'
import { sanitizePipelineText } from './sanitize'

/**
 * The Pipeline workbench section body (p-5).
 *
 * A **list, not a graph**: the validated DAG renders as one accessible
 * ordered list (`<ol>`) in the plan's deterministic topological order —
 * per node: id, kind, relation, live status. There is deliberately NO
 * visual graph editor in P1 (queue row p-5; ADR 0032 keeps orchestration
 * and interactive DAG tooling out).
 *
 * States (all honest, value-free — ADR 0025):
 *
 * - **none** — the zero state; nothing loaded, nothing guessed.
 * - **opening** — the picker/read/parse chain is in flight.
 * - **read-failed / parse-error / invalid** — the total parser's and the
 *   DAG/compile gates' located errors, one sanitized line each (parse
 *   messages embed raw YAML excerpts; `sanitizePipelineText` makes control
 *   characters visible and React text nodes escape the rest).
 * - **loaded** — the inspect list plus the run controls. Source nodes show
 *   an explicit per-node dataset pick (C2: never guessed — pending is
 *   pending, not an error). Terminal relations are flagged as outputs and,
 *   once materialized by a run, offer "View output", which selects the
 *   relation into the EXISTING SQL result surface (the same `runRequest`
 *   seam the schema-tree/grid nested actions use) — the smallest honest
 *   reuse; a virtualized-grid open of a session view would need a new
 *   engine pathway (documented carry-over, not invented here).
 *
 * Run semantics: serialized at the UI level (Run disabled while in flight);
 * live per-node status via the runner's `onNode`; Cancel is boundary-scoped
 * (disclosed); failures name the failing node and the named partial state,
 * value-free. Output relations live in the app session (closing the tab
 * discards them) — disclosed like the CLI's process-lifetime note.
 *
 * Privacy: picked file names are never rendered; no telemetry is emitted
 * from this panel (`pipeline_run` is reserved).
 */

export interface PipelinePanelProps {
  readonly fileState: PipelineFileState
  readonly bindings: Readonly<Record<string, SourceBindingState>>
  readonly runState: PipelineRunState
  readonly onOpenPipelineFile: () => void
  readonly onBindSource: (nodeId: string) => void
  readonly onRun: () => void
  readonly onCancel: () => void
  /** Select a materialized relation into the existing SQL result surface. */
  readonly onInspectOutput: (sql: string) => void
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

export function PipelinePanel({
  fileState,
  bindings,
  runState,
  onOpenPipelineFile,
  onBindSource,
  onRun,
  onCancel,
  onInspectOutput,
}: PipelinePanelProps) {
  /**
   * The inspect view (pure derivation over the loaded pipeline + plan).
   * `fileState` is a fresh object per load, so the memo recomputes exactly
   * once per pipeline open and never during run-state transitions.
   */
  const view = useMemo(
    () => (fileState.kind === 'loaded' ? buildNodeViews(fileState.pipeline, fileState.plan) : null),
    [fileState],
  )
  const order = useMemo(() => (view !== null ? view.map((node) => node.nodeId) : []), [view])
  const statuses = useMemo(
    () => (view !== null ? nodeStatusesForRun(runState, order) : null),
    [runState, order, view],
  )
  const viewable = useMemo(() => viewableRelationsForRun(runState), [runState])
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
        setAnnouncement({ seq, text: 'Pipeline run refused: a source node has no dataset.' })
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
              const binding = bindings[node.nodeId]
              const materialized = viewable[node.nodeId]
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
                  <span data-testid="pipeline-node-relation">
                    relation <code>{sanitizePipelineText(node.relation)}</code>
                  </span>{' '}
                  <span data-testid="pipeline-node-status">
                    {status === 'pending' && 'Pending'}
                    {status === 'running' && 'Running…'}
                    {status === 'failed' && 'Failed'}
                    {status === 'done' &&
                      (materialized?.rowCount !== undefined && materialized.rowCount !== null
                        ? `Done · ${String(materialized.rowCount)} row${
                            materialized.rowCount === 1 ? '' : 's'
                          }`
                        : 'Done')}
                  </span>
                  {node.isOutput && (
                    <span className="pipeline-node-output" data-testid="pipeline-node-output">
                      output
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
                  {node.isOutput && materialized !== undefined && (
                    <span className="pipeline-view-output">
                      <button
                        type="button"
                        className="pipeline-view"
                        data-testid="pipeline-view"
                        data-node-id={node.nodeId}
                        onClick={() => {
                          onInspectOutput(inspectRelationSql(materialized.relation))
                        }}
                      >
                        View output
                      </button>{' '}
                      <span className="pipeline-view-hint">
                        opens this relation in the SQL pane’s result table
                      </span>
                    </span>
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
              Every source node needs a dataset before the run. Missing:{' '}
              {runState.missingSourceIds.map((nodeId, index) => (
                <span key={nodeId}>
                  {index > 0 && ', '}
                  <code>{sanitizePipelineText(nodeId)}</code>
                </span>
              ))}
              . Nothing was executed.
            </p>
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
              Output relations live in this app session — closing the tab discards them. “View
              output” shows a relation in the SQL pane’s result table; a re-run replaces every view
              (never appends).
            </p>
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
