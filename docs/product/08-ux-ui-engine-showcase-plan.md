# Assay UX/UI and Engine Showcase Plan

**Status: proposal, 2026-10-26.** This is a design and investigation companion to the
[usability queue](../process/handoff/20261026-usability-queue.md), not a replacement queue or
implementation authorization. No ug row was claimed or completed during this investigation.
The MVP is complete; this work improves its presentation and usability, not its feature scope.

**Execution companion (authored subsequently):** use the
[implementation spec](09-ux-ui-implementation-spec.md),
[visual execution queue](../process/handoff/20261026-ux-ui-execution-queue.md) and
[pickup prompts](../process/handoff/20261026-ux-ui-pickup-prompts.md) for current requirements,
scopes and readiness. The ug queue now records the ug-1/ug-7 clarifications and ug-10 decision
block. The proposal language below is rationale, not a competing live dispatch instruction.

**Implementation status (2026-11-03):** all 23 usability rows are CLOSED and merged-verified — the
Grid, Panels and Shell lanes are complete, with ug-21 (opening progress + cancel) at `8458ad1`,
ug-22 (sticky-nav reading order, no DOM reorder) at `e73dda4` and ug-23 (the four code-observation
riders) at `07a37d4`. The visual lane is under way: **uxv-1 (R-09) is CLOSED at `d85dec2`** (a defined
scheme-aware surface for the Settings dialog and telemetry disclosure, with the configured-disclosure
leg proven against an endpoint-bearing bundle) **uxv-2 (R-10) at `b487788`** (bounded token layer and
named-control adoption, exactly two accent primaries, no bare element selector) **uxv-3 (R-11) at
`cd4fb3f`** (fluid canvas to the measured 1024/1440/1920 matrix, compact header, measured 420/620/640
grid viewport) and **uxv-4 (R-12) at `6457113`** (the static idle engine line and note) and **uxv-5 (R-13) at
`e3ae857`** (the [rehearsal pack](10-ux-ui-demo-rehearsal.md)), so **every runtime row in the visual
queue is closed**; uxv-6 is design-only and deferred behind a maintainer decision. This note updates status only; the rationale and wave plan below are
unchanged.

## 1. Recommendation

**Make the engine's strengths observable through a coherent workflow, not a wall of technical
claims.** Preserve the accepted grid-centric workbench. Repair invisible outcomes and destructive
recovery first, introduce a useful first-run experience, then apply a consistent visual system.

The product story is **local file → inspect → understand → verify → repair → export a copy →
compare**. Nested exploration and visible generated SQL distinguish Assay from a generic file
viewer. Immutable-source editing, deterministic contracts, and cross-surface report agreement
make the workflow trustworthy.

Do not turn the workbench into a marketing landing page, add an AI/chat sidebar, or start a new
engine track to improve the demo.

## 2. Investigation and evidence

Three read-only scouts ran on **`openai-codex/gpt-6-luna`, thinking `xhigh`**, covering shell/first
run, panel recovery/journeys, and visual design/engine differentiation. The parent independently
read the relevant source and exercised unmodified source at `aded6d7` using Chromium/Playwright
against Vite dev. Viewports: 900×900, 1024×700, 1440×900, 1920×1080; light and selected dark states.
This was an exploratory browser probe, **not** a production-build gate run or full accessibility
certification. No six-gate baseline was established, and none is implied by these observations.

Ephemeral screenshots, measurements, and axe output from this session are in
`/tmp/assay-ux-investigation/`; the probe is `/tmp/assay-ux-probe.mjs`. These are local evidence,
not committed test fixtures. Reproduce the observations through the steps below if absent.
Line references describe the inspected revision and may move as queue work lands.

