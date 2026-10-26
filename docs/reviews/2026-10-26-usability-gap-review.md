# Usability Gap Review — intuitiveness of the current workbench (2026-10-26)

**Baseline:** `main` post slice-2 closure (handoff updated 2026-10-19). **Method:** four parallel
read-only investigator dispatches on `zai/glm-5.3-flash` (the §4 worker lane), each owning one
area: (A) first-run & open path, (B) grid & everyday workflow, (C) cross-surface journey
coherence, (D) shell IA, navigation, help & failure containment. Investigator reports were
consolidated by the orchestrator; every load-bearing P1/P2 claim was independently re-verified
against the tree before publication (grep/read evidence retained below). **No code was changed.**

**Exclusions:** the 2026-09-29 audit findings UX-1…UX-10 are fully remediated (closed queue
[20260929-ux-queue.md](../process/handoff/20260929-ux-queue.md)) and are **not** re-reported;
the uxc-1…uxc-5 and q-15/p2c carry-over ledgers were checked and verified landed. The two-pane
shell ([ADR 0044](../adr/0044-workbench-shell-two-pane.md), spec
[05-workbench-shell.md](../product/05-workbench-shell.md)) is accepted direction — findings
respect its rulings (no DOM reorder proposals; nav-order item cites the ruling instead).

**Finding IDs:** `UG-1…UG-37`. Severity: **P1** blocks comprehension for a new user; **P2** major
friction in a core loop; **P3** polish. Where two or more investigators independently reported
the same gap the finding is marked **convergent** — independent discovery across separate
dispatches is the strongest signal in this review.

---

## 1. What held up (do not churn these)

- **Honest, value-free copy discipline almost everywhere** (ADR 0025): open-phase copy is
  human ("No file open" / "Opening…"), open completion announces via a polite live region and
  moves focus (`App.tsx:281-303`); export copy states the source is never rewritten
  (`ExportDialog.tsx:258-261`); validation/diff carry explicit stale banners.
- **The editing model is trustworthy at the cell level**: typed rejection keeps the editor open
  with a readable reason; unchanged draft = cancel; NULL is explicit; dirty cells tint
  (`DataGrid.tsx:66-88,296-312`). History has a single Undo/Redo pair with honest per-entry
  outcomes and a pre-truncation redo warning (`HistoryPanel.tsx:107-141`).
- **Filter pipeline honesty**: client-side rejection before engine round-trip, injective chips,
  SQL escape hatch preserved (`FilterBar.tsx:127-155,386-427`); the validation→grid
  "show only failing rows" bridge is reflected as removable chips everywhere filters live.
- **Zero states are the app's best help surface**: instructive idle copy in Validation, Diff,
  Profile, SQL (with copy-pasteable example and `kbd` hint), History.
- **A11y scaffolding is real**: complete 12-h2 map pinned in both layouts, dual-scheme axe with
  an empty allowlist, true modal focus trap, per-concern live regions, hardened grid keyboard
  model (uxc-1 fix resolving keydowns against the DOM target).
- **Nested-format power is one click**: STRUCT Flatten / LIST Explode offered in both the schema
  tree and grid headers, composed through a validated pure composer.

**The meta-pattern:** the app is _honest but silent_. Capabilities, state, and recovery paths
exist and are well-pinned — but are rarely _visible_ at the moment a user needs them. Most
findings below are affordance-visibility gaps, not engineering gaps.

---

## 2. Theme A — First run & open path

### UG-1 — The idle screen speaks internal roadmap, not onboarding `[P1]` **convergent** (A, D)

`App.tsx:1160-1169` renders `SCAFFOLD_STATUS` ("MVP complete (M0–M6)…"), `NEXT_MILESTONE`
("PT-0: launch readiness to gate G0 (then the D12-chosen engineering track)") and "Documentation
lives in `docs/` — start with `docs/process/handoff.md`" (constants `lib/app.ts:18-26`). This is
the _only_ screen a new user sees before opening a file, and it is written for repo maintainers:
milestone/gate/decision codes and a repo-relative path meaningless outside the checkout. The
three things an empty state owes the user — what the app does, what it opens, where to click —
are all absent. **Proposal:** idle state renders task-oriented copy only (one capability sentence

- supported formats + CTA); pins assert no milestone/roadmap/docs tokens in visible idle text.

