# Essential dataset-workbench comparison

**Research date:** 2026-11-12. **Assay baseline:** `aba9880`, clean at research start.
**Status:** research and proposed direction, **not runtime authorization**.

## 1. Executive conclusion

Assay should borrow **spreadsheet ease of manipulation**, **OpenRefine's inspect–repair loop**, and
**Power Query's explicit transformation steps**, while retaining its own strengths: local-first structured
files, immutable-source editing, deterministic contracts, keyed comparison, and CLI continuity.

The target is not Excel or Google Sheets feature coverage. It is a reliable journey:

> Open without corrupting interpretation → understand the data and scope → locate a problem → preview a
> deliberate repair → undo if necessary → revalidate → compare → export the intended artifact.

Prioritize safety, scope transparency, import fidelity, and a small reversible bulk-repair workflow.
Reusability and effective-view profiling follow; broader clipboard, delivery, and recovery work need
separate contracts. Formulas, workbook layout, collaboration, AI correction, and connector breadth are not
necessary to prove this proposition.

The companion [enhancement proposal](../product/15-essential-workbench-enhancements.md) turns these lessons
into bounded candidates, decision dependencies, and acceptance journeys. It does not reopen earlier
approvals or authorize implementation.

## 2. Method, comparators, and limits

Three read-only research agents covered Assay's runtime/tests, Microsoft/Google documentation, and
OpenRefine/DBeaver documentation. The orchestrator examined existing decisions, CSV inference, accessibility
guidance, and spot-checked retrieved source evidence. Official pages were actually fetched over HTTPS using
Python/urllib and parsed from their article bodies; this is web research, **not hands-on competitor testing**.

The evidence set is **24 official pages** (§7), retrieved 2026-11-12. It is deliberately selected around core
jobs, not an exhaustive product inventory. No competitor benchmark, release certification, pricing,
compliance, market-share, or measured usability claim is made. Missing documentation is not evidence that a
competitor lacks a feature. An Assay specification heading is not evidence of a shipped web control.

| Comparator              | Why it matters                                                                   | Boundary                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Google Sheets           | Familiar filtering, find/replace, cleanup, entry assistance, keyboard operations | Browser/cloud workbook model; Drive save/version behavior is not Assay persistence        |
| Excel for the web       | Familiar rectangular copy/paste and entry validation                             | Browser-specific behavior; do not infer desktop Excel parity                              |
| Excel / Power Query     | Applied transformations, stage inspection, profile coverage                      | Power Query Editor is not ordinary worksheet editing; Desktop/Online distinctions apply   |
| OpenRefine              | Facets, reviewed cleanup, operation reuse                                        | Installed local web server, not computation wholly inside the browser                     |
| DBeaver                 | Query/result/edit/export boundaries                                              | Installed database client; the database may be remote; not CloudBeaver                    |
| DuckDB and W3C guidance | Import interpretation and accessible grid interaction                            | Technical references, not additional competitor products or evidence of Assay conformance |

No new runtime suite, browser session, participant session, or assistive-technology study ran. Existing
acceptance evidence remains dated evidence, not freshly reproduced results. **RD-T07 remains a limitation.**

## 3. Essential workflow comparison

The table compares documented patterns, not a binary feature score. Source IDs resolve in §7. Current Assay
status is expanded with source/test anchors in §4.

