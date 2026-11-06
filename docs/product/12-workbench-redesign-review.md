# Workbench plan review — stack fit and task-led redesign

**Reviewed:** 2026-11-04 against source `bba491a` plus the uncommitted SVG/specification pack. **Outcome:** the existing stack is suitable; revise the UX approach and several state assumptions before runtime dispatch. This is a source/design review, not a fresh application acceptance run, usability-study result, implementation approval or accepted architectural change.

The user explicitly opened **larger redesign options** for consideration. Do not interpret that as a requirement to keep every existing layout choice—or as blanket authority to rewrite engines, change ADRs or ship future tracks.

**Read with:** [live implementation map](../process/handoff/20261104-svg-implementation-map.md), [conservative Phase A specification](11-svg-implementation-spec.md), [pickup prompts](../process/handoff/20261104-svg-pickup-prompts.md), [SVG capability inventory](../../assests/svg/README.md). This document owns redesign requirements **RD-R01…RD-R08** and acceptance contracts **RD-T01…RD-T08**. The map owns task/decision status. Neither route is authorized for runtime until explicitly selected.

## 1. Review conclusion

**Recommend a bounded, task-led redesign of the web workbench, delivered by vertical slices on the current stack.** First compare and validate the navigation/workflow structure; then implement the most revealing repair-and-recheck journey. Do not first spend a full release polishing every panel or adding a large Help guide.

Keep the conservative `sv-*` Phase A route as a lower-risk fallback if prototype evidence or maintainer preference supports it. It is **not** a prerequisite for the redesign route. Do not run both task tracks over the same surface.

| Option                                        | Benefit                                                                             | Cost / risk                                                                                             | Recommendation                                                 |
| --------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| A — incremental refresh (`sv-0…sv-7`)         | Small visual/state-caption deltas; mostly existing composition                      | Can preserve capability-list overload and context switching; Help may explain rather than fix friction  | Retain as explicit fallback, not presumed best UX              |
| B — task-led workbench redesign (`rd-0…rd-7`) | Reorganize discoverability, focus and next-step flow; existing data services reused | Requires prototype/user evidence, explicit layout/copy decisions and careful state-preserving migration | **Preferred design direction to validate**                     |
| C — new framework/engine/grid rewrite         | Could support a genuinely different future product                                  | High regression/migration cost; no reviewed evidence that current stack is the limiting factor          | Do not choose without a separately demonstrated technical need |

Larger UI change is welcome when it removes demonstrated friction. Its size alone is not a benefit. Choose B only after the design checkpoint; no framework/library migration is needed to explore it.

## 2. Findings and corrections

| Finding                                                | Evidence / risk                                                                                                                    | Required plan correction                                                                                                                     |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Layout was over-preserved                              | Prior SV-R02 froze widths/order/control patterns; the original task chain primarily restyled existing panels                       | Separate immutable data guarantees from revisitable UI decisions; add a design-selection path before restyling                               |
| Help was made an early dependency                      | Prior sv-2 preceded every caption/filter/check/pipeline row                                                                        | Make primary tasks discoverable in the workspace; Help is secondary reference, not a prerequisite for every feature                          |
| No direct proof of intuitive use                       | Automated matrix was extensive, but no user task-completion criterion                                                              | Baseline and test realistic journeys before/after; record wrong turns, Help dependence and safety misunderstandings                          |
| Run origin was inferred from insufficient state        | `ValidationRunState` has report + revision, not captured operation-origin metadata; `useValidationSession` stores the run revision | Use neutral snapshot wording or explicitly add app-session metadata captured with the actual run. Revision means freshness, not changed data |
| Operation count was treated as a changed-data signal   | `HistoryPanel` exposes applied/no-op/conflict outcomes; active operation prefixes can contain no-ops                               | Label **staged operations**, not changed rows or byte differences. Prefer **Current dataset view** / **Whole current dataset**               |
| Draft comparison overclaimed semantics                 | `FilterBar` uses input strings and `FilterSpec[]`, including a raw SQL-predicate escape hatch                                      | Indicate changed/unapplied **inputs**, not general SQL semantic inequality                                                                   |
| Failed-input retention was accidentally a new behavior | `FilterBar.applyList` currently restores accepted filters and reseeds drafts on failure; double rollback failure has distinct copy | Preserve that behavior by default. A retained failed-input buffer is a separately specified UX/state change, not styling                     |
| Dialogs do not share one implementation                | Telemetry disclosure uses native `showModal`; dataset Export uses a custom role-dialog/focus trap and cannot close while writing   | Explicit app-local focus/ownership arbitration; no nested active modal, no implicit Export migration in a Help row                           |
| Resource conflicts looked like functional dependencies | App/CSS overlap requires serial writers, but quality/pipeline display does not inherently depend on global Help                    | Record true prerequisites separately from the one-writer scheduling rule                                                                     |

