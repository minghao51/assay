# SVG vision → implementation specification

> **Historical conservative fallback, not the current dispatch spec (2026-11-10).** The task-led rd route was selected and completed instead. Preserve this requirement vocabulary, but do not treat all SV items as either pending runtime tickets or implemented by association. New planning: [audited follow-up](../reviews/2026-11-10-web-svg-followup-audit.md), [specification](14-web-interface-followup-spec.md), [map](../process/handoff/20261110-web-followup-map.md). Help is now shipped (rd-7); D-10 fixed current VS Code input claims; optional/horizon decisions remain separate. No runtime authorization follows from either specification.

**Authored:** 2026-11-04. **Status: proposed follow-on specification; no runtime work authorized or implemented by this document.** Source audit baseline: `bba491a`. Revalidate at pickup; this is not a fresh runtime-gate result.

**Start:** [stack review and recommended redesign route](12-workbench-redesign-review.md) → [implementation map and decisions](../process/handoff/20261104-svg-implementation-map.md) → this conservative-route specification → [dispatch prompts](../process/handoff/20261104-svg-pickup-prompts.md). Visual references and capability audit: [SVG pack](../../assests/svg/README.md).

**Review amendment (2026-11-04):** the user is open to larger UI changes. Phase A below is now an **explicit conservative fallback**, not the recommended prerequisite for all enhancement. The preferred direction to validate is a bounded task-led redesign (`rd-*` / SV-D08). Its separately approved IA may replace named layout/copy contracts; data, privacy and execution guarantees remain. This document's fixed-layout clauses apply to conservative Phase A, not a blanket ban on redesign.

## 1. The ask

> Make the existing local workbench feel like one coherent, trustworthy workflow, using the SVGs as presentation guidance. Preserve the implemented data semantics and safety guarantees. Add only the explicitly selected UX deltas, prove the complete journey, and leave future/gated capabilities unimplemented.

**Recommended next step:** the `rd-0…rd-2` stack/journey audit, prototype and design-selection checkpoint in [product/12](12-workbench-redesign-review.md), before choosing runtime scope. **Conservative fallback if explicitly selected:** Phase A, tasks **sv-0…sv-7**, covering web presentation, secondary Help, truthful captions, filter/edit/export clarity and quality/pipeline legibility. Do not run fallback Phase A as mandatory preparation for the redesign or rebuild the MVP from the pictures.

**Separate optional follow-ons:** session-only DCR inspection (**sv-8**) and a dirty-session replacement guard (**sv-9**) require their own decisions. Expanded SQL (**sv-10**) and edited-view profiling (**sv-11**) remain deferred. Horizon **sv-12** is planning only.

The present user request reviews stack fit and explicitly permits consideration of larger redesign. It authorizes this review/specification amendment, not runtime implementation, publication, remote operations, gate passage or migration of existing queues. Bigger UI options must be structured and validated, not rejected solely because the old layout exists. The next agent may begin read-only reconciliation; obtain an execution instruction selecting a phase before claiming feature rows. See the map's approval wording.

### 1.1 Authority and interpretation

1. [AGENTS.md](../../AGENTS.md), accepted [ADRs](../adr/README.md), recorded maintainer decisions and the [canonical roadmap](03-execution-roadmap.md) win.
2. [Current handoff](../process/handoff.md) and active queue records determine what has actually shipped. The original usability, visual and audit-follow-up runtime rows are closed; do not redispatch them.
3. This spec and the map define a **new proposed** bounded follow-on. They do not alter the old [UX implementation contract](09-ux-ui-implementation-spec.md).
4. SVGs illustrate composition and intent, not exact DOM order, source code, executable data, fixed app dimensions or new backend capability. An apparent conflict is a STOP/decision, not permission to follow the picture.
5. The [feature taxonomy](01-features.md) is broader than shipping scope. Its older surface-status wording must not override current code/handoff evidence.

### 1.2 Completion means

A selected phase is complete only when its approved deltas are implemented or evidenced as already satisfied, all required preservation tests and gates pass, an independent reviewer approves, merged verification passes, and the orchestrator records evidence and remaining blockers. Do not call the entire product vision complete when Phase A is complete.

## 2. Current foundations: preserve, do not rebuild

