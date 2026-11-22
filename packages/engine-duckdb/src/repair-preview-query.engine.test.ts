// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { EditOp, OverlayBase } from '@assay/domain'
import { initialState, stepOverlay } from '@assay/domain'
import { composeOverlayExportSelectSql } from './export-query.js'
import { quotedIdentifier } from './format-view.js'
import type { OverlayComposition } from './overlay-query.js'
import {
  composeRepairPreviewCountSql,
  repairAffectedFilter,
  repairAffectedPredicate,
} from './repair-preview-query.js'
import type { EngineRepairPlan } from './repair-preview-query.js'
import { whereClauseSql } from './window-query.js'

/**
 * B1/ENG-2 — the **real-engine** conformance pin for the repair-preview
 * affected count (the EW-04I `preview-sql.engine.test.ts` matrix, ported
 * engine-side).
 *
 * Two things are asserted per plan shape, against the pinned DuckDB CLI:
 *
 * 1. the op's `affected` equals the number of rows the **engine's own
 *    composed wrap** actually changes — the pre-apply effective relation
 *    joined to the post-apply effective relation on the logical row id and
 *    compared value by value. That is the differential check
 *    "affected ⟺ `repaired(v) ≠ v`" against the composer, not against a
 *    re-implementation of it, and it is what the first shipped predicate
 *    failed (with `trim = ' '` and `M = {a → ' a '}` the plan maps a trimmed
 *    value straight back, so `' a '` is unchanged — the old predicate
 *    over-counted 3 of 5 rows, enough for a no-op plan to pass the
 *    zero-affected refusal);
 * 2. the op's `affected` equals the **transitional composed-SQL count** — the
 *    exact statement the host composed before this op existed
 *    (`SELECT count(*)::BIGINT AS affected FROM (<export SELECT>) WHERE
 *    (<filter>)`), rebuilt here from the same exported composers so the
 *    migration's byte-for-byte claim is pinned by execution, not by reading.
 *
 * Cases (each is a `column-repair` the domain fold accepts):
 *
 * | case                        | why it is here                                             |
 * | --------------------------- | ---------------------------------------------------------- |
 * | trim + mapping cancellation | EW-04I fix-round-1 regression: the mapping maps back       |
 * | trim only                   | no mapping at all; only the trim can change a value         |
 * | mapping only                | no trim; exact whole-value membership                       |
 * | trim + mapping (both)       | the trim and the mapping both change values                 |
 * | identity pair               | `M = {SG → SG}` changes nothing at all                      |
 * | identity pair + trim        | the `t <> v` disjunct, on an all-keys key list              |
 * | NULL values                 | a repair never matches or produces NULL                     |
 * | stacked prefix repair       | the count runs over the EFFECTIVE relation, not pre-repair  |
 *
 * The last row is the drill that a pre-repair relation cannot pass: with a
 * prefix repair `{US → SG}` already applied, the second plan `{SG → Singapore}`
 * changes 2 rows over the effective relation but only 1 over the raw base
 * values.
 *
 * The CLI is the pinned DuckDB build (`DUCKDB`, default `/tmp/duckdb`) — the
 * same one the engine's other conformance tests spawn; when it is absent the
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

/** The plan as the domain's `column-repair` op (the fold's own input). */
function repairOp(plan: EngineRepairPlan): EditOp {
  return {
    kind: 'column-repair',
    column: plan.column,
    ...(plan.trim === undefined ? {} : { trim: plan.trim }),
    mapping: new Map(plan.pairs.map(([key, target]) => [key, target] as const)),
  }
}

interface CaseResult {
  readonly opCount: number
  readonly transitionalCount: number
  readonly composerCount: number
  readonly opIds: string
  readonly composerIds: string
}

/**
 * Compare, in one CLI invocation: the op's own count, the transitional
 * composed-SQL count, the number of rows the composed wrap changes (pre-apply
 * relation vs post-apply relation), and the two row-id sets.
 */
