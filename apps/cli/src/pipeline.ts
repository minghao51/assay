// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `assay pipeline validate <file>` / `assay pipeline run <file>` (p-4; p2-5
 * gates + materialization).
 *
 * The proven m5-4/m6-3 shape, reused: load the pipeline IR file through the
 * p-1 TOTAL parser (any malformed document degrades to located errors —
 * path/line/column — and exits 2, mirroring `validate`'s contract parse
 * path) → DAG-validate (`validatePipeline`) → compile the DATA subgraph
 * (`compilePipeline`; a data-node refusal is a validate failure, not a
 * crash) → statically resolve every gate binding (C2, no execution):
 *
 * - `validate` renders the human report or byte-stable JSON envelope and
 *   exits 0/1. It NEVER executes and NEVER resolves a source dataset — no
 *   file beyond the pipeline document and its authored contract references is
 *   opened on this path. The report lists the plan in topological order with
 *   each node's effective materialization, and a `gates` section with each
 *   validate/diff/publish node's binding resolution (would-this-run-pass-its-
 *   gates).
 * - `run` executes the pipeline through the p-4 runner bound to a
 *   `@duckdb/node-api` connection via `./node` (ADR 0041 — the SAME
 *   `executePipeline` the web client binds to its postMessage ops), supplying
 *   the parsed contracts and the explicit diff key set, then reports per-node
 *   outcomes (materialization + gate verdicts) and lists the terminal output
 *   relations. C2 discipline: every source dataset AND every validate
 *   contract is resolved BEFORE any execution, all resolution failures are
 *   collected, disclosed, and refused (exit 2) — nothing is guessed,
 *   inferred, or silently fallen back. A gate failure (validation-failed /
 *   publish-blocked) is a first-class RESULT (exit 1, the report on stdout);
 *   a materialization mode this surface cannot execute (export/publish) is a
 *   typed mode refusal (exit 1), never an internal error.
 *
 * Exit codes (pinned by integration tests, mirroring validate/diff):
 * - `0` — validate: the DAG validates, the data subgraph compiles, and every
 *         gate binding resolves (the run would start);
 *         run: every node executed (`completed`).
 * - `1` — validate: DAG/data-compile errors OR gate-binding failures (the
 *         report IS the result); run: a DAG/compile refusal, a typed node
 *         failure (`PipelineRunError`), a gate failure (`gated`), or a
 *         materialization-mode refusal (`refused`) — all RESULTS, not crashes.
 * - `2` — malformed input: IR parse errors, an unreadable pipeline file, or
 *         bad usage; on `run` only, unresolvable source datasets or validate
 *         contracts (disclosed and refused before any execution). The
 *         `validate` path never resolves sources, and an unbound gate there is
 *         a report row — exit 1, never 2.
 *
 * Privacy (ADR 0025): stderr carries authored, fixed messages — parse errors
 * quote the PIPELINE DOCUMENT's own structure (authored input, line/column),
 * source/contract resolution failures echo the pipeline's own authored path
 * references — and every pipeline-derived fragment is sanitized
 * (`sanitizePipelineText`) at this boundary. Raw engine error text and
 * dataset values never reach stderr.
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { parseContract, describeContractError } from '@assay/contracts'
import { compilePipeline, isDataNode, parsePipeline, validatePipeline } from '@assay/pipeline'
import type { PipelineError, PipelineV1 } from '@assay/pipeline'
import type {
  EngineFileFormat,
  PipelineRunContractBinding,
  PipelineRunSource,
  PipelineRunSourceFile,
} from '@assay/engine-duckdb/node'
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
  sanitizePipelineText,
} from './report-pipeline.js'
import type {
  PipelineContractStatus,
  PipelineGateVisibilityRow,
  PipelineValidateReport,
} from './report-pipeline.js'

/** The two-level subcommand: `assay pipeline <validate|run> <file>`. */
export type PipelineSubcommand = 'validate' | 'run'

/** Parsed + validated options for the pipeline command. */
export interface PipelineOptions {
  readonly subcommand: PipelineSubcommand
  readonly pipelinePath: string
  readonly format: 'human' | 'json'
  /**
   * The explicit diff key set (C2): supplied with `--key` (repeatable) and
   * applied to EVERY `diff` node in the pipeline (the IR carries no keys).
   * Empty means no diff key binding — a pipeline with a diff node then refuses
   * at resolution, never infers.
   */
  readonly keys: readonly string[]
}

/**
 * Parse + validate the command's options (exit 2 on anything malformed).
 * The two-level command resolves here, mirroring how the other commands
 * consume their positionals: `positionals[0]` is the subcommand,
 * `positionals[1]` the pipeline file. An unknown subcommand is the existing
 * usage-error path (exit 2, readable stderr). Cross-command flags are
 * rejected, never silently ignored (the m6-3 discipline); `--key` IS accepted
 * (the explicit C2 diff key set), while there is deliberately no
 * `--infer`-shaped flag on this surface (C2: never guess).
 */
