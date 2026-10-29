// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pipeline session (p-5; p2-6 preview/gates/lineage) — the pipeline panel's
 * state machine, extracted from `App` per the f-1 session-hook pattern
 * (siblings: `useValidationSession`, `useDiffSession`).
 *
 * Responsibilities:
 *
 * - **Open** a pipeline file through the real picker path (`pickDataFile`),
 *   then `parsePipeline` → `validatePipeline` → `compilePipeline` over the
 *   DATA subgraph only. Gate nodes (`validate`/`diff`/`publish`) are bound by
 *   the p2-4 runner, not compiled by p2-3, so the panel keeps the full
 *   validated order and merges the two for inspection. Every failure class is
 *   a first-class honest state (parse errors with line/column, DAG/compile
 *   refusals, unreadable file); nothing throws.
 * - **Sources (C2):** each `source` node gets its dataset from an explicit
 *   per-node pick through the same real picker. A source without a dataset
 *   is an honest `pending` state, not an error.
 * - **Contracts (C2):** each `validate` node gets a parsed contract from an
 *   explicit per-node pick (the IR's authored `contract:` path is never
 *   resolved in the browser). A validate node without a contract is pending;
 *   a Run with unbound sources OR contracts is refused up front with ALL
 *   missing nodes disclosed and nothing executed (collect-all-disclose-refuse).
 * - **Run** via `client.runPipeline` with the full IR (so the p2-4 runner can
 *   bind and execute gate nodes), host-supplied pure gate compilers, a fresh
 *   `PipelineRunGuard`, **serialized at the UI level** (the runner has no
 *   re-entrancy guard by design). Live per-node status rides `onNode`. The
 *   runner's `completed`/`canceled`/`gated` outcomes are rendered honestly;
 *   `gated` is the run-stopped-at-gate state (never mistaken for cancel).
 * - **Preview (p2-6, arch §15):** a materialized node's relation opens
 *   grid-native through the p2-1 `registerPipelineRelation` op; the returned
 *   `EngineTableHandle` drives the existing grid model/schema surfaces (the
 *   same handle-based registry path a dataset open uses — no SQL-result
 *   detour). Lazy and on-demand; relations live for the engine session.
 * - **Cancel** invalidates the guard; the runner returns the typed `canceled`
 *   outcome at the next node boundary (ADR 0040: no query interrupt).
 * - **Session reset:** a new dataset open drops the whole pipeline session
 *   (the f-1 reset registry) and invalidates any in-flight run.
 *
 * Privacy (ADR 0025): picked file names are transported to the engine for
 * format detection only and never rendered; no telemetry is emitted from
 * this hook (`pipeline_run` is reserved — design §3.11).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { compilePipeline, isDataNode, parsePipeline, validatePipeline } from '@assay/pipeline'
import type { PipelineV1 } from '@assay/pipeline'
import { parseContract } from '@assay/contracts'
import type { ContractV1 } from '@assay/contracts'
import { compileContract } from '@assay/validation'
import { compileRowDiffPlan } from '@assay/diff'
import { GridViewportModel } from '@assay/grid'
import { PipelineRunError, PipelineRunGuard, PipelineRunRefusalError } from '@assay/engine-duckdb'
import type {
  EngineOverlay,
  PipelineRunCompilers,
  PipelineRunContractBinding,
  PipelineRunNodeResult,
  PipelineRunPartialNode,
} from '@assay/engine-duckdb'
import { pickDataFile } from '@assay/data-sources/browser'
import type { DatasetSession } from '../sessions/session-reset'
import type { SourceIdentity } from '../export/save-destination'
import { engineClient } from '../lib/engine'
import { DuckDbGridProvider } from '../grid/provider'
import { readContractFile } from '../validation/contract-import'
import { buildNodeViews, materializationBadgeFor } from './pipeline-model'
import {
  dcrExportFailureMessage,
  dcrExportSuccessMessage,
  dcrRefusalMessage,
  deriveDcrArtifact,
  requestDcrDestination,
  writeDcrCopy,
} from './dcr-export'
import type { DcrExportRun, DcrExportSpec } from './dcr-export'
import type {
  ContractBindingState,
  DcrExportState,
  NodeMaterialization,
  PipelineFileState,
  PipelinePreviewState,
  PipelineRunOutcome,
  PipelineRunState,
  SourceBindingState,
} from './pipeline-state'
import { advanceNodeStatuses } from './pipeline-state'

