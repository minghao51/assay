# Essential workbench — first-wave implementation specification

**Date:** 2026-11-13. **Source baseline inspected:** `5466470` (clean).
**Authority, status and pickup:** [first-wave handoff](../process/handoff/20261113-essential-workbench-pickup.md).
This specification bounds the maintainer's “proceed with your recommendations” instruction; it is not
permission to implement every candidate in [the proposal](15-essential-workbench-enhancements.md).

**Visual companion:** [essential-workbench SVG pickup](../../assests/svg/essential-workbench/README.md)
(2026-11-13) illustrates replacement, scope, CSV and bulk-repair states in the existing shell. It is static
design guidance, not a pixel contract, delivered technical design or additional runtime selection. Textual
requirements and approval/return gates below prevail.

## 1. Outcome and selected denominator

First preserve work; then make current data scope intelligible; design import fidelity and atomic bulk
repair before extending engine semantics. These are not uniformly small UI changes. WF-06 is lifecycle work;
CSV interpretation and compact undoable bulk repair are cross-package designs, not new toolbar buttons.

| Reference         | Selected outcome                                                     | Implementation boundary                                                           |
| ----------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| EW-01 / **WF-06** | Runtime implementation of the existing reviewed replacement contract | Selected; fresh baseline gates and named reservation required before writing      |
| **EW-02D**        | Source-backed scope/copy specification                               | Design only; return exact per-surface copy and proof table                        |
| **EW-03D**        | CSV interpretation/API/lifetime contract                             | Design and bounded existing-API probes only; no import implementation             |
| **EW-04D**        | Scalar-text trim/exact-mapping atomic-repair contract                | Design and bounded existing-API probes only; no bulk implementation               |
| **EW-02I**        | Approved scope presentation                                          | Blocked until EW-02D's exact scope/copy is accepted and a runtime brief is issued |

EW-03/04 runtime waits for returned designs, unresolved semantic/architecture choices, independent review
and explicit implementation selection. EW-05…08 remain unselected candidates. WF-03/04/07/08/09, WF-O1/O2,
WFD-03/04/05/07, D-06/D-11, SQL sizing, overlay profiles and release/persistence work are not reopened by
adjacency. No second replacement task exists: EW-01 is the rationale; **WF-06 is the single runtime row**.

## 2. Stable contracts

Preserve accepted ADRs, particularly 0003 (engine owns data), 0011/0012 (logical identity and immutable
source/overlay), 0017 (portable metadata), 0025/0037/0045 (telemetry), 0029/0030 (SQL/Pipeline IR), 0044
(shell) and 0047 (unbounded table retention until teardown). Do not rewrite accepted ADRs.

- No source overwrite, hidden cloud upload, new dependency/lockfile, new telemetry event, report/DCR/export
  byte change, format expansion, engine interrupt, second worker, autosave or durable-save claim.
- Tasks remain navigation/exposure; no edit permission mode or task-switch engine work.
- Main grid/Record/validation use effective data. Profiles use File as opened; supplied SQL relation and
  pipeline source reuse are base-oriented. Diff preliminary schema/profile evidence and effective-A row
  diff remain distinct. Whole-effective export remains natural order, ignoring grid filter/sort.
- Raw typed values—not temporal display or clipboard strings—drive edits. NULL/empty/literal text,
  BIGINT/DECIMAL and temporal precision retain their tested semantics. WF-O2 and infinity projection limits
  are not fixed by association.
- No weakening tests, coverage, timeouts, allowlists, skips, retries, budgets or assertions. No forced
  Playwright clicks. New dataset-shape defects need minimal synthetic golden fixtures and regression tests.
- Source-backed statements are not user/AT evidence. RD-T07 remains a limitation. No new benchmark claim.

## 3. WF-06 requirements — inherit the reviewed lifecycle, not a dialog approximation

Read the [entire v5 contract](../process/handoff/20261110-wf05-replacement-contract.md), including its
C1–C16 copy, G1–G6 gate, T0–T11/T9b transitions, N1–N17 evidence and K01–K43 checklist. Its historical
“runtime unauthorised” clauses describe 2026-11-10; the dated handoff now selects WF-06. No code has shipped
from that selection yet. Use v1 §9 only for original cases **after applying v5's replacements**.

### 3.1 Required behavior

1. Keep legacy idle/example/drop/retry/cancel behavior; ready-state Open enters the new synchronous gate.
2. Read editor and pending-work authority synchronously **before** guard/chooser/await. Block every open
   cell editor, unsettled mutation and every outstanding column cast check. Boolean editors do not blur-
   commit. Never add a replacement-specific edit commit/cancel path.
3. Dirty means an applied outcome in the active history prefix. Undo-to-zero, redo-tail-only and no-op-only
   histories are clean; A→B→A remains dirty by adopted policy. Do not redefine pending-change counts.
