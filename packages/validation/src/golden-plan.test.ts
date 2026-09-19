import { describe, expect, it } from 'vitest'
import { compileContract } from './compile'
import type { PlannedRule, ValidationPlan } from './plan'
import { PLAN_KIND, PLAN_VERSION } from './plan'
import { sqlStringLiteral } from './literals'
import type { ContractV1 } from '@assay/contracts'

/**
 * Golden-SQL byte pins (m5-1). Committed test files inside the package per
 * the queue: the full plan of an every-rule-kind contract — each rule's
 * SQL text and the complete summary query — plus the empty-contract plan.
 * These strings are the reviewed surface: identical (contract, schema,
 * options) must keep producing them byte-for-byte, and the m5-2 executor
 * binds against exactly these shapes.
 *
 * The goldens are executed against the pinned DuckDB CLI 1.5.5
 * (`/tmp/duckdb`) by the env-gated agreement suite in
 * `duckdb-agreement.test.ts` — on a dirty dataset every query parses, the
 * per-rule samples carry correct row ordinals, and the summary counts
 * equal the per-rule executions rule-for-rule. Note the shape's
 * collision-freedom invariants (see plan.ts): source columns appear only
 * range-qualified (`"src"."col"`), derived tables expose only the
 * reserved `assay_*` aliases, so any dataset column name — including ones
 * spelled like plan aliases — binds and executes correctly.
 */

/** Join literal SQL lines (data, not compiler logic). */
function lines(...parts: string[]): string {
  return parts.join('\n')
}

const GOLDEN_CONTRACT: ContractV1 = {
  format: 'v1',
  metadata: { name: 'customers-quality', version: 2, description: 'Quality gates' },
  columns: [
    { name: 'customer_id', type: 'BIGINT', required: true, unique: true },
    { name: 'email', required: true, regex: '^[^@]+@[^@]+\\.[^@]+$', maxNullShare: 0 },
    { name: 'country', type: 'VARCHAR', allowedValues: ['US', 'GB', 'DE'], minDistinctShare: 0.5 },
    { name: 'age', type: 'INTEGER', min: 0, max: 120 },
    { name: 'joined_at', type: 'DATE', unique: true },
    { name: 'amount', type: 'DECIMAL', min: 0.25, max: 99.5 }, // 'DECIMAL' vs schema DECIMAL(10,2): the exact-spelling caveat is an honest mismatch violation (m5-0 caveat)
    { name: 'flag', type: 'BOOLEAN', allowedValues: [true, false] },
    { name: 'score', type: 'DOUBLE', min: -1.5 },
    { name: 'legacy_id', type: 'INTEGER' }, // deliberately mismatches the schema (BIGINT)
    { name: 'payload', type: 'BLOB', maxNullShare: 0.5 },
  ],
  dataset: { minRows: 1, maxRows: 1000000 },
}

const GOLDEN_SCHEMA = [
  { name: 'customer_id', type: 'BIGINT' },
  { name: 'email', type: 'VARCHAR' },
  { name: 'country', type: 'VARCHAR' },
  { name: 'age', type: 'INTEGER' },
  { name: 'joined_at', type: 'DATE' },
  { name: 'amount', type: 'DECIMAL(10,2)' },
  { name: 'flag', type: 'BOOLEAN' },
  { name: 'score', type: 'DOUBLE' },
  { name: 'legacy_id', type: 'BIGINT' },
  { name: 'payload', type: 'BLOB' },
  { name: 'unbound', type: 'STRUCT(a INTEGER)' }, // no rules target it — never classified
]

/** The dataset-fact query for a declared-type rule (match: never violated). */
const TYPE_MATCH_SQL = lines(
  'SELECT "assay_n" AS "total_rows", 1 AS "fail_count"',
  'FROM (',
  '  SELECT count(*) AS "assay_n"',
  '  FROM "t1" AS "src"',
  ') AS "assay_rule_stats"',
  'WHERE FALSE',
)

