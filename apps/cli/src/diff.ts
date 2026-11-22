// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `assay diff <a> <b>` (m6-3) — the CLI row-diff command.
 *
 * Pipeline (the m5-4 validate shape, reused): open both dataset files exactly
 * like the engine's `open` (same format policy, same DESCRIBE-shaped schema)
 * → profile both sides with the REUSED m2-5 profile SQL (browser-free through
 * the `./node` seam) → `diffDatasets` over the two schemas + profiles (schema
 * drift, then distribution deltas) → resolve the key set (explicit `--key`
 * columns, or the disclosed top candidate from C2 `inferRowDiffKeys`) →
 * compile the m6-1 DiffPlan → wire-harden it through the engine's own m6-2
 * gates → execute it byte-identically on a `@duckdb/node-api` connection
 * (side A = the base view — the CLI has no editing session; side B = the
 * registered comparison view) → render the report in the documented aspect
 * order: **schema drift → profile deltas → row diff** (docs-07's honesty
 * rule made visible).
 *
 * Exit codes (the m6-3 contract, pinned by integration tests):
 * - `0` — no differences found across the aspects that ran;
 * - `1` — differences were found (the report on stdout IS the result);
 * - `2` — usage, path, inference, or binding error (nothing was diffed).
 *
 * Checkpoint C2 (binding): `--infer` picks the top candidate from
 * `@assay/diff`'s `inferRowDiffKeys` and DISCLOSES it (chosen columns +
 * evidence + the verbatim disclosure strings) in BOTH forms; zero candidates
 * are an exit-2 binding error, never a silent fallback. Without `--infer` or
 * `--key`, the command is a usage error (exit 2).
 *
 * Privacy (ADR 0025): the report (stdout, human or JSON) is the product —
 * row-diff samples carry keys and changed-column NAMES, and the
 * schema-drift/profiling deltas carry **categorical dataset values**
 * (new/vanished category labels — audit AR-C1); dataset values on stdout
 * are legitimate product content. stderr carries authored, fixed messages
 * — binding errors name columns by their schema names, a missing path
 * echoes the caller's own typed path (the m5-4 readability rule), and raw
 * engine error text is never echoed.
 */
import { statSync } from 'node:fs'
import { compileRowDiffPlan, diffDatasets, inferRowDiffKeys } from '@assay/diff'
import type { KeyInferenceResult, RowDiffBindingError } from '@assay/diff'
import { describeRowDiffBindingError } from '@assay/diff'
import { bucketColumnCount, bucketRowCount, bucketSize } from '@assay/telemetry'
import { ROW_DIFF_SAMPLE_HARD_MAX } from '@assay/engine-duckdb/node'
import { DATASET_VIEW, countViewRows, openConnection, registerDatasetAs } from './connection.js'
import type { CommandContext } from './context.js'
import { CliError, usageError } from './errors.js'
import type { CliExitCode } from './errors.js'
import { diffOutcome, durationSince, formatKindFromEngineFormat } from './telemetry/emit.js'
import { prepareDiffPlan, profileView, runDiffPlan } from './node-executor.js'
import {
  buildDiffRowDiffReport,
  datasetDisplayName,
  describeIssueLine,
  diffReportIdentical,
  renderHumanDiffReport,
  renderJsonDiffReport,
} from './report.js'
import type { DiffCommandReport, DiffInferenceDisclosure, DiffReportMeta } from './report.js'
import { resolveSampleLimit } from './validate.js'

/**
 * The registered comparison view (side B). Side A is registered through
 * `registerDataset` under the validate view (`assay_t1`, the m5-4 constant);
 * B gets its own engine-generated name so the two never collide.
 */
const DIFF_COMPARISON_VIEW = 'assay_t2'

/**
 * The plan's binding relations. Fixed constants (part of the determinism
 * tuple): the executor materializes a view under each name, and neither may
 * collide with a registered view (the m6-2 gate rejects shadowing).
 */
const PLAN_RELATION_A = 'assay_cli_diff_a'
const PLAN_RELATION_B = 'assay_cli_diff_b'

/** Parsed + validated options for the diff command. */
export interface DiffOptions {
  readonly pathA: string
  readonly pathB: string
  /** Explicit key columns, in order; empty when `--infer` is set. */
  readonly keys: readonly string[]
  readonly infer: boolean
  readonly format: 'human' | 'json'
  readonly sampleLimit: number
}