| Area               | Existing foundation / immutable boundary                                                                                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inputs             | Parquet, CSV, JSONL/NDJSON, JSON. Arrow transport/export does not mean Arrow/Feather input.                                                                                                                                                             |
| Shell              | ADR 0044 tools-left + persistent grid at ≥1024px; record dock below grid. Minimum supported viewport 1024×700. Narrow layout scrolls/stacks; no phone-support claim or DOM reorder.                                                                     |
| Explore            | Virtualized grid, schema/tree, full record inspection, logical row identity, typed filters/sort, focused-cell copy and mode-aware keyboard navigation.                                                                                                  |
| Nested / SQL       | Supported path extraction, flatten/explode produce visible generated SQL and bounded result pages. Cancel abandons result delivery; it does not interrupt engine execution.                                                                             |
| Profile            | Explicit file-as-opened profile: null/distinct, numeric summaries/quantiles, categorical top-k. Numeric chart is a quantile strip, not a histogram. Click-to-filter safely resolves or refuses.                                                         |
| Repair             | Closed overlay operation vocabulary: cell set/revert, row insert/uninsert/delete/restore, column rename/cast. Session-only history with one Undo/Redo pair. No column drop or persistent autosave.                                                      |
| Export             | Whole accepted effective dataset, natural row order, independent of grid filters/sort. Parquet/CSV/JSONL/JSON/Arrow IPC stream; source-overwrite refused; CSV formula-safe; Arrow cannot be reopened by Assay. Desktop VS Code delivery is create-only. |
| Quality            | Native contracts/JSON Schema subset, explicit effective-view validation, stale verdicts, exact counts vs bounded examples, eligible failure-filtering, sanitized reports.                                                                               |
| Compare            | B staged separately; schema → distribution → confirmed-key rows. Inference proposes, never silently accepts. Only A-side samples jump into the main grid. Edits can stale reports; rerun explicit.                                                      |
| Pipeline           | P1–P3, deterministic ordered plan, local execution, preview, materialization, validation/publish gates and local lineage. Not a visual graph authoring tool.                                                                                            |
| DCR                | Canonical local value-free bounded YAML v1. Explicit keys and logical identities. Privacy findings **not computed**. No approvals/comments/policy checks/evaluations in v1.                                                                             |
| Surfaces           | Desktop VS Code is real and offline-capable with its bundled assets; vscode-web remains RE-SCOPE. CLI raw-file checks have no browser overlay. Packaging proof ≠ publication.                                                                           |
| Privacy / recovery | Local-first; configured allowlisted telemetry has disclosure/opt-out, stock endpoint absent. Native modal lifecycle, focus, busy/empty/stale/error recovery exist and must remain correct.                                                              |

A preservation check may reveal a regression. Record and scope it separately; do not use a presentation row to silently change engine/domain/protocol behavior.

## 3. Board-to-requirement traceability

| SVG                                                              | Implementation intent                                            | Requirements           | Owning task / disposition                      |
| ---------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------- | ---------------------------------------------- |
| [00 Atlas](../../assests/svg/00-vision-atlas.svg)                | Journey structure and scope separation, not a runtime dashboard  | SV-R01, SV-R16         | sv-0, sv-7; documentation / evidence           |
| [01 Welcome](../../assests/svg/01-welcome.svg)                   | Open/example/drop hierarchy, local processing and session truth  | SV-R02, SV-R03         | sv-1, sv-2; guard belongs only to sv-9         |
| [02 Explore](../../assests/svg/02-explore.svg)                   | Persistent grid, coherent schema/record identity                 | SV-R02, SV-R04, SV-R07 | sv-1, sv-3, sv-4; preserve existing inspection |
| [03 Nested SQL](../../assests/svg/03-nested-sql.svg)             | Action → matching generated query/outcome, separate result scope | SV-R04, SV-R08         | sv-3, sv-7; sizing only sv-10                  |
| [04 Profile](../../assests/svg/04-profile.svg)                   | Prominent file-as-opened provenance and safe click-to-filter     | SV-R04, SV-R09         | sv-3, sv-7; no overlay-aware profile           |
| [05 Repair/export](../../assests/svg/05-repair-export.svg)       | Readable staged operations and deliberate copy export            | SV-R06, SV-R07         | sv-4                                           |
| [06 Validation](../../assests/svg/06-validation.svg)             | Failure → logical row → repair → stale → explicit recheck        | SV-R04, SV-R10         | sv-5                                           |
| [07 Compare](../../assests/svg/07-compare.svg)                   | A/B context, confirmation and exact-count/sample hierarchy       | SV-R04, SV-R11         | sv-5                                           |
| [08 Pipeline](../../assests/svg/08-pipeline.svg)                 | Style the existing ordered execution plan / gate outcomes        | SV-R12                 | sv-6                                           |
| [09 Local DCR](../../assests/svg/09-local-dcr.svg)               | Inspect the exact artifact generated in this session             | SV-R14                 | sv-8; separate decision, not Phase A           |
| [10 Surfaces](../../assests/svg/10-surfaces.svg)                 | Accurate source setup and continuation guidance                  | SV-R03, SV-R15         | sv-2, sv-7; no extension/CLI runtime redesign  |
| [11 Trust/recovery](../../assests/svg/11-trust-recovery.svg)     | Global Help, consistent status and explicit local recovery       | SV-R03, SV-R05, SV-R13 | sv-2…sv-7; preserve existing recovery seams    |
| [12 Adaptive dark](../../assests/svg/12-adaptive-dark.svg)       | Shared visual hierarchy in supported schemes/window sizes        | SV-R02, SV-R13         | sv-1, sv-7                                     |
| [13 AI horizon](../../assests/svg/13-ai-horizon.svg)             | Research register only                                           | SV-R16                 | sv-12 / SV-F01; G2/M8 decisions                |
| [14 Governed horizon](../../assests/svg/14-governed-horizon.svg) | Research register only                                           | SV-R16                 | sv-12 / SV-F02; G3/G4 decisions                |
| [15 Prepare horizon](../../assests/svg/15-prepare-horizon.svg)   | Future authoring / adapter / advanced-feature register           | SV-R16                 | sv-12 / SV-F03…SV-F07; not Phase A             |
| [16 Filter/edit](../../assests/svg/16-filter-edit.svg)           | Distinguish drafts/applied view, typed editors and feedback      | SV-R05, SV-R06, SV-R07 | sv-3, sv-4                                     |