export interface PipelineSessionParams {
  readonly session: DatasetSession
  /**
   * The opened source's retained FSA identity (App-owned; the m4-5 rule).
   * Present only for FSA-opened sessions — it is what lets a picked save
   * destination be proven-not-the-source before any byte write. Absent
   * means the DCR export is download-only by construction.
   */
  readonly sourceIdentityRef: { current: SourceIdentity | null }
  /**
   * ug-9/R-15: the open dataset as App-held state — a retained reference to
   * the opened `File`, set on every successful open (picker, hidden-input
   * fallback and the bundled example alike). Present exactly while a dataset
   * session is open; a plain `File` has no FSA handle, which is why this is
   * NOT the same-source `sourceIdentityRef`. Never rendered or logged
   * (ADR 0025).
   */
  readonly openSourceRef: { readonly current: { getFile: () => Promise<File> } | null }
  /**
   * ug-9/R-15: the validation session's loaded (already parsed) contract, or
   * `null` while Validation holds no parsed contract. Offered to `validate`
   * nodes as the no-picker "Use the loaded contract" binding.
   */
  readonly loadedContract: ContractV1 | null
}

export interface PipelineSession {
  readonly fileState: PipelineFileState
  readonly bindings: Readonly<Record<string, SourceBindingState>>
  readonly contractBindings: Readonly<Record<string, ContractBindingState>>
  readonly runState: PipelineRunState
  readonly preview: PipelinePreviewState
  readonly dcrExport: DcrExportState
  readonly openPipelineFile: () => void
  readonly bindSourceDataset: (nodeId: string) => void
  readonly bindContract: (nodeId: string) => void
  /**
   * ug-9/R-15: bind a source node to the dataset the app already has open —
   * no OS picker. Honest `bind-failed` degradation is preserved.
   */
  readonly bindOpenDataset: (nodeId: string) => void
  /**
   * ug-9/R-15: bind a validate node to the contract Validation already holds
   * parsed — no picker, no re-parse.
   */
  readonly bindLoadedContract: (nodeId: string) => void
  readonly run: () => void
  readonly cancelRun: () => void
  readonly openPreview: (nodeId: string) => void
  readonly closePreview: () => void
  readonly exportDcr: (spec: DcrExportSpec) => void
}

/** Readable, fixed text for an unexpected (non-typed) run failure. */
function runFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The data subgraph of an IR (gate nodes are bound by the runner, not compiled). */
function dataSubgraph(pipeline: PipelineV1): PipelineV1 {
  return { ...pipeline, nodes: pipeline.nodes.filter((node) => isDataNode(node)) }
}

/** The engine-facing materialization badge for one loaded node (defensive default). */
function badgeFor(fileState: PipelineFileState, nodeId: string): NodeMaterialization {
  if (fileState.kind !== 'loaded') return 'view'
  return materializationBadgeFor(fileState.plan.nodes.find((entry) => entry.nodeId === nodeId))
}

/** Map a runner node result to the panel's value-free outcome shape. */
function toOutcome(result: PipelineRunNodeResult): PipelineRunOutcome {
  return {
    nodeId: result.nodeId,
    relation: result.relation,
    rowCount: result.rowCount,
    materialization: result.materialization,
    ...(result.exportPath === undefined ? {} : { exportPath: result.exportPath }),
    ...(result.gate === undefined ? {} : { gate: result.gate }),
  }
}

/**
 * Map a runner failure's named partial. Counts are unknown (the runner
 * reports none for partial state) and the materialization badge is derived
 * from the plan; an executed gate's value-free verdict is passed through
 * exactly as `toOutcome` does on the success path (p2c-4).
 */
function partialOutcomes(
  partial: readonly PipelineRunPartialNode[],
  fileState: PipelineFileState,
): readonly PipelineRunOutcome[] {
  return partial.map((entry) => ({
    nodeId: entry.nodeId,
    relation: entry.relation,
    rowCount: 0,
    materialization: badgeFor(fileState, entry.nodeId),
    ...(entry.gate === undefined ? {} : { gate: entry.gate }),
  }))
}

