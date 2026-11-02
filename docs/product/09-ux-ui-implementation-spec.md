# Assay UX/UI Implementation Spec

**Authored 2026-10-26; status refreshed 2026-11-02 (usability batch complete, after ug-23).** The authoring date records when the
contract was written, not the current implementation state. As of 2026-10-31, R-01…R-08, R-14
and R-15 are implemented and merged-verified; **R-09 is implemented at `d85dec2` (uxv-1)** and **R-10 at
`b487788` (uxv-2)**, both 2026-11-03, while R-11…R-13 remain open (the frontier is uxv-3, then uxv-4
→ uxv-5); **R-16 is implemented at `f667a87`** under the maintainer's
UX-D1 Option C ruling (2026-10-30); **ug-16 profile click-to-act is implemented at `3b494f5`**
under the settled typed-refusal design and **ug-17 collapsed section state summaries at
`9a31cd6`**, **ug-4 capability-true grid interaction language at `784805c`**, **ug-5
focused-cell copy at `d814fdf`**, **ug-6 undo/redo shortcuts + first-append History cue at `b2c6ce1`**, and **ug-12
keyboard completion at `d3af2ec`**, **ug-11 row identity at `79febe5`**, **ug-18 filter compose row + collapsed
chips at `4d3cb54`**, **ug-19 contrast + in-flight feedback at `0ac3447`**, and **ug-20 validation on-ramp +
filter-replacement disclosure at `5bad2c3`** (no new R-ID for any of them). This is the
execution
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
- ug-10 is **implemented at `f667a87`** (UX-D1 Option C, R-16); ug-16 (profile stats
  click-to-act) is **implemented at `3b494f5`** under its settled typed-refusal design
  ([record](../process/handoff/20261030-ug16-renamed-column-design.md)): a base-derived stat is
  actionable only when its column resolves on the edited view, nothing is ever silently remapped,
  and cast/type mismatch never coerces. ug-17 (Shell) is **implemented at `9a31cd6`**: managed
  section toggles show optional, value-free session summaries (`Validation · N failing`, `Compare ·
N changed`, `History · N pending`) visible collapsed, only at N>0. ug-4 (Grid) is
  **implemented at `784805c`**: the editable ready grid carries a persistent one-line editing
  hint wired as the grid’s description and a footer Keyboard disclosure, with every claim gated
  on the instance’s actual capabilities. ug-5 (Grid) is **implemented at `d814fdf`**: Ctrl/Cmd+C
  on a focused non-editing cell copies its display value and announces `Value copied.` through the
  existing polite region, with native editor copy untouched. ug-6 (Shell) is **implemented at
  `b2c6ce1`**: Ctrl/Cmd+Z undo and Ctrl/Cmd+Shift+Z / Ctrl/Cmd+Y redo map to the existing handlers
  without hijacking native text undo, and History auto-expands on the first appended op only; the
  single visible Undo/Redo pair is unchanged. ug-12 (Grid) is **implemented at `d3af2ec`**: an
  explicit `.grid-cell:focus-visible` ring plus announced row jumps (`Showing base #N in the grid
and record inspector`) with roving focus landing on the target row. ug-11 (Grid) is
  **implemented at `79febe5`**: a sticky 1-based row-number gutter, a dock title using the same
  convention, and ◀ Prev / ▶ Next immediate-neighbour stepping. ug-18 (Grid) is **implemented at
  `4d3cb54`**: one `Filter on:` compose row, editable active-filter rows that apply what they
  display, a collapsed `SQL predicates` escape hatch, and a collapsed summary that names the
  active columns with removable sibling chips. ug-19 (Grid) is **implemented at `0ac3447`**:
  empty-state text clears AA in both schemes, the grid exposes aria-busy with a polite
  `Sorting…`/`Filtering…` footer status, and a loading-row edit gesture queues and opens only on
  the same logical row. ug-20 (Panels) is **implemented at `5bad2c3`**: the validation zero state
  offers a schema-derived starter contract download, and enabled failure-filter controls state the
  filter replacement when filters are active. **ug-21 (Shell) is implemented at `8458ad1`**: the
  opening state shows a genuinely indeterminate, named `<progress>` (no value, no percentage) and a
  `Cancel opening` control that returns the app to idle through the existing session-token guard, so
  a cancelled open's late result is discarded. **ug-22 (Shell) is implemented at `e73dda4`**: the
  sticky-nav reading order is schema, filters, grid, validation, compare, sql, editing, history,
  export, record, profile, pipeline — a pure `WORKBENCH_SECTIONS` array edit with **no DOM reorder**
  (ADR 0044 / D14 + the q-15 placement ruling authorize nav order only; the section element order,
  heading map and two-pane layout are unchanged). **ug-23 (Shell) is implemented at `07a37d4`**: the
  four code-observation riders (stale pipeline-jump comment corrected, injective FilterBar chip key,
  de-duplicated pane-toggle accessible name, and the `row-uninsert` gloss decided as `undo row
insert`). **All 23 usability rows are implemented and merged-verified; all three lanes are
  complete**, so the only UX work left in this pack is the visual lane (uxv-1 eligible only under an
  exclusive CSS/theme-test reservation). Adjustable SQL sizing remains design-only. All other
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
| R-16 / ug-10 | Profile honesty: statistics describe the file **as opened**. Hint (every expanded profile state, byte-exact): **“Statistics describe the file as opened — staged changes are not included.”** While the active history has ≥1 operation, a note (byte-exact, singular/plural): **“1 staged change is not reflected here — the grid uses the edited view. Validation must be run explicitly against the edited view.”** / **“N staged changes are not reflected here — the grid uses the edited view. Validation must be run explicitly against the edited view.”**                                                                                                                                                                                                                                                                                                                 | Hint byte-exact in idle/zero, running, error and results; note exact at N=1 and N>1, absent at N=0 and after undo back to 0; no “stale — re-run” banner and no claim that re-running includes edits; no auto-recompute on overlay revision change; `profile(handle)`/protocol/engine unchanged; the idle `profile-table-id` element stays present; copy value-free (ADR 0025).                                                                                                                                                                                                                                    |