## 4. Phase A requirements

Each requirement lists the **new delta** separately from existing behavior. If no visual/behavioral gap remains at pickup, the map's evidence-only path applies; do not change code for its own sake.

### SV-R01 — Bound the work before coding

- Produce an actual-vs-target delta ledger for all 17 boards, with source/test references, current observation, exact proposed change, owning task and exclusions. Classify each as **preserve**, **new UI delta**, **decision-blocked**, or **horizon**.
- Capture the actual approved starting revision, working-tree state, tool versions and clean baseline gates. Historical `bba491a`, test counts, screenshots and past reviewer verdicts are not a new baseline.
- Read the SVG pack even when it is untracked in the authoring checkout. An isolated worktree cannot see uncommitted assets; arrange authorized integration or an explicitly recorded working-copy snapshot. Never delete, hide, auto-stage or silently commit unrelated work to make a baseline green.
- **Acceptance:** SV-T01. Output is evidence and a bounded change list, not another unspecific redesign proposal.

### SV-R02 — Coherent presentation inside the existing shell

**New delta:** adopt consistent panel headings, control treatment, spacing, semantic status styling and concise contextual captions where the approved delta ledger demonstrates inconsistency. Reuse existing tokens and named classes; do not rebuild the token layer or change all controls indiscriminately.

- **Board 01 ingress criterion:** preserve one visually primary **Open a data file…** action, with the existing bundled example and idle-only drop instruction as secondary ingress. Verify the example reaches the real nested-data workflow, drop uses the same guarded open chain, opening remains indeterminate/cancellable, and classified open errors plus retry remain visible instead of being covered by welcome content. This is preservation/evidence first, with styling only for an observed hierarchy gap; no new ingress, auto-open or replacement guard. sv-0 must cite `App.test.tsx`, `App.drop.test.tsx`, `App.open-status.test.tsx` and current smoke/drop/open/nested journeys as applicable.
- Preserve all tool sections and their accessible names/purpose descriptions, collapse/recovery behavior, sticky nav and accepted element order. The SVG's abbreviated nav is not a replacement `WORKBENCH_SECTIONS` list.
- Keep existing production pane widths/breakpoints, 28px data rows, horizontal scrolling, viewport/overscan behavior and record dock. SVG grid rows/canvas dimensions are schematic. SQL panels stay in their current placement/sizing unless sv-10 is separately approved.
- One restrained primary action per local context; wrap text rather than shrink essential instructions. No new fonts, animation, dependencies, theme preference or UI-package extraction.
- Light/dark and hover/focus/disabled/error states must be styled together. No color-only distinction.
- **Acceptance:** SV-T02, SV-T13. At 1024×700, normal ready-state header, first row and grid footer remain reachable/visible under the existing geometry contract. Additional guidance/disclosure/zoom may scroll, never clip.

### SV-R03 — Capability-aware global Help and setup guidance

Help is secondary reference, not the mechanism for discovering every core action or a functional prerequisite for filter/check/pipeline improvements. The redesign route validates primary task discoverability first.

**New delta:** add a consistently named **Help** button in the web header, available in idle and ready states, opening a native modal dialog with a concise task guide. This choice is proposed for Phase A approval; it does not introduce a permanent third pane.

- Dialog sections: **Open and inspect**, **Query and profile**, **Repair and export**, **Validate and compare**, **Pipeline and local DCR**, **Other surfaces and setup**. Use short steps, not an exhaustive feature catalog.
- Explain four supported input formats, no-upload local processing, session-only edits, whole-effective-view export, Arrow export-only, explicit recheck, and raw-file CLI continuity. Account creation, a public npm install or an already-deployed collector must not be implied.
- Ready-state task links close the dialog then use existing section-reveal/focus behavior. Idle renders explanations but no dead links to absent dataset sections. Session replacement invalidates delayed navigation. Do not rerun queries or perform exports from Help.
- Keyboard content must distinguish focused row vs cell vs text editor and only describe wired capabilities. Preserve the grid's existing **Keyboard** disclosure; no shortcut editor or second keyboard-handler implementation.
- Opening sets meaningful focus; Tab stays within the active modal; Escape/Close restores the connected opener or a safe fallback. Implement Help with native `<dialog>.showModal()`, but do not assume Export is native: its existing custom role-dialog/focus trap and in-flight close restriction stay unchanged. App-local modal-intent ownership must reject/defer Help while Export or required disclosure owns focus, give disclosure priority over pending Help, and suppress return-focus that would steal focus from a new modal/session. A brief may explicitly reserve bounded disclosure lifecycle callbacks if needed; no consent/storage/emission change or new modal framework. Test competing opens, working export and disconnected openers; STOP if broader state changes are needed.
- **Acceptance:** SV-T03, SV-T13, SV-T15. New component/test names in the map are proposals, not existing files.

