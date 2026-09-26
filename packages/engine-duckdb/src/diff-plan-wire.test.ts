// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { compileRowDiffPlan } from '@assay/diff'
import {
  assertRowDiffPlanBinding,
  parseRowDiffPlan,
  quotedRelationToken,
  ROW_DIFF_SAMPLE_HARD_MAX,
} from './diff-plan-wire'
import type { EngineRowDiffPlan } from './diff-plan-wire'

/**
 * Wire-boundary matrix for the m6-2 row-diff plan (the m5-2
 * `validate-plan-wire.test.ts` precedent). Real compiler output is the
 * accepted shape (the conformance scenario runs it through the boundary
 * end-to-end); the mutations below pin every rejection class in isolation.
 */

const SCHEMA = [
  { name: 'id', type: 'BIGINT' },
  { name: 'email', type: 'VARCHAR' },
]

function compiledPlan(overrides: { sampleLimit?: number } = {}): EngineRowDiffPlan {
  const result = compileRowDiffPlan(SCHEMA, SCHEMA, ['id'], {
    relationA: 'ds_a',
    relationB: 'scratch_ds_b',
    ...(overrides.sampleLimit === undefined
      ? { sampleLimit: 3 }
      : { sampleLimit: overrides.sampleLimit }),
  })
  if (!result.ok) throw new Error(`fixture compile failed: ${JSON.stringify(result.errors)}`)
  return result.plan
}

describe('parseRowDiffPlan (m6-2 wire boundary)', () => {
  it('accepts real compiler output as a deep-equal copy (not the live object)', () => {
    const plan = compiledPlan()
    const parsed = parseRowDiffPlan(plan)
    expect(parsed).not.toBeNull()
    expect(parsed).toEqual(plan)
    expect(parsed).not.toBe(plan)
    expect(parsed?.keys).not.toBe(plan.keys)
  })

  it('rejects non-objects, wrong discriminators, and the wrong version', () => {
    expect(parseRowDiffPlan(null)).toBeNull()
    expect(parseRowDiffPlan('plan')).toBeNull()
    expect(parseRowDiffPlan({ ...compiledPlan(), planKind: 'assay-row-diff-plan-v2' })).toBeNull()
    expect(parseRowDiffPlan({ ...compiledPlan(), planVersion: 2 })).toBeNull()
  })

  it('rejects malformed relation names (empty, NUL, non-string)', () => {
    expect(parseRowDiffPlan({ ...compiledPlan(), relationA: '' })).toBeNull()
    expect(parseRowDiffPlan({ ...compiledPlan(), relationB: 'x\u0000y' })).toBeNull()
    expect(parseRowDiffPlan({ ...compiledPlan(), relationA: 9 })).toBeNull()
  })

  it('rejects an empty key set, duplicate keys, and case-insensitive duplicates', () => {
    expect(parseRowDiffPlan({ ...compiledPlan(), keys: [] })).toBeNull()
    expect(parseRowDiffPlan({ ...compiledPlan(), keys: ['id', 'id'] })).toBeNull()
    expect(parseRowDiffPlan({ ...compiledPlan(), keys: ['id', 'ID'] })).toBeNull()
    expect(parseRowDiffPlan({ ...compiledPlan(), keys: [''] })).toBeNull()
  })

  it('accepts an empty shared-column list (the keys-only plan) and rejects non-strings', () => {
    expect(parseRowDiffPlan({ ...compiledPlan(), sharedColumns: [] })).not.toBeNull()
    expect(parseRowDiffPlan({ ...compiledPlan(), sharedColumns: [7] })).toBeNull()
  })

  it('rejects sampleLimit below 1 or non-integer (the empty-result convention)', () => {
    expect(parseRowDiffPlan({ ...compiledPlan(), sampleLimit: 0 })).toBeNull()
    expect(parseRowDiffPlan({ ...compiledPlan(), sampleLimit: 1.5 })).toBeNull()
    expect(parseRowDiffPlan({ ...compiledPlan({ sampleLimit: 1 }) })).not.toBeNull()
    // An over-max K parses (the executor clamps it, never refuses).
    expect(
      parseRowDiffPlan({ ...compiledPlan(), sampleLimit: ROW_DIFF_SAMPLE_HARD_MAX + 1 }),
    ).not.toBeNull()
  })
})

