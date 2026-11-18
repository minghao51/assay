// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { OverlayBase } from '@assay/domain'
import { initialState, stepOverlay } from '@assay/domain'
import { composeOverlayExportSelectSql, quotedIdentifier } from '@assay/engine-duckdb'
import type { RepairPlan } from './plan'
import { repairPlanOp } from './plan'
import { repairAffectedCountSql, repairAffectedPredicate } from './preview-sql'

/**
 * EW-04I fix round 1 — the **real-engine** pin for the affected-count predicate.
 *
 * `repairAffectedPredicate` is the only SQL this row authors, so it is pinned
 * twice: byte-exactly in `preview-sql.test.ts` (composition invariants) and
 * here **semantically**, against the engine that will actually run it. For each
 * plan shape the fold accepts this file asserts two things:
 *
 * 1. the predicate's `count(*)` equals a literal expected count (so a silently
 *    vacuous comparison cannot pass), and
 * 2. the predicate's count **and row ids** equal the rows the **engine's own
 *    composed repair wrap** actually changes — the same
 *    `composeOverlayExportSelectSql` relation the count query reads, joined
 *    back to the raw table on the row id and compared value by value.
 *
 * The second assertion is the one that matters: it is the differential check
 * "affected ⟺ `repaired(v) ≠ v`" against the composer, not against a
 * re-implementation of it. It is exactly what the first shipped predicate
 * failed: with `trim = ' '` and `M = {a → ' a '}` the plan maps a trimmed value
 * straight back, so `' a '` is unchanged, and the old predicate over-counted it
 * (3 of 5 rows instead of 2) — enough for a no-op plan to pass the U1 refusal
 * and append an empty history entry.
 *
 * Cases (each is a `column-repair` the domain fold accepts):
 *
 * | case                        | why it is here                                            |
 * | --------------------------- | --------------------------------------------------------- |
 * | trim + mapping cancellation | fix-round-1 regression: the mapping maps the value back   |
 * | trim only                   | no mapping at all; only the trim can change a value       |
 * | mapping only                | no trim; exact whole-value membership                     |
 * | identity pair               | `M = {SG → SG}` changes nothing at all                    |
 * | identity pair + trim        | what a "keys with a different target" shortcut misses     |
 *
 * The CLI is the pinned DuckDB build (`DUCKDB`, default `/tmp/duckdb`) — the
 * same one the engine's own conformance tests spawn; when it is absent the
 * suite skips (the repository's convention for CLI-backed pins) rather than
 * passing vacuously.
 */

const DUCKDB_CLI = process.env['DUCKDB'] ?? '/tmp/duckdb'
const hasDuckDbCli = existsSync(DUCKDB_CLI)

const BASE: OverlayBase = {
  baseAnchor: 'fv-97-1700',
  overlayAnchor: 'ov-97',
  columns: [
    { name: 'id', type: 'INTEGER' },
    { name: 'label', type: 'VARCHAR' },
  ],
  baseRowCount: 5,
}

/** A fixture table: named rows so every query can be labelled and parsed. */
interface Fixture {
  readonly rows: readonly (readonly [number, string | null])[]
}

function fixtureSql(fixture: Fixture): string {
  const values = fixture.rows
    .map(
      ([id, label]) =>
        `(${String(id)}, ${label === null ? 'NULL' : `'${label.replaceAll("'", "''")}'`})`,
    )
    .join(', ')
  return [
    'CREATE TABLE assay_t1 (id INTEGER, label VARCHAR);',
    `INSERT INTO assay_t1 VALUES ${values};`,
  ].join('\n')
}

/** Run one labelled result set per `SELECT '<label>', …` statement. */
function runLabelled(script: string): Map<string, string> {
  const stdout = execFileSync(DUCKDB_CLI, ['-noheader', '-list', '-c', script], {
    encoding: 'utf8',
    stdio: 'pipe',
  })
  const labelled = new Map<string, string>()
  for (const line of stdout.trim().split(/\r?\n/)) {
    const at = line.indexOf('|')
    if (at < 0) continue
    labelled.set(line.slice(0, at), line.slice(at + 1))
  }
  return labelled
}

interface CaseResult {
  readonly predicateCount: number
  readonly composerCount: number
  readonly predicateIds: string
  readonly composerIds: string
}

/**
 * Count one plan's affected rows two ways, in a single CLI invocation:
 * the row's own `repairAffectedCountSql` (plus its predicate over the raw
 * table for the ids), and the engine's composed repair wrap joined back to the
 * raw rows.
 */
