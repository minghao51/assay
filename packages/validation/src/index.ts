// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * @assay/validation — Rule planning and execution.
 *
 * m5-1: the pure rule→plan compiler. A validated m5-0 contract
 * (`ContractV1` from `@assay/contracts`) plus the target schema (the
 * engine's `schema()` shape, `Array<{ name, type }>`) compile into a
 * deterministic, serializable {@link ValidationPlan} — one SQL query per
 * rule plus one summary query — or typed {@link BindingError}s. Binding
 * happens before execution: missing columns, rules inapplicable to the
 * column's type family, unclassifiable engine type spellings, and regex
 * patterns outside the documented RE2 subset (DuckDB's dialect) are all
 * rejected here, never at runtime. See `compile.ts` for the binding
 * semantics and `plan.ts` for the result contracts m5-2 pins.
 *
 * Export discipline mirrors `@assay/contracts`: the public surface is the
 * compiler, the plan payload, the error taxonomy, the schema classifier,
 * the RE2 checker, and the SQL literal/identifier helpers (the documented
 * composition contract with the engine). Property-test generators stay
 * in-package (`property-testing.ts` is never re-exported).
 */
export { compileContract, DEFAULT_SAMPLE_LIMIT } from './compile.js'
export type { CompileOptions, CompileResult } from './compile.js'
export { describeBindingError } from './errors.js'
export type { BindingError, BindingErrorCode } from './errors.js'
export {
  quoteIdentifier,
  sqlBooleanLiteral,
  sqlIntegerLiteral,
  sqlNumberLiteral,
  sqlStringLiteral,
} from './literals.js'
export { PLAN_KIND, PLAN_VERSION } from './plan.js'
export type { PlannedRule, RuleOutcomeShape, ValidationPlan, ValidationRuleKind } from './plan.js'
export { checkRe2Pattern } from './re2.js'
export type { Re2PatternCheck } from './re2.js'
export { classifyColumnType, describeUnbindableType } from './schema.js'
export type { ColumnTypeFamily, EngineSchema, EngineSchemaColumn } from './schema.js'
