// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * WF-O1 (E04 filter-draft clarity): the pure rules behind the FilterBar's
 * "Not applied" marker and its no-op Apply, kept out of the JSX so the
 * equality contract is unit-pinned in Node (
 * [design](../../../../docs/process/handoff/20261120-e04-bounded-ux-design.md)
 * §3.1–§3.3).
 *
 * The distinction these rules draw is **presentation identity only**: a
 * displayed draft string vs the accepted predicate string for one column. No
 * SQL semantics are claimed or computed — `> 5` and `>= 6` stay distinct,
 * predicates are never normalized or case-folded, and a draft is never
 * compared to dataset or edit state (plan E04: no "unsaved dataset" claim).
 */
import type { FilterSpec } from '@assay/grid'
import { replaceColumnFilter } from './query-state'

/**
 * WF-O1 §3.3 visible copy of the marker. It is the revert affordance, so the
 * accessible name states the action and starts with the visible text
 * (WCAG 2.5.3 Label in Name) while staying value-free — no predicate is ever
 * echoed into a name or description (ADR 0025).
 */
export const FILTER_DRAFT_MARKER_TEXT = 'Not applied'

/** The marker's accessible name (`aria-label`): visible text first. */
export const FILTER_DRAFT_MARKER_LABEL = `${FILTER_DRAFT_MARKER_TEXT} — restore the applied filter in this input`

/**
 * The input's own description while its draft is dirty. A separate, value-free
 * sentence on a `visually-hidden` span referenced by `aria-describedby` — not
 * a live region, so nothing is announced per keystroke (WF-O1 §3.5).
 */
export const FILTER_DRAFT_DESCRIPTION = 'This input differs from the applied filter.'

/** The predicate the accepted list holds for `column` (`''` = unfiltered). */
export function acceptedPredicateFor(filters: readonly FilterSpec[], column: string): string {
  return filters.find((filter) => filter.column === column)?.predicate ?? ''
}

/**
 * Whether a control's displayed draft differs from its accepted predicate.
 *
 * **Exact string equality, deliberately** (WF-O1 §3.1): no trimming, no case
 * folding, no SQL normalization, no semantic equivalence. A draft that differs
 * only by surrounding whitespace is dirty, because the input really does show
 * something other than the accepted predicate; conversely `> 5` and `>= 6` are
 * different strings and both are shown as such. What these text rules say is
 * nothing about which rows match.
 */
export function draftDirty(displayed: string, accepted: string): boolean {
  return displayed !== accepted
}

/** Exact `(column, predicate)` pair identity — string equality on both fields. */
function samePair(left: FilterSpec, right: FilterSpec): boolean {
  return left.column === right.column && left.predicate === right.predicate
}

/**
 * Whether two filter lists hold the same filters in exact string identity,
 * treating a pure **reordering** as the same content.
 *
 * Order is part of the accepted list's own identity (`filterListSignature` in
 * `FilterBar.tsx` — the model pushes the list to the provider in order), but
 * here it is not the question: `replaceColumnFilter` appends the edited
 * column's filter, so re-applying an unchanged predicate would reorder the
 * list and run a full apply for a change of nothing. The pair content is what
 * an apply would alter, so an identical-content list is a no-op. Pair
 * multiplicity counts: a legacy list carrying the same column twice is NOT
 * the same content after the editor collapses it to one.
 */
export function sameFilterContent(
  left: readonly FilterSpec[],
  right: readonly FilterSpec[],
): boolean {
  if (left.length !== right.length) return false
  const remaining = [...right]
  for (const filter of left) {
    const index = remaining.findIndex((candidate) => samePair(filter, candidate))
    if (index === -1) return false
    remaining.splice(index, 1)
  }
  return true
}

/**
 * WF-O1 §3.1/§3.2 "No-op": submitting `submitted` for `column` would change
 * nothing, so Apply must not dispatch, must not open a busy epoch and must not
 * produce an error — the marker clears and that is the whole feedback.
 *
 * Two conjuncts, in the contract's order:
 *
 * 1. the submitted predicate **trimmed** (the storage form —
 *    `replaceColumnFilter` trims, `query-state.ts`) equals the accepted
 *    predicate for that column; and
 * 2. the list the editor would produce holds exactly the accepted filters
 *    (see {@link sameFilterContent}) — the guard that keeps a real change (a
 *    removal, a collapse of a duplicate-column list) dispatchable.
 *
 * The trimming edge is the specified behavior (§3.1): a draft differing only
 * by surrounding whitespace shows dirty but applies as a no-op.
 */
export function applyIsNoOp(
  filters: readonly FilterSpec[],
  column: string,
  submitted: string,
): boolean {
  if (submitted.trim() !== acceptedPredicateFor(filters, column)) return false
  return sameFilterContent(filters, replaceColumnFilter(filters, column, submitted))
}
