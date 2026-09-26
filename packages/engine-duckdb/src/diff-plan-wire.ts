// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Structural validation for row-diff plans crossing the worker boundary
 * (m6-2). The `engine/diff` request carries a compiled m6-1 `RowDiffPlan`
 * (`@assay/diff`) as plain structured-clone data; the worker is the **second
 * gate, not the first**: the plan's SQL is compiler-generated and
 * golden-pinned upstream, and this module asserts the *shape* the compiler
 * guarantees before any of it reaches the engine — mirroring the m5-2
 * `validate-plan-wire.ts` discipline exactly (this file is a structural
 * mirror of `@assay/diff`'s `row-diff-plan.ts`, never an import: the engine
 * stays dependency-free of the diff package, and drift is caught at runtime
 * because the conformance scenario executes **real compiler output** through
 * this boundary).
 *
 * What is checked here is *structure only*:
 * - the plan discriminator (`planKind`/`planVersion`) must be exactly the v1
 *   pair the compiler emits — a different (or future) plan is not this
 *   protocol's payload and is rejected, never guessed at;
 * - `relationA`/`relationB` are non-empty NUL-free bounded strings: they
 *   become the names of the engine-created binding views (see
 *   `diff-query.ts`), so the bound keeps a hostile name from being a
 *   memory/abuse vector while any legal identifier still binds;
 * - `keys` is a non-empty list of non-empty NUL-free bounded strings with no
 *   exact or case-insensitive duplicates (the m6-1 binding rule: identifiers
 *   are case-insensitive even when quoted, so two case-variants cannot be
 *   distinct key columns);
 * - `sharedColumns` is a list of bounded NUL-free strings (empty is legal:
 *   the plan is structurally empty for `changed`);
 * - `sampleLimit` is a safe integer ≥ 1 (the plan contract: `LIMIT 0` could
 *   not distinguish a non-empty aspect from an empty one). ANY such K is
 *   accepted — the executor CLAMPS the executed aspect query to
 *   `min(K, ROW_DIFF_SAMPLE_HARD_MAX)`, so the rows RETURNED are bounded
 *   while the inner window still computes the aspect's FULL count;
 * - the four SQL strings are bounded (compiler output for realistic schemas
 *   is orders of magnitude smaller) so a hostile host cannot post megabytes
 *   of SQL as a shape-valid request.
 *
 * Beyond shape, {@link assertRowDiffPlanBinding} enforces the
 * compiler-*rendering* invariants the executor relies on. This is the first
 * of TWO containment belts against smuggled SQL (the m5-2 lesson):
 *
 * 1. **Tightened static gate** — every per-aspect query must be lexically
 *    clean compiler SQL (comments refused outright, dollar-quoted and
 *    escape-string dialect forms refused — the compiler emits none) and a
 *    SINGLE `SELECT` statement; the totals query must be exactly three
 *    `UNION ALL`-joined single `SELECT` arms (the compiler's shape); and
 *    BOTH relation names must occur in the compiler's exact FROM renderings
 *    — `FROM "<rel>" AS "a"` / `FROM "<rel>" AS "b"` — in every aspect and
 *    every totals arm. The scan is fully SQL-aware (m5-2's `scanPlanSql`):
 *    occurrences inside string literals or comments can never count, and
 *    comment-bearing SQL is refused outright, so a string-masked
 *    pseudo-reference is a malformed plan, not a binding. CREATE/CTAS
 *    statements, multi-statement strings, and relation-free SQL are typed
 *    rejections BEFORE any SQL runs.
 * 2. **Executor containment** — the executor runs the whole operation inside
 *    a transaction that is ALWAYS rolled back (DuckDB DDL is transactional),
 *    so even a hypothetical gate evasion cannot persist side effects
 *    (`engine-executor.ts` `runDiff`).
 *
 * The reserved-namespace spot checks pin the result columns the readers
 * expect (`assay_side` / `assay_row_ordinal` / `assay_changed` /
 * `assay_count` / `assay_aspect`) so a compiler-shape SQL whose SELECT list
 * was gutted fails the gate instead of producing a shape error mid-op. The
 * check is IDENTIFIER-AWARE (q-12 / AR-E7): a required name counts only when
 * it is projected as a genuine quoted identifier — a string literal that
 * merely quotes the name (the spoof probe) cannot satisfy it, and a name
 * that occurs only below the top-level projection (a filter, a subquery
 * body) is not an output column.
 *
 * Error messages name the failure class only — never plan content, relation
 * names, key names, or dataset contents (ADR 0025).
 */
import { isSingleSelectStatement, scanPlanSql } from './validate-plan-wire.js'
import type { PlanSqlIdentifier, PlanSqlScanOk } from './validate-plan-wire.js'

/** Discriminator carried by every v1 plan (mirror of the m6-1 constant). */
const PLAN_KIND = 'assay-row-diff-plan'

/** The only plan version this protocol accepts (mirror of the m6-1 constant). */
const PLAN_VERSION = 1

/** Maximum length of a bounded plan string field (names, relations). */
const MAX_NAME_LENGTH = 512

/** Maximum length of one compiled SQL string (per-aspect query or totals). */
const MAX_SQL_LENGTH = 200_000

/** The three row-diff aspects, in the compiler's documented order. */
export type EngineRowDiffAspect = 'added' | 'removed' | 'changed'

/**
 * The engine-side hard max on the rows an aspect query may RETURN. A plan's
 * K is accepted at any safe integer ≥ 1 and the executor clamps the executed
 * per-aspect query to `min(K, this)` — the inner SQL stays byte-identical
 * and the inner window still computes the aspect's FULL count, so
 * `samples ≤ min(K, ROW_DIFF_SAMPLE_HARD_MAX)` holds literally for every
 * safe K. Declared here, at the boundary that carries it; `diff-query.ts`
 * re-exports it.
 */
export const ROW_DIFF_SAMPLE_HARD_MAX = 100

/**
 * A compiled row-diff plan as the wire carries it (structural mirror of the
 * m6-1 `RowDiffPlan`; the compiler's output assigns to this shape directly).
 */
export interface EngineRowDiffPlan {
  readonly planKind: string
  readonly planVersion: number
  readonly relationA: string
  readonly relationB: string
  readonly keys: readonly string[]
  readonly sampleLimit: number
  readonly sharedColumns: readonly string[]
  readonly addedSql: string
  readonly removedSql: string
  readonly changedSql: string
  readonly totalsSql: string
}

/**
 * One sampled row of an aspect, carrying a side-qualified row key. A-side
 * keys are **grid-resolvable** logical row ids (`base:<anchor>#<ordinal>`,
 * the m4-3 grammar — resolved engine-side through the effective view's baked
 * ordinal); B-side keys are the documented report-only `b:<ordinal>` form
 * (the staged comparison has no grid anchor, so it is deliberately NOT a
 * logical row id — checkpoint C3).
 */
export interface EngineRowDiffSample {
  readonly side: 'A' | 'B'
  readonly rowKey: string
  /**
   * The shared non-key columns that differ on this pair (`changed` aspect
   * only; absent for `added`/`removed`). Column names are schema, never
   * values (ADR 0025).
   */
  readonly changedColumns?: readonly string[]
}

/** Per-aspect result: the exact count plus bounded samples. */
export interface EngineRowDiffAspectResult {
  readonly aspect: EngineRowDiffAspect
  /** The exact count over the full relations (never the sample bound). */
  readonly count: number
  /** Bounded samples, in the aspect query's natural order. */
  readonly samples: readonly EngineRowDiffSample[]
}

/** Full result of `engine/diff` (plain JSON-able data; no Arrow). */
export interface EngineRowDiffResult {
  /** Effective row count of side A (the composed effective view or base). */
  readonly rowCountA: number
  /** Row count of side B (the staged comparison view). */
  readonly rowCountB: number
  /** One entry per aspect, in the compiler's documented order. */
  readonly aspects: readonly EngineRowDiffAspectResult[]
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= max
}

function isPlanSqlString(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= MAX_SQL_LENGTH
}

function isRelationName(value: unknown): value is string {
  return isBoundedString(value, MAX_NAME_LENGTH) && !value.includes('\u0000')
}

function isColumnName(value: unknown): value is string {
  return isBoundedString(value, MAX_NAME_LENGTH) && !value.includes('\u0000')
}

/**
 * Parse one string list: bounded non-empty NUL-free strings (optionally
 * de-duplicated case-insensitively — mirrors the compiler's `validateKeys`).
 */
function parseStringList(
  value: unknown,
  options: { readonly allowEmpty: boolean; readonly unique: boolean },
): string[] | null {
  if (!Array.isArray(value)) return null
  if (!options.allowEmpty && value.length === 0) return null
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (!isColumnName(entry)) return null
    if (options.unique) {
      const lower = entry.toLowerCase()
      if (seen.has(lower)) return null
      seen.add(lower)
    }
    out.push(entry)
  }
  return out
}

/**
 * Parse a row-diff plan from boundary data. Returns `null` for anything
 * structurally malformed (the protocol layer then answers the recognised
 * request with exactly one typed `engine/error`) — never a throw. The plan
 * is copied into fresh plain objects: a request can never keep a reference
 * into worker state.
 */
export function parseRowDiffPlan(value: unknown): EngineRowDiffPlan | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (record['planKind'] !== PLAN_KIND) return null
  if (record['planVersion'] !== PLAN_VERSION) return null
  if (!isRelationName(record['relationA'])) return null
  if (!isRelationName(record['relationB'])) return null
  const keys = parseStringList(record['keys'], { allowEmpty: false, unique: true })
  if (keys === null) return null
  const sampleLimit = record['sampleLimit']
  if (typeof sampleLimit !== 'number' || !Number.isSafeInteger(sampleLimit) || sampleLimit < 1) {
    return null
  }
  const sharedColumns = parseStringList(record['sharedColumns'], {
    allowEmpty: true,
    unique: false,
  })
  if (sharedColumns === null) return null
  if (!isPlanSqlString(record['addedSql'])) return null
  if (!isPlanSqlString(record['removedSql'])) return null
  if (!isPlanSqlString(record['changedSql'])) return null
  if (!isPlanSqlString(record['totalsSql'])) return null
  return {
    planKind: PLAN_KIND,
    planVersion: PLAN_VERSION,
    relationA: record['relationA'],
    relationB: record['relationB'],
    keys,
    sampleLimit,
    sharedColumns,
    addedSql: record['addedSql'],
    removedSql: record['removedSql'],
    changedSql: record['changedSql'],
    totalsSql: record['totalsSql'],
  }
}

