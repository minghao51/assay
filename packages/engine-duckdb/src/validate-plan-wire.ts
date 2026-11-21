// SPDX-License-Identifier: AGPL-3.0-or-later

import { quotedIdentifier } from './format-view.js'

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
 *   the result map ambiguous, so a duplicate is a malformed plan). The
 *   `ruleId` must match the **m5-0 rule-id grammar** — the compiler's
 *   error-path spelling `columns[<index>].<rule>` / `dataset.<rule>` (m5-2
 *   round-3 fix, W1): engine failure classes interpolate the id, so the
 *   interpolation can only ever carry compiler-shaped text, never arbitrary
 *   plan content;
 * - `sampleLimit` is a safe integer ≥ 1 (the plan contract: `LIMIT 0` could
 *   not distinguish a violated rule from a clean one). ANY such K is
 *   accepted — m5-2 round-3 fix (orchestrator adjudication: CLAMP, don't
 *   reject): the executor executes every rule query as
 *   `SELECT * FROM (<exact rule SQL>) LIMIT min(K, VALIDATION_SAMPLE_HARD_MAX)`,
 *   so the rows RETURNED are bounded by the hard max while the inner query
 *   still computes the rule's FULL violation count (the window scan is
 *   inherent to `failCount` semantics — documented materialization
 *   semantics: the returned rows are clamped, the count never is);
 *   `sampleFailures ≤ min(K, hard max)` holds literally for every safe K;
 * - `relation` is a non-empty NUL-free bounded string: it becomes the name of
 *   the engine-created view the plan executes against (see
 *   `validate-query.ts`), so the bound keeps a hostile name from being a
 *   memory/abuse vector while any legal identifier still binds.
 * - SQL strings are bounded (compiler output for realistic contracts is
 *   orders of magnitude smaller) so a hostile host cannot post megabytes of
 *   SQL as a shape-valid request.
 *
 * Beyond shape, {@link assertValidationPlanRelationBinding} enforces the
 * compiler-*rendering* invariants the executor relies on. This is the first
 * of TWO containment belts against smuggled SQL (review round 2: a plan
 * carrying `CREATE TABLE <canary> AS SELECT 1` slipped an occurrence-shaped
 * gate and persisted the canary):
 *
 * 1. **Tightened static gate** — every rule query and the summary must be
 *    lexically well-formed compiler SQL and a SINGLE `SELECT` statement,
 *    and the quoted relation must occur at least once in one of the
 *    compiler's FROM positions (`FROM "<rel>" AS "src"` /
 *    `(SELECT count(*) FROM "<rel>")`) in every rule — and in the summary
 *    of any plan that HAS rules. A rule-less plan is the one documented
 *    zero-occurrence shape, and it is held to the compiler's EXACT pinned
 *    empty summary ({@link EMPTY_VALIDATION_SUMMARY_SQL}), never to
 *    arbitrary relation-free SQL (q-11 belt-1 tightening). The scan is
 *    FULLY SQL-AWARE (m5-2 round-3 fix): line/block comments, single-quoted
 *    strings (with `''` doubling), double-quoted identifiers, and
 *    dollar-quoted/escape-string dialect forms are all lexed, and
 *    **comment-bearing SQL is refused outright** — the compiler emits no
 *    comments, so a commented pseudo-reference (the review-round-2 probe
 *    `SELECT … /* FROM "relation" AS "src" *\/`) is a malformed plan, and
 *    occurrences inside strings or comments never count. CREATE/CTAS
 *    statements, multi-statement strings, and relation-free SQL are typed
 *    rejections BEFORE any SQL runs.
 * 2. **Executor containment** — the executor runs the whole operation
 *    inside a transaction that is ALWAYS rolled back (DuckDB DDL is
 *    transactional), so even a hypothetical gate evasion cannot persist
 *    side effects (engine-executor.ts `runValidate`).
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
 * The compiler's pinned rule-less summary (mirror of m5-1's private
 * `EMPTY_SUMMARY_SQL` in `compile.ts`): a relation-free single `SELECT`
 * that emits the `rule_id`/`total_rows`/`fail_count` result shape and zero
 * rows. A rule-less plan's summary is held to EXACTLY this text — see
 * {@link assertValidationPlanRelationBinding} — so a foreign plan cannot
 * smuggle arbitrary relation-free SQL (a table function, another table by
 * name, …) through the one documented zero-occurrence exemption. Drift
 * between this mirror and the compiler is caught because the conformance
 * scenario executes real compiler output through this boundary.
 */
