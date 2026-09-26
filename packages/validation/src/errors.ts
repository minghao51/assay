// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Binding-error taxonomy (m5-1).
 *
 * The compiler is **total**: a validated contract + target schema in →
 * either a {@link ValidationPlan} or `BindingError[]` out — never a throw,
 * never a silent skip (every rule compiles or is rejected; all independent
 * errors are collected, m5-0-style). Each error carries a machine-readable
 * `code`, an actionable `message`, and full attribution: the contract
 * `path` (m5-0's convention: `columns[2].max-null-share`,
 * `dataset.min-rows`), the `ruleId` the report would have been keyed by,
 * and the `column` when the rule is column-level.
 *
 * Plain data — render it however the surface wants (see
 * {@link describeBindingError} for the canonical one-liner).
 */

/** Machine-readable binding-failure classes (see {@link BindingError}). */
export type BindingErrorCode =
  /** A rule addresses a column absent from the target schema (with a case-insensitive "did you mean" hint when exactly one candidate exists). */
  | 'missing-column'
  /** The column's engine type spelling cannot be classified (array, nested, unknown) and the rule needs a family. Family-free rules (`required`, `max-null-share`) bind regardless. */
  | 'unknown-column-type'
  /** The column's type is classified but the rule does not apply to that family (min on VARCHAR, regex on INTEGER, allowed-values of the wrong scalar kind, unique on JSON, …). */
  | 'rule-not-applicable'
  /** The `regex` pattern is outside the documented RE2 subset (DuckDB's dialect) or unrepresentable in SQL text. */
  | 'invalid-regex'
  /** The target schema itself is unusable (not an array, malformed entries, duplicate column names, NUL in a name/type). A caller-bug surface: the engine's `schema()` cannot produce these. */
  | 'invalid-schema-input'
  /** The compile options are malformed (relation name, sample limit). */
  | 'invalid-options'
  /**
   * The contract AST is structurally broken *for binding* although it type-checks as `ContractV1` — only reachable through a caller bug behind a cast (non-finite rule numbers, non-scalar allowed-values entries, NUL in a rule value, duplicate column rule sets). `parseContract` output can never trigger this.
   */
  | 'invalid-contract-input'

/** One binding failure. Plain data; never a throw (see module doc). */
export interface BindingError {
  readonly code: BindingErrorCode
  readonly message: string
  /** Path into the contract (m5-0's convention); `dataset.*` for dataset rules. */
  readonly path: string
  /** The rule identity the report would have been keyed by (equals `path` in v1). Present for rule-level errors; absent for input-level errors (malformed schema/options) that are not attributable to one rule. */
  readonly ruleId?: string
  /** The constrained column's name; absent for dataset-level rules. */
  readonly column?: string
}

/** Canonical one-line rendering, compiler-style and greppable. */
export function describeBindingError(error: BindingError): string {
  const where = error.column === undefined ? error.path : `${error.path} (column '${error.column}')`
  return `${where}: [${error.code}] ${error.message}`
}
