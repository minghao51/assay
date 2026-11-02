---
'@assay/web': patch
---

chore(web): code-observation riders CO-1…CO-4 (ug-23).

The four non-UX riders found during the usability investigation
([2026-10-26 gap review](../../docs/reviews/2026-10-26-usability-gap-review.md)
§6). No behaviour change beyond the four items, no dependency, no engine or
grid-protocol change, no telemetry (ADR 0025/0037), no DOM reorder (ADR 0044 /
D14).

**(a) CO-1 — stale pipeline-jump comment.** The `usePipelineSession` call-site
comment in `App.tsx` still described p-5's retired SQL-detour ("jump its outputs
into the SQL pane's result surface"). p2-6 made previews grid-native: a
materialized node's relation opens through the p2-1 `registerPipelineRelation`
handle op and drives the same handle-based grid model a dataset open uses. The
block now says that, and also records the two additions that landed after it was
written — the panel-local `data-bind-revision` contract-bind ordinal and the
ug-9/R-15 gate cross-link (`inspectPipelineContractInValidation`). The
still-true session-scoped reset sentence is kept. **Comment-only**: no code line
in that region changed.

**(b) CO-2 — injective FilterBar chip key.** The chip keys joined
`` `${column}:${predicate}` ``, which is not injective: column `a:b` with
predicate `c` and column `a` with predicate `b:c` both produced `a:b:c`, so React
reconciled two distinct active filters as the same child. A new pure
`filterChipKey(filter)` — the ordered `[column, predicate]` pair as JSON, the
same pair grammar `filterListSignature` already uses for the whole list — is
used at **all three** key sites (the removable collapsed-header chips, the
editable active rows and the display-only expanded-body list). Chip rendering,
labels, removal semantics and the `FilterSpec` grammar are untouched.

**(c) CO-3 — de-duplicated pane-toggle name.** The ≥1024px rail toggle reused
the in-pane `<nav>`'s `"Workbench sections"`, so one accessible name covered a
`button` and a `navigation`. The toggle now names its action through a pure
`paneToggleLabel(collapsed)` — `Collapse workbench pane` /
`Expand workbench pane`, mirroring the `aria-expanded` value — while the nav
keeps `"Workbench sections"` verbatim. `aria-expanded` and `aria-controls` are
unchanged; only the two name attributes moved.

**(d) CO-4 — "row expunge" gloss.** `edit/op-summary.ts` mapped `row-uninsert` to
the overlay's internal term `row expunge`. It is now the plain-language
`undo row insert` (`2 undo row inserts` after the existing `+s`
pluralization) — the gloss of "undid a row I added", matching the toolbar's own
`Insert row` affordance and distinguishing it from `row delete` (a row of the
opened dataset). No other summary string changed. Honest scope note: no web
session path emits `row-uninsert` today (the op exists in `@assay/domain`), so
this is copy correctness plus a regression pin rather than a changed screen.

Pins: `FilterBar.test.tsx` — the retired join maps the colliding pair to one key
while `filterChipKey` does not, both surfaces render two distinct chips with no
React duplicate-key warning, and each chip removes independently;
`App.shell.test.tsx` — the toggle's own name resolves uniquely by role, the nav's
name resolves uniquely by role, the two names differ, neither leaks onto the
other role, and the label tracks `aria-expanded` across both states;
`tests/e2e/shell.spec.ts` — the same name/role split in real Chromium via
`toHaveAccessibleName`; `edit/op-summary.test.ts` + `edit/op-summary.render.test.tsx`
— the decided phrase, its plural and the rendered
`data-testid="pending-changes"` line, with the domain term excluded everywhere.
Mutations killed: reverting the chip key to the colon join (both key sites fail
on React's duplicate-key warning), restoring the shared `"Workbench sections"`
string on the toggle (the distinct-name pin cannot find
`Collapse workbench pane`), and reverting the gloss (the copy pins fail).