const EMPTY_VALIDATION_SUMMARY_SQL =
  'SELECT CAST(NULL AS VARCHAR) AS "rule_id", ' +
  'CAST(NULL AS BIGINT) AS "total_rows", ' +
  'CAST(NULL AS BIGINT) AS "fail_count" WHERE FALSE'

/**
 * The engine-side hard max on the rows a rule query may RETURN. A plan's K
 * is accepted at any safe integer ≥ 1 and the executor clamps the executed
 * per-rule query to `min(K, this)` — the inner SQL stays byte-identical and
 * the inner window still computes the rule's FULL violation count, so
 * `sampleFailures ≤ min(K, VALIDATION_SAMPLE_HARD_MAX)` holds literally for
 * every safe K (m5-2 round-3 semantics: over-max K is CLAMPED, never
 * rejected). The window scan itself is inherent to `failCount` and stays.
 * Declared here, at the boundary that carries it; `validate-query.ts`
 * re-exports it.
 */
export const VALIDATION_SAMPLE_HARD_MAX = 100

/**
 * The m5-0 rule-id grammar, as a anchored pattern (m5-2 round-3 fix, W1).
 * The m5-0/m5-1 compiler derives every `ruleId` from the contract's own
 * structure as the error-path spelling: `columns[<index>].<rule>` for
 * column rules (index a non-negative decimal integer without leading
 * zeros; `<rule>` one of the column rule keys — note a `declared-type`
 * rule's id ends in `.type`, not the kind spelling) and `dataset.<rule>`
 * for the row-count facts. The wire accepts exactly this grammar so the
 * engine's failure-class messages, which interpolate the id, can never
 * reflect arbitrary plan content.
 */
const RULE_ID_PATTERN =
  /^(?:columns\[(?:0|[1-9][0-9]*)\]\.(?:type|required|unique|min|max|allowed-values|regex|max-null-share|min-distinct-share)|dataset\.(?:min-rows|max-rows))$/

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
   * A resolvable non-empty key is part of the result contract: the executor
   * never produces `null`/empty (an unresolvable key fails the op loudly),
   * and the protocol parser rejects any payload that carries one (m5-2 fix
   * round — the type is the contract, not the hope).
   */
  readonly rowKey: string
  /**
   * The offending value, normalized to wire-safe JSON data (see
   * `normalizeSampleValue` in `validate-query.ts`): string, finite number,
   * boolean, or null. Values are report *content* — they are never logged
   * or telemetried anywhere (ADR 0025).
   */
  readonly value: string | number | boolean | null
}

/** Per-rule result (the m5-2 result contract, m5-4-refined). */
export interface EngineValidationRuleResult {
  /** The plan's `ruleId` (m5-0 error-path spelling). */
  readonly ruleId: string
  /**
   * The plan's own outcome for this rule (the closed v1 vocabulary,
   * `'row-samples' | 'dataset-fact'` — runtime-checked at the protocol
   * boundary). It selects the rule's result-sanity bound (m5-4): a
   * `row-samples` count is bounded by the effective row count; a
   * `dataset-fact` count is a boolean fact and is bounded by ONE.
   */
  readonly outcome: string
  /**
   * Violating rows; the executed plan's own count (see the plan contract).
   * Bounded by the outcome's result-sanity bound (m5-4): `≤ rowCount` for
   * `row-samples` rules, `≤ 1` for `dataset-fact` rules — a fact holds or
   * fails, never "fails twice" (`dataset.min-rows ≥ 1` over an empty
   * dataset legitimately reports 1 over 0 rows).
   */
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
   * documented hard max)` entries (the executor clamps the executed rule
   * query to exactly this bound — m5-2 round-3 semantics), each carrying
   * the offending row's key and value. Empty for `dataset-fact` rules (no
   * row samples exist).
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

/** A ruleId in the m5-0 error-path grammar (see {@link RULE_ID_PATTERN}). */
function isRuleId(value: unknown): value is string {
  return isBoundedString(value, MAX_NAME_LENGTH) && RULE_ID_PATTERN.test(value)
}

/** Parse one planned rule; `null` when malformed (never a throw). */
function parseValidationRule(value: unknown): EngineValidationRule | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  // The id is the m5-0 error-path grammar (W1, m5-2 round 3): failure
  // classes interpolate it, so only compiler-shaped ids parse. `path` is
  // report attribution (never interpolated into SQL or messages) and stays
  // a bounded string.
  if (!isRuleId(record['ruleId'])) return null
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
  // Any safe integer ≥ 1 parses (module doc): the executor clamps the
  // executed rule queries to `min(K, VALIDATION_SAMPLE_HARD_MAX)` — over-max
  // K plans execute, they are not refused (m5-2 round-3 adjudication).
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
 * One quoted identifier found by {@link scanPlanSql}: its half-open span in
 * the scanned SQL (the opening quote through just past the closing quote) and
 * its decoded value (SQL's doubled-quote escaping collapsed). The structural
 * code view blanks the identifier's interior, so this list is how the
 * relation-binding checks recover real `FROM "<rel>"` tokens without letting
 * a column whose name merely contains one read as a binding.
 */
export interface PlanSqlIdentifier {
  /** Index of the opening quote in the scanned SQL. */
  readonly start: number
  /** Index just past the closing quote. */
  readonly end: number
  /** Decoded identifier contents (`""` collapsed to `"`). */
  readonly value: string
}

