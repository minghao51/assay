// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import type { OverlayBase } from '@assay/domain'
import { initialState, MAX_REPAIR_MAPPING_PAIRS, MAX_REPAIR_TRIM_CODE_POINTS } from '@assay/domain'
import { composeOverlayExportSelectSql } from './export-query.js'
import type { OverlayComposition } from './overlay-query.js'
import {
  assertEngineRepairPlanWithinEnvelope,
  composeRepairPreviewCountSql,
  parseEngineRepairPlan,
  repairAffectedFilter,
  repairAffectedPredicate,
} from './repair-preview-query.js'
import type { EngineRepairPlan } from './repair-preview-query.js'

/**
 * B1/ENG-2 — the affected-set predicate, the plan's wire/envelope gates, and
 * the count composition, pinned byte-exactly.
 *
 * The predicate is the one expression this op authors (the relation comes from
 * the engine's exported export-SELECT composer and the literals from its own
 * escaper), so its exact text is worth pinning: identifier quoting,
 * single-quote doubling, the explicit `trim(<col>, <set>)` construct the
 * composer itself emits, the pair-set cancellation term, the key list, and the
 * NULL rule. The equivalence of this predicate with the *applied* effect is
 * pinned against the real engine in `repair-preview-query.engine.test.ts` (for
 * every plan shape the fold accepts, including the trim/mapping cancellation);
 * these are the composition's own invariants.
 *
 * The plan boundary is pinned here too: every hostile value the wire can carry
 * either fails the structural parse (nothing composed, nothing executed) or
 * fails the envelope with a value-free sentence — and a legitimate-but-hostile
 * *value* is escaped into the composed SQL, never interpolated.
 */

const BASE: OverlayBase = {
  baseAnchor: 'fv-5-1000',
  overlayAnchor: 'ov-1',
  columns: [
    { name: 'id', type: 'BIGINT' },
    { name: 'country', type: 'VARCHAR' },
  ],
  baseRowCount: 5,
}

const COMPOSITION: OverlayComposition = {
  viewName: 'assay_t1',
  base: BASE,
  state: initialState(BASE),
}

/** A wire plan; `pairs` is the array form the protocol carries. */
function plan(overrides: Partial<EngineRepairPlan> = {}): EngineRepairPlan {
  return { column: 'country', pairs: [['SG', 'Singapore']], ...overrides }
}

