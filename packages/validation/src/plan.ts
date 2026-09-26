// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The validation plan payload (m5-1) — the compiled, **serializable** form
 * of a contract for one target dataset.
 *
 * ## Serialization boundary
 *
 * m5-2 ships this object to the engine worker over postMessage and m5-4
 * executes it under Node: every field is plain JSON-representable data —
 * strings, numbers, booleans, arrays. No functions, closures, Maps, or
 * class instances; the property suite pins `JSON.parse(JSON.stringify(plan))`
 * ≡ `plan`.
 *
 * ## Result contracts the SQL is built for (m5-2 pins these)
 *
 * **Per-rule query, `outcome: 'row-samples'`** — returns the columns
 *
 *     total_rows   — row count of the target relation (BIGINT)
 *     fail_count   — total violating rows (integral; repeated on every row)
 *     sample_index — 0-based ordinal of this sample row within the
 *                    violation set (integral)
 *     assay_row_ordinal — stable row identity: the 0-based position of the
 *                    row in the target relation's **natural (scan) order**,
 *                    computed *before* filtering. When m5-2 binds the plan
 *                    over the engine's composed effective relation (which
 *                    orders by `assay_key`, m4-2), this equals the index
 *                    into the engine's effective row list (the domain's
 *                    `effectiveRowIds` order). The m5-2 agreement work pins
 *                    this against the engine.
 *     assay_value  — the offending value (the constrained column's value)
 *
 * and at most `sampleLimit` rows: empty result ⇔ no violations.
 *
 * **Per-rule query, `outcome: 'dataset-fact'`** — a dataset-level verdict
 * (row-count bounds, declared-type mismatch, share rules): same
 * `total_rows`/`fail_count` columns, exactly one row when the fact is
 * violated, zero rows when it holds. Together with `row-samples` the
 * executor convention is uniform: **empty per-rule result ⇔ failCount 0;
 * otherwise failCount is the first row's `fail_count`** (which is why
 * `sampleLimit` must be ≥ 1 — a `LIMIT 0` would make a violated rule look
 * clean).
 *
 * **Summary query** — exactly one row per planned rule, in plan order
 * (`UNION ALL` of per-rule arms; no `ORDER BY` — arm order is canonical):
 *
 *     rule_id     — the PlannedRule's ruleId
 *     total_rows  — same definition as the per-rule queries
 *     fail_count  — same definition; must equal the per-rule execution
 *
 * Every arm derives its count from the *same* generated predicate/expression
 * fragments as the corresponding per-rule query (shared builders in
 * `compile.ts`), so plan-vs-summary divergence is structurally impossible —
 * m5-6 asserts web/CLI agreement over these counts.
 *
 * ## Identifier invariants (why any dataset column name binds)
 *
 * The plan's SQL reserves two namespaces for itself: the `assay_*` aliases
 * (`assay_row_ordinal`, `assay_value`, `assay_occurrences`, `assay_n`,
 * `assay_null_share`, `assay_non_null`, `assay_distinct` plus the result
 * columns `rule_id`/`total_rows`/`fail_count`/`sample_index`) and the range
 * name `"src"` for the target relation. Because DuckDB identifiers are
 * case-insensitive even when quoted and may contain anything, no *name* is
 * reserved against a dataset — instead the SQL is shaped so names never
 * meet at one scope: source columns are referenced only range-qualified
 * (`"src"."col"`), and derived tables expose only `assay_*` aliases. A
 * dataset column may therefore be named anything — including
 * `assay_row_ordinal` in any casing — and stay bindable and correctly
 * executable (real-DuckDB regression pins in `duckdb-agreement.test.ts`).
 */

/** Discriminator carried by every plan (defensive versioning at the wire). */
export const PLAN_KIND = 'assay-validation-plan' as const

/** The only plan version this compiler emits. */
export const PLAN_VERSION = 1 as const

/**
 * The rule kinds a v1 contract can carry — the m5-0 rule vocabulary, in
 * its canonical key order. Each maps to exactly one planned rule.
 */
export type ValidationRuleKind =
  | 'declared-type'
  | 'required'
  | 'unique'
  | 'min'
  | 'max'
  | 'allowed-values'
  | 'regex'
  | 'max-null-share'
  | 'min-distinct-share'
  | 'min-rows'
  | 'max-rows'

/** Which result shape the rule's per-rule query returns (see module doc). */
export type RuleOutcomeShape = 'row-samples' | 'dataset-fact'

/** One compiled rule: identity, attribution, and its SQL text. */
export interface PlannedRule {
  /**
   * Stable rule identity, reused from the contract's own structure: the
   * m5-0 path spelling (`columns[2].max-null-share`, `dataset.min-rows`).
   * Unique within a plan (m5-0 rejects duplicate columns and each rule kind
   * appears at most once per column); m5-2 keys per-rule results by it.
   * Carried separately from `path` (they coincide in v1) so a future id
   * scheme can diverge without breaking result keying.
   */
  readonly ruleId: string
  /**
   * Attribution path into the contract, m5-0's error-path convention —
   * identical to `ruleId` in v1.
   */
  readonly path: string
  readonly kind: ValidationRuleKind
  /** The constrained column's name; `null` for dataset-level rules. */
  readonly column: string | null
  readonly outcome: RuleOutcomeShape
  /** The rule's complete, deterministic SQL text. */
  readonly sql: string
  /** `declared-type` rules only: the contract's expected type spelling. */
  readonly expectedType?: string
  /** `declared-type` rules only: the schema's actual type spelling. */
  readonly actualType?: string
}

/** A compiled validation plan (see module doc for the full contract). */
export interface ValidationPlan {
  readonly planKind: typeof PLAN_KIND
  readonly planVersion: typeof PLAN_VERSION
  /** Echoed contract metadata (report attribution). */
  readonly contractName: string
  readonly contractVersion: number
  /** The target relation name, as given in the compile options (quoted into SQL). */
  readonly relation: string
  /** The K of the sample-failure bound (≥ 1). */
  readonly sampleLimit: number
  /** One entry per contract rule, in canonical contract order. */
  readonly rules: readonly PlannedRule[]
  /** The single summary query (see module doc). */
  readonly summarySql: string
}
