// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Validation report model (m5-3) — the pure half of the web validation
 * panel: per-rule report rows, the documented severity ordering, the
 * bounded-set honesty decision, the filter-to-failures predicate mapping,
 * logical-row-key resolution, and the canonical text renderings the panel
 * and the report export share.
 *
 * Everything here is total and side-effect-free (Node-testable); the React
 * panel and the App wiring only consume it. Dataset values appear ONLY as
 * opaque text payloads handed upward — they are never logged anywhere
 * (ADR 0025), and nothing here produces HTML (values render as React text).
 *
 * ## Severity ordering (the documented, deterministic report order)
 *
 * The engine returns per-rule results in plan order (the contract's
 * canonical rule order). The panel presents a *severity* order instead —
 * problems first, most-shared problems first — defined as, in priority
 * order:
 *
 * 1. Failing rules (`failCount > 0`) sort before passing rules. The report
 *    leads with the work to do; passing rules are the honest zero-state
 *    tail ("0 violations" per rule).
 * 2. Dataset-fact rules sort before row-samples rules within each group —
 *    structural facts about the whole dataset (declared type, row-count
 *    bounds) read as more fundamental than per-cell violations.
 * 3. Higher frozen-integer `failPercent` first (the m5-2 half-up contract —
 *    rendered verbatim, never recomputed).
 * 4. `ruleId` ascending by code-unit order as the total tiebreak
 *    (the m5-0 error-path grammar — `columns[1].allowed-values` sorts
 *    before `columns[1].required`), so the order is fully deterministic
 *    regardless of contract authoring order.
 *
 * Pinned by unit tests and by both e2e journeys.
 *
 * ## Filter-to-failures honesty rule
 *
 * The engine returns at most `min(K, 100)` sample failures per rule. A
 * "show only failing rows" grid filter is offered for a failing
 * row-samples rule ONLY when the sample set is COMPLETE
 * (`failCount ≤ samplesReturned` — every violating row is in the list) AND
 * the rule's violation semantics are expressible as a single-column m2-2
 * filter predicate. Otherwise the control renders disabled with honest
 * copy; exporting the report is always available. The predicate mapping
 * mirrors the m5-1 compiler's documented violation predicates
 * (`violationPredicate` in `@assay/validation`'s compile module) through
 * the SAME exported literal/identifier helpers, so filtered rows equal the
 * reported failing rows; `unique` and the share rules are window/aggregate
 * semantics with no single-column predicate and are refused honestly
 * rather than approximated.
 */
import type { ColumnRuleSet, ContractError, ContractV1 } from '@assay/contracts'
import type { OverlayBase, OverlayState, RowId } from '@assay/domain'
import { effectiveRowIds, parseRowId } from '@assay/domain'
import type { EngineValidationPlan, EngineValidationResult } from '@assay/engine-duckdb'
import { quoteIdentifier, sqlNumberLiteral, sqlStringLiteral } from '@assay/validation'

/** One offending row of a failing rule, as the panel shows it. */
export interface ValidationSampleRow {
  /**
   * The engine's logical row key (`base:<anchor>#<ordinal>` /
   * `ins:<anchor>#<seq>`) — the targeting identity used for jump-to-row.
   * The anchor token inside it is NEVER rendered or exported (m4-3
   * discipline); `displayKey`/`exportKey` carry the anchor-free forms.
   */
  readonly rowKey: string
  /** Anchor-free human form: `base #12` / `insert #3` / `unknown row`. */
  readonly displayKey: string
  /** Anchor-free export form: `base:12` / `insert:3` / `unknown`. */
  readonly exportKey: string
  /** The offending value as the engine normalized it (wire-safe JSON). */
  readonly value: string | number | boolean | null
  /** Canonical text rendering for the panel (see {@link sampleValueText}). */
  readonly valueText: string
}

/** How the "show only failing rows" control is offered for one rule. */
export type FailureFilterState =
  | { readonly kind: 'clean' }
  | { readonly kind: 'unavailable' }
  /**
   * The sample list is partial: filtering the grid to the known samples
   * could hide unfound violations. Disabled with copy that points at the
   * report export (which is always available).
   */
  | { readonly kind: 'partial'; readonly samplesReturned: number; readonly failCount: number }
  /**
   * The sample set is complete but the rule's semantics (duplicates, value
   * shares, NULL shares, dataset facts) have no single-column predicate.
   */
  | { readonly kind: 'not-expressible' }
  /** Ready: `predicate` is the m2-2 fragment for `column` (see module doc). */
  | { readonly kind: 'ready'; readonly predicate: string }

/** One per-rule report row, severity-ordered by {@link compareReportRules}. */
export interface ValidationReportRow {
  readonly ruleId: string
  /** Constrained column name; `null` for dataset-level rules. */
  readonly column: string | null
  /** The plan rule kind (m5-1 vocabulary), or `'unknown'` defensively. */
  readonly kind: string
  /** Human label (see {@link ruleLabel}); presentation only. */
  readonly label: string
  readonly failCount: number
  /** The engine's frozen integer half-up share — rendered, never recomputed. */
  readonly failPercent: number
  readonly failing: boolean
  /** `'row-samples'` rules carry samples; `'dataset-fact'` rules never do. */
  readonly outcome: 'row-samples' | 'dataset-fact' | 'unknown'
  readonly samples: readonly ValidationSampleRow[]
  /** `true` when every violating row is in `samples` (bounded-set gate). */
  readonly samplesComplete: boolean
  /** declared-type rules only: the contract's expected type spelling. */
  readonly expectedType?: string
  /** declared-type rules only: the dataset's actual type spelling. */
  readonly actualType?: string
  readonly filter: FailureFilterState
}

/** A full report: the verdict plus its severity-ordered rows. */
export interface ValidationReport {
  readonly valid: boolean
  /** Effective row count the verdict ran against (echoed into exports). */
  readonly rowCount: number
  readonly rows: readonly ValidationReportRow[]
}

/** Human label per rule kind (presentation only; the id stays authoritative). */
const RULE_LABELS: Readonly<Record<string, string>> = {
  'declared-type': 'Declared type',
  required: 'Required (no NULLs)',
  unique: 'Unique values',
  min: 'Minimum bound',
  max: 'Maximum bound',
  'allowed-values': 'Allowed values',
  regex: 'Pattern (RE2 full match)',
  'max-null-share': 'Maximum NULL share',
  'min-distinct-share': 'Minimum distinct share',
  'min-rows': 'Minimum row count',
  'max-rows': 'Maximum row count',
}

/** Label for a rule kind; unknown kinds degrade honestly. */
export function ruleLabel(kind: string): string {
  return RULE_LABELS[kind] ?? 'Rule'
}

/**
 * Canonical text rendering of a wire-normalized sample value for the panel
 * and exports. NULL renders as the explicit text `NULL` (never an empty
 * string — an empty string is a real VARCHAR value and the two must stay
 * distinguishable in a text-only report). Everything else renders through
 * the grid's total text formatter (m4-4b canonical rendering: numbers as
 * their exact shortest form, booleans as `true`/`false`, strings verbatim).
 */
export function sampleValueText(value: string | number | boolean | null): string {
  if (value === null) return 'NULL'
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  return String(value)
}

/**
 * Anchor-free display form of a logical row key. The anchor token inside a
 * row key is a host-derived file-version fingerprint and is never rendered
 * (m4-3 discipline); the ordinal/sequence is the part a human needs.
 * Unparsable keys cannot occur from the engine (it guarantees resolvable
 * keys) and degrade to `unknown row` rather than echo the raw token.
 */
export function displayRowKey(rowKey: string): string {
  const parsed = parseRowId(rowKey as RowId)
  if (parsed === null) return 'unknown row'
  return parsed.origin === 'base'
    ? `base #${String(parsed.ordinal)}`
    : `insert #${String(parsed.seq)}`
}

/**
 * Anchor-free export form of a logical row key (`base:<ordinal>` /
 * `insert:<seq>`); stable enough to join back against the source data
 * without carrying the anchor fingerprint into an exported file.
 */
export function exportRowKey(rowKey: string): string {
  const parsed = parseRowId(rowKey as RowId)
  if (parsed === null) return 'unknown'
  return parsed.origin === 'base'
    ? `base:${String(parsed.ordinal)}`
    : `insert:${String(parsed.seq)}`
}

/** The severity ordering — the module doc's four clauses, as one compare. */
export function compareReportRules(a: ValidationReportRow, b: ValidationReportRow): number {
  // 1. Failing before passing.
  const aFailing = a.failCount > 0 ? 0 : 1
  const bFailing = b.failCount > 0 ? 0 : 1
  if (aFailing !== bFailing) return aFailing - bFailing
  // 2. Dataset facts before per-row rules.
  const aFact = a.outcome === 'dataset-fact' ? 0 : 1
  const bFact = b.outcome === 'dataset-fact' ? 0 : 1
  if (aFact !== bFact) return aFact - bFact
  // 3. Higher frozen share first.
  if (a.failPercent !== b.failPercent) return b.failPercent - a.failPercent
  // 4. ruleId ascending (code-unit order) — the total tiebreak.
  if (a.ruleId < b.ruleId) return -1
  if (a.ruleId > b.ruleId) return 1
  return 0
}

/**
 * The m5-0 rule-id grammar as a match: `columns[<index>].<rule>` with the
 * rule spellings exactly as the wire's grammar fixes them (the same set the
 * engine's plan gate enforces). `dataset.<rule>` ids have no contract entry.
 */
const COLUMN_RULE_ID_PATTERN =
  /^columns\[(\d+)\]\.(type|required|unique|min|max|allowed-values|regex|max-null-share|min-distinct-share)$/

export interface ContractRuleRef {
  readonly entry: ColumnRuleSet
  /** The rule key spelling (the m5-0 YAML key). */
  readonly key: string
}

/**
 * Resolve a plan `ruleId` to its contract rule set entry + rule key, so the
 * filter predicate can read the rule's authored bound/list/pattern. Returns
 * `null` for dataset rules and for ids that do not resolve (defensive —
 * the compiler guarantees the grammar for every planned rule).
 */
export function contractRuleFor(ruleId: string, contract: ContractV1): ContractRuleRef | null {
  const match = COLUMN_RULE_ID_PATTERN.exec(ruleId)
  if (match === null) return null
  const index = Number(match[1])
  const entry = contract.columns[index]
  if (entry === undefined) return null
  return { entry, key: match[2] }
}

/**
 * The m2-2 filter predicate selecting a rule's violating rows — the exact
 * mirror of the m5-1 compiler's violation predicate (`violationPredicate`),
 * rendered as a fragment the engine composes as `("<column>" <fragment>)`
 * and built from the SAME exported literal helpers, so literal spellings
 * (and therefore filtered rows) match the plan exactly:
 *
 * - required        → `IS NULL`
 * - min v           → `< v`
 * - max v           → `> v`
 * - allowed-values  → `IS NOT NULL AND "col" NOT IN (…)` (`IS NOT NULL`
 *                     when the list is empty — every non-NULL value fails)
 * - regex p         → `IS NOT NULL AND NOT regexp_full_match("col", 'p')`
 *
 * NULL semantics match the compiler by construction: value rules are
 * NULL-passing, so the mirror re-states the same IS NOT NULL guards. Only
 * these five kinds have a single-column predicate; everything else (unique,
 * the share rules, dataset facts) returns `null` — the caller must present
 * that honestly, never approximate it.
 */
export function failureFilterPredicate(ref: ContractRuleRef, column: string): string | null {
  const quoted = quoteIdentifier(column)
  switch (ref.key) {
    case 'required':
      return 'IS NULL'
    case 'min':
      return typeof ref.entry.min === 'number' ? `< ${sqlNumberLiteral(ref.entry.min)}` : null
    case 'max':
      return typeof ref.entry.max === 'number' ? `> ${sqlNumberLiteral(ref.entry.max)}` : null
    case 'allowed-values': {
      const values = ref.entry.allowedValues
      if (!Array.isArray(values)) return null
      if (values.length === 0) return 'IS NOT NULL'
      const literals = values.map((value) =>
        typeof value === 'string'
          ? sqlStringLiteral(value)
          : typeof value === 'boolean'
            ? value
              ? 'TRUE'
              : 'FALSE'
            : sqlNumberLiteral(value),
      )
      return `IS NOT NULL AND ${quoted} NOT IN (${literals.join(', ')})`
    }
    case 'regex':
      return typeof ref.entry.regex === 'string'
        ? `IS NOT NULL AND NOT regexp_full_match(${quoted}, ${sqlStringLiteral(ref.entry.regex)})`
        : null
    default:
      return null
  }
}

/**
 * The bounded-set + expressibility decision for one rule's filter control
 * (see the module doc's honesty rule). `contract` may be `null` only when
 * no contract is in scope — impossible for a rendered report row; treated
 * as not-expressible defensively.
 */
export function failureFilterState(
  ruleId: string,
  outcome: string,
  failing: boolean,
  failCount: number,
  samplesReturned: number,
  column: string | null,
  contract: ContractV1 | null,
): FailureFilterState {
  if (!failing || outcome !== 'row-samples') return { kind: 'clean' }
  if (failCount > samplesReturned) {
    return { kind: 'partial', samplesReturned, failCount }
  }
  const ref = contract === null ? null : contractRuleFor(ruleId, contract)
  const predicate = ref !== null && column !== null ? failureFilterPredicate(ref, column) : null
  if (predicate === null) return { kind: 'not-expressible' }
  return { kind: 'ready', predicate }
}

/** Partial-state copy — the honest wording the panel renders when disabled. */
export function partialFilterCopy(samplesReturned: number, failCount: number): string {
  return (
    `Sample is partial — ${String(samplesReturned)} of ${String(failCount)} violations were ` +
    'returned, so filtering could hide unfound ones. Export the failure report instead.'
  )
}

/** Not-expressible copy — the honest wording for aggregate-shaped rules. */
export const NOT_EXPRESSIBLE_FILTER_COPY =
  'These violations have no single-column filter (duplicate or share semantics). ' +
  'Use “Show row” to visit each one, or export the failure report.'

/**
 * Build the severity-ordered report from a compiled plan, its engine result,
 * and the contract the plan came from (needed for filter predicates).
 * Total over the result the engine's client returns; defensively tolerant
 * of plan/result misalignment (a result rule with no plan rule degrades to
 * an `unknown` row rather than throwing).
 */
export function buildValidationReport(
  plan: EngineValidationPlan,
  result: EngineValidationResult,
  contract: ContractV1 | null,
): ValidationReport {
  const planByRuleId = new Map<string, EngineValidationPlan['rules'][number]>()
  for (const rule of plan.rules) planByRuleId.set(rule.ruleId, rule)
  const rows: ValidationReportRow[] = result.rules.map((ruleResult) => {
    const planRule = planByRuleId.get(ruleResult.ruleId)
    const kind = planRule?.kind ?? 'unknown'
    const outcome =
      planRule?.outcome === 'dataset-fact' || planRule?.outcome === 'row-samples'
        ? planRule.outcome
        : ('unknown' as const)
    const failing = ruleResult.failCount > 0
    const samples: ValidationSampleRow[] = ruleResult.sampleFailures.map((sample) => ({
      rowKey: sample.rowKey,
      displayKey: displayRowKey(sample.rowKey),
      exportKey: exportRowKey(sample.rowKey),
      value: sample.value,
      valueText: sampleValueText(sample.value),
    }))
    // Bounded-set honesty: the sample set is complete when the engine
    // returned at least as many samples as it counted violations (the
    // engine clamps at min(K, 100), so `>` can only mean a misbehaving
    // engine — still read as complete for the gate; the counts themselves
    // are the report's content).
    const samplesComplete = ruleResult.failCount <= ruleResult.sampleFailures.length
    const filter = failureFilterState(
      ruleResult.ruleId,
      outcome,
      failing,
      ruleResult.failCount,
      ruleResult.sampleFailures.length,
      planRule?.column ?? null,
      contract,
    )
    return {
      ruleId: ruleResult.ruleId,
      column: planRule?.column ?? null,
      kind,
      label: ruleLabel(kind),
      failCount: ruleResult.failCount,
      failPercent: ruleResult.failPercent,
      failing,
      outcome,
      samples,
      samplesComplete,
      ...(planRule?.expectedType === undefined ? {} : { expectedType: planRule.expectedType }),
      ...(planRule?.actualType === undefined ? {} : { actualType: planRule.actualType }),
      filter,
    }
  })
  rows.sort(compareReportRules)
  return { valid: result.valid, rowCount: result.rowCount, rows }
}

/**
 * Count the rules a contract declares (one per present rule key), so the
 * panel can show "N rules" before the first run — the same count a
 * successful compile plans (the m5-1 compiler plans exactly one rule per
 * declared rule, with no silent skips).
 */
export function contractRuleCount(contract: ContractV1): number {
  let count = 0
  for (const entry of contract.columns) {
    for (const key of [
      'type',
      'required',
      'unique',
      'min',
      'max',
      'allowedValues',
      'regex',
      'maxNullShare',
      'minDistinctShare',
    ] as const) {
      if (entry[key] !== undefined) count += 1
    }
  }
  const dataset = contract.dataset
  if (dataset !== undefined) {
    if (dataset.minRows !== undefined) count += 1
    if (dataset.maxRows !== undefined) count += 1
  }
  return count
}

/**
 * Where a logical row key sits in the CURRENT effective view, for
 * jump-to-row. Fast path: a base row with no tombstones and no live inserts
 * keeps its base ordinal as the effective index (the provider's documented
 * base-path equivalence). Otherwise the domain's `effectiveRowIds` order is
 * materialized once per resolution — a bounded, user-gesture-path cost that
 * reuses the domain's own linearization instead of re-deriving it.
 */
export type RowKeyResolution =
  { readonly kind: 'resolved'; readonly rowIndex: number } | { readonly kind: 'missing' }

export function resolveRowKeyIndex(
  base: OverlayBase,
  state: OverlayState,
  rowKey: string,
): RowKeyResolution {
  const parsed = parseRowId(rowKey as RowId)
  if (parsed === null) return { kind: 'missing' }
  let liveInserts = 0
  for (const record of state.inserts.values()) {
    if (record.live) liveInserts += 1
  }
  if (parsed.origin === 'base') {
    if (state.deletedBase.size === 0 && liveInserts === 0) {
      return parsed.ordinal < base.baseRowCount
        ? { kind: 'resolved', rowIndex: parsed.ordinal }
        : { kind: 'missing' }
    }
  }
  const indexByKey = new Map<string, number>()
  const ids = effectiveRowIds(base, state)
  for (let index = 0; index < ids.length; index++) indexByKey.set(ids[index] as string, index)
  const rowIndex = indexByKey.get(rowKey)
  return rowIndex === undefined ? { kind: 'missing' } : { kind: 'resolved', rowIndex }
}

/**
 * Parse errors surface with their line/column as report content
 * (`validation-parse-error` rows); this helper renders one canonical line.
 * The message text comes from the m5-0 parser's typed errors — it never
 * echoes dataset content (a contract is authored text, and the parser's
 * messages quote only the contract's own structure).
 */
export function formatContractParseError(error: ContractError): string {
  return `line ${String(error.line)}, column ${String(error.column)}: ${error.message}`
}
