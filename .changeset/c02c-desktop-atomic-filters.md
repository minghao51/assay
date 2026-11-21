---
'@assay/vscode': patch
---

fix(c02c): adopt the atomic whole-list filter capability in the desktop webview.

`EngineGridProvider` now implements the optional `GridDataProvider.replaceFilters`
capability (C01 §5.1): the whole ordered predicate list is replaced in one
all-before-commit assignment, so a rejection leaves the previously accepted list
in effect. Every spec is shape-checked into a local array first and only a fully
valid list is stored; the list keeps exactly the given order (no parsing,
normalizing, sorting or de-duplication) and `replaceFilters([])` maps to the same
internal empty state as `filter(null)`, so the engine request bytes are unchanged.
The rejection is the adapter's own `TypeError` and carries no phase. Nothing on
the host bridge changes: the capability is webview-local state, adds no message
kind, no engine op and no extra scan.

The filter-lite toolbar stops printing the raw engine diagnostic. It maps the
model's value-free `FilterApplyError.phase` through a desktop-local copy module
(`src/pure/filter-failure.ts`, deliberately duplicated rather than shared with
`apps/web` — apps never import apps): `refused-before-change` keeps the framed
single-line "previous filters are still in effect" sentence,
`accepted-reload-failed` reports applied-but-not-reloaded with a Retry action
(`model.refresh()`) and never claims a rollback or renders `model.reloadError`,
and `restore-failed` states the honest unknown filter list with the documented
Clear-filters control. All restoration stays owned by `GridViewportModel`; the
bar issues no compensating filter write. The phase copy is scoped to filter
transactions: a failed header **sort** is a plain provider/reload rejection with
no phase and no filter involvement, so it keeps its own (pre-C02) framing — the
provider's message, as `apps/web`'s `cycleSort` renders — and never claims that
any filter list was left unchanged. The bridge protocol, previous-report /
stale behaviour, create-only export, validation/diff flows and host bridge
bounds are untouched. This is a **patch**: `@assay/vscode` is private, no public
API or wire vocabulary changes, and the fix is additive inside the webview.

Tests: the provider capability (order preservation, `[]` equivalence with
`filter(null)`, all-before-commit, no extra scans, overlay route), the phase →
copy mapping with a VIOLENT sentinel, and the real toolbar + real model journey
for all three phases including the sentinel never reaching the error region. A
sort rejection is pinned separately: it renders the provider's message, carries
no filter sentence or filter recovery control, and leaves the published sort in
place.
