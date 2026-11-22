// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import type { FilterSpec } from '@assay/grid'
import {
  FILTER_DRAFT_DESCRIPTION,
  FILTER_DRAFT_MARKER_LABEL,
  FILTER_DRAFT_MARKER_TEXT,
  acceptedPredicateFor,
  applyIsNoOp,
  draftDirty,
  sameFilterContent,
} from './filter-draft'

/**
 * WF-O1 (E04 filter-draft clarity) pure-rule pins — design
 * [§3.1–§3.3](../../../../docs/process/handoff/20261120-e04-bounded-ux-design.md).
 *
 * The point of this file is that the equality rules are NOT SQL semantics:
 * every test below that could tempt an implementation into trimming, case
 * folding or "equivalent predicate" reasoning asserts the exact-string answer
 * instead.
 */
const INCOME: FilterSpec = { column: 'income', predicate: '> 50000' }
const COUNTRY: FilterSpec = { column: 'country', predicate: "= 'US'" }

describe('draftDirty (WF-O1 §3.1 exact equality)', () => {
  it('is clean only for the exact same string', () => {
    expect(draftDirty('> 50000', '> 50000')).toBe(false)
    expect(draftDirty('', '')).toBe(false)
    expect(draftDirty('IS NULL', 'IS NULL')).toBe(false)
  })

  it('does not trim: a whitespace-only difference is dirty', () => {
    expect(draftDirty('> 50000 ', '> 50000')).toBe(true)
    expect(draftDirty(' > 50000', '> 50000')).toBe(true)
    expect(draftDirty('   ', '')).toBe(true)
  })

  it('does not case-fold', () => {
    expect(draftDirty("= 'us'", "= 'US'")).toBe(true)
    expect(draftDirty('is not null', 'IS NOT NULL')).toBe(true)
  })

  it('does not normalize SQL: equivalent-looking predicates stay distinct', () => {
    expect(draftDirty('> 5', '>= 6')).toBe(true)
    expect(draftDirty('= 1', '= 01')).toBe(true)
    expect(draftDirty('>= 50000', '> 50000')).toBe(true)
  })

  it('treats a draft against no filter as dirty unless both are empty', () => {
    expect(draftDirty('', '')).toBe(false)
    expect(draftDirty('> 1', '')).toBe(true)
  })
})

describe('acceptedPredicateFor (WF-O1 accepted state)', () => {
  it('reads the accepted predicate for a column and empty for an unfiltered one', () => {
    const filters = [INCOME, COUNTRY]
    expect(acceptedPredicateFor(filters, 'income')).toBe('> 50000')
    expect(acceptedPredicateFor(filters, 'country')).toBe("= 'US'")
    expect(acceptedPredicateFor(filters, 'signup_date')).toBe('')
    expect(acceptedPredicateFor([], 'income')).toBe('')
  })

  it('returns the first entry for a legacy duplicate-column list', () => {
    // Not a shape the bar produces; pinned so the helper has one rule rather
    // than an accidental last-wins one.
    expect(acceptedPredicateFor([INCOME, { column: 'income', predicate: '< 10' }], 'income')).toBe(
      '> 50000',
    )
  })
})

describe('sameFilterContent (WF-O1 list identity for the no-op check)', () => {
  it('is true for the same ordered pairs and for a pure reordering', () => {
    expect(sameFilterContent([INCOME, COUNTRY], [INCOME, COUNTRY])).toBe(true)
    expect(sameFilterContent([INCOME, COUNTRY], [COUNTRY, INCOME])).toBe(true)
    expect(sameFilterContent([], [])).toBe(true)
  })

  it('is false for a different predicate, a different column, or a different length', () => {
    expect(sameFilterContent([INCOME], [{ column: 'income', predicate: '> 50001' }])).toBe(false)
    expect(sameFilterContent([INCOME], [{ column: 'country', predicate: '> 50000' }])).toBe(false)
    expect(sameFilterContent([INCOME, COUNTRY], [INCOME])).toBe(false)
    expect(sameFilterContent([], [INCOME])).toBe(false)
  })

  it('counts multiplicity: a duplicate column collapsed to one is a real change', () => {
    expect(sameFilterContent([INCOME, INCOME], [INCOME])).toBe(false)
    expect(sameFilterContent([INCOME, INCOME], [INCOME, INCOME])).toBe(true)
  })
})

