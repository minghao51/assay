/**
 * `@assay/engine-duckdb/node` — the environment-neutral seam (m5-4).
 *
 * The pure, host-free half of the validate-execution machinery, re-exported
 * for NON-BROWSER hosts (the m5-4 CLI's Node executor and its agreement
 * tests): view composition, the engine-clamped rule-query wrapper, the strict
 * plan wire gate, the result readers/normalizers, and the frozen exact
 * `failPercent`. Everything here is pure SQL/text logic over plain data —
 * verified to touch no browser API (this entry deliberately excludes the
 * worker client/protocol modules, which are the browser surface's transport
 * and are never imported by this file).
 *
 * Cross-surface discipline (m5-2/m5-6): hosts execute the SAME compiled plan
 * SQL through THESE helpers instead of re-deriving any of the semantics —
 * the CLI cannot fork the engine's result contract, it can only reuse it.
 *
 * Scope note: this file and the `./node` exports entry are the m5-4
 * pre-authorized package seam — additive re-exports only, no behavior.
 */
export {
  buildSampleFailures,
  composeValidationCountSql,
  composeValidationRowKeySql,
  composeValidationRuleQuery,
  composeValidationViewDropSql,
  composeValidationViewSql,
  failPercentFromCounts,
  normalizeSampleValue,
  readValidationRowCount,
  readValidationRuleRows,
  readValidationRowKeys,
  readValidationSummaryRows,
  validationEffectiveSampleLimit,
  validationFailCountExcess,
  VALIDATION_BEGIN_SQL,
  VALIDATION_ROLLBACK_SQL,
  VALIDATION_SAMPLE_HARD_MAX,
} from './validate-query.js'
export type {
  ValidationFailCountExcess,
  ValidationRuleRows,
  ValidationSampleRow,
  WireSampleValue,
} from './validate-query.js'
export {
  assertValidationPlanRelationBinding,
  parseValidationPlan,
  quotedRelationToken,
} from './validate-plan-wire.js'
export type {
  EngineValidationPlan,
  EngineValidationResult,
  EngineValidationRule,
  EngineValidationRuleResult,
  EngineValidationSample,
} from './validate-plan-wire.js'
export {
  createViewSql,
  detectFileFormat,
  fileScanSql,
  quotedIdentifier,
  sqlStringLiteral,
} from './format-view.js'
export type { EngineFileFormat } from './format-view.js'
// m6-2: row-diff execution machinery (the m6-3 CLI consumes these exactly as
// the m5-4 CLI consumes the validation helpers, so cross-surface agreement is
// by construction). Pure SQL/text logic over plain data — no browser API.
export {
  assertRowDiffPlanBinding,
  parseRowDiffPlan,
  ROW_DIFF_SAMPLE_HARD_MAX,
} from './diff-plan-wire.js'
export type {
  EngineRowDiffAspect,
  EngineRowDiffAspectResult,
  EngineRowDiffPlan,
  EngineRowDiffResult,
  EngineRowDiffSample,
} from './diff-plan-wire.js'
export {
  buildDiffAspectSamples,
  comparisonRowKey,
  composeDiffARowKeySql,
  composeDiffAspectQuery,
  composeDiffAViewSql,
  composeDiffComparisonViewSql,
  composeDiffCountSql,
  composeDiffViewDropSql,
  diffEffectiveSampleLimit,
  readDiffARowKeys,
  readDiffAspectRows,
  readDiffRowCount,
  readDiffTotalsRows,
  ROW_DIFF_BEGIN_SQL,
  ROW_DIFF_ROLLBACK_SQL,
  rowDiffCountExcess,
} from './diff-query.js'
export type { RowDiffAspectRows, RowDiffCountExcess, RowDiffSampleRow } from './diff-query.js'
// m6-3: profile composition + classification (the pure, browser-free half of
// the m2-5 profiling machinery). The m6-3 CLI needs two dataset profiles to
// drive `@assay/diff`'s schema/profile aspects and C2 key inference, exactly
// as the m5-4 CLI needed the validate helpers: the SQL composition and the
// type classifier are REUSED here, never forked. These modules touch no
// browser API (plain SQL text over quoted identifiers); the value reading
// stays host-side, like every other reader on this seam.
export { classifyProfileColumnType } from './profile-classify.js'
export {
  composeProfileBaseSql,
  composeProfileTopKSql,
  PROFILE_BASE_SLOT,
  PROFILE_QUANTILE_POSITIONS,
  PROFILE_TOP_K,
} from './profile-query.js'
export type { ProfileBaseQueryPlan, ProfileColumnSpec } from './profile-query.js'
