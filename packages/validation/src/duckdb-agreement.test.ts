import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ColumnRuleSet, ContractV1 } from '@assay/contracts'
import { compileContract } from './compile'
import type { PlannedRule, ValidationPlan } from './plan'

/**
 * Real-DuckDB plan-execution agreement (m5-1 fix round). The compiled plan
 * must be *semantically* correct under DuckDB's exact identifier rules —
 * case-insensitive even when quoted, any quoted string a legal column
 * name — which is why the m5-1 review demanded execution evidence, not
 * checker opinion. These pins run every compiled query against the pinned
 * CLI (v1.5.5) and assert violation counts, including the review's two
 * probes:
 *
 * - `unique` over a column named `assay_occurrences` with data [1,1,2] →
 *   **TWO** violations (the old plan's alias collided with the source
 *   column and undercounted to one);
 * - `required` over `ASSAY_ROW_ORDINAL` with data [NULL,9] → **ONE**
 *   violation (the old case-sensitive reserved-name check let the
 *   case-variant through, and the quoted alias collided so the NULL was
 *   never seen).
 *
 * Skipped only when the pinned binary is absent (a CI image without it —
 * the documented skip reason); where it exists these pins must run.
 */

const DUCKDB_CLI = process.env['DUCKDB'] ?? '/tmp/duckdb'
const hasDuckDbCli = existsSync(DUCKDB_CLI)

/** One-row object as the CLI's `-json` emits it. */
type Row = Record<string, unknown>

const DB_PATH = join(tmpdir(), `assay-m51-agreement-${process.pid}.duckdb`)

/** Run SQL that produces rows; returns the JSON rows (empty array ⇒ none). */
function query(sql: string): Row[] {
  const out = execFileSync(DUCKDB_CLI, [DB_PATH, '-json', '-noheader', '-c', sql], {
    encoding: 'utf8',
  })
  return JSON.parse(out) as Row[]
}

/** Run SQL that must succeed; asserts the exit code (DuckDB's rejection). */
function exec(sql: string): void {
  execFileSync(DUCKDB_CLI, [DB_PATH, '-noheader', '-c', sql], { stdio: 'pipe' })
}

/** failCount of a per-rule query under the empty-result⇔clean convention. */
function failCountOf(rows: Row[]): number {
  return rows.length === 0 ? 0 : Number(rows[0]?.['fail_count'])
}

function contractOf(columns: readonly ColumnRuleSet[]): ContractV1 {
  return {
    format: 'v1',
    metadata: { name: 'agreement', version: 1 },
    columns,
  }
}

/**
 * Compile one rule over one column and execute BOTH the per-rule query and
 * the summary arm against the same table; asserts both report the expected
 * violation count and agree with each other (the m5-2 pin, exercised now).
 */
function assertCounts(
  table: string,
  column: ColumnRuleSet,
  schemaType: string,
  expected: number,
): void {
  const result = compileContract(contractOf([column]), [{ name: column.name, type: schemaType }], {
    relation: table,
  })
  expect(result.ok, JSON.stringify(result).slice(0, 300)).toBe(true)
  if (!result.ok) return
  const plan: ValidationPlan = result.plan
  expect(plan.rules.length).toBeGreaterThanOrEqual(1)
  for (const rule of plan.rules as readonly PlannedRule[]) {
    const rows = query(rule.sql)
    const got = failCountOf(rows)
    expect(got, `${rule.ruleId} per-rule count (sql below)\n${rule.sql}`).toBe(expected)
  }
  const summaryRows = query(plan.summarySql)
  for (const row of summaryRows) {
    const ruleId = String(row['rule_id'])
    const got = Number(row['fail_count'])
    expect(got, `summary count for ${ruleId}`).toBe(expected)
  }
  expect(summaryRows).toHaveLength(plan.rules.length)
}