/** The dataset-fact query for a declared-type rule (mismatch: always violated). */
const TYPE_MISMATCH_SQL = TYPE_MATCH_SQL.replace('WHERE FALSE', 'WHERE TRUE')

/**
 * Row-samples query for a plain per-row rule (predicate varies). The inner
 * projection renames the source column to the reserved `assay_value`
 * alias; for `unique` the occurrence count joins it. The outer predicate
 * references derived aliases only.
 */
function rowSamplesSql(column: string, predicate: string, unique = false): string {
  const projection = unique
    ? `"src"."${column}" AS "assay_value", count(*) OVER (PARTITION BY "src"."${column}") AS "assay_occurrences"`
    : `"src"."${column}" AS "assay_value"`
  return lines(
    'SELECT',
    `  (SELECT count(*) FROM "t1") AS "total_rows",`,
    `  count(*) OVER () AS "fail_count",`,
    `  row_number() OVER () - 1 AS "sample_index",`,
    `  "assay_row_ordinal",`,
    `  "assay_value"`,
    'FROM (',
    `  SELECT row_number() OVER () - 1 AS "assay_row_ordinal", ${projection}`,
    `  FROM "t1" AS "src"`,
    ') AS "assay_rule_source"',
    `WHERE ${predicate}`,
    'LIMIT 20',
  )
}

/** Dataset-fact query for the row-count fact (min/max rows, declared type). */
function rowCountFactSql(violated: string): string {
  return lines(
    'SELECT "assay_n" AS "total_rows", 1 AS "fail_count"',
    'FROM (',
    '  SELECT count(*) AS "assay_n"',
    '  FROM "t1" AS "src"',
    ') AS "assay_rule_stats"',
    `WHERE ${violated}`,
  )
}

/** Dataset-fact query for max-null-share. */
function nullShareFactSql(column: string, share: string): string {
  return lines(
    'SELECT "assay_n" AS "total_rows", 1 AS "fail_count"',
    'FROM (',
    `  SELECT count(*) AS "assay_n", coalesce(avg(CASE WHEN "src"."${column}" IS NULL THEN 1.0 ELSE 0.0 END), 0.0) AS "assay_null_share"`,
    '  FROM "t1" AS "src"',
    ') AS "assay_rule_stats"',
    `WHERE "assay_null_share" > ${share}`,
  )
}

/** Dataset-fact query for min-distinct-share. */
function distinctShareFactSql(column: string, share: string): string {
  return lines(
    'SELECT "assay_n" AS "total_rows", 1 AS "fail_count"',
    'FROM (',
    `  SELECT count(*) AS "assay_n", count("src"."${column}") AS "assay_non_null", count(DISTINCT "src"."${column}") AS "assay_distinct"`,
    '  FROM "t1" AS "src"',
    ') AS "assay_rule_stats"',
    `WHERE "assay_non_null" > 0 AND CAST("assay_distinct" AS DOUBLE) / "assay_non_null" < ${share}`,
  )
}

/** Summary arm builders (literal text; mirrors the pinned compiler output). */
function datasetFactArm(ruleId: string, stats: string, violated: string): string {
  return lines(
    `SELECT '${ruleId}' AS "rule_id", "assay_n" AS "total_rows", CASE WHEN ${violated} THEN 1 ELSE 0 END AS "fail_count"`,
    'FROM (',
    `  ${stats}`,
    '  FROM "t1" AS "src"',
    ') AS "assay_rule_stats"',
  )
}
function rowArm(ruleId: string, from: string, predicate: string): string {
  return lines(
    `SELECT '${ruleId}' AS "rule_id", (SELECT count(*) FROM "t1") AS "total_rows", count(*) AS "fail_count"`,
    `FROM ${from}`,
    `WHERE ${predicate}`,
  )
}