export function resolvePipelineOptions(flags: {
  readonly contract?: string
  readonly keys?: readonly string[]
  readonly infer?: boolean
  readonly sampleLimit?: string
  readonly format?: string
  readonly positionals: readonly string[]
}): PipelineOptions {
  if (flags.contract !== undefined) {
    throw usageError(
      'pipeline does not take --contract (did you mean `assay validate`? see --help)',
    )
  }
  if (flags.infer === true) {
    throw usageError(
      'pipeline does not take --infer — a pipeline is executed exactly as authored (see --help)',
    )
  }
  if (flags.sampleLimit !== undefined) {
    throw usageError('pipeline does not take --sample-limit (see --help)')
  }
  const subcommand = flags.positionals[0]
  if (subcommand !== 'validate' && subcommand !== 'run') {
    throw usageError(
      subcommand === undefined
        ? 'pipeline requires a subcommand: validate or run (see --help)'
        : `unknown pipeline subcommand '${subcommand}' (expected validate or run; see --help)`,
    )
  }
  const pipelinePath = flags.positionals[1]
  if (pipelinePath === undefined) {
    throw usageError(`pipeline ${subcommand} requires a pipeline file path (see --help)`)
  }
  if (flags.positionals.length > 2) {
    throw usageError(
      `pipeline ${subcommand} takes exactly one pipeline file path (got ${String(flags.positionals.length - 1)})`,
    )
  }
  const format = flags.format ?? 'human'
  if (format !== 'human' && format !== 'json') {
    throw usageError(`--format must be 'human' or 'json' (got '${format}')`)
  }
  return { subcommand, pipelinePath, format, keys: flags.keys ?? [] }
}

/**
 * The data subgraph of a pipeline (everything EXCEPT the reserved gate node
 * classes): the p-2 compiler compiles source/transform/sql only, so the CLI
 * compiles exactly that subgraph and binds gates statically/runtime
 * separately. Data nodes never consume a gate (the DAG port rule), so the
 * subgraph is self-contained.
 */
function dataSubgraph(pipeline: PipelineV1): PipelineV1 {
  return {
    version: pipeline.version,
    pipeline: pipeline.pipeline,
    nodes: pipeline.nodes.filter((node) => isDataNode(node)),
  }
}

/** One validate node's static contract resolution. */
interface ResolvedContract {
  readonly status: PipelineContractStatus
  /** Localized, sanitized failure lines to disclose ([] when resolved). */
  readonly errorLines: readonly string[]
}

interface ContractResolution {
  readonly bindings: readonly PipelineRunContractBinding[]
  readonly byNode: ReadonlyMap<string, ResolvedContract>
  /** Flat, sanitized failure disclosure lines (collect-all, node order). */
  readonly failures: readonly string[]
}

/**
 * C2 contract resolution for `validate` nodes: the authored `contract`
 * reference resolves relative to the PIPELINE FILE's directory (absolute
 * paths pass through), is read, and is parsed with the m5-0 total parser.
 * Every failure — missing/unreadable file, parse errors — is COLLECTED in
 * node order and disclosed value-free, node-attributed; the caller decides
 * whether that is a report row (`validate`) or a refuse-before-execution
 * (`run`). Never guesses.
 */
function resolveValidateContracts(pipeline: PipelineV1, pipelinePath: string): ContractResolution {
  const baseDir = dirname(pipelinePath)
  const bindings: PipelineRunContractBinding[] = []
  const byNode = new Map<string, ResolvedContract>()
  const failures: string[] = []
  for (const node of pipeline.nodes) {
    if (node.type !== 'validate') continue
    const id = sanitizePipelineText(node.id)
    const authored = node.contract
    const resolved = isAbsolute(authored) ? authored : join(baseDir, authored)
    let text: string
    try {
      text = readFileSync(resolved, 'utf8')
    } catch {
      // Disclose both forms: the report envelope carries the authored
      // reference (it never carries machine paths, the p-4 discipline), while
      // the run stderr echoes the resolved path (the p-4 source-resolution
      // readability precedent).
      const authoredDetail = `${id}: contract file not found: ${sanitizePipelineText(authored)}`
      byNode.set(node.id, { status: 'missing', errorLines: [authoredDetail] })
      failures.push(`${id}: contract file not found: ${sanitizePipelineText(resolved)}`)
      continue
    }
    const parsed = parseContract(text)
    if (!parsed.ok) {
      const lines = parsed.errors.map((error) => sanitizePipelineText(describeContractError(error)))
      const detail = `${id}: contract could not be parsed: ${sanitizePipelineText(authored)}`
      byNode.set(node.id, { status: 'unparseable', errorLines: [detail, ...lines] })
      failures.push(detail, ...lines)
      continue
    }
    bindings.push({ nodeId: node.id, contract: parsed.contract })
    byNode.set(node.id, { status: 'resolved', errorLines: [] })
  }
  return { bindings, byNode, failures }
}

