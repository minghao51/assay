---
'@assay/web': patch
---

fix(uxc-5): pin the ux-1 grid residues and measure the pinned header before
paint. The header-height effect in `DataGrid` now runs in `useLayoutEffect`, so
the first committed frame already carries the real `scrollMargin` /
`scrollPaddingStart`: the virtualizer's range/scroll model is correct from the
start and the grid paints once instead of twice. This is a timing fix, not a
paint-geometry fix — the row transform subtracts the same `headerHeight` that
`item.start` folds in via `scrollMargin`, so those terms cancel and rows paint
in the same place either way. The e2e regression spec gains two durable pins:
an occlusion check that `document.elementFromPoint` at a row's cell
center resolves to the cell and never to the sticky header (the containment
assertions passed while a row sat behind it), and a row-chrome check that the
body row's deterministic `minWidth` floor covers the trailing row-actions track
in the narrow/pan regime. No behavior change beyond the effect timing.