### SV-R04 — Consistent, truthful result-origin captions

**New delta:** use one visual caption/badge language beside the affected region, derived from existing authoritative props/state. No new engine query, refresh, subscription or second result store.

| Region           | Required meaning / suggested concise label                                                                                                          | Must not imply                                                              |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Grid             | **Current dataset view**; separately show **N staged operations** and filter/sort view state. Active operations can be no-ops.                      | Operation count = changed-row count; filtered count = full dataset total.   |
| SQL              | **SQL result page**; actual page range/has-more state only. Preserve whatever base/effective-view semantics the client actually supplies.           | Page size = total rows; generated query = committed edit.                   |
| Profile          | **File as opened** plus existing exact R-16 standing hint and staged-operation note.                                                                | “Stale — refresh to include edits,” live overlay statistics or a histogram. |
| Validation       | **Checked dataset snapshot** with fresh/stale status. Add origin detail only from explicitly captured app-local run metadata, never revision alone. | A previous result automatically describes the current overlay.              |
| Compare          | **A: checked view snapshot** vs **B: staged comparison**; confirmed keys and freshness distinct.                                                    | B belongs in the primary grid; schema/profile alone establish row identity. |
| Dataset export   | **Whole current dataset**, effective base-plus-overlay in natural order; staged-operation count separately; existing filter/sort disclosure.        | Exported rows follow the current filter/sort, selected cell or page.        |
| Pipeline preview | Identify the existing preview node/result scope when available; no invented dataset total.                                                          | Preview = published output.                                                 |

- Existing byte-exact copy, accessible names and wire/report fields remain authoritative. Prefer supplemental captions or existing hint styling; do not rewrite stable copy to match a drawing.
- Freshness uses the result's captured revision/session ownership; neither nonzero revision nor operation count proves changed content or original-versus-overlay run origin. Current validation state stores revision/report, not that origin. Default to neutral snapshot wording. If more provenance is selected, explicitly reserve the validation/diff app-session types/hooks in sv-3 and atomically capture the needed readonly metadata with the actual run snapshot, with reset/race tests. Do not infer it from today's history or add domain/engine/wire/report fields.
- **Acceptance:** SV-T04, SV-T08…SV-T12. A presentation helper may share styling; it must not own engine state or become a new domain model.

### SV-R05 — Consistent state feedback, without changing state machines

**New delta:** align existing busy/empty/error/stale/refused/success presentation where the approved ledger identifies inconsistent hierarchy. Keep each panel's current authoritative state machine and recovery handlers.

- Opening/profiling/SQL operations with no progress information remain indeterminate. Cancel means abandoning UI delivery; do not promise interrupt or restart.
- Distinguish empty dataset, zero matches, zero failures, identical comparison, no SQL rows and missing contract/pipeline input. Offer the relevant existing next action, not generic “Something went wrong.”
- Stale keeps the old verdict visible with an explicit rerun action. Refused export, failed cast and blocked gate cannot get success styling.
- Retain static path/value-free error-boundary copy, section-only retry/close, and grid-retry/reload loss disclosure. Do not auto-retry a consumed nested SQL request on remount.
- New status announcements must be value-free, polite for busy/success, and not duplicated by a caption + live region on each render. Error detail stays text, not interpreted HTML.
- **Acceptance:** SV-T05, SV-T13, SV-T14.

### SV-R06 — Draft-versus-applied filter clarity

**New delta:** add or style **Unapplied input changes** when the compose/active-row inputs differ from their last accepted/seeded input representation, including invalid or cleared input. The current string drafts and SQL-predicate escape hatch do not provide general semantic equality; do not promise it. Active chips continue to represent accepted model filters only. The SVG's unapplied example is a draft, not an active view.

- Do not add another filter builder or SQL-equivalence engine. Reuse current parser/compiler and input reseeding. Distinguish untouched, cleared-to-empty and invalid inputs. Input-change comparison may compare seeded/current field text; call it an input change, not proof of different predicate meaning.
- Apply is explicit. While pending, prevent conflicting submits using existing gates. Preserve current failure behavior: restore accepted filters and reseed drafts from that accepted list on successful rollback. If rollback also fails, retain the existing explicit uncertain-state error; do not claim the old view was restored. Retaining a rejected input buffer would be a separately approved behavior/state change with its own lifecycle tests, not styling.
- External profile/validation filter application reseeds the compose/active rows and updates accepted chips; removing one chip removes only that accepted predicate.
- Preserve SQL-predicate disclosure and current validation filter-replacement messaging. No arbitrary executable-code contract rule is introduced.
- **Acceptance:** SV-T06. If the current UI already proves draft clarity, record the evidence instead of changing filter logic.

