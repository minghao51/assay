---
'@assay/web': patch
---

feat(web): add a `Not applied` marker for drafted filter edits (WF-O1)

The filter bar's active-row and `SQL predicates` inputs can now be told apart
from the applied filters, and re-applying an unchanged filter no longer runs a
whole apply round trip.

Each control whose displayed draft differs **exactly** from the accepted
predicate for its column — no trimming, no case folding, no SQL normalization —
renders one quiet, text-styled `Not applied` marker beside it. The marker is a
native `<button type="button">` carrying the per-row Apply control class; its
accessible name is `Not applied — restore the applied filter in this input`
(starts with the visible text; never carries a predicate — ADR 0025), and the
input gains an `aria-describedby` pointing at a value-free `visually-hidden`
span: `This input differs from the applied filter.` No live region, no
`aria-live`, no banner or error treatment, and no "unsaved dataset" wording: the
marker describes only that input vs the applied filter.

Activating the marker is the revert: it restores the accepted predicate string
into that column's draft — a draft-only change with no dispatch, no busy state
and no engine call — and focus returns to the input it belongs to, because the
marker unmounts as soon as the draft matches accepted. It is not rendered while
the draft is clean (no phantom tab stop) and is `disabled` while an apply is
pending like every other bar control. The compose value input is deliberately
not marked: it is a new filter, not a draft of an accepted one.

Apply with a submitted predicate that trims to the accepted predicate **and**
produces the same filter content is now a no-op: no dispatch, no busy epoch, no
error, marker cleared. That removes the round trip (and the list reorder) an
unchanged re-apply used to cost, without touching `query-state.ts`, the filter
builder or the model's transaction/restoration contract. The trimming edge is
specified behavior: a draft differing only by surrounding whitespace shows dirty
but applies as a no-op.

Preserved unchanged: the untouched, invalid-compose, cleared, programmatic
replace, busy, single-failure and double-failure/unknown-state states with their
existing byte-exact copy (including the C02 phase copy and the `Clear filters`
recovery), and Enter-to-submit on every filter input. Pins: a new pure
`filter-draft.ts` with its own Node test (exactness, reorder-only no-op,
trimming edge, removal/duplicate guards, copy), plus `FilterBar.test.tsx`
marker visibility per state, no-dispatch revert, focus return, keyboard
activation, disabled-while-pending and the no-op paths.
