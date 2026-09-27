// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { compileRowDiffPlan } from '@assay/diff'
import type { RowDiffPlan } from '@assay/diff'
import { composeDiffAspectQuery, rowDiffCountExcess } from './diff-query'
import { ROW_DIFF_SAMPLE_HARD_MAX } from './diff-plan-wire'

/**
 * Real-DuckDB row-diff execution agreement (m6-2, the m6-1 carry-over).
 *
 * The m6-1 compiler was proven by the reviewer against DuckDB 1.5.5, but the
 * package is pure: the **hand-derivation tables** it ships
 * (`row-diff-ordinal-semantics.test.ts`) are lifted here and executed against
 * the pinned CLI through the engine's own composition helpers
 * ({@link composeDiffAspectQuery}), so the pre-filter ordinal contract,
 * NULL-key grouping, the TRUE presence markers, the exact counts + totals
 * agreement, and the K-clamp semantics are all pinned by a real engine — not
 * by checker opinion.
 *
 * The CLI is pinned (ADR 0038): skip only when the binary is absent, as the
 * m5-1 agreement suite does. Where it exists these pins must run.
 */

const DUCKDB_CLI = process.env['DUCKDB'] ?? '/tmp/duckdb'
const hasDuckDbCli = existsSync(DUCKDB_CLI)

const DB_PATH = join(tmpdir(), `assay-m62-agreement-${process.pid}.duckdb`)

/** One CLI `-json` row. */
type Row = Record<string, unknown>

function query(sql: string): Row[] {
  const out = execFileSync(DUCKDB_CLI, [DB_PATH, '-json', '-noheader', '-c', sql], {
    encoding: 'utf8',
  })
  if (out.trim() === '') return []
  return JSON.parse(out) as Row[]
}

function exec(sql: string): void {
  execFileSync(DUCKDB_CLI, [DB_PATH, '-noheader', '-c', sql], { stdio: 'pipe' })
}

function compile(
  schema: readonly { readonly name: string; readonly type: string }[],
  keys: readonly string[],
  sampleLimit: number,
): RowDiffPlan {
  const result = compileRowDiffPlan(schema, schema, [...keys], {
    relationA: 'ds_a',
    relationB: 'ds_b',
    sampleLimit,
  })
  if (!result.ok) throw new Error(`agreement compile failed: ${JSON.stringify(result.errors)}`)
  return result.plan
}

function ordinals(plan: RowDiffPlan, aspect: 'addedSql' | 'removedSql' | 'changedSql'): number[] {
  return query(plan[aspect]).map((row) => Number(row['assay_row_ordinal']))
}

function counts(plan: RowDiffPlan): Record<string, number> {
  const result: Record<string, number> = {}
  for (const row of query(plan.totalsSql)) {
    result[String(row['assay_aspect'])] = Number(row['assay_count'])
  }
  return result
}

