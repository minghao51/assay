// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The candidate DatasetVersion reference derived from a completed/gated run
 * (p3-2; ADR 0046 ruling D17-Q4 — logical id + schema fingerprint +
 * provenance + materialization reference, NO full content hash).
 *
 * ## Input mapping (the Q4 quartet ← runner data)
 *
 * - **Logical id** — host-owned dataset identity (`datasetId`; ADR 0011),
 *   never a file path. The runner knows relations, not dataset identity, so
 *   the surface supplies it; the derived `versionId` defaults to a
 *   deterministic `"<datasetId>@<fingerprint prefix>"` so re-deriving a ref
 *   from the same run is byte-stable (no wall-clock — D17-Q11).
 * - **Schema fingerprint** — engine introspection of the materialized
 *   relation the producing node left behind (`schemaOf`, the same op the
 *   runner's gates use), hashed as SHA-256 over the canonical
 *   `name:type` rendering sorted by column name (code-unit order). The
 *   algorithm name is recorded in the ref (D19-OQ-6: a free string; the
 *   stability fixture is p3-5's).
 * - **Provenance** — run + node identity, no wall-clock: the producing
 *   plan as `transformationRecipe` (derived `"<pipeline>|<nodeId>"` for an
 *   IR input, `"plan|<nodeId>"` for a compiled plan; an explicit override
 *   wins) and the producing node's plan inputs as `parentVersionIds`
 *   (canonical order; an explicit override wins).
 * - **Materialization reference** — `{ node }` for a view/ephemeral/table
 *   output (the run node whose output the version is), `{ export }` for an
 *   export node (the runner's value-free OPFS path — `pipelineExportPath`
 *   encodes every non-safe character, ADR 0025: no sensitive paths).
 *
 * ## Refusal discipline
 *
 * Every refusal is a typed {@link PipelineRunRefusalError} — never a raw
 * throw, never a silent fallback: a node that is not a data node of the
 * plan, a canceled run, a node the run never executed, a gate/source
 * result, an unreachable schema, and unusable identity strings each have
 * their own reason. **Publish-mode materialization is refused explicitly**
 * (`publish-materialization`): the P3/DCR boundary stays explicit
 * (ADR 0033/0035) — publish is never wired for candidate derivation, and
 * wiring it would have to delete that guard and its pin.
 *
 * Purity: deterministic given the run + plan + introspection — no
 * wall-clock, no engine calls beyond the supplied `schemaOf`.
 */
import { isDataNode } from '@assay/pipeline'
import type { PipelineCompilePlan, PipelineV1 } from '@assay/pipeline'
import type {
  DcrMaterializationRef,
  DcrProvenance,
  DcrSchemaFingerprint,
  DcrVersionRef,
} from '@assay/pipeline'
import { PipelineRunRefusalError } from './errors.js'
import { LOCAL_RUN_MATERIALIZATION_MODES } from './plan.js'
import type { PipelineRunColumn, PipelineRunInput } from './plan.js'
import type { PipelineRunNodeResult, PipelineRunResult } from './runner.js'

/**
 * The schema-fingerprint algorithm this producer records (D19-OQ-6: the
 * artifact records what was used; no frozen-name policy — the stability
 * fixture that pins the algorithm's output joins p3-5's sweep).
 */
export const CANDIDATE_SCHEMA_FINGERPRINT_ALGORITHM = 'assay-schema-fingerprint-v1'

/** What the producing plan declares about a data node (the derivation's plan-side view). */
interface DeclaredDataNode {
  readonly nodeId: string
  /** Declared ADR 0033 mode; absent means the `view` default. */
  readonly materialization?: string
  /** The node's plan inputs (IR transform/sql only; a compiled plan carries none). */
  readonly inputs?: readonly string[]
}

/** The input to {@link candidateVersionRefFromRun}. */
export interface CandidateVersionRefInput {
  /** The completed or gated run outcome (`executePipeline`'s result). */
  readonly run: PipelineRunResult
  /** The plan/IR the run executed (the same input `executePipeline` took). */
  readonly plan: PipelineRunInput
  /** The data node whose materialized output is the candidate. */
  readonly nodeId: string
  /** The candidate dataset's logical id (ADR 0011) — host-owned, never a path. */
  readonly datasetId: string
  /** The candidate version id; deterministic default when omitted. */
  readonly versionId?: string
  /** Parent dataset version ids (ADR 0011); default: the producing node's plan inputs. */
  readonly parentVersionIds?: readonly string[]
  /** The transformation recipe; default derived from the plan + node (no wall-clock). */
  readonly transformationRecipe?: string
  /**
   * Engine introspection of a session relation (mirrors the runner's
   * `schemaOf` op). Called with the producing node's relation name; for an
   * export node the session relation does not exist (exports materialize no
   * relation), so the host supplies an introspection that can resolve the
   * exported artifact instead.
   */
  readonly schemaOf?: (relation: string) => Promise<readonly PipelineRunColumn[]>
}

/** Look up the producing node in the plan (IR or compiled plan). */
function declaredDataNodeOf(plan: PipelineRunInput, nodeId: string): DeclaredDataNode | null {
  if (Array.isArray((plan as PipelineCompilePlan).order)) {
    const node = (plan as PipelineCompilePlan).nodes.find((entry) => entry.nodeId === nodeId)
    return node === undefined
      ? null
      : { nodeId: node.nodeId, materialization: node.materialization }
  }
  const node = (plan as PipelineV1).nodes.find((entry) => entry.id === nodeId)
  if (node === undefined || !isDataNode(node)) return null
  return node.type === 'source'
    ? { nodeId: node.id, materialization: node.materialization }
    : { nodeId: node.id, materialization: node.materialization, inputs: node.inputs }
}

/** A non-empty NUL-free identity string; anything else is a typed refusal. */
function identityText(value: string, field: string, nodeId: string): string {
  if (value.length === 0 || value.includes('\u0000')) {
    throw new PipelineRunRefusalError(
      'candidate-identity-invalid',
      nodeId,
      `the candidate ${field} must be a non-empty NUL-free string`,
    )
  }
  return value
}

/** Canonical `parentVersionIds`: ascending code-unit, deduplicated. */
function canonicalParents(inputs: readonly string[], nodeId: string): readonly string[] {
  const unique = [...new Set(inputs)]
  for (const id of unique) identityText(id, 'parent version id', nodeId)
  return unique.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/** Canonical schema rendering: `name:type` pairs sorted by column name. */
function canonicalSchemaRendering(columns: readonly PipelineRunColumn[]): string {
  const sorted = [...columns].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return sorted.map((column) => `${column.name}:${column.type}`).join(',')
}

/** SHA-256 over the canonical rendering, hex — the recorded algorithm's body. */
async function schemaFingerprintOf(
  columns: readonly PipelineRunColumn[],
): Promise<DcrSchemaFingerprint> {
  const subtle = globalThis.crypto?.subtle
  if (subtle === undefined) throw new Error('no platform crypto')
  const encoded = new TextEncoder().encode(canonicalSchemaRendering(columns))
  const digest = await subtle.digest('SHA-256', encoded)
  const value = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  return { algorithm: CANDIDATE_SCHEMA_FINGERPRINT_ALGORITHM, value }
}

/** Introspect the materialized relation's schema (typed, value-free refusals). */
async function introspectCandidateSchema(
  schemaOf: ((relation: string) => Promise<readonly PipelineRunColumn[]>) | undefined,
  relation: string,
  nodeId: string,
): Promise<readonly PipelineRunColumn[]> {
  if (schemaOf === undefined) {
    throw new PipelineRunRefusalError(
      'candidate-schema-unavailable',
      nodeId,
      'a candidate reference needs the materialized relation schema: no engine introspection was supplied',
    )
  }
  let columns: readonly PipelineRunColumn[]
  try {
    columns = await schemaOf(relation)
  } catch {
    // Value-free: the raw introspection error is dropped — it can embed
    // relation state or engine text (the errors.ts discipline).
    throw new PipelineRunRefusalError(
      'candidate-schema-unavailable',
      nodeId,
      'the materialized relation schema could not be introspected (the view may have been dropped)',
    )
  }
  if (columns.length === 0) {
    throw new PipelineRunRefusalError(
      'candidate-schema-unavailable',
      nodeId,
      'the materialized relation introspected to an empty schema',
    )
  }
  return columns
}

/** The export form's value-free artifact path (present on every executed export). */
function exportPathOf(node: PipelineRunNodeResult, nodeId: string): string {
  const path = node.exportPath
  if (path === undefined || path.length === 0 || path.includes('\u0000')) {
    throw new PipelineRunRefusalError(
      'candidate-not-materialized',
      nodeId,
      'the export node result carries no value-free artifact path',
    )
  }
  return path
}

/**
 * Derive the candidate DatasetVersion reference (the D17-Q4 identity) from a
 * completed/gated run's materialized output. Total over the refusal
 * discipline: every invalid request degrades to a typed located
 * {@link PipelineRunRefusalError} — never a raw throw, never a silent
 * fallback, never a publish-mode reference.
 */
export async function candidateVersionRefFromRun(
  input: CandidateVersionRefInput,
): Promise<DcrVersionRef> {
  const declared = declaredDataNodeOf(input.plan, input.nodeId)
  if (declared === null) {
    throw new PipelineRunRefusalError('candidate-node-unknown', input.nodeId)
  }
  // The declared-mode guard (p3-2): the P3/DCR boundary is explicit. Publish
  // mode is never a candidate reference — a run cannot even reach a
  // publish-mode node today (plan resolution refuses it before any engine
  // call), and this guard keeps it that way at the DCR seam: wiring publish
  // would have to delete this guard and its unit pin. Other non-local modes
  // reuse the runner's own unsupported-materialization refusal.
  if (declared.materialization === 'publish') {
    throw new PipelineRunRefusalError('publish-materialization', input.nodeId)
  }
  if (
    !(LOCAL_RUN_MATERIALIZATION_MODES as readonly string[]).includes(
      declared.materialization ?? 'view',
    )
  ) {
    throw new PipelineRunRefusalError('unsupported-materialization', input.nodeId)
  }
  if (input.run.status === 'canceled') {
    throw new PipelineRunRefusalError('candidate-run-canceled', input.nodeId)
  }
  const nodeResult = input.run.nodes.find((node) => node.nodeId === input.nodeId)
  if (nodeResult === undefined) {
    throw new PipelineRunRefusalError('candidate-node-absent', input.nodeId)
  }
  if (nodeResult.materialization === 'gate' || nodeResult.materialization === 'source') {
    throw new PipelineRunRefusalError('candidate-not-materialized', input.nodeId)
  }

  const datasetId = identityText(input.datasetId, 'datasetId', input.nodeId)
  const recipe =
    input.transformationRecipe === undefined
      ? Array.isArray((input.plan as PipelineCompilePlan).order)
        ? `plan|${input.nodeId}`
        : `${(input.plan as PipelineV1).pipeline}|${input.nodeId}`
      : input.transformationRecipe
  identityText(recipe, 'transformationRecipe', input.nodeId)

  const columns = await introspectCandidateSchema(input.schemaOf, nodeResult.relation, input.nodeId)
  let fingerprint: DcrSchemaFingerprint
  try {
    fingerprint = await schemaFingerprintOf(columns)
  } catch {
    throw new PipelineRunRefusalError(
      'candidate-schema-unavailable',
      input.nodeId,
      'the schema fingerprint could not be computed: no platform crypto is available',
    )
  }

  const versionId =
    input.versionId === undefined
      ? `${datasetId}@${fingerprint.value.slice(0, 16)}`
      : identityText(input.versionId, 'versionId', input.nodeId)
  const parents =
    input.parentVersionIds === undefined
      ? declared.inputs === undefined
        ? undefined
        : canonicalParents(declared.inputs, input.nodeId)
      : canonicalParents(input.parentVersionIds, input.nodeId)
  // Absence is meaning: no parents carried means no parentVersionIds field.
  const provenance: DcrProvenance =
    parents === undefined
      ? { transformationRecipe: recipe }
      : { transformationRecipe: recipe, parentVersionIds: parents }
  const materialization: DcrMaterializationRef =
    nodeResult.materialization === 'export'
      ? { export: exportPathOf(nodeResult, input.nodeId) }
      : { node: input.nodeId }

  return {
    datasetId,
    versionId,
    schemaFingerprint: fingerprint,
    provenance,
    materialization,
  }
}
