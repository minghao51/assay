// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * DCR artifact export (p3-4) — the derivation seam mirrored from the CLI
 * (`apps/cli/src/dcr.ts`) plus the destination/delivery glue, in the m5-3/
 * m6-4 export discipline (`../validation/report-export`, `../diff/diff-export`).
 *
 * ## Derivation (the ONE construction path, consumed — never forked)
 *
 * Both version references come from the p3-2 `candidateVersionRefFromRun`
 * (the same single function the CLI drives), liveness is re-verified at
 * EXPORT time through the same `schemaOf` op the derivation used (D19-OQ-5:
 * no check-then-use window — the resolved schemas also feed the drift
 * computation), schema drift comes from `@assay/diff`'s own classifier, and
 * the payload is built + serialized by the p3-1 builder (`buildDcrArtifact`
 * + `serializeDcr`). There is deliberately NO web-side re-serialization:
 * the canonical YAML string the builder produces IS the artifact.
 *
 * **LOAD-BEARING PIN:** because both surfaces derive through the same
 * packages and the same p3-2/p3-1 functions, the same golden gated run
 * (`fixtures/pipeline/cli_dcr_gated.yaml`) exports byte-identical artifact
 * bytes from CLI and web — pinned against the committed golden
 * `fixtures/dcr/cli-gated-run.yaml` in `dcr-export.test.ts` (unit) and in
 * the playwright journey (real engine, real delivery).
 *
 * Every derivation refusal is typed data (never a throw): a dangling
 * materialization reference refuses loudly with NOTHING written (OQ-5),
 * publish mode is never a version reference (ADR 0033/0035), and the
 * builder's refusals surface as a named invalid state.
 *
 * ## Delivery (always a NEW file)
 *
 * The artifact is a new file — never a rewrite of anything (ADR 0012).
 * Delivery reuses the m4-5/m5-3 save-destination shape: the File System
 * Access save picker when a retained source identity can prove the picked
 * destination is not the opened source (same-entry → refused before any
 * byte write), otherwise the anchor-download fallback. Result lines always
 * say the opened file is unchanged and use no overwrite language.
 *
 * Privacy (ADR 0025): the artifact is value-free by construction (the
 * builder's own pins); the in-panel messages carry dataset ids, node ids,
 * and counts only — schema, never values.
 */
import { schemaDrift } from '@assay/diff'
import type { EngineSchema } from '@assay/validation'
import { buildDcrArtifact, sanitizePipelineText, serializeDcr } from '@assay/pipeline'
import type { DcrVersionRef, PipelineV1 } from '@assay/pipeline'
import { candidateVersionRefFromRun, PipelineRunRefusalError } from '@assay/engine-duckdb'
import type {
  PipelineRunColumn,
  PipelineRunGateResult,
  PipelineRunResult,
} from '@assay/engine-duckdb'
import type {
  SaveDestination,
  SaveStrategy,
  WritableSaveDestination,
} from '../export/save-destination'
import { detectSaveCapabilities } from '../export/save-destination'

/**
 * The executed run an export derives from: the session's settled outcome
 * (completed or gated — a canceled/failed run is never an export basis).
 * Structurally the runner's `PipelineRunResult` (the panel's value-free
 * outcomes are that shape), so the p3-2 function consumes it unchanged.
 */
export type DcrExportRun = Extract<PipelineRunResult, { status: 'completed' | 'gated' }>

/** The two named sides of the comparison, as the user states them. */
export interface DcrExportSpec {
  readonly baseNodeId: string
  readonly baseDatasetId: string
  readonly candidateNodeId: string
  readonly candidateDatasetId: string
}

/** The engine introspection seam (the runner's `schemaOf` op shape). */
export type DcrSchemaOf = (relation: string) => Promise<readonly PipelineRunColumn[]>

/** Why nothing was exported — typed, rendered in-panel, never a throw. */
export type DcrExportRefusalReason =
  /** D19-OQ-5: a materialization reference did not resolve at export time. */
  | 'dangling-materialization'
  /** A canceled run is no export basis (unreachable from the panel; total). */
  | 'run-canceled'
  /** The named node is not a data node of this pipeline. */
  | 'node-unknown'
  /** The named node did not execute in this run. */
  | 'node-absent'
  /** The named node produced no materialized output (source/gate nodes). */
  | 'node-not-materialized'
  /** Publish mode is never a DCR version reference (ADR 0033/0035). */
  | 'publish-materialization'
  /** The node's materialization mode cannot be referenced on this surface. */
  | 'unsupported-materialization'
  /** A dataset id (identity string) was empty or unusable. */
  | 'identity-invalid'
  /** The builder refused the assembled payload (a structural defect). */
  | 'builder-refused'
  /** Both sides named the same node (the CLI's option-level refusal). */
  | 'same-node'

/** A typed export refusal: why nothing was written, with the node (when attributed). */
export interface DcrExportRefusal {
  readonly reason: DcrExportRefusalReason
  readonly nodeId: string | null
}

/** The roll-up an exported artifact reports (value-free counts only). */
export interface DcrArtifactSummary {
  readonly baseDatasetId: string
  readonly candidateDatasetId: string
  readonly baseNodeId: string
  readonly candidateNodeId: string
  readonly schemaDriftFindings: number
  readonly validationVerdicts: number
  /** `null` when no validate gate executed — never a fabricated verdict. */
  readonly validationValid: boolean | null
}

/** The derivation outcome — total: refusals are data, never throws. */
export type DcrDerivationResult =
  | {
      readonly ok: true
      /** The canonical artifact text — exactly the bytes delivered to disk. */
      readonly yaml: string
      readonly summary: DcrArtifactSummary
    }
  | { readonly ok: false; readonly refusal: DcrExportRefusal }

/**
 * Map a p3-2 reference-derivation refusal to the panel's typed refusal
 * (the CLI's `mapRefusal` seam, mirrored).
 */
function mapRefusal(error: PipelineRunRefusalError): DcrExportRefusal {
  switch (error.reason) {
    case 'candidate-run-canceled':
      return { reason: 'run-canceled', nodeId: error.nodeId }
    case 'candidate-schema-unavailable':
      // D19-OQ-5: the materialization reference does not resolve in the
      // run session — the export-time liveness refusal, loud and typed.
      return { reason: 'dangling-materialization', nodeId: error.nodeId }
    case 'candidate-node-unknown':
      return { reason: 'node-unknown', nodeId: error.nodeId }
    case 'candidate-node-absent':
      return { reason: 'node-absent', nodeId: error.nodeId }
    case 'candidate-not-materialized':
      return { reason: 'node-not-materialized', nodeId: error.nodeId }
    case 'publish-materialization':
      return { reason: 'publish-materialization', nodeId: error.nodeId }
    case 'unsupported-materialization':
      return { reason: 'unsupported-materialization', nodeId: error.nodeId }
    default:
      return { reason: 'identity-invalid', nodeId: error.nodeId }
  }
}

/** One side's derivation outcome: a version reference or a typed refusal. */
type SideDerivation = { readonly ref: DcrVersionRef } | { readonly refusal: DcrExportRefusal }

async function deriveSide(
  run: DcrExportRun,
  plan: PipelineV1,
  schemaOf: DcrSchemaOf,
  side: 'base' | 'candidate',
  spec: DcrExportSpec,
): Promise<SideDerivation> {
  try {
    return {
      ref: await candidateVersionRefFromRun({
        run,
        plan,
        nodeId: side === 'base' ? spec.baseNodeId : spec.candidateNodeId,
        datasetId: side === 'base' ? spec.baseDatasetId : spec.candidateDatasetId,
        schemaOf,
      }),
    }
  } catch (error) {
    if (error instanceof PipelineRunRefusalError) return { refusal: mapRefusal(error) }
    throw error
  }
}

/**
 * The OQ-5 export-time liveness verification: a derived reference's
 * materialization must resolve RIGHT NOW through the same `schemaOf` op
 * the derivation used, and the resolved schema feeds the drift computation
 * (no window where a reference could dangle past the check). An
 * `{ export }` reference cannot occur from a run whose data nodes the panel
 * offers, and is refused loudly rather than passed.
 */
async function verifyMaterializationLive(
  ref: DcrVersionRef,
  run: DcrExportRun,
  schemaOf: DcrSchemaOf,
): Promise<
  { ok: true; schema: readonly PipelineRunColumn[] } | { ok: false; nodeId: string | null }
> {
  if ('export' in ref.materialization) {
    return { ok: false, nodeId: null }
  }
  const nodeId = ref.materialization.node
  const nodeResult = run.nodes.find((node) => node.nodeId === nodeId)
  if (nodeResult === undefined) {
    return { ok: false, nodeId }
  }
  try {
    const schema = await schemaOf(nodeResult.relation)
    if (schema.length === 0) {
      return { ok: false, nodeId }
    }
    return { ok: true, schema }
  } catch {
    return { ok: false, nodeId }
  }
}

/** The validate verdicts the run actually executed, in execution order. */
function executedValidationVerdicts(run: DcrExportRun): {
  verdicts: number
  valid: boolean | null
} {
  let count = 0
  let valid: boolean | null = null
  for (const node of run.nodes) {
    const gate: PipelineRunGateResult | undefined = node.gate
    if (gate === undefined || gate.class !== 'validate') continue
    count += 1
    valid = valid === null ? gate.valid : valid && gate.valid
  }
  return { verdicts: count, valid }
}

/**
 * Derive the DCR artifact off a completed/gated run — the web mirror of the
 * CLI's `deriveDcrArtifact` seam (p3-4; the byte-agreement twin). Total:
 * refusals are typed data, never throws; nothing is built or written when
 * any step refuses (OQ-5).
 */
export async function deriveDcrArtifact(input: {
  readonly run: DcrExportRun
  readonly plan: PipelineV1
  readonly schemaOf: DcrSchemaOf
  readonly spec: DcrExportSpec
}): Promise<DcrDerivationResult> {
  const base = await deriveSide(input.run, input.plan, input.schemaOf, 'base', input.spec)
  if ('refusal' in base) return { ok: false, refusal: base.refusal }
  const candidate = await deriveSide(input.run, input.plan, input.schemaOf, 'candidate', input.spec)
  if ('refusal' in candidate) return { ok: false, refusal: candidate.refusal }
  const baseRef = base.ref
  const candidateRef = candidate.ref

  // D19-OQ-5 export-time liveness: both materialization references must
  // resolve right now, before anything is built (and the resolved schemas
  // feed the drift computation — one introspection path, no gap).
  const baseLive = await verifyMaterializationLive(baseRef, input.run, input.schemaOf)
  if (!baseLive.ok) {
    return { ok: false, refusal: { reason: 'dangling-materialization', nodeId: baseLive.nodeId } }
  }
  const candidateLive = await verifyMaterializationLive(candidateRef, input.run, input.schemaOf)
  if (!candidateLive.ok) {
    return {
      ok: false,
      refusal: { reason: 'dangling-materialization', nodeId: candidateLive.nodeId },
    }
  }

  // Structural schema drift between the two materialized relations, via
  // @assay/diff's own classifier (consumed, never forked; value-free —
  // column names and engine type spellings are schema, never values).
  const driftFindings = schemaDrift(
    baseLive.schema as EngineSchema,
    candidateLive.schema as EngineSchema,
  ).findings

  // Only verdicts the run executed travel (the p2-5 honesty): a gated run
  // carries the verdict that stopped it; a run with no validate gates
  // carries no validation section at all.
  const validation = [...input.run.nodes]
    .filter((node) => node.gate?.class === 'validate')
    .map((node) => ({
      nodeId: node.nodeId,
      input: node.gate?.class === 'validate' ? node.gate.input : node.relation,
      valid: node.gate?.class === 'validate' ? node.gate.valid : false,
      violatedRules: node.gate?.class === 'validate' ? node.gate.violatedRules : 0,
      rowCount: node.rowCount,
    }))
  const validationRollup = executedValidationVerdicts(input.run)

  // P2-derived lineage: the input version (the reference side) and the
  // executed node list in execution order — the evidence snapshot of THIS
  // run (a gated run's list is the executed prefix; that is the honesty).
  const lineage = {
    inputVersionIds: [...new Set([baseRef.versionId])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    nodes: input.run.nodes.map((node) => node.nodeId),
  }

  const built = buildDcrArtifact({
    base: baseRef,
    candidate: candidateRef,
    deltas:
      driftFindings.length === 0
        ? {}
        : {
            schemaDrift: driftFindings.map((finding) => ({
              kind: finding.kind,
              column: finding.column,
              ...(finding.typeA === undefined ? {} : { typeA: finding.typeA }),
              ...(finding.typeB === undefined ? {} : { typeB: finding.typeB }),
              ...(finding.familyA === undefined ? {} : { familyA: finding.familyA }),
              ...(finding.familyB === undefined ? {} : { familyB: finding.familyB }),
              ...(finding.nullShareA === undefined ? {} : { nullShareA: finding.nullShareA }),
              ...(finding.nullShareB === undefined ? {} : { nullShareB: finding.nullShareB }),
            })),
          },
    ...(validation.length === 0 ? {} : { validation }),
    lineage,
  })
  if (!built.ok) {
    // The builder refused the assembled payload — a structural defect in
    // the derivation itself. Loud, typed, nothing written.
    return {
      ok: false,
      refusal: { reason: 'builder-refused', nodeId: null },
    }
  }
  return {
    ok: true,
    yaml: serializeDcr(built.artifact),
    summary: {
      baseDatasetId: baseRef.datasetId,
      candidateDatasetId: candidateRef.datasetId,
      baseNodeId: specNodeId(baseRef),
      candidateNodeId: specNodeId(candidateRef),
      schemaDriftFindings: driftFindings.length,
      validationVerdicts: validationRollup.verdicts,
      validationValid: validationRollup.valid,
    },
  }
}

/** The node id a derived version's `{ node }` materialization names. */
function specNodeId(ref: DcrVersionRef): string {
  return 'node' in ref.materialization ? ref.materialization.node : ''
}

/**
 * The materialized data nodes a completed/gated run offers as DCR sides,
 * in execution order: executed nodes that materialized a session relation
 * (source and gate nodes are refused by the derivation, so they are not
 * offered — never a guessable option list).
 */
export function dcrExportableNodeIds(run: DcrExportRun): readonly string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const node of run.nodes) {
    if (node.materialization !== 'source' && node.materialization !== 'gate') {
      if (!seen.has(node.nodeId)) {
        seen.add(node.nodeId)
        ids.push(node.nodeId)
      }
    }
  }
  return ids
}