These corrections apply to **both** routes. Original SVG labels are illustrative; corrected source-backed wording/state contracts govern implementation, not a literal copy of a badge.

## 3. Actual stack and reuse map

| Existing asset                                                                                                                                                                                                                                                                       | Keep / reuse                                                                               | Redesign boundary                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| React + TypeScript + Vite in [web package](../../apps/web/package.json)                                                                                                                                                                                                              | Current build/runtime and strict types                                                     | New app-local presentation components; no Next.js/server rewrite, router or global store by default                                           |
| [App composition root](../../apps/web/src/App.tsx)                                                                                                                                                                                                                                   | Dataset/session lifetime, section reveal, request ownership and existing hook integration  | Extract controlled layout/presentation seams incrementally, not a second app controller                                                       |
| [Editing session](../../apps/web/src/sessions/useEditingSession.ts), [validation session](../../apps/web/src/sessions/useValidationSession.ts), [diff session](../../apps/web/src/sessions/useDiffSession.ts), [pipeline session](../../apps/web/src/pipeline/usePipelineSession.ts) | Authoritative data work, snapshot/freshness, pending gates, cancellation/generation checks | Task switching changes visibility/focus, not hook lifetime or engine ownership. Bounded presentation metadata may be added explicitly         |
| [Grid renderer](../../apps/web/src/grid/DataGrid.tsx), `@tanstack/react-virtual`, portable `@assay/grid`                                                                                                                                                                             | Virtualization, logical identity, keyboard/editor interaction and provider contracts       | No replacement table library, full-row materialization, changed row estimate or duplicate mounted grid                                        |
| [Real engine](../../packages/engine-duckdb/src/client.ts), DuckDB-WASM worker, Arrow transport                                                                                                                                                                                       | Existing client/worker and registry/query behavior                                         | No new worker per task. `packages/engine`'s retained target interface is not the runtime API to reimplement                                   |
| [Existing CSS](../../apps/web/src/index.css)                                                                                                                                                                                                                                         | Semantic tokens, both schemes, typography/focus/NULL/error meaning                         | Compose app-local components/styles; token changes only for evidenced need. Do not blindly replace the stylesheet                             |
| Contracts / validation / diff / pipeline domain packages                                                                                                                                                                                                                             | Portable parsers/plans/IR/canonical bytes and deterministic checks                         | UI consumes existing APIs; no React/browser imports into pure packages, no app imports from packages                                          |
| Scaffold `ui/core/transforms/ai/security` packages                                                                                                                                                                                                                                   | Their current scope and dependency direction                                               | Do not move UI there merely to appear architecturally tidy. Extract only when real second-surface reuse is demonstrated and separately scoped |
| Vitest + Testing Library/happy-dom; Playwright + axe                                                                                                                                                                                                                                 | Component logic, real browser lifecycle, source/CLI agreement and keyboard/a11y proof      | New layout requires migrated behavioral/geometry assertions, not deletion of tests or screenshot-only proof                                   |
| CLI Node seam / desktop VS Code webview                                                                                                                                                                                                                                              | Current independent surface implementations and canonical semantic agreement               | Web redesign does not force React into the extension or change raw-file CLI semantics                                                         |

Potential new app-local files such as `workbench/WorkbenchLayout.tsx`, `TaskNavigation.tsx`, `DatasetContextBar.tsx` and `sessions/view-snapshot.ts` are **proposed seams**, not existing APIs or mandated filenames. Do not add a new state-management/design-system dependency unless an approved technical comparison establishes a need, license compatibility and migration cost.

## 4. Desired experience: fewer decisions, clearer consequences

### RD-R01 — Organize around user goals, not a wall of equal-weight panels

Prototype a small task hierarchy while retaining direct expert access:

| Task group  | Existing tools it organizes                  | Expected user outcome                                                 |
| ----------- | -------------------------------------------- | --------------------------------------------------------------------- |
| **Explore** | Fields/schema, filters, record, SQL, profile | Understand what is in the file and investigate a suspicious value     |
| **Check**   | Validation and comparison                    | Find quality issues or explain differences between two versions       |
| **Change**  | Editing, history and export                  | Make a reversible repair, review staged operations and deliver a copy |
| **Prepare** | Local pipeline and local change artifact     | Run deterministic steps and inspect gate/delivery evidence            |

