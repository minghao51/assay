// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Shared state vocabulary for the pipeline panel (p-5; extended p2-6) — the
 * shapes the session hook (`usePipelineSession`) owns and the panel renders.
 * Plain data, discriminated unions, no behavior — mirroring the
 * validation/diff panel state contracts.
 *
 * p2-6 additions (arch §15/§16 core): the loaded file state carries the
 * validated topological order (the full IR order including gate nodes, which
 * the p2-3 compiler does not compile); per-`validate`-node contract bindings
 * (C2: parsed contracts supplied by the user, never resolved from the IR's
 * authored path); and the run outcomes carry the runner's per-node
 * materialization + gate verdicts so the panel can render materialization
 * badges, validate/diff verdicts, the gated (run-stopped-at-gate) state, and
 * an honest preview.
 */
import type { PipelineCompilePlan, PipelineError, PipelineV1 } from '@assay/pipeline'
import type { ContractError, ContractV1 } from '@assay/contracts'

/**
 * The pipeline FILE lifecycle. Parse and validation are the p-1 total
 * surfaces: every malformed document degrades to located typed errors —
 * the empty/error states are first-class states here, never throws.
 */
export type PipelineFileState =
  | { readonly kind: 'none' }
  /** Picker/read/parse chain in flight (an honest busy state, not silence). */
  | { readonly kind: 'opening' }
  /** The picked file could not be read as text (fixed, value-free message). */
  | { readonly kind: 'read-failed' }
  | { readonly kind: 'parse-error'; readonly errors: readonly PipelineError[] }
  /** DAG validation or compilation refused the pipeline (typed refusals). */
  | { readonly kind: 'invalid'; readonly errors: readonly PipelineError[] }
  | {
      readonly kind: 'loaded'
      readonly pipeline: PipelineV1
      /**
       * The DATA subgraph's compiled plan (p2-3). Gate nodes (`validate` /
       * `diff` / `publish`) are deliberately absent: the p2-3 compiler
       * refuses them (`reserved-node-class`) and the p2-4 runner binds them
       * separately. `buildNodeViews` merges this with the IR order.
       */
      readonly plan: PipelineCompilePlan
      /** The validated topological order of EVERY node (gates included). */
      readonly order: readonly string[]
    }

/** One source node's dataset binding (C2: user-picked, never guessed). */
export type SourceBindingState =
  | { readonly kind: 'pending' }
  /**
   * The picked dataset could not be read (the picker or the file handle
   * rejected). Honest degradation, mirroring the open path's `read-failed`:
   * a fixed value-free state — never an unhandled rejection, never a
   * partial binding, and the pick gesture stays available for a retry.
   */
  | { readonly kind: 'bind-failed' }
  | {
      readonly kind: 'bound'
      /**
       * The picked file's name — transported to the engine for format
       * detection only (the runner's `{name, getFile()}` source shape);
       * NEVER rendered, logged, or announced (ADR 0025).
       */
      readonly fileName: string
      readonly getFile: () => Promise<File>
    }

/**
 * One `validate` node's contract binding (p2-6, C2). The IR's authored
 * `contract:` value is a path reference and is NEVER resolved in the browser;
 * the user picks a contract file explicitly, which is parsed through
 * `@assay/contracts`'s total parser. Parse failures are an honest state, not
 * a run failure — the run pre-check refuses before any engine call.
 */
export type ContractBindingState =
  | { readonly kind: 'pending' }
  /** The picked contract could not be read or parsed (located, value-free). */
  | { readonly kind: 'read-failed' }
  | { readonly kind: 'parse-error'; readonly errors: readonly ContractError[] }
  | { readonly kind: 'bound'; readonly contract: ContractV1 }

/** Per-node run status, updated live via the runner's `onNode` hook. */
export type NodeRunStatus = 'pending' | 'running' | 'done' | 'failed' | 'gated'

/**
 * How a node's output materialized (or that it is a gate verdict). Mirrors
 * the runner's `PipelineRunNodeResult.materialization`; the pre-run badge
 * reads the p2-3 plan's `statementKind`/`materialization`.
 */
export type NodeMaterialization = 'source' | 'view' | 'ephemeral' | 'table' | 'export' | 'gate'

