// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { compileRowDiffPlan } from './row-diff-compile'
import { scanOrdinalScopes } from './diff-property-testing'
import type { RowDiffPlan } from './row-diff-plan'

/**
 * Row-diff ordinal **semantics** — the pre-filter contract, hand-derived
 * (m6-1 fix round 1).
 *
 * A `row_number() OVER ()` window projected in the same SELECT as a
 * `WHERE` numbers only the *surviving* rows: SQL evaluates window functions
 * after `WHERE`. The round-1 defects (antiJoinSource and changedSource)
 * did exactly that, so the reported `assay_row_ordinal` was `0..K-1`
 * instead of the side's true scan position — which breaks the m6-2
 * `base:<anchor>#<ordinal>` binding contract whenever any row is filtered
 * out (essentially always). The compiler now computes the ordinal in an
 * inner projection over the **unfiltered** relation (the m5-1
 * `rowSamplesSql` pattern) and applies the anti-join / full-outer-join
 * filter outside it.
 *
 * The committed package is pure (no engine), so this suite pins the
 * contract structurally and records the hand-derivation in a form m6-2 can
 * lift verbatim into its env-gated DuckDB agreement suite. The SQL below
 * was executed against DuckDB CLI 1.5.5 during the fix (see the report);
 * the reference derivation here is a pure model of the documented
 * semantics, not an execution.
 *
 * ## Fixture (side A = base/reference, side B = current)
 *
 * Both sides are `(id BIGINT, val VARCHAR)`; key = `[id]`; shared non-key
 * column = `val`; K (`sampleLimit`) = 3. Rows are written in natural scan
 * order and the leading integer is the row's 0-based **scan position**
 * (the `assay_row_ordinal` truth for that side). `IS NOT DISTINCT FROM`
 * is modelled by `===` for these non-NULL scalars.
 *
 * | side | pos | id | val | note                         |
 * | ---- | --- | -- | --- | ---------------------------- |
 * | A    | 0   | 1  | a   | unchanged                    |
 * | A    | 1   | 2  | b   | changed (B val 'B')          |
 * | A    | 2   | 3  | c   | changed (B val 'C')          |
 * | A    | 3   | 4  | d   | unchanged                    |
 * | A    | 4   | 5  | e   | unchanged                    |
 * | A    | 5   | 6  | f   | removed (no B id 6)          |
 * | A    | 6   | 7  | g   | changed (B val 'G')          |
 * | A    | 7   | 8  | h   | removed (no B id 8)          |
 * | B    | 0   | 1  | a   | unchanged                    |
 * | B    | 1   | 2  | B   | changed                      |
 * | B    | 2   | 3  | C   | changed                      |
 * | B    | 3   | 4  | d   | unchanged                    |
 * | B    | 4   | 5  | e   | unchanged                    |
 * | B    | 5   | 9  | x   | added (no A id 9)            |
 * | B    | 6   | 10 | y   | added (no A id 10)           |
 * | B    | 7   | 7  | G   | changed                      |
 *
 * ## Hand-derivation (expected samples and exact counts at K = 3)
 *
 * | aspect  | matching rows                | expected ordinals | count | post-filter (wrong) |
 * | ------- | ---------------------------- | ----------------- | ----- | ------------------- |
 * | added   | B pos 5, 6                   | `[5, 6]`          | 2     | `[0, 1]`            |
 * | removed | A pos 5, 7                   | `[5, 7]`          | 2     | `[0, 1]`            |
 * | changed | A pos 1, 2, 6 (the pair side)| `[1, 2, 6]`       | 3     | `[0, 1, 2]`         |
 *
 * (`changed` carries the **A-side** ordinal; B rows are report content.)
 * m6-2's env-gated agreement suite executes `addedSql` / `removedSql` /
 * `changedSql` / `totalsSql` against this fixture and asserts the
 * ordinals/counts above. The post-filter column is what the round-1 defect
 * produced — it differs for every aspect, which is why this fixture
 * discriminates.
 */

