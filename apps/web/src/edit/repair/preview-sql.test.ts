// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import type { OverlayBase } from '@assay/domain'
import { initialState, stepOverlay } from '@assay/domain'
import type { RepairPlan } from './plan'
import {
  REPAIR_ENVELOPE,
  planPairs,
  repairAffectedCountSql,
  repairAffectedFilter,
  repairAffectedPredicate,
  repairScannedRows,
  repairedValue,
} from './preview-sql'

/**
 * EW-04I — the preview's predicate and count composition, pinned byte-exactly.
 *
 * The predicate is the one expression this row authors (the relation comes from
 * the engine's exported composer and the literals from its escaper), so its
 * exact text is worth pinning: identifier quoting, single-quote doubling, the
 * explicit `trim(<col>, <set>)` construct the composer itself emits, the
 * pair-set cancellation term, the key list, and the NULL rule. The equivalence
 * of this predicate with the *applied* effect is pinned against the real engine
 * in `preview-sql.engine.test.ts` (for every plan shape the fold accepts,
 * including the trim/mapping cancellation) and end to end by
 * `tests/e2e/repair-journey.spec.ts`; these are the composition's own
 * invariants.
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

const SNAPSHOT = {
  viewName: 'assay_t1',
  base: BASE,
  state: initialState(BASE),
}

function plan(overrides: Partial<RepairPlan> = {}): RepairPlan {
  return {
    column: 'country',
    mapping: new Map([['SG', 'Singapore']]),
    ...overrides,
  }
}

describe('planPairs — the pair set, in a deterministic order', () => {
  it('keeps identity pairs and sorts by key', () => {
    // Identity pairs are PART of the rule (term A cancels them, term B counts
    // the key), so nothing is filtered out here.
    expect(
      planPairs(
        plan({
          mapping: new Map([
            ['US', 'United States'],
            ['SG', 'SG'],
            ['DE', 'Germany'],
          ]),
        }),
      ),
    ).toEqual([
      ['DE', 'Germany'],
      ['SG', 'SG'],
      ['US', 'United States'],
    ])
  })
})

describe('repairAffectedPredicate — the exact affected rule as one filter clause', () => {
  it('without a trim: the pair set cancels an identity pair, the key list keeps the rest', () => {
    expect(repairAffectedPredicate(plan())).toBe(
      'IS NOT NULL AND ("country", "country") NOT IN (VALUES (\'SG\', \'Singapore\')) ' +
        'AND ("country" IN (\'SG\') OR "country" <> "country")',
    )
  })

  it('with a trim: one trim() operand, the trim diff AND the mapping both feed the pair set', () => {
    const predicate = repairAffectedPredicate(
      plan({ trim: ' \t', mapping: new Map([['SG', 'Singapore']]) }),
    )
    expect(predicate).toBe(
      'IS NOT NULL AND ' +
        "(trim(\"country\", ' \t'), \"country\") NOT IN (VALUES ('SG', 'Singapore')) AND " +
        '(trim("country", \' \t\') IN (\'SG\') OR trim("country", \' \t\') <> "country")',
    )
    // Three occurrences of the SAME construct — never a duplicated or nested wrap.
    expect(predicate.match(/trim\(/g)).toHaveLength(3)
  })

  it('a trim-only plan changes rows only through the trim term', () => {
    expect(repairAffectedPredicate(plan({ trim: ' ', mapping: new Map() }))).toBe(
      'IS NOT NULL AND trim("country", \' \') <> "country"',
    )
  })

  it('an identity pair is a real cancellation: no trim, nothing changes', () => {
    // `M = {SG → SG}`: term A matches `(SG, SG)`, so the row is NOT affected —
    // the fold accepts this plan and it must preview as zero-affected (U1).
    expect(repairAffectedPredicate(plan({ mapping: new Map([['SG', 'SG']]) }))).toBe(
      'IS NOT NULL AND ("country", "country") NOT IN (VALUES (\'SG\', \'SG\')) ' +
        'AND ("country" IN (\'SG\') OR "country" <> "country")',
    )
  })

  it('a trim/mapping cancellation is excluded by the pair-set term (fix round 1)', () => {
    // Reviewer's real-engine case: trim ' ' with M = {a → ' a '} maps the
    // trimmed value straight back, so `' a '` is unchanged. The first shipped
    // predicate counted it (3 of 5 rows instead of 2) and let a no-op plan pass
    // the zero-affected refusal.
    expect(repairAffectedPredicate(plan({ trim: ' ', mapping: new Map([['a', ' a ']]) }))).toBe(
      "IS NOT NULL AND (trim(\"country\", ' '), \"country\") NOT IN (VALUES ('a', ' a ')) " +
        'AND (trim("country", \' \') IN (\'a\') OR trim("country", \' \') <> "country")',
    )
  })

  it('an identity pair with a trim still counts the key (why the liveKeys shortcut was removed)', () => {
    // `M = {a → a}` with trim ' ': the row `' a '` trims to `a` and maps to
    // `a`, a real change on a pair whose "target differs from key" is false —
    // the removed shortcut would have missed it. Term B lists ALL keys.
    expect(repairAffectedPredicate(plan({ trim: ' ', mapping: new Map([['a', 'a']]) }))).toBe(
      "IS NOT NULL AND (trim(\"country\", ' '), \"country\") NOT IN (VALUES ('a', 'a')) " +
        'AND (trim("country", \' \') IN (\'a\') OR trim("country", \' \') <> "country")',
    )
  })

  it('escapes a quote by doubling and quotes the identifier (keys AND targets)', () => {
    const predicate = repairAffectedPredicate(
      plan({
        column: 'odd "name"',
        mapping: new Map([
          ["O'Brien", "O'Brien2"],
          ['a', 'b'],
        ]),
      }),
    )
    expect(predicate).toBe(
      'IS NOT NULL AND ("odd ""name""", "odd ""name""") NOT IN ' +
        "(VALUES ('O''Brien', 'O''Brien2'), ('a', 'b')) AND " +
        '("odd ""name""" IN (\'O\'\'Brien\', \'a\') OR "odd ""name""" <> "odd ""name""")',
    )
  })

  it('is the same string the filter spec carries (one source, two uses)', () => {
    const subject = plan({ trim: ' ' })
    expect(repairAffectedFilter(subject)).toEqual({
      column: 'country',
      predicate: repairAffectedPredicate(subject),
    })
  })
})

describe('repairAffectedCountSql — the complete count over the engine’s own relation', () => {
  it('counts under the predicate over the engine-composed effective relation', () => {
    const sql = repairAffectedCountSql(SNAPSHOT, plan())
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

  it('composes the repair wrap when the prefix already carries a repair (the case the typed count op cannot see)', () => {
    const first = stepOverlay(BASE, SNAPSHOT.state, {
      kind: 'column-repair',
      column: 'country',
      mapping: new Map([['SG', 'Singapore']]),
    })
    expect(first.application.outcome.status).toBe('applied')
    const sql = repairAffectedCountSql({ ...SNAPSHOT, state: first.state }, plan())
    // The stacked repair layer is present (the wrap is an inner projection)…
    expect(sql).toContain("CASE \"country\" WHEN 'SG' THEN CAST('Singapore' AS VARCHAR)")
    // …and the predicate still sits in the outer WHERE.
    expect(sql).toContain('WHERE ("country" IS NOT NULL AND')
  })

  it('is not sanitized (a CSV guard would rewrite the values the predicate reads)', () => {
    const sql = repairAffectedCountSql(SNAPSHOT, plan())
    expect(sql).not.toContain('left(')
    expect(sql).not.toContain('chr(9)')
  })

  it('states the envelope constant it is compared against', () => {
    expect(REPAIR_ENVELOPE).toBe(1_000_000_000)
  })
})

describe('scanned rows — the pure fold, no engine call', () => {
  it('is base rows minus tombstones plus live inserts', () => {
    expect(repairScannedRows(BASE, SNAPSHOT.state)).toBe(5)
  })
})

describe('repairedValue — the domain’s own trim∘map, never String.prototype.trim()', () => {
  it('trims with the plan’s set only, then maps exactly', () => {
    const subject = plan({ trim: ' ' })
    expect(repairedValue('  SG  ', subject)).toBe('Singapore')
    // A non-matching value's passthrough is its TRIMMED value (EW-04D §1).
    expect(repairedValue('  us  ', subject)).toBe('us')
    // NBSP is not in the plan's set, so it survives — the difference from
    // String.prototype.trim(), which would strip it.
    expect(repairedValue('\u00a0SG\u00a0', subject)).toBe('\u00a0SG\u00a0')
  })

  it('without a trim the mapping matches the raw value exactly', () => {
    const subject = plan()
    expect(repairedValue('SG', subject)).toBe('Singapore')
    expect(repairedValue(' SG', subject)).toBe(' SG')
    expect(repairedValue('', subject)).toBe('')
  })

  it('the cancellation plan repairs ` a ` back to itself (the fix-round-1 case)', () => {
    const subject = plan({ trim: ' ', mapping: new Map([['a', ' a ']]) })
    expect(repairedValue(' a ', subject)).toBe(' a ')
    expect(repairedValue('a', subject)).toBe(' a ')
    expect(repairedValue(' x ', subject)).toBe('x')
  })
})
