---
'@assay/web': patch
---

fix(ux-1): make wide grids horizontally reachable. The grid header now lives inside the grid viewport, so the header row and the virtualized body share one horizontal scroll context (header pinned with `position: sticky`, an opaque background, and a z-index above the rows); the viewport scrolls both axes while remaining the TanStack virtualizer's scroll element, with the measured header height feeding `scrollMargin`/`scrollPaddingStart` so range math and jump/focus offsets stay correct. Header and body rows share a deterministic track floor (`calc(N * 9rem [+ 5rem])`), so columns keep equal widths and stay aligned whether the container stretches or pans. Adds the committed synthetic `fixtures/csv/wide.csv` (20 columns × 3 rows) and a Playwright regression proving the last column is reachable by wheel pan, keyboard focus-reveal, and inline edit at 1280px and that the grid scrolls without clipping at 900px.