### SV-R07 — Staged change review and export clarity

**New delta:** improve History/Export visual hierarchy and add a compact **review context inside the existing export dialog**, not a new mandatory multi-step save wizard. Show accepted active operation count, export format, whole-effective-view scope and existing save restrictions. Use one navigation action to existing History where helpful; do not duplicate Undo/Redo.

- Count is **staged operations**, never “changed rows/cells.” At zero or undo-to-zero, remove false dirty indicators. No phantom persistent workspace or autosave label.
- Preserve typed cell edit, distinct Set NULL vs empty string, row restore, rename/cast refusal/rollback and native editor shortcuts. No new codecs, bulk fill or column-drop operation.
- Keep the current timing/snapshot contract for export. Dialog presentation must not introduce a stale cached overlay; if edits can occur concurrently, the chosen snapshot and existing pending gate remain explicit.
- Preserve all five formats, formula-safe CSV, IPC stream MIME/bytes and Arrow cannot-reopen guidance. Save-picker cancellation, source refusal, failed write and fallback download keep their actual per-surface meanings; no success before existing delivery confirmation.
- Export includes all effective rows in natural order even when grid filters, sort or page differ. Do not add a subset toggle, compression/partition tuning or results export.
- **Acceptance:** SV-T07, SV-T15. Existing byte and source-integrity assertions remain, not replaced with screenshot tests.

### SV-R08 — Nested action / SQL continuity (preservation)

Preserve exactly-once request consumption across reveal/remount, matching outcome focus for success/empty/error, visible editable generated SQL, bounded paging and cancel/late-result handling. No center-mounted/resizable SQL workspace or saved-query subsystem. **Acceptance:** SV-T08.

### SV-R09 — Profile scope and action safety (preservation)

Preserve file-as-opened hint in idle/running/error/results, staged-operation note at N=1/N>1, no false note at zero, quantile labels/text alternatives and categorical counts. No automatic profiling on edit. Click-to-filter must refuse unresolved/renamed/cast-incompatible fields without silent remap/coercion. **Acceptance:** SV-T09.

### SV-R10 — Validation legibility and truthful freshness

**New delta:** visually separate contract setup, exact rule aggregate, bounded failure examples, freshness and actions. The existing checks/compiler/import/report semantics are unchanged.

- Keep starter contract on-ramp, supported JSON Schema subset with located unsupported-key errors, severity ordering, per-rule counts/percent and logical-row jump.
- Failure-filter action remains enabled only under existing complete/eligible sample rules. Disclose filter replacement and explain disabled cases. No claim that examples enumerate every failing row.
- Preserve explicit run → result → edit → stale → rerun. Report output and source bytes stay unchanged. Do not add automatic repair suggestions or failure-row dataset export.
- **Acceptance:** SV-T10, SV-T14.

### SV-R11 — Comparison legibility and confirmed identity

**New delta:** clarify A/B labels, schema/distribution/row sections, exact counts vs sample counts and confirmation/freshness hierarchy using current controls/data.

- B staging leaves A/grid intact. Schema/distribution disclosure precedes row findings. Explicit or minimal-first inferred candidates still need nonempty user confirmation; never make “proposed key” look already confirmed.
- State screenshots/tests must represent a coherent point in the flow: unapplied candidate vs confirmed report, not a contradictory mixture. Preserve composite-key and unsupported-comparability explanations.
- A-side row jumps only; B-only data remains comparison context. Preserve explicit rerun and sanitized reports. No merge, B editing, computed p-values or invented full-distribution evidence.
- **Acceptance:** SV-T11, SV-T14, SV-T15.

### SV-R12 — Readable ordered pipeline execution

**New delta:** style the existing accessible ordered plan so node identity/kind, relation, logical materialization and actual status are easy to scan; a refused gate is visibly different from successful completion.

- Retain deterministic topological order, `<ol>` semantics, actual status vocabulary, existing lineage, generated plan information and grid-native previews. Suggested visual categories map to existing states; no new runner state names or transitions.
- Show which gate stopped execution and which downstream nodes did not run using existing value-free evidence. Do not label a gated run “published.” Unsupported materialization mappings still refuse explicitly.
- No drag/drop graph, node reordering, orchestration service, scheduler, adapter installation or new materialization behavior.
- DCR generation/delivery remains as implemented in Phase A; richer artifact inspection belongs to sv-8.
- **Acceptance:** SV-T12, SV-T14.

### SV-R13 — Accessibility, responsive layout and privacy are acceptance criteria

