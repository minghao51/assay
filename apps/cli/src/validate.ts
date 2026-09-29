// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `assay validate <path> --contract <file>` (m5-4).
 *
 * Pipeline: open the dataset exactly like the engine's `open` (same format
 * support, same DESCRIBE-shaped schema) → read + parse the contract (m5-0
 * total parser; parse errors surface with line/column and exit 2) → compile
 * against the REAL schema (m5-1; binding errors are per-rule attributed on
 * stderr, exit 2) → wire-harden the plan (the engine's boundary gates) →
 * execute on a `@duckdb/node-api` connection through the engine-neutral
 * helpers (base view only — the raw file; there is no CLI editing session) →
 * render the severity-ordered report (human or byte-stable JSON).
 *
 * Exit codes: 0 valid, 1 violations, 2 usage/contract/path/execution error.
 *
 * Privacy (ADR 0025): dataset values appear ONLY as sample rows in the
 * stdout report (the product). stderr carries authored, fixed messages —
 * contract parse errors quote the CONTRACT's own structure (authored input,
 * line/column), path errors echo the user's own path; raw engine error text
 * and dataset values never reach stderr.
 */
import { readFileSync, statSync } from 'node:fs'
import { parseContract, describeContractError } from '@assay/contracts'
import type { ContractError } from '@assay/contracts'
import { compileContract, DEFAULT_SAMPLE_LIMIT, describeBindingError } from '@assay/validation'
import type { BindingError } from '@assay/validation'
import { bucketColumnCount, bucketFindingCount, bucketRowCount, bucketSize } from '@assay/telemetry'
import { VALIDATION_SAMPLE_HARD_MAX } from '@assay/engine-duckdb/node'
import { DATASET_VIEW, openConnection, PLAN_RELATION, registerDataset } from './connection.js'
import type { CommandContext } from './context.js'
import { CliError, usageError } from './errors.js'
import type { CliExitCode } from './errors.js'
import { durationSince, formatKindFromEngineFormat, validationOutcome } from './telemetry/emit.js'
import { preparePlan, runValidationPlan } from './node-executor.js'
import {
  buildValidationReport,
  datasetDisplayName,
  renderHumanReport,
  renderJsonReport,
} from './report.js'
import type { ReportMeta } from './report.js'
import type {
  EngineValidationPlan,
  EngineValidationResult,
  EngineFileFormat,
} from '@assay/engine-duckdb/node'

/** Parsed + validated options for the validate command. */
export interface ValidateOptions {
  readonly datasetPath: string
  readonly contractPath: string
  readonly format: 'human' | 'json'
  readonly sampleLimit: number
}

/** Resolve the compile-time K from `--sample-limit` (validated; default 20). */
export function resolveSampleLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_SAMPLE_LIMIT
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw usageError(`--sample-limit must be an integer of at least 1 (got '${raw}')`)
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) {
    throw usageError(`--sample-limit must be an integer of at least 1 (got '${raw}')`)
  }
  return value
}

/** Parse + validate the command's options (exit 2 on anything malformed). */
export function resolveValidateOptions(flags: {
  readonly contract?: string
  readonly format?: string
  readonly sampleLimit?: string
  /** Diff-only flags, parsed globally but rejected here (m6-3). */
  readonly keys?: readonly string[]
  readonly infer?: boolean
  readonly positionals: readonly string[]
}): ValidateOptions {
  if ((flags.keys?.length ?? 0) > 0) {
    throw usageError('validate does not take --key (did you mean `assay diff`? see --help)')
  }
  if (flags.infer === true) {
    throw usageError('validate does not take --infer (did you mean `assay diff`? see --help)')
  }
  const datasetPath = flags.positionals[0]
  if (datasetPath === undefined) {
    throw usageError('validate requires a dataset path (see --help)')
  }
  if (flags.positionals.length > 1) {
    throw usageError(
      `validate takes exactly one dataset path (got ${String(flags.positionals.length)})`,
    )
  }
  const contractPath = flags.contract
  if (contractPath === undefined) {
    throw usageError('validate requires --contract <file> (see --help)')
  }
  const format = flags.format ?? 'human'
  if (format !== 'human' && format !== 'json') {
    throw usageError(`--format must be 'human' or 'json' (got '${format}')`)
  }
  return {
    datasetPath,
    contractPath,
    format,
    sampleLimit: resolveSampleLimit(flags.sampleLimit),
  }
}