| Observation                                     | Independently checked evidence                                                                                                                                                                                                                                                         | Consequence                                                                                |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **An action succeeds invisibly.**               | Open `fixtures/jsonl/nested.jsonl` without expanding tools; click the `tags` header's Explode action. SQL reaches `done` with **20 result rows**, while its toggle remains `aria-expanded="false"` and its panel is invisible. `App.tsx:566–579` sets the request without opening SQL. | ug-1 is the first trust repair.                                                            |
| **The existing journey masks that defect.**     | `tests/e2e/nested-journey.spec.ts:98–101` calls the shared opener; `support/fixtures.ts:25–32,89–91` defaults to expanding every section.                                                                                                                                              | New acceptance must start from real collapsed defaults.                                    |
| **First run addresses maintainers.**            | Idle browser text contains M0–M6, PT-0, G0, D12 and `docs/process/handoff.md`; `App.tsx:1160–1170`.                                                                                                                                                                                    | Replace internal status with a user contract, formats and an obvious action.               |
| **Wide-screen space is wasted.**                | At both 1440px and 1920px, measured main width is **1152px**, tool pane **360px**, grid section **776px**. `index.css:183–184,380–383` caps the main and pane widths.                                                                                                                  | A fluid desktop canvas can materially improve the demo without changing data flow.         |
| **Minimum-height first paint is crowded.**      | At 1024×700, the grid section starts at y≈212 and is ≈567px high; its bottom extends below the viewport.                                                                                                                                                                               | Compact the header and evaluate a bounded viewport-relative grid height; retain scrolling. |
| **SQL is revealed into a narrow working area.** | After manually opening SQL at 1440px, its editor and result table occupy the left pane beside the unchanged grid.                                                                                                                                                                      | ug-1 repairs visibility, not result ergonomics. Wider SQL needs a separate layout review.  |
| **Dark Settings has a real contrast defect.**   | Open Settings with dark preference. Computed surface is white, text is `#e8eaed`; axe reports **1.2:1**, serious `color-contrast`, for title and option label. `index.css:1843–1850` references undefined `--color-surface-panel` with `#fff` fallback.                                | New bounded theme-completeness task; inspect disclosure too, which uses the same rule.     |
| **Revealed SQL has a keyboard-scroll gap.**     | Run Explode, reveal SQL, then axe-scan in dark mode: serious `scrollable-region-focusable` on `.sql-result`. `SqlPanel.tsx:285–312` creates a scroll container with no focus target.                                                                                                   | Coordinate with ug-1's result-focus requirement; pin scrollability and both schemes.       |
| **Panel failures are not contained.**           | `ErrorBoundary.tsx:18–92` has only app/grid scopes and reload; `App.tsx:938–1141` leaves tool bodies unwrapped. App owns session hooks above those bodies.                                                                                                                             | ug-7 should remount a failed panel, not restart the dataset session.                       |

Sources are relative to `apps/web/src/` unless qualified. These supplement the
[existing 37-finding review](../reviews/2026-10-26-usability-gap-review.md); do not renumber its
findings or duplicate queue ownership.

## 3. Engine strengths → useful interface evidence

| Real capability                                                           | What the user should see                                                                                                                                                                                            | Honesty boundary                                                                                                                                 |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| DuckDB-WASM in a Web Worker; Arrow IPC batches; windowed virtualized grid | A concise explanatory line such as **“Powered by DuckDB-WASM · local query execution”**, with optional static explanation of worker/Arrow/windowed rendering. Keep the grid responsive during supported operations. | The line is explanatory, not a live readiness indicator. Do not invent a live engine badge, memory meter, streaming guarantee, or new telemetry. |
| Nested schema and pure Flatten/Explode/path SQL composition               | One click reveals the generated SQL **and its result**, with a clear note that this is a separate query result.                                                                                                     | Does not reshape or edit the main grid. Displayed SQL is reproducible; that does not promise a saved recipe.                                     |
| Session overlay over immutable source                                     | Visible staged-change count, readable History, standing copy that export writes a copy.                                                                                                                             | Session edits are not saved to the opened file or visible to the CLI. A reset/reload can lose them.                                              |
| Deterministic contract compilation and validation                         | Starter-contract guidance, failing-rule summaries, jump-to-row, stale/fresh state around repairs.                                                                                                                   | Do not imply arbitrary scripts, AI repair, or that stale results are current.                                                                    |
| Staged schema/profile/confirmed-key row comparison                        | Schema signals first; explicitly confirmed keys; inspectable findings and exportable report.                                                                                                                        | Do not silently infer-and-run keys or promise exact row identity without the existing disclosures.                                               |
| Shared validation/diff logic across browser, desktop VS Code and CLI      | A short demo connecting exported/raw datasets and contracts to the existing CLI agreement journeys.                                                                                                                 | CLI uses the native Node DuckDB seam, not WASM, and cannot see an unexported browser overlay.                                                    |