### UG-2 — Supported formats are never communicated before open `[P1]`

The idle copy says nothing about formats; the picker passes no `accept` list
(`packages/data-sources/src/pick-file.ts:33-34,59`; hidden-input fallback `:83-105` sets none
either — **verified**). Format support first becomes visible _after_ a failed open
(`engine-executor.ts:481`). A user with `.tsv`/`.xlsx` discovers rejection by trial. **Proposal:**
list "Opens .parquet, .csv, .jsonl, .json" beside the Open button and pass a matching `accept`
map (with a `*/*` fallback so Linux dialogs still show all files); pin both.

### UG-3 — No way to try the app without a user file `[P1]`

No demo/sample entry point exists (`grep` over `apps/web/src`: none), while privacy-safe
synthetic golden fixtures ship in-repo (`fixtures/csv/customers.csv`, `fixtures/jsonl/events.jsonl`,
`fixtures/nested-json/messages.jsonl`, `fixtures/parquet/customers.parquet`). A first-time
evaluator without a dataset bounces off a single OS-dialog CTA. **Proposal:** "Try with example
data" loads one bundled synthetic fixture through the _unchanged_ `engineClient.open` chain;
e2e pins cold-open → ready grid.

### UG-4 — The .arrow/.feather story contradicts itself across layers `[P2]**

`@assay/data-sources` recognizes `arrow`/`feather` (`detect-format.ts:29-30`), the export dialog
offers Arrow IPC output, and the product pitch names Arrow — but the engine whitelist is
`parquet|csv|jsonl|json` ("arrow/feather: deferred", `format-view.ts:20` — **verified**) and
rejects with "unsupported dataset format". Being told "unsupported" _by the format the README
leads with_ is a trust break. **Proposal (cheap route):** close the discrepancy honestly — drop
arrow/feather from user-visible format copy or mark "export only" until an engine change lands;
pin that every extension `detectFormatFromFileName` maps to an engine-accepted format.

### UG-5 — Open failure surfaces the raw engine string with no recovery affordance `[P2]`

The catch block renders `error.message` verbatim into the `open-error` alert (`App.tsx:820-831`):
fine for unsupported extensions, raw DuckDB diagnostics for corrupt files; no retry button, and
the status span has already returned to "No file open" — failure and recovery live in different
sentences. **Proposal:** map the error class to a one-line human cause + "Choose a different
file…" retry button; raw detail behind a `<details>`; pin with a corrupt fixture.

### UG-6 — Open path is single-shot picker only: no drag-and-drop, no recents `[P2]**

Only ingress is `pickDataFile` (`App.tsx:690-698`); no `dragover`/`drop` handling exists anywhere
in `apps/web/src`; no recent-files store. For a workbench whose whole loop starts with "open",
the strongest learned gesture (drop a file on the window) is missing. **Proposal:** drop-anywhere
target routing through the identical open chain (same guards/identity); Playwright `DataTransfer`
test asserts `data-phase="ready"`.

### UG-7 — "Opening…" gives no progress and no cancel `[P3]`

One static string; the open chain is sequential (picker → `getFile` → engine open → schema →
count → model load) with WASM cold boot potentially ~20s (`bench-ttfr.spec.ts:56-62`), so first
run can look like a hang. **Proposal:** indeterminate progress affordance + cancel restoring idle
via the existing session-token guard; pin the cancel path.

---

## 3. Theme B — Grid & everyday workflow

### UG-8 — One-click Flatten/Explode executes into a hidden section — looks broken `[P1]` **convergent** (A, B)