const REL_AS_SRC = '"t1" AS "src"'
const COUNT_STATS = 'SELECT count(*) AS "assay_n"'
const NULL_SHARE_STATS = (column: string) =>
  `SELECT count(*) AS "assay_n", coalesce(avg(CASE WHEN "src"."${column}" IS NULL THEN 1.0 ELSE 0.0 END), 0.0) AS "assay_null_share"`
const DISTINCT_SHARE_STATS = (column: string) =>
  `SELECT count(*) AS "assay_n", count("src"."${column}") AS "assay_non_null", count(DISTINCT "src"."${column}") AS "assay_distinct"`

/** Summary FROM for a `unique` arm (the occurrence subquery). */
function uniqueSummaryFrom(column: string): string {
  return lines(
    '(',
    `  SELECT "src"."${column}" AS "assay_value", count(*) OVER (PARTITION BY "src"."${column}") AS "assay_occurrences"`,
    '  FROM "t1" AS "src"',
    ') AS "assay_rule_summary"',
  )
}

function rule(rule: Omit<PlannedRule, 'path'> & { path?: string }): PlannedRule {
  return { path: rule.ruleId, ...rule } as PlannedRule
}

/** The expected plan rules, in canonical contract order. */
const GOLDEN_RULES: readonly PlannedRule[] = [
  rule({
    ruleId: 'columns[0].type',
    kind: 'declared-type',
    column: 'customer_id',
    outcome: 'dataset-fact',
    sql: TYPE_MATCH_SQL,
    expectedType: 'BIGINT',
    actualType: 'BIGINT',
  }),
  rule({
    ruleId: 'columns[0].required',
    kind: 'required',
    column: 'customer_id',
    outcome: 'row-samples',
    sql: rowSamplesSql('customer_id', '"assay_value" IS NULL'),
  }),
  rule({
    ruleId: 'columns[0].unique',
    kind: 'unique',
    column: 'customer_id',
    outcome: 'row-samples',
    sql: rowSamplesSql(
      'customer_id',
      '"assay_value" IS NOT NULL AND "assay_occurrences" > 1',
      true,
    ),
  }),
  rule({
    ruleId: 'columns[1].required',
    kind: 'required',
    column: 'email',
    outcome: 'row-samples',
    sql: rowSamplesSql('email', '"assay_value" IS NULL'),
  }),
  rule({
    ruleId: 'columns[1].regex',
    kind: 'regex',
    column: 'email',
    outcome: 'row-samples',
    sql: rowSamplesSql(
      'email',
      '("assay_value" IS NOT NULL AND NOT regexp_full_match("assay_value", \'^[^@]+@[^@]+\\.[^@]+$\'))',
    ),
  }),
  rule({
    ruleId: 'columns[1].max-null-share',
    kind: 'max-null-share',
    column: 'email',
    outcome: 'dataset-fact',
    sql: nullShareFactSql('email', '0'),
  }),
  rule({
    ruleId: 'columns[2].type',
    kind: 'declared-type',
    column: 'country',
    outcome: 'dataset-fact',
    sql: TYPE_MATCH_SQL,
    expectedType: 'VARCHAR',
    actualType: 'VARCHAR',
  }),
  rule({
    ruleId: 'columns[2].allowed-values',
    kind: 'allowed-values',
    column: 'country',
    outcome: 'row-samples',
    sql: rowSamplesSql(
      'country',
      "(\"assay_value\" IS NOT NULL AND \"assay_value\" NOT IN ('US', 'GB', 'DE'))",
    ),
  }),
  rule({
    ruleId: 'columns[2].min-distinct-share',
    kind: 'min-distinct-share',
    column: 'country',
    outcome: 'dataset-fact',
    sql: distinctShareFactSql('country', '0.5'),
  }),
  rule({
    ruleId: 'columns[3].type',
    kind: 'declared-type',
    column: 'age',
    outcome: 'dataset-fact',
    sql: TYPE_MATCH_SQL,
    expectedType: 'INTEGER',
    actualType: 'INTEGER',
  }),
  rule({
    ruleId: 'columns[3].min',
    kind: 'min',
    column: 'age',
    outcome: 'row-samples',
    sql: rowSamplesSql('age', '"assay_value" < 0'),
  }),
  rule({
    ruleId: 'columns[3].max',
    kind: 'max',
    column: 'age',
    outcome: 'row-samples',
    sql: rowSamplesSql('age', '"assay_value" > 120'),
  }),
  rule({
    ruleId: 'columns[4].type',
    kind: 'declared-type',
    column: 'joined_at',
    outcome: 'dataset-fact',
    sql: TYPE_MATCH_SQL,
    expectedType: 'DATE',
    actualType: 'DATE',
  }),
  rule({
    ruleId: 'columns[4].unique',
    kind: 'unique',
    column: 'joined_at',
    outcome: 'row-samples',
    sql: rowSamplesSql('joined_at', '"assay_value" IS NOT NULL AND "assay_occurrences" > 1', true),
  }),
  rule({
    ruleId: 'columns[5].type',
    kind: 'declared-type',
    column: 'amount',
    outcome: 'dataset-fact',
    sql: TYPE_MISMATCH_SQL,
    expectedType: 'DECIMAL',
    actualType: 'DECIMAL(10,2)',
  }),
  rule({
    ruleId: 'columns[5].min',
    kind: 'min',
    column: 'amount',
    outcome: 'row-samples',
    sql: rowSamplesSql('amount', '"assay_value" < 0.25'),
  }),
  rule({
    ruleId: 'columns[5].max',
    kind: 'max',
    column: 'amount',
    outcome: 'row-samples',
    sql: rowSamplesSql('amount', '"assay_value" > 99.5'),
  }),
  rule({
    ruleId: 'columns[6].type',
    kind: 'declared-type',
    column: 'flag',
    outcome: 'dataset-fact',
    sql: TYPE_MATCH_SQL,
    expectedType: 'BOOLEAN',
    actualType: 'BOOLEAN',
  }),
  rule({
    ruleId: 'columns[6].allowed-values',
    kind: 'allowed-values',
    column: 'flag',
    outcome: 'row-samples',
    sql: rowSamplesSql(
      'flag',
      '("assay_value" IS NOT NULL AND "assay_value" NOT IN (TRUE, FALSE))',
    ),
  }),
  rule({
    ruleId: 'columns[7].type',
    kind: 'declared-type',
    column: 'score',
    outcome: 'dataset-fact',
    sql: TYPE_MATCH_SQL,
    expectedType: 'DOUBLE',
    actualType: 'DOUBLE',
  }),
  rule({
    ruleId: 'columns[7].min',
    kind: 'min',
    column: 'score',
    outcome: 'row-samples',
    sql: rowSamplesSql('score', '"assay_value" < -1.5'),
  }),
  rule({
    ruleId: 'columns[8].type',
    kind: 'declared-type',
    column: 'legacy_id',
    outcome: 'dataset-fact',
    sql: TYPE_MISMATCH_SQL,
    expectedType: 'INTEGER',
    actualType: 'BIGINT',
  }),
  rule({
    ruleId: 'columns[9].type',
    kind: 'declared-type',
    column: 'payload',
    outcome: 'dataset-fact',
    sql: TYPE_MATCH_SQL,
    expectedType: 'BLOB',
    actualType: 'BLOB',
  }),
  rule({
    ruleId: 'columns[9].max-null-share',
    kind: 'max-null-share',
    column: 'payload',
    outcome: 'dataset-fact',
    sql: nullShareFactSql('payload', '0.5'),
  }),
  rule({
    ruleId: 'dataset.min-rows',
    kind: 'min-rows',
    column: null,
    outcome: 'dataset-fact',
    sql: rowCountFactSql('"assay_n" < 1'),
  }),
  rule({
    ruleId: 'dataset.max-rows',
    kind: 'max-rows',
    column: null,
    outcome: 'dataset-fact',
    sql: rowCountFactSql('"assay_n" > 1000000'),
  }),
]