/**
 * The result of the SQL-aware lexical scan ({@link scanPlanSql}): either a
 * code view of the SQL with every comment and string-literal contents
 * blanked out (same length, positions preserved — **quoted-identifier
 * interiors are blanked too**, with the tokens exposed via `identifiers`),
 * or the reason the SQL is not compiler-shaped. String/identifier
 * terminators use SQL's doubled-quote escaping (`''` / `""`).
 */
export interface PlanSqlScanOk {
  readonly ok: true
  readonly code: string
  /** Every quoted identifier, in source order (see {@link PlanSqlIdentifier}). */
  readonly identifiers: readonly PlanSqlIdentifier[]
}

export interface PlanSqlScanFailure {
  readonly ok: false
  readonly reason: 'comment' | 'unterminated' | 'dollar-quote' | 'escape-string'
}

export type PlanSqlScan = PlanSqlScanOk | PlanSqlScanFailure

/**
 * Fully SQL-aware lexical scan of one plan SQL string (m5-2 round-3 fix):
 * tracks line comments (`--` to end of line), block comments (`/* … *\/`),
 * single-quoted strings and double-quoted identifiers (both with `''` /
 * `""` doubling), and the DuckDB dialect forms the compiler never emits
 * (dollar-quoted `$$…$$` / `$tag$…$tag$` strings and `E'…'` escape
 * strings). The scan fails CLOSED:
 *
 * - any comment ⇒ `comment` (the compiler emits none; a commented
 *   pseudo-reference such as the review's `/* FROM "relation" AS "src" *\/`
 *   must never reach an occurrence counter — comment-bearing SQL is a
 *   malformed plan, refused outright before anything runs);
 * - an unterminated string/identifier/comment ⇒ `unterminated`;
 * - any dollar-quoted string ⇒ `dollar-quote` (a bare `$` outside strings
 *   and identifiers — the compiler emits no `$` at all);
 * - an `E'`-style escape-string opening ⇒ `escape-string` (its backslash
 *   escapes would defeat the doubling model).
 *
 * On success, `code` is a same-length view of the SQL in which single-quoted
 * string CONTENTS are blanked to spaces (the quotes themselves remain) **and
 * quoted-identifier interiors are blanked the same way**; the identifiers are
 * returned separately in `identifiers`. Downstream structural checks
 * (statement shape, `UNION ALL` splitting, `;` detection) therefore see only
 * real SQL structure: a `;` or `UNION ALL` or pseudo `FROM "<rel>" AS
 * "src"` inside either a literal or an identifier can never read as code.
 * The relation-binding checks stay correct by matching the returned
 * identifier tokens against the relation name and the surrounding code view.
 * (Comments never reach the code view: they are refused outright.)
 */
