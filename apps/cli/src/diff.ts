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
 * Privacy (ADR 0025): the report (stdout, human or JSON) is the product and
 * carries row-diff sample keys and changed-column NAMES; dataset values
 * never appear there. stderr carries authored, fixed messages — binding
 * errors name columns by their schema names, a missing path echoes the
 * caller's own typed path (the m5-4 readability rule), and raw engine error
 * text is never echoed.
 */
import { compileRowDiffPlan, diffDatasets, inferRowDiffKeys } from '@assay/diff'
import type { KeyInferenceResult, RowDiffBindingError } from '@assay/diff'
import { describeRowDiffBindingError } from '@assay/diff'
import { ROW_DIFF_SAMPLE_HARD_MAX } from '@assay/engine-duckdb/node'
import { DATASET_VIEW, openConnection, registerDatasetAs } from './connection'
import { CliError, usageError } from './errors'
import type { CliExitCode } from './errors'
import { prepareDiffPlan, profileView, runDiffPlan } from './node-executor'
import {
  buildDiffRowDiffReport,
  columnDeltaDiffers,
  datasetDisplayName,
  describeIssueLine,
  renderHumanDiffReport,
  renderJsonDiffReport,
} from './report'
import type { DiffCommandReport, DiffInferenceDisclosure, DiffReportMeta } from './report'
import { resolveSampleLimit } from './validate'

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
  out: (text: string) => void,
): Promise<CliExitCode> {
  const conn = await openConnection()
  let report: DiffCommandReport
  let meta: DiffReportMeta
  try {
    const a = await registerDatasetAs(conn, options.pathA, DATASET_VIEW)
    const b = await registerDatasetAs(conn, options.pathB, DIFF_COMPARISON_VIEW)
    const profileA = await profileView(conn, DATASET_VIEW, a.schema)
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
    const plan = prepareDiffPlan(compiled.plan, [DATASET_VIEW, DIFF_COMPARISON_VIEW])
    const result = await runDiffPlan(conn, plan, a.schema, DIFF_COMPARISON_VIEW)
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
  } finally {
    // The connection is per-run; a failed close cannot mask the outcome
    // (the instance dies with the process anyway).
    try {
      conn.closeSync()
    } catch {
      // best-effort
    }
  }

  out(
    options.format === 'json'
      ? renderJsonDiffReport(report, meta)
      : renderHumanDiffReport(report, meta),
  )
  const identical =
    report.diff.schemaDrift.length === 0 &&
    !report.diff.columnDeltas.some(columnDeltaDiffers) &&
    report.rowDiff.added.count === 0 &&
    report.rowDiff.removed.count === 0 &&
    report.rowDiff.changed.count === 0
  return identical ? 0 : 1
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
