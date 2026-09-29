---
'@assay/web': patch
---

fix(uxc-5): pin the ux-1 grid residues and measure the pinned header before
paint. The header-height effect in `DataGrid` now runs in `useLayoutEffect`, so
the first committed frame already carries the real `scrollMargin` /
`scrollPaddingStart` (with `useEffect` the initial paint ran with both at 0, a
one-frame row-0-under-header window). The e2e regression spec gains two durable
pins: an occlusion check that `document.elementFromPoint` at a row's cell
center resolves to the cell and never to the sticky header (the containment
assertions passed while a row sat behind it), and a row-chrome check that the
body row's deterministic `minWidth` floor covers the trailing row-actions track
in the narrow/pan regime. No behavior change beyond the effect timing.