- Keyboard-only open/Help/task-reveal/cell-edit/record-step/check/jump/export and local recovery paths must work. Preserve roving focus and logical row targeting under filter/sort/edit.
- Dialog focus, Escape, return focus, native modal isolation and disclosure lifecycle need real-browser assertions, not only DOM-shim tests. No duplicated active modal or background tab escape.
- Check light/dark at 1024×700, 1440×900, 1920×1080; 900px narrow scrolling; 200% zoom/readable wrapping; forced-colors/reduced-motion where relevant to new controls. No unsupported phone promise. Preserve existing axe/heading/focus thresholds and zero unexplained exceptions.
- Textual labels plus semantic color, visible 2px focus, AA contrast for adopted controls/status/empty/NULL text. Use existing typography/spacing aliases rather than introducing an unrelated brand palette.
- No new telemetry events/dependencies/remote fonts/provider requests. Tests of configured telemetry abort collectors before navigation, block service workers and restore stock build before stock legs.
- **Acceptance:** SV-T13, SV-T14, SV-T16.

### SV-R15 — Surface continuity without false parity

**New delta:** concise Help/rehearsal/setup guidance connecting web export to CLI validation/diff and desktop VS Code. No CLI or extension runtime changes in Phase A.

- Commands/examples come from current help and proven fixtures, not imagined flags/files. CLI checks raw inputs; validate/diff the exported edited copy for agreement, not an unsaved web overlay.
- Desktop: supported scalar edits only, session loss warning, source-read-only, create-only export, explicit validation/key confirmation, path-free Git context, no telemetry. vscode-web is not the desktop extension.
- Document four proven input formats. Report the VS Code declared-extension mismatch as a separate scoped issue; do not “fix” it by pretending engine support exists or altering routing in a presentation task.
- Source checkout / Node ≥22 / repository pnpm / install / dev is the documented setup. Respect local offline asset differences and publication/collector boundaries.
- **Acceptance:** SV-T15. Existing [demo rehearsal](10-ux-ui-demo-rehearsal.md) retains its distinct nested, M5 and M6 fixture narratives; do not pretend all chapters use one repaired dataset.

## 5. Optional scope — blocked until its decision is approved

### SV-R14 — Session-only DCR artifact inspector (sv-8 / SV-D02)

**Recommended design, not accepted by this document:** inspect the exact artifact produced by the existing derivation; do not add standalone DCR-file import, a second DCR build, a backend or hosted review.

Current seam: `deriveDcrArtifact` in [dcr-export.ts](../../apps/web/src/pipeline/dcr-export.ts) returns successful YAML/summary; [usePipelineSession](../../apps/web/src/pipeline/usePipelineSession.ts) owns derivation/delivery and generation guards; [DcrExportState](../../apps/web/src/pipeline/pipeline-state.ts) currently stores delivery outcome, not artifact content. Reconfirm names/shapes at pickup.

Recommended acceptance contract for SV-D02:

1. **Generation and delivery are separate.** Successful, still-owned derivation may make an artifact preview available before destination selection. A cancelled save leaves **Generated in this session · not saved**, not **Delivered**. Refused/failed delivery may retain the same generated preview with explicit unsaved status. A generation/build refusal produces no new preview. This is a deliberate new UI state contract requiring approval.
2. **One artifact, one derivation.** Retain canonical YAML and the AST from that same successful build where possible. If an AST is needed from retained YAML, use the existing total parser; do not rebuild a supposedly equivalent artifact. Inspection performs no engine query, second derivation, save or network request. Extra retained content remains within existing artifact bounds; do not add unbounded storage.
3. **Ownership.** Bind the preview to the run/definition/session generation and the exact base/candidate selections, logical IDs and explicit keys used. Clear/hide it on a new generation attempt, relevant form change, pipeline/settled-run replacement or session disposal. Check current ownership at every asynchronous boundary; old results cannot populate a new run's inspector. Do not add durable persistence or a new invented freshness field to v1 bytes.
4. **Read-only content.** Expandable summary with headings for identity/references, schema/column/row deltas, validation and lineage actually present. Absent sections say **Not included**, not **Passed**. Privacy explicitly **Not computed**. Optional collapsed canonical YAML rendered as text, with exact same bytes as delivery. No cell values, raw SQL, sensitive source filenames, comments, approvals, policies or evaluations.
5. **Honest actions.** Expand/collapse/close does not regenerate or redeliver. Do not add a “save cached artifact” action in this row; existing generation/delivery controls remain. Form changes require a new explicit generation. Focus and reading order work in the existing pipeline section, not a full-page hosted review workspace.
6. **Proof.** Preserve byte agreement with [canonical DCR fixture](../../fixtures/dcr/cli-gated-run.yaml). Cover derive success + save success/cancel/refusal/failure, failed build, ownership races, optional missing sections, exact privacy wording, inert content, no extra engine/derive calls, clearing on selection/run/session changes and unchanged existing delivery.

**Acceptance:** SV-T17. Approval must explicitly select preview lifetime and summary/YAML design; do not silently adopt a recommended default.

### Dirty-session replacement guard (sv-9 / SV-D03)

Recommended separate enhancement: intercept **opening a replacement dataset/example** before the existing session is invalidated when accepted staged operations exist. This is not a durable save or broad unload guarantee.