// --- Delivery (the m5-3/m6-4 patterns, specialized to the artifact) ---------

/** Suggested file name — a new artifact file, never a source's name. */
export function dcrArtifactFileName(): string {
  return 'assay-dcr.yaml'
}

/** Save-picker entry point, injectable so tests never open a native dialog. */
export type ShowDcrSavePicker = (options: { suggestedName: string }) => Promise<DcrSaveHandle>

/** The writable slice of a picked save handle (the m5-3 seam shape). */
export interface DcrSaveHandle {
  createWritable(): Promise<DcrWritable>
}

export interface DcrWritable {
  write(chunk: Uint8Array<ArrayBuffer>): Promise<void>
  close(): Promise<void>
}

export interface RequestDcrDestinationDeps {
  readonly capabilities?: ReturnType<typeof detectSaveCapabilities>
  readonly showSaveFilePicker?: ShowDcrSavePicker
  /**
   * Opened-source identity for the same-source refusal — the m4-5 rule:
   * present only for FSA-opened sessions; absent means identity cannot be
   * proven, so the picker is never offered and delivery rides the anchor
   * download (fail-closed by construction).
   */
  readonly sourceIdentity?: { readonly isSameEntry: (other: FileSystemHandle) => Promise<boolean> }
}

/** True for the DOMException a dismissed save picker raises. */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * Acquire a destination for the artifact. Resolves `null` on a dismissed
 * picker; `{ via: 'refused-source' }` when the picker returned the opened
 * source's own entry (refused before any byte write — the artifact must
 * never replace anything, least of all the data it describes).
 */