describe('applyIsNoOp (WF-O1 §3.1/§3.2 No-op)', () => {
  it('is a no-op for an unchanged re-apply, single filter', () => {
    expect(applyIsNoOp([INCOME], 'income', '> 50000')).toBe(true)
  })

  it('is a no-op for an unchanged re-apply that would only REORDER the list', () => {
    // `replaceColumnFilter` appends the edited column, so re-applying income in
    // [income, country] would produce [country, income] — the round trip
    // WF-O1 removes (the accepted list is left untouched because nothing is
    // dispatched).
    expect(applyIsNoOp([INCOME, COUNTRY], 'income', '> 50000')).toBe(true)
    expect(applyIsNoOp([INCOME, COUNTRY], 'country', "= 'US'")).toBe(true)
  })

  it('is a no-op for the trimming edge: surrounding whitespace only', () => {
    // Shows dirty (draftDirty), applies as a no-op (the storage form trims).
    expect(draftDirty(' > 50000 ', '> 50000')).toBe(true)
    expect(applyIsNoOp([INCOME], 'income', ' > 50000 ')).toBe(true)
  })

  it('is a no-op for an empty draft on a column with no accepted filter', () => {
    expect(applyIsNoOp([INCOME], 'country', '')).toBe(true)
    expect(applyIsNoOp([INCOME], 'country', '   ')).toBe(true)
    expect(applyIsNoOp([], 'income', '')).toBe(true)
  })

  it('is NOT a no-op when the predicate really changes', () => {
    expect(applyIsNoOp([INCOME], 'income', '> 60000')).toBe(false)
    // …and SQL-equivalent-looking edits are real edits: no normalization.
    expect(applyIsNoOp([INCOME], 'income', '>= 50001')).toBe(false)
    expect(applyIsNoOp([{ column: 'country', predicate: "= 'US'" }], 'country', "= 'us'")).toBe(
      false,
    )
  })

  it('is NOT a no-op for an explicitly emptied input on a filtered column (a removal)', () => {
    expect(applyIsNoOp([INCOME], 'income', '')).toBe(false)
    expect(applyIsNoOp([INCOME, COUNTRY], 'income', '  ')).toBe(false)
  })

  it('is NOT a no-op when applying would change the rest of the list', () => {
    // A legacy duplicate-column list collapses to one entry: a real change.
    expect(applyIsNoOp([INCOME, INCOME], 'income', '> 50000')).toBe(false)
  })
})

describe('WF-O1 marker copy (ADR 0025 — value-free)', () => {
  it('pins the exact visible text, accessible name and description', () => {
    expect(FILTER_DRAFT_MARKER_TEXT).toBe('Not applied')
    expect(FILTER_DRAFT_MARKER_LABEL).toBe('Not applied — restore the applied filter in this input')
    // Label in Name (WCAG 2.5.3): the accessible name starts with the visible
    // text.
    expect(FILTER_DRAFT_MARKER_LABEL.startsWith(FILTER_DRAFT_MARKER_TEXT)).toBe(true)
    expect(FILTER_DRAFT_DESCRIPTION).toBe('This input differs from the applied filter.')
    // Never reads as dataset dirtiness, and never carries a predicate.
    expect(FILTER_DRAFT_MARKER_TEXT).not.toMatch(/unsaved|dataset/i)
    expect(FILTER_DRAFT_MARKER_LABEL).not.toMatch(/unsaved|dataset/i)
    expect(FILTER_DRAFT_DESCRIPTION).not.toMatch(/unsaved|dataset/i)
  })
})
