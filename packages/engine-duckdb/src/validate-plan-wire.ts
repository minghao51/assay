/**
 * Structural validation for validation plans crossing the worker boundary
 * (m5-2). The `engine/validate` request carries a compiled m5-1
 * `ValidationPlan` (`@assay/validation`) as plain structured-clone data; the
 * worker is the **second gate, not the first**: the plan's SQL is
 * compiler-generated and golden-pinned upstream, and this module asserts the
 * *shape* the compiler guarantees before any of it reaches the engine —
 * mirroring the m4-2 overlay-wire discipline (`overlay-wire.ts`).
 *
 * What is checked here is *structure only*:
 * - the plan discriminator (`planKind`/`planVersion`) must be exactly the
 *   v1 pair the compiler emits — a different (or future) plan is not this
 *   protocol's payload and is rejected, never guessed at;
 * - every rule carries the closed v1 kind/outcome vocabularies, string SQL,
 *   and a unique `ruleId` (results are keyed by it — duplicates would make
 *   the result map ambiguous, so a duplicate is a malformed plan);
 * - `sampleLimit` is a safe integer ≥ 1 (the plan contract: `LIMIT 0` could
 *   not distinguish a violated rule from a clean one). There is deliberately
 *   **no upper bound here** — the compiler accepts any safe K — but the
 *   executor clamps the *returned samples* to its documented hard max
 *   (`VALIDATION_SAMPLE_HARD_MAX` in `validate-query.ts`);
 * - `relation` is a non-empty NUL-free bounded string: it becomes the name of
 *   the engine-created view the plan executes against (see
 *   `validate-query.ts`), so the bound keeps a hostile name from being a
 *   memory/abuse vector while any legal identifier still binds.
 * - SQL strings are bounded (compiler output for realistic contracts is
 *   orders of magnitude smaller) so a hostile host cannot post megabytes of
 *   SQL as a shape-valid request.
 *
 * Beyond shape, {@link assertValidationPlanRelationBinding} enforces the one
 * structural invariant of the compiler's *rendering* the executor relies on:
 * the quoted relation name may appear in plan SQL **only** in the FROM
 * positions the compiler emits (`FROM "<rel>" AS "src"` /
 * `(SELECT count(*) FROM "<rel>")`). Any other occurrence — the signature of
 * SQL smuggled through the relation-name position — is a typed rejection
 * before execution. A rule *value* that legitimately embeds that exact text
 * is therefore also rejected (fail-closed; documented in the m5-2 report).
 *
 * The mirror discipline is the same as the m2-2 filter/sort and m2-5 profile
 * mirrors: shapes are re-declared here (no engine → validation dependency),
 * and drift is caught at runtime because the conformance scenario executes
 * **real compiler output** through this boundary (packages/testing).
 */

/** Discriminator carried by every v1 plan (mirror of m5-1's `PLAN_KIND`). */
const PLAN_KIND = 'assay-validation-plan'

/** The only plan version this protocol accepts (mirror of m5-1's `PLAN_VERSION`). */
const PLAN_VERSION = 1

/** The closed v1 rule-kind vocabulary (mirror of m5-1's `ValidationRuleKind`). */
const RULE_KINDS: ReadonlySet<string> = new Set([
  'declared-type',
  'required',
  'unique',
  'min',
  'max',
  'allowed-values',
  'regex',
  'max-null-share',
  'min-distinct-share',
  'min-rows',
  'max-rows',
])

/** The closed outcome vocabulary (mirror of m5-1's `RuleOutcomeShape`). */
const OUTCOMES: ReadonlySet<string> = new Set(['row-samples', 'dataset-fact'])

/** Maximum length of a bounded plan string field (names, ids, paths). */
const MAX_NAME_LENGTH = 256

/** Maximum length of the relation binding name. */
const MAX_RELATION_LENGTH = 128

/** Maximum length of one compiled SQL string (per-rule query or summary). */
const MAX_SQL_LENGTH = 100_000

/** Maximum length of a column attribution name. */
const MAX_COLUMN_LENGTH = 512

/**
 * One compiled rule as the wire carries it (structural mirror of m5-1's
 * `PlannedRule`; the compiler's output assigns to this shape directly).
 */
export interface EngineValidationRule {
  readonly ruleId: string
  readonly path: string
  readonly kind: string
  readonly column: string | null
  readonly outcome: string
  readonly sql: string
  readonly expectedType?: string
  readonly actualType?: string
}

