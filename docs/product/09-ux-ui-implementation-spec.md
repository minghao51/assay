# Assay UX/UI Implementation Spec

**Authored 2026-10-26; status refreshed 2026-10-29.** The authoring date records when the
contract was written, not the current implementation state. As of 2026-10-29, R-01…R-08, R-14
and R-15 are implemented and merged-verified; R-09…R-13 remain open (uxv-1 is eligible pending an
exclusive CSS/theme-test reservation); proposed R-16 is not authorized. This is the execution
contract for the bounded improvements requested after the
[investigation plan](08-ux-ui-engine-showcase-plan.md).
The [usability queue](../process/handoff/20261026-usability-queue.md) owns ug tasks; the
[visual queue](../process/handoff/20261026-ux-ui-execution-queue.md) owns uxv tasks and their live
status. Start with the [pickup prompts](../process/handoff/20261026-ux-ui-pickup-prompts.md).

## 1. Authority, scope and readiness

- Accepted ADRs, especially [0044](../adr/0044-workbench-shell-two-pane.md), win. This spec does
  not change the two-pane direction, DOM order, minimum viewport, engine or grid protocols.
- Queues own claims, dependencies and completion evidence. This spec owns the requirement IDs
  below, copy, states and visual constraints. The earlier plan owns rationale/evidence, not
  dispatch status. Resolve a contradiction before starting; do not choose the convenient text.
- The user requested this implementation/handoff pack, not publication or an engine expansion.
  Reference frames express the specified target, **not** an assertion that a human approved
  every pixel. Fidelity is reviewed against the requirements; any architectural deviation stops.
- Implementation requires a fresh clean-main baseline. Existing probe screenshots and historical
  green counts are not that baseline. This spec records requirements, not task completions; §8 is
  the pointer index to implemented rows and their evidence.
- ug-10 remains decision-blocked (§7). Adjustable SQL sizing remains design-only. All other
  requirements are bounded by queue prerequisites and scope; no broad redesign is authorized.

## 2. Requirements and UI states

Requirement IDs are stable. Preserve them in worker briefs and review reports.