export function scanPlanSql(sql: string): PlanSqlScan {
  let out = ''
  let index = 0
  const length = sql.length
  const identifiers: PlanSqlIdentifier[] = []
  while (index < length) {
    const character = sql[index]
    if (character === '-') {
      if (sql[index + 1] === '-') {
        // Line comment: refused outright (the compiler emits none).
        return { ok: false, reason: 'comment' }
      }
      out += character
      index += 1
      continue
    }
    if (character === '/' && sql[index + 1] === '*') {
      return { ok: false, reason: 'comment' }
    }
    if (character === '$') {
      return { ok: false, reason: 'dollar-quote' }
    }
    if (character === "'") {
      // An E'…' escape string: backslash escapes would defeat the doubling
      // model, and the compiler never emits one — fail closed. The `E` must
      // be a standalone token (not the tail of a longer identifier), which
      // is exactly the escape-string spelling.
      if (index >= 1 && (sql[index - 1] === 'E' || sql[index - 1] === 'e')) {
        const before = index >= 2 ? sql[index - 2] : ''
        if (!/[A-Za-z0-9_"]/.test(before)) {
          return { ok: false, reason: 'escape-string' }
        }
      }
      out += "'"
      index += 1
      let closed = false
      while (index < length) {
        if (sql[index] === "'") {
          if (sql[index + 1] === "'") {
            out += '  '
            index += 2
            continue
          }
          out += "'"
          index += 1
          closed = true
          break
        }
        out += ' '
        index += 1
      }
      if (!closed) return { ok: false, reason: 'unterminated' }
      continue
    }
    if (character === '"') {
      // Quoted identifier: the token is code, but its **interior is not SQL
      // structure** — a column named `a;b` or one containing `UNION ALL` or
      // a relation-token text must not read as a separator, an operator, or
      // a binding. Blank the interior in the structural code view and record
      // the decoded token for the relation-binding checks.
      let cursor = index + 1
      let decoded = ''
      let closed = false
      while (cursor < length) {
        if (sql[cursor] === '"') {
          if (sql[cursor + 1] === '"') {
            decoded += '"'
            cursor += 2
            continue
          }
          closed = true
          break
        }
        decoded += sql[cursor]
        cursor += 1
      }
      if (!closed) return { ok: false, reason: 'unterminated' }
      const end = cursor + 1
      out += '"' + ' '.repeat(end - index - 2) + '"'
      identifiers.push({ start: index, end, value: decoded })
      index = end
      continue
    }
    out += character
    index += 1
  }
  return { ok: true, code: out, identifiers }
}

/**
 * The compiler's exact FROM renderings of the relation binding: the quoted
 * name is always preceded by `FROM ` and always followed by either the range
 * alias (` AS "src"`) or the closing parenthesis of the scalar count
 * subquery (`(SELECT count(*) FROM "<rel>")`). Anything else — an occurrence
 * in any other position — is not compiler output. Returns the number of
 * compiler-shaped occurrences: the caller enforces the minimum (≥ 1 for
 * every rule query and for the summary of any plan that has rules; the
 * rule-less plan's summary is the one documented zero-occurrence shape and
 * is held instead to the compiler's exact pinned empty summary — review
 * round 2: a relation-free statement can carry arbitrary SQL past an
 * occurrence gate, so zero occurrences are only acceptable where the
 * compiler provably emits them). The input is the {@link scanPlanSql}
 * result: the structural code view has literal AND identifier interiors
 * blanked, and the relation/alias tokens are matched from `identifiers`.
 * A column whose name merely *equals* or *contains* the relation token is
 * therefore never a binding, and a pseudo-reference in a literal or another
 * identifier can never count (m5-2 round-3 fix; AR-E2 made it
 * identifier-aware).
 */
function countCompilerShapedOccurrences(scan: PlanSqlScanOk, relation: string): number {
  const { code, identifiers } = scan
  let count = 0
  for (const identifier of identifiers) {
    if (identifier.value !== relation) continue
    const from = identifier.start - 'FROM '.length
    if (from < 0 || code.slice(from, identifier.start) !== 'FROM ') continue
    const after = code.slice(identifier.end)
    if (after.startsWith(')')) {
      count += 1
      continue
    }
    // `FROM "<rel>" AS "src"` — the alias quote sits exactly after the ` AS "`.
    if (after.startsWith(' AS "')) {
      const aliasStart = identifier.end + ' AS "'.length - 1
      const alias = identifiers.find((candidate) => candidate.start === aliasStart)
      if (alias !== undefined && alias.value === 'src') count += 1
    }
  }
  return count
}

/**
 * True when the (already scanned) code view is a single SELECT statement:
 * it starts with `SELECT` (the compiler emits no CTE/wrapper forms) and
 * contains no statement separator with anything after it. String literals
 * AND quoted-identifier interiors were blanked by {@link scanPlanSql}, so a
 * legitimate rule VALUE containing `;` (a regex or allowed-values literal) or
 * a column named `a;b` never reads as a second statement; comments were
 * refused outright, so they cannot hide one either. A trailing lone
 * separator with nothing after it is tolerated (the compiler never emits
 * one, but it cannot carry a second statement).
 */
export function isSingleSelectStatement(code: string): boolean {
  if (!/^\s*select\b/i.test(code)) return false
  const separator = code.indexOf(';')
  return separator < 0 || code.slice(separator + 1).trim() === ''
}

/**
 * The executor-side semantic checks beyond wire shape (typed `Error`s — the
 * request is recognised, so these surface as exactly one typed
 * `engine/error`, never a silent drop). Belt 1 of the m5-2 fix round's two
 * containment belts (belt 2 is the executor's rollback transaction):
 *
 * 1. **No clobbering** — the binding name must not equal the registered view
 *    of ANY open table (a hostile plan naming `assay_t1` must be rejected
 *    before a `CREATE VIEW` could shadow the base view; the executor also
 *    uses bare `CREATE VIEW`, so any other catalog collision fails the
 *    create without touching the existing object).
 * 2. **Single SELECT statements over well-formed compiler SQL** — every
 *    rule query and the summary must be lexically clean (no comments —
 *    refused outright —, no unterminated literals, no dialect string forms
 *    the compiler never emits) and exactly one `SELECT` statement (see
 *    {@link scanPlanSql} / {@link isSingleSelectStatement}).
 *    `CREATE TABLE <canary> AS SELECT …` payloads — the review's exact
 *    probe — are rejected here, before any SQL reaches the engine.
 * 3. **Compiler-shaped relation references, at least once** — every rule
 *    query must reference the quoted relation in one of the compiler's FROM
 *    positions at least once, and so must the summary of any plan that has
 *    rules (see {@link countCompilerShapedOccurrences}). SQL smuggled
 *    through the relation-name position — or SQL with no relation binding
 *    at all (including pseudo-references hidden inside string literals) —
 *    cannot reach execution.
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
  for (const rule of plan.rules) {
    const scanned = scanPlanSql(rule.sql)
    if (!scanned.ok) {
      throw new Error(
        scanned.reason === 'comment'
          ? `validation plan rule '${rule.ruleId}' contains SQL comments; the compiler emits none`
          : scanned.reason === 'dollar-quote'
            ? `validation plan rule '${rule.ruleId}' contains dollar-quoted SQL; the compiler emits none`
            : scanned.reason === 'escape-string'
              ? `validation plan rule '${rule.ruleId}' contains an escape-string literal; the compiler emits none`
              : `validation plan rule '${rule.ruleId}' is not lexically well-formed compiler SQL`,
      )
    }
    if (!isSingleSelectStatement(scanned.code)) {
      throw new Error(
        `validation plan rule '${rule.ruleId}' is not a single compiler-shaped SELECT query`,
      )
    }
    if (countCompilerShapedOccurrences(scanned, plan.relation) === 0) {
      throw new Error(
        `validation plan rule '${rule.ruleId}' does not bind its relation in the compiler's FROM shape`,
      )
    }
  }
  const scannedSummary = scanPlanSql(plan.summarySql)
  if (!scannedSummary.ok) {
    throw new Error(
      scannedSummary.reason === 'comment'
        ? 'validation plan summary contains SQL comments; the compiler emits none'
        : scannedSummary.reason === 'dollar-quote'
          ? 'validation plan summary contains dollar-quoted SQL; the compiler emits none'
          : scannedSummary.reason === 'escape-string'
            ? 'validation plan summary contains an escape-string literal; the compiler emits none'
            : 'validation plan summary is not lexically well-formed compiler SQL',
    )
  }
  if (!isSingleSelectStatement(scannedSummary.code)) {
    throw new Error('validation plan summary is not a single compiler-shaped SELECT query')
  }
  // A rule-less plan's summary is the one documented zero-occurrence shape:
  // the compiler's EXACT relation-free empty summary, so it is accepted only
  // when byte-identical to the pinned mirror. The old `rules.length === 0`
  // exemption skipped the summary's relation-shape check for ANY single
  // `SELECT`, which let a foreign rule-less plan run arbitrary relation-free
  // SQL (a table function, another table by name, …) as its summary straight
  // past belt 1 (AR-E6 / q-11). A plan that HAS rules still must bind the
  // relation in the compiler's FROM shape.
  if (plan.rules.length === 0) {
    if (plan.summarySql !== EMPTY_VALIDATION_SUMMARY_SQL) {
      throw new Error(
        'validation plan is rule-less; its summary must be the compiler-shaped empty summary',
      )
    }
  } else if (countCompilerShapedOccurrences(scannedSummary, plan.relation) === 0) {
    throw new Error('validation plan summary does not bind its relation in the compiler FROM shape')
  }
}

/**
 * The plan SQL's quoted rendering of the relation name (compiler's `q(rel)`).
 * D04b: delegates to the engine's single identifier-quoting implementation
 * (`./format-view.js` `quotedIdentifier`) instead of re-deriving the fragment;
 * the emitted token is byte-identical.
 */
export function quotedRelationToken(relation: string): string {
  return quotedIdentifier(relation)
}
