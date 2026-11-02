---
'@assay/web': patch
---

chore(web): sticky-nav reading order (ug-22).

The sticky nav now reads **schema, filters, grid, validation, compare, sql,
editing, history, export, record, profile, pipeline** — the "why do my rows look
like this?" loop (filter → validate → compare → query) instead of the tool pane's
file-creation order, so Filters is one link away instead of eighth (UG-36,
[2026-10-26 usability gap review](../../docs/reviews/2026-10-26-usability-gap-review.md)).

This is a **pure `WORKBENCH_SECTIONS` array edit**: the same twelve ids, the same
titles, the same objects — only their order in the array changes. The nav link
order, the reveal/expand/scroll behaviour and the `aria-describedby` purpose
wiring all follow the array, so no navigation mechanism was touched.

**ADR 0044 / D14 + the q-15 placement ruling authorize the nav reading order
only — no DOM reorder.** The section element order in the JSX, the two-pane
layout, the heading map and the record dock are unchanged; `profile` still
precedes `pipeline` and `pipeline` stays last, in both the pane and the nav. No
copy change, no `index.css`/`display: contents`/`order` change, no new
dependency, no engine/protocol change, no telemetry (ADR 0025/0037).

Pins: the unit nav-order + two-pane DOM-order lists in `App.shell.test.tsx` (an
explicit `pipeline`-last assertion, a `filters`-before-`grid`-in-the-nav
assertion, and a dedicated nav↔DOM decoupling test that reads **both rendered
lists** and asserts `indexOf('grid')`/`indexOf('filters')` differ between them —
the nav reads filters 1, grid 2, while the two-pane DOM keeps filters in the tool
pane at 6 and grid in the center column at 10) and the matching nav-order list in
`tests/e2e/shell.spec.ts`. An earlier draft of this entry claimed a
`grid`-before-`filters`-in-the-DOM half; that was wrong — `grid` renders in the
center column, not the tool pane — and the decoupling pin now observes the real
rendered difference. `App.headings.test.tsx` still asserts the unchanged two-pane
DOM heading map and needed no edit.