/** The expected summary: one arm per rule, in plan order, joined by UNION ALL. */
const GOLDEN_SUMMARY_SQL = [
  datasetFactArm('columns[0].type', COUNT_STATS, 'FALSE'),
  rowArm('columns[0].required', REL_AS_SRC, '"src"."customer_id" IS NULL'),
  rowArm(
    'columns[0].unique',
    uniqueSummaryFrom('customer_id'),
    '"assay_value" IS NOT NULL AND "assay_occurrences" > 1',
  ),
  rowArm('columns[1].required', REL_AS_SRC, '"src"."email" IS NULL'),
  rowArm(
    'columns[1].regex',
    REL_AS_SRC,
    '("src"."email" IS NOT NULL AND NOT regexp_full_match("src"."email", \'^[^@]+@[^@]+\\.[^@]+$\'))',
  ),
  datasetFactArm('columns[1].max-null-share', NULL_SHARE_STATS('email'), '"assay_null_share" > 0'),
  datasetFactArm('columns[2].type', COUNT_STATS, 'FALSE'),
  rowArm(
    'columns[2].allowed-values',
    REL_AS_SRC,
    '("src"."country" IS NOT NULL AND "src"."country" NOT IN (\'US\', \'GB\', \'DE\'))',
  ),
  datasetFactArm(
    'columns[2].min-distinct-share',
    DISTINCT_SHARE_STATS('country'),
    '"assay_non_null" > 0 AND CAST("assay_distinct" AS DOUBLE) / "assay_non_null" < 0.5',
  ),
  datasetFactArm('columns[3].type', COUNT_STATS, 'FALSE'),
  rowArm('columns[3].min', REL_AS_SRC, '"src"."age" < 0'),
  rowArm('columns[3].max', REL_AS_SRC, '"src"."age" > 120'),
  datasetFactArm('columns[4].type', COUNT_STATS, 'FALSE'),
  rowArm(
    'columns[4].unique',
    uniqueSummaryFrom('joined_at'),
    '"assay_value" IS NOT NULL AND "assay_occurrences" > 1',
  ),
  datasetFactArm('columns[5].type', COUNT_STATS, 'TRUE'),
  rowArm('columns[5].min', REL_AS_SRC, '"src"."amount" < 0.25'),
  rowArm('columns[5].max', REL_AS_SRC, '"src"."amount" > 99.5'),
  datasetFactArm('columns[6].type', COUNT_STATS, 'FALSE'),
  rowArm(
    'columns[6].allowed-values',
    REL_AS_SRC,
    '("src"."flag" IS NOT NULL AND "src"."flag" NOT IN (TRUE, FALSE))',
  ),
  datasetFactArm('columns[7].type', COUNT_STATS, 'FALSE'),
  rowArm('columns[7].min', REL_AS_SRC, '"src"."score" < -1.5'),
  datasetFactArm('columns[8].type', COUNT_STATS, 'TRUE'),
  datasetFactArm('columns[9].type', COUNT_STATS, 'FALSE'),
  datasetFactArm(
    'columns[9].max-null-share',
    NULL_SHARE_STATS('payload'),
    '"assay_null_share" > 0.5',
  ),
  datasetFactArm('dataset.min-rows', COUNT_STATS, '"assay_n" < 1'),
  datasetFactArm('dataset.max-rows', COUNT_STATS, '"assay_n" > 1000000'),
].join('\nUNION ALL\n')

