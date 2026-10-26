---
'@assay/web': patch
---

fix(ug-1): reveal and focus the SQL outcome of nested one-click actions. A successful grid-header or schema-tree Flatten/Explode now opens the SQL section through the existing shell seam, expands a rail-collapsed tool pane, scrolls the section into view, and focuses the outcome tied to that request sequence — the named keyboard-scrollable result region, the empty-result status, or the execution error. Composition rejections keep their existing alert and open nothing; manual runs, paging and typing never steal focus; the main grid is unchanged and no count query is added.
