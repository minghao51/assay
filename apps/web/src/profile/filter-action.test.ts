// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import type { EditOp } from '@assay/domain'
import { UNRESOLVED_COLUMN_REFUSAL, planProfileFilter, renamedColumnRefusal } from './filter-action'

/**
 * ug-16 click-to-act planning pins (design §4.1–§4.3). The copy is pinned as
 * literals, never imported from the module, so the bytes are the assertion:
 * straight ASCII quotes and the em dash U+2014 exactly as the design record
 * carries them. Column names are schema vocabulary — no cell value, filename or
 * engine text appears in any refusal.
 */

const RENAMED =
  'This column is now "nation" in the edited view. The profile still uses the file\'s original name, "country" — use "nation" in Filters instead.'
const UNRESOLVED =
  'This column is not in the edited view. The profile describes the file as opened — undo the change or re-open the file to filter by it.'

type Schema = readonly { readonly name: string; readonly type: string }[]

const rename = (from: string, to: string): EditOp => ({ kind: 'column-rename', from, to })

const SCHEMA: Schema = [
  { name: 'id', type: 'BIGINT' },
  { name: 'country', type: 'VARCHAR' },
  { name: 'income', type: 'BIGINT' },
  { name: 'signup_date', type: 'DATE' },
]

describe('planProfileFilter — resolved clicks compile with the existing builder', () => {
  it('compiles a top-k value to the exact `= <literal>` predicate', () => {
    expect(planProfileFilter('country', { kind: 'value', value: 'SG' }, [], SCHEMA)).toEqual({
      kind: 'apply',
      column: 'country',
      predicate: "= 'SG'",
    })
  })

  it('compiles the null count to `IS NULL`', () => {
    expect(planProfileFilter('income', { kind: 'null' }, [], SCHEMA)).toEqual({
      kind: 'apply',
      column: 'income',
      predicate: 'IS NULL',
    })
  })

  it('quotes hostile values through the builder literal rules (no markup, doubled quotes)', () => {
    expect(planProfileFilter('country', { kind: 'value', value: "O'Brien" }, [], SCHEMA)).toEqual({
      kind: 'apply',
      column: 'country',
      predicate: "= 'O''Brien'",
    })
  })

  it('compiles against the EFFECTIVE type, not the profile/base type', () => {
    // A categorical (VARCHAR) base column cast to BIGINT: the same top-k value
    // is a numeric literal against the edited view.
    const castSchema: Schema = [
      { name: 'id', type: 'BIGINT' },
      { name: 'amount', type: 'BIGINT' },
    ]
    expect(planProfileFilter('amount', { kind: 'value', value: '5' }, [], castSchema)).toEqual({
      kind: 'apply',
      column: 'amount',
      predicate: '= 5',
    })
    // A DATE-typed effective column keeps the builder's temporal literal.
    expect(
      planProfileFilter('signup_date', { kind: 'value', value: '2025-01-04' }, [], SCHEMA),
    ).toEqual({ kind: 'apply', column: 'signup_date', predicate: "= DATE '2025-01-04'" })
  })
})

describe('planProfileFilter — renamed / unresolved refuse without a filter', () => {
  it('refuses a renamed column with the byte-exact copy naming base + current', () => {
    const plan = planProfileFilter(
      'country',
      { kind: 'value', value: 'SG' },
      [rename('country', 'nation')],
      [
        { name: 'id', type: 'BIGINT' },
        { name: 'nation', type: 'VARCHAR' },
      ],
    )
    expect(plan).toEqual({ kind: 'refuse', message: RENAMED })
    expect(plan.kind === 'refuse' && plan.message).toBe(renamedColumnRefusal('country', 'nation'))
  })

  it('names the CURRENT name after a chained rename (a→b→c)', () => {
    expect(
      planProfileFilter(
        'country',
        { kind: 'value', value: 'SG' },
        [rename('country', 'nation'), rename('nation', 'homeland')],
        [{ name: 'homeland', type: 'VARCHAR' }],
      ),
    ).toEqual({
      kind: 'refuse',
      message:
        'This column is now "homeland" in the edited view. The profile still uses the file\'s original name, "country" — use "homeland" in Filters instead.',
    })
  })

  it('refuses an unresolvable column with the byte-exact generic copy', () => {
    expect(
      planProfileFilter('country', { kind: 'null' }, [], [{ name: 'id', type: 'BIGINT' }]),
    ).toEqual({ kind: 'refuse', message: UNRESOLVED })
    expect(UNRESOLVED_COLUMN_REFUSAL).toBe(UNRESOLVED)
  })

  it('resolves a rename-back-to-original as itself (no refusal)', () => {
    expect(
      planProfileFilter(
        'country',
        { kind: 'value', value: 'SG' },
        [rename('country', 'nation'), rename('nation', 'country')],
        [{ name: 'country', type: 'VARCHAR' }],
      ),
    ).toEqual({ kind: 'apply', column: 'country', predicate: "= 'SG'" })
  })
})

describe('planProfileFilter — cast/type mismatch is the builder’s readable rejection', () => {
  it('refuses a non-numeric top-k value against a numeric effective type (no coercion)', () => {
    expect(
      planProfileFilter(
        'amount',
        { kind: 'value', value: 'SG' },
        [],
        [{ name: 'amount', type: 'BIGINT' }],
      ),
    ).toEqual({ kind: 'refuse', message: 'That is not a number.' })
  })

  it('refuses a non-temporal top-k value against a temporal effective type', () => {
    expect(
      planProfileFilter(
        'signup_date',
        { kind: 'value', value: 'SG' },
        [],
        [{ name: 'signup_date', type: 'DATE' }],
      ),
    ).toEqual({ kind: 'refuse', message: 'Enter a date as YYYY-MM-DD.' })
  })

  it('still applies the null operator on a type the builder cannot compare by value', () => {
    // `other` kinds expose only the null operators; the null click stays valid.
    expect(
      planProfileFilter(
        'payload',
        { kind: 'null' },
        [],
        [{ name: 'payload', type: 'STRUCT(a INT)' }],
      ),
    ).toEqual({ kind: 'apply', column: 'payload', predicate: 'IS NULL' })
    // ...while a value click has no operator to compile and is refused.
    expect(
      planProfileFilter(
        'payload',
        { kind: 'value', value: 'x' },
        [],
        [{ name: 'payload', type: 'STRUCT(a INT)' }],
      ),
    ).toEqual({ kind: 'refuse', message: 'Choose an operator for this column.' })
  })
})
