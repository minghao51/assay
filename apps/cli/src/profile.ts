/**
 * `assay profile <path>` (ar-5; closes the AR-C4 missing-command finding).
 *
 * Pipeline (the m5-4/m6-3 shape, reused): open the dataset exactly like the
 * engine's `open` (same format policy, same DESCRIBE-shaped schema) → build
 * the m2-5 `DatasetProfile` from the REUSED profile SQL through the `./node`
 * seam (`profileView`: one combined aggregate scan plus one top-k query per
 * categorical column) → render the report (human or byte-stable JSON).
 *
 * Exit codes (the house style): `0` — the profile was produced (the report on
 * stdout IS the result); `2` — usage, path, or execution error (readable,
 * value-free stderr). Profile has no violation/difference verdict, so it never
 * exits 1.
 *
 * Privacy (ADR 0025): profile output is product content on stdout — column
 * names, types, counts, statistics, and categorical top-k values. stderr
 * carries authored, fixed messages; raw engine error text and dataset values
 * never reach it.
 */
import { PROFILE_TOP_K } from '@assay/engine-duckdb/node'
import { DATASET_VIEW, openConnection, registerDataset } from './connection.js'
import { usageError } from './errors.js'
import type { CliExitCode } from './errors.js'
import { profileView } from './node-executor.js'
import { datasetDisplayName, renderHumanProfile, renderJsonProfile } from './report.js'
import type { ProfileReportMeta } from './report.js'

/** Parsed + validated options for the profile command. */
export interface ProfileOptions {
  readonly datasetPath: string
  readonly format: 'human' | 'json'
}

/** Parse + validate the command's options (exit 2 on anything malformed). */
export function resolveProfileOptions(flags: {
  readonly contract?: string
  readonly format?: string
  readonly sampleLimit?: string
  /** Diff/validate-only flags, parsed globally but rejected here. */
  readonly keys?: readonly string[]
  readonly infer?: boolean
  readonly positionals: readonly string[]
}): ProfileOptions {
  const datasetPath = flags.positionals[0]
  if (datasetPath === undefined) {
    throw usageError('profile requires a dataset path (see --help)')
  }
  if (flags.positionals.length > 1) {
    throw usageError(
      `profile takes exactly one dataset path (got ${String(flags.positionals.length)})`,
    )
  }
  if (flags.contract !== undefined) {
    throw usageError('profile does not take --contract (did you mean `assay validate`? see --help)')
  }
  if ((flags.keys?.length ?? 0) > 0) {
    throw usageError('profile does not take --key (did you mean `assay diff`? see --help)')
  }
  if (flags.infer === true) {
    throw usageError('profile does not take --infer (did you mean `assay diff`? see --help)')
  }
  if (flags.sampleLimit !== undefined) {
    throw usageError('profile does not take --sample-limit (see --help)')
  }
  const format = flags.format ?? 'human'
  if (format !== 'human' && format !== 'json') {
    throw usageError(`--format must be 'human' or 'json' (got '${format}')`)
  }
  return { datasetPath, format }
}

/**
 * Run the profile command. Resolves with the exit code (0); everything that
 * is exit code 2 throws `CliError` with authored stderr text.
 */
export async function runProfileCommand(
  options: ProfileOptions,
  out: (text: string) => void,
): Promise<CliExitCode> {
  const conn = await openConnection()
  let meta: ProfileReportMeta
  let report: string
  try {
    const registered = await registerDataset(conn, options.datasetPath)
    const profile = await profileView(conn, DATASET_VIEW, registered.schema)
    meta = {
      datasetName: datasetDisplayName(options.datasetPath),
      format: registered.format,
      topK: PROFILE_TOP_K,
    }
    report =
      options.format === 'json'
        ? renderJsonProfile(profile, meta)
        : renderHumanProfile(profile, meta)
  } finally {
    // The connection is per-run; a failed close cannot mask the outcome
    // (the instance dies with the process anyway).
    try {
      conn.closeSync()
    } catch {
      // best-effort
    }
  }
  out(report)
  return 0
}