| Essential job                     | Spreadsheet / preparation pattern                                                      | Relevant adjacent pattern                                                                   | Assay implication                                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Interpret imported data           | Tables expose column-type expectations; warnings are not strict storage typing [S02]   | DuckDB infers dialect/header/types from samples and permits overrides [T01]                 | Retain simple opening; add a separate CSV interpretation-review design, not silent coercion                       |
| Locate a suspicious subset        | Named filter views, shown/total rows, literal/regex find [S01, S03]                    | Exact facets combine predicates and counts [W01]; DBeaver separates fetched and total [W05] | Build on existing filters and finding jumps; make scope and denominator consistent                                |
| Repair a repeated defect          | Replace all, trim, split, deduplicate; fill and rectangular paste [S03, S05, S07, S08] | OpenRefine exact edits and supervised clustering [W02]                                      | Add a small previewable, transactional repair set; defer approximate matching and broad paste                     |
| Prevent a bad manual entry        | Dropdown rejection/warning, type hints [S02, S04, S09]                                 | Editor availability can depend on keys, metadata and permissions [W05]                      | Preserve typed editors; distinguish entry checks from a complete contract run                                     |
| Assess data quality               | Power Query quality/distribution/profile, first 1,000 rows by default [S11]            | Facet display limits are not row-sampling claims [W01]                                      | Preserve base-profile honesty; never label top values or failure samples exhaustive                               |
| Review and reverse changes        | Power Query Applied Steps; worksheet undo is a different mechanism [S07, S10]          | OpenRefine history and supported operation extraction [W03]                                 | Session history exists; portable recipes need compatibility rules, not a renamed History panel                    |
| Verify a repaired dataset         | Entry validation alone is not an exhaustive data check [S04, S09]                      | Preview is only initial rows [W04]                                                          | Reuse Assay's explicit contract rerun, stale-result handling and keyed diff; these are core strengths             |
| Work with SQL-derived results     | Power Query stage results have explicit step identity [S10]                            | DBeaver separates script, result, table and fetched extent [W05, W06]                       | Do not treat a SQL result/page as the editable source or complete result export                                   |
| Deliver the intended output       | View/filter state and workbook save are different concepts [S01, S12]                  | Export may query again, use fetched rows, or select rows/columns [W09]                      | Whole-effective export stays the default; new subset/query delivery must be explicit                              |
| Survive a mistake or interruption | Drive versions, AutoSave and AutoRecover have different preconditions [S06, S12]       | OpenRefine persists project history [W03]                                                   | Immutable input, undo, replacement safety, recovery checkpoint and delivered export are five different guarantees |
| Operate without a mouse           | Shortcut help, fill, undo, navigation [S07]                                            | WAI distinguishes navigation from editing and notes virtualized-DOM caveats [T02]           | Preserve existing keyboard work; require the new repair loop to work beyond mounted rows                          |

## 4. Assay baseline: existing functionality versus gaps

