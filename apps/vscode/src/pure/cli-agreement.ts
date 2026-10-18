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

export interface AgreementOptions {
  /**
   * Fields excluded from this leg's comparison. The only sanctioned uses
   * are documented at the call sites: the edited-view leg excludes
   * `baseViewOnly` (the desktop marks side A as an edited view while the
   * CLI diffs a plain exported file) and `columnDeltas` (profile aspects
   * are base-only on the desktop — no overlay profiling exists — while the
   * CLI profiles the exported copy). Every exclusion must be justified at
   * the call site; an exclusion never waives the presence check.
   */
  readonly excludeFields?: readonly (typeof COMMON_FIELDS)[number][]
}

const FIELD_KINDS = {
  keys: 'array',
  keySource: 'string',
  sampleLimitRequested: 'number',
  sampleLimitEffective: 'number',
  schemaDrift: 'array',
  columnDeltas: 'array',
  rowDiff: 'object',
  issues: 'array',
  identical: 'boolean',
  baseViewOnly: 'boolean',
} as const satisfies Record<(typeof COMMON_FIELDS)[number], string>

/** A report is only comparable when every common field is present with the
 * right kind — two reports that both LACK a field must not compare equal. */
function missingShapeFields(report: DiffReport, label: 'desktop' | 'cli'): string[] {
  const missing: string[] = []
  for (const [field, kind] of Object.entries(FIELD_KINDS)) {
    const value = report[field]
    const ok =
      (kind === 'array' && Array.isArray(value)) ||
      (kind === 'object' && typeof value === 'object' && value !== null && !Array.isArray(value)) ||
      (kind !== 'array' && kind !== 'object' && typeof value === kind)
    if (!ok) missing.push(`missing-${field}-${label}`)
  }
  return missing
}

/** Compare only the cross-surface contract; report heads and staleness are surface-specific. */
export function agreeSemantics(
  desktopReport: DiffReport,
  cliReport: DiffReport,
  options?: AgreementOptions,
): { agreed: boolean; mismatchedFields: string[] } {
  const excluded = new Set(options?.excludeFields ?? [])
  const mismatchedFields = [
    ...missingShapeFields(desktopReport, 'desktop'),
    ...missingShapeFields(cliReport, 'cli'),
  ]
  for (const field of COMMON_FIELDS) {
    if (excluded.has(field)) continue
    if (
      mismatchedFields.some(
        (entry) => entry === `missing-${field}-desktop` || entry === `missing-${field}-cli`,
      )
    )
      continue
    if (JSON.stringify(desktopReport[field]) !== JSON.stringify(cliReport[field]))
      mismatchedFields.push(field)
  }
  return { agreed: mismatchedFields.length === 0, mismatchedFields }
}
