/**
 * Per-column distribution deltas (checkpoint C1), computed purely from the
 * two profile summaries (the m2 `profile()` shape, mirrored in
 * `profile.ts`). Directionality: **A = reference, B = current** everywhere.
 *
 * ## The metric set (exactly checkpoint C1 — no p-values, no significance)
 *
 * - Numeric: standardized mean shift `(meanB − meanA) / stddevA` and
 *   standardized variance shift `σB²/σA² − 1`, computed in the numerically
 *   stable ratio form `(σB/σA)² − 1` (algebraically identical to
 *   `(σB² − σA²)/σA²`; exact at identity, and it never squares a subnormal
 *   spread into 0 — see `numericDelta`) — both standardized
 *   **against side A** (documented, pinned); raw `p50`/`p90` quantile
 *   shifts `qB − qA` in the column's own units (defined even for a
 *   zero-spread reference, where standardization is not — a constant
 *   reference keeps its raw signal here); and the side-A bins
 *   (`bins.ts`) for downstream PSI/J-S histograms.
 * - Categorical: total-variation distance over `top-k ∪ {other}` plus the
 *   new/vanished category lists relative to A (`divergence.ts`).
 *
 * ## Undefined, not zero
 *
 * Every metric is `null` (documented undefined — never NaN) when its inputs
 * do not determine it: missing/non-finite stats, a zero-spread or unknown
 * reference spread for the standardizations, a side without non-null mass
 * for TV, a non-finite intermediate result. Issues already attribute the
 * input problems that caused it.
 *
 * ## Identity and skips
 *
 * Comparing A to A yields exactly `0` for every *defined* metric and empty
 * new/vanished lists (pinned across shapes in the tests; `0` survives the
 * report rounding by construction). Columns are matched by exact,
 * case-sensitive name. A column present in only one profile gets no delta —
 * presence is schema drift's concern, a documented skip, not a silent one.
 * Columns whose profile kinds differ get an entry without metrics: the
 * schema-drift aspect carries the cross-family type finding that explains
 * it. Deltas appear in profile-A column order.
 */

import type { BinSet } from './bins.js'
import { deriveBins } from './bins.js'
import type { DiffIssue } from './issues.js'
import type { CategoricalTopKEntry, DatasetProfile, ProfileColumnKind } from './profile.js'
import { isFiniteNumber, normZero } from './guards.js'
import type {
  ValidatedColumnProfile,
  ValidatedNumericStats,
  ValidatedProfile,
} from './input-validation.js'
import { nonNullCount, validateProfile } from './input-validation.js'
import { newCategories, totalVariation, vanishedCategories } from './divergence.js'

/** Numeric deltas (checkpoint C1) for one column present as `numeric` on both sides. */
export interface NumericDistributionDelta {
  /** `(meanB − meanA) / stddevA` — standardized against side A. */
  readonly meanShiftStandardized: number | null
  /**
   * `σB²/σA² − 1` — relative variance change, referenced to side A,
   * computed in the ratio form `(σB/σA)² − 1` (documented in
   * `numericDelta`; exact at identity and stable at subnormal spread).
   */
  readonly varianceShiftStandardized: number | null
  /** `p50B − p50A` in the column's own units (raw, not standardized). */
  readonly p50Shift: number | null
  /** `p90B − p90A` in the column's own units (raw, not standardized). */
  readonly p90Shift: number | null
  /**
   * Side-A reference bins for downstream PSI/J-S histograms (`deriveBins`
   * of side A's stats; present whenever the numeric delta is present).
   */
  readonly bins: BinSet
}

/** Categorical deltas (checkpoint C1) for one column present as `categorical` on both sides. */
export interface CategoricalDistributionDelta {
  /** Total-variation distance over `top-k ∪ {other}` (pooled proxy — see `divergence.ts`). */
  readonly totalVariation: number | null
  /** Values in B's top-k absent from A's top-k, in B's top-k order. */
  readonly newCategories: readonly CategoricalTopKEntry[]
  /** Values in A's top-k absent from B's top-k, in A's top-k order. */
  readonly vanishedCategories: readonly CategoricalTopKEntry[]
}

/**
 * One shared column's distribution delta. `numeric` is present iff both
 * sides are kind `numeric` with usable payloads; `categorical` iff both are
 * `categorical` with usable payloads. Kind-changed columns have neither —
 * the schema-drift aspect carries the explanation.
 */
export interface ColumnDistributionDelta {
  readonly column: string
  readonly typeA: string
  readonly typeB: string
  readonly kindA: ProfileColumnKind
  readonly kindB: ProfileColumnKind
  readonly numeric?: NumericDistributionDelta
  readonly categorical?: CategoricalDistributionDelta
}