4. Clean sessions choose without a dirty guard but still preserve the live session. Dirty sessions use
   the native guard: Stay / Export a copy… / Choose a replacement file…. Escape means Stay.
5. Export-first closes the guard, ends the intent and opens the existing exporter. No export outcome
   auto-opens the chooser, resets edits or marks clean. Current export snapshot/delivery semantics stay.
6. Chooser cancel/refusal or candidate failure preserves live session data, history, provider/model, drafts,
   findings, comparison, SQL and pipeline state. A replacement status/focus change is allowed as specified;
   preservation does not mean a byte-identical screenshot of status regions.
7. Prepare a candidate using its **own empty overlay box**, no captured live overlay/history/phase.
   Old source identity and all live session slots remain untouched. One candidate only; no candidate-ready
   approval, no Cancel or abandonment after candidate opening begins.
8. Adopt only after readiness: one synchronous reset → republish new history/overlay → rebind provider →
   publish identity/panels/ready phase → clear intent. No await or model refresh in adoption. Defensive late
   results check intent sequence and captured phase. Never reopen the candidate at adoption.
9. Respect modal arbitration and explicitly focus progress before making the ready region inert. Open
   during Export must not unmount an in-flight write. Restore only connected opener focus, otherwise Open.
10. Retain ADR 0047's limitation honestly: adoption and post-registration failures can retain tables until
    disposal; no per-table release exists. No “bounded leak”, “zero orphan” or leak-free claim.

### 3.2 Implementation clarifications to v5 shorthand

These narrowly make v5's intended behavior executable; they do not reopen its adopted product decisions.
They take precedence over the corresponding shorthand assertions only. Any further conflict requires a
stop/amendment, not worker interpretation.

| ID                                                 | Clarification / allowed seam                                                                                                                                                                                                                                                                                                                                                                                  | Required falsification                                                                                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **IC-01 Editor authority versus notice rendering** | Keep the synchronous App-owned editor ref as the gate authority. Permit an optional render-only editor-state reporting callback/mirror at the same existing handler writes so App can clear C13; a ref write alone does not rerender App. No effect-delayed authority or new commit/cancel path                                                                                                               | Refuse Open from an editor; Escape/ordinary commit closes it and clears C13 **without** another Open click or unrelated rerender; test text and boolean kinds                              |
| **IC-02 Cast authority versus render state**       | Aggregate pending checks must have synchronous ref-owned membership/count updated before the first await and in each finally, plus a render mirror for SchemaPanel/C16. The gate reads current ref authority, not a stale React state snapshot; keep existing per-column disable policy                                                                                                                       | Start a check and invoke the gate in the same turn; it refuses. Hold A+B, resolve non-committing B first; A still blocks. Final settlement clears C16; no auto-resume                      |
| **IC-03 Disable versus refusal**                   | Open is disabled when **intent active OR owned modal open**, not only when both are true. G3/G4 refusal leaves intent none; C13/C15/C16 do not themselves disable retry or create a dialog                                                                                                                                                                                                                    | Modal-only and intent-only truth cases; pending-work retry remains a refusal and never reaches a chooser                                                                                   |
| **IC-04 Technical-detail DOM and announcement**    | A closed details element contains a summary `Technical detail` and inert pre text; “only child is pre” means the sole diagnostic content block, **not** exclusion of summary. Use a failure container with value-free announced text and adjacent non-live details; do not place raw diagnostics inside the announced text/live subtree. User selection/copy is allowed; app-initiated diagnostic copy is not | Closed by default; summary accessible; marker appears only in pre, not announced status/alert text, title, logs or telemetry; ordinary user copy unsuppressed                              |
| **IC-05 Preservation and source pins**             | Assert live session identity/data/drafts/history for non-adoption paths, allowing specified notices, focus, inert/busy and T4 ExportDialog transitions. Exactly three production reset **call expressions** remain the invariant; grep counts including comments/tests are historical aids, not a ban on documenting tests                                                                                    | Distinct-schema live/candidate negative assertions; reset/adoption call-site inspection; no status change mistaken for session loss and no data loss hidden by a screenshot-only assertion |

IC-01/02 are reporting/observability additions within reserved App/grid/editing seams. They do not serialize,
abort, reorder, coalesce or fix pre-existing overlapping commits. Keep C1–C16 byte-for-byte from v5; no new
first-minute, save, timeout or recovery wording. If another seam or runtime policy is needed, stop.

### 3.3 Required acceptance and test layers

- **RTL/pure:** gate/machine/predicate and copy; clean/dirty picker cancel/refusal; deferred refresh/rollback;
  invalid/programmatic-open editor; overlapping checks; post-open provider failure; C13/15/16 clearing;
  no-auto-resume; defensive seq/phase rejection; IC-01…05. Literal copy assertions must be independent of
  implementation constants.
