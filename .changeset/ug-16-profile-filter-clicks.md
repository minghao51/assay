---
'@assay/web': minor
---

feat(web): profile stats click-to-act (ug-16). Profile statistics become
controls: a categorical top-k row click applies the grid builder's
`= 'value'` predicate and the null-count stat applies `IS NULL`, both through
`replaceColumnFilter` + `GridViewportModel.setFilters` — the existing FilterBar
renders the chips and the existing grid empty state stays the honest outcome
for a zero-row result. Because the profile is base-derived (R-16) while filters
run on the overlay-effective view, every click is planned first by a new pure
module (`profile/filter-action.ts`) over the active ops at the history cursor
and the effective schema (`resolveProfileColumn`, appended to `edit/session.ts`):
a name present in the effective schema resolves as itself; otherwise the active
`column-rename` chain is followed in order; a chain end in the schema is a
**typed refusal** naming both the file's original name and the current name, and
anything else is a **generic refusal** — no filter, no filter-state change, no
engine call, and never a silent remap. A cast/type mismatch compiles against the
effective column type and surfaces the builder's own readable rejection in the
same single-line, value-free `role="status"` slot (`profile-filter-refusal`);
an engine rejection after a successful compile keeps the existing framed
`filter` error copy and rolls the previous filter list back. The refusal clears
on the next click, another profile run, undo/redo, or a new dataset, and never
replaces the R-16 hint/note or the idle `profile-table-id`. Top-k rows and the
null count are real `<button>` controls with accessible names naming the column
and the action; the chart's `role="img"` text alternative is preserved. No
engine/protocol/domain change, no new telemetry, nothing logged.