| ID / owner   | Requirement / exact text                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Acceptance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-01 / ug-1  | Successful nested actions reveal SQL, expand a collapsed tool pane, scroll the relevant container, and focus the new outcome. Generated SQL remains visible; the main grid remains unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | From collapsed defaults, `tags` LIST Explode yields 20 fixture rows and `rows 1–20`; `meta` STRUCT Flatten yields 12. Cover header and schema origins; no navigation click required.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| R-02 / ug-1  | Outcome focus is meaningful for populated results, empty results and execution errors. Composition rejection retains its existing alert and does not open SQL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | A named result/status target is focused after the matching request renders; SQL scroll area is keyboard operable. No focus move on unrelated rerenders; no hidden/missing focus target.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| R-03 / ug-2  | Idle capability: **“Inspect, query, validate, compare, and repair local datasets.”** Format line: **“Opens .parquet · .csv · .jsonl · .json”**. Primary control remains **“Open a data file…”**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Idle DOM contains that copy and no milestone, roadmap, `NEXT_MILESTONE`, `SCAFFOLD_STATUS`, `docs/`, PT-0 or G0 copy. Opening/error are not rendered as welcome states.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| R-04 / ug-2  | Picker hints cover exactly the four advertised input extensions, while retaining an All files option. Hints do not validate data.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | FSA options pin the accept map and `excludeAcceptAllOption: false` (or the API default); hidden input pins matching extensions. Cancel/single-file/fallback behavior unchanged. Do not use an invalid `*/*` FSA MIME key.                                                                                                                                                                                                                                                                                                                                                                                         |
| R-05 / ug-3  | Secondary control: **“Try with example data”**. Helper: **“Explore nested fields with a small synthetic example.”** Use existing `fixtures/jsonl/nested.jsonl`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Built app cold start → click → normal opening/ready chain → 12 rows, 10 columns. No picker, external fetch, duplicate open chain, new data authorship or new telemetry event.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| R-06 / ug-7  | Tool-body failures are local; panel retry and grid retry preserve opened dataset and committed staged changes/history.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Mounted-panel throw with nonzero pending edits leaves grid and summary usable; transient retry recovers. Persistent failure remains contained. `beginSession()` is not called.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| R-07 / ug-7  | Close is recoverable for managed and inner-disclosure sections; retry does not replay consumed SQL requests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Keyboard close → section hidden → focus on its existing nav link → nav reopens retained fallback → explicit retry. SQL retry/remount/StrictMode and new-sequence pins in §3.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| R-08 / ug-8  | Editing explanation: **“Edits are staged in this session; the opened file is never modified. Export writes a copy.”** Export includes **“Includes N staged change(s) — review in History”**, with singular grammar and no line at zero.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 0/1/N active-history-prefix pins; no export/report byte changes. Count operations, not rows or cells.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| R-09 / uxv-1 | Settings and telemetry disclosure use a defined semantic surface in both schemes. Disclosure/consent text and preference behavior are unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Both real surfaces driven in light/dark; normal text ≥4.5:1; axe clean without new allowlist. Test configured disclosure separately from inert stock build (§6).                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| R-10 / uxv-2 | Shared spacing, typography, control and radius tokens; scoped adoption, no global button restyle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | §4 inventory and token/control computed-style pins; existing compact grid/schema controls retain geometry and focus.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| R-11 / uxv-3 | Fluid desktop canvas, compact header and bounded grid height within the existing two-pane composition.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | §4 geometry matrix; grid scroll/virtualization and memo pins green; same DOM/headings and 28px rows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| R-12 / uxv-4 | Idle explanatory line: **“Powered by DuckDB-WASM · local query execution”**. Supporting sentence: **“Dataset contents are processed locally. Edits are staged; export writes a copy.”**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Static idle-only copy pins; no live status semantics, benchmark/memory claims, new network requests or events. Existing metadata disclosure/opt-out stays available.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| R-15 / ug-9  | Pipeline binding continues the journey instead of restarting it. Source nodes offer primary **“Use the open dataset”** plus secondary **“Choose a different file…”**; validate nodes offer primary **“Use the loaded contract”** (only while Validation holds a parsed contract) plus secondary **“Choose a different contract…”**. Both primary actions bind from App-held state with NO picker call. The validate-gate failure detail offers **“Inspect this contract in Validation”**, which reveals/expands the Validation section, loads the run's bound contract into it without a picker and focuses the section. The first DCR mention reads **“Export the Dataset Change Request (DCR)”** with one purpose sentence: **“A Dataset Change Request packages a proposed dataset change for review — like a pull request for data.”** Later mentions may abbreviate to “DCR”. | (a) e2e: open dataset → load a contract in Validation → open pipeline → bind source + validate nodes via the two primary actions with a picker spy that FAILS the test if called → run to a settled verdict. (b) e2e: force a validate-gate failure → click the cross-link → Validation section visible/expanded with the SAME contract loaded and the failing ruleIds named in its verdict, again with no picker call. (c) text pin: in the pipeline panel's rendered text no bare `DCR` precedes the expansion sentence. Engine/pipeline IR contracts unchanged; no new dependency; copy value-free (ADR 0025). |
| R-13 / uxv-5 | Rehearsable two-chapter synthetic demo and explicit raw-file/overlay/CLI boundaries.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | §5 and queue evidence checklist; exact existing fixture/contract paths and commands derived from tested journeys, not invented.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| R-14 / ug-13 | Every tool-section header carries a one-line purpose subtitle, verbatim: Schema **“Fields and types”** · Grid **“Browse the rows”** · Filters **“Show only matching rows”** · Validation **“Check data against rules”** · Compare **“Diff two datasets by key”** · SQL **“Query with DuckDB SQL”** · Editing **“Stage edits in this session”** · History **“Review and undo staged edits”** · Export **“Write a reviewed copy”** · Record **“Inspect one row in full”** · Profile **“Column statistics summary”** · Pipeline **“Chained contract checks”**. The Record section, while no row is selected, renders the closed-state hint **“Select a row to inspect it here — press Enter or double-click a row.”** The name **Record** stays as-is across nav link, section heading and toggle label (no rename; the hint disambiguates the dead end).                             | Subtitles render WITH the section collapsed (post-open, no user expansion) and are exposed to assistive tech via `aria-describedby` (the toggle's accessible name is unchanged); the Record hint is visible only while no record is requested; the name-agreement pin exists; heading map and collapsed-name pins updated; no DOM reorder (ADR 0044/q-15), no value-bearing copy, no new state, storage or telemetry.                                                                                                                                                                                             |

### State completeness

| State                    | Required presentation / ownership                                                                                                                                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idle                     | R-03, then R-05/R-12 as their owners land. One primary Open CTA; example is secondary. Settings remains available.                                                                                                                                    |
| Opening                  | Existing “Opening…” and disabled Open remain. Do not imply scan percentage or engine interrupt. ug-21 owns future progress/cancel, not these visual tasks.                                                                                            |
| Open error               | Classified one-line human cause + “Choose a different file…” retry re-entering the guarded open chain; raw engine detail only behind a collapsed `<details>` (ug-14, 2026-10-30). Preserve the Open control; do not hide errors beneath welcome text. |
| Ready, no edits          | Dataset row/column metadata, persistent grid, existing tool shells/nav and record dock; no false staged badge.                                                                                                                                        |
| SQL running/outcome      | Existing guarded running/error/cancel honesty. R-01/R-02 expose the matching nested outcome. “rows 1–20” is a page range, not a general total.                                                                                                        |
| Staged edit              | Existing dirty markers plus R-08. ug-6/ug-17 own History visibility/summaries; no second Undo/Redo pair.                                                                                                                                              |
| Validation stale/failure | Preserve current stale banners and failure navigation. ug-13/ug-17/ug-20 own further guidance/summaries. Styling must not conceal stale status.                                                                                                       |
| Panel/grid crash         | Static recovery copy in §3. No thrown messages, paths or cell values in fallback UI.                                                                                                                                                                  |
| Export                   | Preserve dialog focus/overwrite/source-copy guarantees and R-08. Restyle without altering output bytes or save semantics.                                                                                                                             |

## 3. First dispatch contracts

### ug-1: reveal, scroll, focus

Allowed expansion of the original scope: `App.tsx`, `sql/SqlPanel.tsx`, their focused tests and
`tests/e2e/nested-journey.spec.ts`; shared fixture helper only if necessary. Keep these paths
under `apps/web/src/` unless stated. Do not modify `DataGrid` or engine APIs to reveal a result.

Use existing `openSection`/pane state. Rendering and focus must be tied to the new request
sequence, not just the existence of any old SQL result. A populated scroll container can be a
named focusable region; provide equivalent focusable empty/error outcomes. Preserve manual SQL
editing and paging. Test a visible result focus plus in-pane scrolling; test the 900px page-scroll
fallback and the rail-collapsed header-action path. No DOM relocation or SQL workspace expansion.

### ug-7: retry and close without restarting the session

Allowed scope: `ErrorBoundary.tsx`, `App.tsx`, `sql/SqlPanel.tsx` for request acknowledgment,
focused boundary/SQL/shell tests. Tool-body boundaries wrap Schema, Editing, Export, History,
Validation, Compare, Filters, SQL, Profile and Pipeline. Keep root/grid boundaries and App-owned
session hooks; do not move those hooks into boundaries. The record dock is not silently added
to this tool-body task. Async/event errors still require existing explicit handling.

**Recovery seam:** managed sections use existing open state. Inner-disclosure sections use a
recovery-only parent visibility override, reset on a new dataset and cleared by their existing
nav link. Close focuses that nav link. Hidden bodies stay mounted; nav reopens the fallback
without auto-retrying. Normal inner disclosure controls do not gain duplicate shell toggles.
Retry clears only the failed boundary state and remounts its child.

**SQL request lifetime:** record consumption in App-owned, session-scoped sequence state before
issuing the external nested query. The claim/acknowledgment must synchronously distinguish a
new sequence from one already started; a panel-local ref is insufficient across a true remount.
Clearing an acknowledged request must not clear a newer request. After recovery, the user may
explicitly run SQL again; remount is not permission to replay a consumed request. Implementation
choice is local to web UI state, not a new engine/client protocol.

Mandatory pins: initial request runs once; StrictMode/remount with the same consumed sequence
runs zero additional queries; a genuinely new sequence runs once; stale session requests cannot
run in a replacement dataset. Test the query-call count, not only unchanged visible rows.

Use these static fallback strings (action labels are part of acceptance):

| Scope | Title / body / recovery / actions                                                                                                                                                                                                                                                                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Panel | **“This section could not render”** / “The grid and staged changes remain available. The opened file was not changed.” / “Try again resets this section's local state. If the error returns, close the section and use another tool.” / **“Try again”**, **“Close section”**                                                                                                    |
| Grid  | **“The data grid could not render”** / “The rest of the workbench and committed staged changes remain available. The opened file was not changed.” / “Try again resets the grid view; an uncommitted cell draft, focus and scroll position may be lost. Reload starts a fresh session and loses session edits.” / primary **“Try again”**, secondary **“Reload the workbench”** |

Move focus to reachable fallback content on failure and to a usable grid/panel target after a
successful retry. Never promise that remount fixes deterministic faults. Keep app-scope copy
outside this task except where a directly necessary test update is agreed in the brief.
Mutation drills remove retry reset and a panel wrapper separately; both relevant tests must fail.
STOP if recovery needs session restart, engine changes, or a broader component refactor.

## 4. Visual contract and reference frames

Reviewable reference drawings (not runtime screenshots or pixel baselines):
[idle light](assets/ux-ui-idle-light.svg), [idle dark](assets/ux-ui-idle-dark.svg),
[ready light](assets/ux-ui-ready-light.svg), [ready dark](assets/ux-ui-ready-dark.svg).
The ready references illustrate the assembled post-queue hierarchy; purpose/state summaries
still belong to ug-13/ug-17. Drawn controls and cells are schematic, not new APIs, fixture
values, DOM order or extra feature commitments. Error/export variants are specified by §2/§3
and the existing dialogs, not invented as unrelated new screens.

### Token and control inventory (uxv-2)

- Add semantic spacing aliases for 4/8/12/16/24/32px, compact/default control heights 32/36px,
  radii 4/6/8px, and UI/body/metadata/mono type aliases. UI/body 14–16px; metadata 12–13px;
  page title 20–24px. Essential instructions must remain readable at zoom.
- Reuse existing light/dark color tokens, explicit NULL and staged-warning semantics. No new
  external fonts, images, dependencies, brand palette, animations or theme-preference setting.
- First adoption is limited to the Open/example buttons, telemetry Settings/disclosure controls,
  workbench section toggles, and existing export-dialog action buttons/inputs. Use named component
  classes; preserve accessible names and all event/save behavior. Grid cells, schema action
  buttons, filter builder and SQL editor layout are not an implicit full-restyle scope.
- Primary action has one restrained accent treatment; secondary actions are neutral; focus has
  a visible 2px outline and offset. Preserve text-plus-color distinction for errors/stale state.
  No essential hover-only controls or tiny text to force a line fit.

### Geometry (uxv-3)

At default font/zoom, fixed synthetic fixture and the normal no-disclosure ready state:

| Viewport  | Outer gutters | Main width | Pane                                   | Gap  | Grid column           |
| --------- | ------------- | ---------- | -------------------------------------- | ---- | --------------------- |
| 1024×700  | 16px          | 992px      | 320px                                  | 16px | 656px                 |
| 1440×900  | 24px          | 1392px     | 360px                                  | 16px | 1016px                |
| 1920×1080 | 24px          | 1872px     | 360px                                  | 16px | 1496px                |
| 900×900   | 16px          | 868px      | Existing single-column scrolling stack | —    | Available stack width |

Allow ±2px box-measurement tolerance. Between samples, use fluid width, a 320px pane at
1024–1199px and a 360px pane at ≥1200px. Keep the existing 1024px breakpoint and rail behavior.
At ≤1023px preserve the current CSS ordering/DOM relationship; do not claim phone support.
The ready workspace top should be ≤140px at the supported desktop samples, absent disclosure,
error or additional guidance. Additional copy/zoom may increase height; scroll rather than clip.

Grid scroll viewport candidate: `clamp(280px, calc(100dvh - 240px), 640px)`, with `vh` fallback.
This yields 460/640/640px at the three desktop heights, before borders. Keep 28px row geometry,
header measurement, horizontal scroll, overscan/window contracts and record dock placement.
Assert heading, column headers, first ready row and normal grid footer visible at 1024×700;
if real header/footer measurements defeat that acceptance, adjust the reserved-height constant
within this task and record why. Never change the JS row estimate or hide document overflow.

Keep the current DOM sequence. A compact header can use scoped layout classes on existing
nodes, not relocate tool sections or duplicate controls. Header/open/status/Settings should have
clear hierarchy; nonmodal Settings must remain reachable and not cover the Open CTA at 1024px.
Adjustable pane width and center-mounted SQL are explicitly outside uxv-3.

## 5. Demo contract (uxv-5)

Deliver a repository-local rehearsal document, not a new public dataset or marketing performance
claim. Chapter 1 uses the bundled nested fixture, once ug-3 lands: open example → inspect schema
and record → Explode → visible SQL/result. Chapter 2 derives exact datasets, contracts, key
selection and commands from the existing M5/M6 exit journeys. Include CLI continuity within
Chapter 2, not a third chapter. Show failure → staged repair → fresh validation → copy export;
then demonstrate confirmed-key comparison on the separate proven M6 pair. Do not describe that
pair as the repaired M5 export or claim untested same-dataset agreement.

Of the demo inputs, only the nested example is a committed fixture (other golden fixtures exist for
other tests). M5/M6 use **per-run generated temporary files**
from `tests/e2e/support/validation-datasets.ts` (`writeValidationDatasetA`) and
`tests/e2e/support/diff-datasets.ts` (`writeExitJourneyPair`). Cite generator/function paths and
the current journey source, not imaginary stable dataset/contract paths. On this host's Node 24,
manual inputs can be reproduced from the repo root without authoring or committing new data:

```bash
node --experimental-strip-types --input-type=module -e '
import { writeValidationDatasetA } from "./tests/e2e/support/validation-datasets.ts";
import { writeExitJourneyPair } from "./tests/e2e/support/diff-datasets.ts";
console.log(JSON.stringify({ validation: writeValidationDatasetA(), diff: writeExitJourneyPair() }));
'
DUCKDB=/tmp/duckdb pnpm exec playwright test tests/e2e/m5-exit-journey.spec.ts tests/e2e/m6-exit-journey.spec.ts
```

The first command emits only fresh synthetic input paths for local rehearsal, not dataset values
or telemetry. The second, after `pnpm build`, generates its own inputs and proves the existing
journeys. Record which generated paths a manual run used and any differences from the automated
leg. On a runtime without TypeScript stripping, use the existing Playwright journey generation;
do not add a dependency or commit temporary data to get stable filenames.

State exactly which input each report describes. CLI agreement is on matching raw files or
explicitly exported/reopened files, not an invisible browser overlay. Browser runs WASM; CLI
uses the native Node seam. Keep telemetry caveats and input-format limits. Rehearse built output
in both schemes with keyboard access; record commit, commands, observed counts and any gap.
Human approval is still required for new public demo-data curation, publication and live collectors.

## 6. Verification contract

### Clean-main baseline, worker, reviewer and merged gates

Record starting commit, `git status --short`, Node/pnpm/DuckDB versions, build environment,
ports, each exit code and log path. Never erase, stash away, or silently commit unknown work to
make the tree look clean. Integrate this documentation pack through the normal reviewed docs
process before claiming a clean-main baseline. If commit/integration authority is unclear, ask.

Run from the repository root; use a distinct `/tmp/assay-ux-<row>-<role>/` log directory and
`set -o pipefail` when piping to `tee`. Six core gates, in order:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
DUCKDB=/tmp/duckdb pnpm test
pnpm build
DUCKDB=/tmp/duckdb pnpm test:e2e
```

Also required: `DUCKDB=/tmp/duckdb pnpm test:coverage`, `pnpm docs:links:check`, and
`pnpm adr:index:check`. Preserve configured coverage floors; do not lower limits or exclusions.
Unset `ASSAY_TELEMETRY_ENDPOINT`, `ASSAY_TELEMETRY_TOKEN` and `ASSAY_NO_TELEMETRY` for the
stock baseline/build, and record that these names were unset without logging secret values.
Use Node ≥22, pinned pnpm via the repo, `/tmp/duckdb` 1.5.5 and installed Playwright Chromium.
A missing binary is a blocker, not a skip or an invitation to rewrite gates. Record failures and
reproduce/retry known contention signatures without weakening thresholds. Additional CI packaging,
fixture or VS Code harness gates remain required when affected; this is not a full remote-CI claim.

Baseline and integration use default ports 4173/4179/4180. Isolated Shell worker ports are
4273/4279/4280; Panels worker ports 4373/4379/4380 via `ASSAY_E2E_PORT_WEB`,
`ASSAY_E2E_PORT_ENGINE`, `ASSAY_E2E_PORT_DS`. Reviewers use their worktree's assigned free set;
never reuse a server built from another revision. Source mutation under e2e requires a rebuild,
then restoration **and a rebuild of restored source** before claiming a clean verification.

### Focused evidence (in addition to gates)

| Owner   | Focused commands / pins                                                                                                                                                                                                                                                                                       |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ug-1    | `pnpm exec playwright test tests/e2e/nested-journey.spec.ts tests/e2e/a11y-keyboard.spec.ts`; outcome/sequence unit tests where added; real collapsed defaults and focus assertions.                                                                                                                          |
| ug-2/3  | `pnpm exec vitest run apps/web/src/lib/app.test.ts apps/web/src/App.open-status.test.tsx packages/data-sources/src/pick-file.test.ts`; `pnpm exec playwright test tests/e2e/smoke.spec.ts tests/e2e/data-sources.spec.ts tests/e2e/shell.spec.ts`; add example cold-start pin for ug-3.                       |
| ug-4    | `pnpm exec vitest run apps/web/src/grid/DataGrid.keyboard.test.tsx apps/web/src/App.shell.test.tsx`; `pnpm exec playwright test tests/e2e/a11y-keyboard.spec.ts tests/e2e/grid-editing.spec.ts`; hint visible on first ready paint, footer shortcut list and `aria-describedby` pins.                         |
| ug-14   | `pnpm exec vitest run apps/web/src/App.open-status.test.tsx apps/web/src/grid/FilterBar.test.tsx`; `pnpm exec playwright test tests/e2e/data-sources.spec.ts tests/e2e/smoke.spec.ts tests/e2e/shell.spec.ts`; add a corrupt-fixture open-error retry pin and a single-line message pin per adopted panel.    |
| ug-7    | `pnpm exec vitest run apps/web/src/ErrorBoundary.test.tsx apps/web/src/App.error-boundary.test.tsx apps/web/src/App.shell.test.tsx`; new real request-consumption/remount pins; retry/wrapper mutants must fail.                                                                                              |
| uxv-1/2 | `pnpm exec playwright test tests/e2e/theme.spec.ts tests/e2e/a11y.spec.ts tests/e2e/telemetry.spec.ts`; telemetry component tests; uxv-1 configured disclosure leg below.                                                                                                                                     |
| uxv-3   | `pnpm exec vitest run apps/web/src/App.memo-probe.test.tsx apps/web/src/App.shell.test.tsx`; `pnpm exec playwright test tests/e2e/shell.spec.ts tests/e2e/grid-horizontal.spec.ts tests/e2e/grid-virtualization.spec.ts tests/e2e/theme.spec.ts tests/e2e/a11y-keyboard.spec.ts`; geometry/focus/scroll pins. |
| uxv-4/5 | Add explanatory-copy pin; built nested/M5/M6 rehearsals respectively. Re-derive fixture counts; docs links and privacy/source-claim review.                                                                                                                                                                   |

All Playwright legs use freshly built output. Add missing requirement tests; existing file names
are starting points, not proof that their current assertions already cover this spec.

### Configured-disclosure theme evidence (uxv-1)

Stock `telemetry.spec.ts` intentionally asserts no disclosure; do **not** run that stock suite
against a configured build or introduce a production testing hook. Add an isolated
`tests/visual/telemetry-disclosure-theme.spec.ts` and config in the same directory (outside the
default `tests/e2e` testDir), reusing base settings with explicit testDir/testMatch and assigned
ports. Register a context route aborting `https://collector.example.invalid/**` before navigation,
block service workers, and use fresh local storage. This exercises the real disclosure without
sending metadata to a collector. Preserve consent copy, emission and storage contracts.

```bash
env -u ASSAY_NO_TELEMETRY -u ASSAY_TELEMETRY_TOKEN \
  ASSAY_TELEMETRY_ENDPOINT=https://collector.example.invalid/ingest pnpm build
ASSAY_E2E_PORT_WEB=4473 ASSAY_E2E_PORT_ENGINE=4479 ASSAY_E2E_PORT_DS=4480 \
  pnpm exec playwright test --config tests/visual/playwright.telemetry.config.ts
env -u ASSAY_TELEMETRY_ENDPOINT -u ASSAY_TELEMETRY_TOKEN -u ASSAY_NO_TELEMETRY pnpm build
```

Finally re-run stock theme/telemetry tests against restored stock output. Attach real light/dark
screenshots and axe results; a JSDOM/happy-dom style assertion alone cannot prove contrast.

## 7. Explicit STOP/decision register

| ID    | Decision / blocked work                                                                                                                                                                                                                                                        | Who resolves / safe default                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UX-D1 | ug-10 currently promises overlay stale → re-run, but `profile(handle)` reads only the base and user SQL (`query(sql)`) carries no overlay, so a re-run cannot include staged edits. A draft amendment brief now exists (Options A / B / C) and is PENDING a maintainer ruling. | **BLOCKED until the maintainer rules.** Safe default unchanged: do not implement ug-10 and do not edit its contradictory queue wording. Brief: [20261029-ux-d1-amendment.md](../process/handoff/20261029-ux-d1-amendment.md) (§7 decision block). Recommended: Option C — honest labeling now, overlay-aware profile chartered separately. Engine/domain/`DataEngine` target changes are candidate design options, not a required mandate; the existing diff overlay is the composition precedent, and the architect must resolve the actual Option B footprint. Panels successors ug-16/ug-20 stay behind ug-10. |
| UX-D2 | Adjustable SQL pane/workspace sizing exceeds the fixed-pane spec.                                                                                                                                                                                                              | Maintainer approves bounded spec amendment; architect/ADR if changing accepted shell direction. uxv-6 is design-only; ug-1 does not wait for it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| UX-D3 | Opening a new example/file while staged changes exist has existing session-loss behavior.                                                                                                                                                                                      | ug-3 adds example entry only on idle. A ready-state replace-dataset confirmation is a separate scoped task if desired; do not silently add it to a style task.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

No new dependencies, telemetry, AI/hosted features, benchmarks, Arrow/Feather input support,
DOM reorder, dynamic fallback interpolation, export byte changes, source mutation or automatic
query replay is authorized by this spec. STOP and report any requirement needing those changes.

## 8. Requirement status (living index)

**This is a pointer index, not the evidence trail.** Queues own claims, reviewer verdicts and merged
gate logs; this table only answers "is this requirement implemented, and where does the record
live?" Update it in the same change that closes a row. Local green is never remote green (M6).

Ownership: the [usability queue](../process/handoff/20261026-usability-queue.md) owns R-01…R-08,
R-14 and R-15; the [visual queue](../process/handoff/20261026-ux-ui-execution-queue.md) owns
R-09…R-13. **R-16 is proposed only** — it exists in this index and the amendment brief and is
added to §2 only if the maintainer approves UX-D1. uxv-6 has no requirement row and remains
design-only/deferred.

| Requirement     | Owner row | Status (2026-10-29)                                              | Record                                                                  |
| --------------- | --------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| R-01, R-02      | ug-1      | implemented                                                      | `e92c0dd` (usability queue §1)                                          |
| R-03, R-04      | ug-2      | implemented                                                      | `8e5fd62`                                                               |
| R-05            | ug-3      | implemented                                                      | `5253c06`                                                               |
| R-06, R-07      | ug-7      | implemented                                                      | `9c29da4` + evidence `8367fbd`                                          |
| R-08            | ug-8      | implemented                                                      | `cb64c32`, gate determinism `b6fb78a` (gd-1)                            |
| R-09            | uxv-1     | open — eligible, pending an exclusive CSS/theme-test reservation | visual queue row uxv-1                                                  |
| R-10            | uxv-2     | open — dependency-gated (after uxv-1)                            | visual queue row uxv-2 (also owns the ug-8 copy classes)                |
| R-11            | uxv-3     | open — dependency-gated (after uxv-2)                            | visual queue row uxv-3 (two-line headers from R-14 exist)               |
| R-12            | uxv-4     | open — dependency-gated (after ug-3 and uxv-3)                   | visual queue row uxv-4                                                  |
| R-13            | uxv-5     | open — dependency-gated (after uxv-1…4; ug-3/7/8)                | visual queue row uxv-5                                                  |
| R-14            | ug-13     | implemented                                                      | `36cead3` + test-only `793ba90`                                         |
| R-15            | ug-9      | implemented                                                      | `71fa03a` + Critical fix `385649b`                                      |
| R-16 (proposed) | ug-10     | **not authorized** — UX-D1 pending                               | [amendment brief](../process/handoff/20261029-ux-d1-amendment.md) §4/§7 |
