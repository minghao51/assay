---
'@assay/web': patch
'@assay/diff': patch
---

fix(au3-12): QoL residue — below-fold bundle split, focus restore, injective
candidate keys, and a case-insensitive column guard.

`@assay/web`: the below-fold panels (Validation, Diff, SQL, Profile) are now
dynamically imported, so the initial bundle carries only the open flow, schema
tree, editing toolbar, and grid; each panel keeps its own intra-panel loading
states. The record inspector's `close()` now restores focus to the element that
opened it (the ExportDialog pattern) instead of stranding focus on `<body>`.
Undo/redo read the live history through `historyRef` like the cast path (a
consistency fix; no behavior change in the normal event flow). The key-candidate
list key is now `column:index` so candidates that share an evidence column can
no longer collide and drop a row.

`@assay/diff`: schema validation now refuses case-variant duplicate column names
(`Name` + `name`), which collide for every case-insensitive engine purpose, with
the existing `duplicate-column-name` issue idiom and a value-free message. Exact
duplicates keep their prior behavior; distinct case-similar names stay accepted.