This is a **candidate IA**, not approved copy/DOM. Grid stays a persistent dataset artifact in the ADR-compatible candidate; Record is contextual rather than another competing destination. Show one primary task surface at a time where useful; keep all existing tools reachable. Groups are navigation, not separate datasets or execution sessions. SQL and other expert tools must remain directly discoverable without a setup wizard.

Prototype at least two alternatives: A with improved navigation inside the existing shell; B with a task-focused/contextual composition. If B moves SQL/results into the center or changes pane/dock/minimum-viewport contracts, document the exact decision/ADR changes before runtime. Validate the structure rather than choosing a library first.

**Acceptance:** RD-T01.

### RD-R02 — Make the next useful action visible in context

Priority journey: **contract → validation finding → logical row → typed repair → stale verdict → explicit recheck → reviewed copy**.

- Present the current task and a clear return path; relevant row/field focus persists when switching tools.
- A failure offers its existing row jump and, when eligible, a clearly scoped failure filter. A repair surfaces the need to recheck without automatically running expensive work.
- Stale findings remain readable with explicit rerun. Comparison exposes A/B orientation and key-confirmation state before row findings.
- Export describes the whole effective dataset, staged-operation count and destination restrictions at the point of delivery; it is not a filter/subset export.
- Explain unavailable actions beside the action. Use progressive disclosure for technical detail, not for hiding every essential next step.
- Help/setup/shortcut reference is secondary. Core study tasks must be completable without opening a six-topic Help dialog.

No new report engine, automatic repair, auto-validation, live profile or implicit publish is required. **Acceptance:** RD-T02.

### RD-R03 — Truthful, economical context and feedback

Prefer a compact dataset/session context bar plus local exceptions over repetitive warnings in every panel. Preserve mandatory exact copy until an explicit copy-contract update is approved.

- **Current dataset view** = the effective base-plus-overlay view. **N staged operations** reports history facts and may include no-ops; it is not proof of changed contents.
- Validation/comparison caption **Checked dataset snapshot** plus fresh/stale is truthful without reconstructing origin. If origin is needed, explicitly capture app-local immutable run metadata at the same synchronous snapshot boundary used for compilation/execution; include session ownership, revision and operation-count-at-run only as needed. Never infer it from current history or nonzero revision, and never claim the count proves changes.
- Profile is **File as opened** with the existing scope hint; SQL is a **result page**, not a dataset total; B is staged separately; export is the **whole current dataset** in natural order.
- Filter draft status means **Unapplied input changes** relative to seeded inputs, including invalid/cleared input. It does not prove semantic inequivalence for arbitrary SQL. Keep accepted chips based on accepted model state.
- Preserve current failed-apply rollback/reseed and double-failure recovery by default. A design choosing draft retention must explicitly describe its separate attempted-input state, lifecycle and tests before coding.
- Status must have text as well as color; announcements remain concise and value-free. No duplicate warnings or per-render announcements merely because panels become visible.

**Acceptance:** RD-T03.

### RD-R04 — Restructure presentation without losing the session

Keep authoritative session hooks outside task-specific presentation lifetimes. Components receive typed props/callbacks; task visibility and last focused target are app-local UI state, not a duplicate engine/report store.

- A task switch must not reopen a file, reboot a worker, discard the overlay/history/filter drafts, rerun SQL/checks, consume a nested action twice or reset B staging.
- Do not conditionally call hooks or key/remount the dataset session by task ID. Hidden work and late outcomes still need the existing sequence/session guards. If panels must remount, first lift the affected draft/request state and prove its lifecycle; do not assume hooks alone preserve local textarea state.
- Presentation extraction must preserve grid/provider identity, logical-row mapping, render-count and viewport fetch behavior. No second hidden engine/grid to simulate switching.
- New run-caption metadata stays in web session types, not domain/wire/report formats; document atomic capture and all reset paths. Do not infer across sessions.
- Test startup, switching while busy, cancel, dataset replacement and local error recovery, not only a settled screen.

**Acceptance:** RD-T04.

### RD-R05 — Accessible focus and deliberate modal ownership

Task navigation must use semantics matching the chosen interaction, a logical heading/reading order, visible focus and a keyboard equivalent. Do not label ordinary anchor navigation as tabs unless the actual tab/tabpanel behavior is implemented.

Prototype light/dark, 1024×700, 1440×900, 1920×1080, 900px narrow scrolling and 200% zoom before settling the shell. Preserve desktop support unless a separate decision expands it. Contrast/axe and screen-reader announcements remain requirements, not optional polish.