function runCase(
  plan: EngineRepairPlan,
  fixture: Fixture,
  prefix: readonly EditOp[] = [],
): CaseResult {
  const base: OverlayBase = { ...BASE, baseRowCount: fixture.rows.length }
  // The preview reads the pre-apply state: whatever the prefix has applied,
  // the plan itself is not in it yet.
  let state = initialState(base)
  for (const op of prefix) {
    const applied = stepOverlay(base, state, op)
    if (applied.application.outcome.status !== 'applied') {
      throw new Error(
        `the fixture prefix must be accepted by the fold, got: ${applied.application.outcome.status}`,
      )
    }
    state = applied.state
  }
  const snapshot: OverlayComposition = { viewName: 'assay_t1', base, state }
  // The plan the preview is *about* must itself be foldable (the surface only
  // previews plans the domain accepts).
  const published = stepOverlay(base, state, repairOp(plan))
  if (published.application.outcome.status !== 'applied') {
    throw new Error(
      `the fixture plan must be accepted by the fold, got: ${published.application.outcome.status}`,
    )
  }

  const relation = composeOverlayExportSelectSql(snapshot, 'parquet')
  const publishedRelation = composeOverlayExportSelectSql(
    { viewName: 'assay_t1', base, state: published.state },
    'parquet',
  )
  // The op's production statement…
  const opCountSql = `SELECT 'op_count', affected FROM (${composeRepairPreviewCountSql(
    snapshot,
    plan,
  )})`
  // …and the transitional host composition, rebuilt from the same exports.
  const where = whereClauseSql([repairAffectedFilter(plan)])
  if (where === null) throw new Error('a repair predicate is always present')
  const transitionalSql =
    `SELECT 'transitional_count', affected FROM ` +
    `(SELECT count(*)::BIGINT AS affected FROM (${relation}) WHERE ${where})`
  // The engine's own wrap: which rows does the plan actually change?
  const composedDiff =
    `FROM (${relation}) AS pre JOIN (${publishedRelation}) AS post ON pre."id" = post."id" ` +
    'WHERE pre."label" IS DISTINCT FROM post."label"'
  const column = quotedIdentifier(plan.column)
  const opIdsSql =
    `SELECT 'op_ids', list("id" ORDER BY "id") FROM (${relation}) ` +
    `WHERE (${column} ${repairAffectedPredicate(plan)})`

  const script = [
    fixtureSql(fixture),
    opCountSql,
    transitionalSql,
    `SELECT 'composer_count', count(*) ${composedDiff}`,
    opIdsSql,
    `SELECT 'composer_ids', list(pre."id" ORDER BY pre."id") ${composedDiff}`,
  ]
    .map((statement) => statement.trim().replace(/;?$/, ';'))
    .join('\n')

  const labelled = runLabelled(script)
  return {
    opCount: Number(labelled.get('op_count') ?? NaN),
    transitionalCount: Number(labelled.get('transitional_count') ?? NaN),
    composerCount: Number(labelled.get('composer_count') ?? NaN),
    opIds: labelled.get('op_ids') ?? '',
    composerIds: labelled.get('composer_ids') ?? '',
  }
}

