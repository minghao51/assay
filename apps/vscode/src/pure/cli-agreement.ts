// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from 'node:child_process'

export type DiffReport = Record<string, unknown>

/** Run the repository CLI's JSON diff and return its parsed semantic report. */
export function runCliDiffReport(
  cliPath: string,
  aPath: string,
  bPath: string,
  key: string,
): DiffReport {
  const result = spawnSync(
    process.execPath,
    [cliPath, 'diff', aPath, bPath, '--key', key, '--format', 'json'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  )
  // Exit 1 is the CLI's documented result for a non-identical pair; its JSON
  // report remains the authoritative output. Other non-zero statuses fail.
  if (result.error !== undefined) throw result.error
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(result.stderr.trim() || `CLI diff exited ${String(result.status)}`)
  }
  try {
    return JSON.parse(result.stdout) as DiffReport
  } catch (error) {
    throw new Error(
      `CLI diff did not return JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

const COMMON_FIELDS = [
  'keys',
  'keySource',
  'sampleLimitRequested',
  'sampleLimitEffective',
  'schemaDrift',
  'columnDeltas',
  'rowDiff',
  'issues',
  'identical',
  'baseViewOnly',
] as const

/** Compare only the cross-surface contract; report heads and staleness are surface-specific. */
export function agreeSemantics(
  desktopReport: DiffReport,
  cliReport: DiffReport,
): { agreed: boolean; mismatchedFields: string[] } {
  const mismatchedFields = COMMON_FIELDS.filter(
    (field) => JSON.stringify(desktopReport[field]) !== JSON.stringify(cliReport[field]),
  )
  return { agreed: mismatchedFields.length === 0, mismatchedFields: [...mismatchedFields] }
}
