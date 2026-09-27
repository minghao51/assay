---
'@assay/web': patch
---

fix(au3-5): injective DOM ids and unambiguous record-tree paths (S4). Replaced the lossy `[^A-Za-z0-9_-] → -` sanitizing in `SchemaPanel.pathId` and `RecordInspector.nodePathId` (which made `a.b` and `a-b` collide into duplicate ids / mispointed `aria-controls`) with the shared AR-W11 hex encoding in the new `lib/dom-id.ts`; `FilterBar.filterInputId` now delegates to the same grammar. Record inspector expansion keys are built from encoded segments (`encodePath`/`encodePathSegment`, mirrored by `collectBranchPaths`) so a struct key containing `/` can no longer be confused with nesting (`x/y` vs child `y` of `x`). New collision pins mirror `FilterBar.test.tsx` at both call sites. Schema panel expansion keys use the same encoded-segment grammar, so a top-level column literally named `x/y` no longer shares expansion state with child `y` of column `x`.
