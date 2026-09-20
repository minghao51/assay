/**
 * The diff model's front door (m6-0): `diffDatasets` turns two engine-shaped
 * schemas plus two profile summaries into one plain-data {@link DiffReport}
 * — schema-drift findings (type drift + profile-derived nullability),
 * per-column distribution deltas (checkpoint C1), and collected typed
 * issues.
 *
 * ## Totality (the m5-0 hostile-input discipline)
 *
 * The parameter is *typed* for callers; behind a hostile cast nothing
 * throws: every field read is guarded, malformed input degrades to typed
 * {@link DiffIssue}s (collected together, attributed — never a first-error
 * abort), and an aspect computed from an unusable side is skipped *with*
 * the issue that says so — never silently, and never with misleading
 * findings synthesized from an empty stand-in. Column names and category
 * values like `__proto__` are inert: matching uses `Map`/`Set`, never
 * plain objects.
 *
 * ## Determinism
 *
 * Identical inputs produce byte-identical, JSON-stable reports. Findings
 * and issues come in documented orders (issues: input-level, then side A
 * schema, side B schema, side A profile, side B profile, then aspect
 * order; findings: column name, then documented kind order; deltas:
 * profile-A column order); every number is finite-or-null with `-0`
 * normalized; there is no clock, randomness, or map-iteration-order leak.
 * Report-facing rendering rounds through the one documented convention
 * (`roundForReport`) — the model keeps full precision.
 *
 * ## Aspect order (the docs-07 honesty rule, made structural)
 *
 * Schema drift first, then distribution deltas; row-level comparison is
 * m6-1+ and deliberately absent here. "No differences" at this level means
 * no *schema/profile-observable* difference — two datasets with identical
 * schema and identical profile aggregates but different rows are honestly
 * reported as having none (`hasSchemaOrProfileDifferences`), until the
 * row-diff aspects land.
 */

import type { DiffIssue } from './issues'
import { makeIssue } from './issues'
import type { DatasetProfile } from './profile'
import { readField } from './guards'
import type { EngineSchema } from '@assay/validation'
import type {
  CategoricalDistributionDelta,
  ColumnDistributionDelta,
  NumericDistributionDelta,
} from './deltas'
import { distributionDeltasFor } from './deltas'
import type { SchemaDriftFinding } from './schema-drift'
import { nullabilityFindings, sortFindings, typeDriftFindings } from './schema-drift'
import type { ValidatedProfile, ValidatedSchema } from './input-validation'
import { validateProfile, validateSchema } from './input-validation'

/** The diff model's inputs: two engine schemas, two profile summaries. */
export interface DiffInput {
  /** Side A — the reference (e.g. the dataset already open in the grid). */
  readonly schemaA: EngineSchema
  /** Side B — the current version. */
  readonly schemaB: EngineSchema
  readonly profileA: DatasetProfile
  readonly profileB: DatasetProfile
}

/**
 * The typed diff report: plain, JSON-stable data both surfaces render.
 * Aspect order for consumers: schema drift first, then column deltas.
 */
export interface DiffReport {
  /** Type drift + profile-derived nullability, in the documented order. */
  readonly schemaDrift: readonly SchemaDriftFinding[]
  /** Per-column distribution deltas (checkpoint C1), in profile-A column order. */
  readonly columnDeltas: readonly ColumnDistributionDelta[]
  /** Collected input issues (documented order); empty for well-formed inputs. */
  readonly issues: readonly DiffIssue[]
}

/**
 * Compare side A (reference) and side B (current): schema drift, then
 * per-column distribution deltas, with all input problems collected as
 * typed issues. Total — never throws, over any input (see module doc).
 */
export function diffDatasets(input: DiffInput): DiffReport {
  const issues: DiffIssue[] = []
  const schemaA = readField(input, 'schemaA')
  const schemaB = readField(input, 'schemaB')
  const profileA = readField(input, 'profileA')
  const profileB = readField(input, 'profileB')
  for (const [key, read] of [
    ['schemaA', schemaA],
    ['schemaB', schemaB],
    ['profileA', profileA],
    ['profileB', profileB],
  ] as const) {
    // A successful read of a missing key yields `undefined` — that is also
    // "missing", with the same aspect-skip semantics as an unreadable field.
    if (!read.ok || read.value === undefined) {
      issues.push(
        makeIssue(
          'invalid-input',
          `input.${key} is missing or unreadable; the aspects consuming it are skipped`,
        ),
      )
    }
  }
  const findings: SchemaDriftFinding[] = []
  let validatedA: ValidatedSchema | null = null
  let validatedB: ValidatedSchema | null = null
  if (schemaA.ok && schemaA.value !== undefined && schemaB.ok && schemaB.value !== undefined) {
    validatedA = validateSchema(schemaA.value, 'A', issues)
    validatedB = validateSchema(schemaB.value, 'B', issues)
    if (validatedA !== null && validatedB !== null) {
      findings.push(...typeDriftFindings(validatedA, validatedB))
    }
  }
  let validatedProfileA: ValidatedProfile | null = null
  let validatedProfileB: ValidatedProfile | null = null
  if (profileA.ok && profileA.value !== undefined && profileB.ok && profileB.value !== undefined) {
    validatedProfileA = validateProfile(profileA.value, 'A', issues)
    validatedProfileB = validateProfile(profileB.value, 'B', issues)
    if (validatedProfileA !== null && validatedProfileB !== null) {
      findings.push(...nullabilityFindings(validatedProfileA, validatedProfileB))
    }
  }
  const deltas =
    validatedProfileA !== null && validatedProfileB !== null
      ? distributionDeltasFor(validatedProfileA, validatedProfileB)
      : []
  return {
    schemaDrift: sortFindings(findings),
    columnDeltas: deltas,
    issues,
  }
}

/**
 * Whether the report contains any schema- or profile-observable difference:
 * any schema-drift finding, or any column delta with a defined non-zero
 * metric or non-empty new/vanished list. Honest scope: identical files
 * always yield `false` (pinned), but `false` alone does not prove row-level
 * identity — row-level comparison is m6-1+.
 */
export function hasSchemaOrProfileDifferences(report: DiffReport): boolean {
  if (report.schemaDrift.length > 0) return true
  return report.columnDeltas.some(deltaNonZero)
}

function deltaNonZero(delta: ColumnDistributionDelta): boolean {
  const numeric: NumericDistributionDelta | undefined = delta.numeric
  if (
    numeric !== undefined &&
    (nonZeroMetric(numeric.meanShiftStandardized) ||
      nonZeroMetric(numeric.varianceShiftStandardized) ||
      nonZeroMetric(numeric.p50Shift) ||
      nonZeroMetric(numeric.p90Shift))
  ) {
    return true
  }
  const categorical: CategoricalDistributionDelta | undefined = delta.categorical
  if (categorical !== undefined) {
    if (nonZeroMetric(categorical.totalVariation)) return true
    if (categorical.newCategories.length > 0 || categorical.vanishedCategories.length > 0) {
      return true
    }
  }
  return false
}

function nonZeroMetric(value: number | null): boolean {
  return value !== null && value !== 0
}
