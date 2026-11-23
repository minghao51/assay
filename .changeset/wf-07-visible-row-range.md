---
'@assay/web': patch
---

feat(web): show the grid footer's visible row range (WF-07, WFD-07 option A).

The grid footer now carries one static label beside its existing counters and
busy status: `Visible rows X–Y of N` when the view has rows, `No rows` when it
has none, and `Row range unavailable` while the row count is unknown or the
rows cannot be measured. X/Y are 1-based positions in the current view (after
filters, sorts, inserts and deletes), derived from the rendered row elements'
intersection with the scroll viewport below the sticky header — not from the
virtualizer's window, whose overscan tail is never named. A partly visible
first/last row counts, bounds clamp to the known total, and a fully fitting
view reads `1–N`.

The label is plain text: no live region, no per-scroll announcement and no new
focus target. It adds no engine work — no fetch, count or query — and changes
no paging, selection, bulk-operation or row-identity behaviour. The SQL result
pane's separate `rows {a}–{b}` label is untouched.