export async function requestDcrDestination(
  deps: RequestDcrDestinationDeps = {},
): Promise<SaveDestination | null> {
  if (deps.sourceIdentity === undefined) return { via: 'download' }
  const capabilities = deps.capabilities ?? detectSaveCapabilities()
  if (!capabilities.fileSavePicker) return { via: 'download' }
  const pick: ShowDcrSavePicker =
    deps.showSaveFilePicker ??
    ((options) => showSaveFilePicker({ suggestedName: options.suggestedName }))
  try {
    const handle = await pick({ suggestedName: dcrArtifactFileName() })
    let sameEntry: boolean
    try {
      // SAFETY: a real picker resolves a DOM FileSystemFileHandle; the
      // structural `DcrSaveHandle` deliberately does not re-declare the DOM
      // supertype (the m5-3 report-export cast, verbatim).
      sameEntry = await deps.sourceIdentity.isSameEntry(handle as unknown as FileSystemHandle)
    } catch {
      sameEntry = true // identity unprovable → fail closed (m4-5 discipline)
    }
    if (sameEntry) return { via: 'refused-source' }
    return { via: 'file-system-access', handle }
  } catch (error) {
    if (isAbortError(error)) return null
    throw error
  }
}

/**
 * Deliver artifact bytes to a resolved destination. FSA sessions get a
 * direct write to the picked handle; everything else rides the anchor
 * download (the m4-5 delivery contract). Resolves the strategy actually
 * used, so the result line can say honestly where the artifact went.
 */
