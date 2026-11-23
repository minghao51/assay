---
'@assay/engine-duckdb': minor
'@assay/web': patch
'@assay/testing': minor
---

feat(b3/r-8): add the typed `engine/profile-comparison` op so diff staging profiles the comparison slot directly instead of opening the comparison file a second time.

Every comparison staging attempt used to run `stageComparison`, then `engineClient.open(source)` and `engineClient.profile(handleB)` to obtain the B-side profile aggregates (the engine profiles registered tables, and the comparison view is not one). Nothing released that handle: each attempt that reached a successful `open` left one orphaned `assay_tN` view plus one file registration for the whole worker lifetime, including re-stages, retries after a failed stage, and superseded in-flight stages whose handle the seq guard drops (`engine/dispose` is the only release).

The new op addresses the staged comparison through the comparison registry (`assay_diff_dN`, the single-slot scratch the row diff already binds as side B) and answers with the **existing `engine/profile-result` payload unchanged**, so `toDiffProfile`, the diff model and the panel report consume it without edits. It is one request type on the query lane (ADR 0040: profile-class scans, same as `engine/profile`), with no `transient` flag on `engine/open`, no `engine/close-table`, no closed-tombstone set, no cap and no memory claim. Refusals are pre-execution and value-free (ADR 0025): the request must carry an engine-generated comparison id (`dN`) — a table id, an `assay_tN`/`assay_diff_dN` view name, an extra field, or a malformed id is refused at the parse boundary, and an absent/unknown slot is refused before any DuckDB call.

`apps/web/src/sessions/useDiffSession.ts` now calls `profileComparison(comparison.id)` after `stageComparison`; the transient `open` and its `profile` call are deleted from `handleComparisonFile`. The seq guard, every failure path, `engine/profile-result`'s shape, the diff result wire (`EngineRowDiffResult`), `buildDiffPanelReport`, the CSV preview payload/retention (ADR 0049), the DCR artefact (ADR 0046) and the repair composition shape (ADR 0051) are untouched.

ADR 0047 check: this change does not widen `closeTable` and releases no replacement-path, live-session or pipeline-`registerView` table, so it does not trip the ADR's supersession trigger; `engine/dispose` remains the only terminal release.

`@assay/testing` gains one conformance scenario (`profile-comparison`) and one client-surface method (`profileComparison`), which assert that the staged comparison's statistics equal the same dataset's `profile()` output and that staging several comparisons leaves the table registry at its pre-staging baseline (via the existing `registeredTableCount` probe).