describe('assertRowDiffPlanBinding (m6-2 belt 1)', () => {
  const REGISTERED = ['assay_t1', 'assay_diff_d1']

  it('accepts real compiler output', () => {
    expect(() => assertRowDiffPlanBinding(compiledPlan(), REGISTERED)).not.toThrow()
  })

  it('refuses the same relation for both sides', () => {
    const plan = { ...compiledPlan(), relationB: 'ds_a' }
    expect(() => assertRowDiffPlanBinding(plan, REGISTERED)).toThrow(/same relation name/)
  })

  it('refuses a relation that would shadow a registered view', () => {
    const plan = { ...compiledPlan(), relationA: 'assay_t1' }
    expect(() => assertRowDiffPlanBinding(plan, REGISTERED)).toThrow(/shadow/)
    const comparison = { ...compiledPlan(), relationB: 'assay_diff_d1' }
    expect(() => assertRowDiffPlanBinding(comparison, REGISTERED)).toThrow(/shadow/)
  })

  it('refuses a comment-bearing query (a commented pseudo-reference cannot bind)', () => {
    const plan = compiledPlan()
    const hostile = {
      ...plan,
      addedSql: plan.addedSql.replace('SELECT', 'SELECT /* FROM "ds_a" AS "a" */'),
    }
    expect(() => assertRowDiffPlanBinding(hostile, REGISTERED)).toThrow(/comment/)
  })

  it('refuses a pseudo-reference hidden inside a string literal (string-masked cannot count)', () => {
    const plan = compiledPlan()
    const quotedA = quotedRelationToken('ds_a')
    const quotedB = quotedRelationToken('scratch_ds_b')
    const masked =
      `SELECT 'FROM ${quotedA} AS "a"' AS "assay_side", ` +
      `0 AS "assay_row_ordinal", 0 AS "assay_count", 'FROM ${quotedB} AS "b"' AS "x"`
    expect(() => assertRowDiffPlanBinding({ ...plan, addedSql: masked }, REGISTERED)).toThrow(
      /does not bind side A|does not bind side B/,
    )
  })

  it('refuses a CREATE/CTAS payload (not a single compiler-shaped SELECT)', () => {
    const plan = compiledPlan()
    const hostile = { ...plan, removedSql: 'CREATE TABLE canary AS SELECT 1' }
    expect(() => assertRowDiffPlanBinding(hostile, REGISTERED)).toThrow(/single compiler-shaped/)
  })

  it('refuses a multi-statement aspect query', () => {
    const plan = compiledPlan()
    const hostile = { ...plan, addedSql: `${plan.addedSql}; DROP TABLE canary` }
    expect(() => assertRowDiffPlanBinding(hostile, REGISTERED)).toThrow(/single compiler-shaped/)
  })

  it('refuses an aspect query that drops a relation binding', () => {
    const plan = compiledPlan()
    const hostile = { ...plan, removedSql: plan.removedSql.split('"a"').join('"z"') }
    expect(() => assertRowDiffPlanBinding(hostile, REGISTERED)).toThrow(/does not bind side A/)
  })

  it('refuses a totals query that is not the compiler-shaped three-arm UNION ALL', () => {
    const plan = compiledPlan()
    const singleArm = plan.totalsSql.split('\nUNION ALL\n')[0] as string
    expect(() => assertRowDiffPlanBinding({ ...plan, totalsSql: singleArm }, REGISTERED)).toThrow(
      /three-arm/,
    )
  })

  it('refuses an aspect query whose reserved result columns were gutted', () => {
    const plan = compiledPlan()
    const gutted = plan.addedSql.split('"assay_count"').join('"not_the_count"')
    expect(() => assertRowDiffPlanBinding({ ...plan, addedSql: gutted }, REGISTERED)).toThrow(
      /reserved result columns/,
    )
  })

  it('applies the reserved-column spot check symmetrically (removed/changed fail belt 1)', () => {
    const plan = compiledPlan()
    // The reader needs `assay_row_ordinal` in EVERY aspect, not just `added`.
    const removedGutted = plan.removedSql.split('"assay_row_ordinal"').join('"not_the_ord"')
    expect(() =>
      assertRowDiffPlanBinding({ ...plan, removedSql: removedGutted }, REGISTERED),
    ).toThrow(/removed query is missing its reserved result columns/)
    const changedGutted = plan.changedSql.split('"assay_changed"').join('"not_the_changed"')
    expect(() =>
      assertRowDiffPlanBinding({ ...plan, changedSql: changedGutted }, REGISTERED),
    ).toThrow(/changed query is missing its reserved result columns/)
    const changedOrdGutted = plan.changedSql.split('"assay_row_ordinal"').join('"not_the_ord"')
    expect(() =>
      assertRowDiffPlanBinding({ ...plan, changedSql: changedOrdGutted }, REGISTERED),
    ).toThrow(/changed query is missing its reserved result columns/)
  })

  it('refuses an escape-string and a dollar-quoted aspect query', () => {
    const plan = compiledPlan()
    expect(() =>
      assertRowDiffPlanBinding(
        { ...plan, addedSql: 'SELECT E\'\\n\' AS "assay_side"' },
        REGISTERED,
      ),
    ).toThrow()
    expect(() =>
      assertRowDiffPlanBinding({ ...plan, addedSql: 'SELECT $$x$$ AS "assay_side"' }, REGISTERED),
    ).toThrow()
  })

  // ---- q-12 / AR-E7: the reserved-column check is identifier-aware --------

  it('rejects a reserved column spoofed only by a string literal (q-12 gate, not mid-op)', () => {
    const plan = compiledPlan()
    // Gut the genuine `"assay_side"` output alias and offer the name only
    // inside a string literal. The old raw `.includes('"assay_side"')`
    // check saw the literal text and passed the plan, deferring the
    // missing-column failure to a mid-op DuckDB shape error. Identifier-
    // aware detection ignores literal interiors, so the gate rejects it now.
    const spoofed = plan.addedSql
      .split(`'B' AS "assay_side"`)
      .join(`'B' AS "not_the_side"`)
      .replace('SELECT', `SELECT 'x ''"assay_side"'' y' AS "noise",`)
    expect(spoofed.includes('"assay_side"')).toBe(true)
    expect(() => assertRowDiffPlanBinding({ ...plan, addedSql: spoofed }, REGISTERED)).toThrow(
      /added query is missing its reserved result columns/,
    )
  })

  it('accepts a genuine output identifier alongside a literal that quotes it (no false reject)', () => {
    const plan = compiledPlan()
    // The genuine `'B' AS "assay_side"` alias is still present; an extra
    // string literal that quotes the name must not change the verdict. A
    // raw `.includes` check also accepts here — this pins that tightening
    // the check does not start false-rejecting legitimate compiler output.
    const withLiteral = plan.addedSql.replace('SELECT', `SELECT 'x ''"assay_side"'' y' AS "noise",`)
    expect(() =>
      assertRowDiffPlanBinding({ ...plan, addedSql: withLiteral }, REGISTERED),
    ).not.toThrow()
  })

  it('rejects a reserved name used only below the top-level projection (q-12 identifier position)', () => {
    const plan = compiledPlan()
    // A genuine `"assay_side"` identifier, but in a filter below the
    // top-level FROM — not a projected output column. It would satisfy a
    // naive identifier-presence check and a raw `.includes` check while
    // leaving the reader without its column (mid-op failure). The gate's
    // projection-position awareness rejects it here.
    const hidden = plan.addedSql
      .split(`'B' AS "assay_side"`)
      .join(`'B' AS "not_the_side"`)
      .replace('LIMIT', `WHERE "assay_side" IS NULL\nLIMIT`)
    expect(hidden.includes('"assay_side"')).toBe(true)
    expect(() => assertRowDiffPlanBinding({ ...plan, addedSql: hidden }, REGISTERED)).toThrow(
      /added query is missing its reserved result columns/,
    )
  })

  // ---- AR-E2: the gate is identifier-aware --------------------------------

  it('accepts a compiler plan whose alias text contains UNION ALL (AR-E2)', () => {
    // The old totals split ran on the raw code view, so an identifier whose
    // text contains `UNION ALL` over-split the three arms and false-rejected
    // a legal compiler plan. Identifier interiors are blanked in the split's
    // structural view now.
    const plan = compiledPlan()
    const totals = plan.totalsSql.replace('SELECT', 'SELECT 1 AS "x UNION ALL y",')
    expect(() => assertRowDiffPlanBinding({ ...plan, totalsSql: totals }, REGISTERED)).not.toThrow()
    // The split really is still shape-strict: a genuine fourth arm rejects.
    const fourArms = `${plan.totalsSql}\nUNION ALL\n${plan.totalsSql.split('\nUNION ALL\n')[0] as string}`
    expect(() => assertRowDiffPlanBinding({ ...plan, totalsSql: fourArms }, REGISTERED)).toThrow(
      /three-arm/,
    )
  })

  it('accepts an aspect query with a column named exactly the relation (AR-E2)', () => {
    const plan = compiledPlan()
    const withRelationColumn = plan.addedSql.replace('SELECT', 'SELECT "ds_a",')
    expect(() =>
      assertRowDiffPlanBinding({ ...plan, addedSql: withRelationColumn }, REGISTERED),
    ).not.toThrow()
    // And still rejects the same shape when the FROM binding is gone.
    const noFrom = withRelationColumn.split('FROM "ds_a" AS "a"').join('FROM "zzz" AS "a"')
    expect(() => assertRowDiffPlanBinding({ ...plan, addedSql: noFrom }, REGISTERED)).toThrow(
      /does not bind side A/,
    )
  })
})