`runNestedAction` only sets `sqlRequest` (`App.tsx:566-578` — **verified**); the SQL section
starts collapsed (initial `openSections` = `{'grid'}`, `App.tsx:338-341` — **verified**); bodies
stay mounted while `hidden`, and `SqlPanel` auto-executes on `seq` advance regardless of
visibility (`SqlPanel.tsx:170-174`). Net: the app's most discoverable power gesture (a button on
the column header) runs a query into an invisible subtree — the visible screen shows nothing.
This teaches users the app is unreliable, and quietly mis-teaches the mental model (it produces a
SQL-pane result, not a transformed view). **Proposal:** nested actions auto-open the SQL section
via the existing `openSection` seam, scroll into view, focus the result; e2e pins
click-Explode → SQL section visible with statement + result.

### UG-9 — Cell editing is invisible; the gesture users try first does something else `[P2]` **convergent** (A, B, D)

Edit gestures exist only as code comments ("double-click a cell, or focus a cell and press
Enter", `DataGrid.tsx:109-115`); repo-wide grep finds no user-facing hint. Worse, the natural
first gesture — a single click — opens the record dock instead (`DataGrid.tsx:620-628`). A user
who doesn't try double-click concludes Assay is a viewer and misses the entire overlay/undo/
export-changes value proposition. **Proposal:** persistent one-line hint ("Double-click a cell to
edit · Enter edits the focused cell · Esc cancels") wired as `aria-describedby` for the grid;
component + e2e pins.

### UG-10 — Undo/Redo are unreachable in the moment `[P2]`

The single pair lives in the collapsed History section (`HistoryPanel.tsx:64-90`; first paint
opens only the grid); grep confirms no Ctrl/Cmd+Z anywhere (`ctrlKey` only for SQL run). An edit
is one double-click away but reversing it requires knowing to open a different collapsed section
— "how do I back out?" is the first question every new editor asks. **Proposal:** document-level
Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z (and Ctrl+Y) wired to the existing handlers; first appended history
op badge-marks the History section. Keeps the ux-3 single-pair ruling intact (shortcuts, not a
second control pair).

### UG-11 — No way to copy a cell value anywhere `[P2]`

`grep -rn "clipboard|copy" apps/web/src` → only export wording; zero clipboard usage
(**verified**). A local-first data workbench that cannot put one cell's value on the clipboard
fails a table-stakes job ("grab this id"). Ctrl+C is unbound on focused cells. **Proposal:**
Ctrl/Cmd+C on a focused non-editing cell copies the display value and announces via the existing
live region ("Value copied."); user-initiated local copy keeps ADR 0025 intact.

### UG-12 — No visible row numbers; record dock titles by zero-based position `[P2]`

Rows render schema columns + optional actions only (`DataGrid.tsx:521-575,826+`); `aria-rowindex`
is invisible. The dock title is `row {state.rowIndex}` — zero-based (`RecordInspector.tsx:563`) —
so "row 5" names the 6th displayed row, nothing in the grid lets a user verify which record is
open, and there are no prev/next controls in the dock (`:566-595`). **Proposal:** sticky 1-based
row-number gutter matching the dock title (or explicit "0-based index" label); ◀ Prev / ▶ Next in
the dock; pin gutter↔title agreement.

### UG-13 — Focused cells have no guaranteed visible focus indicator `[P2]`

`moveGridFocus` calls `.focus()` on `role="gridcell"` divs (`DataGrid.tsx:433-439`); `index.css`
has three `:focus-visible` rules — nav link, pane toggle, `.grid-row-openable` — and **no**
`.grid-cell:focus` rule (grep **verified**). After the first arrow key, keyboard users may be
navigating on a ring that does not render. **Proposal:** explicit `.grid-cell:focus-visible`
outline rule + computed-style pin in the roving-tabindex spec (scroll-margin precedent).

### UG-14 — Profile stats are dead ends: nothing is click-to-act `[P2]`

Top-k values, null counts, and quantile bounds render as plain spans
(`ProfilePanel.tsx:189-233,256-257`), while the filter grammar already supports the obvious
predicates and programmatic `setFilters` is chip-reflected (uxc-4). Profiling is exactly the
"spot something odd → interrogate it" loop, and today every insight requires re-tracing to
Filters manually. **Proposal:** top-k click applies `= 'value'`; null-count click applies
`IS NULL`; chips visible; component pins + one e2e.

### UG-15 — Sort round-trips are silent `[P3]`

`cycleSort` sets only an error state on failure (`DataGrid.tsx:231-236`); no pending/busy state
exists for sort/filter epochs ("Sorting…"/`aria-busy`: zero hits) although loading rows already
dim (`index.css:515`). **Proposal:** in-flight `aria-busy` + footer status, cleared on settle.

### UG-16 — The expanded filter panel renders every column twice `[P3]`

Expanding Filters renders one builder row per column (`FilterBar.tsx:277-344`) _and_ one
SQL-fragment input per column (`:349-381`) — ~40 control rows at 20 columns. Collapse-by-default
fixed first paint, but opening Filters on a wide file recreates the UX-8 wall inside the
disclosure. **Proposal:** single "Filter on: [column ▾] [operator ▾] [value] [Apply]" compose row
(+ editable rows for active filters); fragment escape hatch behind its own disclosure.

### UG-17 — Collapsed filter summary hides _which_ filters are active `[P3]`

Collapsed state shows only a count (`Filters · 2 active`, `FilterBar.tsx:264`); chips render only
inside the open body (`:405-427`). The recommended posture (collapsed bar) hides the only
human-readable record of the constraints. **Proposal:** chips render beside the collapsed summary
("Filters · 2 active: salary, date") with per-chip removal; pin.

### UG-18 — Profile silently goes stale after edits `[P3]` **convergent** (B, C)

`ProfilePanel` consumes no `overlayRevision` and keeps its snapshot forever
(`ProfilePanel.tsx:388-393`; base-table op, `client.ts:519-527`), while validation and diff both
carry explicit stale banners. After a repair session, pre-edit numbers are presented as current —
in the one panel whose whole value is "what is true about this column". **Proposal:** state
"computed over the file as opened" + stale banner mirroring validation's until re-run.

### UG-19 — Edit gestures on still-loading rows are silently dropped `[P3]`

`beginEdit` early-returns with no feedback when the slot isn't ready (`DataGrid.tsx:252`) — the
editing sibling of the fixed uxc-2 record-inspector defect. A fast double-click after a scroll
sometimes "does nothing". **Proposal:** queue the gesture to open once ready (or drop visibly
with status), pinned mirroring uxc-2.

### UG-20 — Export never mentions the staged changes it will include `[P3]**

The dialog says "complete edited dataset" (`ExportDialog.tsx:288-296`) but nowhere counts pending
ops; the count lives in the collapsed Editing section. Export is the real commit — an unstated
"you are taking your 3 staged changes with you" invites surprise. **Proposal:** "Includes N
staged change(s) — review in History" (0 ⇒ no line); pin across 0/1/N.

---

## 4. Theme C — Cross-surface journey coherence

Verdict: the journey is _coherent but not guided_. Panels are individually honest; the
validation→filter→grid bridge is real and reflected everywhere. But artifacts don't flow between
surfaces, results don't surface on collapsed toggles, and two cross-surface gestures complete
visually but not for keyboard/screen-reader users.

### UG-21 — The Pipeline panel is an island `[P2]**

`usePipelineSession` receives no reference to the open dataset or loaded contract
(`App.tsx:461`); source and contract binding always go through a fresh `pickDataFile()`
(`usePipelineSession.ts:358-360,404-406`). OPEN → VALIDATE → PIPELINE forces re-picking the same
files from the OS dialog with no indication they're the same artifacts. **Proposal:** binding
offers "Use the open dataset" / "Use the loaded contract" first; completing both bindings
requires no OS picker.

### UG-22 — "DCR" jargon surfaced raw, never expanded `[P2]**

"Export the DCR artifact" / "Exported the DCR artifact (…)" (`PipelinePanel.tsx:1087,1168`;
`dcr-export.ts:495`); nothing in `apps/web` expands the acronym or says what the artifact is
_for_ (a reviewable change proposal). **Proposal:** first mention reads "Dataset Change Request
(DCR)" plus one purpose sentence; text pin asserts no bare "DCR" precedes the expansion.

### UG-23 — The overlay-editing model is never stated where editing happens `[P2]` **convergent** (C, B)

The Editing section renders only "Insert row" + "N pending changes…" (`EditToolbar.tsx:26-30`);
the one explicit "Assay never rewrites the source" statement lives inside the on-demand export
modal (`ExportDialog.tsx:258-261`). A user editing cells has no in-context reason to know edits
are a session overlay — exactly the product's core trust claim (ADR 0012). **Proposal:** standing
line in the Editing section while a dataset is open ("Edits are staged in this session; the
opened file is never modified. Export writes a copy."); unit pin.

### UG-24 — A validate-gate failure dead-ends: count without a path to the failing rules `[P2]**

The gated detail says "The contract failed N rules (rule values are never surfaced). Bind a
passing contract and re-run." (`PipelinePanel.tsx:753-756`) while the per-rule detail exists in
Validation — but nothing links them, and bindings are per-surface (UG-21), so the user must
re-pick contract + dataset in another panel to learn _which_ rule failed. **Proposal:** "Inspect
this contract in Validation" cross-link; pinned verdict naming the failing ruleIds.

### UG-25 — Edit-domain error copy leaks into validation and diff `[P3]`

`engineRejectionMessage` hard-codes "The engine rejected this **edit**… The previous view is
unchanged." (`edit/session.ts:122-124`) but is reused by read-only sessions
(`useValidationSession.ts:199`; `useDiffSession.ts:156,219`), producing nonsense like
"**Validation failed:** The engine rejected this **edit**…". **Proposal:** shared per-operation
message helper; validation/diff/staging text never contains "edit" and names what was not
changed.

### UG-26 — Jump-to-row completes visually, not for keyboard/screen-reader users `[P3]**

The validation/diff "Show row" gesture scrolls the grid and opens the dock (`App.tsx:385-394`)
but never moves focus (`DataGrid.tsx:379-398`), the dock deliberately doesn't steal focus, and no
announcement fires — the view moved with no cue for non-pointer users. **Proposal:** polite
announcement ("Showing base #12 in the grid and record inspector") + roving focus lands on the
target row; e2e pin.

### UG-27 — Collapsed sections hide results: no state summaries in the tool rail `[P3]`

`WorkbenchSection` renders a static label (`App.tsx:240`); after a failing validation run nothing
on the rail says so. The idiom already exists one level down ("Filters · 2 active").
**Proposal:** optional summary slot fed from session state ("Validation · 2 failing", "Compare ·
3 changed", "History · 4 pending"), visible collapsed.

### UG-28 — Validation requires an artifact the app never helps produce `[P3]**

Zero state: "No contract loaded. Open a contract YAML…" (`ValidationPanel.tsx:233`) — no sample,
no docs link, no generate action, though the native format (ADR 0013) is trivially derivable
(declared types, row bounds). First contact with VALIDATE is a dead end without hand-authored
YAML. **Proposal:** starter-contract download for the open dataset (existing report-export path)
or a docs link, from the zero state.

### UG-29 — "Show only failing rows" silently replaces active filters `[P3]**

The bridge replaces the filter list wholesale (`useValidationSession.ts:249`, comment at `:234`)
but the control's copy never says so (`ValidationPanel.tsx:402-406`). Carefully built filters
vanish without notice. **Proposal:** when filters are active, the control states the replacement
("Replaces the current 2 filters"); pin.

### UG-30 — Error-copy conventions vary per surface `[P3]`

Raw `error.message` in open/SQL/profile/filter (`App.tsx:829`, `SqlPanel.tsx:100,268`,
`ProfilePanel.tsx:424`, `FilterBar.tsx:437`) vs wrapped first-line-reduced in edits and export.
The same engine failure reads polished in one panel and raw (multi-line SQL) in the next.
**Proposal:** one first-line-reducing summary helper with per-panel framing; unit pin that
open/SQL/profile/filter render single-line messages.

---

## 5. Theme D — Shell, navigation, help & failure containment

### UG-31 — One panel crash white-screens the whole session `[P2]`

Only two error boundaries are wired (app root + grid; `ErrorBoundary.tsx:8-15` — **verified**).
The ten other panels render bare, so a `DiffPanel` render throw bubbles to the _app_ boundary →
"Reload the page… Any unsaved edits… are lost". **Proposal:** `scope="panel"` boundary per
tool-pane section body with "Try again" (remount that panel only) + "Close section"; component
test throws in a mounted panel and asserts the grid and pending-changes summary survive.

### UG-32 — Grid-boundary recovery is the most destructive option, stated after the fact `[P2]**

Fallback offers only `window.location.reload()` with the loss disclosed in the same sentence
(`ErrorBoundary.tsx:37-40,87-93`), though the engine session and overlay refs often survive a
React-local failure. **Proposal:** primary "Try again" (in-place remount preserving the session),
"Reload the workbench" secondary; copy states the trade-off _before_ any click; mutation-tested.

### UG-33 — Grid keyboard gestures are undiscoverable; no shortcut help surface `[P2]` **convergent** (B, D)

Enter's mode-dependent meaning (cell → editor; row → inspector), arrows/Home/End — all exist
only in code and spec files; no shortcut listing, no `aria-keyshortcuts`, no "?" affordance
(the SQL pane is the only surface documenting its keys). Keyboard-only users can pass through
the app but cannot _learn_ it without reading source. **Proposal:** "Keyboard" section in the
existing grid footer `<details>` (`DataGrid.tsx:948`) listing edit/inspect/navigate keys;
optionally `aria-keyshortcuts` per region; pin.

### UG-34 — After open, the user faces 11 collapsed nouns with no guidance `[P2]` **convergent** (A, D)

First paint expands exactly the grid; the workflow-critical Export and Validation controls are
invisible collapsed `hidden` bodies; single-noun titles carry no purpose; the post-open
announcement carries only row/column counts. Nothing distinguishes "Export (you'll want this)"
from "Pipeline (advanced)". **Proposal:** one-line purpose subtitle per collapsed section (e.g.
"Check the data against rules" under Validation) or a dismissible "Filter → Validate → Export"
next-steps strip whose links expand+scroll; pin visible post-open without user expansion.

### UG-35 — The "Record" nav entry is a dead end until a row is opened `[P3]**

The nav always lists Record (`App.tsx:128`); the dock returns `null` when closed
(`RecordInspector.tsx:501`), so the anchor scrolls to an empty box; the label itself is ambiguous
(spreadsheet-trained users may read "create a record"). **Proposal:** closed-state value-free
hint ("Select a row to inspect it here — press Enter or double-click a row."); one name agreed
across title/aria-label/nav.

### UG-36 — Tool-pane reading order doesn't match the mental loop `[P3]`

DOM/pane order is schema → editing → export → history → validation → compare → filters → …
(`App.tsx:916-1040`), so "why do my rows look like this?" requires scanning past three
write-oriented panels to reach Filters eighth. The q-15 placement ruling bars DOM reordering —
but the nav list is explicitly decoupled from DOM order (`App.tsx:109-116`). **Proposal
(nav-only, cite the ruling):** sticky-nav reading order becomes schema, filters, grid,
validation, compare, sql, editing, history, export, record, profile, pipeline — a pure
`WORKBENCH_SECTIONS` array edit with updated heading-map pins.

### UG-37 — Sub-AA text tokens persist in empty states the axe scans never reach `[P3]**

`--color-text-faint` (#777, 4.29:1 per the repo's own comment, `index.css:992`) is used by
`.sql-result-empty` (`:1084`) and profile empty strips (`:1320`); `--color-text-placeholder`
(#889, ≈3.5:1) by `.record-value-null` (`:644-647`) — quiet explanatory lines are the
hardest-to-see text on screen, in surfaces the dual-scheme scans don't drive. **Proposal:** move
the four rules to a ≥4.5:1 token (`.filter-empty` precedent, `:990-995`) and add one scanned
zero-result state to `a11y.spec.ts`.

---

## 6. Code observations (non-UX riders found during investigation)

- **CO-1** — `App.tsx` comment at the `usePipelineSession` call site still says pipeline outputs
  "jump … into the SQL pane's result surface"; p2-6 made previews grid-native. Stale comment.
- **CO-2** — FilterBar chip React key is a non-injective `column:predicate` join
  (`FilterBar.tsx:408`); two identical predicates on one column collide.
- **CO-3** — Pane-toggle accessible name duplicates the nav's "Workbench sections"
  (`App.tsx:894` vs `:902`).
- **CO-4** — Pending-changes summary surfaces the domain term "row expunge"
  (`edit/op-summary.ts:28`); consider a plain-language gloss next time the string is touched.
- **CO-5** — `useDiffSession`'s B-side transient open remains the recorded PT-H engine
  carry-over (tables not releasable per-action); staging several comparisons in one session
  compounds memory pressure. Track on the engine ledger, not here.

---

## 7. Prioritization

**Batch 1 — trust repair (small, isolated, highest ratio of pay-off to risk):**
UG-8 (hidden SQL result — the app's flagship gesture reads as broken), UG-1/UG-2/UG-3 (the idle
screen as a user contract: capability + formats + example data), UG-31/UG-32 (crash containment:
a panel crash must not cost the session).

**Batch 2 — make the core loop visible:** UG-9 + UG-33 (editing/keyboard language on-screen),
UG-10 (undo/redo shortcuts), UG-11 (cell copy), UG-23 + UG-20 (say what the overlay does, at the
moment of edit and of export), UG-34 (post-open guidance).

**Batch 3 — journey coherence:** UG-21 + UG-24 (pipeline as continuation of validate), UG-22
(DCR expansion), UG-18 (profile staleness), UG-27 (state summaries on the rail), UG-12 (row
identity), UG-13 + UG-26 (keyboard focus/announcement completion).

**Batch 4 — polish:** everything marked P3 not already above (UG-4…UG-7, UG-14…UG-17, UG-19,
UG-25, UG-28…UG-30, UG-35…UG-37) plus riders CO-1…CO-4.

**Execution:** actionable rows with done-whens, lanes, and standing constraints live in the
companion queue [handoff/20261026-usability-queue.md](../process/handoff/20261026-usability-queue.md)
— dispatch from there, not from this review.

---

## 8. Provenance

- Investigator dispatches: 4 × `glm-flash-worker` (`zai/glm-5.3-flash`), parallel, read-only,
  2026-10-26; areas as named in §Method; all four succeeded.
- Orchestrator verification (before publication): idle JSX (`App.tsx:1140-1170`), nested-action
  path (`App.tsx:560-585,331-345`), picker options (`pick-file.ts`), boundary census
  (`ErrorBoundary.tsx`), clipboard grep, `.grid-cell:focus` grep, engine whitelist
  (`format-view.ts:20`) — all claims quoted above were confirmed in-tree.
- Standing constraints respected by every proposal: ADR 0025 (value-free copy, no filenames),
  ADR 0012 (overlay, never in-place), ADR 0044/D14 (no DOM reorder), ux-3 single Undo/Redo pair,
  dual-scheme axe floor with empty allowlist, no new telemetry, engine contracts unchanged.
