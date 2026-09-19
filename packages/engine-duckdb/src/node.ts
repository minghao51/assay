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
} from './validate-query'
export type {
  ValidationFailCountExcess,
  ValidationRuleRows,
  ValidationSampleRow,
  WireSampleValue,
} from './validate-query'
export {
  assertValidationPlanRelationBinding,
  parseValidationPlan,
  quotedRelationToken,
} from './validate-plan-wire'
export type {
  EngineValidationPlan,
  EngineValidationResult,
  EngineValidationRule,
  EngineValidationRuleResult,
  EngineValidationSample,
} from './validate-plan-wire'
export {
  createViewSql,
  detectFileFormat,
  fileScanSql,
  quotedIdentifier,
  sqlStringLiteral,
} from './format-view'
export type { EngineFileFormat } from './format-view'