/** Distribution deltas plus the collected input issues of the aspect. */
export interface DistributionDeltasResult {
  readonly deltas: readonly ColumnDistributionDelta[]
  readonly issues: readonly DiffIssue[]
}

/**
 * Distribution deltas over the two profile summaries (see module doc).
 * Total over hostile input: profile problems degrade to issues; a top-level
 * unusable profile skips the aspect with its issue.
 */
export function distributionDeltas(
  profileA: DatasetProfile,
  profileB: DatasetProfile,
): DistributionDeltasResult {
  const issues: DiffIssue[] = []
  const a = validateProfile(profileA as unknown, 'A', issues)
  const b = validateProfile(profileB as unknown, 'B', issues)
  if (a === null || b === null) return { deltas: [], issues }
  return { deltas: distributionDeltasFor(a, b), issues }
}

/** Deltas over validated profiles (shared by `distributionDeltas` and `diffDatasets`). */
export function distributionDeltasFor(
  a: ValidatedProfile,
  b: ValidatedProfile,
): ColumnDistributionDelta[] {
  const deltas: ColumnDistributionDelta[] = []
  for (const columnA of a.columns) {
    const columnB = b.byName.get(columnA.name)
    if (columnB === undefined) continue // presence is schema drift's concern
    deltas.push(deltaForColumn(columnA, columnB, a.rowCount, b.rowCount))
  }
  return deltas
}

function deltaForColumn(
  a: ValidatedColumnProfile,
  b: ValidatedColumnProfile,
  rowCountA: number | null,
  rowCountB: number | null,
): ColumnDistributionDelta {
  const identity = {
    column: a.name,
    typeA: a.type,
    typeB: b.type,
    kindA: a.kind,
    kindB: b.kind,
  }
  if (a.kind === 'numeric' && b.kind === 'numeric' && a.numeric !== null && b.numeric !== null) {
    return { ...identity, numeric: numericDelta(a.numeric, b.numeric) }
  }
  if (
    a.kind === 'categorical' &&
    b.kind === 'categorical' &&
    a.categorical !== null &&
    b.categorical !== null
  ) {
    const nonNullA = nonNullCount(a, rowCountA)
    const nonNullB = nonNullCount(b, rowCountB)
    return {
      ...identity,
      categorical: {
        totalVariation:
          nonNullA !== null && nonNullB !== null
            ? totalVariation(a.categorical.topK, nonNullA, b.categorical.topK, nonNullB)
            : null,
        newCategories: newCategories(a.categorical.topK, b.categorical.topK),
        vanishedCategories: vanishedCategories(a.categorical.topK, b.categorical.topK),
      },
    }
  }
  return identity
}

function numericDelta(
  a: ValidatedNumericStats,
  b: ValidatedNumericStats,
): NumericDistributionDelta {
  const spreadA = a.stddev !== null && a.stddev > 0
  const meanShiftStandardized =
    spreadA && a.mean !== null && b.mean !== null
      ? finiteOrNull(normZero((b.mean - a.mean) / a.stddev))
      : null
  // Ratio form, documented: σB²/σA² − 1 = (σB/σA)² − 1 — algebraically the
  // same relative-to-A variance shift as (σB² − σA²)/σA², but it never
  // squares a side into a subnormal-sized double. The quotient form squares
  // σA = 1e-200 into 1e-400 → underflow to 0 → 0/0 = NaN, which turned the
  // *identity* comparison (σB = σA) into a spurious `null` at subnormal
  // spread. The ratio form is exactly 0 there (σB/σA = 1), keeps the
  // documented goldens exact at ordinary scales (they are algebraically
  // identical, and the ratio of two doubles rounds once), and still maps an
  // overflowing ratio (|σB/σA| ≥ ~1e154) to `null` via `finiteOrNull`.
  const varianceShiftStandardized =
    spreadA && b.stddev !== null
      ? finiteOrNull(normZero((b.stddev / a.stddev) * (b.stddev / a.stddev) - 1))
      : null
  return {
    meanShiftStandardized,
    varianceShiftStandardized,
    p50Shift: quantileShift(a.quantiles.p50, b.quantiles.p50),
    p90Shift: quantileShift(a.quantiles.p90, b.quantiles.p90),
    bins: deriveBins(a),
  }
}

/** `qB − qA`; `null` when either side's quantile is unknown. */
function quantileShift(qA: number | null, qB: number | null): number | null {
  if (qA === null || qB === null) return null
  return normZero(qB - qA)
}

/** Non-finite intermediates (overflowing doubles) mean "undefined", never NaN. */
function finiteOrNull(value: number | null): number | null {
  return value !== null && isFiniteNumber(value) ? value : null
}