- Recommended actions: **Stay**, **Export current dataset…**, **Discard changes and choose a file…** (example action must name its actual replacement). State clearly that changes are session-only and source bytes are unchanged.
- Stay or cancelled picker/export retains the current session and overlay. Export success alone does not discard or open another dataset; the user must still explicitly choose replacement/discard. Source-refused/failed export retains work.
- Do not clear the grid/history before a valid replacement request enters the existing guarded open chain. Prevent repeated concurrent prompts. Existing late-open token protection and idle-only drop semantics remain.
- No `beforeunload`/tab-close guarantee, autosave, workspace persistence or VS Code native dirty-document semantics in this row. Typed cell drafts are distinct from accepted staged operations; define whether a pending draft must be committed/cancelled before replacement in the approval record.
- **Acceptance:** SV-T18 after explicit approval. The map must record draft treatment and picker/export flow before dispatch.

### Deferred SQL and overlay-aware profile (sv-10, sv-11)

Do not implement these under Phase A or infer approval from a roomy SVG. Reuse the [uxv-6 / UX-D2 queue record](../process/handoff/20261026-ux-ui-execution-queue.md) and [overlay-profile candidate](../process/handoff/20261030-overlay-profile-candidate.md); first ask whether those decisions are being reopened. Any approved SQL sizing design must preserve tools-left composition, matching outcome focus, keyboard accessibility and narrow fallback. Any approved overlay-aware profile needs a separately specified engine/client/state/consistency contract and a maintained file-as-opened mode. This pack intentionally does not invent either protocol.

### SV-R16 — Future capability register (sv-12)

Every broader capability remains visible in the [SVG capability matrix](../../assests/svg/README.md); none is silently dropped or treated as Phase A. See map §5 for SV-F01…SV-F07. Future implementation requires a new scoped spec, relevant gate/demand evidence and any ADR changes before task dispatch. No disabled “coming soon” launch navigation is required now.

## 6. Acceptance / verification matrix

Existing test paths below are starting points, not proof that the requested assertions already exist. Add focused regression assertions where necessary; proposed new suites must be listed as new in worker reports. Full gates remain required by map §6.