/**
 * The static gate-visibility rows: every validate/diff/publish node, in node
 * order, with its binding resolution and the static `bound` verdict. No
 * execution: a validate node binds when its contract resolves, a diff node
 * when an explicit key set was supplied, a publish node when its `requires`
 * edges resolve (the DAG already guarantees reference resolution).
 */
function buildGateVisibility(
  pipeline: PipelineV1,
  byNode: ReadonlyMap<string, ResolvedContract>,
  keys: readonly string[],
): readonly PipelineGateVisibilityRow[] {
  const rows: PipelineGateVisibilityRow[] = []
  for (const node of pipeline.nodes) {
    if (node.type === 'validate') {
      const resolution = byNode.get(node.id)
      rows.push({
        nodeId: node.id,
        kind: 'validate',
        input: node.input,
        against: null,
        contract: node.contract,
        contractStatus: resolution?.status ?? null,
        requires: null,
        bound: resolution?.status === 'resolved',
      })
    } else if (node.type === 'diff') {
      rows.push({
        nodeId: node.id,
        kind: 'diff',
        input: node.input,
        against: node.against,
        contract: null,
        contractStatus: null,
        requires: null,
        bound: keys.length > 0,
      })
    } else if (node.type === 'publish') {
      rows.push({
        nodeId: node.id,
        kind: 'publish',
        input: node.input,
        against: null,
        contract: null,
        contractStatus: null,
        requires: [...(node.requires ?? [])],
        bound: true,
      })
    }
  }
  return rows
}

/** Render the validate report in the requested format. */
function renderValidate(
  report: PipelineValidateReport,
  options: PipelineOptions,
  context: CommandContext,
): void {
  context.out(
    options.format === 'json'
      ? renderJsonPipelineValidateReport(report)
      : renderHumanPipelineValidateReport(report, context.style),
  )
}

/**
 * Run the pipeline command. Resolves with the exit code (0/1); everything
 * that is exit code 2 throws `CliError` with authored stderr text.
 */
