// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createViewSql, quotedIdentifier } from './format-view.js'
import { classifyProfileColumnType } from './profile-classify.js'
import { composeProfileBaseSql, composeProfileTopKSql } from './profile-query.js'

/**
 * B3 — the **real-engine** pin for `engine/profile-comparison`: profiling the
 * staged comparison view (`assay_diff_dN`) must answer exactly what profiling
 * the same dataset as a registered table (`assay_tN`) answers.
 *
 * The test runs the engine's OWN composed SQL (one `DESCRIBE`, the combined
 * aggregate from `profile-query.ts`, and one top-k scan per categorical
 * column) twice over two views created from the same file by the engine's own
 * `createViewSql` composer. The only difference between the two runs is the
 * view NAME — which is the whole claim: the op resolves a different address
 * and reuses the identical read path, so the statistics cannot diverge.
 *
 * Equality alone could be vacuous (two empty results are equal), so the
 * profile's concrete values are also pinned against the fixture below
 * (rowCount, nullCount, distinctCount, min/max/mean, and the top-k with its
 * value-ascending tie order).
 *
 * The CLI is the pinned DuckDB build (`DUCKDB`, default `/tmp/duckdb`) — the
 * same one the engine's other CLI-backed pins spawn; when it is absent the
 * suite skips (the repository's convention) rather than passing vacuously.
 */

const DUCKDB_CLI = process.env['DUCKDB'] ?? '/tmp/duckdb'
const hasDuckDbCli = existsSync(DUCKDB_CLI)

/** A CSV with a numeric column with a NULL, a categorical, a nulls-only and a tie. */
const ROWS = [
  '10,alpha,true,,2025-01-01,gold',
  '20,alpha,false,,2025-01-02,silver',
  '30,beta,true,,2025-01-01,gold',
  ',beta,false,,2025-01-02,silver',
  '50,alpha,true,,2025-01-01,bronze',
] as const

const HEADER = 'score,label,flag,empty,when,tier'

const workDir = hasDuckDbCli ? mkdtempSync(join(tmpdir(), 'assay-profile-comparison-')) : ''
const csvPath = join(workDir, 'profile.csv')
/** One on-disk database so both views live in the same CLI session state. */
const dbPath = join(workDir, 'assay-profile.duckdb')
if (hasDuckDbCli) writeFileSync(csvPath, [HEADER, ...ROWS].join('\n') + '\n', 'utf8')

afterAll(() => {
  if (workDir !== '') rmSync(workDir, { recursive: true, force: true })
})

function runJson(script: string): unknown[] {
  const stdout = execFileSync(DUCKDB_CLI, [dbPath, '-json', '-c', script], {
    encoding: 'utf8',
    stdio: 'pipe',
  })
  // A DDL statement prints nothing; only query results are JSON.
  return stdout.trim() === '' ? [] : (JSON.parse(stdout) as unknown[])
}

interface ViewProfile {
  readonly columns: readonly { name: string; type: string; kind: string }[]
  readonly base: unknown[]
  readonly topK: Record<string, unknown[]>
}

/**
 * The profile the executor would compute for `viewName`: the identical
 * composer calls, read as JSON (the CLI is the observation channel, not a
 * re-implementation of the aggregate).
 */
function profileOf(viewName: string): ViewProfile {
  const created = createViewSql(viewName, csvPath, 'csv')
  runJson(created)

  const describe = runJson(`DESCRIBE ${quotedIdentifier(viewName)}`) as {
    column_name: string
    column_type: string
  }[]
  const columns = describe.map((column) => ({
    name: column.column_name,
    type: column.column_type,
    kind: classifyProfileColumnType(column.column_type),
  }))

  const base = composeProfileBaseSql({
    viewName,
    columns: columns.map((column) => ({ name: column.name, kind: column.kind })),
  })
  const topK: Record<string, unknown[]> = {}
  for (const column of columns) {
    if (column.kind !== 'categorical') continue
    topK[column.name] = runJson(composeProfileTopKSql({ viewName, column: column.name }))
  }
  return { columns, base: runJson(base.sql), topK }
}

describe.skipIf(!hasDuckDbCli)('B3: profile-comparison on a real DuckDB engine', () => {
  it('answers exactly the table profile for the same dataset (statistics identical)', () => {
    const table = profileOf('assay_t1')
    const comparison = profileOf('assay_diff_d1')

    // Equality of the whole computed payload — schema/kind classification,
    // every aggregate slot and every top-k list, in order.
    expect(comparison).toEqual(table)
    // ...and the compared payload is non-trivial (the fixture's real values).
    expect(
      comparison.columns.map((column) => `${column.name}:${column.type}:${column.kind}`),
    ).toEqual([
      'score:BIGINT:numeric',
      'label:VARCHAR:categorical',
      'flag:BOOLEAN:categorical',
      'empty:VARCHAR:categorical',
      'when:DATE:categorical',
      'tier:VARCHAR:categorical',
    ])
    const base = comparison.base as Record<string, unknown>[]
    expect(base).toHaveLength(1)
    const row = base[0]!
    // c0 = row count; the numeric block (score) starts at c1: non-null,
    // distinct, min, max, mean, stddev, quantiles.
    expect(row['c0']).toBe(5)
    expect(row['c1']).toBe(4)
    expect(row['c2']).toBe(4)
    expect(row['c3']).toBe(10)
    expect(row['c4']).toBe(50)
    expect(row['c5']).toBe(27.5)
    // The categorical columns carry no numeric block; the next block is
    // label's (non-null, distinct), then flag's.
    expect(row['c8']).toBe(5)
    expect(row['c9']).toBe(2)
    // Top-k: count descending, ties by value ascending; the nulls-only column
    // has none.
    expect(comparison.topK['label']).toEqual([
      { v: 'alpha', n: 3 },
      { v: 'beta', n: 2 },
    ])
    // Count descending (tie by value ascending): the count tie orders gold
    // before silver, and the single-count value sorts last.
    expect(comparison.topK['tier']).toEqual([
      { v: 'gold', n: 2 },
      { v: 'silver', n: 2 },
      { v: 'bronze', n: 1 },
    ])
    expect(comparison.topK['empty']).toEqual([])
  })
})