describe.skipIf(!hasDuckDbCli)(
  'plan execution vs DuckDB 1.5.5 — the review probes (pinned CLI)',
  () => {
    afterAll(() => {
      rmSync(DB_PATH, { force: true })
    })

    it('pins the dialect: the CLI is the 1.5.x series', () => {
      const version = execFileSync(DUCKDB_CLI, ['--version'], { encoding: 'utf8' })
      expect(version).toMatch(/v1\.5\./)
    })

    it('review probe 1 — unique over assay_occurrences [1,1,2] reports TWO violations', () => {
      exec('CREATE TABLE probe1 (assay_occurrences INTEGER);')
      exec('INSERT INTO probe1 VALUES (1), (1), (2);')
      // per-rule and summary, asserted separately for exact evidence
      const result = compileContract(
        contractOf([{ name: 'assay_occurrences', unique: true }]),
        [{ name: 'assay_occurrences', type: 'INTEGER' }],
        { relation: 'probe1' },
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const [rule] = result.plan.rules
      expect(rule?.kind).toBe('unique')
      const rows = query(rule?.sql ?? '')
      expect(failCountOf(rows)).toBe(2)
      expect(rows).toHaveLength(2) // both offending rows sampled
      const summary = query(result.plan.summarySql)
      expect(summary.map((r) => Number(r['fail_count']))).toEqual([2])
    })

    it('review probe 2 — required over ASSAY_ROW_ORDINAL [NULL,9] reports ONE violation', () => {
      exec('CREATE TABLE probe2 ("ASSAY_ROW_ORDINAL" INTEGER);')
      exec('INSERT INTO probe2 VALUES (NULL), (9);')
      const result = compileContract(
        contractOf([{ name: 'ASSAY_ROW_ORDINAL', required: true }]),
        [{ name: 'ASSAY_ROW_ORDINAL', type: 'INTEGER' }],
        { relation: 'probe2' },
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const [rule] = result.plan.rules
      expect(rule?.kind).toBe('required')
      const rows = query(rule?.sql ?? '')
      expect(failCountOf(rows)).toBe(1)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.['assay_row_ordinal']).toBe(0) // the NULL is the first row
      expect(rows[0]?.['assay_value']).toBe(null)
      const summary = query(result.plan.summarySql)
      expect(summary.map((r) => Number(r['fail_count']))).toEqual([1])
    })
  },
)

describe.skipIf(!hasDuckDbCli)(
  'plan execution vs DuckDB 1.5.5 — every plan alias name binds and executes (collision matrix)',
  () => {
    afterAll(() => {
      rmSync(DB_PATH, { force: true })
    })

    it('required/unique/min over columns named like plan aliases (exact and case-variant)', () => {
      // Each case: a table whose column collides with a plan alias, data
      // engineered so the rule is violated exactly `expected` times.
      const cases: readonly {
        readonly table: string
        readonly ddl: string
        readonly dml: string
        readonly column: ColumnRuleSet
        readonly schemaType: string
        readonly expected: number
      }[] = [
        // result-shape names of the per-rule queries
        {
          table: 't_required_assay_row_ordinal',
          ddl: 'CREATE TABLE t_required_assay_row_ordinal (assay_row_ordinal INTEGER);',
          dml: 'INSERT INTO t_required_assay_row_ordinal VALUES (NULL), (9);',
          column: { name: 'assay_row_ordinal', required: true },
          schemaType: 'INTEGER',
          expected: 1,
        },
        {
          table: 't_required_upper',
          ddl: 'CREATE TABLE t_required_upper ("ASSAY_ROW_ORDINAL" INTEGER);',
          dml: 'INSERT INTO t_required_upper VALUES (NULL), (9);',
          column: { name: 'ASSAY_ROW_ORDINAL', required: true },
          schemaType: 'INTEGER',
          expected: 1,
        },
        {
          table: 't_required_assay_value',
          ddl: 'CREATE TABLE t_required_assay_value (assay_value VARCHAR);',
          dml: "INSERT INTO t_required_assay_value VALUES (NULL), ('x');",
          column: { name: 'assay_value', required: true },
          schemaType: 'VARCHAR',
          expected: 1,
        },
        {
          table: 't_required_total_rows',
          ddl: 'CREATE TABLE t_required_total_rows (total_rows INTEGER);',
          dml: 'INSERT INTO t_required_total_rows VALUES (NULL), (3);',
          column: { name: 'total_rows', required: true },
          schemaType: 'INTEGER',
          expected: 1,
        },
        {
          table: 't_required_fail_count',
          ddl: 'CREATE TABLE t_required_fail_count (fail_count INTEGER);',
          dml: 'INSERT INTO t_required_fail_count VALUES (1), (NULL);',
          column: { name: 'fail_count', required: true },
          schemaType: 'INTEGER',
          expected: 1,
        },
        {
          table: 't_required_sample_index',
          ddl: 'CREATE TABLE t_required_sample_index (sample_index INTEGER);',
          dml: 'INSERT INTO t_required_sample_index VALUES (NULL), (2);',
          column: { name: 'sample_index', required: true },
          schemaType: 'INTEGER',
          expected: 1,
        },
        {
          table: 't_required_rule_id',
          ddl: 'CREATE TABLE t_required_rule_id (rule_id VARCHAR);',
          dml: "INSERT INTO t_required_rule_id VALUES (NULL), ('x');",
          column: { name: 'rule_id', required: true },
          schemaType: 'VARCHAR',
          expected: 1,
        },
        // the unique rule's internal alias, exact and case-variant
        {
          table: 't_unique_occurrences',
          ddl: 'CREATE TABLE t_unique_occurrences (assay_occurrences INTEGER);',
          dml: 'INSERT INTO t_unique_occurrences VALUES (1), (1), (2);',
          column: { name: 'assay_occurrences', unique: true },
          schemaType: 'INTEGER',
          expected: 2,
        },
        {
          table: 't_unique_occurrences_upper',
          ddl: 'CREATE TABLE t_unique_occurrences_upper ("ASSAY_OCCURRENCES" INTEGER);',
          dml: 'INSERT INTO t_unique_occurrences_upper VALUES (7), (7), (8), (8);',
          column: { name: 'ASSAY_OCCURRENCES', unique: true },
          schemaType: 'INTEGER',
          expected: 4,
        },
        // dataset-fact stats aliases
        {
          table: 't_null_share',
          ddl: 'CREATE TABLE t_null_share (assay_null_share INTEGER);',
          dml: 'INSERT INTO t_null_share VALUES (NULL), (1), (1);',
          column: { name: 'assay_null_share', maxNullShare: 0.25 },
          schemaType: 'INTEGER',
          expected: 1, // NULL share 1/3 > 0.25 → violated
        },
        {
          table: 't_non_null',
          ddl: 'CREATE TABLE t_non_null (assay_non_null INTEGER);',
          dml: 'INSERT INTO t_non_null VALUES (1), (1);',
          column: { name: 'assay_non_null', minDistinctShare: 1 },
          schemaType: 'INTEGER',
          expected: 1, // distinct 1 / non-null 2 < 1
        },
        {
          table: 't_distinct',
          ddl: 'CREATE TABLE t_distinct (assay_distinct INTEGER);',
          dml: 'INSERT INTO t_distinct VALUES (5), (5), (NULL);',
          column: { name: 'assay_distinct', minDistinctShare: 1 },
          schemaType: 'INTEGER',
          expected: 1,
        },
        {
          table: 't_min_assay_n',
          ddl: 'CREATE TABLE t_min_assay_n (assay_n INTEGER);',
          dml: 'INSERT INTO t_min_assay_n VALUES (-1), (2);',
          column: { name: 'assay_n', min: 0 },
          schemaType: 'INTEGER',
          expected: 1,
        },
        // the range alias itself and the derived-table aliases as column names
        {
          table: 't_required_src',
          ddl: 'CREATE TABLE t_required_src (src INTEGER);',
          dml: 'INSERT INTO t_required_src VALUES (NULL), (4);',
          column: { name: 'src', required: true },
          schemaType: 'INTEGER',
          expected: 1,
        },
        {
          table: 't_required_rule_source',
          ddl: 'CREATE TABLE t_required_rule_source (assay_rule_source INTEGER);',
          dml: 'INSERT INTO t_required_rule_source VALUES (NULL);',
          column: { name: 'assay_rule_source', required: true },
          schemaType: 'INTEGER',
          expected: 1,
        },
        {
          table: 't_required_rule_stats',
          ddl: 'CREATE TABLE t_required_rule_stats (assay_rule_stats INTEGER);',
          dml: 'INSERT INTO t_required_rule_stats VALUES (5), (NULL);',
          column: { name: 'assay_rule_stats', required: true },
          schemaType: 'INTEGER',
          expected: 1,
        },
      ]
      for (const c of cases) {
        exec(c.ddl)
        exec(c.dml)
        assertCounts(c.table, c.column, c.schemaType, c.expected)
      }
    })

    it('dataset-fact rules stay correct over colliding column names', () => {
      exec('CREATE TABLE t_fact (assay_null_share INTEGER, assay_distinct INTEGER);')
      exec('INSERT INTO t_fact VALUES (NULL, 1), (NULL, 1);')
      // max-null-share over assay_null_share: 2/2 NULLs > 0.25 → violated
      const shareResult = compileContract(
        contractOf([{ name: 'assay_null_share', maxNullShare: 0.25 }]),
        [{ name: 'assay_null_share', type: 'INTEGER' }],
        { relation: 't_fact' },
      )
      expect(shareResult.ok).toBe(true)
      if (shareResult.ok) {
        const rows = query(shareResult.plan.rules[0]?.sql ?? '')
        expect(failCountOf(rows)).toBe(1)
        const summary = query(shareResult.plan.summarySql)
        expect(summary.map((r) => Number(r['fail_count']))).toEqual([1])
      }
    })
  },
)

describe.skipIf(!hasDuckDbCli)(
  'plan execution vs DuckDB 1.5.5 — the golden plan, every rule, exact counts',
  () => {
    afterAll(() => {
      rmSync(DB_PATH, { force: true })
    })

    it('every golden rule executes; per-rule counts equal summary counts', () => {
      // The golden contract (mirrors golden-plan.test.ts) over a dirty
      // 3-row dataset; expected counts computed by hand and pinned.
      exec(`CREATE TABLE t1 (
        customer_id BIGINT, email VARCHAR, country VARCHAR, age INTEGER,
        joined_at DATE, amount DECIMAL(10,2), flag BOOLEAN, score DOUBLE,
        legacy_id BIGINT, payload BLOB, unbound STRUCT(a INTEGER));`)
      exec(`INSERT INTO t1 VALUES
        (1, 'a@x.com', 'US', 30, DATE '2020-01-01', 1.00, TRUE, 0.0, 1, NULL, {'a': 1}),
        (1, 'bad-email', 'DE', 150, DATE '2020-01-01', -5.00, TRUE, -2.0, 2, 'ab'::BLOB, {'a': 2}),
        (2, NULL, 'FR', 40, DATE '2021-01-01', 50.00, FALSE, 0.5, 3, NULL, {'a': 3});`)
      const schema = [
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
        { name: 'unbound', type: 'STRUCT(a INTEGER)' },
      ]
      const contract: ContractV1 = {
        format: 'v1',
        metadata: { name: 'customers-quality', version: 2 },
        columns: [
          { name: 'customer_id', type: 'BIGINT', required: true, unique: true },
          { name: 'email', required: true, regex: '^[^@]+@[^@]+\\.[^@]+$', maxNullShare: 0 },
          {
            name: 'country',
            type: 'VARCHAR',
            allowedValues: ['US', 'GB', 'DE'],
            minDistinctShare: 0.5,
          },
          { name: 'age', type: 'INTEGER', min: 0, max: 120 },
          { name: 'joined_at', type: 'DATE', unique: true },
          { name: 'amount', type: 'DECIMAL', min: 0.25, max: 99.5 },
          { name: 'flag', type: 'BOOLEAN', allowedValues: [true, false] },
          { name: 'score', type: 'DOUBLE', min: -1.5 },
          { name: 'legacy_id', type: 'INTEGER' },
          { name: 'payload', type: 'BLOB', maxNullShare: 0.5 },
        ],
        dataset: { minRows: 1, maxRows: 1000000 },
      }
      const expected: Readonly<Record<string, number>> = {
        'columns[0].type': 0,
        'columns[0].required': 0,
        'columns[0].unique': 2,
        'columns[1].required': 1,
        'columns[1].regex': 1,
        'columns[1].max-null-share': 1,
        'columns[2].type': 0,
        'columns[2].allowed-values': 1,
        'columns[2].min-distinct-share': 0,
        'columns[3].type': 0,
        'columns[3].min': 0,
        'columns[3].max': 1,
        'columns[4].type': 0,
        'columns[4].unique': 2,
        'columns[5].type': 1,
        'columns[5].min': 1,
        'columns[5].max': 0,
        'columns[6].type': 0,
        'columns[6].allowed-values': 0,
        'columns[7].type': 0,
        'columns[7].min': 1,
        'columns[8].type': 1,
        'columns[9].type': 0,
        'columns[9].max-null-share': 1,
        'dataset.min-rows': 0,
        'dataset.max-rows': 0,
      }
      const result = compileContract(contract, schema, { relation: 't1' })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.plan.rules).toHaveLength(26)
      for (const rule of result.plan.rules) {
        const rows = query(rule.sql)
        const got = failCountOf(rows)
        expect(got, `${rule.ruleId}\n${rule.sql}`).toBe(expected[rule.ruleId])
      }
      // one summary row per rule, agreeing rule-for-rule
      const summary = query(result.plan.summarySql)
      expect(summary).toHaveLength(result.plan.rules.length)
      for (const row of summary) {
        const ruleId = String(row['rule_id'])
        expect(Number(row['fail_count']), `summary ${ruleId}`).toBe(expected[ruleId])
        expect(Number(row['total_rows'])).toBe(3)
      }
    })
  },
)