/** A gate node's value-free verdict (never dataset values). */
export type PipelineRunGateVerdict =
  | {
      readonly class: 'validate'
      readonly input: string
      readonly valid: boolean
      /** How many contract rules were violated (0 when valid). */
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

/** One executed node's addressable outcome (the runner's value-free shape). */
export interface PipelineRunOutcome {
  readonly nodeId: string
  /** The output relation (the node id); for a gate, the input relation. */
  readonly relation: string
  readonly rowCount: number
  readonly materialization: NodeMaterialization
  /** An export node's OPFS artifact path (value-free; export only). */
  readonly exportPath?: string
  /** A gate node's value-free verdict (validate/diff/publish only). */
  readonly gate?: PipelineRunGateVerdict
}

/**
 * The run lifecycle. Serialized at the UI level (p-3 carry-over: the runner
 * has no re-entrancy guard by design — the Run control is disabled while a
 * run executes and the hook double-checks). Cancellation is the typed
 * `canceled` outcome the runner returns at the next node boundary after the
 * guard is invalidated (ADR 0040: no client-facing query interrupt).
 */
export type PipelineRunState =
  | { readonly kind: 'idle' }
  /**
   * Pre-flight honest refusal: unbound source nodes and/or unbound
   * `validate` contracts, or a runner refusal (e.g. an unbound diff key set)
   * collected and disclosed before any engine call. Nothing was executed.
   */
  | {
      readonly kind: 'refused'
      readonly missingSourceIds: readonly string[]
      readonly missingContractIds: readonly string[]
      /** A runner refusal's fixed value-free class text, or `null` for the pre-flight list. */
      readonly runnerMessage: string | null
    }
  | {
      readonly kind: 'running'
      readonly statuses: Readonly<Record<string, NodeRunStatus>>
      /** Cancel clicked; the typed outcome lands at the next node boundary. */
      readonly cancelRequested: boolean
    }
  | {
      readonly kind: 'completed'
      /** Every executed node, in execution order (gate verdicts included). */
      readonly outcomes: readonly PipelineRunOutcome[]
    }
  /**
   * A gate stopped the run (p2-4): `gatedAt` names where evaluation stopped
   * and `outcomes` is every executed node — including a failed validate
   * consumed by a publish (whose own result is the publish's blocked gate).
   * No downstream node executed. The panel must show what completed, what a
   * re-run needs, and which gates are still blocked.
   */
  | {
      readonly kind: 'gated'
      readonly gatedAt: string
      readonly gate: 'validation-failed' | 'publish-blocked'
      readonly outcomes: readonly PipelineRunOutcome[]
      /** The next unexecuted node, or `null` on a trailing gate. */
      readonly nextNodeId: string | null
    }
  | {
      readonly kind: 'canceled'
      /** Named partial state: the nodes materialized before cancellation. */
      readonly partial: readonly PipelineRunOutcome[]
      /** The node that was not executed, or `null` on a trailing cancellation. */
      readonly nextNodeId: string | null
    }
  | {
      readonly kind: 'failed'
      /** The failing node, or `null` when the failure predates node execution. */
      readonly nodeId: string | null
      readonly partial: readonly PipelineRunOutcome[]
      /** Fixed, value-free class text (typed runner messages; never raw engine text). */
      readonly message: string
    }

/**
 * The per-node preview lifecycle (p2-6, arch §15). Preview is lazy and
 * on-demand: the relation is opened through the p2-1 `registerPipelineRelation`
 * op only when a preview is requested, and the returned `EngineTableHandle`
 * drives the EXISTING grid model/schema surfaces (the same handle-based
 * registry path a dataset open uses — never a SQL-result detour). The grid
 * model itself is owned by the session hook; the panel only renders it.
 */
export type PipelinePreviewState =
  | { readonly kind: 'closed' }
  | { readonly kind: 'loading'; readonly nodeId: string }
  | {
      readonly kind: 'ready'
      readonly nodeId: string
      readonly relation: string
      readonly rowCount: number
      /** The node's output schema (the relation the handle addresses). */
      readonly columns: readonly { readonly name: string; readonly type: string }[]
      /** The single input relation's schema when the node has one input; else `null`. */
      readonly inputColumns: readonly { readonly name: string; readonly type: string }[] | null
      /** The p2-3 generated query for transform/sql nodes, or `null`. */
      readonly sql: string | null
      /** The pre-run materialization badge for this node. */
      readonly materialization: NodeMaterialization
      /**
       * The live grid model over the registered handle. The panel renders it
       * through the existing `DataGrid` renderer — no bespoke table.
       */
      readonly model: GridPreviewModel
    }
  | { readonly kind: 'failed'; readonly nodeId: string; readonly message: string }

/**
 * The structural surface the panel renders. Kept as a narrow local alias so
 * the state module stays free of a `@assay/grid` import at the type level
 * elsewhere; the hook owns the concrete `GridViewportModel`.
 */
export type GridPreviewModel = import('@assay/grid').GridViewportModel

/** All nodes of a topological order start pending. */
export function initialNodeStatuses(order: readonly string[]): Record<string, NodeRunStatus> {
  const statuses: Record<string, NodeRunStatus> = {}
  for (const nodeId of order) statuses[nodeId] = 'pending'
  return statuses
}

/**
 * Live `onNode` transition: the named node begins its engine op, so every
 * earlier node in the topological order is already materialized (the runner
 * awaits each op before advancing). Pure; returns a fresh map.
 */
export function advanceNodeStatuses(
  statuses: Readonly<Record<string, NodeRunStatus>>,
  order: readonly string[],
  currentNodeId: string,
): Record<string, NodeRunStatus> {
  const next = { ...statuses }
  const index = order.indexOf(currentNodeId)
  if (index < 0) return next
  for (let position = 0; position < index; position += 1) {
    const nodeId = order[position]
    if (next[nodeId] === 'pending' || next[nodeId] === 'running') next[nodeId] = 'done'
  }
  next[currentNodeId] = 'running'
  return next
}

/**
 * The DCR artifact export lifecycle (p3-4). The export is offered on
 * completed/gated runs only; every settled outcome is an honest state with
 * fixed value-free text (the m5-3/m6-4 export-state shape): the derivation
 * refusals land as `refused` (typed reason data — OQ-5 lands here), the
 * delivery outcomes mirror the report-export machine.
 */
export type DcrExportState =
  | { readonly kind: 'idle' }
  /** Derivation + destination + delivery in flight (an honest busy state). */
  | { readonly kind: 'working' }
  | {
      readonly kind: 'delivered'
      readonly strategy: 'file-system-access' | 'download'
      readonly message: string
    }
  | { readonly kind: 'cancelled' }
  /** The picked destination was the opened source (refused before any write). */
  | { readonly kind: 'same-source' }
  | {
      readonly kind: 'refused'
      readonly reason: string
      readonly nodeId: string | null
      readonly message: string
    }
  | { readonly kind: 'failed'; readonly message: string }