export async function writeDcrCopy(
  destination: WritableSaveDestination,
  content: { readonly yaml: string },
  deps: { readonly deliverDownload?: (blob: Blob, fileName: string) => void } = {},
): Promise<SaveStrategy> {
  const bytes = new TextEncoder().encode(content.yaml)
  if (destination.via === 'file-system-access') {
    const writable = await destination.handle.createWritable()
    await writable.write(bytes)
    await writable.close()
    return 'file-system-access'
  }
  const deliver = deps.deliverDownload ?? deliverDcrDownload
  deliver(new Blob([bytes], { type: 'application/yaml' }), dcrArtifactFileName())
  return 'download'
}

/**
 * Hidden-anchor download — the same delivery contract as the m4-5
 * `downloadBlob`: object URL revoked on a generous timer after the click,
 * so the browser has certainly finished reading the blob.
 */
function deliverDcrDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  globalThis.setTimeout(() => {
    URL.revokeObjectURL(url)
  }, 30_000)
}

/**
 * Honest result line for a delivered artifact. Counts are the derivation's
 * own, never estimated; both delivery strategies are unambiguously NEW
 * files and the line says the opened file is unchanged (the m4-5 copy rule).
 */
export function dcrExportSuccessMessage(
  summary: DcrArtifactSummary,
  strategy: SaveStrategy,
): string {
  const verdict =
    summary.validationVerdicts === 0 || summary.validationValid === null
      ? 'none carried'
      : summary.validationValid
        ? 'valid'
        : 'invalid'
  const head =
    `Exported the DCR artifact (${String(summary.schemaDriftFindings)} schema drift findings, ` +
    `${verdict} validation)`
  const where =
    strategy === 'file-system-access'
      ? 'to a new file.'
      : '— your browser is downloading it as a new file.'
  return `${head} ${where} The opened file is unchanged.`
}

