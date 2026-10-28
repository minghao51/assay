---
'@assay/web': patch
---

feat(ug-13): give every tool section a visible purpose subtitle and make the
Record dock explain its closed state. Each collapsed section header now shows
the R-14 one-line purpose verbatim (Schema "Fields and types" through Pipeline
"Chained contract checks"): the managed toggles keep their `Expand/Collapse
<Title>` accessible name and expose the subtitle through `aria-describedby`
(the inner-disclosure sections and the nav anchors use the same stable purpose
id). The Record section, while no row is requested, renders "Select a row to
inspect it here — press Enter or double-click a row."; the hint disappears as
soon as a record opens, and the name "Record" stays unchanged across the nav
link, section heading and inspector label. No DOM reorder, no new state or
telemetry, value-free copy (ADR 0025), and no change to the 28px grid rows or
existing control/focus geometry.