Runtime evidence: `packages/engine-duckdb/README.md`, `src/client.ts:310–410`,
`src/worker-core.ts:118–187`; UI adaptation: `apps/web/src/grid/provider.ts:71–125,160–230`.
Cross-surface evidence: `tests/e2e/m5-exit-journey.spec.ts:288–500` and
`m6-exit-journey.spec.ts:812–863`. Use their exact fixture/report conditions for agreement claims.

**Privacy copy:** “Dataset contents are processed locally” is preferable to “Nothing leaves your
machine.” Keep the existing usage-metadata disclosure and opt-out available. See
[telemetry disclosure](../telemetry-disclosure.md). Advertise only **.parquet, .csv, .jsonl, .json**
as inputs; Arrow IPC export/internal transport does not mean Arrow/Feather input is supported.

## 4. Proposed experience

### First run: immediately understandable

```text
Assay                                                Settings
The local-first data workbench

Inspect, query, validate, compare, and repair local datasets.
Opens .parquet · .csv · .jsonl · .json

[ Open a data file… ]   [ Try with example data ]
Dataset contents are processed locally. Edits are staged; export writes a copy.

Powered by DuckDB-WASM · local query execution
```

ug-2 owns the capability sentence, formats and picker hints. ug-3 owns the example button.
Overlay reassurance and engine explanation are proposed follow-ups, **not extra ug-2 acceptance**.
Keep onboarding specific to idle: opening, cancellation and failure need their own useful states,
not the same welcome text repeated under an error.

Start with **one existing synthetic example**, not a sample gallery. Recommended for ug-3:
`fixtures/jsonl/nested.jsonl`, already demonstrated by the existing nested journey. It exposes
STRUCT/LIST exploration and generates an observable SQL result quickly. The queue permits an
existing synthetic fixture or equivalent bundled asset. Bundle deliberately; do not fetch a
repository-relative fixture URL at runtime or author new user-like data.

Validation/repair/comparison demonstrations can use a separate existing acceptance fixture set;
do not imply that the nested sample includes a ready-made contract and comparison partner.
Public demo-data curation/approval remains the human launch task recorded in the roadmap.

### Ready state: data first, guidance beside it

```text
Assay   [ Open a data file… ]   Dataset · N rows · M columns     Settings
─────────────────────────────────────────────────────────────────────
Tool pane                            Persistent grid
Existing section navigation          Clear focus, row identity, staged markers
Schema / existing tool sections      Interaction hint and honest busy state
Purpose text and current summaries   Filter state / keyboard help
                                     Record inspector dock
```

This is a visual hierarchy sketch, **not a new DOM or navigation order**. Apply purpose text and
summaries inside existing section shells (ug-13/ug-17), using the queue's nav-array-only change
for ug-22. Do not replace the workbench with tabs that unmount sessions or duplicate Undo/Redo.

Show advanced capability progressively: a concise collapsed purpose/state, an explicit action,
and an inspectable outcome. Keep technical explanation available without filling first paint
with engine internals, pipeline acronyms or benchmark claims.

## 5. Visual direction: quiet, precise, data-dense

Reuse the current neutral surfaces, restrained blue accent, explicit NULL styling, tabular
numerals and amber staged-edit markers. The needed change is consistency and hierarchy, not
brand reinvention or a decorative dashboard.

