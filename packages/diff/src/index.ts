// SPDX-License-Identifier: AGPL-3.0-or-later

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
 * - **Row-diff plan** (`compileRowDiffPlan`, m6-1): the key-based row-diff
 *   DiffPlan — added/removed anti-joins, changed via a full outer join on
 *   key with `IS DISTINCT FROM` per shared column, exact counts +
 *   K-bounded samples carrying side-qualified row keys — plus the C2 key
 *   inference proposer (`inferRowDiffKeys`). See `row-diff-plan.ts` for
 *   the executor contract.
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
 * lint-enforced purity boundary). Downstream: m6-2 engine execution, m6-3
 * CLI, m6-4 web panel; cross-surface byte-agreement is asserted in m6-5.
 */
export { binIndex, deriveBins } from './bins.js'
export type { BinSet } from './bins.js'
export { distributionDeltas } from './deltas.js'
export type {
  CategoricalDistributionDelta,
  ColumnDistributionDelta,
  DistributionDeltasResult,
  NumericDistributionDelta,
} from './deltas.js'
export {
  DIVERGENCE_EPSILON,
  JENSEN_SHANNON_MAX,
  jensenShannon,
  newCategories,
  psi,
  totalVariation,
  vanishedCategories,
} from './divergence.js'
export { describeDiffIssue } from './issues.js'
export type { DiffIssue, DiffIssueCode, DiffSide } from './issues.js'
export { inferRowDiffKeys } from './key-inference.js'
export type { KeyCandidate, KeyCandidateEvidence, KeyInferenceResult } from './key-inference.js'
export type {
  CategoricalColumnStats,
  CategoricalTopKEntry,
  ColumnProfile,
  DatasetProfile,
  NumericColumnStats,
  NumericQuantiles,
  ProfileColumnKind,
} from './profile.js'
export { REPORT_DECIMALS, roundForReport } from './rounding.js'
export {
  DIFF_REPORT_MARKER,
  columnDeltaDiffers,
  diffReportIdentical,
  diffSampleDisplayKey,
  diffSampleExportKey,
  divergentColumnDeltas,
  projectAspect,
  projectColumnDelta,
  projectInference,
  projectIssue,
  projectSample,
  projectSchemaFinding,
  roundReportMetric,
} from './report-projection.js'
export type {
  DiffInferenceInput,
  DiffReportIdentityInput,
  ProjectAspectInput,
  ProjectSampleInput,
} from './report-projection.js'
export { diffDatasets, hasSchemaOrProfileDifferences } from './report.js'
export type { DiffInput, DiffReport } from './report.js'
export { nullabilityDrift, schemaDrift } from './schema-drift.js'
export type { SchemaDriftFinding, SchemaDriftKind, SchemaDriftResult } from './schema-drift.js'
export {
  compileRowDiffPlan,
  DEFAULT_ROW_DIFF_SAMPLE_LIMIT,
  keyTypesCompatible,
} from './row-diff-compile.js'
export type { RowDiffCompileOptions, RowDiffCompileResult } from './row-diff-compile.js'
export { describeRowDiffBindingError } from './row-diff-errors.js'
export type { RowDiffBindingError, RowDiffBindingErrorCode } from './row-diff-errors.js'
export { DIFF_PLAN_KIND, DIFF_PLAN_VERSION, ROW_DIFF_ASPECTS } from './row-diff-plan.js'
export type { RowDiffAspect, RowDiffPlan } from './row-diff-plan.js'