/** The SQL's quoted rendering of a relation name (the compiler's `q(rel)`). */
export function quotedRelationToken(relation: string): string {
  return '"' + relation.replaceAll('"', '""') + '"'
}

/**
 * Count the compiler's exact FROM rendering of one relation bound to one of
 * the two fixed range aliases: `FROM "<rel>" AS "a"` / `FROM "<rel>" AS
 * "b"`. The input must be the {@link scanPlanSql} result (literal and
 * quoted-identifier interiors blanked; relation/alias tokens in
 * `identifiers`), so a pseudo-reference inside a literal or a column whose
 * name merely contains the token can never count. The compiler emits no
 * other shape for its two top-level ranges.
 */
function countCompilerFromOccurrences(
  scan: PlanSqlScanOk,
  relation: string,
  range: 'a' | 'b',
): number {
  const { code, identifiers } = scan
  let count = 0
  for (const identifier of identifiers) {
    if (identifier.value !== relation) continue
    const from = identifier.start - 'FROM '.length
    if (from < 0 || code.slice(from, identifier.start) !== 'FROM ') continue
    const after = code.slice(identifier.end)
    if (!after.startsWith(' AS "')) continue
    const aliasStart = identifier.end + ' AS "'.length - 1
    const alias = identifiers.find((candidate) => candidate.start === aliasStart)
    if (alias !== undefined && alias.value === range) count += 1
  }
  return count
}

