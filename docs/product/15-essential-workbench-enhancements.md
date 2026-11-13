# Essential web-workbench enhancements — proposed direction

**Date:** 2026-11-12. **Baseline researched:** `aba9880`.
**Status at publication (2026-11-12): proposal only.**

**First-wave selection recorded 2026-11-13:** the maintainer has since asked to proceed. The
[first-wave handoff](../process/handoff/20261113-essential-workbench-pickup.md) and
[implementation specification](16-essential-workbench-first-wave-spec.md) now select WF-06 runtime subject
to fresh preflight, plus EW-02D/03D/04D design work. They supersede only this document's earlier blanket
unapproved status for that bounded selection; all other candidates and unresolved design/runtime gates
remain proposed. Use the handoff's current register, not the publication-time status language below.

Evidence: [functional comparison and 24 official sources](../reviews/2026-11-12-essential-workbench-comparison.md).
Authority: [canonical roadmap](03-execution-roadmap.md), accepted [ADRs](../adr/README.md), and the
[dated WF approval record](../process/handoff/20261110-web-followup-approval.md#32-approved-subset-manifest-dispatch-index).
The feature taxonomy is not a shipping list. Existing WF and engine-track decisions remain binding.

## 1. Product objective and stopping rule

Make this journey complete and trustworthy for a developer with a local structured file:

> Inspect → isolate a defect → preview a repair → apply reversibly → validate → compare → deliver.

Assay is **not a smaller spreadsheet**. Keep Parquet/CSV/JSONL/JSON, nested inspection, contracts, keyed
comparison, immutable sources, local-first execution, and web/CLI continuity central. Borrow familiar
interaction patterns only when they improve this journey.

**Essential** means preventing loss or misinterpretation, or removing repeated manual work in that journey.
It does not mean feature popularity elsewhere. Priorities below are product judgments, not measured user
demand, elapsed-time estimates, or approved sequencing. No parity percentage is useful.

Stop expansion once the selected acceptance journeys pass and the core repair loop is usable; do not turn
optional follow-ons into prerequisites. Do not reopen completed MVP or rd queues to implement these ideas.

## 2. Recommended candidates and existing-decision mapping

`EW-*` names are proposal references, **not dispatchable task IDs**. “Design first” means a new approved
contract and file reservation must precede implementation. Every row remains proposed, including high-priority
ones. Cross-package work cannot inherit a web presentation row's permissions.

| Candidate                                       | Priority / outcome                                                                  | Reuse and decision boundary                                                                                                                                              | Initial footprint / cost                                                                                  |
| ----------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| **EW-01 Preserve the working session**          | First: avoid losing edits or a clean session on replacement cancellation/failure    | **Reuse WF-06**, do not design a second guard; verified WF-05 v5, explicit runtime go still required; ADR 0047 retention remains                                         | Existing App/editor/provider seams; complex lifecycle, not a confirmation-dialog patch                    |
| **EW-02 Make operation scope unmistakable**     | First: distinguish file, effective data, filtered view, result, sample and artifact | Preserve current semantics; reuse WFD-07/WF-07, WF-O1 and WF-O2 only if separately selected; WFD-03/D-11 are not reopened                                                | Small source-backed presentation slices first; metadata not available today needs a separate semantic row |
| **EW-03 Review CSV interpretation**             | First design candidate: prevent irreversible interpretation mistakes                | New import/engine contract; not a WF display change; retain simple-open default                                                                                          | Worker/options/protocol, source lifecycle and fixtures; explicit resource-ownership design                |
| **EW-04 Previewable deterministic bulk repair** | First substantive capability candidate: fix repeated defects safely                 | New domain/engine/grid contract; reuse immutable overlay, logical identity, SQL target and History                                                                       | Cross-package atomicity/scale feasibility first; UI-only loops over cell edits are insufficient           |
| **EW-05 Close the quality-feedback loop**       | Next: traverse complete failure populations and verify repaired data                | Reuse validation/diff/finding jumps; separately select a complete-failure-relation design and/or the **existing overlay-profile candidate**; UX-D1/SV-D05 remain binding | Presentation reuse first; failure traversal/effective profiles require their own engine contracts         |
| **EW-06 Portable supported repair recipes**     | Next: reproduce a supported preparation step on another compatible file             | Reuse SQL/Pipeline IR under ADRs 0029/0030; no second DAG or arbitrary scripting                                                                                         | Versioned semantics, compatibility/preconditions, dry run, private local artifact                         |
| **EW-07 Explicit subset/result delivery**       | Optional after essentials: deliver an intentionally narrowed or derived artifact    | Whole-effective export remains default; new scope/order/result contract and byte-affecting approval required                                                             | Export/protocol/streaming and freshness work; not a new label on current dataset export                   |
| **EW-08 Opt-in local work checkpoint**          | Design only after initial loop: recover work across reloads                         | ADR 0017 portable metadata; persistence/recovery is separate from WF-06 and export                                                                                       | Identity, storage/privacy, quotas, permissions, migration and restore failure model                       |

**Recommended first investment:** authorize an existing WF-06 implementation separately if desired, plus
read-only designs for EW-03 and EW-04; select only the source-backed portion of EW-02. That is a proposed
selection, not authorization given by this document. EW-05/06 can follow a proven repair slice; EW-07/08
need not block it.

## 3. Shared interaction and data contracts

### 3.1 One vocabulary for seven different scopes

| Scope                                 | Meaning                                                                                                                                  | Required honesty                                                                                                                                                                                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **File as opened**                    | Immutable imported base                                                                                                                  | May differ from current edits; profiling currently lives here                                                                                                                                      |
| **Effective dataset**                 | Base plus the currently applied overlay/history cursor                                                                                   | Not necessarily every staged operation; no-op/cursor semantics remain unchanged                                                                                                                    |
| **Accepted filtered/sorted view**     | The effective data under accepted view predicates/order                                                                                  | Not draft inputs, DOM rows, overscan, or a durable row identity                                                                                                                                    |
| **SQL result**                        | Result of one explicit query against its actual input relation; the supplied table name currently addresses the original registered view | A fetched page is not the full result; edits/filters are not automatically included; no guessed origin/freshness metadata                                                                          |
| **Validation/diff evidence**          | A completed run with its own input and bounded evidence                                                                                  | A failure sample is not every failing row; stale results remain labeled                                                                                                                            |
| **Comparison B / pipeline candidate** | A distinct staged relation or recorded pipeline output                                                                                   | Diff's preliminary schema/profile evidence is base-oriented, while row diff uses effective A; pipeline “Use the open dataset” binds the original File, not edits; terminal outcome is not delivery |
| **Delivered artifact**                | A new-file output/report under an explicit scope and delivery outcome                                                                    | Initiated browser download is not proof of durable save                                                                                                                                            |

This is a design vocabulary, not approved runtime copy. Use available state; if provenance or coverage is
unknown, say unknown rather than inventing a revision badge. Adding actual run-origin metadata reopens
D-11 and needs its own approval. Task switching remains navigation, not an edit permission or automatic run.

### 3.2 Preview, apply, undo, and evidence

A proposed bulk action has a source identity, captured effective revision, target columns, accepted
predicate, operation parameters and failure policy. A preview shows bounded examples labeled as examples,
plus exact affected/error counts **only when computed**. If a complete safety check is required but has not
completed, Apply remains unavailable; “at least N” must not masquerade as an exact count.

Changing the underlying data, applied history cursor, relevant schema or predicate invalidates the preview.
Pure viewport scrolling does not. Confirmation applies the reviewed plan, not a new evaluation against
whatever happens to be visible. Preconditions must be checked at execution; a stale plan refuses without
partial changes. Successful apply is one undoable operation; reject/failed apply preserves the prior state.
If that atomic contract is not feasible within bounded resources, reduce the slice or stop for architecture
review—do not quietly perform a partially successful loop.

Preview cancellation may discard pending UI intent. It does **not** promise a true engine interrupt. During
an irreversible/atomic apply boundary, do not expose a false Cancel; design that lifecycle separately and
preserve existing engine cancellation honesty. Reuse current stale-validation/diff behavior; no implicit
validation, profiling, query execution or publication on task switch.

### 3.3 Fidelity, privacy, accessibility and scale

- Raw typed values, not formatted display/copy strings, are mutation inputs. NULL, empty string and literal
  text remain distinct. Preserve exact BIGINT/DECIMAL and supported temporal precision; NS/raw fallbacks,
  original-offset limits and WF-O2 remain explicit.
- Values are inert text. Clipboard data is untrusted; do not execute formulas, HTML or scripts. Preserve
  formula-injection-safe CSV export and all existing report/DCR byte contracts unless separately approved.
- No contents, filenames, predicates containing values, SQL results, recipe literals or diagnostics in
  telemetry or logs. Local previews may show actual values intentionally; neutral shell/status copy must
  not echo them. Recipes/checkpoints are potentially sensitive local exports, not harmless metadata.
- The engine owns data. Never materialize the whole dataset or every matching row into React state to drive
  selection, preview, copy or repair. No silent top-N execution or offscreen-row omissions. A resource
  limit must refuse explicitly and preserve the session, not truncate a repair.
- Keep ADR 0044's grid-centric shell, tool pane and Record dock. Use an existing panel plus bounded review
  affordance; no shell replacement, workbook tabs or DAG editor needed. Preserve modal ownership, focus
  return and live editor drafts.
- New actions need a keyboard route, visible focus, clear disabled reasons, correct editor/navigation modes,
  both themes, supported viewport/zoom checks and virtualized offscreen cases. Automated accessibility
  checks do not satisfy RD-T07 or establish screen-reader usability.

## 4. Bounded enhancement designs

### EW-01 — implement the already-reviewed replacement safety, if authorized

Use the [WF-05 v5 contract](../process/handoff/20261110-wf05-replacement-contract.md), not an approximate
reconstruction here. Preserve clean and dirty ready sessions during chooser cancellation/refusal and
candidate failure. Candidate reads must not consume the live overlay. Invalid/open editors and unsettled
mutations/cast checks gate the gesture; adoption is the defined synchronous ownership transfer.

Keep Stay / Export-first / Choose-replacement semantics and their actual delivery guarantees. No autosave,
reload-recovery or source-write claim follows. ADR 0047 accepts **unbounded** retired-table retention until
teardown; a future release primitive needs its own decision and superseding ADR, not a hidden change here.

**Success:** current history, provider, focused work and data survive every non-adoption path. A selected
candidate is adopted exactly once with no old-overlay leakage. Use the existing contract's complete matrix
rather than treating this paragraph as a substitute implementation brief.

### EW-02 — show scope at the point of action

Start with source-backed presentation: make it clear that Export currently writes the whole effective
dataset, Profile describes File as opened, SQL has a separate result, and stale evidence needs an explicit
rerun. Keep existing labels when they already convey this accurately; consolidate inconsistent cues, do not
add redundant banners everywhere.

For a future repair panel, use a compact summary such as **target column · whole dataset / accepted filter ·
preview state** above before/after examples. This is schematic wording pending copy approval. Keep raw
predicates/values in intentional local inspection controls, not global guidance or telemetry.

Do not conflate independent follow-ons:

- Visible viewport ranges belong to **WF-07/WFD-07**, not backend row IDs.
- Draft-versus-applied filter clarity belongs to **WF-O1**, not a SQL-equivalence claim.
- Nested/Record/query temporal parity belongs to **WF-O2**, with actual child/result type metadata.
- Task-aware next actions belong to **WF-04/WFD-03**; no extra primary action or hidden auto-run here.

**Success:** with a filtered edited grid and an old profile/validation result, the user can identify which
relation each surface describes and which artifact Export will produce. Presentation tests prove no new
engine call, remount or semantic change. New provenance cannot be asserted without new data ownership.

### EW-03 — CSV interpretation review, not a general import wizard

Keep the current quick-open route. Design an explicit advanced CSV review for delimiter/header decisions,
detected types and selected per-column overrides, particularly string identifiers and ambiguous dates.
A “preserve as text” option must operate **at parse time**: casting an already-inferred number back to text
cannot recover leading zeros or original lexical representation.

DuckDB 1.4 documents sampling, `sniff_csv`, explicit `types` and `all_varchar`; that is feasibility evidence,
not proof that Assay's browser API exposes them. Confirm the pinned engine/browser source behavior first.
Show the inference coverage actually known; sample success is not full-file validation. Do not enable
silent bad-row skipping, empty-on-error conversion or locale guessing as a default. Also reconcile the
source-confirmed `.ndjson` extension/Help mismatch under a separately approved alias/copy row; it is not a
reason to add workbook or Arrow/Feather input to this slice.

The design must resolve candidate ownership before a new preview loop is approved. Repeatedly registering
candidate tables for each setting change would accumulate resources under ADR 0047. Do not manufacture
extra registrations or assume a release API exists. Establish a no-extra-registration approach, or propose
a separately reviewed release/lifecycle change and its ADR implications. This is not folded into WF-06.

**Success fixtures:** leading-zero IDs, integers beyond safe JS precision, empty versus NULL, ambiguous
calendar strings, quoted delimiters/newlines, all-text headers, and a parse/type failure outside the initial
inference sample. Overrides produce intended typed values or an explicit error, never silent loss; cancel
or failure retains the prior ready session and source bytes. Unsupported formats remain unsupported.

### EW-04 — one small, reviewable repair builder

**First proposed slice:** one selected scalar text column, whole effective data or an explicit accepted
filter, with (a) a specified edge-whitespace trim and (b) an exact whole-value replacement/mapping. Choose
and approve the whitespace set, comparison/case policy, NULL policy and mapping collision rules before
implementation. Default proposal: case-sensitive exact matching; NULL preserved unless explicitly targeted;
no implicit case folding, Unicode normalization or empty-to-NULL conversion.

Flow: select column → choose operation and scope → inspect before/after examples and completed impact check
→ explicitly apply → one History entry → undo/redo → rerun validation. Reuse existing typed editor rules,
overlay identity, findings navigation and history rather than inventing a second edit store.

**Architecture gate:** determine whether a bounded relational operation can supply atomic apply/rollback
and a compact undo representation. A SQL expression alone does not establish overlay compatibility or
portable row identity. No unbounded array of per-cell operations in JS; no accidental weakening of current
insert/overlay limits. Crossing domain/engine/grid boundaries requires explicit new reservations, conformance
fixtures and an approved failure/undo model.

**Defer from the first slice:** regex replacement, general expressions, inferred series, deduplication,
column split/merge, fuzzy clustering and arbitrary multi-column edits. Later rectangular **plain-value**
paste/fill may reuse the same atomic boundary, with destination shape, raw types, empty/NULL policy,
filtered-row mapping and rejection behavior pinned. Single-cell copy or text pasted into an active editor
is not evidence that this batch feature exists.

**Success:** repair matching rows beyond the mounted viewport in a sorted/filtered view; exact unaffected
row preservation; one undo restores typed data; concurrent edits invalidate preview; failure midway cannot
leave a partly changed dataset. A no-op is reported truthfully without inventing dirty-state semantics.

### EW-05 — use quality findings to verify repairs

Preserve existing contract loading, invalid-row jumps, explicit rerun and stale-result treatment. Do not
propose “add validation” as if it were absent. Improve the continuity of the existing journey: from a
finding inspect its column/rule and true scope, perform a supported repair, rerun, then review diff/export.
Incomplete sampled failures cannot become an “all invalid rows” action.

**Large-failure traversal is a distinct proposed engine slice:** compile the supported failing-row
predicate into a pageable relation tied to the effective revision, with full count and stable logical-row
navigation, instead of targeting the current bounded sample list. Preserve “not expressible” for
aggregate/dataset-wide rules with no defensible row relation; overlapping rules need an explicit
union/intersection choice. A complete-failure predicate may feed a repair only after its population and
revision are confirmed. Do not enlarge or repurpose report samples or alter canonical report bytes to
pretend this traversal already exists. The existing 110-failure/100-sample case is a required negative
control. Focused B-side record inspection and a small contract-rule editor are optional follow-ons, not a
merge engine or a prerequisite for deterministic repair.

For profiles, explicitly select the existing
[overlay-aware profile candidate](../process/handoff/20261030-overlay-profile-candidate.md) if the maintainer
wants statistics to follow edits. Keep current base-only behavior for callers that do not opt in. Approve
relation/revision ownership, renamed-column binding, coverage and failure semantics; no silent fallback to
base stats on effective-profile failure. Replace the old base-only UI contract only when the new one ships.

**Success:** a change that removes a violation makes old evidence stale, rerun checks the effective data,
and the selected profile contract reports the matching relation. Empty datasets, rename/cast/insert/delete,
unsupported/incomplete failure scope and stale-result races have negative tests. If full-failure traversal
is selected, a supported 110-row failure population remains completely navigable despite the report's
100-sample cap; an unsupported rule refuses row targeting honestly. No automatic rerun needed.

### EW-06 — export a supported preparation recipe, not arbitrary session history

Start with allowlisted deterministic repair/relational steps. Record versioned operation semantics,
column/type preconditions, scope predicate, parameters and failure policy. Reuse the existing SQL target
and Pipeline IR where compatible; do not create a parallel language or assume every cell edit can become
an SQL node. No arbitrary embedded JavaScript/Python.

Portable predicates/transforms differ from session logical-row keys. A row-specific edit or insert/delete
sequence is nonportable unless a separately approved stable-key contract makes it portable. Export must
identify unsupported steps and refuse an incomplete “replay everything” claim; do not silently omit them.
Import performs schema/type compatibility checking and a dry run on an explicitly chosen file. Source
identity is a precondition, not a filename guess. Never execute a loaded recipe automatically.

**Success:** an approved trim/mapping recipe gives equivalent typed results on a compatible synthetic file;
incompatible types, changed columns, unsupported versions or unsupported operations refuse atomically. The
exported artifact warns that literal mappings/predicates can contain sensitive data. Existing pipeline/DCR
serialization is unchanged unless a separate format/version decision authorizes it.

### EW-07 — explicit filtered/query-result export, only if selected

Do not change the current whole-effective-dataset Export default or route filters into it silently.
Treat a subset export and a SQL-result export as separate entry points with explicit identity, columns,
ordering, freshness, and complete-versus-page scope. Exporting one loaded SQL page must not be called full
query export. Query rerun during export can differ from the displayed result; pin snapshot/rerun policy.

Use bounded/streamed engine output, original-source preservation, typed encoding and injection-safe CSV.
Preserve existing reports/DCRs and their byte contracts. Cancellation/refusal/failure and browser-download
handoff keep their actual delivery wording. Exact supported formats and result metadata require approval. Promoting a SQL result into a new editable
main dataset would be a further identity/adoption contract, not implied by result export. Existing SQL
joins/aggregations and pipeline transforms already cover analytical computation; this proposal addresses
safe handoff, not a missing query engine.

**Success:** filtered/sorted edited input yields exactly the explicitly selected scope/order; rows outside
the viewport are included when required; query results with aliases/aggregates preserve their schema;
source checksum remains unchanged; whole-effective export is unchanged when subset output is not selected.
This is a new export-semantics feature, not a presentation-only patch.

### EW-08 — explicit local checkpoint before any autosave promise

Design a portable work package for supported queries/contracts/recipes and, only if separately approved,
recoverable overlay state. ADR 0017 favors human-readable project semantics; browser caches do not become
the sole authority. Define whether original bytes are referenced or embedded, how permissions and quotas
work, the sensitive payload warning, retention/deletion and storage-failure behavior.

Restore must require the correct base identity and compatible schema/version. No filename-only match,
implicit wrong-file replay, automatic execution of SQL/recipes or “recovered” badge before validation.
Define incomplete-checkpoint and crash consistency separately from new-file dataset export. A checkpoint
containing only queries/recipes must say that unsaved cell edits are **not** recoverable from it.

**Success:** synthetic work is restored against the correct base, and mismatched/changed bases, denied
permissions, quota exhaustion and corrupted versions refuse without changing the live session. Copy must
distinguish session undo, checkpoint completion and delivered dataset export. No cloud account, hidden
background upload or tab-close guarantee is implied. This candidate is not an authorization for autosave.

## 5. End-to-end acceptance set: the denominator is the selected slice

These are proposed test journeys, not tests claimed to have run. Each selected implementation needs its own
positive/negative cases and an independent review at a fresh committed baseline.

| Journey                            | Essential proof                                                                                                                                                                                                     | Candidate mapping                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| **J1 Preserve work**               | Dirty and clean session → replacement picker cancel/failure → identical live data/history; invalid boolean/text editor and overlapping cast checks cannot bypass the gate                                           | EW-01 / WF-06 contract              |
| **J2 Understand scope**            | Edited, filtered view + base profile + stale validation + SQL page → each scope remains distinguishable; whole-effective Export still ignores the view                                                              | EW-02, preservation across all rows |
| **J3 Import faithfully**           | CSV identifiers/dates/types reviewed before adoption → correct types or explicit refusal; malformed late row is not silently skipped; prior session preserved                                                       | EW-03                               |
| **J4 Repair safely**               | Filtered/sorted rows, including offscreen rows → trim/map preview → apply → one undo/redo → exact unaffected rows and unchanged input bytes                                                                         | EW-04                               |
| **J5 Reject stale/failed plans**   | Preview → schema/data/predicate change or held engine failure → Apply refuses/rolls back atomically; no timeout-as-success or partial repair                                                                        | EW-04                               |
| **J6 Verify the repair**           | Contract failures → existing jump or separately selected full-failure relation → repair → old findings stale → explicit rerun → keyed comparison → current export; partial report samples never define all failures | EW-04/05, existing validation/diff  |
| **J7 Repeat deliberately**         | Export supported recipe → choose compatible new file → dry run and confirm → equivalent output; incompatible file/version refuses                                                                                   | EW-06                               |
| **J8 Deliver the chosen relation** | Explicit subset or query result spans multiple pages → complete selected output, accurate metadata/order; old whole-dataset path unchanged                                                                          | EW-07, if selected                  |
| **J9 Restore honestly**            | Explicit checkpoint → reload/correct base restore → recover only promised work; wrong base/quota/corruption fail safely                                                                                             | EW-08, if selected                  |
| **J10 Keyboard and fidelity**      | Complete selected J1–J9 without pointer-only controls; dual-theme/zoom/offscreen tests, NULL/empty/BIGINT/DECIMAL/temporal adversaries, no content in telemetry                                                     | Every selected row                  |

The initial bulk-repair denominator can stop at J1/J2/J4/J5/J6/J10 for the specifically selected features;
J3/J7/J8/J9 remain separate when not selected. Reuse current acceptance suites; do not delete fidelity or
failure assertions to accommodate new controls. Add golden synthetic fixtures for dataset-shape defects.
Do not claim improved task completion time until authorized participant evidence exists.

## 6. Decisions required before any dispatch

1. **Select scope and order.** Example proposal: WF-06 runtime separately; EW-02 source-backed presentation;
   read-only EW-03 import and EW-04 atomic-repair designs. Keep every unselected candidate proposed.
2. **Approve operation semantics and copy.** Exact trim characters, matching/NULL policy, predicate scope,
   preview count meaning, failure/undo behavior; do not import another product's defaults accidentally.
3. **Resolve architecture boundaries.** Import resource ownership and API exposure; compact atomic overlay
   representation; recipes versus existing IR; new result/persistence formats. Durable changes get a new
   Proposed ADR and acceptance when required; never rewrite an accepted ADR to fit implementation.
4. **Name evidence and ownership.** Fresh baseline, reserved files/packages/fixtures, one web writer, worker
   and independent reviewer, ports, full gates and meaningful negative controls. Existing floors, allowlists,
   skips and timeouts stay unchanged; no retries-to-green or forced browser clicks.
5. **Keep human evidence separate.** Authorize participant/AT work explicitly if wanted. Competitor docs,
   screenshots, source review and automated checks are not a usability study.

No changes to dependencies, telemetry semantics, format coverage, source overwriting, report/DCR/export
bytes, persistence, cloud services or hosted/AI gates follow from this proposal. Each would need a named,
approved row. Nothing here authorizes a push or release.