describe.skipIf(!hasDuckDbCli)('row-diff execution vs DuckDB 1.5.5 (pinned CLI)', () => {
  afterAll(() => {
    rmSync(DB_PATH, { force: true })
  })

  it('pins the dialect: the CLI is the 1.5.x series', () => {
    expect(execFileSync(DUCKDB_CLI, ['--version'], { encoding: 'utf8' })).toMatch(/v1\.5\./)
  })

  it('lifts the m6-1 hand-derivation table: added [5,6] / removed [5,7] / changed [1,2,6]', () => {
    exec('CREATE OR REPLACE TABLE ds_a (id BIGINT, val VARCHAR, score BIGINT);')
    exec('CREATE OR REPLACE TABLE ds_b (id BIGINT, val VARCHAR, score BIGINT);')
    exec(
      "INSERT INTO ds_a VALUES (1,'a',10),(2,'b',20),(3,'c',30),(4,'d',40),(5,'e',50),(6,'f',60),(7,'g',70),(8,'h',80);",
    )
    exec(
      "INSERT INTO ds_b VALUES (1,'a',10),(2,'B',20),(3,'c',33),(4,'d',40),(5,'e',50),(9,'x',90),(10,'y',100),(7,'G',77);",
    )
    const plan = compile(
      [
        { name: 'id', type: 'BIGINT' },
        { name: 'val', type: 'VARCHAR' },
        { name: 'score', type: 'BIGINT' },
      ],
      ['id'],
      3,
    )
    expect(ordinals(plan, 'addedSql')).toEqual([5, 6])
    expect(ordinals(plan, 'removedSql')).toEqual([5, 7])
    expect(ordinals(plan, 'changedSql')).toEqual([1, 2, 6])
    expect(counts(plan)).toEqual({ added: 2, removed: 2, changed: 3 })
    // The changed-column sets (schema-A shared-column order).
    const changed = query(plan.changedSql)
    expect(changed.map((row) => row['assay_changed'])).toEqual([
      ['val'],
      ['score'],
      ['val', 'score'],
    ])
    // The post-filter regression would report 0..K-1 — the fixture discriminates.
    expect(ordinals(plan, 'addedSql')).not.toEqual([0, 1])
  })

  it('NULL keys group as a matched pair (TRUE presence markers), never added+removed', () => {
    exec('CREATE OR REPLACE TABLE ds_a (id BIGINT, val VARCHAR, score BIGINT);')
    exec('CREATE OR REPLACE TABLE ds_b (id BIGINT, val VARCHAR, score BIGINT);')
    exec("INSERT INTO ds_a VALUES (NULL,'x',1),(1,'a',1);")
    exec("INSERT INTO ds_b VALUES (NULL,'y',1),(1,'a',1);")
    const plan = compile(
      [
        { name: 'id', type: 'BIGINT' },
        { name: 'val', type: 'VARCHAR' },
        { name: 'score', type: 'BIGINT' },
      ],
      ['id'],
      5,
    )
    expect(counts(plan)).toEqual({ added: 0, removed: 0, changed: 1 })
    const changed = query(plan.changedSql)
    expect(changed).toHaveLength(1)
    expect(Number(changed[0]?.['assay_row_ordinal'])).toBe(0) // the NULL-key A row
    expect(changed[0]?.['assay_changed']).toEqual(['val'])
  })

  it('accepts non-unique user keys: a 3×3 key group yields changed 9 (refined bound)', () => {
    exec('CREATE OR REPLACE TABLE ds_a (id BIGINT, val VARCHAR, score BIGINT);')
    exec('CREATE OR REPLACE TABLE ds_b (id BIGINT, val VARCHAR, score BIGINT);')
    exec("INSERT INTO ds_a VALUES (1,'a1',1),(1,'a2',2),(1,'a3',3);")
    exec("INSERT INTO ds_b VALUES (1,'b1',1),(1,'b2',2),(1,'b3',3);")
    const plan = compile(
      [
        { name: 'id', type: 'BIGINT' },
        { name: 'val', type: 'VARCHAR' },
        { name: 'score', type: 'BIGINT' },
      ],
      ['id'],
      20,
    )
    // Non-unique keys multiply: every A row pairs with every B row in the
    // group. The m6-1 compiler accepts explicit non-unique keys (joint
    // uniqueness is not derivable), so this is legal compiler output.
    expect(counts(plan)).toEqual({ added: 0, removed: 0, changed: 9 })
    const changed = query(plan.changedSql)
    expect(changed).toHaveLength(9)
    expect(
      changed.every(
        (row) =>
          Array.isArray(row['assay_changed']) && (row['assay_changed'] as unknown[]).length > 0,
      ),
    ).toBe(true)
    // The refined bound accepts it; the old `min(rowCountA, rowCountB)` bound
    // would have rejected this legal output (9 > 3).
    expect(rowDiffCountExcess('changed', 9, 3, 3)).toBeNull()
    expect(9).toBeGreaterThan(Math.min(3, 3))
  })

  it('accepts m6-1 NULL-key grouping (2×2 group → changed 4, duplicate A ordinals)', () => {
    exec('CREATE OR REPLACE TABLE ds_a (id BIGINT, val VARCHAR, score BIGINT);')
    exec('CREATE OR REPLACE TABLE ds_b (id BIGINT, val VARCHAR, score BIGINT);')
    exec("INSERT INTO ds_a VALUES (NULL,'x',1),(NULL,'x',2);")
    exec("INSERT INTO ds_b VALUES (NULL,'y',1),(NULL,'y',2);")
    const plan = compile(
      [
        { name: 'id', type: 'BIGINT' },
        { name: 'val', type: 'VARCHAR' },
        { name: 'score', type: 'BIGINT' },
      ],
      ['id'],
      20,
    )
    // NULL keys group under IS NOT DISTINCT FROM: two NULL-key rows per side
    // form a 2×2 matched pair set, all four changed (val always differs).
    expect(counts(plan)).toEqual({ added: 0, removed: 0, changed: 4 })
    const changed = query(plan.changedSql)
    expect(changed).toHaveLength(4)
    // One pair per (A row, B row): duplicate A-side ordinals are inherent to
    // the m6-1 changed-sample contract, not a defect.
    const ordinals = changed.map((row) => Number(row['assay_row_ordinal'])).sort((a, b) => a - b)
    expect(ordinals).toEqual([0, 0, 1, 1])
    expect(rowDiffCountExcess('changed', 4, 2, 2)).toBeNull()
    expect(4).toBeGreaterThan(Math.min(2, 2))
  })

  it('hostile dataset column names bind and execute (range/alias/reserved names)', () => {
    // Column names that collide with every internal name the plan reserves.
    exec(
      'CREATE OR REPLACE TABLE ds_a ("assay_row_ordinal" BIGINT, a VARCHAR, b VARCHAR, ai BIGINT, bi BIGINT, "assay_changed" VARCHAR, "assay_count" BIGINT, "assay_side" VARCHAR, "has space" VARCHAR);',
    )
    exec(
      'CREATE OR REPLACE TABLE ds_b ("assay_row_ordinal" BIGINT, a VARCHAR, b VARCHAR, ai BIGINT, bi BIGINT, "assay_changed" VARCHAR, "assay_count" BIGINT, "assay_side" VARCHAR, "has space" VARCHAR);',
    )
    exec("INSERT INTO ds_a VALUES (1,'x','p',1,1,'q',1,'r','s'),(2,'y','q',2,2,'r',2,'s','t');")
    exec(
      "INSERT INTO ds_b VALUES (1,'x','p',1,1,'q',1,'r','s'),(2,'CHANGED','q',2,2,'r',2,'s','t'),(3,'z','z',3,3,'z',3,'z','z');",
    )
    const plan = compile(
      [
        { name: 'assay_row_ordinal', type: 'BIGINT' },
        { name: 'a', type: 'VARCHAR' },
        { name: 'b', type: 'VARCHAR' },
        { name: 'ai', type: 'BIGINT' },
        { name: 'bi', type: 'BIGINT' },
        { name: 'assay_changed', type: 'VARCHAR' },
        { name: 'assay_count', type: 'BIGINT' },
        { name: 'assay_side', type: 'VARCHAR' },
        { name: 'has space', type: 'VARCHAR' },
      ],
      ['assay_row_ordinal'],
      5,
    )
    // No binder error, exact counts; side A changed row at ordinal 1, B added at 2.
    expect(counts(plan)).toEqual({ added: 1, removed: 0, changed: 1 })
    expect(ordinals(plan, 'changedSql')).toEqual([1])
    expect(ordinals(plan, 'addedSql')).toEqual([2])
  })

  it('the K clamp bounds returned samples while the exact count survives untouched', () => {
    exec('CREATE OR REPLACE TABLE ds_a (id BIGINT, val VARCHAR, score BIGINT);')
    exec('CREATE OR REPLACE TABLE ds_b (id BIGINT, val VARCHAR, score BIGINT);')
    // 130 added B rows (ids 1000..1129); no shared rows.
    const insertsA: string[] = []
    for (let i = 0; i < 5; i++) {
      insertsA.push(`(${String(i)},'a${String(i)}',${String(i)})`)
    }
    exec(`INSERT INTO ds_a VALUES ${insertsA.join(',')};`)
    const insertsB: string[] = []
    for (let i = 0; i < 130; i++) {
      insertsB.push(`(${String(1000 + i)},'b${String(i)}',${String(i)})`)
    }
    exec(`INSERT INTO ds_b VALUES ${insertsB.join(',')};`)
    const plan = compile(
      [
        { name: 'id', type: 'BIGINT' },
        { name: 'val', type: 'VARCHAR' },
        { name: 'score', type: 'BIGINT' },
      ],
      ['id'],
      500,
    )
    // The clamp wrapper is what the executor runs; the inner window keeps the
    // FULL count on every returned row.
    const clamped = query(composeDiffAspectQuery(plan.addedSql, ROW_DIFF_SAMPLE_HARD_MAX))
    expect(clamped).toHaveLength(ROW_DIFF_SAMPLE_HARD_MAX)
    expect(Number(clamped[0]?.['assay_count'])).toBe(130)
    // Removed samples are exactly the 5 A rows (under the clamp).
    const removed = query(composeDiffAspectQuery(plan.removedSql, ROW_DIFF_SAMPLE_HARD_MAX))
    expect(removed).toHaveLength(5)
    expect(Number(removed[0]?.['assay_count'])).toBe(5)
    expect(counts(plan)).toEqual({ added: 130, removed: 5, changed: 0 })
  })

  it('refuses a drifted compared column the engine cannot compare (VARCHAR vs INTEGER) before execution', () => {
    // The C2 case: a shared NON-key column drifts VARCHAR → INTEGER. The
    // pre-au3-2 compiler emitted `ok:true` for this pair, and DuckDB then
    // threw a value-bearing conversion error at execution. The compiler now
    // refuses with a value-free typed error BEFORE any query is composed.
    exec('CREATE OR REPLACE TABLE ds_a (id BIGINT, val VARCHAR);')
    exec('CREATE OR REPLACE TABLE ds_b (id BIGINT, val INTEGER);')
    exec("INSERT INTO ds_a VALUES (1, 'x');")
    exec('INSERT INTO ds_b VALUES (1, 7);')

    const refused = compileRowDiffPlan(
      [
        { name: 'id', type: 'BIGINT' },
        { name: 'val', type: 'VARCHAR' },
      ],
      [
        { name: 'id', type: 'BIGINT' },
        { name: 'val', type: 'INTEGER' },
      ],
      ['id'],
      { relationA: 'ds_a', relationB: 'ds_b', sampleLimit: 3 },
    )
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.errors.map((error) => error.code)).toEqual(['shared-column-type-mismatch'])
    expect(refused.errors[0]?.column).toBe('val')
    // value-free: the refusal message never carries the cell text the engine
    // would have leaked had the plan executed.
    expect(refused.errors[0]?.message).not.toContain("'x'")

    // Agreement: the exact comparison the refused plan would have run DOES
    // fail on the pinned engine — so the compile-time refusal is not
    // over-conservative, it is the value-free projection of a real failure.
    // (`stdio: 'pipe'` keeps the engine's value-bearing stderr out of the
    // test log; the assertion is only that the statement throws.)
    expect(() =>
      execFileSync(
        DUCKDB_CLI,
        [
          DB_PATH,
          '-json',
          '-noheader',
          '-c',
          'SELECT 1 FROM ds_a AS a JOIN ds_b AS b ON a.id = b.id WHERE a.val IS DISTINCT FROM b.val;',
        ],
        { stdio: 'pipe' },
      ),
    ).toThrow()
  })
})