/** The host-supplied pure gate compilers (the p2-4 harness shape). */
function buildCompilers(): PipelineRunCompilers {
  return {
    validate: (input) => {
      const compiled = compileContract(
        input.contract as Parameters<typeof compileContract>[0],
        [...input.columns],
        { relation: input.relation },
      )
      return compiled.ok ? { ok: true, plan: compiled.plan } : { ok: false }
    },
    diff: (input) => {
      const compiled = compileRowDiffPlan([...input.schemaA], [...input.schemaB], [...input.keys], {
        relationA: input.relationA,
        relationB: input.relationB,
      })
      return compiled.ok ? { ok: true, plan: compiled.plan } : { ok: false }
    },
  }
}

/**
 * Build the grid-native preview model over an already-registered handle. The
 * provider's overlay source is never used for a pipeline relation (no edits,
 * no query state), but the natural read path reads the base anchor, so a
 * minimal, honest base is supplied.
 */
function buildPreviewModel(handle: Parameters<typeof engineClient.schema>[0]): GridViewportModel {
  const overlay = (): EngineOverlay => ({
    base: {
      baseAnchor: 'pipeline-preview',
      overlayAnchor: 'pipeline-preview',
      columns: [],
      baseRowCount: 0,
    },
    ops: [],
  })
  return new GridViewportModel(new DuckDbGridProvider(engineClient, handle, overlay))
}