| Area          | Proposed treatment                                                                                                                        | Guardrail                                                                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Type          | UI text 14–16px; readable 12–13px secondary metadata; 18–20px panel/page hierarchy as appropriate. Monospace for SQL/types/data metadata. | Never shrink essential instructions to fit. Keep existing accessible heading names/levels. Use system/local fonts; no third-party font requests. |
| Spacing       | Shared 4/8/12/16/24/32px scale; consistent heading-to-body and panel gaps.                                                                | Tokenize incrementally rather than rewrite the entire stylesheet.                                                                                |
| Controls      | Consistent input/button typography, 30–32px compact controls and 36px primary CTA; clear primary/secondary/danger/disabled states.        | Do not apply one oversized global button style to grid/header controls. Retain keyboard target and focus affordances.                            |
| Surfaces      | One page canvas, a distinguishable tool surface, quieter nested content, consistent borders and 4–8px radii.                              | Avoid borders inside borders and new card wrappers around every paragraph. No raw light-mode fallbacks.                                          |
| Desktop frame | Compact masthead; fluid main width on wide screens, retaining the accepted two-pane split and bounded tool width initially.               | CSS-only width work must retain grid scroll ownership, virtualization, memo boundaries and 1024×700 support.                                     |
| Data canvas   | Preserve 28px data rows initially; evaluate a viewport-relative scroll height with a safe minimum.                                        | The JS virtualizer estimates 28px (`DataGrid.tsx:17–19`); CSS row-height changes alone would desynchronize geometry.                             |
| State         | Text-plus-color labels for pending, stale, running, failed and complete; readable empty states.                                           | Do not use badges that imply persisted edits or total SQL row counts when only a page is known.                                                  |
| Keyboard      | Explicit focus rings, focusable scroll regions, discoverable edit/inspect shortcuts.                                                      | No hover-only essential actions; no color-only state; preserve reduced-motion preferences if motion is introduced.                               |

Candidate desktop geometry for a design review (targets, not observed results): at 1440px,
24px outer gutters give a 1392px main with a 360px pane, 16px gap and 1016px grid column; at
1920px the same rules give a 1496px grid column. At 1024px, 16px gutters and a 320px pane leave
656px for the grid column. These bounds stay within the existing pane-width direction. Target
a compact header of approximately 120–140px before the workspace, then evaluate a grid scroll
height bounded between 280px and 640px using the remaining viewport height, reserving space
for its heading/footer. Validate the formula with real content and zoom before fixing it in CSS;
keep internal horizontal scrolling for wide schemas and never force the page into hidden overflow.

**SQL ergonomics is a separate proposal.** A fluid main alone widens the grid but leaves SQL in
the ≈360px pane. Evaluate a keyboard-accessible adjustable pane on sufficiently wide desktops,
while retaining a useful grid width and the current 1024px default. The shell spec currently
calls for ≈320–360px: agree a bounded spec amendment before implementation. Relocating SQL into
the center, adding a new result workspace, or changing DOM order is **not** authorized by this
plan or ug-1. Do not delay the visibility fix for that decision.

## 6. Delivery plan and ownership

Preserve each lane's existing order. The waves below describe product outcomes, not permission
to skip predecessor tasks. Every implementation dispatch still owns exactly one queue row.

### Wave A — repair trust and first impression

1. Establish and record the queue-required **clean-main six-gate baseline**.
2. Start Shell **ug-1 first**. After it lands, run **ug-2** and Panels **ug-7** in parallel;
   then continue ug-3 and ug-8 in their respective lanes. Grid can start **ug-4** independently.
3. Add the newly verified theme-completeness fix as a separately scoped candidate; do not hide
   it in ug-2 or silently expand ug-19. Coordinate CSS ownership before claiming it.

**ug-1 implementation brief refinements:**

- Test the `tags` **LIST** header's Explode and/or `meta` STRUCT's Flatten. The queue's phrase
  “Explode on the fixture STRUCT header” conflates the two actions; correct the brief, not
  the type system. The actual Explode fixture yields 20 rows and page range `rows 1–20`.
- Reveal via existing section state, ensure the tool pane itself is expanded if it was a rail,
  scroll the relevant container, and focus a usable result/status target after rendering.
- Include keyboard-operable scrolling of the SQL result; its focusability is also an existing
  axe gap. Handle empty results and execution errors without focusing a missing table.
- Composition rejection retains its existing error path and does not open unrelated sections.
  A composed query that fails execution should reveal its SQL error.
- Start tests with `expandSections: false`; cover both schema-tree and grid-header origins,
  including a grid-header action with the pane collapsed to a rail. Assert the active focus
  target and relevant scroll-container visibility, not only section expansion. Do not add engine
  count queries: page length/range is not an arbitrary-query total.

**ug-7 implementation brief refinements:**