/**
 * A compiled validation plan as the wire carries it (structural mirror of
 * m5-1's `ValidationPlan`). `relation` is the binding name: the executor
 * materializes the target's effective view under exactly this name, so the
 * plan's FROM clauses resolve to the composed relation.
 */
export interface EngineValidationPlan {
  readonly planKind: string
  readonly planVersion: number
  readonly contractName: string
  readonly contractVersion: number
  readonly relation: string
  readonly sampleLimit: number
  readonly rules: readonly EngineValidationRule[]
  readonly summarySql: string
}

/** One offending row of a failing rule, carried to the report surface. */
export interface EngineValidationSample {
  /**
   * The logical row id of the offending row in the composed effective view
   * (`base:<anchor>#<ordinal>` / `ins:<anchor>#<seq>` — the m4-3 row-key
   * grammar), NOT a bare position: hosts target rows with it directly.
   * `null` is never produced by the executor (a resolvable key is part of
   * the result contract); the `null` spelling exists so older payloads stay
   * parseable.
   */
  readonly rowKey: string | null
  /**
   * The offending value, normalized to wire-safe JSON data (see
   * `normalizeSampleValue` in `validate-query.ts`): string, finite number,
   * boolean, or null. Values are report *content* — they are never logged
   * or telemetried anywhere (ADR 0025).
   */
  readonly value: string | number | boolean | null
}

/** Per-rule result (the m5-2 result contract). */
export interface EngineValidationRuleResult {
  /** The plan's `ruleId` (m5-0 error-path spelling). */
  readonly ruleId: string
  /** Violating rows; the executed plan's own count (see the plan contract). */
  readonly failCount: number
  /**
   * `failCount` as an integer percentage of the effective row count,
   * **rounded half-up to the nearest integer** via exact integer arithmetic:
   * `floor((failCount * 200 + rowCount) / (2 * rowCount))` — the written
   * definition m5-4 (CLI) and m5-6 (cross-surface agreement) pin against. An
   * empty dataset (rowCount 0) defines `failPercent = 0` (no rows fail;
   * the ratio itself is undefined there).
   */
  readonly failPercent: number
  /**
   * Bounded sample failures: at most `min(plan.sampleLimit, the engine's
   * documented hard max)` entries, each carrying the offending row's key and
   * value. Empty for `dataset-fact` rules (no row samples exist).
   */
  readonly sampleFailures: readonly EngineValidationSample[]
}

/** Full result of `engine/validate` (plain JSON-able data; no Arrow). */
export interface EngineValidationResult {
  /** Total verdict: `true` iff every planned rule reported failCount 0. */
  readonly valid: boolean
  /**
   * The effective row count the plan executed against (the composed view's
   * `count(*)` — base rows minus tombstones plus live inserts).
   */
  readonly rowCount: number
  /** One entry per planned rule, in plan order. */
  readonly rules: readonly EngineValidationRuleResult[]
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= max
}

function isPlanSqlString(value: unknown): value is string {
  return isBoundedString(value, MAX_SQL_LENGTH)
}

function isRelationName(value: unknown): value is string {
  return isBoundedString(value, MAX_RELATION_LENGTH) && !value.includes('\u0000')
}

/** Parse one planned rule; `null` when malformed (never a throw). */
function parseValidationRule(value: unknown): EngineValidationRule | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (!isBoundedString(record['ruleId'], MAX_NAME_LENGTH)) return null
  if (!isBoundedString(record['path'], MAX_NAME_LENGTH)) return null
  const kind = record['kind']
  if (typeof kind !== 'string' || !RULE_KINDS.has(kind)) return null
  const column = record['column']
  if (column !== null && !isBoundedString(column, MAX_COLUMN_LENGTH)) return null
  const outcome = record['outcome']
  if (typeof outcome !== 'string' || !OUTCOMES.has(outcome)) return null
  if (!isPlanSqlString(record['sql'])) return null
  const expectedType = record['expectedType']
  if (expectedType !== undefined && !isBoundedString(expectedType, MAX_NAME_LENGTH)) return null
  const actualType = record['actualType']
  if (actualType !== undefined && !isBoundedString(actualType, MAX_NAME_LENGTH)) return null
  return {
    ruleId: record['ruleId'],
    path: record['path'],
    kind,
    column: column as string | null,
    outcome,
    sql: record['sql'],
    ...(expectedType === undefined ? {} : { expectedType: expectedType as string }),
    ...(actualType === undefined ? {} : { actualType: actualType as string }),
  }
}

