/**
 * Canonical Contract AST (m5-0; ADR 0013/0026).
 *
 * `ContractV1` is the portable, engine-independent meaning of a data-quality
 * contract: what the YAML format *says*, stripped of formatting. Everything
 * downstream (the m5-1 rule→plan compiler, the engine execution in m5-2, the
 * CLI in m5-4, the adapters in m5-5) consumes this shape — never YAML text.
 *
 * ## v1 rule set (exactly as queued — cross-field and cross-row rule
 * expressions are a recorded M5 non-goal; do not add them here)
 *
 * - metadata: `name`, `version`, `description`
 * - per-column rules: declared-type expectation (`type`), `required`,
 *   `unique`, `min`/`max`, `allowed-values`, `regex`, `max-null-share`,
 *   `min-distinct-share`
 * - dataset rules: row-count bounds (`min-rows`/`max-rows`)
 *
 * Each rule carries intent only. The precise compiled semantics (SQL shape,
 * NULL handling, applicability of a rule to a column's actual type, RE2
 * dialect validation of `regex` patterns) are owned by the m5-1 compiler and
 * m5-2 engine — this module fixes the portable vocabulary and shape.
 *
 * ## YAML ↔ AST key map
 *
 * YAML is flat over metadata; the AST nests it. Both spellings below are
 * fixed by the canonical serializer (`serialize.ts`):
 *
 *   YAML (root)            AST
 *   -------------------------------------------------------
 *   format: v1             format: 'v1'
 *   name: …                metadata.name
 *   version: …             metadata.version
 *   description: …         metadata.description
 *   columns:               columns[]            (list of rule sets)
 *   dataset:               dataset              (rule set or absent)
 *
 *   YAML (inside a columns[] entry)   AST (ColumnRuleSet)
 *   -------------------------------------------------------
 *   name: …                           name
 *   type: …                           type
 *   required: true                    required
 *   unique: true                      unique
 *   min: … / max: …                   min / max
 *   allowed-values: […]               allowedValues
 *   regex: …                          regex
 *   max-null-share: …                 maxNullShare
 *   min-distinct-share: …             minDistinctShare
 *
 *   YAML (inside dataset)   AST (DatasetRuleSet)
 *   -------------------------------------------------------
 *   min-rows: …             minRows
 *   max-rows: …             maxRows
 *
 * ## Canonical normalization (parse input → AST)
 *
 * The parser normalizes semantically-empty rules so the AST has one shape
 * per meaning, and the canonical serializer can round-trip it exactly:
 *
 * - `columns` is **always** an array (possibly empty) — an absent or empty
 *   YAML `columns` key both yield `[]`.
 * - `required: false` / `unique: false` are the same thing as their absence,
 *   so a present-but-false boolean is normalized away: `required`/`unique`
 *   are only ever `true` when present.
 * - a rule-less `columns[]` entry (one carrying only `name` — e.g. `name: id`
 *   alone, or rules that all normalize away like `required: false`) also
 *   normalizes to absent: it constrains nothing, so dropping it keeps one
 *   shape per meaning and leaves the m5-1 compiler nothing to second-guess.
 *   It still participates in duplicate-name rejection — declaring a column
 *   twice is an authoring error even when one of the entries is empty.
 * - an empty `description: ''` and a rule-less `dataset: {}` normalize to
 *   absent (`undefined`).
 * - `allowed-values: []` is NOT normalized away: an empty allowed-values
 *   means "every non-NULL value fails" — a real (if degenerate) constraint,
 *   and the honest mapping target for an empty JSON Schema `enum` (m5-5).
 *
 * ## Rule semantics at a glance (intent only — m5-1 owns the compiled form)
 *
 * - `type` — the column's declared type must be this spelling. v1 spellings
 *   come from the closed {@link CONTRACT_TYPE_VOCABULARY} (see
 *   `vocabulary.ts`); parameterized/nested expectations are a v1 non-goal.
 * - `required` — the column must not contain NULLs.
 * - `unique` — the column's non-NULL values must be distinct.
 * - `min`/`max` — numeric bounds on the value (both bound the same
 *   comparison space; `min ≤ max` is enforced at validation time). Rule
 *   numbers are carried as exact JavaScript numbers: a literal the parse
 *   would silently alter (e.g. a 17th-significant-digit integer) is a typed
 *   parse error (`imprecise-number`), never a quietly rounded bound — the
 *   vocabulary includes `BIGINT`/`HUGEINT`, so precision honesty matters.
 * - `allowed-values` — the value must be one of the listed scalars.
 * - `regex` — the value must match the pattern. The pattern string is
 *   carried **verbatim**; v1 targets DuckDB's RE2 dialect, and dialect
 *   validation is a binding error owned by m5-1 (an RE2 check cannot be
 *   faked with a JS RegExp without lying about the dialect). Nothing is
 *   rejected here for dialect reasons; only the value's type is checked.
 * - `max-null-share` — share of NULLs must be ≤ this number ([0, 1]).
 * - `min-distinct-share` — share of distinct non-NULL values must be ≥ this
 *   number ([0, 1]).
 * - `minRows`/`maxRows` — bounds on the dataset's row count.
 *
 * Purity: types + total helpers only — no React, no browser APIs, no engine
 * or `@assay/*` imports (docs/engineering/05-repository-structure.md §3,
 * lint-enforced).
 */