- Keep App-owned dataset/history/session hooks outside boundaries. Retry remounts only the
  failed panel/grid; it must not call `beginSession()` or reopen the file. Panel-local state can
  reset and a persistent fault can recur. Grid remount can lose an uncommitted cell draft,
  focus and scroll position even though committed staged changes/history survive. Name that
  distinction in recovery copy. Reload is the separate loss-bearing action, with warning visible
  before the click.
- Test a panel crash with nonzero pending changes: grid, staged count and History survive.
  Retry and close/reopen must be keyboard reachable, including Schema/Filters/Profile, whose
  inner disclosure controls disappear if their panel throws. Proposed seam: managed sections
  use existing open state; inner sections gain a recovery-only shell visibility override, cleared
  by their existing nav link and on a new dataset. Close moves focus to that nav link. Reopening
  exposes the retained fallback and its explicit Try again action; it does not silently retry.
  This keeps ordinary inner controls unchanged, avoids duplicate normal toggles, and preserves
  mounted-body semantics. Confirm the seam in the worker brief; if it requires wider ownership,
  split a prerequisite rather than ship a nonfunctional Close action.
- SQL's `runRequest` mount effect (`SqlPanel.tsx:170–174`) can replay a retained request after
  remount. Define request consumption/recovery explicitly and test it; retry must not silently
  repeat an already-consumed nested action. If that needs a wider seam than ug-7 allows, STOP
  and split the prerequisite rather than changing the engine or weakening recovery claims.
- Keep static fallback/no-interpolation pins; do not repeat the root fallback's overly broad
  “Nothing was sent anywhere” claim, since operational telemetry is permitted. Mutation drills
  must kill removal of reset and removal of a panel boundary. Error boundaries do not replace
  async/event-error handling.

### Wave B — make the working loop discoverable

Continue existing lane order: grid editing/clipboard/history/focus/row identity; Shell purpose
and state summaries; Panels validation/profile/pipeline continuity. Highest-value outcomes are
ug-4/6, ug-8, ug-12/13, ug-17 and ug-20, **subject to their lane predecessors**.

Two honesty issues need explicit worker attention:

- **ug-10 — resolved 2026-10-30 by UX-D1 Option C:** current profiling reads the file as opened,
  not the effective overlay, so the original overlay-stale → re-run contract was misleading. The
  ruling ships a clearly labeled file-as-opened profile (R-16: standing hint + staged-changes
  note; no stale/re-run banner and no claim that re-running includes edits) and does **not** clear
  any overlay-mismatch warning by recomputing the same base view. Effective-overlay profiling is
  chartered separately as a planning-only engine candidate
  ([20261030-overlay-profile-candidate.md](../process/handoff/20261030-overlay-profile-candidate.md)),
  outside this batch's no-engine-change constraint; it is not authorized for dispatch.
- **ug-9:** the ready phase does not retain the opened `File`; pipeline binding currently opens
  a picker. “Use the open dataset” needs a real session-source seam, not a label-only shortcut.
  A Validation cross-link must not imply that an unrelated bound pipeline source is the grid.

### Wave C — visual consistency and showcase readiness

The following table preserves the proposal rationale. These candidates now have bounded owners
in the [live uxv queue](../process/handoff/20261026-ux-ui-execution-queue.md); dispatch only from
that queue and the implementation spec. **Do not author duplicate rows.** No implementation row
is claimed and no new architectural choice is approved by this rationale table.

| Candidate            | Scope                                                                                                          | Done when / dependencies                                                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Theme completeness   | Existing telemetry surface token usage; focused `theme.spec.ts`/axe coverage.                                  | Settings readable in light/dark; disclosure driven with a configured test runtime; ≥4.5:1 normal text, no new axe allowlist. Coordinate with ug-19 CSS.                                |
| Visual foundation    | `index.css` semantic spacing/type/control/surface tokens, followed by scoped component-class adoption.         | Review idle, ready, error and export at the viewport matrix; consistent controls, no clipping or lost focus. Serialize CSS work with ug-12/19 and affected panel owners.               |
| Desktop canvas       | Fluid main width, compact header and bounded grid height; no new pane model.                                   | More data area at 1440/1920; useful first paint at 1024×700; no document horizontal overflow; grid virtualization/horizontal-scroll and memo pins remain green. Shell/CSS lanes quiet. |
| Engine explanation   | Static, value-free “Powered by…” explanation in existing idle/help space.                                      | Every claim maps to current runtime code; no fabricated readiness/performance/live metrics; no telemetry added. After ug-2/3 copy settles.                                             |
| Demo rehearsal pack  | Documentation plus existing synthetic assets/contracts; walkthrough of nested and verify/repair/compare loops. | Rehearsed on built output; raw-file vs overlay and web vs CLI boundaries stated; no new public dataset or publication approval implied.                                                |
| SQL workspace sizing | A design spike/spec amendment for adjustable pane bounds, not implementation in ug-1.                          | Agree minimum grid width, keyboard resizing, reset behavior and dual-layout review before authoring a code task.                                                                       |

