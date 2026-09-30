// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pipeline session (p-5) — the pipeline panel's state machine, extracted
 * from `App` per the f-1 session-hook pattern (siblings:
 * `useValidationSession`, `useDiffSession`).
 *
 * Responsibilities:
 *
 * - **Open** a pipeline file through the real picker path (`pickDataFile`),
 *   then `parsePipeline` → `validatePipeline` → `compilePipeline`. Every
 *   failure class is a first-class honest state (parse errors with
 *   line/column, DAG/compile refusals, unreadable file); nothing throws.
 * - **Sources (C2):** each `source` node gets its dataset from an explicit
 *   per-node pick through the same real picker. A source without a dataset
 *   is an honest `pending` state, not an error; a Run with unbound sources
 *   is refused up front with ALL missing nodes disclosed and nothing
 *   executed (the CLI's collect-all-disclose-refuse discipline, mirrored).
 * - **Run** via `client.runPipeline` with a fresh `PipelineRunGuard` per
 *   run, **serialized at the UI level** (p-3 carry-over: the runner has no
 *   re-entrancy guard by design — the panel's Run control is disabled while
 *   a run executes, and this hook double-checks). Live per-node status rides
 *   the `onNode` hook: at each boundary the named node is running and every
 *   earlier topological node is already materialized.
 * - **Cancel** invalidates the guard; the runner returns the typed
 *   `canceled` outcome at the next node boundary (ADR 0040: no query
 *   interrupt) — the panel discloses that cancellation is boundary-scoped.
 * - **Session reset:** a new dataset open drops the whole pipeline session
 *   (the f-1 reset registry) and invalidates any in-flight run; stale
 *   deliveries are dropped by run token (the house AR-W13/AR-W9 pattern).
 *
 * Privacy (ADR 0025): picked file names are transported to the engine for
 * format detection only and never rendered; no telemetry is emitted from
 * this hook (`pipeline_run` is reserved — design §3.11).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { compilePipeline, parsePipeline, validatePipeline } from '@assay/pipeline'
import { PipelineRunError, PipelineRunGuard, PipelineRunRefusalError } from '@assay/engine-duckdb'
import { pickDataFile } from '@assay/data-sources/browser'
import type { DatasetSession } from '../sessions/session-reset'
import { engineClient } from '../lib/engine'
import type {
  PipelineFileState,
  PipelinePartialNode,
  PipelineRunState,
  SourceBindingState,
} from './pipeline-state'

export interface PipelineSessionParams {
  readonly session: DatasetSession
}

export interface PipelineSession {
  readonly fileState: PipelineFileState
  readonly bindings: Readonly<Record<string, SourceBindingState>>
  readonly runState: PipelineRunState
  readonly openPipelineFile: () => void
  readonly bindSourceDataset: (nodeId: string) => void
  readonly run: () => void
  readonly cancelRun: () => void
}

/** Readable, fixed text for an unexpected (non-typed) run failure. */
function runFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function usePipelineSession(params: PipelineSessionParams): PipelineSession {
  const { session } = params

  const [fileState, setFileState] = useState<PipelineFileState>({ kind: 'none' })
  const [bindings, setBindings] = useState<Readonly<Record<string, SourceBindingState>>>({})
  const [runState, setRunState] = useState<PipelineRunState>({ kind: 'idle' })

  /**
   * Monotonic run token: each run captures its token and every delivery
   * (result, rejection, `onNode` transition) is dropped when a newer run,
   * a new pipeline file, or a new dataset session has superseded it. The
   * token is bumped by `run`, `openPipelineFile`, and the session reset —
   * the same generation-guard discipline as the validation/diff sessions.
   */
  const runTokenRef = useRef(0)
  /** The active run's guard; invalidated by Cancel and by any supersede. */
  const guardRef = useRef<PipelineRunGuard | null>(null)

  // Latest-closure refs (the SqlPanel `executeRef` pattern): callbacks stay
  // identity-stable across renders (f-2) while reading the current state at
  // invocation time.
  const fileStateRef = useRef(fileState)
  fileStateRef.current = fileState
  const bindingsRef = useRef(bindings)
  bindingsRef.current = bindings
  const runStateRef = useRef(runState)
  runStateRef.current = runState

  /**
   * f-1: a new dataset open drops the pipeline session. The token bump also
   * abandons any in-flight run's deliveries; the guard invalidation stops
   * the runner itself at the next node boundary (its materialized views
   * remain in the engine session — session-scoped state, disclosed in the
   * panel, never auto-cleaned: the client exposes no per-view release op).
   */
  useEffect(() => {
    const reset = (): void => {
      runTokenRef.current += 1
      guardRef.current?.invalidate()
      guardRef.current = null
      setFileState({ kind: 'none' })
      setBindings({})
      setRunState({ kind: 'idle' })
    }
    return session.registerReset(reset)
  }, [session])

  const openPipelineFile = useCallback((): void => {
    const sessionId = session.tokenRef.current
    void (async () => {
      setFileState({ kind: 'opening' })
      let picked: Awaited<ReturnType<typeof pickDataFile>> = null
      try {
        picked = await pickDataFile()
      } catch {
        // The picker itself failed (rare; the fallback path can reject).
        if (session.tokenRef.current !== sessionId) return
        setFileState({ kind: 'read-failed' })
        return
      }
      if (session.tokenRef.current !== sessionId) return
      if (picked === null) {
        // User dismissed the picker — restore the pre-open state (only when
        // this is still the active open gesture).
        setFileState((previous) => (previous.kind === 'opening' ? { kind: 'none' } : previous))
        return
      }
      let file: File
      try {
        file = await picked.source.getFile()
      } catch {
        if (session.tokenRef.current !== sessionId) return
        setFileState({ kind: 'read-failed' })
        return
      }
      if (session.tokenRef.current !== sessionId) return
      let text: string
      try {
        text = await file.text()
      } catch {
        if (session.tokenRef.current !== sessionId) return
        setFileState({ kind: 'read-failed' })
        return
      }
      if (session.tokenRef.current !== sessionId) return
      const parsed = parsePipeline(text)
      if (!parsed.ok) {
        setFileState({ kind: 'parse-error', errors: parsed.errors })
        return
      }
      const validation = validatePipeline(parsed.pipeline)
      if (!validation.ok) {
        setFileState({ kind: 'invalid', errors: validation.errors })
        return
      }
      const compiled = compilePipeline(parsed.pipeline)
      if (!compiled.ok) {
        setFileState({ kind: 'invalid', errors: compiled.errors })
        return
      }
      // A new pipeline supersedes any in-flight run of the previous one and
      // starts with clean bindings (bindings are per-pipeline picks).
      runTokenRef.current += 1
      guardRef.current?.invalidate()
      guardRef.current = null
      setBindings({})
      setRunState({ kind: 'idle' })
      setFileState({ kind: 'loaded', pipeline: parsed.pipeline, plan: compiled.plan })
    })()
  }, [session])

  const bindSourceDataset = useCallback(
    (nodeId: string): void => {
      const sessionId = session.tokenRef.current
      void (async () => {
        const picked = await pickDataFile()
        if (session.tokenRef.current !== sessionId) return
        if (picked === null) return // dismissed — the source stays honestly pending
        const file = await picked.source.getFile()
        if (session.tokenRef.current !== sessionId) return
        setBindings((previous) => ({
          ...previous,
          [nodeId]: {
            kind: 'bound',
            // Transported to the engine for format detection only; never
            // rendered (ADR 0025).
            fileName: file.name,
            getFile: () => Promise.resolve(file),
          },
        }))
      })()
    },
    [session],
  )

  const run = useCallback((): void => {
    const current = fileStateRef.current
    if (current.kind !== 'loaded') return
    // UI-level serialization (p-3 carry-over): no second run can start
    // while one is in flight. The disabled control is the primary guard;
    // this check is the belt-and-braces.
    if (runStateRef.current.kind === 'running') return
    const plan = current.plan

    // C2: collect ALL unbound source nodes (in node order), disclose them,
    // and refuse before any engine call. Never guess, never partially run.
    const missingSourceIds = plan.nodes
      .filter(
        (node) => node.kind === 'source' && bindingsRef.current[node.nodeId]?.kind !== 'bound',
      )
      .map((node) => node.nodeId)
    if (missingSourceIds.length > 0) {
      setRunState({ kind: 'refused', missingSourceIds })
      return
    }
    const sources = plan.nodes
      .filter((node) => node.kind === 'source')
      .map((node) => {
        const binding = bindingsRef.current[node.nodeId]
        // Narrowed by the missing check above; this assertion keeps the
        // types honest without re-deriving the filter.
        if (binding?.kind !== 'bound') {
          throw new Error('internal: a source node was bound but not recorded')
        }
        return { nodeId: node.nodeId, source: { name: binding.fileName, getFile: binding.getFile } }
      })

    const token = runTokenRef.current + 1
    runTokenRef.current = token
    const guard = new PipelineRunGuard()
    guardRef.current = guard
    const sessionId = session.tokenRef.current
    setRunState({
      kind: 'running',
      statuses: Object.fromEntries(plan.order.map((nodeId) => [nodeId, 'pending' as const])),
      cancelRequested: false,
    })
    void engineClient
      .runPipeline(plan, {
        sources,
        guard,
        onNode: (nodeId: string) => {
          // Live boundary updates: the named node is executing; every
          // earlier topological node is already materialized. Stale tokens
          // (a newer run / new pipeline / new dataset session) drop silently.
          setRunState((previous) => {
            if (previous.kind !== 'running' || runTokenRef.current !== token) return previous
            const index = plan.order.indexOf(nodeId)
            if (index < 0) return previous
            const statuses = { ...previous.statuses }
            for (let position = 0; position < index; position += 1) {
              const earlier = plan.order[position]
              if (statuses[earlier] === 'pending' || statuses[earlier] === 'running') {
                statuses[earlier] = 'done'
              }
            }
            statuses[nodeId] = 'running'
            return { ...previous, statuses }
          })
        },
      })
      .then((result) => {
        if (runTokenRef.current !== token || session.tokenRef.current !== sessionId) return
        guardRef.current = null
        if (result.status === 'completed') {
          setRunState({
            kind: 'completed',
            results: Object.fromEntries(
              result.nodes.map((entry) => [
                entry.nodeId,
                { relation: entry.relation, rowCount: entry.rowCount },
              ]),
            ),
          })
        } else {
          setRunState({
            kind: 'canceled',
            partial: result.nodes,
            nextNodeId: result.nextNodeId,
          })
        }
      })
      .catch((error: unknown) => {
        if (runTokenRef.current !== token || session.tokenRef.current !== sessionId) return
        guardRef.current = null
        if (error instanceof PipelineRunError) {
          const partial: readonly PipelinePartialNode[] = error.partial
          setRunState({ kind: 'failed', nodeId: error.nodeId, partial, message: error.message })
          return
        }
        if (error instanceof PipelineRunRefusalError) {
          // Unreachable for a compiler-produced plan with pre-bound sources
          // (the runner's own gates passed at compile time); reported as the
          // fixed value-free class, like the CLI's internal-error posture.
          setRunState({
            kind: 'failed',
            nodeId: error.nodeId,
            partial: [],
            message: error.message,
          })
          return
        }
        setRunState({
          kind: 'failed',
          nodeId: null,
          partial: [],
          message: runFailureMessage(error),
        })
      })
  }, [session])

  const cancelRun = useCallback((): void => {
    if (runStateRef.current.kind !== 'running') return
    setRunState((previous) =>
      previous.kind === 'running' && !previous.cancelRequested
        ? { ...previous, cancelRequested: true }
        : previous,
    )
    // Boundary-scoped abandonment (ADR 0040): the runner returns the typed
    // `canceled` outcome at the next node boundary; the late delivery is
    // rendered honestly when it arrives.
    guardRef.current?.invalidate()
  }, [])

  return {
    fileState,
    bindings,
    runState,
    openPipelineFile,
    bindSourceDataset,
    run,
    cancelRun,
  }
}