interface FixtureRow {
  readonly id: number
  readonly val: string
}

const KEYS = ['id'] as const
const SHARED = ['val'] as const
const SAMPLE_LIMIT = 3

const SIDE_A: readonly FixtureRow[] = [
  { id: 1, val: 'a' },
  { id: 2, val: 'b' },
  { id: 3, val: 'c' },
  { id: 4, val: 'd' },
  { id: 5, val: 'e' },
  { id: 6, val: 'f' },
  { id: 7, val: 'g' },
  { id: 8, val: 'h' },
]

/** A-side scan position of each row above — the truth the fixture records. */
const A_SCAN = [0, 1, 2, 3, 4, 5, 6, 7] as const

const SIDE_B: readonly FixtureRow[] = [
  { id: 1, val: 'a' },
  { id: 2, val: 'B' },
  { id: 3, val: 'C' },
  { id: 4, val: 'd' },
  { id: 5, val: 'e' },
  { id: 9, val: 'x' },
  { id: 10, val: 'y' },
  { id: 7, val: 'G' },
]

const B_SCAN = [0, 1, 2, 3, 4, 5, 6, 7] as const

/**
 * The hand-derived expectation (fixture → ordinals per aspect), duplicated
 * for m6-2 to lift. The reference derivation below is asserted against
 * this table so the documented values cannot drift.
 */
const EXPECTED_ORDINALS = {
  added: [5, 6],
  removed: [5, 7],
  changed: [1, 2, 6],
} as const satisfies Record<string, readonly number[]>

const EXPECTED_COUNTS = { added: 2, removed: 2, changed: 3 } as const

/**
 * Pure reference model of the documented semantics (independent of the SQL
 * compiler): `===` models `IS NOT DISTINCT FROM` for these non-NULL
 * scalars; ordinals are the indices in the *unfiltered* scan.
 */
function deriveOrdinals(
  sideA: readonly FixtureRow[],
  sideB: readonly FixtureRow[],
  keys: readonly (keyof FixtureRow)[],
  shared: readonly (keyof FixtureRow)[],
): { added: number[]; removed: number[]; changed: number[] } {
  const keyMatch = (a: FixtureRow, b: FixtureRow): boolean => keys.every((key) => a[key] === b[key])
  const added: number[] = []
  sideB.forEach((b, bi) => {
    if (!sideA.some((a) => keyMatch(a, b))) added.push(bi)
  })
  const removed: number[] = []
  sideA.forEach((a, ai) => {
    if (!sideB.some((b) => keyMatch(a, b))) removed.push(ai)
  })
  const changed: number[] = []
  sideA.forEach((a, ai) => {
    const pair = sideB.find((b) => keyMatch(a, b))
    if (pair === undefined) return
    if (shared.some((column) => a[column] !== pair[column])) changed.push(ai)
  })
  return { added, removed, changed }
}

const DERIVED = deriveOrdinals(SIDE_A, SIDE_B, KEYS, SHARED)

function compileFixture(): RowDiffPlan {
  const result = compileRowDiffPlan(
    [
      { name: 'id', type: 'BIGINT' },
      { name: 'val', type: 'VARCHAR' },
    ],
    [
      { name: 'id', type: 'BIGINT' },
      { name: 'val', type: 'VARCHAR' },
    ],
    [...KEYS],
    { relationA: 'ds_a', relationB: 'ds_b', sampleLimit: SAMPLE_LIMIT },
  )
  if (!result.ok) throw new Error(`fixture compile failed: ${JSON.stringify(result.errors)}`)
  return result.plan
}