## 7. Showcase script

Use two short, honest chapters rather than claim one fixture proves every capability.

1. **Explore nested data:** cold start → bundled synthetic example → schema/record inspection →
   Explode → visible generated SQL and result page. Explain worker-backed local computation and
   windowed rendering briefly; do not lead with an architecture lecture.
2. **From finding to reviewable change:** existing acceptance dataset/contract → validate → jump
   to failure → stage a repair → observe stale then revalidated verdict → History/undo → export
   a copy → compare using explicitly confirmed keys. Explain whether comparison inputs are the
   effective overlay or reopened exported files; use the corresponding proven fixture journey.
   **Chapter 2 continuity:** include the matching raw-file/contract CLI validation case and a
   proven browser/CLI diff report case. Exported edits become a new CLI input; unsaved browser
   edits do not magically appear there. Desktop VS Code is an optional continuation, not a
   browser-runtime equivalence claim. The M5/M6 helpers generate per-run temporary synthetic
   datasets/contracts; cite their generator paths and reproducible commands, not nonexistent
   committed dataset paths. See implementation spec §5. The M6 pair is a separate proven example,
   not automatically the M5 repaired export.

Large-file footage is a separate deliberate benchmark/demo setup, not the bundled example.
Historical benchmark evidence exists in
[the M1 benchmark record](../engineering/05-m1-benchmarks.md), but do not promote its numbers as
current cross-browser guarantees without a fresh, documented reproduction.

## 8. Acceptance, review and execution protocol

- **Precondition:** clean `main`, then format, lint, typecheck, unit, build and e2e gates per
  [operating-model §7.6](../process/handoff/operating-model.md). Preserve coverage floors; run
  affected harnesses and docs checks where required. Local green is not remote CI green.
- **Dispatch:** worker → independent reviewer → orchestrator integration, one bounded row per
  dispatch, changeset/Conventional Commit as required. The research roster does not silently
  replace the standing implementation/reviewer roster. Parallel lanes use isolated worktrees
  and ports; ug-1 and ug-7 both touch `App.tsx`, so integration must inspect the shared seam.
- **Visual matrix:** 1024×700 supported minimum, 1440×900, 1920×1080; retain the 900px scrolling
  fallback. Light and dark; empty, opening, open error, ready, SQL result/error, staged edit,
  validation stale/failure, panel crash and export. Use fixed synthetic fixtures and screenshots
  for review, not brittle pixel-perfect CI gates.
- **Accessibility:** dual-scheme axe with no allowlist additions; keyboard-only open → action →
  outcome → edit/recover/export; visible focus, scrollable results and useful announcements.
  Preserve the current heading map and DOM order. No duplicate Undo/Redo controls.
- **Behavior:** no engine/client/filter grammar or grid-model protocol changes. Preserve source
  immutability, export/report byte contracts and stale-session guards. New wrappers must not
  cause unnecessary grid remounts, queries or render-count regressions.
- **Usability rehearsal:** ask a new evaluator to open the example, find a nested result, stage
  an edit, explain whether the source changed, and export a copy without coaching. Record
  task completion/confusion locally; no dataset-bearing telemetry or new tracking events.

**Recommended next action:** establish the baseline, dispatch ug-1 first, then ug-2 and Panels
ug-7 in isolated worktrees. Dispatch subsequent visual work from the authored uxv queue and
implementation spec, with their prerequisites and decision blocks. This plan
changes no accepted ADR, release gate, publication boundary, or existing queue completion state.