export async function runPipelineCommand(
  options: PipelineOptions,
  context: CommandContext,
): Promise<CliExitCode> {
  const text = readPipelineText(options.pipelinePath)
  const parsed = parsePipeline(text)
  if (!parsed.ok) {
    throw parseError(parsed.errors)
  }
  const pipeline = parsed.pipeline

  // The shared static analysis: DAG validation, the data-subgraph compile,
  // and C2 gate binding (never executing). A compile is attempted only when
  // the DAG validates (compilePipeline re-runs DAG validation, so its errors
  // would only duplicate the DAG's).
  const validation = validatePipeline(pipeline)
  const compile = validation.ok ? compilePipeline(dataSubgraph(pipeline)) : null
  const resolution = resolveValidateContracts(pipeline, options.pipelinePath)
  const gates = buildGateVisibility(pipeline, resolution.byNode, options.keys)
  // Gate-binding failures disclosed in the static report: contract resolution
  // failures (authored references — no machine paths in the envelope) plus a
  // diff node with no explicit key set (C2: never inferred). The stderr
  // refusal additionally uses the resolved contract paths (the p-4
  // source-resolution readability precedent).
  const missingDiffKeyLines = gates
    .filter((gate) => gate.kind === 'diff' && !gate.bound)
    .map(
      (gate) =>
        `${sanitizePipelineText(gate.nodeId)}: a diff node requires an explicit key set (--key <column>); keys are never inferred`,
    )
  const reportGateErrors = [
    ...pipeline.nodes
      .filter((node) => node.type === 'validate')
      .flatMap((node) => resolution.byNode.get(node.id)?.errorLines ?? []),
    ...missingDiffKeyLines,
  ]
  const gateBindingFailures = [...resolution.failures, ...missingDiffKeyLines]
  const validateReport = buildPipelineValidateReport({
    pipeline,
    validation,
    compile,
    gates,
    gateErrors: reportGateErrors,
  })

  // `validate` ends here: the report is the static, would-this-run view.
  if (options.subcommand === 'validate') {
    renderValidate(validateReport, options, context)
    return validateReport.valid ? 0 : 1
  }

  // Structural DAG/compile refusals report the validate surface (exit 1,
  // nothing executed) — the p-4 behavior.
  if (!validation.ok || compile === null || !compile.ok) {
    renderValidate(validateReport, options, context)
    return 1
  }

  // C2: every gate binding must resolve before any engine call. A missing or
  // unparseable contract, or a diff node without an explicit `--key` set, is
  // an input-resolution failure (exit 2) — collected, disclosed, refused.
  if (!gates.every((gate) => gate.bound)) {
    throw new CliError(
      2,
      [
        'pipeline gates could not be resolved (nothing was executed):',
        ...gateBindingFailures.map((failure) => `  ${failure}`),
      ].join('\n'),
    )
  }

  // p2-1 (c): the native engine seam loads lazily on the EXECUTE path only —
  // `assay pipeline validate` returns above and never boots or even loads
  // `@duckdb/node-api` (standalone and transitively via the CLI's node seam).
  const engine = await import('@assay/engine-duckdb/node')
  const { openConnection } = await import('./connection.js')
  const { createPipelineRunOps, createPipelineRunCompilers } = await import('./node-executor.js')

  // C2: resolve EVERY source node's dataset before any execution — collect
  // all failures, disclose them, refuse (exit 2). Never guess.
  const sources = resolveSources(pipeline, options.pipelinePath, engine.detectFileFormat)

  // The explicit diff key set (C2): one explicit set, applied to every diff
  // node (the IR carries no keys). Absent when the pipeline has no diff node.
  const diffKeys =
    options.keys.length === 0
      ? []
      : pipeline.nodes
          .filter((node) => node.type === 'diff')
          .map((node) => ({ nodeId: node.id, keys: [...options.keys] }))

  context.progress.step('running pipeline on the local engine')
  const conn = await openConnection()
  try {
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
      createPipelineRunOps(conn),
    )
    const report = buildPipelineRunReport({
      pipeline,
      order: validation.order,
      result,
      error: null,
    })
    context.progress.done()
    context.out(
      options.format === 'json'
        ? renderJsonPipelineRunReport(report)
        : renderHumanPipelineRunReport(report, context.style),
    )
    // `canceled` is unreachable from the one-shot CLI (no guard is ever
    // invalidated on this surface); it still counts as not-completed. A
    // `gated` run is a first-class result (exit 1, the report on stdout).
    return report.status === 'completed' ? 0 : 1
  } catch (error) {
    if (error instanceof engine.PipelineRunError) {
      // Typed, value-free, node-attributed: the report (stdout) IS the
      // result — the partial state and the failing node — and the exit is 1.
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
      // p2-5: a user-authored materialization-mode plan the local surface
      // cannot execute (the p2-4 runner refuses `export` when no export op is
      // bound, and `export-with-consumers` before any engine call). This is a
      // typed, value-free mode refusal — a RESULT on stdout with exit 1, never
      // an "internal error". Genuinely internal preconditions (the CLI
      // pre-checks them) keep the fixed internal-error posture.
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
    // The connection is per-run; a failed close cannot mask the outcome
    // (the instance dies with the process anyway).
    try {
      conn.closeSync()
    } catch {
      // best-effort
    }
  }
}

/**
 * The CLI-side source binding: the runner's `{name, getFile()}` shape plus
 * the resolved path the Node registration reads from. `getFile()` is
 * implemented honestly (a lazy read into a `File`) so the binding satisfies
 * the runner's source contract — the Node ops read `path` directly (the
 * m5-4 lazy-view registration), so the bytes are never hoisted in-process.
 */
export interface PipelineFileSource extends PipelineRunSourceFile {
  /** The resolved path (absolute), as the Node registration consumes it. */
  readonly path: string
}

/**
 * Resolve every `source` node's dataset on the Node side, relative to the
 * pipeline file's directory (absolute paths pass through — documented, no
 * magic). A non-`file` kind, a missing/non-string path, or an
 * missing/unreadable/unsupported dataset is COLLECTED and disclosed — all
 * failures at once, in node-id order — and refuses with exit 2 before any
 * execution (checkpoint C2: disclose and refuse, never guess or fall back).
 */
function resolveSources(
  pipeline: PipelineV1,
  pipelinePath: string,
  detectFileFormat: (name: string) => EngineFileFormat | null,
): readonly PipelineRunSource<PipelineFileSource>[] {
  const baseDir = dirname(pipelinePath)
  const failures: string[] = []
  const bindings: PipelineRunSource<PipelineFileSource>[] = []
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
    const source: PipelineFileSource = {
      name: basename(path),
      path,
      getFile: async () => new File([await readFile(path)], basename(path)),
    }
    bindings.push({ nodeId: node.id, source })
  }
  if (failures.length > 0) {
    throw new CliError(
      2,
      ['pipeline sources could not be resolved (nothing was executed):', ...failures].join('\n'),
    )
  }
  return bindings
}

/** Read the pipeline file (readable path error; mirrors the contract path). */
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
