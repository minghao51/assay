// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `assay dcr <file>` — the DCR artifact entry point (p3-3; ADR 0046 ruling
 * D17-Q5, CLI-first). One command, one builder:
 *
 *   resolve flags → parse + validate the pipeline IR → bind gates (C2) →
 *   resolve sources (C2) → execute the pipeline on the local engine →
 *   derive the base + candidate DatasetVersion references off the run (the
 *   p3-2 surface, ONE function for BOTH sides) → verify the materialization
 *   references resolve (D19-OQ-5 export-time liveness) → `buildDcrArtifact`
 *   (the p3-1 builder — the only construction path) → write a NEW file.
 *
 * Exit codes (the pipeline.ts discipline, mirrored exactly):
 * - `0` — the artifact was written off a completed run.
 * - `1` — result-class outcomes: a gated run whose artifact WAS written (the
 *         report on stdout discloses the gating — a gated run is the core DCR
 *         use case, never an error), or a run that failed/was
 *         refused/canceled and produced NO artifact, or the D19-OQ-5
 *         dangling-materialization refusal.
 * - `2` — malformed input (IR parse errors, unreadable file, bad usage,
 *         unresolvable sources/contracts/gate bindings — disclosed and
 *         refused before any execution), a reference derivation that does not
 *         match the run (unknown node, a source/gate node, publish mode, a
 *         node the run never reached, an unusable identity), a builder
 *         refusal, or an EXISTING output path (ADR 0012: a DCR artifact is
 *         never rewritten — the refusal fires before any run and again at
 *         the exclusive write).
 *
 * Honest no-verdict (the p2-5 carry-over): only verdicts the run actually
 * executed travel into the artifact (`validation` is absent when none
 * existed); the report says `none carried` — nothing is fabricated. Deltas:
 * schema drift is computed from the two materialized relations' schemas via
 * `@assay/diff`'s own classifier (value-free — names and types are schema);
 * distribution deltas and sampled row diffs are NOT computed on this surface
 * (the runner's gate verdicts carry counts, not sampled M6 payloads), so
 * those sections stay honestly absent.
 *
 * Privacy (ADR 0025): the artifact is value-free by construction (the p3-1
 * builder pins); the report carries dataset ids, node ids, version ids, and
 * counts only — schema, never values; stderr is authored fixed text; the
 * output path appears only in messages for the path the user themselves
 * typed.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { lstat, open, readFile, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { schemaDrift } from '@assay/diff'
import type { SchemaDriftFinding } from '@assay/diff'
import type { EngineSchema } from '@assay/validation'
import {
  buildDcrArtifact,
  describeDcrError,
  isDataNode,
  parsePipeline,
  sanitizePipelineText,
  serializeDcr,
  validatePipeline,
  compilePipeline,
} from '@assay/pipeline'
import type { DcrArtifactV1, DcrVersionRef, PipelineError, PipelineV1 } from '@assay/pipeline'
import type {
  EngineFileFormat,
  PipelineRunColumn,
  PipelineRunResult,
  PipelineRunSource,
  PipelineRunSourceFile,
} from '@assay/engine-duckdb/node'
import { candidateVersionRefFromRun, PipelineRunRefusalError } from '@assay/engine-duckdb/node'
import type { CommandContext } from './context.js'
import { CliError, usageError } from './errors.js'
import type { CliExitCode } from './errors.js'
import {
  buildPipelineRunReport,
  buildPipelineValidateReport,
  describePipelineErrorLine,
  renderHumanPipelineRunReport,
  renderHumanPipelineValidateReport,
  renderJsonPipelineRunReport,
  renderJsonPipelineValidateReport,
} from './report-pipeline.js'
import { resolveValidateContracts } from './pipeline.js'
import { renderHumanDcrExportReport, renderJsonDcrExportReport } from './report-dcr.js'
import type { DcrExportReport, DcrNoArtifactReason } from './report-dcr.js'

/** Options for the p3-3 `assay dcr` command (all resolved, exit 2 on misuse). */
export interface DcrOptions {
  readonly pipelinePath: string
  /** The artifact destination — a NEW file, never an overwrite (ADR 0012). */
  readonly outPath: string
  readonly baseNodeId: string
  readonly baseDatasetId: string
  readonly baseVersionId?: string
  readonly candidateNodeId: string
  readonly candidateDatasetId: string
  readonly candidateVersionId?: string
  readonly format: 'human' | 'json'
  /** The explicit diff key set (C2), applied to every diff node (the pipeline run rule). */
  readonly keys: readonly string[]
}

/**
 * Parse + validate the command's options (exit 2 on anything malformed).
 * Mirrors `resolvePipelineOptions`: cross-command flags are rejected, never
 * silently ignored; the pipeline file is the single positional.
 */
export function resolveDcrOptions(flags: {
  readonly contract?: string
  readonly keys?: readonly string[]
  readonly infer?: boolean
  readonly sampleLimit?: string
  readonly format?: string
  readonly out?: string
  readonly baseNode?: string
  readonly baseDatasetId?: string
  readonly baseVersionId?: string
  readonly candidateNode?: string
  readonly candidateDatasetId?: string
  readonly candidateVersionId?: string
  readonly positionals: readonly string[]
}): DcrOptions {
  if (flags.contract !== undefined) {
    throw usageError(
      'dcr does not take --contract (validate-node contracts resolve from the pipeline file; see --help)',
    )
  }
  if (flags.infer === true) {
    throw usageError('dcr does not take --infer (see --help)')
  }
  if (flags.sampleLimit !== undefined) {
    throw usageError('dcr does not take --sample-limit (see --help)')
  }
  const pipelinePath = flags.positionals[0]
  if (pipelinePath === undefined) {
    throw usageError('dcr requires a pipeline file path (see --help)')
  }
  if (flags.positionals.length > 1) {
    throw usageError(
      `dcr takes exactly one pipeline file path (got ${String(flags.positionals.length - 1)})`,
    )
  }
  if (flags.out === undefined) {
    throw usageError(
      'dcr requires --out <path> — the artifact destination, a NEW file (an existing path is never overwritten; see --help)',
    )
  }
  if (flags.baseNode === undefined) {
    throw usageError(
      'dcr requires --base-node <id> — the data node whose output is the base version (see --help)',
    )
  }
  if (flags.baseDatasetId === undefined) {
    throw usageError(
      "dcr requires --base-dataset-id <id> — the base version's logical dataset id (see --help)",
    )
  }
  if (flags.candidateNode === undefined) {
    throw usageError(
      'dcr requires --candidate-node <id> — the data node whose output is the candidate version (see --help)',
    )
  }
  if (flags.candidateDatasetId === undefined) {
    throw usageError(
      "dcr requires --candidate-dataset-id <id> — the candidate version's logical dataset id (see --help)",
    )
  }
  if (flags.baseNode === flags.candidateNode) {
    throw usageError(
      `--base-node and --candidate-node must be different nodes (got '${sanitizePipelineText(flags.baseNode)}' for both)`,
    )
  }
  const format = flags.format ?? 'human'
  if (format !== 'human' && format !== 'json') {
    throw usageError(`--format must be 'human' or 'json' (got '${format}')`)
  }
  return {
    pipelinePath,
    outPath: flags.out,
    baseNodeId: flags.baseNode,
    baseDatasetId: flags.baseDatasetId,
    ...(flags.baseVersionId === undefined ? {} : { baseVersionId: flags.baseVersionId }),
    candidateNodeId: flags.candidateNode,
    candidateDatasetId: flags.candidateDatasetId,
    ...(flags.candidateVersionId === undefined
      ? {}
      : { candidateVersionId: flags.candidateVersionId }),
    format,
    keys: flags.keys ?? [],
  }
}

/** The data subgraph of a pipeline (the p2 compiler compiles source/transform/sql only). */
function dataSubgraph(pipeline: PipelineV1): PipelineV1 {
  return {
    version: pipeline.version,
    pipeline: pipeline.pipeline,
    nodes: pipeline.nodes.filter((node) => isDataNode(node)),
  }
}

/** Read the pipeline file (readable path error; mirrors the pipeline command). */
function readPipelineText(pipelinePath: string): string {
  try {
    return readFileSync(pipelinePath, 'utf8')
  } catch {
    throw usageError(`pipeline file not readable: ${pipelinePath}`)
  }
}

/** All IR parse errors, one sanitized located line each (the p-1 form). */
function parseError(errors: readonly PipelineError[]): CliError {
  const lines = errors.map((error) => `error: ${describePipelineErrorLine(error)}`)
  return new CliError(2, ['pipeline could not be parsed:', ...lines].join('\n'))
}

/**
 * The ADR 0012 new-file discipline, enforced twice: this pre-flight fires
 * BEFORE the pipeline runs (a doomed export never executes anything), and
 * the write itself uses an exclusive create so a path that appears mid-run
 * still refuses. The message names the rule, not just the fact.
 */
function refuseExistingOut(outPath: string): CliError {
  return usageError(
    `dcr output already exists — a DCR artifact is never overwritten (ADR 0012); choose a new --out path: ${outPath}`,
  )
}

/**
 * The exclusive write (ADR 0012). `wx` creates the file only if it does not
 * exist — the race-proof half of the ADR 0012 pin (the pre-flight check alone
 * would still lose a path created between check and write). The artifact is
 * written as UTF-8 in full, then the handle is closed, and the exact number of
 * bytes written is returned.
 *
 * FAILED-WRITE RESIDUE (B05), the bounded contract — deliberately NOT
 * all-or-nothing publication: if the write or the close fails, the acquired
 * handle is closed and cleanup is attempted ONLY with verified ownership.
 *
 * "Verified ownership" is a BEST-EFFORT identity match: the writer records the
 * dev/ino/nlink of the handle it created, re-reads the path with `lstat` and
 * unlinks only on an exact match. The check and the unlink are two syscalls,
 * so a replacement that appears between them can still be removed — this is
 * the same non-atomic check-then-unlink race as the desktop writer (B04) and
 * is NOT advertised as universal replacement safety. Eliminating that race
 * needs a platform-specific atomic design, not another check.
 *
 * When the identity cannot be established (stat failed) or no longer matches,
 * the residue is LEFT IN PLACE and the authored failure says the requested new
 * artifact may be incomplete — it never claims nothing was written. The
 * primary failure is preserved: cleanup can only add the honest suffix, never
 * replace the exit code or the authored message. Temporary-file/rename
 * publishing is not used (replacement/no-replace semantics differ by platform).
 */
export async function writeDcrArtifactNew(
  outPath: string,
  text: string,
): Promise<{ ok: true; bytes: number } | { ok: false; reason: 'path-exists' }> {
  // Fast refusal before the exclusive open: the common case (an existing --out)
  // never opens anything. `wx` below remains the authoritative guard.
  if (existsSync(outPath)) return { ok: false, reason: 'path-exists' }
  return writeNewArtifact(nodeFs, outPath, text)
}

/** The identity facts the residue cleanup relies on (`fs.Stats` satisfies it). */
export interface DcrWriteStat {
  readonly dev: number
  readonly ino: number
  readonly nlink: number
  isFile(): boolean
}

/**
 * The narrow filesystem surface of the exclusive write. Injectable ONLY so the
 * write/close/cleanup failure paths can be fault-injected (B05 acceptance);
 * the command goes through `writeDcrArtifactNew` and the real `node:fs`.
 */
export interface DcrWriteFs {
  readonly open: (path: string, flags: string, mode: number) => Promise<FileHandle>
  readonly stat: (handle: FileHandle) => Promise<DcrWriteStat>
  readonly write: (
    handle: FileHandle,
    bytes: Uint8Array,
    offset: number,
    length: number,
  ) => Promise<{ readonly bytesWritten: number }>
  readonly close: (handle: FileHandle) => Promise<void>
  readonly lstat: (path: string) => Promise<DcrWriteStat>
  readonly unlink: (path: string) => Promise<void>
}

/** The real `node:fs` implementation of the write surface. */
const nodeFs: DcrWriteFs = {
  open: (path, flags, mode) => open(path, flags, mode),
  stat: (handle) => handle.stat(),
  write: (handle, bytes, offset, length) => handle.write(bytes, offset, length, null),
  close: (handle) => handle.close(),
  lstat: (path) => lstat(path),
  unlink: (path) => unlink(path),
}

/**
 * Internal test seam (B05): the exclusive write over an injected fs surface.
 * Not a command surface — `writeDcrArtifactNew` is the only production entry.
 */
export function writeDcrArtifactNewWithFs(
  fs: DcrWriteFs,
  outPath: string,
  text: string,
): Promise<{ ok: true; bytes: number } | { ok: false; reason: 'path-exists' }> {
  return writeNewArtifact(fs, outPath, text)
}

async function writeNewArtifact(
  fs: DcrWriteFs,
  outPath: string,
  text: string,
): Promise<{ ok: true; bytes: number } | { ok: false; reason: 'path-exists' }> {
  const bytes = new TextEncoder().encode(text)
  let handle: FileHandle
  try {
    // `0o666` is the historical `writeFile` default (the umask still applies):
    // B05 changes the failure handling, not the artifact's permissions.
    handle = await fs.open(outPath, 'wx', 0o666)
  } catch (error) {
    // A path that appeared between the pre-flight and the open is the same
    // refusal, not a write failure.
    if ((error as { readonly code?: unknown }).code === 'EEXIST') {
      return { ok: false, reason: 'path-exists' }
    }
    throw usageError(`dcr output could not be written: ${outPath}`)
  }
  // Best-effort ownership identity: unavailable metadata must not turn into an
  // unverified unlink later, so it only disables cleanup.
  let owned: { readonly dev: number; readonly ino: number } | undefined
  try {
    const opened = await fs.stat(handle)
    if (opened.isFile() && opened.nlink === 1) owned = { dev: opened.dev, ino: opened.ino }
  } catch {
    /* identity unverifiable: the residue stays */
  }
  let closeStarted = false
  const closeOnce = async (): Promise<void> => {
    if (closeStarted) return
    closeStarted = true
    await fs.close(handle)
  }
  let written = 0
  try {
    while (written < bytes.byteLength) {
      const result = await fs.write(handle, bytes, written, bytes.byteLength - written)
      if (result.bytesWritten <= 0) throw new Error('write-failed')
      written += result.bytesWritten
    }
    await closeOnce()
  } catch {
    await closeOnce().catch(() => undefined)
    const removed = await removeOwnedResidue(fs, outPath, owned)
    throw dcrWriteFailure(outPath, removed)
  }
  return { ok: true, bytes: written }
}

/**
 * The narrow cleanup routine: unlink ONLY the identity this write created.
 * Returns whether the residue was removed; every failure is swallowed (the
 * caller reports residue, never a cleanup error).
 */
async function removeOwnedResidue(
  fs: DcrWriteFs,
  outPath: string,
  owned: { readonly dev: number; readonly ino: number } | undefined,
): Promise<boolean> {
  if (owned === undefined) return false
  try {
    const current = await fs.lstat(outPath)
    if (
      !current.isFile() ||
      current.dev !== owned.dev ||
      current.ino !== owned.ino ||
      current.nlink !== 1
    )
      return false
    await fs.unlink(outPath)
    return true
  } catch {
    return false
  }
}

/**
 * The authored write failure (exit 2). The primary category and path are
 * unchanged; the suffix states what happened to the partial file, and the
 * honest default is that an incomplete artifact may remain.
 */
function dcrWriteFailure(outPath: string, residueRemoved: boolean): CliError {
  return usageError(
    residueRemoved
      ? `dcr output could not be written: ${outPath} (the incomplete new artifact was removed — no DCR artifact exists at that path)`
      : `dcr output could not be written: ${outPath} (the requested new artifact may be incomplete: an interrupted write can leave partial bytes at that path — inspect or remove it)`,
  )
}

/**
 * The export-time liveness refusal and the derivation outcome — plain data,
 * total (never a throw), mirroring the p3-1 builder/parse discipline. The
 * command maps these to exit classes: `run-state` refusals are result-class
 * (exit 1, report on stdout); `usage` refusals are authored stderr (exit 2).
 */
export type DcrDerivationResult =
  | {
      readonly ok: true
      readonly artifact: DcrArtifactV1
      readonly base: DcrVersionRef
      readonly candidate: DcrVersionRef
      readonly schemaDriftFindings: number
      readonly validationVerdicts: number
      readonly validationValid: boolean | null
    }
  | { readonly ok: false; readonly kind: 'usage'; readonly message: string }
  | {
      readonly ok: false
      readonly kind: 'run-state'
      readonly reason: DcrNoArtifactReason
      readonly nodeId: string | null
    }

/** The derivation input: the executed run, its plan, and the two named sides. */
export interface DcrDerivationInput {
  readonly plan: PipelineV1
  readonly run: PipelineRunResult
  /**
   * Engine introspection of a session relation (the runner's `schemaOf` op).
   * BOTH the p3-2 reference derivation and the OQ-5 liveness verification
   * consume exactly this op — one source of session truth.
   */
  readonly schemaOf: (relation: string) => Promise<readonly PipelineRunColumn[]>
  readonly baseNodeId: string
  readonly baseDatasetId: string
  readonly baseVersionId?: string
  readonly candidateNodeId: string
  readonly candidateDatasetId: string
  readonly candidateVersionId?: string
}

/**
 * Map a p3-2 reference-derivation refusal to the CLI's exit classes: run
 * state and session liveness are result-class; everything else (a named node
 * that does not qualify) is a usage error naming the typed reason.
 */
function mapRefusal(
  error: PipelineRunRefusalError,
  side: 'base' | 'candidate',
): DcrDerivationResult {
  const flag = side === 'base' ? '--base-node' : '--candidate-node'
  const nodeId = error.nodeId === null ? '' : sanitizePipelineText(error.nodeId)
  switch (error.reason) {
    case 'candidate-run-canceled':
      return { ok: false, kind: 'run-state', reason: 'run-canceled', nodeId: error.nodeId }
    case 'candidate-schema-unavailable':
      // D19-OQ-5: the materialization reference does not resolve in the run
      // session — the export-time liveness refusal, loud and typed.
      return {
        ok: false,
        kind: 'run-state',
        reason: 'dangling-materialization',
        nodeId: error.nodeId,
      }
    case 'candidate-node-unknown':
      return {
        ok: false,
        kind: 'usage',
        message: `${flag} names '${nodeId}', which is not a data node of this pipeline`,
      }
    case 'candidate-node-absent':
      return {
        ok: false,
        kind: 'usage',
        message: `${flag} names '${nodeId}', which did not execute in this run (the run stopped earlier) — name a node the run executed`,
      }
    case 'candidate-not-materialized':
      return {
        ok: false,
        kind: 'usage',
        message: `${flag} names '${nodeId}', which produced no materialized output in this run (source and gate nodes are not dataset versions)`,
      }
    case 'publish-materialization':
      return {
        ok: false,
        kind: 'usage',
        message: `${flag} names '${nodeId}', which declares publish-mode materialization — publish is never a DCR version reference (the P3/DCR boundary, ADR 0033/0035)`,
      }
    case 'unsupported-materialization':
      return {
        ok: false,
        kind: 'usage',
        message: `${flag} names '${nodeId}', which declares a materialization mode this surface cannot reference`,
      }
    default:
      return {
        ok: false,
        kind: 'usage',
        message: `the ${side} reference for node '${nodeId}' was refused (${error.reason}): ${sanitizePipelineText(error.message)}`,
      }
  }
}

async function deriveSide(
  input: DcrDerivationInput,
  side: 'base' | 'candidate',
): Promise<DcrVersionRef | DcrDerivationResult> {
  try {
    return await candidateVersionRefFromRun({
      run: input.run,
      plan: input.plan,
      nodeId: side === 'base' ? input.baseNodeId : input.candidateNodeId,
      datasetId: side === 'base' ? input.baseDatasetId : input.candidateDatasetId,
      ...(side === 'base'
        ? input.baseVersionId === undefined
          ? {}
          : { versionId: input.baseVersionId }
        : input.candidateVersionId === undefined
          ? {}
          : { versionId: input.candidateVersionId }),
      schemaOf: input.schemaOf,
    })
  } catch (error) {
    if (error instanceof PipelineRunRefusalError) return mapRefusal(error, side)
    throw error
  }
}

/**
 * The materialization references must RESOLVE at export time (D19-OQ-5):
 * every `{ node }` reference is re-introspected through the same `schemaOf`
 * op the derivation used, and the resolved schema is returned for the drift
 * computation (one introspection path — no window where the reference could
 * dangle between the liveness check and the payload). An `{ export }`
 * reference cannot occur on this surface (the Node ops bind no export op, so
 * export-mode nodes are refused before any relation exists) and is refused
 * loudly rather than passed.
 */
/** The liveness outcome: the resolved schema, or why the reference dangles. */
type LivenessResult =
  | { readonly ok: true; readonly schema: readonly PipelineRunColumn[] }
  | {
      readonly ok: false
      readonly nodeId: string | null
    }

async function verifyMaterializationLive(
  ref: DcrVersionRef,
  run: PipelineRunResult,
  schemaOf: DcrDerivationInput['schemaOf'],
): Promise<LivenessResult> {
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

/** The one dangling-reference refusal spelling (D19-OQ-5). */
function danglingRefusal(nodeId: string | null): DcrDerivationResult {
  return { ok: false, kind: 'run-state', reason: 'dangling-materialization', nodeId }
}

/** The validate verdicts the run actually executed, in execution order. */
function executedValidationVerdicts(run: PipelineRunResult): {
  verdicts: number
  valid: boolean | null
} {
  let count = 0
  let valid: boolean | null = null
  for (const node of run.nodes) {
    const gate = node.gate
    if (gate === undefined || gate.class !== 'validate') continue
    count += 1
    valid = valid === null ? gate.valid : valid && gate.valid
  }
  return { verdicts: count, valid }
}

/**
 * Derive the DCR artifact off the executed run — the ONE construction path
 * (both sides through the p3-2 function, the payload through the p3-1
 * builder). Total: refusals are typed data, never throws.
 */
export async function deriveDcrArtifact(input: DcrDerivationInput): Promise<DcrDerivationResult> {
  if (input.run.status === 'canceled') {
    return { ok: false, kind: 'run-state', reason: 'run-canceled', nodeId: null }
  }
  const base = await deriveSide(input, 'base')
  if ('ok' in base) return base
  const candidate = await deriveSide(input, 'candidate')
  if ('ok' in candidate) return candidate

  // D19-OQ-5 export-time liveness: both materialization references must
  // resolve RIGHT NOW, in the run's own session, before anything is built
  // or written — and the resolved schemas feed the drift computation, so
  // there is no window where a reference could dangle past the check.
  const baseLive = await verifyMaterializationLive(base, input.run, input.schemaOf)
  if (!baseLive.ok) return danglingRefusal(baseLive.nodeId)
  const candidateLive = await verifyMaterializationLive(candidate, input.run, input.schemaOf)
  if (!candidateLive.ok) return danglingRefusal(candidateLive.nodeId)

  // Structural schema drift between the two materialized relations, via
  // @assay/diff's own classifier (consumed, never forked; value-free —
  // column names and engine type spellings are schema, never values).
  const driftFindings: readonly SchemaDriftFinding[] = schemaDrift(
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
      input: node.gate?.input ?? node.relation,
      valid: node.gate?.class === 'validate' ? node.gate.valid : false,
      violatedRules: node.gate?.class === 'validate' ? node.gate.violatedRules : 0,
      rowCount: node.rowCount,
    }))
  const validationRollup = executedValidationVerdicts(input.run)

  // P2-derived lineage: the input version (the reference side) and the
  // executed node list in execution order — the evidence snapshot of THIS
  // run (a gated run's list is the executed prefix; that is the honesty).
  const lineage = {
    inputVersionIds: [...new Set([base.versionId])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    nodes: input.run.nodes.map((node) => node.nodeId),
  }

  const built = buildDcrArtifact({
    base,
    candidate,
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
    const lines = built.errors.map((error) => describeDcrError(error))
    return {
      ok: false,
      kind: 'usage',
      message: ['dcr artifact could not be built:', ...lines.map((line) => `  ${line}`)].join('\n'),
    }
  }
  return {
    ok: true,
    artifact: built.artifact,
    base,
    candidate,
    schemaDriftFindings: driftFindings.length,
    validationVerdicts: validationRollup.verdicts,
    validationValid: validationRollup.valid,
  }
}

/**
 * The CLI-side source binding + resolution — the pipeline command's
 * discipline, reused verbatim in shape: resolve relative to the pipeline
 * file's directory, collect ALL failures, refuse with exit 2 before any
 * execution, never guess.
 */
interface DcrFileSource extends PipelineRunSourceFile {
  readonly path: string
}

function resolveSources(
  pipeline: PipelineV1,
  pipelinePath: string,
  detectFileFormat: (name: string) => EngineFileFormat | null,
): readonly PipelineRunSource<DcrFileSource>[] {
  const baseDir = dirname(pipelinePath)
  const failures: string[] = []
  const bindings: PipelineRunSource<DcrFileSource>[] = []
  for (const node of pipeline.nodes) {
    if (node.type !== 'source') continue
    const id = sanitizePipelineText(node.id)
    const config = node.source
    if (config.kind !== 'file') {
      failures.push(
        `  ${id}: unsupported source kind '${sanitizePipelineText(config.kind)}' — this command resolves file sources only`,
      )
      continue
    }
    const authored = config.path
    if (typeof authored !== 'string' || authored.length === 0) {
      failures.push(
        `  ${id}: the source's path is missing or not a string — a file source declares path: <relative or absolute path>`,
      )
      continue
    }
    const resolved = isAbsolute(authored) ? authored : join(baseDir, authored)
    if (!existsSync(resolved)) {
      failures.push(`  ${id}: dataset file not found: ${resolved}`)
      continue
    }
    if (!statSync(resolved).isFile()) {
      failures.push(`  ${id}: dataset path is not a file: ${resolved}`)
      continue
    }
    const format = detectFileFormat(basename(resolved))
    if (format === null) {
      failures.push(
        `  ${id}: unsupported dataset format '${basename(resolved)}' — supported: parquet, csv, jsonl, json`,
      )
      continue
    }
    const path = resolved
    bindings.push({
      nodeId: node.id,
      source: {
        name: basename(path),
        path,
        getFile: async () => new File([await readFile(path)], basename(path)),
      },
    })
  }
  if (failures.length > 0) {
    throw new CliError(
      2,
      ['dcr sources could not be resolved (nothing was executed):', ...failures].join('\n'),
    )
  }
  return bindings
}

/** Render the export report in the requested format. */
function renderExport(report: DcrExportReport, options: DcrOptions, context: CommandContext): void {
  context.out(
    options.format === 'json'
      ? renderJsonDcrExportReport(report)
      : renderHumanDcrExportReport(report, context.style),
  )
}

/**
 * Run the `assay dcr` command. Resolves with the exit code; exit-2 outcomes
 * throw `CliError` with authored stderr text (the CLI error taxonomy).
 */
export async function runDcrCommand(
  options: DcrOptions,
  context: CommandContext,
): Promise<CliExitCode> {
  // ADR 0012 pre-flight: an existing destination refuses BEFORE anything runs.
  if (existsSync(options.outPath)) {
    throw refuseExistingOut(options.outPath)
  }

  const text = readPipelineText(options.pipelinePath)
  const parsed = parsePipeline(text)
  if (!parsed.ok) {
    throw parseError(parsed.errors)
  }
  const pipeline = parsed.pipeline

  // The shared static analysis (the pipeline command's shape): DAG
  // validation + data-subgraph compile. Structural refusals report the
  // validate surface (exit 1, nothing executed).
  const validation = validatePipeline(pipeline)
  const compile = validation.ok ? compilePipeline(dataSubgraph(pipeline)) : null
  if (!validation.ok || compile === null || !compile.ok) {
    const validateReport = buildPipelineValidateReport({
      pipeline,
      validation,
      compile,
      gates: [],
      gateErrors: [],
    })
    context.out(
      options.format === 'json'
        ? renderJsonPipelineValidateReport(validateReport)
        : renderHumanPipelineValidateReport(validateReport, context.style),
    )
    return 1
  }

  // C2 gate binding: validate-node contracts resolve relative to the
  // pipeline file (the pipeline command's exact rule); a diff node without
  // an explicit --key set refuses before any execution.
  const resolution = resolveValidateContracts(pipeline, options.pipelinePath)
  const missingDiffKeyLines = pipeline.nodes
    .filter((node) => node.type === 'diff')
    .map(
      (node) =>
        `${sanitizePipelineText(node.id)}: a diff node requires an explicit key set (--key <column>); keys are never inferred`,
    )
  const gateBindingFailures = [...resolution.failures, ...missingDiffKeyLines]
  if (gateBindingFailures.length > 0) {
    throw new CliError(
      2,
      [
        'dcr gates could not be resolved (nothing was executed):',
        ...gateBindingFailures.map((failure) => `  ${failure}`),
      ].join('\n'),
    )
  }

  // p2-1 (c): the native engine seam loads lazily on the EXECUTE path only.
  const engine = await import('@assay/engine-duckdb/node')
  const { openConnection } = await import('./connection.js')
  const { createPipelineRunOps, createPipelineRunCompilers } = await import('./node-executor.js')

  const sources = resolveSources(pipeline, options.pipelinePath, engine.detectFileFormat)

  const diffKeys =
    options.keys.length === 0
      ? []
      : pipeline.nodes
          .filter((node) => node.type === 'diff')
          .map((node) => ({ nodeId: node.id, keys: [...options.keys] }))

  context.progress.step('running pipeline on the local engine')
  const conn = await openConnection()
  try {
    const ops = createPipelineRunOps(conn)
    const result = await engine.executePipeline(
      pipeline,
      {
        sources,
        contracts: resolution.bindings,
        diffKeys,
        compilers: createPipelineRunCompilers(),
        onNode: (nodeId) => {
          context.progress.step(`node ${sanitizePipelineText(nodeId)}`)
        },
      },
      ops,
    )

    // A failed or refused run is a first-class RESULT (exit 1, the run
    // report on stdout, no artifact) — the pipeline command's exact mapping.
    if (result.status === 'canceled') {
      context.progress.done()
      renderCanceled(options, pipeline, validation.order, context)
      return 1
    }
    context.progress.step('deriving the DCR sides from the executed run')
    const schemaOf = ops.schemaOf
    if (schemaOf === undefined) {
      throw usageError(
        'internal error: the run ops expose no schema introspection, so the materialization references cannot be verified',
      )
    }
    const derived = await deriveDcrArtifact({
      plan: pipeline,
      run: result,
      schemaOf,
      baseNodeId: options.baseNodeId,
      baseDatasetId: options.baseDatasetId,
      ...(options.baseVersionId === undefined ? {} : { baseVersionId: options.baseVersionId }),
      candidateNodeId: options.candidateNodeId,
      candidateDatasetId: options.candidateDatasetId,
      ...(options.candidateVersionId === undefined
        ? {}
        : { candidateVersionId: options.candidateVersionId }),
    })
    if (!derived.ok) {
      context.progress.done()
      if (derived.kind === 'usage') {
        throw usageError(derived.message)
      }
      // Run-state refusal: the report (stdout) IS the result — no artifact.
      const report = runStateRefusalReport(pipeline, result, derived)
      renderExport(report, options, context)
      return 1
    }

    context.progress.step('writing the artifact (a new file — never overwritten)')
    const serialized = serializeDcr(derived.artifact)
    const written = await writeDcrArtifactNew(options.outPath, serialized)
    if (!written.ok) {
      throw refuseExistingOut(options.outPath)
    }
    context.progress.done()
    const report: DcrExportReport = {
      pipeline: pipeline.pipeline,
      runStatus: result.status,
      gatedAt: result.status === 'gated' ? result.gatedAt : null,
      gate: result.status === 'gated' ? result.gate : null,
      refusal: null,
      base: {
        datasetId: derived.base.datasetId,
        versionId: derived.base.versionId,
        node: materializationNodeOf(derived.base),
      },
      candidate: {
        datasetId: derived.candidate.datasetId,
        versionId: derived.candidate.versionId,
        node: materializationNodeOf(derived.candidate),
      },
      schemaDriftFindings: derived.schemaDriftFindings,
      validationVerdicts: derived.validationVerdicts,
      validationValid: derived.validationValid,
      artifact: { file: basename(options.outPath), bytes: written.bytes },
    }
    renderExport(report, options, context)
    // A gated run is a first-class result (exit 1) even though its artifact
    // was written — the report on stdout discloses the gating; the artifact
    // carries exactly the evidence the run executed (the p2-5 honesty).
    return result.status === 'completed' ? 0 : 1
  } catch (error) {
    if (error instanceof engine.PipelineRunError) {
      context.progress.done()
      const report = buildPipelineRunReport({
        pipeline,
        order: validation.order,
        result: null,
        error,
      })
      context.out(
        options.format === 'json'
          ? renderJsonPipelineRunReport(report)
          : renderHumanPipelineRunReport(report, context.style),
      )
      return 1
    }
    if (error instanceof engine.PipelineRunRefusalError) {
      context.progress.done()
      const modeRefusal =
        error.reason === 'unsupported-materialization' || error.reason === 'export-with-consumers'
      if (!modeRefusal) {
        throw usageError(
          `internal error: the compiled plan was refused by the runner (${error.reason})`,
        )
      }
      const report = buildPipelineRunReport({
        pipeline,
        order: validation.order,
        result: null,
        error: null,
        refusal: { reason: error.reason, nodeId: error.nodeId },
      })
      context.out(
        options.format === 'json'
          ? renderJsonPipelineRunReport(report)
          : renderHumanPipelineRunReport(report, context.style),
      )
      return 1
    }
    throw error
  } finally {
    try {
      conn.closeSync()
    } catch {
      // best-effort (the instance dies with the process)
    }
  }
}

/** The report for a run-state refusal (nothing written; the report IS the result). */
function runStateRefusalReport(
  pipeline: PipelineV1,
  result: PipelineRunResult,
  refusal: Extract<DcrDerivationResult, { ok: false; kind: 'run-state' }>,
): DcrExportReport {
  const gated = result.status === 'gated'
  return {
    pipeline: pipeline.pipeline,
    runStatus: result.status,
    gatedAt: gated ? result.gatedAt : null,
    gate: gated ? result.gate : null,
    refusal: { reason: refusal.reason, nodeId: refusal.nodeId },
    base: null,
    candidate: null,
    schemaDriftFindings: null,
    validationVerdicts: null,
    validationValid: null,
    artifact: null,
  }
}

/** The canceled-run report (the run report surface, exit 1 — the p2-5 shape). */
function renderCanceled(
  options: DcrOptions,
  pipeline: PipelineV1,
  order: readonly string[],
  context: CommandContext,
): void {
  const report = buildPipelineRunReport({
    pipeline,
    order,
    result: { status: 'canceled', nodes: [], nextNodeId: null },
    error: null,
  })
  context.out(
    options.format === 'json'
      ? renderJsonPipelineRunReport(report)
      : renderHumanPipelineRunReport(report, context.style),
  )
}

/**
 * The node id a derived version's `{ node }` materialization names. The
 * export form cannot reach here: the OQ-5 liveness verification refuses it
 * before any report is built.
 */
function materializationNodeOf(ref: DcrVersionRef): string {
  return 'node' in ref.materialization ? ref.materialization.node : ''
}