### State completeness

| State                    | Required presentation / ownership                                                                                                                                                                                                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idle                     | R-03, then R-05/R-12 as their owners land. One primary Open CTA; example and drop-anywhere are secondary ingress (the drop is idle-only, ug-15). Settings remains available.                                                                                                                                                                                  |
| Opening                  | Existing “Opening…” and disabled Open remain. Do not imply scan percentage or engine interrupt. **ug-21 (implemented at `8458ad1`)** adds an indeterminate progress affordance and a Cancel that returns to idle through the existing session-token guard (the engine op has no interrupt — the copy must not claim one); it does not own these visual tasks. |
| Open error               | Classified one-line human cause + “Choose a different file…” retry re-entering the guarded open chain; raw engine detail only behind a collapsed `<details>` (ug-14, 2026-10-30). Preserve the Open control; do not hide errors beneath welcome text.                                                                                                         |
| Ready, no edits          | Dataset row/column metadata, persistent grid, existing tool shells/nav and record dock; no false staged badge.                                                                                                                                                                                                                                                |
| SQL running/outcome      | Existing guarded running/error/cancel honesty. R-01/R-02 expose the matching nested outcome. “rows 1–20” is a page range, not a general total.                                                                                                                                                                                                                |
| Staged edit              | Existing dirty markers plus R-08. ug-6/ug-17 own History visibility/summaries; no second Undo/Redo pair.                                                                                                                                                                                                                                                      |
| Validation stale/failure | Preserve current stale banners and failure navigation. ug-13/ug-17/ug-20 own further guidance/summaries. Styling must not conceal stale status.                                                                                                                                                                                                               |
| Panel/grid crash         | Static recovery copy in §3. No thrown messages, paths or cell values in fallback UI.                                                                                                                                                                                                                                                                          |
| Export                   | Preserve dialog focus/overwrite/source-copy guarantees and R-08. Restyle without altering output bytes or save semantics.                                                                                                                                                                                                                                     |

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