- **Browser/real engine:** valid candidate adoption, dirty Stay/Escape/export-first, unsupported/corrupt
  selected file, distinct-schema overlay isolation, first post-adoption edit, modal/export arbitration,
  explicit progress focus/inert, boolean real-pointer refusal, deferred work where existing Worker gating
  can hold it, dirty/clean/no-op/undo/redo cases, source-byte preservation and exact once-only adoption.
- Native chooser selection uses the existing input fallback/filechooser path. OS dismissal/refusal is not
  honestly driven by Playwright: keep deterministic mocked-picker RTL legs and label the coverage limit.
  Browser absence of a chooser after a refused gesture is still observable; it is not native cancellation.
- Candidate supersession is defensive unit coverage, not a fake second user intent or a newly added Cancel.
  Post-registration load failure is mandatory injected-provider RTL; real-engine coverage remains unasserted
  unless a valid fixture reproducer is found. Registry size and fallback-download disk persistence are not
  observable guarantees. Do not add a production test hook or package introspection to claim them.
- Existing open-cancel/open-recovery/export/history/validation journeys stay unchanged and green. Additional
  exact tests may be added; do not rewrite their asserted behavior to make the new path pass.

### 3.4 WF-06 file reservation

Allowed production files, and **only** the named behavior in §3:

- `apps/web/src/App.tsx`, `apps/web/src/index.css`;
- new `apps/web/src/replace/{gate,machine,messages}.ts` and `ReplaceGuard.tsx`;
- `apps/web/src/edit/session.ts` (`hasAppliedChanges` only);
- `apps/web/src/sessions/useEditingSession.ts` (pending observation and aggregate checks only);
- `apps/web/src/grid/provider.ts` (`rebindOverlaySource` only);
- `apps/web/src/grid/DataGrid.tsx` (synchronous editor reporting plus IC-01 mirror notification only);
- `apps/web/src/schema/SchemaPanel.tsx` (aggregate-check prop adaptation only).

Allowed tests: new `replace/{gate,machine,messages}.test.ts`, `replace/ReplaceGuard.test.tsx`,
`App.replace.test.tsx`, `sessions/useEditingSession.replace.test.tsx`,
`grid/DataGrid.replace.test.tsx`, `grid/provider.test.ts`, `edit/session.test.ts`,
`schema/SchemaPanel.test.tsx`, and `tests/e2e/replace-guard.spec.ts`.
Reusing unmodified helpers in `tests/e2e/support/` is allowed; editing helper/config/harness files is not.
Prefer existing fixture inputs (including synthetic existing e2e generators); temporary synthetic files
may be generated in `/tmp` by the new test. A new committed dataset fixture requires an explicit path,
generator/checksum reservation and minimal golden regression under the repository fixture rule first.

One new `.changeset/*.md` for `@assay/web` is allowed; state session preservation and ADR 0047 retention
without save/recovery promises. Orchestrator owns docs/CHANGELOG updates. **Not reserved:** `packages/**`,
`export/**`, `sessions/session-reset.ts`, `sessions/types.ts`, telemetry, configs, dependencies/lockfile,
ADRs or unrelated tests. Shared type/caller discovery outside this list is a scope amendment, not permission.

## 4. EW-02D — scope/copy specification, no new provenance

Output a source-backed table for Profile, SQL, Pipeline source binding, Validation, mixed-scope Diff and
Export: current exact label, actual relation, trigger, proposed exact string or **retain**, DOM placement,
state applicability, independent assertion and file reservation. Include initial/loading/empty/error/stale,
edited/filtered and narrow/zoom cases. Do not claim an “overlay-aware diff panel” or current SQL/pipeline
input when it actually uses the original File/view.

Use only already available state. Do not add revision stamps/origin metadata, engine calls, task permissions,
auto-runs, a new next action, global banners, a heading-map replacement or a new shell. Preserve helpful
existing copy rather than duplicating it. Clarify in an existing local panel/note where possible. Report
all WFD/D-11 collisions explicitly. Return this copy/placement/acceptance table for independent review and
maintainer acceptance; only then may a separately briefed **EW-02I** writer edit production.

## 5. EW-03D — CSV interpretation contract, not importer implementation

Read actual `engine-duckdb` reader/client/protocol/executor/registry/worker-core and browser API exposure.
Return sections for: current facts; proposed typed option allowlist/SQL quoting; quick-open versus advanced
flow; source/registration/preview/adoption ownership; inference coverage versus full evaluation; failures,
cancellation and late responses; probe transcript; decisions; future files/fixtures/tests.

