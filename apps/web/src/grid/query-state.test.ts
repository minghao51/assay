// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import type { FilterSpec, SortSpec } from '@assay/grid'
import { nextSortSpec, replaceColumnFilter } from './query-state'

describe('nextSortSpec — the header toggle cycle (asc → desc → cleared)', () => {
  it('starts ascending from no sort', () => {
    expect(nextSortSpec(null, 'income')).toEqual({ column: 'income', direction: 'asc' })
  })

  it('starts ascending when another column is currently sorted (sort is dataset-wide)', () => {
    const current: SortSpec = { column: 'country', direction: 'desc' }
    expect(nextSortSpec(current, 'income')).toEqual({ column: 'income', direction: 'asc' })
  })

  it('cycles asc → desc on the same column', () => {
    const current: SortSpec = { column: 'income', direction: 'asc' }
    expect(nextSortSpec(current, 'income')).toEqual({ column: 'income', direction: 'desc' })
  })

  it('clears after descending (null is the model/provider clear protocol)', () => {
    const current: SortSpec = { column: 'income', direction: 'desc' }
    expect(nextSortSpec(current, 'income')).toBeNull()
  })
})

describe('replaceColumnFilter — per-column editing of the whole filter list', () => {
  const existing: FilterSpec[] = [
    { column: 'country', predicate: "= 'US'" },
    { column: 'income', predicate: '> 50000' },
  ]

  it('replaces this column’s filter and preserves the others in order', () => {
    expect(replaceColumnFilter(existing, 'income', '>= 61000')).toEqual([
      { column: 'country', predicate: "= 'US'" },
      { column: 'income', predicate: '>= 61000' },
    ])
  })

  it('adds a filter for a previously unfiltered column at the end', () => {
    expect(replaceColumnFilter([], 'income', '> 0')).toEqual([
      { column: 'income', predicate: '> 0' },
    ])
  })

  it('drops this column’s filter when the draft trims to empty (and only this one)', () => {
    expect(replaceColumnFilter(existing, 'income', '   ')).toEqual([
      { column: 'country', predicate: "= 'US'" },
    ])
    expect(replaceColumnFilter([], 'country', '')).toEqual([])
  })

  it('trims surrounding whitespace from the predicate', () => {
    expect(replaceColumnFilter([], 'country', "  = 'DE'  ")).toEqual([
      { column: 'country', predicate: "= 'DE'" },
    ])
  })
})
