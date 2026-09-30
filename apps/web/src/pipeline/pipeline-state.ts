// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Shared state vocabulary for the pipeline panel (p-5) — the shapes the
 * session hook (`usePipelineSession`) owns and the panel renders. Plain
 * data, discriminated unions, no behavior — mirroring the validation/diff
 * panel state contracts.
 */
import type { PipelineCompilePlan, PipelineError, PipelineV1 } from '@assay/pipeline'

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
      readonly plan: PipelineCompilePlan
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

/** Per-node run status, updated live via the runner's `onNode` hook. */
export type NodeRunStatus = 'pending' | 'running' | 'done' | 'failed'

/** One materialized node of a partial (canceled/failed) run state. */
export interface PipelinePartialNode {
  readonly nodeId: string
  readonly relation: string
}

/** One materialized node of a completed run (counts known). */
export interface PipelineRunResultNode {
  readonly relation: string
  readonly rowCount: number
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
  /** Pre-flight honest refusal: unbound source nodes (nothing was executed). */
  | { readonly kind: 'refused'; readonly missingSourceIds: readonly string[] }
  | {
      readonly kind: 'running'
      readonly statuses: Readonly<Record<string, NodeRunStatus>>
      /** Cancel clicked; the typed outcome lands at the next node boundary. */
      readonly cancelRequested: boolean
    }
  | {
      readonly kind: 'completed'
      readonly results: Readonly<Record<string, PipelineRunResultNode>>
    }
  | {
      readonly kind: 'canceled'
      /** Named partial state: the nodes materialized before cancellation. */
      readonly partial: readonly PipelinePartialNode[]
      /** The node that was not executed, or `null` on a trailing cancellation. */
      readonly nextNodeId: string | null
    }
  | {
      readonly kind: 'failed'
      /** The failing node, or `null` when the failure predates node execution. */
      readonly nodeId: string | null
      readonly partial: readonly PipelinePartialNode[]
      /** Fixed, value-free class text (typed runner messages; never raw engine text). */
      readonly message: string
    }

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