/**
 * The identifier tokens that sit in the TOP-LEVEL SELECT projection of a
 * query — the region between the leading `SELECT` and the first `FROM` at
 * parenthesis depth zero. The input is the {@link scanPlanSql} result
 * (position-preserving; literal AND quoted-identifier interiors blanked), so
 * a `FROM` token inside either can never be mistaken for the clause
 * boundary. This is the output-column position the readers bind from, so a
 * name that appears only inside a string literal (the AR-E7 spoof) or only
 * below the top-level FROM (a filter, a subquery body) is not an output
 * column and cannot satisfy the reserved-column gate.
 */
function projectionIdentifiers(scan: PlanSqlScanOk): readonly PlanSqlIdentifier[] {
  const { code, identifiers } = scan
  const select = /^\s*select\b/i.exec(code)
  if (select === null) return []
  const start = select.index + select[0].length
  let depth = 0
  let from = -1
  for (let index = start; index < code.length; index += 1) {
    const character = code[index]
    if (character === '(') {
      depth += 1
    } else if (character === ')') {
      depth -= 1
    } else if (
      depth === 0 &&
      (character === 'F' || character === 'f') &&
      /^from\b/i.test(code.slice(index, index + 4))
    ) {
      from = index
      break
    }
  }
  if (from < 0) return []
  return identifiers.filter((identifier) => identifier.start >= start && identifier.end <= from)
}

/** True when the scanned query projects `name` as a genuine output identifier. */
function projectsIdentifier(scan: PlanSqlScanOk, name: string): boolean {
  return projectionIdentifiers(scan).some((identifier) => identifier.value === name)
}