function runCase(plan: RepairPlan, fixture: Fixture): CaseResult {
  const base: OverlayBase = { ...BASE, baseRowCount: fixture.rows.length }
  const step = stepOverlay(base, initialState(base), repairPlanOp(plan))
  if (step.application.outcome.status !== 'applied') {
    throw new Error(
      `the fixture plan must be accepted by the fold, got: ${step.application.outcome.status}`,
    )
  }
  // The preview reads the PRE-apply state: the plan is not in the prefix yet, so
  // the relation shows the values the user is looking at (the state that already
  // carries the plan is what publication composes, below).
  const snapshot = { viewName: 'assay_t1', base, state: initialState(base) }
  // The production count statement, verbatim, re-labelled for parsing.
  const predicateCountSql = `SELECT 'predicate_count', affected FROM (${repairAffectedCountSql(
    snapshot,
    plan,
  )})`
  // The same predicate over the raw pre-apply relation, for the row ids.
  const column = quotedIdentifier(plan.column)
  const predicateIdsSql =
    `SELECT 'predicate_ids', list("id" ORDER BY "id") FROM assay_t1 ` +
    `WHERE (${column} ${repairAffectedPredicate(plan)})`
  // The engine's composed repair wrap — what publication actually materializes.
  const composed = composeOverlayExportSelectSql(
    { viewName: 'assay_t1', base, state: step.state },
    'parquet',
  )
  const composedDiff =
    `FROM assay_t1 AS raw JOIN (${composed}) AS rep ON raw."id" = rep."id" ` +
    'WHERE raw."label" IS DISTINCT FROM rep."label"'
  // Every statement is `;`-terminated: DuckDB's `-c` runs a script, not a batch
  // of newline-separated fragments.
  const script = [
    fixtureSql(fixture),
    predicateCountSql,
    `SELECT 'composer_count', count(*) ${composedDiff}`,
    predicateIdsSql,
    `SELECT 'composer_ids', list(raw."id" ORDER BY raw."id") ${composedDiff}`,
  ]
    .map((statement) => statement.trim().replace(/;?$/, ';'))
    .join('\n')

  const labelled = runLabelled(script)
  return {
    predicateCount: Number(labelled.get('predicate_count') ?? NaN),
    composerCount: Number(labelled.get('composer_count') ?? NaN),
    predicateIds: labelled.get('predicate_ids') ?? '',
    composerIds: labelled.get('composer_ids') ?? '',
  }
}

describe.skipIf(!hasDuckDbCli)('repairAffectedPredicate — real DuckDB agreement', () => {
  const cancellation: Fixture = {
    rows: [
      [0, ' a '],
      [1, 'a'],
      [2, ' x '],
      [3, 'b'],
      [4, null],
    ],
  }

  it('(a) trim + mapping cancellation: the mapping maps the trimmed value back', () => {
    // `' a '` trims to `a` and maps back to `' a '` — unchanged. `'a'` maps to
    // `' a '` and `' x '` trims to `x`: two rows change, not three. The first
    // shipped predicate said three here.
    const result = runCase(
      { column: 'label', trim: ' ', mapping: new Map([['a', ' a ']]) },
      cancellation,
    )
    expect(result.composerCount).toBe(2)
    expect(result.predicateCount).toBe(2)
    expect(result.predicateIds).toBe(result.composerIds)
    expect(result.predicateIds).toBe('[1, 2]')
  })

  it('(b) trim only: no mapping, only the trim can change a value', () => {
    const result = runCase({ column: 'label', trim: ' ', mapping: new Map() }, cancellation)
    expect(result.composerCount).toBe(2)
    expect(result.predicateCount).toBe(2)
    expect(result.predicateIds).toBe(result.composerIds)
    expect(result.predicateIds).toBe('[0, 2]')
  })

  it('(c) mapping only: exact whole-value membership, no trim', () => {
    const fixture: Fixture = {
      rows: [
        [0, 'SG'],
        [1, 'US'],
        [2, 'SG'],
        [3, 'DE'],
        [4, null],
      ],
    }
    const result = runCase({ column: 'label', mapping: new Map([['SG', 'Singapore']]) }, fixture)
    expect(result.composerCount).toBe(2)
    expect(result.predicateCount).toBe(2)
    expect(result.predicateIds).toBe(result.composerIds)
    expect(result.predicateIds).toBe('[0, 2]')
  })

  it('(d) identity pair: the plan changes nothing at all', () => {
    const fixture: Fixture = {
      rows: [
        [0, 'SG'],
        [1, 'US'],
      ],
    }
    const result = runCase({ column: 'label', mapping: new Map([['SG', 'SG']]) }, fixture)
    expect(result.composerCount).toBe(0)
    expect(result.predicateCount).toBe(0)
    // `list(...)` over zero rows is NULL in DuckDB (not an empty list), which is
    // itself worth pinning: it is why the row-id assertion above compares the two
    // sides to each other before comparing either to a literal.
    expect(result.predicateIds).toBe('NULL')
    expect(result.composerIds).toBe('NULL')
  })

  it('(e) identity pair with a trim: the trim still changes the padded row', () => {
    // `M = {a → a}` looks like "no mapping", but with a trim the padded row
    // `' a '` becomes `a` — a real change. This is the case a
    // "keys-with-a-different-target" shortcut gets wrong.
    const fixture: Fixture = {
      rows: [
        [0, ' a '],
        [1, 'a'],
        [2, 'b'],
      ],
    }
    const result = runCase({ column: 'label', trim: ' ', mapping: new Map([['a', 'a']]) }, fixture)
    expect(result.composerCount).toBe(1)
    expect(result.predicateCount).toBe(1)
    expect(result.predicateIds).toBe(result.composerIds)
    expect(result.predicateIds).toBe('[0]')
  })
})