This section is source-qualified, not a claim that the entire product was retested. The
[shipping/decision record](../process/handoff/20261110-web-followup-approval.md#32-approved-subset-manifest-dispatch-index)
and [current handoff](../process/handoff.md) take precedence over older proposed headings.

- **Already shipped:** file inspection, virtualized grid, nested Record inspection, filters/sort, SQL and
  profiles, typed scalar/row/column edits, undo/redo/history, contract validation and finding navigation,
  schema/profile/keyed diff, pipeline/DCR workflows, and new-file export. These are not greenfield proposals.
- **Important semantic boundaries:** profile is **File as opened**; the main grid and validation use the
  effective overlay view; SQL has a distinct result identity; grid filters/sort do not silently redefine
  whole-effective-dataset export. Partial samples and paged results retain their own limits.
- **Known open safety work:** WF-05's replacement contract is verified; **WF-06 runtime is not implemented or
  authorized**. Accepted ADR 0047 allows unbounded registered-table retention until engine teardown; a dialog
  does not solve that resource limit.
- **Known temporal limits:** scalar grid/display-copy work shipped in WF-01; nested/Record/untyped SQL parity
  remains WF-O2. `TIMESTAMP 'infinity'` can fail before formatting in the Arrow projection boundary. A display
  fix cannot recover precision or source offsets lost before the UI.
- **Product opportunity, not a missing engine claim:** SQL can express many repairs, but SQL expressibility
  does not make a safe, discoverable bulk-repair workflow or portable edit recipe.

### Source-inspected capability inventory

**I = implemented; P = partial journey; D = deferred/unselected; U = not established.**
Paths/line numbers refer to `aba9880`. Existing test bodies were inspected, **not rerun**. Negative UI
findings are bounded by reachable App wiring, component handlers and operation types—not a claim that
DuckDB cannot express the operation. File names in backticks below are repository-relative.

| Workflow                  | Status and actual web reachability                                                                                                                                                                                               | Source / existing test anchor                                                                                                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open/import               | **I/P:** four engine input formats, example, idle drop, progress/cancel/recovery. No import dialect/type review UI found; replacement preservation is **D**                                                                      | `apps/web/src/App.tsx:1596–1791`; `packages/engine-duckdb/src/format-view.ts:21–76`; `tests/e2e/drop-open.spec.ts:38`, `open-recovery.spec.ts:43`                                                           |
| Grid/Record               | **I/P:** windowed rows, horizontal access, row positions, arrows/Home/End, full Record tree. No rectangular selection, resize/freeze/reorder controls established                                                                | `apps/web/src/grid/DataGrid.tsx:278–310,989–1123`; `tests/e2e/grid-virtualization.spec.ts:117`, `a11y-keyboard.spec.ts:208`, `record-keyboard.spec.ts:48`                                                   |
| Clipboard                 | **P:** focused display-value copy and native editor copy. No range-copy/typed multi-cell paste workflow found                                                                                                                    | `apps/web/src/grid/DataGrid.tsx:614–641,1041–1063`; `tests/e2e/cell-copy.spec.ts:55`                                                                                                                        |
| Filter/sort/find          | **I/P:** typed predicates, contains/NULL, SQL predicate, editable chips and single-column sort. No global find/replace or multi-sort editor found                                                                                | `apps/web/src/grid/FilterBar.tsx:196–239,396–520`; `grid/query-state.ts:17–39` under the same source root; `tests/e2e/filter-builder.spec.ts:87,181`, `grid-filter-sort.spec.ts:190`                        |
| Profile                   | **I/P:** numeric statistics/quantiles, categorical bars and NULL/top-value click-to-filter. **Original file only**, not edited/filtered; quantile strip is not a frequency histogram                                             | `apps/web/src/profile/ProfilePanel.tsx:143–227,461–488`; `tests/e2e/profile-panel.spec.ts:88`, `profile-honesty.spec.ts:36`                                                                                 |
| SQL/derived data          | **I/P:** query execution, 50-row paging, generated nested flatten/explode/extract SQL. Supplied table name reads the original view; no managed editable-result adoption or SQL-result export control found                       | `apps/web/src/sql/SqlPanel.tsx:70–83,161,253–273`; `apps/web/src/sql/paged-query.ts:38,73–94`; `tests/e2e/sql-editor.spec.ts:70,107`, `nested-journey.spec.ts:98`                                           |
| Scalar/row/column changes | **I/P:** typed scalar/NULL edit, append/delete row, rename/cast and conversion precheck. Nested edits and add/drop/derived-column UI not established                                                                             | `apps/web/src/sessions/useEditingSession.ts:291–390`; `tests/e2e/grid-editing.spec.ts:91,350,388`, `column-ops.spec.ts:61,118,237`                                                                          |
| Undo/history              | **I:** undo/redo/shortcuts, cursor jumps and redo-tail warning. Not arbitrary middle-step deletion, durable recovery or a portable recipe                                                                                        | `apps/web/src/edit/HistoryPanel.tsx:6–19,67–140`; `tests/e2e/history-shortcuts.spec.ts:57`, `column-ops.spec.ts:387`                                                                                        |
| Bulk repair               | **P:** whole-column cast/rename and authored SQL/pipeline transforms exist. No previewed mass-cleaning UI or history-to-recipe bridge found                                                                                      | `apps/web/src/edit/EditToolbar.tsx:31–54`; `tests/e2e/validation-panel.spec.ts:120` proves individual web repairs; `validation-journey.spec.ts:28` targets an engine harness, **not** a web Fix all button  |
| Validation                | **I/P:** starter/YAML contracts, counts, samples, jumps, eligible failure filters, stale/rerun and reports. Incomplete samples disable failure filtering; no general rule-authoring UI established                               | `apps/web/src/validation/ValidationPanel.tsx:477–550`; `tests/e2e/validation-panel.spec.ts:77,120`, `validation-report-export.spec.ts:103–145`                                                              |
| Keyed comparison          | **I/P:** confirmed/explicit keys, schema/profile evidence, effective-A row diff, bounded samples, stale/rerun and reports. B is report-only; no merge or all-change browser established                                          | `apps/web/src/sessions/useDiffSession.ts:117–154,177–231`; `tests/e2e/diff-panel.spec.ts:128,411`, `m6-exit-journey.spec.ts:562`                                                                            |
| Pipelines                 | **I/P:** authored YAML, bindings, joins/aggregates/window transforms, gates, lineage, read-only previews and canonical DCR output. No visual authoring/record-actions bridge; “Use the open dataset” binds the **original File** | `apps/web/src/pipeline/usePipelineSession.ts:485–521,541–873`; `packages/pipeline/src/compile/compile.ts:661–679`; `tests/e2e/pipeline-panel-journey.spec.ts:64,186,251`, `pipeline-dcr-export.spec.ts:110` |
| Export                    | **I/P:** five output formats, new-file source guard, CSV formula neutralization. **Entire effective dataset, natural order**, ignoring grid filter/sort. No selection/query export workflow found                                | `apps/web/src/export/ExportDialog.tsx:261–300`; `tests/e2e/export-rewrite.spec.ts:203,386,418,459,487`                                                                                                      |
| Continuity                | **P/D/U:** task/panel retry preserves session work; durable reload/crash recovery not established. Current Open resets before picker resolution; WF-06 remains unimplemented                                                     | `apps/web/src/App.tsx:1611–1653`; `apps/web/src/ErrorBoundary.tsx:20–26`; `tests/e2e/workbench-visibility.spec.ts:222`, `tests/visual/panel-recovery.spec.ts:73`                                            |
| Accessibility             | **I/P/U:** keyboard/focus journeys and dual-theme automated checks exist. Human/AT evidence and full conformance are not established                                                                                             | `apps/web/src/grid/DataGrid.tsx:1005–1123`; `tests/e2e/a11y-keyboard.spec.ts:286`, `a11y.spec.ts:152–447`; RD-T07                                                                                           |

### Scope traps that matter more than adding buttons

- **Validation** addresses the effective dataset, not the grid's current filter. A test explicitly records
  **110 failures / 100 returned samples** and disables “Show only failing rows” for that incomplete set
  (`tests/e2e/validation-report-export.spec.ts:103–145`). Essential large-subset repair needs a complete
  engine-backed predicate/relation, not an enlarged sample masquerading as the failing population.
- **Diff is mixed-scope:** initial schema/profile/key proposals use original A and B; confirmed-key row diff
  uses effective A and B (`useDiffSession.ts:117–154,177–231`). Do not label the whole panel overlay-aware.
- **SQL and pipeline source reuse are base-oriented today:** the supplied `assay_tN` query relation is the
  original registered view; “Use the open dataset” obtains the retained File. Neither automatically consumes
  grid edits. Changing either needs a new binding contract, not a promise that all panels refresh together.
- **Format/cold-offline honesty:** JSONL content is newline-delimited JSON, but `.ndjson` is not recognized by
  the inspected engine extension switch (`packages/engine-duckdb/src/format-view.ts:21–44`), despite NDJSON
  wording in Help. Reconcile that alias/copy in a separately approved, fixture-backed row; do not claim new
  format support here. Web reader downloads remain disclosed in `apps/web/src/help/WorkbenchHelp.tsx:42–49`;
  e2e extension interception is not shipped cold-offline support.

**Do not recommend as missing:** contains filters, profile charts/click-to-filter, nested SQL generators,
Record navigation, starter contracts, history shortcuts, pipeline gates/previews/DCR generation, focused
cell copy, scalar temporal display, or honest terminal-node labels. The gaps are scope, safe bulk work,
repeatability and continuity—not first introduction of those shipped capabilities.

## 5. Lessons worth adopting—and traps to avoid

### 5.1 A filter is a view, not implicit permission to mutate everything

Sheets distinguishes ordinary filters and filter views [S01]. OpenRefine facets narrow matching rows, but
some structural operations explicitly ignore facets [W01]. DBeaver distinguishes query-result extent and
export extraction choices [W05, W09]. Borrow the explicit boundary, not one product's hidden exception.

For Assay, name the file, effective dataset, accepted filtered view, SQL result, comparison side, and pipeline
candidate as different identities. A preview must bind to the actual execution scope and revision, not DOM
rows or whatever filter happens to be active at Apply time.

### 5.2 Cleanup needs a semantic contract, not just a button

Sheets documents case-insensitive duplicate comparison and trim behavior that excludes non-breaking spaces
[S05]. Those are product choices, not universal definitions. OpenRefine transformations can retain an
unconvertible value; apparent completion therefore need not mean every value converted [W02, W04].

Start with explicit whitespace classes and exact replacement/mapping. Keep NULL, empty string, literal
`"NULL"`, identifiers and typed values distinct. Defer deduplication until equality, null treatment and the
retained-row rule are specified. A preview sample is illustrative; it cannot prove the affected count or
that no conversion failures exist.

### 5.3 Similarity is a suggestion, not a repair verdict

OpenRefine requires approval of suggested cluster edits [W02]. If Assay eventually adds clustering, preserve
that human decision boundary and serialize approved mappings, not a promise to rediscover the same clusters.
Exact mapping should precede fuzzy matching; neither requires an AI dependency.

### 5.4 Inspectable steps are valuable; every edit need not be portable

Power Query exposes the result at a selected Applied Step [S10]. OpenRefine can extract supported operations,
but not individual cell edits [W03]. Borrow reproducibility for a deliberately supported subset. Raw row
positions or session logical keys do not establish identity on another file. Unsupported steps must be
visible and rejected for replay, never silently omitted.

### 5.5 Coverage and freshness are separate dimensions

Power Query's documented default profile is the first 1,000 rows, switchable to the whole dataset [S11].
OpenRefine's 2,000-choice text-facet limit is a category-display limit, not proof of sampled rows [W01]. These
are different limits. Assay should disclose only coverage it actually knows, separately from whether a
result describes the current overlay revision. Its existing base-profile label is honest; changing that
semantic contract needs the already-separated engine candidate, not a caption edit.

### 5.6 Familiar save vocabulary can be dangerous

Sheets describes automatic Drive saving [S07]. Microsoft 365 desktop AutoSave depends on supported
OneDrive/SharePoint locations; local paths and AutoRecover are different [S12]. OpenRefine project history
has another persistence model [W03]. None justifies an Assay “saved” badge after initiating a download.
Replacement safety should preserve the current session; durable recovery requires its own opt-in storage,
identity and failure contract.

## 6. Recommended focus and explicit non-goals

**First:** complete the already-designed replacement safety if authorized, standardize scope presentation,
research CSV interpretation controls, and design one deterministic bulk-repair vertical slice.

**Next:** connect repair to effective-view quality evidence and a small portable recipe subset using existing
contract/SQL/pipeline capabilities. Keep full-result/subset delivery and recovery as separately approved
follow-ons, not prerequisites for every small repair improvement.

**Do not pursue parity now:** spreadsheet formula dependency engines, macros, workbook formatting, merged
cells, pivot/chart suites, live collaboration/comments, AI auto-correction, generic database administration,
new connectors, hosted governance, a new DAG editor, or replacing the accepted shell. Existing roadmap and
investment gates remain binding. Range paste, deduplication and fuzzy clustering are useful candidates, not
mandatory first-slice requirements.

There is no meaningful “85% Excel coverage” target. Judge success through the acceptance journeys in the
[proposal](../product/15-essential-workbench-enhancements.md), then separately collect authorized human and
assistive-technology evidence.

## 7. Official web source ledger

All pages below were retrieved on **2026-11-12** with substantive article text and HTTP 200. IDs identify
supported claims, not entire-product endorsements. Titles below are article headings; URLs use the final
response address where available.

| ID  | Official article                                                                                                                   | Claim supported / caveat                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| S01 | [Sort & filter your data — Google Sheets](https://support.google.com/docs/answer/3540681?hl=en)                                    | Filters/filter views, shown/total; viewer-only temporary views differ from saved views                     |
| S02 | [Use tables in Google Sheets](https://support.google.com/docs/answer/14239833?hl=en)                                               | Column types and type warnings; not strict dataset-schema enforcement                                      |
| S03 | [Search and use find and replace — Google](https://support.google.com/docs/answer/62754?hl=en)                                     | Sheets-specific matching/replace controls; distinguish Docs behavior                                       |
| S04 | [Create an in-cell dropdown list — Google Sheets](https://support.google.com/docs/answer/186103?hl=en)                             | Entry rejection versus warning; not exhaustive imported-data checking                                      |
| S05 | [Split text, remove duplicates, or trim whitespace — Google Sheets](https://support.google.com/docs/answer/6325535?hl=en)          | Cleanup controls and case/whitespace caveats                                                               |
| S06 | [Find what's changed in a file — Google](https://support.google.com/docs/answer/190843?hl=en)                                      | Versions and restoration limits; not a complete cell-level audit                                           |
| S07 | [Keyboard shortcuts for Google Sheets](https://support.google.com/docs/answer/181110?hl=en)                                        | Fill/copy/undo/help and Drive-save model; not empirical AT evidence                                        |
| S08 | [Copy and paste in Office for the web — Microsoft](https://support.microsoft.com/en-us/word/copy-and-paste-in-office-for-the-web)  | Explicit Excel-web section: rectangular tabular paste, browser differences; URL also covers other apps     |
| S09 | [Apply data validation to cells — Microsoft](https://support.microsoft.com/en-us/excel/get-started/apply-data-validation-to-cells) | Platform-tabbed entry validation; do not generalize desktop behavior to web                                |
| S10 | [Using the Applied Steps list — Power Query](https://learn.microsoft.com/en-us/power-query/applied-steps)                          | Step inspection/reconfiguration; Desktop/Online features differ                                            |
| S11 | [Using the data profiling tools — Power Query](https://learn.microsoft.com/en-us/power-query/data-profiling-tools)                 | First 1,000 rows by default; whole-data option; distinct versus unique                                     |
| S12 | [What is AutoSave? — Microsoft](https://support.microsoft.com/en-us/office/collab-files/what-is-autosave)                          | Microsoft 365 desktop and supported cloud paths; AutoRecover differs                                       |
| W01 | [Exploring facets — OpenRefine](https://openrefine.org/docs/manual/facets)                                                         | Exact facets, counts, display cap, operations that ignore facets                                           |
| W02 | [Cell editing — OpenRefine](https://openrefine.org/docs/manual/cellediting)                                                        | Exact transforms, conversions and explicitly approved cluster edits                                        |
| W03 | [Running OpenRefine](https://openrefine.org/docs/manual/running)                                                                   | Local-server model, project history and supported operation extraction                                     |
| W04 | [Expressions — OpenRefine](https://openrefine.org/docs/manual/expressions)                                                         | One-time transformations, first-few-rows preview, explicit error outcomes                                  |
| W05 | [Data Editor — DBeaver](https://dbeaver.com/docs/dbeaver/Data-Editor/)                                                             | Table/query results, fetch extent, count and editability distinctions                                      |
| W06 | [SQL Editor — DBeaver](https://dbeaver.com/docs/dbeaver/SQL-Editor/)                                                               | Script/results and connection identities; no browser-local guarantee                                       |
| W07 | [Data filters — DBeaver](https://dbeaver.com/docs/dbeaver/Data-Filters/)                                                           | SQL/value predicates and reusable filter history                                                           |
| W08 | [Data viewing and editing — DBeaver](https://dbeaver.com/docs/dbeaver/Data-Viewing-and-Editing/)                                   | Staged edits and generated change script; database write semantics are not Assay's model                   |
| W09 | [Data export — DBeaver](https://dbeaver.com/docs/dbeaver/Data-export/)                                                             | Query again versus fetched rows, selected rows/columns where offered                                       |
| W10 | [Standalone installation — DBeaver](https://dbeaver.com/docs/dbeaver/Installation/)                                                | Installed desktop distribution, not locality of the connected database                                     |
| T01 | [CSV Auto Detection — DuckDB 1.4](https://duckdb.org/docs/1.4/data/csv/auto_detection)                                             | Sample-based inference, overrides, `all_varchar`, `sniff_csv`; engine docs do not prove Assay API exposure |
| T02 | [Grid pattern — W3C WAI-ARIA APG](https://www.w3.org/WAI/ARIA/apg/patterns/grid/)                                                  | Navigation/edit focus modes and virtualized-DOM caveat; guidance, not a conformance result                 |

**Retrieval qualifications:** Microsoft S09 and S12 redirected from older Office article URLs; S08 was
found after a guessed legacy URL returned 404. Two guessed leading-zero Microsoft URLs also returned 404
and are not evidence. DuckDB `/stable/…` initially returned an HTTP-200 meta-refresh stub; following it led
to 2.0 documentation. T01 deliberately uses the 1.4 family to match Assay's recorded 1.4.3 engine, without
assuming every option is exposed in the web app. No failed lookup is treated as a feature absence.

Raw public-page captures and response metadata were retained for this research under
`/tmp/assay-spreadsheet-sources/`, `/tmp/assay-official-manifest.json` with corresponding numbered captures,
and `/tmp/assay-competitive-web/`. Those are temporary audit aids, not durable project dependencies; this
ledger and the precise claims above are the repository record. Product documentation may change after
retrieval. Recommendations and prioritization are our synthesis, not statements made by the vendors.

## 8. Review and documentation verification

An independent `openai-codex/gpt-6-luna` reviewer at explicit **xhigh** reviewed both documents and their
index/handoff changes. It found no critical issue and requested one clarification: the handoff's phrase
“existing WF-06 session safety” could imply implementation. That now explicitly says **already-designed
session-preservation work; runtime not implemented or authorized**. A fresh narrow review approved the
correction and its consistency with both documents. This is approval of a bounded research/proposal pack,
not an implementation brief, user validation, or runtime authorization.

Documentation gates: root `pnpm format:check`, `pnpm docs:links:check` (**148 files / 0 broken relative
links**), `pnpm adr:index:check` (**47 records**), and `git diff --check`. External source retrieval is
recorded separately in §7; the relative-link check does not certify live vendor content. No runtime,
package, dependency, lockfile, fixture, accepted ADR, telemetry or product-byte change was made. Runtime
suites were not rerun, and no push/publication action was performed.