/** Split the compiler's totals query into its three `UNION ALL` arms. */
function splitTotalsArms(original: string, code: string): PlanSqlScanOk[] | null {
  // The compiler emits exactly `\nUNION ALL\n` between arms. The split runs
  // over the structural code view (`code`), whose literal AND
  // quoted-identifier interiors are blanked — so an identifier containing the
  // literal text can no longer over-split the query (AR-E2). Each arm is then
  // re-scanned from the SAME offsets of the original SQL (the view is
  // position-preserving), recovering the arm's own identifier tokens for the
  // relation-binding checks. A shape that does not yield exactly three
  // well-formed arms is a malformed plan.
  const arms: PlanSqlScanOk[] = []
  let start = 0
  for (;;) {
    const index = code.indexOf('UNION ALL', start)
    if (index < 0) break
    const scanned = scanPlanSql(original.slice(start, index))
    if (!scanned.ok) return null
    arms.push(scanned)
    start = index + 'UNION ALL'.length
  }
  const last = scanPlanSql(original.slice(start))
  if (!last.ok) return null
  arms.push(last)
  return arms.length === 3 ? arms : null
}

/**
 * The executor-side semantic checks beyond wire shape (typed `Error`s — the
 * request is recognised, so these surface as exactly one typed
 * `engine/error`, never a silent drop). Belt 1 of the two containment belts
 * (belt 2 is the executor's rollback transaction). See the module doc for
 * the full rule list. The messages are value-free (ADR 0025).
 */
export function assertRowDiffPlanBinding(
  plan: EngineRowDiffPlan,
  registeredViewNames: readonly string[],
): void {
  if (plan.relationA === plan.relationB) {
    throw new Error('row-diff plan binds both sides to the same relation name; refusing')
  }
  for (const relation of [plan.relationA, plan.relationB]) {
    if (registeredViewNames.includes(relation)) {
      throw new Error(
        'row-diff plan relation collides with a registered table view; refusing to shadow it',
      )
    }
  }
  const aspectQueries: readonly {
    readonly label: string
    readonly sql: string
    /** Reserved result columns the reader of this aspect requires (bare names). */
    readonly requiredColumns: readonly string[]
  }[] = [
    {
      label: 'added',
      sql: plan.addedSql,
      requiredColumns: ['assay_side', 'assay_row_ordinal', 'assay_count'],
    },
    {
      label: 'removed',
      sql: plan.removedSql,
      requiredColumns: ['assay_side', 'assay_row_ordinal', 'assay_count'],
    },
    {
      label: 'changed',
      sql: plan.changedSql,
      requiredColumns: ['assay_side', 'assay_row_ordinal', 'assay_changed', 'assay_count'],
    },
  ]
  for (const aspect of aspectQueries) {
    const scanned = scanPlanSql(aspect.sql)
    if (!scanned.ok) {
      throw new Error(
        `row-diff ${aspect.label} query is not lexically well-formed compiler SQL (${scanned.reason})`,
      )
    }
    if (!isSingleSelectStatement(scanned.code)) {
      throw new Error(
        `row-diff ${aspect.label} query is not a single compiler-shaped SELECT statement`,
      )
    }
    if (countCompilerFromOccurrences(scanned, plan.relationA, 'a') < 1) {
      throw new Error(
        `row-diff ${aspect.label} query does not bind side A in the compiler's FROM shape`,
      )
    }
    if (countCompilerFromOccurrences(scanned, plan.relationB, 'b') < 1) {
      throw new Error(
        `row-diff ${aspect.label} query does not bind side B in the compiler's FROM shape`,
      )
    }
    // Reserved-namespace spot checks: the readers require these result
    // columns in EVERY aspect, and `changed` additionally requires its
    // changed-column list. Identifier-aware (q-12 / AR-E7): the name must be
    // projected as a genuine quoted identifier — a string literal that
    // quotes it cannot spoof the check, and a name used only below the
    // top-level projection is not an output column. The check is symmetric
    // across the three aspect SQLs so a gutted `removed`/`changed` query
    // fails THIS gate instead of surfacing a shape error mid-op (m6-2
    // review round 1).
    for (const column of aspect.requiredColumns) {
      if (!projectsIdentifier(scanned, column)) {
        throw new Error(`row-diff ${aspect.label} query is missing its reserved result columns`)
      }
    }
  }

  const totalsScan = scanPlanSql(plan.totalsSql)
  if (!totalsScan.ok) {
    throw new Error(
      `row-diff totals query is not lexically well-formed compiler SQL (${totalsScan.reason})`,
    )
  }
  const arms = splitTotalsArms(plan.totalsSql, totalsScan.code)
  if (arms === null) {
    throw new Error('row-diff totals query is not the compiler-shaped three-arm UNION ALL')
  }
  for (const arm of arms) {
    if (!isSingleSelectStatement(arm.code)) {
      throw new Error('row-diff totals query arm is not a single compiler-shaped SELECT statement')
    }
    if (countCompilerFromOccurrences(arm, plan.relationA, 'a') < 1) {
      throw new Error('row-diff totals query does not bind side A in the compiler FROM shape')
    }
    if (countCompilerFromOccurrences(arm, plan.relationB, 'b') < 1) {
      throw new Error('row-diff totals query does not bind side B in the compiler FROM shape')
    }
  }
}