For Help if retained: use a native dialog for that new surface; keep existing custom Export focus-trap behavior unchanged unless a distinct migration is approved. App-local ownership must prevent opening Help over Export or the mandatory native disclosure. Required disclosure has priority over pending Help; never dismiss an in-flight export to make room. Closing a modal restores focus only when it does not steal focus from the next active modal/session. Scope any necessary disclosure lifecycle callbacks explicitly without changing telemetry copy, consent, storage or emission. Test all competing-open/close and disconnected-opener paths in a real browser.

**Acceptance:** RD-T05.

### RD-R06 — Match the safety priority to the chosen journey

Consider the replacement-only dirty-session guard as part of the redesign's safety decision, not automatically after an unrelated pipeline-polish phase. It still needs **SV-D03** and the exact pending-cell-draft / Stay / export / discard / cancelled-picker flow. No autosave or tab-close guarantee.

Likewise, optional DCR inspection needs **SV-D02**, retained-artifact bounds and explicit generation-vs-delivery lifetime; it must not become a hosted approval workspace. It can follow the redesign's pipeline slice without first executing conservative Phase A.

The user may choose these enhancements in the rd-2 scope decision; they are not silently authorized by the recommendation. SQL sizing needs **SV-D04**, overlay-aware profile **SV-D05**; neither follows automatically from structural UI freedom. AI/hosted/enterprise/adapters/new formats remain in the existing future register.

**Acceptance:** RD-T06.

### RD-R07 — Measure whether the workflow is actually easier

Use a moderated, synthetic-data study with **5–8 representative participants**, including newcomers and experienced data-tool users where possible. Start with five; agree an expanded sample only if needed. Run baseline and candidate with equivalent tasks and counterbalanced order to reduce learning bias. Keep anonymous aggregate notes local; no new product telemetry, sensitive datasets or recording/upload requirement.

| Journey              | Unprompted task / observation                                                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| J1 — Understand      | Open the example/file, find a nested value and full record, reach the relevant generated SQL outcome; do not tell users which panel to open                          |
| J2 — Repair/check    | Load a supplied contract, locate one failure, repair a scalar, notice stale, explicitly revalidate, review/export; use a known reproducible fixture                  |
| J3 — Compare         | Stage B, review schema context, confirm the supplied/proposed key, explain added/removed/changed and navigate an A-side example                                      |
| J4 — Safety/recovery | Explain original vs overlay, original-file profile vs checked snapshot, whole-dataset export and unsaved session behavior; recover from one cancelled/refused action |

**Provisional design exit criteria, to agree before the study:**

- At least **4 of the first 5** complete each core task without moderator direction; for larger cohorts record both count and denominator and agree the equivalent threshold beforehand.
- **No participant** leaves with a critical misconception about source mutation, export scope, stale checks, profile origin or whether edits/artifacts were saved. Correct the design and retest any critical misunderstanding.
- At least 4/5 identify the useful next action without opening Help. Record wrong turns, repeated scrolling and lost context; compare task success and median time against the same baseline task, not a marketing benchmark.
- Target median ease rating **≥5/7** per core task and no median task-time regression. Prefer at least **20% fewer avoidable tool/scroll round trips** on J2; define/count those events before testing. These are proposed UX targets, not achieved results or statistically powered claims.
- Include a keyboard-only walkthrough and at least one assistive-technology review where available. Automated axe is not a substitute. Document missing participant/AT coverage.

If participants are unavailable, perform a structured heuristic/cognitive walkthrough and mark **human usability evidence missing**. A maintainer may explicitly accept the limitation for a limited implementation pilot; do not label that choice user-validated or make it an automatic public-release pass. Re-test after the first real slice.

**Acceptance:** RD-T07.

### RD-R08 — Migrate by useful slices, with a reversible integration plan

No big-bang `App.tsx`/CSS replacement. First document the chosen IA, exact stable-vs-changing contracts, scope/ownership and rollback points. Then extract the narrow presentation seam needed for the first vertical slice, preserving all existing hooks and engines.

1. **First usable slice:** validation → row → repair → stale → explicit recheck, plus enough existing explore/edit/export navigation to finish J2. Do not prioritize the global Help modal ahead of this journey.
2. **Second slice:** comparison, A/B context and reviewed copy/export continuation; retain semantic agreement with CLI and current source-byte/format tests.
3. **Third slice:** pipeline execution/status/local artifact surfaces with existing runner and delivery. Optional inspector remains a separately approved row.
4. **Finish:** contextual guidance/Help, precise setup/surface continuity, recovery, accessibility, performance and the full journey study.

