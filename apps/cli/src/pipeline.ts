// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `assay pipeline validate <file>` / `assay pipeline run <file>` (p-4).
 *
 * The proven m5-4/m6-3 shape, reused: load the pipeline IR file through the
 * p-1 TOTAL parser (any malformed document degrades to located errors —
 * path/line/column — and exits 2, mirroring `validate`'s contract parse
 * path) → DAG-validate (`validatePipeline`) → compile the plan
 * (`compilePipeline`; typed refusals are validate failures, not crashes) →
 *
 * - `validate` renders the human report or byte-stable JSON envelope and
 *   exits 0/1. It NEVER executes and NEVER resolves a source dataset — no
 *   file beyond the pipeline document itself is opened on this path.
 * - `run` executes the compiled plan through the p-3 runner bound to a
 *   `@duckdb/node-api` connection via `./node` (ADR 0041 — the SAME
 *   `executePipeline` the web client binds to its postMessage ops), then
 *   reports per-node outcomes and lists the terminal output relations with
 *   their row counts. C2 discipline: every source node's dataset is resolved
 *   BEFORE any execution, all resolution failures are collected, disclosed,
 *   and refused (exit 2) — nothing is guessed, inferred, or silently
 *   fallen back. Cancellation is not triggerable from a one-shot CLI (no
 *   abort surface exists on this process boundary); the report shape keeps
 *   the runner's `canceled` outcome representable anyway, honestly.
 *
 * Exit codes (pinned by integration tests, mirroring validate/diff):
 * - `0` — validate: the DAG validates and the plan compiles;
 *         run: every node materialized.
 * - `1` — validate: DAG errors or compile refusals (the report IS the
 *         result); run: a DAG/compile refusal, or a typed node failure
 *         (`PipelineRunError`) after the run began.
 * - `2` — malformed input: IR parse errors, an unreadable pipeline file,
 *         unresolvable source datasets (disclosed), or bad usage.
 *
 * Privacy (ADR 0025): stderr carries authored, fixed messages — parse errors
 * quote the PIPELINE DOCUMENT's own structure (authored input, line/column),
 * source resolution failures echo the pipeline's own authored path
 * references — and every pipeline-derived fragment is sanitized
 * (`sanitizePipelineText`) at this boundary. Raw engine error text and
 * dataset values never reach stderr.
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { compilePipeline, parsePipeline, validatePipeline } from '@assay/pipeline'
import type {
  PipelineCompileResult,
  PipelineError,
  PipelineV1,
  PipelineValidationResult,
} from '@assay/pipeline'
import type {
  EngineFileFormat,
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

/** The two-level subcommand: `assay pipeline <validate|run> <file>`. */
export type PipelineSubcommand = 'validate' | 'run'

/** Parsed + validated options for the pipeline command. */
export interface PipelineOptions {
  readonly subcommand: PipelineSubcommand
  readonly pipelinePath: string
  readonly format: 'human' | 'json'
}

/**
 * Parse + validate the command's options (exit 2 on anything malformed).
 * The two-level command resolves here, mirroring how the other commands
 * consume their positionals: `positionals[0]` is the subcommand,
 * `positionals[1]` the pipeline file. An unknown subcommand is the existing
 * usage-error path (exit 2, readable stderr). Cross-command flags are
 * rejected, never silently ignored (the m6-3 discipline); there is
 * deliberately no `--infer`-shaped flag on this surface (C2).
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
  if ((flags.keys?.length ?? 0) > 0) {
    throw usageError('pipeline does not take --key (did you mean `assay diff`? see --help)')
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
  return { subcommand, pipelinePath, format }
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

  // The shared validation gates: DAG validation, then compilation. A compile
  // is attempted only when the DAG validates (compilePipeline re-runs DAG
  // validation, so its errors would only duplicate the DAG's).
  const { validation, compile } = validateThenCompile(pipeline)
  if (!validation.ok || compile === null || !compile.ok) {
    const report = buildPipelineValidateReport({ pipeline, validation, compile })
    context.out(
      options.format === 'json'
        ? renderJsonPipelineValidateReport(report)
        : renderHumanPipelineValidateReport(report, context.style),
    )
    return 1
  }
  const plan = compile.plan

  // `validate` ends here: plan reported, nothing executed.
  if (options.subcommand === 'validate') {
    const report = buildPipelineValidateReport({ pipeline, validation, compile })
    context.out(
      options.format === 'json'
        ? renderJsonPipelineValidateReport(report)
        : renderHumanPipelineValidateReport(report, context.style),
    )
    return 0
  }

  // p2-1 (c): the native engine seam loads lazily on the EXECUTE path only —
  // `assay pipeline validate` returns above and never boots or even loads
  // `@duckdb/node-api` (standalone and transitively via the CLI's node seam).
  const engine = await import('@assay/engine-duckdb/node')
  const { openConnection } = await import('./connection.js')
  const { createPipelineRunOps } = await import('./node-executor.js')

  // C2: resolve EVERY source node's dataset before any execution — collect
  // all failures, disclose them, refuse (exit 2). Never guess.
  const sources = resolveSources(pipeline, options.pipelinePath, engine.detectFileFormat)

  context.progress.step('running pipeline on the local engine')
  const conn = await openConnection()
  try {
    const result = await engine.executePipeline(
      plan,
      {
        sources,
        onNode: (nodeId) => {
          context.progress.step(`node ${sanitizePipelineText(nodeId)}`)
        },
      },
      createPipelineRunOps(conn),
    )
    const report = buildPipelineRunReport({ pipeline, order: plan.order, result, error: null })
    context.progress.done()
    context.out(
      options.format === 'json'
        ? renderJsonPipelineRunReport(report)
        : renderHumanPipelineRunReport(report, context.style),
    )
    // `canceled` is unreachable from the one-shot CLI (no guard is ever
    // invalidated on this surface); it still counts as not-completed.
    return report.status === 'completed' ? 0 : 1
  } catch (error) {
    if (error instanceof engine.PipelineRunError) {
      // Typed, value-free, node-attributed: the report (stdout) IS the
      // result — the partial state and the failing node — and the exit is 1.
      const report = buildPipelineRunReport({ pipeline, order: plan.order, result: null, error })
      context.out(
        options.format === 'json'
          ? renderJsonPipelineRunReport(report)
          : renderHumanPipelineRunReport(report, context.style),
      )
      return 1
    }
    if (error instanceof engine.PipelineRunRefusalError) {
      // Unreachable for a compiler-produced plan that passed the gates above
      // (sources are pre-resolved; relations and SQL were already gated).
      // Reported as the fixed internal class, like the m5-4 wire-gate
      // posture — never with raw error text.
      throw usageError(
        `internal error: the compiled plan was refused by the runner (${error.reason})`,
      )
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

/** DAG-validate, then compile (or `null` when the DAG failed). */
function validateThenCompile(pipeline: PipelineV1): {
  readonly validation: PipelineValidationResult
  readonly compile: PipelineCompileResult | null
} {
  const validation = validatePipeline(pipeline)
  if (!validation.ok) return { validation, compile: null }
  return { validation, compile: compilePipeline(pipeline) }
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