/**
 * Parse a validation plan from boundary data. Returns `null` for anything
 * structurally malformed (the protocol layer then answers the recognised
 * request with exactly one typed `engine/error`) — never a throw. The plan
 * is copied into fresh plain objects: a request can never keep a reference
 * into worker state.
 */
export function parseValidationPlan(value: unknown): EngineValidationPlan | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (record['planKind'] !== PLAN_KIND) return null
  if (record['planVersion'] !== PLAN_VERSION) return null
  if (!isBoundedString(record['contractName'], MAX_NAME_LENGTH)) return null
  const contractVersion = record['contractVersion']
  if (typeof contractVersion !== 'number' || !Number.isSafeInteger(contractVersion)) return null
  if (contractVersion < 1) return null
  if (!isRelationName(record['relation'])) return null
  const sampleLimit = record['sampleLimit']
  if (typeof sampleLimit !== 'number' || !Number.isSafeInteger(sampleLimit) || sampleLimit < 1) {
    return null
  }
  const rawRules = record['rules']
  if (!Array.isArray(rawRules)) return null
  const rules: EngineValidationRule[] = []
  const seen = new Set<string>()
  for (const rawRule of rawRules) {
    const rule = parseValidationRule(rawRule)
    if (rule === null) return null
    if (seen.has(rule.ruleId)) return null // results key by ruleId: duplicates are malformed
    seen.add(rule.ruleId)
    rules.push(rule)
  }
  if (!isPlanSqlString(record['summarySql'])) return null
  return {
    planKind: PLAN_KIND,
    planVersion: PLAN_VERSION,
    contractName: record['contractName'],
    contractVersion,
    relation: record['relation'],
    sampleLimit,
    rules,
    summarySql: record['summarySql'],
  }
}

/**
 * The compiler's exact FROM renderings of the relation binding: the quoted
 * name is always preceded by `FROM ` and always followed by either the range
 * alias (` AS "src"`) or the closing parenthesis of the scalar count
 * subquery (`(SELECT count(*) FROM "<rel>")`). Anything else — an occurrence
 * in any other position — is not compiler output.
 */
function relationOccurrencesMatchCompilerShape(sql: string, quotedRelation: string): boolean {
  let cursor = 0
  for (;;) {
    const index = sql.indexOf(quotedRelation, cursor)
    if (index < 0) break
    const from = index - 'FROM '.length
    if (from < 0 || sql.slice(from, index) !== 'FROM ') return false
    const after = sql.slice(index + quotedRelation.length)
    if (!after.startsWith(` AS "src"`) && !after.startsWith(')')) return false
    cursor = index + quotedRelation.length
  }
  // Zero occurrences is fine (e.g. the empty summary of a rule-less plan).
  return true
}

/**
 * The executor-side semantic checks beyond wire shape (typed `Error`s — the
 * request is recognised, so these surface as exactly one typed
 * `engine/error`, never a silent drop):
 *
 * 1. **No clobbering** — the binding name must not equal the registered view
 *    of ANY open table (a hostile plan naming `assay_t1` must be rejected
 *    before a `CREATE VIEW` could shadow the base view; the executor also
 *    uses bare `CREATE VIEW`, so any other catalog collision fails the
 *    create without touching the existing object).
 * 2. **Compiler-shaped relation references** — every occurrence of the
 *    quoted relation in the plan's SQL must sit in one of the compiler's
 *    FROM positions (see {@link relationOccurrencesMatchCompilerShape}).
 *    This is the second-gate invariant: SQL smuggled through the
 *    relation-name position cannot reach execution.
 *
 * The error messages name the failure class only — never plan content, rule
 * values, or dataset contents (ADR 0025).
 */
export function assertValidationPlanRelationBinding(
  plan: EngineValidationPlan,
  registeredViewNames: readonly string[],
): void {
  if (registeredViewNames.includes(plan.relation)) {
    throw new Error(
      'validation plan relation collides with a registered table view; refusing to shadow it',
    )
  }
  const quoted = quotedRelationToken(plan.relation)
  for (const rule of plan.rules) {
    if (!relationOccurrencesMatchCompilerShape(rule.sql, quoted)) {
      throw new Error(
        `validation plan rule '${rule.ruleId}' does not bind its relation in the compiler's FROM shape`,
      )
    }
  }
  if (!relationOccurrencesMatchCompilerShape(plan.summarySql, quoted)) {
    throw new Error('validation plan summary does not bind its relation in the compiler FROM shape')
  }
}

/** The plan SQL's quoted rendering of the relation name (compiler's `q(rel)`). */
export function quotedRelationToken(relation: string): string {
  return '"' + relation.replaceAll('"', '""') + '"'
}