describe('golden plan — every rule kind, byte-pinned', () => {
  it('compiles the full contract to the pinned plan', () => {
    const result = compileContract(GOLDEN_CONTRACT, GOLDEN_SCHEMA, { relation: 't1' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const expected: ValidationPlan = {
      planKind: PLAN_KIND,
      planVersion: PLAN_VERSION,
      contractName: 'customers-quality',
      contractVersion: 2,
      relation: 't1',
      sampleLimit: 20,
      rules: GOLDEN_RULES,
      summarySql: GOLDEN_SUMMARY_SQL,
    }
    expect(result.plan).toEqual(expected)
  })

  it('compiles byte-identically on a second run and a reordered schema', () => {
    const first = compileContract(GOLDEN_CONTRACT, GOLDEN_SCHEMA, { relation: 't1' })
    const second = compileContract(GOLDEN_CONTRACT, GOLDEN_SCHEMA, { relation: 't1' })
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    const reversed = compileContract(GOLDEN_CONTRACT, [...GOLDEN_SCHEMA].reverse(), {
      relation: 't1',
    })
    expect(JSON.stringify(reversed)).toBe(JSON.stringify(first))
  })

  it('produces a JSON-serializable plan (the postMessage/Node boundary)', () => {
    const result = compileContract(GOLDEN_CONTRACT, GOLDEN_SCHEMA, { relation: 't1' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(JSON.parse(JSON.stringify(result.plan))).toEqual(result.plan)
  })

  it('keys the summary to every rule (structural plan↔summary agreement)', () => {
    const result = compileContract(GOLDEN_CONTRACT, GOLDEN_SCHEMA, { relation: 't1' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    for (const planned of result.plan.rules) {
      expect(result.plan.summarySql).toContain(sqlStringLiteral(planned.ruleId))
    }
    // and nothing else: one arm per rule
    const arms = result.plan.summarySql.split('\nUNION ALL\n')
    expect(arms).toHaveLength(result.plan.rules.length)
  })

  it('honors a custom sampleLimit in the plan and the LIMIT text', () => {
    const result = compileContract(GOLDEN_CONTRACT, GOLDEN_SCHEMA, {
      relation: 't1',
      sampleLimit: 3,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.sampleLimit).toBe(3)
    for (const planned of result.plan.rules) {
      if (planned.outcome === 'row-samples') expect(planned.sql).toContain('LIMIT 3')
      else expect(planned.sql).not.toContain('LIMIT')
    }
  })

  it('changes the relation byte-for-byte in every query (determinism tuple)', () => {
    const result = compileContract(GOLDEN_CONTRACT, GOLDEN_SCHEMA, { relation: 'assay_v7' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.summarySql).toContain('FROM "assay_v7" AS "src"')
    expect(result.plan.summarySql).not.toContain('"t1"')
  })

  it('references source columns only range-qualified (collision-freedom invariant)', () => {
    const result = compileContract(GOLDEN_CONTRACT, GOLDEN_SCHEMA, { relation: 't1' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const texts = [...result.plan.rules.map((r) => r.sql), result.plan.summarySql]
    for (const name of [
      'customer_id',
      'email',
      'country',
      'age',
      'joined_at',
      'amount',
      'flag',
      'score',
      'legacy_id',
      'payload',
    ]) {
      // A source column may appear only as "src"."name" — never bare, so a
      // dataset column spelled like a plan alias can never be confused with
      // one (DuckDB identifiers are case-insensitive even when quoted).
      const bare = new RegExp(`(?<!\\.)"${name}"`)
      for (const text of texts) {
        expect(bare.test(text), `bare "${name}" in:\n${text}`).toBe(false)
      }
    }
  })
})

describe('golden plan — the empty contract (m5-0 normalization edge)', () => {
  it('compiles zero rules and the pinned degenerate summary', () => {
    const result = compileContract(
      { format: 'v1', metadata: { name: 'minimal', version: 1 }, columns: [] },
      [{ name: 'id', type: 'BIGINT' }],
      { relation: 't9' },
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.rules).toEqual([])
    expect(result.plan.summarySql).toBe(
      'SELECT CAST(NULL AS VARCHAR) AS "rule_id", CAST(NULL AS BIGINT) AS "total_rows", CAST(NULL AS BIGINT) AS "fail_count" WHERE FALSE',
    )
  })
})