| Owner   | Focused commands / pins                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ug-1    | `pnpm exec playwright test tests/e2e/nested-journey.spec.ts tests/e2e/a11y-keyboard.spec.ts`; outcome/sequence unit tests where added; real collapsed defaults and focus assertions.                                                                                                                                                                                                                                                                                                                                                                         |
| ug-2/3  | `pnpm exec vitest run apps/web/src/lib/app.test.ts apps/web/src/App.open-status.test.tsx packages/data-sources/src/pick-file.test.ts`; `pnpm exec playwright test tests/e2e/smoke.spec.ts tests/e2e/data-sources.spec.ts tests/e2e/shell.spec.ts`; add example cold-start pin for ug-3.                                                                                                                                                                                                                                                                      |
| ug-4    | `pnpm exec vitest run apps/web/src/grid/DataGrid.keyboard.test.tsx apps/web/src/App.shell.test.tsx`; `pnpm exec playwright test tests/e2e/a11y-keyboard.spec.ts tests/e2e/grid-editing.spec.ts`; hint visible on first ready paint, footer shortcut list and `aria-describedby` pins.                                                                                                                                                                                                                                                                        |
| ug-5    | `pnpm exec vitest run apps/web/src/grid/copy-cell.test.ts apps/web/src/grid/DataGrid.copy.test.tsx apps/web/src/grid/DataGrid.keyboard.test.tsx`; `pnpm exec playwright test tests/e2e/cell-copy.spec.ts tests/e2e/a11y-keyboard.spec.ts`; display-value payload parity (DECIMAL/date/nested), Ctrl/Cmd+C only on focused non-editing cells, exact value-free announcements, native editor copy untouched, real clipboard read-back.                                                                                                                         |
| ug-6    | `pnpm exec vitest run apps/web/src/lib/history-shortcut.test.ts apps/web/src/App.history-shortcut.test.tsx apps/web/src/App.section-summaries.test.tsx`; `pnpm exec playwright test tests/e2e/history-shortcuts.spec.ts tests/e2e/section-summaries.spec.ts`; full shortcut matrix, native text undo preserved in editable targets, first-append-only History auto-expand (no undo/redo/dataset trigger, no re-open after collapse), single visible pair.                                                                                                    |
| ug-12   | `pnpm exec vitest run apps/web/src/App.row-jump-announcement.test.tsx apps/web/src/grid/DataGrid.jump-focus.test.tsx apps/web/src/sessions/jump-to-row.test.tsx apps/web/src/grid/DataGrid.keyboard.test.tsx`; `pnpm exec playwright test tests/e2e/a11y-keyboard.spec.ts tests/e2e/validation-panel.spec.ts tests/e2e/diff-panel.spec.ts`; keyboard-driven computed-style outline pin; exact value-free jump announcement with the domain display key; target row focused as the roving stop with the record inspector on the same row; failed jump silent. |
| ug-11   | `pnpm exec vitest run apps/web/src/grid apps/web/src/record apps/web/src/App.record-step.test.tsx`; `pnpm exec playwright test tests/e2e/grid-row-numbers.spec.ts tests/e2e/grid-horizontal.spec.ts tests/e2e/grid-virtualization.spec.ts tests/e2e/record-inspector.spec.ts`; sticky 1-based gutter (`rowheader`, `aria-colcount`, opaque/striped) with gutter↔dock-title agreement; immediate-neighbour Prev/Next (bounds/error disabled, loading rides pending); O(1) stepping call-count pin on a 100k sparse cache.                                     |
| ug-18   | `pnpm exec vitest run apps/web/src/grid/FilterBar.test.tsx`; `pnpm exec playwright test tests/e2e/filter-builder.spec.ts tests/e2e/grid-filter-sort.spec.ts`; exactly one compose row compiled through the existing builder; active rows apply what they display (programmatic replacement re-seeds); collapsed `SQL predicates` disclosure; exact collapsed summary naming columns + sibling chips with working removal; one removal control per filter per state.                                                                                          |
| ug-19   | `pnpm exec vitest run apps/web/src/grid apps/web/src/App.grid-busy.test.tsx apps/web/src/theme-contrast.test.ts`; `pnpm exec playwright test tests/e2e/a11y.spec.ts tests/e2e/theme.spec.ts tests/e2e/grid-editing.spec.ts`; empty-state + NULL-marker AA in both schemes with driven zero-result/NULL scans; aria-busy + footer Sorting…/Filtering… cleared on settle; one-slot loading-row pending edit retired by overlay revision, opened on the captured row, dropped visibly on error.                                                                 |
| ug-20   | `pnpm exec vitest run apps/web/src/validation`; `pnpm exec playwright test tests/e2e/validation-panel.spec.ts tests/e2e/validation-report-export.spec.ts`; schema-derived starter contract (canonical, round-trip, mappable types only, no filename/values, real download); zero-state states/status incl. delivery failure and dataset-swap clearing; exact `Replaces the current N filters` on enabled controls only, absent at 0, with enabled accessible names pinned.                                                                                   |
| ug-14   | `pnpm exec vitest run apps/web/src/App.open-status.test.tsx apps/web/src/grid/FilterBar.test.tsx`; `pnpm exec playwright test tests/e2e/data-sources.spec.ts tests/e2e/smoke.spec.ts tests/e2e/shell.spec.ts`; add a corrupt-fixture open-error retry pin and a single-line message pin per adopted panel.                                                                                                                                                                                                                                                   |
| ug-16   | `pnpm exec vitest run apps/web/src/profile apps/web/src/edit/session.test.ts apps/web/src/App.profile-filter.test.tsx`; `pnpm exec playwright test tests/e2e/profile-panel.spec.ts tests/e2e/profile-honesty.spec.ts tests/e2e/profile-filter.spec.ts`; top-k/null predicates pinned at the model boundary; byte-exact renamed/unresolved refusals with NO filter (never remapped); cast/type rejection without coercion; zero-row resolved click keeps the empty state; single-flight and attempt/session-identity lifecycle pins.                          |
| ug-17   | `pnpm exec vitest run apps/web/src/App.section-summaries.test.tsx apps/web/src/App.section-purposes.test.tsx apps/web/src/App.headings.test.tsx`; `pnpm exec playwright test tests/e2e/section-summaries.spec.ts`; byte-exact `Validation · N failing` / `Compare · N changed` / `History · N pending` from the right sources, visible inside the collapsed managed toggle, absent at 0 and in non-verdict/non-result states, accessible name unchanged, summary appended to `aria-describedby` only when present.                                           |
| ug-4    | `pnpm exec vitest run apps/web/src/grid/DataGrid.interaction-hints.test.tsx apps/web/src/grid/DataGrid.keyboard.test.tsx apps/web/src/grid/DataGrid.diagnostics.test.tsx`; `pnpm exec playwright test tests/e2e/a11y-keyboard.spec.ts tests/e2e/grid-editing.spec.ts`; byte-exact hint on first ready paint wired as the grid description; footer Keyboard list pinned; capability gating for editable / inspect-only / read-only-preview shapes.                                                                                                            |
| ug-7    | `pnpm exec vitest run apps/web/src/ErrorBoundary.test.tsx apps/web/src/App.error-boundary.test.tsx apps/web/src/App.shell.test.tsx`; new real request-consumption/remount pins; retry/wrapper mutants must fail.                                                                                                                                                                                                                                                                                                                                             |
| uxv-1/2 | `pnpm exec playwright test tests/e2e/theme.spec.ts tests/e2e/a11y.spec.ts tests/e2e/telemetry.spec.ts`; telemetry component tests; uxv-1 configured disclosure leg below.                                                                                                                                                                                                                                                                                                                                                                                    |
| uxv-3   | `pnpm exec vitest run apps/web/src/App.memo-probe.test.tsx apps/web/src/App.shell.test.tsx`; `pnpm exec playwright test tests/e2e/shell.spec.ts tests/e2e/grid-horizontal.spec.ts tests/e2e/grid-virtualization.spec.ts tests/e2e/theme.spec.ts tests/e2e/a11y-keyboard.spec.ts`; geometry/focus/scroll pins.                                                                                                                                                                                                                                                |
| uxv-4/5 | Add explanatory-copy pin; built nested/M5/M6 rehearsals respectively. Re-derive fixture counts; docs links and privacy/source-claim review.                                                                                                                                                                                                                                                                                                                                                                                                                  |

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
# NOTE (corrected 2026-11-03 at uxv-1): `pnpm build` under the endpoint env does NOT configure the
# bundle. Turbo 2.x runs in strict env mode and turbo.json declares no `env`, so the variable is
# dropped AND the task is usually a cache hit — the built output carries no endpoint. Build the web
# package directly, then prove the endpoint is actually baked in before running the leg:
env -u ASSAY_NO_TELEMETRY -u ASSAY_TELEMETRY_TOKEN \
  ASSAY_TELEMETRY_ENDPOINT=https://collector.example.invalid/ingest pnpm --filter @assay/web build
