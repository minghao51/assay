/**
 * @assay/diff — Schema/profile/distribution/row diff (pure domain layer).
 *
 * m6-0 ships the typed diff model's pure heart:
 *
 * - **Schema drift** (`schemaDrift`, `nullabilityDrift`): added/removed
 *   columns and type changes classified via the m5-1 type-family classifier
 *   **reused from `@assay/validation`** (pre-authorized dependency, never
 *   reimplemented; nested-shape drift from the textual type compare +
 *   classifier family); nullability drift computed from the profiles' null
 *   shares (engine `DESCRIBE` carries no nullability — documented).
 * - **Distribution deltas** (`distributionDeltas`, checkpoint C1):
 *   standardized mean/variance shifts (against side A), raw p50/p90
 *   quantile shifts, categorical total-variation over `top-k ∪ {other}`
 *   plus new/vanished category lists.
 * - **The bin seam** (`deriveBins`, `binIndex`, `psi`, `jensenShannon`):
 *   profiles carry no histograms, so bins are derived deterministically
 *   from side A's stats and PSI/J-S are pure functions over
 *   (bins, countsA, countsB) — downstream tasks (m6-2+) produce the counts.
 * - **Totality**: every entry point is total over hostile input — typed,
 *   attributed issues collected together, never a throw, never a silent
 *   skip (the m5-0/m5-1 discipline).
 * - **Determinism**: documented orderings everywhere, one documented
 *   report-rounding convention (`roundForReport`), full precision in the
 *   model, byte-stable JSON (no `-0`, no undefined-valued keys).
 * - **Directionality**: A = reference, B = current everywhere; the PSI
 *   form's Jeffreys symmetry and the A-bin directionality are documented
 *   and pinned (`divergence.ts`).
 *
 * The engine profile shape is mirrored structurally (`profile.ts`), never
 * imported: engines are forbidden dependencies for this package (the
 * lint-enforced purity boundary). Downstream: m6-1 plan compiler, m6-2
 * engine execution, m6-3 CLI, m6-4 web panel; cross-surface byte-agreement
 * is asserted in m6-5.
 */
export { binIndex, deriveBins } from './bins'
export type { BinSet } from './bins'
export { distributionDeltas } from './deltas'
export type {
  CategoricalDistributionDelta,
  ColumnDistributionDelta,
  DistributionDeltasResult,
  NumericDistributionDelta,
} from './deltas'
export {
  DIVERGENCE_EPSILON,
  JENSEN_SHANNON_MAX,
  jensenShannon,
  newCategories,
  psi,
  totalVariation,
  vanishedCategories,
} from './divergence'
export { describeDiffIssue } from './issues'
export type { DiffIssue, DiffIssueCode, DiffSide } from './issues'
export type {
  CategoricalColumnStats,
  CategoricalTopKEntry,
  ColumnProfile,
  DatasetProfile,
  NumericColumnStats,
  NumericQuantiles,
  ProfileColumnKind,
} from './profile'
export { REPORT_DECIMALS, roundForReport } from './rounding'
export { diffDatasets, hasSchemaOrProfileDifferences } from './report'
export type { DiffInput, DiffReport } from './report'
export { nullabilityDrift, schemaDrift } from './schema-drift'
export type { SchemaDriftFinding, SchemaDriftKind, SchemaDriftResult } from './schema-drift'