/**
 * Run the validate command. Resolves with the exit code (0/1); everything
 * that is exit code 2 throws `CliError` with authored stderr text.
 */
export async function runValidateCommand(
  options: ValidateOptions,
  context: CommandContext,
): Promise<CliExitCode> {
  const startedAt = Date.now()
  const contractText = readContractText(options.contractPath)
  const parsed = parseContract(contractText)
  if (!parsed.ok) {
    throw contractParseError(parsed.errors)
  }

  context.progress.step('opening dataset')
  const conn = await openConnection()
  let plan: EngineValidationPlan
  let result: EngineValidationResult
  let format: EngineFileFormat
  let registeredColumns = 0
  try {
    let registered
    try {
      registered = await registerDataset(conn, options.datasetPath)
    } catch (error) {
      // `dataset_open_failed` (design §2/Appendix C): a closed reason enum.
      context.telemetry?.emit('dataset_open_failed', {
        dataset_role: 'primary',
        format_kind: 'unknown',
        reason_code: context.telemetry?.reasonFromError(error) ?? 'unknown',
      })
      throw error
    }
    registeredColumns = registered.schema.length
    const compiled = compileContract(parsed.contract, registered.schema, {
      relation: PLAN_RELATION,
      sampleLimit: options.sampleLimit,
    })
    if (!compiled.ok) {
      throw bindingError(compiled.errors)
    }
    plan = preparePlan(compiled.plan, [DATASET_VIEW])
    context.progress.step('running validation plan')
    result = await runValidationPlan(conn, plan, registered.schema)
    format = registered.format
  } finally {
    // The connection is per-run; a failed close cannot mask the outcome
    // (the instance dies with the process anyway).
    try {
      conn.closeSync()
    } catch {
      // best-effort
    }
  }

  const report = buildValidationReport(plan, result)
  const meta: ReportMeta = {
    contractName: plan.contractName,
    contractVersion: plan.contractVersion,
    datasetName: datasetDisplayName(options.datasetPath),
    format,
    sampleLimitRequested: options.sampleLimit,
    sampleLimitEffective: Math.min(options.sampleLimit, VALIDATION_SAMPLE_HARD_MAX),
  }
  // `dataset_opened` + `validation_run` (design §2/Appendix C): value-free
  // buckets/counts only. Row count comes from the completed verdict.
  context.telemetry?.emit('dataset_opened', {
    dataset_role: 'primary',
    format_kind: formatKindFromEngineFormat(format),
    size_bucket: fileSizeBucket(options.datasetPath),
    row_count_bucket: bucketRowCount(result.rowCount),
    column_count_bucket: bucketColumnCount(registeredColumns),
  })
  context.telemetry?.emit('validation_run', {
    checks_run: result.rules.length,
    finding_count_bucket: bucketFindingCount(
      result.rules.reduce((sum, rule) => sum + rule.failCount, 0),
    ),
    duration_bucket: durationSince(startedAt),
    outcome: validationOutcome(report.valid),
  })
  context.progress.done()
  context.out(
    options.format === 'json'
      ? renderJsonReport(report, meta)
      : renderHumanReport(report, meta, context.style),
  )
  return report.valid ? 0 : 1
}

/** Size bucket for a path; an unreadable size degrades to `empty`. */
function fileSizeBucket(path: string): ReturnType<typeof bucketSize> {
  try {
    return bucketSize(statSync(path).size)
  } catch {
    return 'empty'
  }
}

/** Read the contract file (readable path error; size bounded for sanity). */
function readContractText(contractPath: string): string {
  let text: string
  try {
    text = readFileSync(contractPath, 'utf8')
  } catch {
    throw usageError(`contract file not readable: ${contractPath}`)
  }
  return text
}

/** All contract parse errors, one readable line each (the m5-0 canonical form). */
function contractParseError(errors: readonly ContractError[]): CliError {
  const lines = errors.map((error) => `error: ${describeContractError(error)}`)
  return new CliError(2, [`contract could not be parsed:`, ...lines].join('\n'))
}

/** All binding errors, one readable line each (the m5-1 canonical form). */
function bindingError(errors: readonly BindingError[]): CliError {
  const lines = errors.map((error) => `error: ${describeBindingError(error)}`)
  return new CliError(2, [`contract does not bind against the dataset:`, ...lines].join('\n'))
}