/** Parse + validate the command's options (exit 2 on anything malformed). */
export function resolveDiffOptions(flags: {
  readonly keys: readonly string[]
  readonly infer: boolean
  readonly contract?: string
  readonly format?: string
  readonly sampleLimit?: string
  readonly positionals: readonly string[]
}): DiffOptions {
  if (flags.contract !== undefined) {
    throw usageError('diff does not take --contract (did you mean `assay validate`? see --help)')
  }
  const pathA = flags.positionals[0]
  if (pathA === undefined) {
    throw usageError('diff requires two dataset paths <a> <b> (see --help)')
  }
  const pathB = flags.positionals[1]
  if (pathB === undefined) {
    throw usageError('diff requires two dataset paths <a> <b> (see --help)')
  }
  if (flags.positionals.length > 2) {
    throw usageError(
      `diff takes exactly two dataset paths (got ${String(flags.positionals.length)})`,
    )
  }
  if (flags.keys.length === 0 && !flags.infer) {
    throw usageError('diff requires --key <column> (repeatable) or --infer (see --help)')
  }
  if (flags.keys.length > 0 && flags.infer) {
    throw usageError('--infer cannot be combined with --key (choose explicit keys or inference)')
  }
  const format = flags.format ?? 'human'
  if (format !== 'human' && format !== 'json') {
    throw usageError(`--format must be 'human' or 'json' (got '${format}')`)
  }
  return {
    pathA,
    pathB,
    keys: flags.keys,
    infer: flags.infer,
    format,
    sampleLimit: resolveSampleLimit(flags.sampleLimit),
  }
}

/**
 * Run the diff command. Resolves with the exit code (0/1); everything that
 * is exit code 2 throws `CliError` with authored stderr text.
 */