export const DCR_EXPORT_CANCELLED_MESSAGE =
  'Export cancelled — no new file was written, and the opened file is unchanged.'

export const DCR_EXPORT_SAME_SOURCE_MESSAGE =
  'That is the opened file — writing the artifact there would change the source. ' +
  'Choose a different name or location. Nothing was written, and the opened file is unchanged.'

/**
 * Failure line for any export step. Always states that nothing was written
 * and the source is unchanged; the raw error text is reduced to its first
 * line and never echoed when empty (the m4-5 `exportErrorSummary` rule —
 * engine errors can carry SQL across further lines).
 */
export function dcrExportFailureMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const summary = raw.split('\n')[0]?.trim() ?? ''
  return (
    `Export failed: ${summary === '' ? 'the artifact could not be written' : summary}. ` +
    'No file was written, and the opened file is unchanged.'
  )
}

/**
 * The in-panel refusal line (the OQ-5 refusal UX — loud, typed, and always
 * stating that NOTHING was written). Node ids render through
 * `sanitizePipelineText` at the component boundary; this line is plain data
 * with authored fixed text per reason.
 */
export function dcrRefusalMessage(refusal: DcrExportRefusal): string {
  const node = refusal.nodeId === null ? '' : ` for node "${sanitizePipelineText(refusal.nodeId)}"`
  switch (refusal.reason) {
    case 'dangling-materialization':
      return (
        `The artifact was not exported: the materialization reference${node} no longer ` +
        'resolves in the run session. Nothing was written, and the opened file is unchanged.'
      )
    case 'run-canceled':
      return (
        'The artifact was not exported: the run was canceled before the named sides ' +
        'materialized. Nothing was written, and the opened file is unchanged.'
      )
    case 'node-unknown':
      return (
        `The artifact was not exported: the named node${node} is not a data node of this ` +
        'pipeline. Nothing was written, and the opened file is unchanged.'
      )
    case 'node-absent':
      return (
        `The artifact was not exported: the named node${node} did not execute in this run ` +
        '(the run stopped earlier). Nothing was written, and the opened file is unchanged.'
      )
    case 'node-not-materialized':
      return (
        `The artifact was not exported: the named node${node} produced no materialized ` +
        'output in this run (source and gate nodes are not dataset versions). ' +
        'Nothing was written, and the opened file is unchanged.'
      )
    case 'publish-materialization':
      return (
        `The artifact was not exported: the named node${node} declares publish-mode ` +
        'materialization — publish is never a DCR version reference. ' +
        'Nothing was written, and the opened file is unchanged.'
      )
    case 'unsupported-materialization':
      return (
        `The artifact was not exported: the named node${node} declares a materialization ` +
        'mode this surface cannot reference. Nothing was written, and the opened file is unchanged.'
      )
    case 'identity-invalid':
      return (
        'The artifact was not exported: a dataset id must be a non-empty name. ' +
        'Nothing was written, and the opened file is unchanged.'
      )
    case 'builder-refused':
      return (
        'The artifact was not exported: the derivation assembled an invalid artifact. ' +
        'Nothing was written, and the opened file is unchanged.'
      )
    case 'same-node':
      return (
        'The artifact was not exported: the base and the candidate must be different nodes. ' +
        'Nothing was written, and the opened file is unchanged.'
      )
  }
}
