// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Pure query-state transitions for the m2-3 sort/filter UI — extracted from
 * the components so the state logic is unit-testable in Node (the repo's
 * testing convention: thin components over tested pure modules). The UI
 * drives `GridViewportModel.setSort`/`setFilters` with the lists these
 * functions produce.
 */
import type { FilterSpec, SortSpec } from '@assay/grid'

/**
 * The sort spec after one click on `column`'s header toggle: unsorted (or
 * sorted on another column) → ascending, ascending → descending,
 * descending → cleared (`null`, the model's clear input).
 */
export function nextSortSpec(current: SortSpec | null, column: string): SortSpec | null {
  if (current === null || current.column !== column) return { column, direction: 'asc' }
  if (current.direction === 'asc') return { column, direction: 'desc' }
  return null
}

/**
 * The full filter list after editing `column`'s predicate draft: every other
 * column's filter is preserved in order; `column`'s filter is replaced — or
 * dropped when the draft trims to empty (an empty input means "no filter for
 * this column"). The result is a fresh list, safe to hand to
 * `GridViewportModel.setFilters` (which replaces the whole state).
 */
export function replaceColumnFilter(
  previous: readonly FilterSpec[],
  column: string,
  predicate: string,
): FilterSpec[] {
  const trimmed = predicate.trim()
  const next = previous.filter((filter) => filter.column !== column)
  if (trimmed !== '') next.push({ column, predicate: trimmed })
  return next
}