import type { ContractTypeSpelling } from './vocabulary'

/** The only supported contract format version (recorded M5 non-goal: no versioning beyond this). */
export const CONTRACT_FORMAT = 'v1'

/** The literal format discriminator carried by every {@link ContractV1}. */
export type ContractFormat = typeof CONTRACT_FORMAT

/** Metadata identifying the contract itself (YAML: flat `name`/`version`/`description`). */
export interface ContractMetadata {
  /**
   * Human-chosen identifier used by reports and cross-surface agreement
   * (m5-6). Non-empty; any text.
   */
  readonly name: string
  /** The contract's own revision. A positive safe integer (not the format version — see {@link ContractFormat}). */
  readonly version: number
  /** Optional free-text description; `''` normalizes to absent (see module doc). */
  readonly description?: string
}

/**
 * A scalar usable in `allowed-values`. Objects, arrays and null are not
 * scalar rules in v1; NULL is deliberately excluded — nullness is governed
 * by `required`/`max-null-share`, never by membership in a value list.
 */
export type ContractScalar = string | number | boolean

/**
 * All rules declared for one named column. Every field except `name` is an
 * optional rule; each rule kind may appear at most once per column (the
 * YAML format has no way to repeat one — duplicate keys are rejected — and
 * the AST fields are singular by construction). Duplicate column *names*
 * are rejected too: one contract v1 addresses each column with one rule set.
 */
export interface ColumnRuleSet {
  /** The dataset column this rule set addresses. Non-empty; any text. */
  readonly name: string
  /**
   * Declared-type expectation. The closed v1 vocabulary is enforced twice:
   * at the type level ({@link ContractTypeSpelling}, so programmatically
   * constructed ASTs cannot drift) and at parse time (`unknown-type` errors
   * against {@link CONTRACT_TYPE_VOCABULARY}).
   */
  readonly type?: ContractTypeSpelling
  /** The column must not contain NULLs. Only ever `true` when present. */
  readonly required?: true
  /** Non-NULL values must be distinct. Only ever `true` when present. */
  readonly unique?: true
  /** Inclusive lower bound for the value. Any finite number. */
  readonly min?: number
  /** Inclusive upper bound for the value; `min ≤ max` is validated. Any finite number. */
  readonly max?: number
  /** The value must be one of these scalars. May be empty (see module doc). */
  readonly allowedValues?: readonly ContractScalar[]
  /**
   * The value must match this pattern. Carried verbatim — RE2 (DuckDB's
   * regex dialect) validity is a binding error owned by m5-1, not here
   * (see module doc). An empty pattern is valid RE2 (matches everything).
   */
  readonly regex?: string
  /** Share of NULLs must be ≤ this. A finite number in [0, 1]. */
  readonly maxNullShare?: number
  /** Share of distinct non-NULL values must be ≥ this. A finite number in [0, 1]. */
  readonly minDistinctShare?: number
}

/** Dataset-level rules (YAML: the `dataset` mapping). Present only when at least one rule is set. */
export interface DatasetRuleSet {
  /** Row count must be ≥ this. A non-negative safe integer. */
  readonly minRows?: number
  /** Row count must be ≤ this; `minRows ≤ maxRows` is validated. A non-negative safe integer. */
  readonly maxRows?: number
}

/**
 * A parsed, validated v1 contract — the canonical meaning of a contract
 * document. Produced only by `parseContract` (which guarantees the
 * vocabulary/normalization invariants documented in this module); consumed
 * by the m5-1 compiler. `format` is the literal `'v1'`.
 */
export interface ContractV1 {
  readonly format: ContractFormat
  readonly metadata: ContractMetadata
  /** One rule set per addressed column; always an array (possibly empty). */
  readonly columns: readonly ColumnRuleSet[]
  /** Dataset-level rules; absent when none are declared. */
  readonly dataset?: DatasetRuleSet
}