export function usePipelineSession(params: PipelineSessionParams): PipelineSession {
  const { session, sourceIdentityRef, openSourceRef, loadedContract } = params

  const [fileState, setFileState] = useState<PipelineFileState>({ kind: 'none' })
  const [bindings, setBindings] = useState<Readonly<Record<string, SourceBindingState>>>({})
  const [contractBindings, setContractBindings] = useState<
    Readonly<Record<string, ContractBindingState>>
  >({})
  const [runState, setRunState] = useState<PipelineRunState>({ kind: 'idle' })
  const [preview, setPreview] = useState<PipelinePreviewState>({ kind: 'closed' })
  const [dcrExport, setDcrExport] = useState<DcrExportState>({ kind: 'idle' })

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
  /** Preview generation guard (a run or new pipeline closes a stale preview). */
  const previewTokenRef = useRef(0)

  // Latest-closure refs (the SqlPanel `executeRef` pattern): callbacks stay
  // identity-stable across renders (f-2) while reading the current state at
  // invocation time.
  const fileStateRef = useRef(fileState)
  fileStateRef.current = fileState
  const bindingsRef = useRef(bindings)
  bindingsRef.current = bindings
  const contractBindingsRef = useRef(contractBindings)
  contractBindingsRef.current = contractBindings
  const runStateRef = useRef(runState)
  runStateRef.current = runState
  const dcrExportRef = useRef(dcrExport)
  dcrExportRef.current = dcrExport
  /**
   * ug-9/R-15: latest loaded contract without making the binder depend on
   * it, so the callback identity stays stable across validation imports (the
   * f-2 latest-closure-ref pattern used by the other session hooks).
   */
  const loadedContractRef = useRef<ContractV1 | null>(loadedContract)
  loadedContractRef.current = loadedContract

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
      previewTokenRef.current += 1
      guardRef.current?.invalidate()
      guardRef.current = null
      setFileState({ kind: 'none' })
      setBindings({})
      setContractBindings({})
      setRunState({ kind: 'idle' })
      setPreview({ kind: 'closed' })
      setDcrExport({ kind: 'idle' })
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
      // Compile the DATA subgraph only: p2-3 refuses the reserved gate
      // classes by design, and the p2-4 runner binds/executes them. The
      // data subgraph is always a valid DAG on its own (a data node can
      // never depend on a gated node — the port rule).
      const compiled = compilePipeline(dataSubgraph(parsed.pipeline))
      if (!compiled.ok) {
        setFileState({ kind: 'invalid', errors: compiled.errors })
        return
      }
      // A new pipeline supersedes any in-flight run of the previous one and
      // starts with clean bindings (bindings are per-pipeline picks).
      runTokenRef.current += 1
      previewTokenRef.current += 1
      guardRef.current?.invalidate()
      guardRef.current = null
      setBindings({})
      setContractBindings({})
      setRunState({ kind: 'idle' })
      setPreview({ kind: 'closed' })
      setDcrExport({ kind: 'idle' })
      setFileState({
        kind: 'loaded',
        pipeline: parsed.pipeline,
        plan: compiled.plan,
        order: validation.order,
      })
    })()
  }, [session])

  const bindSourceDataset = useCallback(
    (nodeId: string): void => {
      const sessionId = session.tokenRef.current
      void (async () => {
        /**
         * Honest degradation (the open path's pattern): a rejecting picker
         * or file handle degrades to the typed `bind-failed` state — never
         * an unhandled rejection, never a partial binding.
         */
        const bindFailed = (): void => {
          if (session.tokenRef.current !== sessionId) return
          setBindings((previous) => ({
            ...previous,
            [nodeId]: { kind: 'bind-failed' },
          }))
        }
        let picked: Awaited<ReturnType<typeof pickDataFile>> = null
        try {
          picked = await pickDataFile()
        } catch {
          bindFailed()
          return
        }
        if (session.tokenRef.current !== sessionId) return
        if (picked === null) return // dismissed — the source stays honestly pending
        let file: File
        try {
          file = await picked.source.getFile()
        } catch {
          bindFailed()
          return
        }
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

  /**
   * Bind one `validate` node's contract (p2-6, C2). The picked file is read
   * as text and parsed through the total `@assay/contracts` parser; read and
   * parse failures are honest states. The IR's authored `contract:` path is
   * never resolved in the browser.
   */
  const bindContract = useCallback(
    (nodeId: string): void => {
      const sessionId = session.tokenRef.current
      void (async () => {
        const bindFailed = (): void => {
          if (session.tokenRef.current !== sessionId) return
          setContractBindings((previous) => ({ ...previous, [nodeId]: { kind: 'read-failed' } }))
        }
        let picked: Awaited<ReturnType<typeof pickDataFile>> = null
        try {
          picked = await pickDataFile()
        } catch {
          bindFailed()
          return
        }
        if (session.tokenRef.current !== sessionId) return
        if (picked === null) return // dismissed — the node stays honestly pending
        let file: File
        try {
          file = await picked.source.getFile()
        } catch {
          bindFailed()
          return
        }
        if (session.tokenRef.current !== sessionId) return
        const read = await readContractFile(file)
        if (session.tokenRef.current !== sessionId) return
        if (read.kind !== 'parsed') {
          bindFailed()
          return
        }
        const parsed = parseContract(read.text)
        if (!parsed.ok) {
          setContractBindings((previous) => ({
            ...previous,
            [nodeId]: { kind: 'parse-error', errors: parsed.errors },
          }))
          return
        }
        setContractBindings((previous) => ({
          ...previous,
          [nodeId]: { kind: 'bound', contract: parsed.contract },
        }))
      })()
    },
    [session],
  )

  /**
   * ug-9/R-15 (a): bind a source node to the dataset already open. This is
   * the "Use the open dataset" primary action — it never touches the picker,
   * and it keeps the same honest binding shape (and `bind-failed`
   * degradation) as the picker path, including the session-token guard
   * around the awaited `getFile()`. The node-kind / loaded-document checks
   * keep a stale gesture from writing a binding into a different pipeline.
   */
  const bindOpenDataset = useCallback(
    (nodeId: string): void => {
      const current = fileStateRef.current
      if (current.kind !== 'loaded') return
      if (!current.pipeline.nodes.some((node) => node.id === nodeId && node.type === 'source')) {
        return
      }
      const source = openSourceRef.current
      if (source === null) return
      const sessionId = session.tokenRef.current
      void (async () => {
        const bindFailed = (): void => {
          if (session.tokenRef.current !== sessionId) return
          setBindings((previous) => ({ ...previous, [nodeId]: { kind: 'bind-failed' } }))
        }
        let file: File
        try {
          file = await source.getFile()
        } catch {
          bindFailed()
          return
        }
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
    [session, openSourceRef],
  )

  /**
   * ug-9/R-15 (a): bind a validate node to the contract Validation already
   * holds parsed — the "Use the loaded contract" primary action. No picker,
   * no re-read, no re-parse: the SAME parsed contract object reaches the run
   * contract bindings. Purely synchronous, so no session token race is
   * possible; the session reset still drops the binding with the rest.
   */
  const bindLoadedContract = useCallback((nodeId: string): void => {
    const current = fileStateRef.current
    if (current.kind !== 'loaded') return
    if (!current.pipeline.nodes.some((node) => node.id === nodeId && node.type === 'validate')) {
      return
    }
    const contract = loadedContractRef.current
    if (contract === null) return
    setContractBindings((previous) => ({ ...previous, [nodeId]: { kind: 'bound', contract } }))
  }, [])

  const run = useCallback((): void => {
    const current = fileStateRef.current
    if (current.kind !== 'loaded') return
    // UI-level serialization (p-3 carry-over): no second run can start
    // while one is in flight. The disabled control is the primary guard;
    // this check is the belt-and-braces.
    if (runStateRef.current.kind === 'running') return
    const plan = current.plan

    // C2: collect ALL unbound source nodes and validate-node contracts (in
    // node order), disclose them, and refuse before any engine call. Never
    // guess, never partially run.
    const missingSourceIds = plan.nodes
      .filter(
        (node) => node.kind === 'source' && bindingsRef.current[node.nodeId]?.kind !== 'bound',
      )
      .map((node) => node.nodeId)
    const missingContractIds = current.pipeline.nodes
      .filter((node) => node.type === 'validate')
      .filter((node) => contractBindingsRef.current[node.id]?.kind !== 'bound')
      .map((node) => node.id)
    if (missingSourceIds.length > 0 || missingContractIds.length > 0) {
      setRunState({ kind: 'refused', missingSourceIds, missingContractIds, runnerMessage: null })
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
    const runContracts = current.pipeline.nodes
      .filter((node) => node.type === 'validate')
      .flatMap((node): { nodeId: string; contract: ContractV1 }[] => {
        const binding = contractBindingsRef.current[node.id]
        return binding?.kind === 'bound' ? [{ nodeId: node.id, contract: binding.contract }] : []
      })
    const contracts: PipelineRunContractBinding[] = runContracts
    /**
     * ug-9/R-15 (b) fix-round: freeze the contracts this run STARTS with,
     * before any node executes. A re-bind while (or after) the run settles
     * must never change which contract the gated detail attributes the
     * failure to, so the settled gated state carries this snapshot rather
     * than resolving the live bindings at render time.
     */
    const contractSnapshot: Record<string, ContractV1> = {}
    for (const entry of runContracts) contractSnapshot[entry.nodeId] = entry.contract

    const token = runTokenRef.current + 1
    runTokenRef.current = token
    previewTokenRef.current += 1
    setPreview({ kind: 'closed' })
    setDcrExport({ kind: 'idle' })
    const guard = new PipelineRunGuard()
    guardRef.current = guard
    const sessionId = session.tokenRef.current
    setRunState({
      kind: 'running',
      statuses: Object.fromEntries(current.order.map((nodeId) => [nodeId, 'pending' as const])),
      cancelRequested: false,
    })
    void engineClient
      .runPipeline(current.pipeline, {
        sources,
        contracts,
        compilers: buildCompilers(),
        guard,
        onNode: (nodeId: string) => {
          // Live boundary updates: the named node is executing; every
          // earlier topological node is already materialized. Stale tokens
          // (a newer run / new pipeline / new dataset session) drop silently.
          // The transition itself is the exported, unit-pinned
          // `advanceNodeStatuses` — one implementation, no inline shadow.
          setRunState((previous) => {
            if (previous.kind !== 'running' || runTokenRef.current !== token) return previous
            if (!current.order.includes(nodeId)) return previous
            return {
              ...previous,
              statuses: advanceNodeStatuses(previous.statuses, current.order, nodeId),
            }
          })
        },
      })
      .then((result) => {
        if (runTokenRef.current !== token || session.tokenRef.current !== sessionId) return
        guardRef.current = null
        if (result.status === 'completed') {
          setRunState({ kind: 'completed', outcomes: result.nodes.map(toOutcome) })
        } else if (result.status === 'gated') {
          setRunState({
            kind: 'gated',
            gatedAt: result.gatedAt,
            gate: result.gate,
            outcomes: result.nodes.map(toOutcome),
            nextNodeId: result.nextNodeId,
            contracts: contractSnapshot,
          })
        } else {
          setRunState({
            kind: 'canceled',
            partial: result.nodes.map(toOutcome),
            nextNodeId: result.nextNodeId,
          })
        }
      })
      .catch((error: unknown) => {
        if (runTokenRef.current !== token || session.tokenRef.current !== sessionId) return
        guardRef.current = null
        if (error instanceof PipelineRunError) {
          setRunState({
            kind: 'failed',
            nodeId: error.nodeId,
            partial: partialOutcomes(error.partial, current),
            message: error.message,
          })
          return
        }
        if (error instanceof PipelineRunRefusalError) {
          // The runner's own gates (e.g. an unbound diff key set) — a
          // pre-flight refusal, not a node failure. Rendered honestly with
          // the fixed value-free class text and the refused node ids.
          setRunState({
            kind: 'refused',
            missingSourceIds: [],
            missingContractIds: [],
            runnerMessage: `${error.message}${
              error.nodeIds.length === 0 ? '' : ` (nodes: ${error.nodeIds.join(', ')})`
            }`,
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

  /**
   * Open one materialized node's relation as a grid-native preview (p2-6,
   * arch §15). The p2-1 op registers the existing session view and returns an
   * `EngineTableHandle`; the same handle then drives the grid model and the
   * schema surface — no SQL detour. Lazy: only the requested node's relation
   * (and its single input, for the schema delta) is registered.
   */
  const openPreview = useCallback((nodeId: string): void => {
    const current = fileStateRef.current
    if (current.kind !== 'loaded') return
    const view = buildNodeViews(current.pipeline, current.order, current.plan).find(
      (entry) => entry.nodeId === nodeId,
    )
    if (view === undefined) return
    const token = previewTokenRef.current + 1
    previewTokenRef.current = token
    setPreview({ kind: 'loading', nodeId })
    void (async () => {
      const dropped = (): boolean => previewTokenRef.current !== token
      try {
        const handle = await engineClient.registerPipelineRelation(view.relation)
        if (dropped()) return
        const columns = await engineClient.schema(handle)
        if (dropped()) return
        // Schema delta input: the single data input's schema, when it is
        // itself an addressable executed relation. Source nodes have none.
        let inputColumns: readonly { name: string; type: string }[] | null = null
        const inputId = view.inputs.length === 1 ? view.inputs[0] : undefined
        if (inputId !== undefined) {
          try {
            const inputHandle = await engineClient.registerPipelineRelation(inputId)
            if (dropped()) return
            inputColumns = (await engineClient.schema(inputHandle)).map((column) => ({
              name: column.name,
              type: column.type,
            }))
          } catch {
            // The input relation is not addressable (e.g. not executed):
            // the schema delta is honestly unavailable, never guessed.
            inputColumns = null
          }
        }
        if (dropped()) return
        const model = buildPreviewModel(handle)
        await model.load()
        if (dropped()) return
        setPreview({
          kind: 'ready',
          nodeId,
          relation: view.relation,
          rowCount: model.totalRows ?? 0,
          columns: columns.map((column) => ({ name: column.name, type: column.type })),
          inputColumns,
          sql: view.sql,
          materialization: view.materialization,
          model,
        })
      } catch {
        if (dropped()) return
        // Value-free, fixed class text: a relation that could not be opened
        // for preview never leaks engine detail (ADR 0025).
        setPreview({
          kind: 'failed',
          nodeId,
          message: 'the relation could not be opened for preview',
        })
      }
    })()
  }, [])

  const closePreview = useCallback((): void => {
    previewTokenRef.current += 1
    setPreview({ kind: 'closed' })
  }, [])

  /**
   * Export the DCR artifact off the settled run (p3-4). The derivation
   * mirrors the CLI seam exactly (see `./dcr-export`): both sides through
   * the p3-2 function, OQ-5 export-time liveness through the SAME
   * `schemaOf` op the runner used (built here over the p2-1 handle op —
   * the client's own internal op path), the payload through the p3-1
   * builder. Refusals are typed states with nothing written; delivery is
   * the m4-5/m5-3 save-destination discipline (download-only when identity
   * cannot be proven).
   */
  const exportDcr = useCallback(
    (rawSpec: DcrExportSpec): void => {
      const current = fileStateRef.current
      if (current.kind !== 'loaded') return
      const settled = runStateRef.current
      if (settled.kind !== 'completed' && settled.kind !== 'gated') return
      if (dcrExportRef.current.kind === 'working') return
      const spec: DcrExportSpec = {
        baseNodeId: rawSpec.baseNodeId,
        baseDatasetId: rawSpec.baseDatasetId.trim(),
        candidateNodeId: rawSpec.candidateNodeId,
        candidateDatasetId: rawSpec.candidateDatasetId.trim(),
      }
      if (spec.baseNodeId === spec.candidateNodeId) {
        setDcrExport({
          kind: 'refused',
          reason: 'same-node',
          nodeId: null,
          message: dcrRefusalMessage({ reason: 'same-node', nodeId: null }),
        })
        return
      }
      const token = runTokenRef.current
      const sessionId = session.tokenRef.current
      setDcrExport({ kind: 'working' })
      void (async () => {
        const dropped = (): boolean =>
          runTokenRef.current !== token || session.tokenRef.current !== sessionId
        // The session-truth seam: the SAME ops path the runner used (the
        // p2-1 handle op + the schema surface) — one source of session
        // truth for both the derivation and the OQ-5 liveness check.
        const schemaOf = async (relation: string) => {
          const handle = await engineClient.registerPipelineRelation(relation)
          const columns = await engineClient.schema(handle)
          return columns.map((column) => ({ name: column.name, type: column.type }))
        }
        const run: DcrExportRun =
          settled.kind === 'gated'
            ? {
                status: 'gated',
                gatedAt: settled.gatedAt,
                gate: settled.gate,
                nextNodeId: settled.nextNodeId,
                nodes: settled.outcomes,
              }
            : { status: 'completed', nodes: settled.outcomes }
        const derived = await deriveDcrArtifact({ run, plan: current.pipeline, schemaOf, spec })
        if (dropped()) return
        if (!derived.ok) {
          setDcrExport({
            kind: 'refused',
            reason: derived.refusal.reason,
            nodeId: derived.refusal.nodeId,
            message: dcrRefusalMessage(derived.refusal),
          })
          return
        }
        let destination: Awaited<ReturnType<typeof requestDcrDestination>> = null
        try {
          destination = await requestDcrDestination({
            sourceIdentity: sourceIdentityRef.current ?? undefined,
          })
        } catch (error) {
          if (dropped()) return
          setDcrExport({ kind: 'failed', message: dcrExportFailureMessage(error) })
          return
        }
        if (dropped()) return
        if (destination === null) {
          setDcrExport({ kind: 'cancelled' })
          return
        }
        if (destination.via === 'refused-source') {
          setDcrExport({ kind: 'same-source' })
          return
        }
        try {
          const strategy = await writeDcrCopy(destination, { yaml: derived.yaml })
          if (dropped()) return
          setDcrExport({
            kind: 'delivered',
            strategy,
            message: dcrExportSuccessMessage(derived.summary, strategy),
          })
        } catch (error) {
          if (dropped()) return
          setDcrExport({ kind: 'failed', message: dcrExportFailureMessage(error) })
        }
      })()
    },
    [session, sourceIdentityRef],
  )

  return {
    fileState,
    bindings,
    contractBindings,
    runState,
    preview,
    openPipelineFile,
    bindSourceDataset,
    bindContract,
    bindOpenDataset,
    bindLoadedContract,
    run,
    cancelRun,
    openPreview,
    closePreview,
    dcrExport,
    exportDcr,
  }
}