export async function runDiffCommand(
  options: DiffOptions,
  context: CommandContext,
): Promise<CliExitCode> {
  const startedAt = Date.now()
  context.progress.step('opening datasets')
  const conn = await openConnection()
  let report: DiffCommandReport
  let meta: DiffReportMeta
  let aOpened = false
  let bOpened = false
  try {
    const a = await registerSide(conn, options.pathA, DATASET_VIEW, 'side_a', context)
    await emitSideOpened(conn, context, 'side_a', a, options.pathA, DATASET_VIEW)
    aOpened = true
    const b = await registerSide(conn, options.pathB, DIFF_COMPARISON_VIEW, 'side_b', context)
    await emitSideOpened(conn, context, 'side_b', b, options.pathB, DIFF_COMPARISON_VIEW)
    bOpened = true
    context.progress.step('profiling side A')
    const profileA = await profileView(conn, DATASET_VIEW, a.schema)
    context.progress.step('profiling side B')
    const profileB = await profileView(conn, DIFF_COMPARISON_VIEW, b.schema)
    const diff = diffDatasets({
      schemaA: a.schema,
      schemaB: b.schema,
      profileA,
      profileB,
    })

    // Checkpoint C2: the key set is explicit or the disclosed inferred top
    // candidate — never a silent guess.
    let keys: readonly string[]
    let inference: DiffInferenceDisclosure | null = null
    if (options.infer) {
      const inferred = inferRowDiffKeys(profileA, profileB)
      const top = inferred.candidates[0]
      if (top === undefined) {
        throw inferenceError(inferred)
      }
      keys = top.columns
      inference = {
        columns: top.columns,
        candidateDisclosure: top.disclosure,
        outcomeDisclosure: inferred.disclosure,
        evidence: top.evidence,
      }
    } else {
      keys = options.keys
    }

    const compiled = compileRowDiffPlan(a.schema, b.schema, keys, {
      relationA: PLAN_RELATION_A,
      relationB: PLAN_RELATION_B,
      sampleLimit: options.sampleLimit,
    })
    if (!compiled.ok) {
      throw bindingError(compiled.errors)
    }
    // The m6-2 two-belt wire gate: the CLI executes only plans the engine's
    // worker would accept, so every surface runs the same plans.
    context.progress.step('executing row diff')
    const plan = prepareDiffPlan(compiled.plan, [DATASET_VIEW, DIFF_COMPARISON_VIEW])
    const result = await runDiffPlan(
      conn,
      plan,
      a.schema,
      DIFF_COMPARISON_VIEW,
      // Side A is the CLI's registered dataset view; passed explicitly because
      // `runDiffPlan` has no default base view (B4).
      DATASET_VIEW,
    )
    const rowDiff = buildDiffRowDiffReport(result, plan.sharedColumns.length > 0)
    report = { diff, rowDiff }
    meta = {
      nameA: datasetDisplayName(options.pathA),
      nameB: datasetDisplayName(options.pathB),
      formatA: a.format,
      formatB: b.format,
      keys,
      keySource: options.infer ? 'inferred' : 'explicit',
      inference,
      sampleLimitRequested: options.sampleLimit,
      sampleLimitEffective: Math.min(options.sampleLimit, ROW_DIFF_SAMPLE_HARD_MAX),
    }
  } catch (error) {
    // `diff_run` (design §2): once BOTH datasets are registered the run has a
    // finish, so a binding/plan/engine failure emits with outcome `error`.
    // `aborted` is genuinely unreachable from the CLI (no abort UX) and is
    // never invented; a registration failure emits `dataset_open_failed` only
    // (the run never started). There is no verdict, so the counts are the
    // honest zero state.
    if (aOpened && bOpened) {
      context.telemetry?.emit(
        'diff_run',
        {
          aspects_count: 0,
          key_mode: 'none',
          duration_bucket: durationSince(startedAt),
          outcome: 'error',
        },
        'error',
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

  context.progress.done()
  // `diff_run` (design §2/Appendix C): value-free buckets and the `key_mode`
  // enum only — never key column names (R4).
  context.telemetry?.emit('diff_run', {
    aspects_count: 3,
    key_mode: options.infer ? 'inferred' : 'explicit',
    duration_bucket: durationSince(startedAt),
    outcome: diffOutcome(diffReportIdentical(report)),
  })
  context.out(
    options.format === 'json'
      ? renderJsonDiffReport(report, meta)
      : renderHumanDiffReport(report, meta, context.style),
  )
  return diffReportIdentical(report) ? 0 : 1
}

/**
 * Emit `dataset_opened` for a registered side with a best-effort real row
 * count. Telemetry is best-effort: a failed count (or an inactive runtime)
 * emits nothing rather than break the command (R9).
 */
async function emitSideOpened(
  conn: Awaited<ReturnType<typeof openConnection>>,
  context: CommandContext,
  role: 'side_a' | 'side_b',
  dataset: Awaited<ReturnType<typeof registerDatasetAs>>,
  path: string,
  viewName: string,
): Promise<void> {
  if (context.telemetry?.active !== true) return
  let rowCount: number
  try {
    rowCount = await countViewRows(conn, viewName)
  } catch {
    return
  }
  context.telemetry.emit('dataset_opened', {
    dataset_role: role,
    format_kind: formatKindFromEngineFormat(dataset.format),
    size_bucket: fileSizeBucket(path),
    row_count_bucket: bucketRowCount(rowCount),
    column_count_bucket: bucketColumnCount(dataset.schema.length),
  })
}

/** Register one diff side, emitting `dataset_open_failed` on a typed failure. */
async function registerSide(
  conn: Awaited<ReturnType<typeof openConnection>>,
  path: string,
  viewName: string,
  role: 'side_a' | 'side_b',
  context: CommandContext,
): Promise<Awaited<ReturnType<typeof registerDatasetAs>>> {
  try {
    return await registerDatasetAs(conn, path, viewName)
  } catch (error) {
    context.telemetry?.emit('dataset_open_failed', {
      dataset_role: role,
      format_kind: 'unknown',
      reason_code: context.telemetry?.reasonFromError(error) ?? 'unknown',
    })
    throw error
  }
}

/** Size bucket for a path; an unreadable size degrades to `empty`. */
function fileSizeBucket(path: string): ReturnType<typeof bucketSize> {
  try {
    return bucketSize(statSync(path).size)
  } catch {
    return 'empty'
  }
}

/** All binding errors, one readable line each (the m6-1 canonical form). */
function bindingError(errors: readonly RowDiffBindingError[]): CliError {
  const lines = errors.map((error) => `error: ${describeRowDiffBindingError(error)}`)
  return new CliError(
    2,
    ['the row diff does not bind against the two datasets:', ...lines].join('\n'),
  )
}

/**
 * The zero-candidate inference outcome (checkpoint C2): the pure package's
 * verbatim disclosure plus any collected issues, never a silent fallback.
 */
function inferenceError(inferred: KeyInferenceResult): CliError {
  const lines = ['no usable row-diff key could be inferred:', `  ${inferred.disclosure}`]
  for (const issue of inferred.issues) {
    lines.push(`  ${describeIssueLine(issue)}`)
  }
  return new CliError(2, lines.join('\n'))
}