describe('repairAffectedPredicate — the exact affected rule as one filter clause', () => {
  it('without a trim: the pair set cancels an identity pair, the key list keeps the rest', () => {
    expect(repairAffectedPredicate(plan())).toBe(
      'IS NOT NULL AND ("country", "country") NOT IN (VALUES (\'SG\', \'Singapore\')) ' +
        'AND ("country" IN (\'SG\') OR "country" <> "country")',
    )
  })

  it('with a trim: one trim() operand, the trim diff AND the mapping both feed the pair set', () => {
    const predicate = repairAffectedPredicate(plan({ trim: ' \t', pairs: [['SG', 'Singapore']] }))
    expect(predicate).toBe(
      'IS NOT NULL AND ' +
        "(trim(\"country\", ' \t'), \"country\") NOT IN (VALUES ('SG', 'Singapore')) AND " +
        '(trim("country", \' \t\') IN (\'SG\') OR trim("country", \' \t\') <> "country")',
    )
    // Three occurrences of the SAME construct — never a duplicated or nested wrap.
    expect(predicate.match(/trim\(/g)).toHaveLength(3)
  })

  it('a trim-only plan changes rows only through the trim term', () => {
    expect(repairAffectedPredicate(plan({ trim: ' ', pairs: [] }))).toBe(
      'IS NOT NULL AND trim("country", \' \') <> "country"',
    )
  })

  it('an identity pair is a real cancellation: no trim, nothing changes', () => {
    // `M = {SG → SG}`: term A matches `(SG, SG)`, so the row is NOT affected —
    // the fold accepts this plan and it must preview as zero-affected (U1).
    expect(repairAffectedPredicate(plan({ pairs: [['SG', 'SG']] }))).toBe(
      'IS NOT NULL AND ("country", "country") NOT IN (VALUES (\'SG\', \'SG\')) ' +
        'AND ("country" IN (\'SG\') OR "country" <> "country")',
    )
  })

  it('a trim/mapping cancellation is excluded by the pair-set term (EW-04I fix round 1)', () => {
    // Reviewer's real-engine case: trim ' ' with M = {a → ' a '} maps the
    // trimmed value straight back, so `' a '` is unchanged. The first shipped
    // predicate counted it (3 of 5 rows instead of 2) and let a no-op plan pass
    // the zero-affected refusal.
    expect(repairAffectedPredicate(plan({ trim: ' ', pairs: [['a', ' a ']] }))).toBe(
      "IS NOT NULL AND (trim(\"country\", ' '), \"country\") NOT IN (VALUES ('a', ' a ')) " +
        'AND (trim("country", \' \') IN (\'a\') OR trim("country", \' \') <> "country")',
    )
  })

  it('an identity pair with a trim still counts the key (term B lists all keys)', () => {
    // `M = {a → a}` with trim ' ': the row `' a '` trims to `a` and maps to
    // `a`, a real change. It is counted by the `t <> v` disjunct, not by a
    // key-set distinction — with term A in place a `liveKeys` subset would be
    // equivalent here, so this case pins the disjunct and the flat key list.
    expect(repairAffectedPredicate(plan({ trim: ' ', pairs: [['a', 'a']] }))).toBe(
      "IS NOT NULL AND (trim(\"country\", ' '), \"country\") NOT IN (VALUES ('a', 'a')) " +
        'AND (trim("country", \' \') IN (\'a\') OR trim("country", \' \') <> "country")',
    )
  })

  it('escapes a quote by doubling and quotes the identifier (keys AND targets)', () => {
    const predicate = repairAffectedPredicate({
      column: 'odd "name"',
      pairs: [
        ['a', 'b'],
        ["O'Brien", "O'Brien2"],
      ],
    })
    expect(predicate).toBe(
      'IS NOT NULL AND ("odd ""name""", "odd ""name""") NOT IN ' +
        "(VALUES ('O''Brien', 'O''Brien2'), ('a', 'b')) AND " +
        '("odd ""name""" IN (\'O\'\'Brien\', \'a\') OR "odd ""name""" <> "odd ""name""")',
    )
  })

  it('is deterministic for one plan: pair order is canonical, not caller order', () => {
    const forward = repairAffectedPredicate(
      plan({
        pairs: [
          ['a', 'b'],
          ['c', 'd'],
        ],
      }),
    )
    const reversed = repairAffectedPredicate(
      plan({
        pairs: [
          ['c', 'd'],
          ['a', 'b'],
        ],
      }),
    )
    expect(reversed).toBe(forward)
    expect(forward).toContain("(VALUES ('a', 'b'), ('c', 'd'))")
  })

  it('is the same string the filter spec carries (one source, two uses)', () => {
    const subject = plan({ trim: ' ' })
    expect(repairAffectedFilter(subject)).toEqual({
      column: 'country',
      predicate: repairAffectedPredicate(subject),
    })
  })
})

describe('composeRepairPreviewCountSql — the complete count over the engine’s own relation', () => {
  it('counts under the predicate over the engine-composed effective relation', () => {
    const sql = composeRepairPreviewCountSql(COMPOSITION, plan())
    expect(sql).toBe(
      'SELECT count(*)::BIGINT AS affected FROM ' +
        '(SELECT "id", "country" FROM (SELECT "id" AS "id", "country" AS "country" FROM ' +
        '(SELECT "id", "country", (row_number() OVER () - 1) AS assay_overlay_ord FROM "assay_t1"))) ' +
        `WHERE ("country" ${repairAffectedPredicate(plan())})`,
    )
    // The relation is the engine's, composed by the engine's own export
    // composer (its machinery ordinal is visible here and pruned by the count).
    expect(sql).toContain('FROM "assay_t1"')
  })

  it('is not sanitized (a CSV guard would rewrite the values the predicate reads)', () => {
    const sql = composeRepairPreviewCountSql(COMPOSITION, plan())
    expect(sql).not.toContain('left(')
    expect(sql).not.toContain('chr(9)')
  })
})

describe('parseEngineRepairPlan — structure only, never a throw', () => {
  it('accepts a canonical plan and drops any foreign field', () => {
    expect(
      parseEngineRepairPlan({
        column: 'country',
        pairs: [['SG', 'Singapore']],
        // A hostile sender may attach anything; the parsed request keeps the
        // protocol's own fields only (nothing becomes a predicate).
        predicate: 'OR 1 = 1',
        sql: 'DROP TABLE assay_t1',
      }),
    ).toEqual({ column: 'country', pairs: [['SG', 'Singapore']] })
  })

  it('canonicalises pair order and keeps identity pairs', () => {
    expect(
      parseEngineRepairPlan({
        column: 'country',
        pairs: [
          ['US', 'United States'],
          ['SG', 'SG'],
          ['DE', 'Germany'],
        ],
      }),
    ).toEqual({
      column: 'country',
      pairs: [
        ['DE', 'Germany'],
        ['SG', 'SG'],
        ['US', 'United States'],
      ],
    })
  })

  it.each([
    ['a non-object plan', 'nope'],
    ['an array plan', []],
    ['a missing column', { pairs: [] }],
    ['a non-string column', { column: 7, pairs: [] }],
    ['a non-string trim', { column: 'country', trim: 1, pairs: [] }],
    ['a missing pairs list', { column: 'country' }],
    ['a non-array pairs list', { column: 'country', pairs: 'SG => Singapore' }],
    ['a non-string key', { column: 'country', pairs: [[1, 'x']] }],
    ['a non-string target', { column: 'country', pairs: [['a', null]] }],
    ['a one-member pair', { column: 'country', pairs: [['a']] }],
    ['a three-member pair', { column: 'country', pairs: [['a', 'b', 'c']] }],
    ['a pair that is not an array', { column: 'country', pairs: [{ 0: 'a', 1: 'b' }] }],
    ['an SQL fragment as the pairs list itself', { column: 'country', pairs: '; DROP TABLE t' }],
  ])('refuses %s', (_label, value) => {
    expect(parseEngineRepairPlan(value)).toBeNull()
  })
})

describe('assertEngineRepairPlanWithinEnvelope — typed, value-free plan refusals', () => {
  function refusalOf(subject: EngineRepairPlan): string {
    try {
      assertEngineRepairPlanWithinEnvelope(subject)
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    return ''
  }

  it('refuses an empty plan (no pairs, no trim) — the identity cannot change a row', () => {
    expect(refusalOf({ column: 'country', pairs: [] })).toBe('repair plan is empty')
    // …while a trim-only plan is a real plan.
    expect(refusalOf({ column: 'country', trim: ' ', pairs: [] })).toBe('')
  })

  it('refuses a duplicate key without naming it', () => {
    const message = refusalOf({
      column: 'country',
      pairs: [
        ['SECRET-KEY', 'a'],
        ['SECRET-KEY', 'b'],
      ],
    })
    expect(message).toBe('repair plan repeats a mapping key')
    expect(message).not.toContain('SECRET-KEY')
  })

  it(`refuses more than the domain pair cap (${String(MAX_REPAIR_MAPPING_PAIRS)})`, () => {
    const pairs: [string, string][] = []
    for (let index = 0; index <= MAX_REPAIR_MAPPING_PAIRS; index += 1) {
      pairs.push([`k${String(index)}`, 'v'])
    }
    expect(refusalOf({ column: 'country', pairs })).toBe(
      `repair plan exceeds the ${String(MAX_REPAIR_MAPPING_PAIRS)}-pair cap`,
    )
    // Exactly at the cap is accepted (the cap is unchanged by this op).
    expect(refusalOf({ column: 'country', pairs: pairs.slice(1) })).toBe('')
  })

  it(`refuses a bad trim set (empty, or over ${String(MAX_REPAIR_TRIM_CODE_POINTS)} code points)`, () => {
    expect(refusalOf({ column: 'country', trim: '', pairs: [['a', 'b']] })).toBe(
      'repair plan has an invalid trim set',
    )
    expect(
      refusalOf({
        column: 'country',
        trim: 'x'.repeat(MAX_REPAIR_TRIM_CODE_POINTS + 1),
        pairs: [['a', 'b']],
      }),
    ).toBe('repair plan has an invalid trim set')
    // Astral members count once, exactly as the domain fold counts them.
    expect(
      refusalOf({
        column: 'country',
        trim: '\u{1F600}'.repeat(MAX_REPAIR_TRIM_CODE_POINTS),
        pairs: [['a', 'b']],
      }),
    ).toBe('')
  })

  it('refuses text no SQL literal can carry (NUL, unpaired surrogate), value-free', () => {
    const cases: EngineRepairPlan[] = [
      { column: 'country', pairs: [['a\u0000b', 'x']] },
      { column: 'country', pairs: [['a', 'x\u0000']] },
      { column: 'country', trim: ' \u0000', pairs: [['a', 'b']] },
      { column: 'country', pairs: [['a\uD800', 'x']] },
      { column: 'country', pairs: [['a', 'x\uDC00']] },
    ]
    for (const subject of cases) {
      const message = refusalOf(subject)
      expect(message).toBe('repair plan contains text the engine cannot materialise')
      // Value-free: never the offending text, never the NUL itself.
      expect(message).not.toContain('\u0000')
      expect(message).not.toContain('\uD800')
    }
  })

  it('refuses unrepresentable text at COMPOSITION too (defence in depth)', () => {
    // A caller that skipped the envelope cannot make the composer emit a raw
    // NUL or an unpaired surrogate into SQL text.
    expect(() =>
      repairAffectedPredicate({ column: 'country', pairs: [['a\u0000b', 'x']] }),
    ).toThrow(/cannot materialise/)
    expect(() => repairAffectedPredicate({ column: 'country', pairs: [['a', 'x\uD800']] })).toThrow(
      /cannot materialise/,
    )
  })
})

describe('hostile wire values never become SQL text', () => {
  const HOSTILE = [
    "b'); DROP TABLE assay_t1; --",
    "' OR 1 = 1 --",
    '"; DROP TABLE x; --',
    'a; DELETE FROM t',
    '/* comment */',
  ]

  it.each(HOSTILE)('escapes %s into a literal and keeps the statement shape', (hostile) => {
    // The composed statement is EXACTLY the count form with the value escaped
    // by single-quote doubling: nothing else the value contains (`;`, `--`,
    // a comment opener, a quote) is interpolated, so it cannot end the literal
    // or start a second statement.
    const escaped = hostile.replaceAll("'", "''")
    expect(composeRepairPreviewCountSql(COMPOSITION, plan({ pairs: [[hostile, hostile]] }))).toBe(
      'SELECT count(*)::BIGINT AS affected FROM ' +
        `(${composeOverlayExportSelectSql(COMPOSITION, 'parquet')}) ` +
        'WHERE ("country" IS NOT NULL AND ' +
        `("country", "country") NOT IN (VALUES ('${escaped}', '${escaped}')) AND ` +
        `("country" IN ('${escaped}') OR "country" <> "country"))`,
    )
  })

  it('escapes a hostile identifier by doubling its quote', () => {
    const sql = composeRepairPreviewCountSql(
      COMPOSITION,
      plan({ column: 'country" FROM assay_t1; --' }),
    )
    expect(sql).toContain('"country"" FROM assay_t1; --"')
    expect(sql).not.toContain('"country" FROM assay_t1')
  })
})