describe.skipIf(!hasDuckDbCli)('repair-preview affected count — real DuckDB agreement', () => {
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
    const result = runCase({ column: 'label', trim: ' ', pairs: [['a', ' a ']] }, cancellation)
    expect(result.composerCount).toBe(2)
    expect(result.opCount).toBe(2)
    expect(result.transitionalCount).toBe(2)
    expect(result.opIds).toBe(result.composerIds)
    expect(result.opIds).toBe('[1, 2]')
  })

  it('(b) trim only (empty mapping): only the trim can change a value', () => {
    const result = runCase({ column: 'label', trim: ' ', pairs: [] }, cancellation)
    expect(result.composerCount).toBe(2)
    expect(result.opCount).toBe(2)
    expect(result.transitionalCount).toBe(2)
    expect(result.opIds).toBe(result.composerIds)
    expect(result.opIds).toBe('[0, 2]')
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
    const result = runCase({ column: 'label', pairs: [['SG', 'Singapore']] }, fixture)
    expect(result.composerCount).toBe(2)
    expect(result.opCount).toBe(2)
    expect(result.transitionalCount).toBe(2)
    expect(result.opIds).toBe(result.composerIds)
    expect(result.opIds).toBe('[0, 2]')
  })

  it('(d) trim + mapping, both applying: the trimmed value is the mapping operand', () => {
    // ` a ` trims to `a` and maps to `A`; `a` maps to `A`; `b` is untouched and
    // ` b ` trims to `b` — three rows change.
    const fixture: Fixture = {
      rows: [
        [0, ' a '],
        [1, 'a'],
        [2, 'b'],
        [3, ' b '],
        [4, null],
      ],
    }
    const result = runCase({ column: 'label', trim: ' ', pairs: [['a', 'A']] }, fixture)
    expect(result.composerCount).toBe(3)
    expect(result.opCount).toBe(3)
    expect(result.transitionalCount).toBe(3)
    expect(result.opIds).toBe(result.composerIds)
    expect(result.opIds).toBe('[0, 1, 3]')
  })

  it('(e) identity pair: the plan changes nothing at all', () => {
    const fixture: Fixture = {
      rows: [
        [0, 'SG'],
        [1, 'US'],
      ],
    }
    const result = runCase({ column: 'label', pairs: [['SG', 'SG']] }, fixture)
    expect(result.composerCount).toBe(0)
    expect(result.opCount).toBe(0)
    expect(result.transitionalCount).toBe(0)
    // `list(...)` over zero rows is NULL in DuckDB (not an empty list), which is
    // itself worth pinning: it is why the row-id assertion above compares the
    // two sides to each other before comparing either to a literal.
    expect(result.opIds).toBe('NULL')
    expect(result.composerIds).toBe('NULL')
  })

  it('(f) identity pair with a trim: the trim still changes the padded row', () => {
    // `M = {a → a}` looks like "no mapping", but with a trim the padded row
    // `' a '` becomes `a` — a real change, and it is the `t <> v` disjunct that
    // counts it (with term A in place a `liveKeys` subset would agree here, so
    // this case pins the disjunct: drop it and the count falls to 0).
    const fixture: Fixture = {
      rows: [
        [0, ' a '],
        [1, 'a'],
        [2, 'b'],
      ],
    }
    const result = runCase({ column: 'label', trim: ' ', pairs: [['a', 'a']] }, fixture)
    expect(result.composerCount).toBe(1)
    expect(result.opCount).toBe(1)
    expect(result.transitionalCount).toBe(1)
    expect(result.opIds).toBe(result.composerIds)
    expect(result.opIds).toBe('[0]')
  })

  it('(g) NULLs everywhere: a repair never matches and never produces NULL', () => {
    // (g1) an all-NULL column is untouched by any plan;
    // (g2) a NULL beside matching values is excluded from the count.
    const allNull: Fixture = {
      rows: [
        [0, null],
        [1, null],
      ],
    }
    const untouched = runCase({ column: 'label', trim: ' ', pairs: [['a', 'b']] }, allNull)
    expect(untouched.composerCount).toBe(0)
    expect(untouched.opCount).toBe(0)
    expect(untouched.transitionalCount).toBe(0)

    const mixed: Fixture = {
      rows: [
        [0, null],
        [1, 'a'],
        [2, null],
      ],
    }
    const counted = runCase({ column: 'label', pairs: [['a', 'b']] }, mixed)
    expect(counted.composerCount).toBe(1)
    expect(counted.opCount).toBe(1)
    expect(counted.opIds).toBe(counted.composerIds)
    expect(counted.opIds).toBe('[1]')
  })

  it('(h) a stacked prefix repair: the count runs over the effective relation', () => {
    // The prefix already repaired `US → SG`. The previewed plan maps `SG` to
    // `Singapore`, so over the EFFECTIVE relation two rows change (the original
    // `SG` and the re-repaired `US`); over the raw pre-repair values only one
    // would. A count pointed at the pre-repair relation reports 1, which is the
    // mutation this case exists to catch.
    const fixture: Fixture = {
      rows: [
        [0, 'SG'],
        [1, 'US'],
        [2, 'DE'],
        [3, null],
      ],
    }
    const prefix: readonly EditOp[] = [
      { kind: 'column-repair', column: 'label', mapping: new Map([['US', 'SG']]) },
    ]
    const result = runCase({ column: 'label', pairs: [['SG', 'Singapore']] }, fixture, prefix)
    expect(result.composerCount).toBe(2)
    expect(result.opCount).toBe(2)
    expect(result.transitionalCount).toBe(2)
    expect(result.opIds).toBe(result.composerIds)
    expect(result.opIds).toBe('[0, 1]')
    // The pre-repair count would be 1 — the drilled defect.
    expect(result.opCount).not.toBe(1)
  })

  it('(i) the op’s statement is the transitional composition, byte for byte', () => {
    const plan: EngineRepairPlan = { column: 'label', trim: ' ', pairs: [['a', ' a ']] }
    const base: OverlayBase = { ...BASE, baseRowCount: 5 }
    const composition: OverlayComposition = {
      viewName: 'assay_t1',
      base,
      state: initialState(base),
    }
    const relation = composeOverlayExportSelectSql(composition, 'parquet')
    const where = whereClauseSql([repairAffectedFilter(plan)])
    expect(where).not.toBeNull()
    expect(composeRepairPreviewCountSql(composition, plan)).toBe(
      `SELECT count(*)::BIGINT AS affected FROM (${relation}) WHERE ${where ?? ''}`,
    )
  })
})