grep -r collector.example.invalid apps/web/dist   # must print a hit; no hit = the leg would be vacuous
ASSAY_E2E_PORT_WEB=4473 ASSAY_E2E_PORT_ENGINE=4479 ASSAY_E2E_PORT_DS=4480 \
  pnpm exec playwright test --config tests/visual/playwright.telemetry.config.ts
# Restore: a cache-hit rebuild does NOT delete the configured chunk, so remove the output first and
# then verify the endpoint is gone before any stock run.
rm -rf apps/web/dist
env -u ASSAY_TELEMETRY_ENDPOINT -u ASSAY_TELEMETRY_TOKEN -u ASSAY_NO_TELEMETRY pnpm build
grep -r collector.example.invalid apps/web/dist   # must print nothing
```

The two `grep` lines are part of the evidence, not decoration: without them a cache hit or a stale
`dist` can make the configured leg pass against a stock or mixed build. (A cleaner long-term fix is
declaring `ASSAY_TELEMETRY_ENDPOINT`/`TOKEN`/`NO_TELEMETRY` in `turbo.json`'s `env`; that is a root
config change and was deliberately not taken inside uxv-1.)

Finally re-run stock theme/telemetry tests against restored stock output. Attach real light/dark
screenshots and axe results; a JSDOM/happy-dom style assertion alone cannot prove contrast.

## 7. Explicit STOP/decision register

| ID    | Decision / blocked work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Who resolves / safe default                                                                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UX-D1 | **RESOLVED 2026-10-30 — Option C.** ug-10 promised an overlay stale → re-run state, but `profile(handle)` reads only the base and user SQL (`query(sql)`) carries no overlay, so a re-run cannot include staged edits. The maintainer ruled Option C: ship the amended honest-labeling contract (R-16) now, and charter an overlay-aware profile as a **separate engine-track candidate** (planning only, not authorized). Brief + ruling: [20261029-ux-d1-amendment.md](../process/handoff/20261029-ux-d1-amendment.md) (§7); candidate: [20261030-overlay-profile-candidate.md](../process/handoff/20261030-overlay-profile-candidate.md). ug-10 is authorized; ug-16 becomes eligible only after the amended ug-10 is implemented, independently reviewed and merged-green. | Maintainer ruled **Option C** (2026-10-30); the overlay-aware profile is a planning-only engine candidate, not authorized for dispatch.                        |
| UX-D2 | Adjustable SQL pane/workspace sizing exceeds the fixed-pane spec.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Maintainer approves bounded spec amendment; architect/ADR if changing accepted shell direction. uxv-6 is design-only; ug-1 does not wait for it.               |
| UX-D3 | Opening a new example/file while staged changes exist has existing session-loss behavior.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | ug-3 adds example entry only on idle. A ready-state replace-dataset confirmation is a separate scoped task if desired; do not silently add it to a style task. |

No new dependencies, telemetry, AI/hosted features, benchmarks, Arrow/Feather input support,
DOM reorder, dynamic fallback interpolation, export byte changes, source mutation or automatic
query replay is authorized by this spec. STOP and report any requirement needing those changes.

## 8. Requirement status (living index)

**This is a pointer index, not the evidence trail.** Queues own claims, reviewer verdicts and merged
gate logs; this table only answers "is this requirement implemented, and where does the record
live?" Update it in the same change that closes a row. Local green is never remote green (M6).

Ownership: the [usability queue](../process/handoff/20261026-usability-queue.md) owns R-01…R-08,
R-14, R-15 and R-16; the [visual queue](../process/handoff/20261026-ux-ui-execution-queue.md) owns
R-09…R-13. **R-16 is implemented** at `f667a87` (UX-D1 Option C, 2026-10-30), owned by ug-10;
the overlay-aware profile it deliberately does _not_ implement is a separate engine-track candidate
(planning only). uxv-6 has no requirement row and remains design-only/deferred.

| Requirement | Owner row | Status (2026-11-02)                                                        | Record                                                                            |
| ----------- | --------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| R-01, R-02  | ug-1      | implemented                                                                | `e92c0dd` (usability queue §1)                                                    |
| R-03, R-04  | ug-2      | implemented                                                                | `8e5fd62`                                                                         |
| R-05        | ug-3      | implemented                                                                | `5253c06`                                                                         |
| R-06, R-07  | ug-7      | implemented                                                                | `9c29da4` + evidence `8367fbd`                                                    |
| R-08        | ug-8      | implemented                                                                | `cb64c32`, gate determinism `b6fb78a` (gd-1)                                      |
| R-09        | uxv-1     | implemented — `d85dec2` (defined scheme-aware surface, no colour fallback) | visual queue row uxv-1 + `.changeset/uxv-1-telemetry-surface-token.md`            |
| R-10        | uxv-2     | implemented — `b487788` (token layer + named controls)                     | visual queue row uxv-2 + `.changeset/uxv-2-design-tokens.md`                      |
| R-11        | uxv-3     | open — dependency-gated (after uxv-2)                                      | visual queue row uxv-3 (two-line headers from R-14 exist)                         |
| R-12        | uxv-4     | open — dependency-gated (after ug-3 and uxv-3)                             | visual queue row uxv-4                                                            |
| R-13        | uxv-5     | open — dependency-gated (after uxv-1…4; ug-3/7/8)                          | visual queue row uxv-5                                                            |
| R-14        | ug-13     | implemented                                                                | `36cead3` + test-only `793ba90`                                                   |
| R-15        | ug-9      | implemented                                                                | `71fa03a` + Critical fix `385649b`                                                |
| R-16        | ug-10     | implemented — `f667a87` (UX-D1 Option C)                                   | [amendment brief](../process/handoff/20261029-ux-d1-amendment.md) §4/§7 + spec §2 |

**Rows without a requirement ID.** ug-4/ug-5/ug-6/ug-11/ug-12/ug-17/ug-18/ug-19/ug-20 and (as of
2026-11-02) **ug-21** and **ug-22** implement queue findings rather than an `R-` contract and are not
listed above: ug-21 (opening progress + session-token cancel) is **implemented at `8458ad1`** and
ug-22 (sticky-nav reading order, no DOM reorder) at `e73dda4` and **ug-23** (the four
code-observation riders) at `07a37d4`; the owning record is the
[usability queue](../process/handoff/20261026-usability-queue.md) rows and
[handoff §9](../process/handoff.md). The `Opening` row in §2's state-completeness table carries
ug-21's behavioural contract, and §1 above records ug-22's nav-order-only boundary.