| Test ID | Observable proof                                                                                                                                                                                 | Existing starting points / proposed additions                                                                                                                                                                                                                                                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SV-T01  | Baseline revision/dirty state/env names/versions/gate exits recorded; all boards classified; scope approved                                                                                      | map preflight ledger; current handoff + SVG README                                                                                                                                                                                                                                                                                    |
| SV-T02  | Open primary/example/drop secondary, guarded example/drop/open/error/retry flow; accepted shell geometry/reading order, grid footer and horizontal scroll preserved; no extra render/query churn | `App.test.tsx`, `App.drop.test.tsx`, `App.open-status.test.tsx`, `App.shell.test.tsx`, `App.memo-probe.test.tsx`, `shell-geometry.test.ts`; `smoke.spec.ts`, `drop-open.spec.ts`, `open-cancel.spec.ts`, `open-recovery.spec.ts`, `nested-journey.spec.ts`, `shell.spec.ts`, `grid-horizontal.spec.ts`, `grid-virtualization.spec.ts` |
| SV-T03  | Idle/ready Help; accurate mode-aware content; no dead task links; reveal/focus only; modal arbitration and close-focus                                                                           | New `help/WorkbenchHelp.test.tsx` + `tests/e2e/workbench-help.spec.ts`; existing `DataGrid.interaction-hints.test.tsx`, `DataGrid.keyboard.test.tsx`, `App.shell.test.tsx`                                                                                                                                                            |
| SV-T04  | Neutral captions handle no-op operations and undo-to-base revisions; optional metadata captured atomically; page/sample/total/origin not conflated; no extra engine calls                        | Panel component tests, `App.profile-honesty.test.tsx`, `App.section-summaries.test.tsx`; new focused scope assertions if needed                                                                                                                                                                                                       |
| SV-T05  | Indeterminate busy/cancel, correct empty/refusal/success presentation; stale visible; section-only recovery and no SQL replay                                                                    | `App.open-status.test.tsx`, `App.panel-boundary.test.tsx`; `open-cancel.spec.ts`, `open-recovery.spec.ts`, `sql-editor.spec.ts`; existing panel-recovery harness when affected                                                                                                                                                        |
| SV-T06  | Unapplied input indicator makes no semantic-SQL claim; accepted chips only; failed apply rollback/reseed and double failure; external reseed; clear/invalid/pending/remove cases                 | `grid/FilterBar.test.tsx`, `App.profile-filter.test.tsx`, `App.grid-busy.test.tsx`; `filter-builder.spec.ts`, `grid-filter-sort.spec.ts`, `profile-filter.spec.ts`                                                                                                                                                                    |
| SV-T07  | Count = operations; undo/redo zero boundary; typed editor/native undo; full effective export despite filter/sort; all format/source/byte protections                                             | `edit/op-summary.test.ts`, `edit/op-summary.render.test.tsx`, `App.history-shortcut.test.tsx`, `export/ExportDialog.test.tsx`, `export/save-destination.test.ts`; `history-shortcuts.spec.ts`, `grid-editing.spec.ts`, `export-rewrite.spec.ts`, `m4-exit-journey.spec.ts`                                                            |
| SV-T08  | Nested action runs once, reveals matching success/empty/error, correct focus; query page/cancel not dataset mutation                                                                             | `sql/SqlPanel` / App request-consumption tests; `nested-journey.spec.ts`, `sql-editor.spec.ts`                                                                                                                                                                                                                                        |
| SV-T09  | Exact file-as-opened hint through all states; N=0/1/>1; quantiles not histogram; renamed/cast action refusal                                                                                     | `profile/ProfilePanel.honesty.test.tsx`, `App.profile-honesty.test.tsx`; `profile-honesty.spec.ts`, `profile-filter.spec.ts`                                                                                                                                                                                                          |
| SV-T10  | Contract on-ramp/errors, exact aggregate vs bounded examples, disabled filter reasons, logical jump, edit→stale→rerun                                                                            | Validation tests; `validation-panel.spec.ts`, `validation-report-export.spec.ts`, `m5-exit-journey.spec.ts`                                                                                                                                                                                                                           |
| SV-T11  | A retained when staging B; no empty/unconfirmed keys; schema-first; A-only jump; exact counts/sample truncation; stale rerun                                                                     | Diff tests; `diff-panel.spec.ts`, `m6-exit-journey.spec.ts`                                                                                                                                                                                                                                                                           |
| SV-T12  | Ordered-list semantics/node order unchanged; real statuses/gate refusal; downstream not falsely executed; preview/lineage retained                                                               | `pipeline/PipelinePanel.test.tsx`, `pipeline/pipeline-model.test.ts`; `pipeline-panel-journey.spec.ts`, `pipeline-panel-gate-journey.spec.ts`, `pipeline-gate-journey.spec.ts`                                                                                                                                                        |
| SV-T13  | Both schemes + viewport/zoom matrix; keyboard focus visible; mode-aware shortcuts, dialog trap/Escape/return focus; AA/axe unchanged                                                             | `theme-contrast.test.ts`, `design-tokens.test.ts`; `a11y.spec.ts`, `a11y-keyboard.spec.ts`, `theme.spec.ts`, `record-keyboard.spec.ts`; new Help browser suite                                                                                                                                                                        |
| SV-T14  | Adversarial remount/session replacement/late completion and busy rejection; static recovery retains work, no hidden query/derive replay                                                          | App lifecycle/boundary/session tests; targeted browser races where reproducible; document component-only evidence explicitly                                                                                                                                                                                                          |
| SV-T15  | Same proven fixtures/raw files across supported surfaces; source integrity and report/CLI agreement retained; setup/help flags valid                                                             | `m4-exit-journey.spec.ts`, `m5-exit-journey.spec.ts`, `m6-exit-journey.spec.ts`; existing CLI/VS Code harness only when affected                                                                                                                                                                                                      |
| SV-T16  | Stock endpoint-free build; configured disclosure safely aborted before navigation; no new events/content leakage; restored stock rerun                                                           | `telemetry.spec.ts`; isolated `tests/visual/playwright.telemetry.config.ts`; existing telemetry component tests                                                                                                                                                                                                                       |
| SV-T17  | Exact canonical artifact inspected without extra derivation; separate generation/delivery states; ownership/reset/absent-section/byte proofs                                                     | `pipeline/dcr-export.test.ts`, `PipelinePanel.test.tsx`, pipeline state/session tests; `pipeline-dcr-export.spec.ts`; canonical fixture                                                                                                                                                                                               |
| SV-T18  | Dirty replacement Stay/export/cancel/failure/discard flows preserve accepted overlay; no premature invalidation/parallel prompt; draft rule pinned                                               | App open/lifecycle/history tests; new dirty-replacement browser suite after SV-D03 approval                                                                                                                                                                                                                                           |

Test path prefixes: component tests under `apps/web/src/`; browser suites under `tests/e2e/` unless explicitly marked `tests/visual/`. Use actual current file names at dispatch; never silently skip a missing test.

## 7. Non-goals and STOP conditions

**Phase A non-goals:** engine/client/grid protocols, contract/diff/DCR bytes, logical-row semantics, new file formats/codecs/dependencies, persistent workspaces/queries, subset export, bulk editing, structural shell relocation, resizable SQL, overlay profiling, hosted auth/review/policy services, AI/provider calls, graph authoring, ecosystem runtimes, publication/collector deployment/billing/force-push.

STOP and leave the task open if:

- SVG guidance conflicts with an ADR, exact existing copy or a current decision; report the precise conflict.
- A display label needs unavailable result-snapshot data; conservatively label unknown scope or propose an explicitly bounded state addition before implementing it.
- An apparently visual change needs engine execution/serialization/format behavior changes, shared-package imports or a migration.
- Clean baseline, toolchain, approved scope, required gate or independent reviewer is unavailable. Do not lower thresholds, replace real integration with stubs, silently retry away failures or announce completion.
- You must edit files outside the reserved task boundary. Request an orchestrator split/amendment first.

No runtime change was made while authoring this specification. Implementation evidence belongs in the map, not in the SVGs or this document's status banner.