Each approved slice has independent review, full policy-required gates and fresh merged verification. Define a known-good commit rollback point; no persistent-data migration is introduced. Never switch old/new shells live by remounting a dirty session or leave duplicate mounted grids to support a toggle. Development-only prototype comparison must not become a production testing API/telemetry mechanism.

Record baseline render/query/window counts on fixed synthetic fixtures and compare at each slice: task switching creates **zero extra file opens/worker boots/validation/SQL executions**, no unbounded DOM growth, unchanged logical row targeting, and no material performance regression under a pre-agreed budget. Do not convert historical machine timings into universal limits or silently weaken existing benchmarks.

**Acceptance:** RD-T08 plus all reused data-safety tests from the conservative specification.

## 5. Design authority and decision path

| Proposed change                                                                               | What is preserved / what approval is needed                                                                                                                                |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App-local component extraction, clearer controls, goal grouping within tools-left composition | Can fit ADR 0044; still approve the UI/copy/reading-order contract and migrate named tests deliberately                                                                    |
| Changing nav/section order, conditional task visibility or accessible headings                | Reconcile existing q-15 / original UX copy and heading contracts; record a new UI ruling/spec. Do not merely update snapshots to silence failures                          |
| Center-mounted/resizable SQL, different record dock/pane roles, changed minimum support       | Revisit relevant deferment and ADR 0044. If selected direction conflicts, add a new accepted superseding ADR/ruling before runtime; do not edit/renumber accepted ADR 0044 |
| Captured app-local view/run metadata                                                          | Explicit session-type/file reservation and race/reset tests; no domain/engine/wire/report changes                                                                          |
| New profile execution, formats, edit ops, contract/report semantics or surface parity         | Separate engine/domain/surface work and scope; a UI redesign decision does not authorize it                                                                                |

**SV-D08** in the map selects the route/IA and documents which current contracts are retained or replaced. An approval to explore B is not approval to implement B. `rd-2` must resolve the chosen design, runtime scope, required ADR/UI-copy decisions, participant-evidence limitations and optional **SV-D02/03/04/05** selections before feature dispatch.

## 6. Redesign acceptance matrix

| Test ID    | Requirement / proof                                                                                                                        | Evidence and owner                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| **RD-T01** | RD-R01: both navigation alternatives, complete existing-tool reachability and explicit scope/decision matrix                               | rd-0/rd-1/rd-2; new prototype/wireframes, SVG coverage map and approved IA, no fictional backend                                 |
| **RD-T02** | RD-R02: J2 next-action/return/context flow works through real controls without Help dependency                                             | rd-4; existing validation/edit/history/export and M5 journeys extended deliberately; human task observation                      |
| **RD-T03** | RD-R03: neutral labels; no-op operations and undo-to-base revision cases; draft input vs SQL semantics; rollback + double failure          | Presentation/session and FilterBar tests; existing profile-honesty/filter/export suites; rd-3…rd-6 as affected                   |
| **RD-T04** | RD-R04: switches preserve drafts/history/results/B staging; zero extra engine/file/query work; late completion/remount ownership           | Session/lifecycle/request-consumption/grid render/window pins; rd-3 plus each vertical slice                                     |
| **RD-T05** | RD-R05: keyboard/AT/zoom/schemes/viewports, heading/focus and modal competition/return paths                                               | Existing axe/keyboard/theme/record suites + new task-navigation/native Help cases; configured disclosure and restored stock legs |
| **RD-T06** | RD-R06: selected optional features have actual approvals, scoped lifecycle/state proofs and unchanged data guarantees                      | SV-D02/03/04/05 record; SV-T17/18 only if selected; otherwise explicit unchanged/blocked evidence                                |
| **RD-T07** | RD-R07: observed baseline/candidate task results, denominator, wrong turns, safety/ease/time and limitations, before and after first slice | rd-2/rd-4/rd-7; local anonymized study report; no invented participants or automatic claim of intuitive UX                       |
| **RD-T08** | RD-R08: named migration/rollback points, baseline and per-slice performance, full gates/review/merged semantic/byte agreement              | rd-3…rd-7; map verification protocol plus preserved CLI/export/DCR and grid tests                                                |

These are additional to, not replacements for, the [map's gate and review protocol](../process/handoff/20261104-svg-implementation-map.md#6-verification-and-independent-review). New test filenames are determined from the chosen IA and explicitly reserved in the corresponding brief. No runtime test results or user-study outcomes were produced while writing this review.