describe('row-diff ordinal semantics — hand-derived pre-filter expectation (all aspects)', () => {
  const plan = compileFixture()

  it('the reference derivation matches the documented fixture table (spot-checked against DuckDB 1.5.5)', () => {
    expect(DERIVED).toEqual(EXPECTED_ORDINALS)
    expect({
      added: DERIVED.added.length,
      removed: DERIVED.removed.length,
      changed: DERIVED.changed.length,
    }).toEqual(EXPECTED_COUNTS)
    // The fixture records the scan positions explicitly.
    expect(SIDE_A[DERIVED.removed[0] as number]?.id).toBe(6)
    expect(SIDE_A[DERIVED.removed[1] as number]?.id).toBe(8)
    expect(SIDE_B[DERIVED.added[0] as number]?.id).toBe(9)
    expect(SIDE_B[DERIVED.added[1] as number]?.id).toBe(10)
  })

  it('the fixture discriminates: pre-filter ordinals differ from post-filter 0..K-1 for every aspect', () => {
    // If the matching rows sat at scan positions 0..K-1 a post-filter
    // regression would be invisible — this pin keeps the fixture honest.
    for (const aspect of ['added', 'removed', 'changed'] as const) {
      const preFilter = EXPECTED_ORDINALS[aspect]
      const postFilter = preFilter.map((_, i) => i)
      expect(preFilter).not.toEqual(postFilter)
    }
    expect(A_SCAN[0]).toBe(0)
    expect(B_SCAN[0]).toBe(0)
  })

  it('added (B-side anti-join): ordinal computed pre-filter, count exact', () => {
    const scan = scanOrdinalScopes(plan.addedSql)
    expect(scan.violations).toEqual([])
    expect(scan.ordinalWindows).toBe(1)
    expect(plan.addedSql).toContain('SELECT "assay_row_ordinal"')
    expect(plan.addedSql).toContain(') AS "assay_antijoin_source"')
    expect(plan.addedSql).toContain('count(*) OVER () AS "assay_count"')
  })

  it('removed (A-side anti-join): ordinal computed pre-filter, count exact', () => {
    const scan = scanOrdinalScopes(plan.removedSql)
    expect(scan.violations).toEqual([])
    expect(scan.ordinalWindows).toBe(1)
    expect(plan.removedSql).toContain('SELECT "assay_row_ordinal"')
    expect(plan.removedSql).toContain(') AS "assay_antijoin_source"')
    expect(plan.removedSql).toContain('count(*) OVER () AS "assay_count"')
  })

  it('changed (full outer join): the A-side ordinal is carried from "ai" (not re-numbered post-WHERE)', () => {
    const scan = scanOrdinalScopes(plan.changedSql)
    expect(scan.violations).toEqual([])
    expect(scan.ordinalWindows).toBe(1)
    // the outer projection must reference the inner A-side ordinal…
    expect(plan.changedSql).toContain('SELECT "ai"."assay_row_ordinal",')
    // …and must NOT re-number the post-WHERE rows (the round-1 shape was a
    // re-numbering outer projection immediately before the changed list)
    expect(plan.changedSql).not.toContain(
      'SELECT row_number() OVER () - 1 AS "assay_row_ordinal",\n         list_concat(',
    )
    expect(plan.changedSql).toContain('count(*) OVER () AS "assay_count"')
    expect(plan.sharedColumns).toEqual([...SHARED])
  })

  it('totals: each aspect arm embeds the pre-filter source and count', () => {
    const arms = plan.totalsSql.split('\nUNION ALL\n')
    expect(arms).toHaveLength(3)
    let windows = 0
    for (const arm of arms) {
      const scan = scanOrdinalScopes(arm)
      expect(scan.violations).toEqual([])
      windows += scan.ordinalWindows
    }
    expect(windows).toBe(3)
    expect(plan.totalsSql).toContain(`SELECT 'added' AS "assay_aspect"`)
    expect(plan.totalsSql).toContain(`SELECT 'removed' AS "assay_aspect"`)
    expect(plan.totalsSql).toContain(`SELECT 'changed' AS "assay_aspect"`)
  })
})