The decision ledger must cover delimiter/header/duplicate or empty names, types/all-text, dates, quoted
empty versus NULL, sample disclosure, full-check definition, adoption identity, cancellation/resource bounds
and registration reuse versus a separately approved lifecycle change. Every item names alternatives,
recommendation, evidence, decision owner and unresolved/accepted status. Recommendations are not acceptance.

Test browser WASM capability—not native CLI alone. Parse-time string preservation must retain leading zeros;
casting an already-parsed number back to text cannot recover them. `count(*)` does not prove conversion of
all columns; show intended typed-column evaluation. Address failure beyond the sniff sample, lazy parsing,
quoted newlines/delimiters, unsafe integers, all-text headers and explicit refusal. No silent skipped rows.
Repeated option previews must not manufacture registered tables under ADR 0047. A single registered-source
idea still needs cancel/abandon/adoption accounting. No release API is assumed. `.ndjson` alias/copy repair
is a separately proposed row, not an implicit format change here.

**Return gate:** no runtime CSV row until browser exposure, ownership, complete-check meaning and remaining
policy decisions are resolved and accepted; new protocols/ADRs need separate approval.

## 6. EW-04D — deterministic scalar-text repair contract, not a per-cell loop

Read domain edit-ops/overlay/history/row identity, engine overlay wire/query composition, and web edit
publication/provider. Return sections for: exact operation examples; captured identity/revision/schema and
predicate; preview examples/counts/invalidation; representation alternatives and resource bounds; joint
worker/host publication/rollback; undo/redo/refolding/branching; races/cancellation; SQL/wire/privacy
validation; probe transcript; decision ledger; future files/fixtures/tests.

Decisions must cover exact trim code points, edge-only behavior, case/equality/collation, mapping collisions
and simultaneous-versus-cascading replacement, NULL/empty policy, no-op/dirty treatment, inserted/deleted/
previously edited rows, and **determinism of accepted filters**. Accepted SQL can contain volatile
expressions; unchanged history alone does not freeze membership. Specify stable target membership or
reject unsupported volatile scope. Whole-effective and accepted-filter scope are not DOM row selections.

Compare a compact relational operation with a bounded engine-owned delta; neither is already implemented.
Current History stores one closed-union EditOp per entry, and the engine statelessly folds active ops.
Explain exact replay/refolding, not just first execution. No unbounded matching-row arrays in React, no
silent top-N, no grouped per-cell loop pretending to be atomic, no relaxed overlay/insert limits. Specify
one logical publication boundary across engine and host History; handle transport failure, stale plans,
partial computation, rollback/restore failure, repeat Apply and redo. No new engine interrupt claim.

Use synthetic offscreen/sorted/filter cases, prior edits/inserts/deletes/renames/casts, no-op and stale
previews, out-of-order results, resource refusal, exact unaffected rows and source checksums. Regex,
deduplication, fuzzy matching, formula engines, arbitrary scripting, range paste and general column
transforms remain out. **Return gate:** if a bounded atomic representation cannot be established, reduce
scope or propose architecture work; do not issue a bulk-runtime brief from a list of SQL functions.

## 7. Verification and evidence

Runtime rows use the complete [WF verification contract](14-web-interface-followup-spec.md#6-verification-and-evidence-contract):
clean fresh baseline → worker candidate → independent reviewer → integrated revision, full gates at each
required stage. Commands/ports/logging and configured/restored telemetry steps are in the
[pickup](../process/handoff/20261113-essential-workbench-pickup.md#5-verification-runbook).
Historical counts are context, never new pass assertions. Config/test changes still require unit tests.

Design rows run docs format/links/ADR checks and cite source/probe evidence; no full runtime suite is needed
for prose-only changes. They may execute only the bounded disposable probes explicitly permitted by the
handoff. New repository code, fixtures, APIs or config are not probes. A claimed user interaction requires
real UI proof; native chooser cancel, unreachable supersession and download persistence retain their limits.

Each runtime behavior needs a meaningful independent negative control/mutation, restored byte-identically
and rebuilt before browser verification. No retries-to-green, forced clicks or assertion/threshold changes.
Reviewer must approve actual candidate code/commands, not a summary. Both schemes, keyboard, supported
viewport/zoom and source/format fidelity remain required. No participant/AT, cold-offline or remote-CI claim
follows from local automation.

## 8. Completion

The selected first wave is complete only when WF-06 is independently approved and merged-green,
EW-02D/03D/04D are delivered with honest decisions/limitations, and the integration ledger carries the
unselected runtime work forward. Design delivery is **not** implementation completion. If EW-02I is later
selected, extend the denominator explicitly. Do not reopen the prior WF-10 closure or call all EW candidates
shipped. Nothing in this specification authorizes a push, release or publication.
