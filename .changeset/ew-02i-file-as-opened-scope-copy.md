---
'@assay/web': patch
---

feat(web): name the file-as-opened scope on SQL, validation and pipeline (EW-02I)

The three EW-02D sentences accepted verbatim on 2026-11-14 land as append-only
copy, one sentence each, with no state, prop, engine-call or telemetry change:

- **SQL** — the `sql-hint` paragraph ends with "Queries read the file as opened
  — staged grid edits and grid filters are not part of this view." (the
  supplied relation is the base registered view; the pager fact
  `50 rows per page` is unchanged).
- **Validation** — the `validation-intro` paragraph ends with "Validation runs
  on the whole edited dataset — grid filters and sorting are not applied."
  (validation receives the overlay at the history cursor, never the accepted
  grid predicates).
- **Pipeline** — inside the existing `openDatasetAvailable` fragment, right
  after the "Use the open dataset" primary, a
  `pipeline-open-dataset-scope` span reads "Use the open dataset binds the
  opened file itself — staged grid edits and grid filters are not part of
  pipeline runs." The picker path carries no new copy (post-bind provenance is
  indistinguishable without new state — EW-02D round-1 re-scope).

Render-only text through React's default escaping (no `innerHTML`, no
`dangerouslySetInnerHTML`, no dataset values in logs). Every RETAIN string is
byte-for-byte unchanged; unit pins assert each literal.
