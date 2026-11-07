# Workbench redesign — rd-0…rd-2 design record

**Authored:** 2026-11-04. **Scope:** the rd-0…rd-2 design checkpoint authorized for this episode: read-only discovery, two isolated prototypes and a usability protocol/design selection. **No production runtime, dependency, ADR, release or publication change was made.** No participant session was run — see §4.6 and the [usability protocol](../process/handoff/20261104-rd2-usability-protocol.md).

**Read with:** [stack/UX review](12-workbench-redesign-review.md) (requirements **RD-R01…RD-R08**, acceptance **RD-T01…RD-T08**), [live implementation map](../process/handoff/20261104-svg-implementation-map.md), [conservative specification](11-svg-implementation-spec.md), [pickup prompts](../process/handoff/20261104-svg-pickup-prompts.md), [SVG capability inventory](../../assests/svg/README.md), and the prototypes in [`assests/prototypes/`](../../assests/prototypes/README.md).

**Status vocabulary used here:** a **recommendation** is this checkpoint's proposed design; **OPEN** means a maintainer decision is required before runtime; **BLOCKED** means a named dependency is unresolved. This document cannot itself approve a design, an ADR or an implementation.

---

## 0. Decision summary (for the reader in a hurry)

| Question                         | Recommendation                                                                                                                                                                                                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Route (SV-D08)                   | **B — bounded task-led redesign on the existing React/TypeScript/Vite stack**, delivered in two reversible slices (rd-3 structure, rd-4 repair/recheck journey). Keep A (incremental navigation) as the explicit fallback and as the fallback path if the study fails.                           |
| Information architecture         | Four user goals — **Explore, Check, Change, Prepare** — as a single-select task strip in the existing tools-left pane, beside the unchanged persistent grid and record dock. One task's sections visible at ≥1024px; every section stacked and reachable at <1024px.                             |
| What changes                     | Presentation/navigation only: task framing (active-task marking + its manageable sections opening), one persistent dataset/context bar with one next action, task-aware section reveal (close-focus behaviour preserved), and two honesty copy corrections. Conditional hiding is deferred (§9). |
| What does **not** change         | Session hooks, engine/worker, grid/provider/virtualization, logical row identity, overlay/history semantics, validation/diff/report bytes, export dialog and bytes, profile scope, CLI/VS Code surfaces, telemetry, dependencies, ADRs.                                                          |
| Evidence produced here           | rd-0 source-qualified friction inventory, two keyboard-operable isolated prototypes with the full J2 journey, a moderator protocol with provisional thresholds, a heuristic walkthrough with its limits, and an exact migration/test/rollback plan.                                              |
| Evidence still missing           | Any human usability result, any AT review, any candidate built-app run, and the J2/J3 study fixtures.                                                                                                                                                                                            |
| What must be decided before rd-3 | SV-D08 route + IA, a new UI ruling for the grouping/visibility/heading/focus contracts, copy approval, and an explicit rd-3/rd-4 runtime scope (**SV-D01**).                                                                                                                                     |

---

## 1. rd-0 — established baseline

### 1.1 Working tree, revision and pack availability

Inspected in this checkout on 2026-11-04, without cleaning, stashing, staging or committing anything:

| Item                  | Observed state                                                                                                                                                                                                                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HEAD                  | `bba491ad47941eea233b5174eb4284370676323d` on `main`; no branch created, no commit made by this checkpoint.                                                                                                                                                                                                                      |
| Uncommitted user work | `docs/process/handoff.md` (+2 lines: the SVG-follow-on "planning only" paragraph) — preserved byte-for-byte.                                                                                                                                                                                                                     |
| Untracked pack        | `assests/` (17 SVG boards + `README.md`), `docs/product/11-svg-implementation-spec.md`, `docs/product/12-workbench-redesign-review.md`, `docs/process/handoff/20261104-svg-implementation-map.md`, `docs/process/handoff/20261104-svg-pickup-prompts.md` — all present, none modified except by the additive files listed in §7. |
| Worktree isolation    | Not used. An isolated worktree at `bba491a` would omit the uncommitted pack, so discovery ran in the authoring checkout, matching the map's instruction.                                                                                                                                                                         |
| Node / pnpm           | Node `v24.13.0`; repository-pinned pnpm `11.26.0` via corepack.                                                                                                                                                                                                                                                                  |
| Telemetry environment | `ASSAY_TELEMETRY_ENDPOINT`, `ASSAY_TELEMETRY_TOKEN`, `ASSAY_NO_TELEMETRY` unset for the bounded check (names only; no values recorded).                                                                                                                                                                                          |

### 1.2 Fresh observation vs reused historical evidence

**Freshly observed (bounded, this checkout):**

- `pnpm typecheck` → exit **0** (turbo reported 20/20 tasks, all cached).
- `pnpm exec vitest run --project web` → **103 test files / 1057 tests passed** (the `web` Vitest project only).
- Prototype smoke: both prototypes loaded from `file://` in headless Chromium, scripted through their scenario/step controls with **zero page errors and zero console errors**; the task strip's arrow-key roving worked. Screenshots are inspection artifacts in `/tmp/assay-rd0/`, not committed evidence.

**Explicitly not claimed as fresh:** lint, format check, build, e2e/Playwright, coverage, docs-links, ADR-index, desktop/CLI harnesses, or any remote CI result. The historical counts in [`handoff.md` §2](../process/handoff.md) (3441 unit / 219 e2e / coverage 89.19/83.90/91.47/90.78 at `fc6fd0f`) are **historical evidence**, not this tree's baseline. A runtime slice must establish its own full gate baseline per the map §6 before claiming anything.

This is a red-gate-free but partial baseline; it is sufficient for design work and insufficient for a merge claim.

### 1.3 Current composition (source-verified)

| Layer               | What exists today                                                                                                                                                                                                                                                                                                                                                                                                                                        | Source                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| App composition     | One `App` (2132 lines) owns the dataset phase, session-token guards, the open chain, section visibility, pane collapse, record request, export open state, SQL request ledger, profile-filter single-flight and the document-level undo/redo shortcuts. Hooks are called unconditionally at top level.                                                                                                                                                   | `apps/web/src/App.tsx`                                                                                    |
| Shell               | `h1` + tagline + telemetry settings + open flow, then a two-pane layout ≥1024px: sticky tools-left pane and a center column whose only permanent artifact is the grid, with the record dock below it. Below 1024px the same DOM becomes a stacked column via `display: contents` + `order`.                                                                                                                                                              | `App.tsx:1755–2130`, `index.css` `@media` blocks                                                          |
| Tool pane           | A 12-link sticky nav (`schema, filters, grid, validation, compare, sql, editing, history, export, record, profile, pipeline`) followed by 12 sections whose **DOM order differs** from the nav order (`schema, editing, export, history, validation, compare, filters, sql, profile, pipeline`, then `grid`, `record` in the center).                                                                                                                    | `App.tsx:181–257` (comment and array), `:1783–1800`, `:1814–2124`                                         |
| Section disclosure  | `WorkbenchSection` renders a `<section id="section-<id>">`; managed sections have one toggle with `Collapse/Expand <Title>` as the accessible name, a purpose subtitle as description and an optional state summary; the body is `hidden={!open}` but **children stay mounted**. Schema/Filters/Profile own their inner disclosure; Record is always open in the dock.                                                                                   | `App.tsx:386–482`, `:216–220`                                                                             |
| Default first paint | `openSections` starts as `{'grid'}`; Schema's own disclosure is open. Every other tool section is collapsed.                                                                                                                                                                                                                                                                                                                                             | `App.tsx:654–656`                                                                                         |
| Editing session     | Owns history, overlay revision, overlay ref, cast pending/race revision, view error and edit announcements; every op/undo/redo/cursor move calls `activateHistory`, which bumps `overlayRevision` **including for a logged no-op**.                                                                                                                                                                                                                      | `sessions/useEditingSession.ts:118`, `:162–205`, `:225–275`                                               |
| Validation session  | Owns contract state, run state, generation counter, jump/filter errors. A finished run stores **`{report, revision}` only**; freshness is derived (`run.revision !== overlayRevision`). No operation count, session token or origin metadata is captured.                                                                                                                                                                                                | `sessions/useValidationSession.ts:57–77`, `:139–141`, `validation/ValidationPanel.tsx:76–93`              |
| Diff session        | Owns comparison state, B file handle, run state, key mode. The finished report records `revision` and a coarse `baseViewOnly` boolean computed at run time; it does not record which operations ran.                                                                                                                                                                                                                                                     | `sessions/useDiffSession.ts:117–119`, `:207`, `diff/diff-model.ts:118–138`                                |
| Pipeline session    | Owns pipeline file bindings and run state; the only hook that snapshots run-time session state (a gated run carries its contract snapshot so a later rebind cannot rewrite attribution).                                                                                                                                                                                                                                                                 | `pipeline/usePipelineSession.ts`, `pipeline/pipeline-state.ts:181–195`                                    |
| Dataset lifetime    | `useDatasetSession().beginSession()` bumps the session token **first**, then runs registered resets in registration order; the open chain re-checks the token after every `await`. Section visibility is **not** reset by a new dataset (only `recoveryHiddenSections` is).                                                                                                                                                                              | `sessions/session-reset.ts:49–82`, `App.tsx:1375–1510`                                                    |
| Panels              | Validation: `Open a contract…`, `Validate`/`Validating…` + `Cancel`, verdict sentence, stale paragraph (text only), 9-rule `<ol>`, bounded samples with `Show row`, `Show only failing rows` (eligibility + replacement note). Diff: A/B staging, schema first, key confirmation, `Run row diff`, A-only `Show row`, stale paragraph. Export: custom modal with its own trap; cannot close while writing; whole-effective-dataset and staged-count copy. | `validation/ValidationPanel.tsx:264–508`, `diff/DiffPanel.tsx:409–697`, `export/ExportDialog.tsx:133–310` |
| Grid / record       | Virtualized grid with a 1-based row-number gutter, roving cell focus, double-click/Enter cell editor, logical row identity, a single polite live region; the record dock opens on row activation and returns focus to the row on Escape.                                                                                                                                                                                                                 | `grid/DataGrid.tsx`, `record/RecordInspector.tsx`                                                         |
| Help                | Grid-local `Keyboard` disclosure plus the telemetry Settings dialog; there is no global Help surface and no shortcut editor. This is existing scope, not a defect.                                                                                                                                                                                                                                                                                       | `grid/DataGrid.tsx:1386`, `telemetry/TelemetrySettings.tsx`                                               |

**Corrections to the review's own assumptions (verified against source):**

1. The review's "run origin was inferred from insufficient state" is correct for validation. It is slightly incomplete for diff: `DiffReport` already records a coarse `baseViewOnly` flag at run time. Do not write "no origin metadata exists anywhere".
2. The stale banner says "the dataset changed after it was computed". Because `overlayRevision` bumps on every history activation — a logged no-op entry (`packages/domain` history logs no-ops; `edit/session.ts:424` activates the new history unconditionally), **undo/redo, and a selective cursor move** — so neither "changed" nor "a staged operation happened" is guaranteed, and even "an earlier dataset view" implies different data. The honest wording is about the session's staged state and a possible (not certain) divergence; see §2 F5.
3. `Validation`'s stale banner has **no rerun control**; the rerun is the panel's primary `Validate` button. "Explicit rerun" is true of the model, not of a single in-banner affordance.
4. The heading map is exposed only while a section's body is open. The existing contract is therefore already conditional, which makes per-task heading exposure a smaller change than it first appears.
5. `Show row` announces the display key through the single polite region and opens the record dock, but nothing records the jump origin. A return path is genuinely absent, not merely hidden.

### 1.4 Concrete UX friction inventory (J2-led)

Severity is a design judgement, not a measured usability result.

| ID  | Friction                                                                                                                                                                                                                                                                                                               | Evidence                                                                               | Affects |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------- |
| F1  | Twelve equal-weight peers, and the nav reading order differs from the pane's DOM order. A user must learn two orders before the toolset makes sense.                                                                                                                                                                   | `WORKBENCH_SECTIONS` vs JSX order; ug-22 deliberately decoupled them.                  | J1–J4   |
| F2  | The next useful action after a repair is not visible where the repair happened. Stale lives in the Validation panel (collapsed by default) and in a collapsed section summary; the grid shows only a dirty cell.                                                                                                       | `App.tsx:654`, `ValidationPanel.tsx:430–435`, `activeOps` summary in `App.tsx`         | J2      |
| F3  | A finding jump loses its origin. `Show row` scrolls/selects/opens the record dock but no return affordance exists.                                                                                                                                                                                                     | `App.tsx:846–859`, `ValidationPanel.tsx:484–490`                                       | J2, J3  |
| F4  | The repair affordance is grid-local (double-click/Enter); the Editing section contains only `Insert row` + a pending summary; nothing links a failing sample to the cell that must change.                                                                                                                             | `edit/EditToolbar.tsx`, `grid/DataGrid.tsx`                                            | J2      |
| F5  | Stale copy overclaims. `overlayRevision` bumps on no-op entries, undo/redo and cursor moves, so "the dataset changed" and "a staged operation happened" can both be false, and even "an earlier dataset view" implies different data. The honest statement is that the session's staged state changed after the check. | `useEditingSession.ts:194–205`, `ValidationPanel.tsx:431–434`, `DiffPanel.tsx:694–696` | J2, J3  |
| F6  | Default first paint exposes only the grid; the toolset is discoverable only through the 12-link nav.                                                                                                                                                                                                                   | `App.tsx:654–656`                                                                      | J1–J4   |
| F7  | Counts can appear in three places at once if a context bar is added naively (section summary, panel verdict, bar).                                                                                                                                                                                                     | ug-17 summaries + verdict                                                              | J2      |
| F8  | No global Help, and the Ctrl/Cmd+Z path is document-level while the grid owns cell editing. Both are deliberate; a redesign must not "fix" them by adding a wizard or a second shortcut system.                                                                                                                        | `grid/DataGrid.tsx:1386`, `App.tsx:878–899`                                            | J1–J4   |
| F9  | The narrow layout is one DOM plus CSS `order`; any grouping wrapper must stay `display: contents` or the stack reorders.                                                                                                                                                                                               | `index.css` `max-width: 1023px` block                                                  | all     |
| F10 | All panels are already mounted. Task switching must not remount them, or filter drafts, SQL text, contract text and B staging are lost.                                                                                                                                                                                | `App.tsx:481` (`hidden={!open}` on the body)                                           | J2–J4   |
| F11 | The failed-apply rollback/reseed and the double-failure copy are load-bearing existing behaviour; a redesign must not "clean them up" into draft retention without a separate decision.                                                                                                                                | `grid/FilterBar.tsx:295–336`                                                           | J1, J2  |
| F12 | Safe replacement of a dirty dataset is not protected today (no guard). This is a decision (**SV-D03**), not a redesign side effect; the redesign must not imply autosave.                                                                                                                                              | `App.tsx` open flow                                                                    | J4      |

### 1.5 Existing contracts the redesign must renegotiate deliberately (not silently)

| Contract                                                                    | Where pinned                                                                                                              | Why the recommendation touches it                                                                                                                                                       |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR 0044 two-pane shell: tools-left, grid center, record dock, 1024×700 min | `docs/adr/0044-workbench-shell-two-pane.md`; D14; q-15 queue                                                              | The recommendation keeps all four; no superseding ADR is needed if it stays inside them.                                                                                                |
| DOM section order frozen; nav order loose                                   | `App.shell.test.tsx` (`DOM_ORDER`, `NAV_ORDER`), `shell.spec.ts` heading map/DOM order                                    | Grouping sections into task scopes changes section DOM order (deliberate; narrow CSS order restored).                                                                                   |
| Complete heading map while sections are open                                | `App.headings.test.tsx`, `shell.spec.ts`                                                                                  | Per-task visibility makes the exposed map a subset; a per-task map must replace it.                                                                                                     |
| R-14 purpose subtitles, no rename, Record closed hint                       | `App.section-purposes.test.tsx`, `App.section-summaries.test.tsx`                                                         | Kept verbatim; summaries kept, plus a "no copied count in the context bar" rule.                                                                                                        |
| R-07 close-section keyboard focus goes to the section's nav link            | `App.shell.test.tsx` / `a11y-keyboard.spec.ts`                                                                            | **Kept:** each task keeps a task-scoped section link list, so every section still has its `section-nav-<id>` target; the close-focus path and the panel-failure boundary are unchanged. |
| R-11 compact header / grid viewport clamp                                   | `shell-geometry.test.ts`, `shell.spec.ts` geometry + first-paint legs                                                     | A context bar must live inside the center column so the ≤140px ready-top budget is not re-opened.                                                                                       |
| Keyboard/modal contracts                                                    | `App.history-shortcut.test.tsx`, `TelemetryDisclosure.keyboard.test.tsx`, `ExportDialog.test.tsx`                         | Unchanged; the task strip adds no document-level shortcut and no second modal.                                                                                                          |
| Data-semantics suites                                                       | `validation/*`, `diff/*`, `export/*`, `profile/*`, `grid/filter-builder.test.ts`, `sessions/*`, `App.memo-probe.test.tsx` | Only presentation may change; all of these must stay green without weakening assertions.                                                                                                |

---

## 2. rd-1 — two prototypes

Both artifacts are single self-contained HTML files with synthetic data, no engine, no network and no telemetry. They are **design probes**, not screenshots of the product and not evidence of usability. Scenario data differs slightly between them (illustrative rows/values); the tasks, state model and journey steps match.

**A — incremental navigation** — [`assests/prototypes/rd-nav-a.html`](../../assests/prototypes/rd-nav-a.html)

Keeps the current composition exactly: same 12 sections, same pane DOM order, same 12-link nav, same headings, same collapsed-by-default behaviour. Adds only:

1. a compact **dataset context bar** above the grid (`Current dataset view · <file> · rows × columns · N staged operations`) with one next-action slot;
2. **nav grouping labels** (Explore / Check / Change / Prepare) over the existing anchor links, plus a `Workspace: Grid · Record` line — plain anchors, no tab roles;
3. a **Back to findings** chip after a `Show row` jump;
4. a shell-level **next-action state machine** that never auto-runs: no contract / loaded-not-checked / failing / stale / valid / comparison stale.

**B — task-led workbench** — [`assests/prototypes/rd-task-led-b.html`](../../assests/prototypes/rd-task-led-b.html)

Keeps the persistent grid and record dock; changes the pane's information architecture:

1. a **single-select task strip** (ARIA `radiogroup`, roving tabindex, ←/→/Home/End) for Explore / Check / Change / Prepare, with a one-line purpose; state is carried by the context bar and the existing in-pane section summary, not by a per-task badge;
2. **one task's sections visible at a time** at ≥1024px; every section stays mounted (grouping wrappers are `display: contents`), so drafts/results/overlay survive a switch;
3. the same **context bar**, with the same next-action states, placed beside the data;
4. **task-aware reveal** (a nested action, pipeline cross-link or close-focus request activates the owning task first);
5. **narrow mode** (<1024px) keeps every section stacked in the documented slice-1 order — the strip becomes a jump list and nothing is filtered, so ADR 0044's narrow contract is unchanged.

Both prototypes include scenario buttons (six states), a seven-step J2 walkthrough, keyboard-only operation, recovery states (validation busy + Cancel, export working state where Escape is inert, same-source refusal copy, stale/empty verdicts) and an honest scope panel.

### 2.1 The J2 journey in each alternative

| Step | Current shell (source)                                                                                       | A — incremental                             | B — task-led                                                        |
| ---- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------- |
| 1    | Scroll to / expand Validation, load a contract                                                               | Same, plus nav grouping makes Check obvious | Task strip → Check; Validation is the first section                 |
| 2    | Click `Validate`; read verdict                                                                               | Same                                        | Same; the context bar mirrors the state                             |
| 3    | `Show row` → grid scrolls, record dock opens                                                                 | Same + `Back to findings`                   | Same + `Back to findings`; Check stays active                       |
| 4    | Double-click/Enter the cell, type, commit                                                                    | Same                                        | Same; the Edit hint and grid stay in the center                     |
| 5    | Go back to Validation to see the stale banner (the collapsed summary keeps the failing count, not staleness) | Context bar names stale beside the grid     | Same; the context bar states stale beside the grid wherever you are |
| 6    | Find `Validate` again and click                                                                              | `Recheck` in the context bar                | `Recheck` in the context bar                                        |
| 7    | Expand Export, open the dialog, review whole-dataset copy                                                    | Same                                        | Switch to Change → History/Export                                   |

### 2.2 What both alternatives preserve (and what the prototypes only sketch)

- Overlay model, history cursor, undo/redo, no source writes, whole-effective-dataset export and its custom modal, CSV protection, Arrow interchange disclosure.
- Overlay/history/validation/diff/pipeline session ownership; no new engine call, no automatic check, no auto-repair.
- File-as-opened profile scope; SQL page ≠ total; comparison A/B staging; a bounded sample ≠ the full failing set.
- The grid, provider and record-dock model; the record dock remains the only full-record surface.
- One Undo/Redo pair; document-level Ctrl/Cmd+Z with native text undo preserved; the telemetry disclosure/settings lifecycle.

The prototypes do **not** prove engine behaviour, real grid keyboard routing, performance, focus management inside production components, or dark/narrow semantics under the production stylesheet. Those require the built slice.

### 2.3 Heuristic walkthrough result (not human evidence)

The structured walkthrough (protocol §7) found seven design faults that were fixed in the prototypes and carried into the recommendation:

1. stale needs an action, not just a sentence;
2. a finding jump needs a return path;
3. grouping must not hide the state — hence a context bar that names the consequence and the action without copying the count, plus the existing local section summary and the panel verdict;
4. the default task must show a real tool section, not an empty pane;
5. a task switch must not steal focus; only keyboard activation moves focus to the strip, and reveal-by-action focuses the revealed target;
6. filtering the task strip at narrow would violate ADR 0044's narrow stack — so narrow stays unfiltered;
7. the existing Export dialog is already honest — do not turn delivery into a wizard.

It also records what only participants can settle: task names, whether the context bar reads as status vs banner, discovery of the strip versus the section list, and whether the stale action beside the grid is found before the panel's own banner.

---

## 3. rd-2 — recommended information architecture

### 3.1 Recommended IA (alternative B)

```text
┌ Assay · The local-first data workbench ───────────────────── Settings · Open a data file… · rows × cols ┐
│                                                                                                          │
│  ┌ tools pane (≥1024px) ─────────────┐   ┌ center column (persistent) ──────────────────────────────┐   │
│  │ [◂ collapse]                      │   │ Current dataset view · 12 rows × 10 cols · 1 staged       │   │
│  │ Explore │ Check │ Change │ Prepare│   │ operation            [state text] [next action] [Back…]    │   │
│  │ one-line task purpose             │   ├───────────────────────────────────────────────────────────┤   │
│  │                                   │   │ Grid — the artifact (unchanged internals)                  │   │
│  │ active task's sections only       │   │ …                                                          │   │
│  │ (all mounted; inactive hidden)    │   ├───────────────────────────────────────────────────────────┤   │
│  │                                   │   │ Record inspector dock (unchanged)                          │   │
│  │ Workspace: Grid · Record anchors  │   └───────────────────────────────────────────────────────────┘   │
│  └───────────────────────────────────┘                                                                   │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Membership (every existing tool stays reachable):**

| Task        | Sections (in this order)      | User goal                                                           |
| ----------- | ----------------------------- | ------------------------------------------------------------------- |
| **Explore** | Schema, Filters, SQL, Profile | Understand what is in the file; investigate a suspicious value.     |
| **Check**   | Validation, Compare           | Find quality issues or explain differences between versions.        |
| **Change**  | Editing, History, Export      | Make a reversible repair, review staged operations, deliver a copy. |
| **Prepare** | Pipeline                      | Run deterministic steps; inspect gate and delivery evidence.        |
| Workspace   | Grid, Record anchors          | The persistent artifact and its dock — not task tools (ADR 0044).   |

**Ordering rules:** task order is Explore → Check → Change → Prepare; `pipeline` stays last in both layouts (q-15); within a task the existing relative order is kept; the 12 section ids, titles and R-14 purpose subtitles are unchanged. The grouped DOM order is the task order (narrow CSS `order` restores the documented slice-1 stack).

**Semantics:** a single-select **radio group** (`role="radiogroup"` + `role="radio"` with `aria-checked`, roving tabindex, ←/→/↑/↓/Home/End) labelled `Workbench task`, described by the purpose line. **Not tabs**: there is no tabpanel element, and the review explicitly forbids claiming tab semantics without tab/tabpanel behaviour. Each task also renders a **task-scoped section link list** (native anchors to `section-<id>` with the existing `section-nav-<id>` test ids); this keeps every section directly reachable and preserves R-07's existing close-focus destination. Grid/Record remain workspace anchors, not task choices.

**Visibility (slice 1, amended):** every section stays reachable at all widths. The active task's sections are marked with an accent edge, and choosing a task opens its shell-managed sections; at <1024px the documented stack is unchanged. Conditional hiding at ≥1024px remains the target design but is deferred to its own reviewed slice, because the legacy panel-expansion journeys must be migrated deliberately rather than in the same change as the IA (§9). The accepted implementation keeps a **flat DOM** (no task wrappers) and introduces exactly one section-order change, `History` before `Export` in Change; every other section stays where it is.

**Context bar (new app-local component, first child of the center column):**

- Left, neutral facts: `Current dataset view` · `12 rows × 10 columns` · `N staged operations` (never "N changes", never "edited view"). **No filename**: the current UI exposes only table id/counts and never the picked file's name (ADR 0025 discipline), so the bar must not add one.
- Right, exactly one next action derived from existing state (no new session metadata). The bar names the **consequence**, not a copy of the count, because the verdict and the local section summary already carry the numbers: `No contract loaded → Open a contract…`; `Contract loaded — not checked yet → Validate`; `The current check found failures → Review findings`; `Verdict stale — the session's staged state changed after it was computed → Recheck` (+ `Review findings`); `Verdict is current — no violations → Export a copy…`; `Comparison stale — the session's staged state changed after it ran → Review comparison`; busy → `Validating the current dataset view… → Cancel`. Only the state text is a polite `role="status"`; the action is a normal button.
- A `Back to findings` chip appears only after a validation/diff `Show row` jump; it is app-local UI state, not a session record.
- **No copied count:** the context bar states the consequence and offers the single next action, but does **not** repeat the verdict's numbers. The count therefore appears at most twice for the same scope — the panel verdict (expanded) and the existing collapsed section summary — and never in a third surface. No per-task badge is added. Stale is the one exception the bar repeats, because a stale verdict stays readable but no longer describes the current view.

**Copy changes proposed (require approval):**

| Current                                                                                                              | Proposed                                                                                                                                                                                                                                                                                                                | Why                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| “This verdict is **stale** — the dataset changed after it was computed, so it no longer reflects the current edits.” | “This verdict is **stale** — the session’s staged state changed after it was computed, so it may no longer reflect the current dataset view. Re-validate for a fresh result.”                                                                                                                                           | Revision also bumps on a logged no-op, undo/redo and cursor moves, so neither “changed” nor a new operation is guaranteed; naming the staged state is truthful. |
| “This row diff is **stale** — the dataset changed after it ran…”                                                     | “This row diff is **stale** — the session’s staged state changed after it ran, so it may no longer reflect the current dataset view. Re-run for a fresh comparison.”                                                                                                                                                    | Same reason.                                                                                                                                                    |
| (new) task purposes                                                                                                  | Explore: “Understand what is in the file: fields, filters, query and statistics.” Check: “Find quality issues or explain differences between two versions.” Change: “Make a reversible repair, review staged operations and deliver a copy.” Prepare: “Run deterministic steps and inspect gate and delivery evidence.” | One-line goal, value-free; matches the review's task table.                                                                                                     |
| (new) neutral labels                                                                                                 | `Current dataset view`, `N staged operations`, `Checked dataset snapshot` (panel caption, rd-4), `Back to findings`                                                                                                                                                                                                     | RD-R03; keep “Staged operations” distinct from changed contents.                                                                                                |

Excluded copy: no “edited view”, no “matched rows” counts presented as changed data, no new shortcut claims, no telemetry wording change.

### 3.2 Why B, and why not the others

- **A is the safe fallback, not the recommendation.** It fixes the return path and the stale action at low cost, but leaves the top-level structure — twelve peers and two orders — unchanged. On the primary journey the participant still has to find Validation among collapsible peers and re-find it after every repair.
- **B addresses the demonstrated friction** (F1–F4) with presentation only: no session, engine, byte, protocol or dependency change. The decisive technical finding is that **every panel is already mounted and hidden**, so a task switch cannot lose local drafts; grouping wrappers stay `display: contents`, so the narrow stack and grid internals are untouched.
- **C (framework/engine/grid rewrite) is not justified.** Nothing in the review or this audit shows the stack is the limiting factor. Do not choose it without a separately demonstrated technical need.
- **A remains the fallback** if the study cannot be run, if the maintainer prefers minimal contract churn, or if B fails the J2 criteria.

### 3.3 RD requirement/acceptance coverage in this checkpoint

| ID              | This checkpoint's status                                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| RD-R01 / RD-T01 | **Addressed as design**: both alternatives prototyped, membership/reachability defined, IA matrix above. Approval pending SV-D08. |
| RD-R02 / RD-T02 | **Designed, not implemented**: J2 chain, context action, return path; rd-4 delivers and observes it.                              |
| RD-R03 / RD-T03 | **Designed**: neutral labels, one-count rule, no-op stale wording correction; tests specified in §3.6.                            |
| RD-R04 / RD-T04 | **Designed with proof of feasibility**: mounted-panel fact; no hook/worker/grid lifetime change; tests specified.                 |
| RD-R05 / RD-T05 | **Designed**: radiogroup semantics, focus rules, narrow behaviour, no new modal; accessibility cases specified.                   |
| RD-R06 / RD-T06 | **Unchanged and explicitly not selected**: SV-D02/03/04/05 remain open; no optional feature is authorized by this document.       |
| RD-R07 / RD-T07 | **Protocol prepared; evidence missing**: no participants, no AT review; heuristic walkthrough recorded as non-evidence.           |
| RD-R08 / RD-T08 | **Plan with rollback points** in §3.7–§3.8; no runtime slice run.                                                                 |

---

## 4. rd-2 — decisions, boundaries, acceptance and rollback

### 4.1 Open decisions (must be recorded before runtime)

| ID                           | Question                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Recommendation / consequence                                                                                                                                                          |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SV-D08 — route and IA**    | Select conservative refresh (A) or the task-led redesign (B); record old→new layout/copy/test contracts.                                                                                                                                                                                                                                                                                                                                                                                                        | **Recommend B** with the §3.1 IA. Approval of "explore B" is not approval to implement it.                                                                                            |
| **UI-RD-01 — new UI ruling** | Authorize: task grouping and membership; active-task framing (marking + opening its manageable sections); radio-group task semantics; pane composition (4 task choices + a task-scoped section link list + Workspace anchors); flat section DOM with the single History-before-Export order; the existing R-07 close-focus target retained; narrow stack retained; q-15 pipeline-last retained; R-14 copy retained. **Conditional hiding is not authorized in this slice; it is the next reviewed slice (§9).** | Requires a recorded ruling/spec amendment. No ADR change is needed because the shell remains ADR 0044's tools-left / grid-center / record-dock / 1024×700 composition.                |
| **Copy approval**            | Approve the §3.1 copy table (task purposes, neutral labels, stale rewording).                                                                                                                                                                                                                                                                                                                                                                                                                                   | Without it, keep the current strings and drop the no-op correction from rd-3/rd-4; the design still works, but the stale sentence stays potentially inaccurate.                       |
| **SV-D01 — runtime scope**   | Approve rd-3 and rd-4 as bounded rows with file reservations and gates.                                                                                                                                                                                                                                                                                                                                                                                                                                         | Template in §5; nothing runs before it is recorded.                                                                                                                                   |
| **Default task + reset**     | Default task Explore; does a new dataset reset the active task and return-focus state?                                                                                                                                                                                                                                                                                                                                                                                                                          | Recommend: reset to Explore on a new dataset session, register the reset beside the other App-local resets, test it.                                                                  |
| **Workspace anchors**        | Keep `Grid` and `Record` as anchors in the pane?                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Recommend yes (reachability; minimal churn). Record remains a dock, not a task.                                                                                                       |
| **Run metadata**             | Capture read-only app-session metadata (origin/op count at run)?                                                                                                                                                                                                                                                                                                                                                                                                                                                | **Recommend no** for rd-3/rd-4: the "session's staged state changed" wording is truthful without new state. Revisit only if a concrete need appears, with atomic capture/reset tests. |
| **Optional SV-D02/03/04/05** | DCR inspector, dirty-replacement guard, SQL sizing, overlay-aware profile.                                                                                                                                                                                                                                                                                                                                                                                                                                      | All remain **OPEN**. Recommend none for the first two slices; SV-D03 can follow rd-3 if the maintainer wants the safety flow in the same migration.                                   |
| **Help**                     | Global Help/guide consolidation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Not in rd-3/rd-4. Core tasks must be completable without Help; rd-7 may add concise contextual guidance.                                                                              |

### 4.2 Exact migration boundaries

**Allowed (rd-3):**

- `apps/web/src/workbench/tasks.ts` (new, pure): task ids/names/purposes, section membership, ordering, `taskOfSection`, completeness assertions.
- `apps/web/src/workbench/next-action.ts` (new, pure): the state machine above, derived only from existing state (`ContractState`, `ValidationRunState`, `DiffRunState`, `TransformationHistory`, busy/cancel flags). No engine/session access, no new metadata.
- `apps/web/src/workbench/TaskNav.tsx` (new): radio group, roving tabindex, task purpose, the active task's section links (`section-nav-<id>` targets, unchanged R-07 focus destination) and workspace anchors.
- `apps/web/src/workbench/DatasetContextBar.tsx` (new): neutral facts, next action, back-to-findings chip, record status.
- `apps/web/src/workbench/use-workbench-task.ts` (new, optional): app-local active task + per-task last-focused target; no engine/session state.
- `apps/web/src/App.tsx`: import/render the seam; task-aware `revealSectionFromNav`; pass existing derived state; task reset on dataset session; keep `closeSection`'s existing `section-nav-<id>` focus query.
- `apps/web/src/index.css`: scoped classes for the new components; **no token value changes**, no bare-element selectors, no global restyle.
- Focused tests: `workbench/*.test.ts(x)`; deliberate migrations of `App.shell.test.tsx`, `App.headings.test.tsx`, `App.section-purposes.test.tsx`, `App.section-summaries.test.tsx`, `shell-geometry.test.ts`, and a new `tests/e2e/workbench-tasks.spec.ts`; locator-only updates to existing e2e specs where the pane composition changed.
- One `.changeset/*.md` for `@assay/web` (runtime UI change).

**rd-4 additionally allowed:** `apps/web/src/validation/ValidationPanel.tsx` and `apps/web/src/diff/DiffPanel.tsx` **copy only** for the approved stale sentences, plus the context-bar action wiring already in the seam. No report/model/export changes.

**Forbidden for both slices:** `sessions/*` (except a read-only import), `pipeline/usePipelineSession.ts`, `grid/*`, `record/*`, `export/*`, `profile/*`, `sql/*`, `schema/*`, `telemetry/*`, `packages/**`, root configs/lockfiles, ADRs, docs owned by the orchestrator, new dependencies, new formats, CLI/VS Code runtime, any telemetry event/content change, any report/wire/byte change.

**State-ownership rules (non-negotiable):**

1. Hooks are called unconditionally at App top level and are never keyed by task id.
2. Task switching changes visibility/focus only; it must not reopen a file, boot a worker, run SQL/validation/diff, consume a request twice, reset B staging or discard drafts.
3. Inactive sections are hidden, never unmounted. No second grid, no second engine.
4. New UI state (active task, last-focused target, jump-origin marker) is app-local and is reset by the dataset session, not by a task switch.
5. Any hidden panel keeps its existing effects and guards; no new effects may fire on activation.
6. `role=status` only on text, never on a container with buttons; no duplicate announcements; no per-render announcements.

### 4.3 Acceptance test plan

**New pure tests**

- `workbench/tasks.test.ts`: 10 tool sections partition exactly once; 4 tasks in order; `pipeline` last; Grid/Record are workspace anchors, not task tools; titles/purposes unchanged; no unknown ids.
- `workbench/next-action.test.ts`: full truth table (no contract, loaded/not run, failing fresh, stale after edit, stale after no-op, valid, diff stale, diff fresh, busy, cancelled, engine error). Asserts: never auto-runs; one action; stale text does not claim changed contents; counts are not re-derived from operation counts.
- `workbench/visibility.test.ts` (or in `tasks.test.ts`): desktop visible set = active task; narrow visible set = all sections; grid/record never hidden by a task.

**New component tests**

- `TaskNav.test.tsx`: single radio checked; `tabIndex` roving; ←/→/↑/↓/Home/End; no `tab`/`tabpanel` roles; keyboard activation moves focus to the radio; mouse activation does not move focus into content; no per-task count badge (state stays in the bar/summary); purpose exposed as description.
- `DatasetContextBar.test.tsx`: neutral label strings; one action per state; `role=status` on text only; action calls the existing handler exactly once; busy shows Cancel and cancels; back-to-findings appears only after a jump and clears on dataset reset; **the bar text never contains the verdict's count** (asserted against the rendered verdict and the section summary).
- `App.task-switch.test.tsx`: type a filter draft → switch → return → draft intact; SQL text intact; contract text intact; history cursor/overlay intact; record target and expanded record paths intact; **comparison B staging and DiffPanel key mode intact**; export dialog open/closed state consistent; **zero** engine calls added (spy on the engine client), grid mounted with the same model identity; no remount of any panel.

**Deliberate migrations (not deletions)**

- `App.shell.test.tsx`: `NAV_ORDER` → 4 task radios + workspace anchors; `DOM_ORDER` → grouped order; keep the decoupling pin in its new form (task membership ≠ DOM adjacency is irrelevant now; instead pin "every section belongs to exactly one task and appears once"); keep the grid-mounted-across-pane-collapse leg.
- `App.headings.test.tsx`: per-task heading maps; all 12 section headings exist in the DOM; only the active task's are exposed; Grid always; Record only when open; exactly one `h1`.
- `App.section-purposes.test.tsx` and `App.section-summaries.test.tsx`: activate the owning task first; assertions stay byte-exact; summaries at 0 stay absent; no per-task badge exists (asserted by absence).
- `shell-geometry.test.ts` / `shell.spec.ts`: keep the pane/center/grid geometry pins; add a task-strip height budget and the 1024×700 containment leg; migrate nav label/heading/DOM-order assertions.
- `a11y.spec.ts`: add the four task surfaces (both schemes) with the allowlist still empty; **keep every existing surface scan, the two 900px cases per scheme and the canary** — do not replace or reduce the file's current matrix.
- `a11y-keyboard.spec.ts`: add keyboard-only task switching and focus-return; keep the export-modal and disclosure legs.
- `tests/e2e/workbench-tasks.spec.ts` (new): real browser at 1024×700 and 1440×900, both schemes; task switch preserves row/selection; Escape/Arrow behaviour; narrow 900 shows every section and does not clip; no horizontal overflow at 200% zoom.
- `App.memo-probe.test.tsx`: unchanged and green; add an assertion that a task switch does not re-render `DataGrid`/`RecordInspector` (props identity).
- `nested-journey`, `pipeline-panel*`, `validation-panel`, `diff-panel`, `profile-*`, `export-rewrite`: verify selectors/migrations only; no assertion weakening. Reveal paths must activate the owning task before expanding.

**Performance / no-extra-work baseline (per slice)**

Record on fixed synthetic fixtures at the slice's starting revision: file opens, worker boots, engine queries, validation/diff runs, SQL runs, grid window fetches, grid render counts, DOM node count, and the ready-workbench top offset. Then assert after the slice: **zero** extra opens/boots/runs on task switching; unchanged logical row targeting; no unbounded DOM growth; no material regression under a pre-agreed budget. Historical timings are context only.

**Gates:** the map §6 sequence, including format/lint/typecheck/unit/build/coverage/e2e/docs-links/ADR-index; configured-telemetry disclosure leg and restored stock rebuilt output whenever `App.tsx`/CSS changes; independent reviewer with a different model/session; one changeset.

### 4.4 Rollback points

| Point                        | Meaning                                                                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `bba491a` + pack             | Pre-redesign source. The design record/prototypes are additive docs; runtime is unchanged.                                              |
| **R0 — rd-3 seam commit**    | First runtime slice. Reverting this single commit restores the 12-section pane, tests included. No storage/URL/router migration exists. |
| **R1 — rd-4 journey commit** | Reverting returns to the rd-3 shell (structure without the journey wiring); R0 remains reversible.                                      |
| Post-slice                   | No live old/new shell toggle, no dual mounted grid, no dirty-session remount. Development comparison stays outside the shipping build.  |

Rollback is `git revert <slice commit>` in the reserved checkout; no data migration, no persisted UI preference, no feature flag. A slice that fails gates or review is reverted, not patched into a partial state.

---

## 5. Bounded implementation proposal for rd-3 and rd-4

Nothing below is authorized by this document. It is the exact scope to approve under **SV-D01** after **SV-D08**/**UI-RD-01**/copy approval.

### rd-3 — extract the state-preserving presentation seam

**Goal:** deliver the IA structure without changing data semantics: task grouping, task-aware reveal, context bar with neutral facts, and the caption/count rules.

1. Add the pure `workbench/tasks.ts` and `workbench/next-action.ts` with their truth tables.
2. Add `TaskNav` and `DatasetContextBar`; keep their copy in constants; mark the proposed strings for the copy decision.
3. Restructure the pane render into four `display: contents` scopes in task order (Explorer → Check → Change → Prepare), preserving every section id, heading and purpose; keep Grid/Record in the center column and the Workspace anchors.
4. Wire app-local active-task state and `revealSection(sectionId)`:
   - activate the owning task (silently),
   - expand the section,
   - scroll and focus the existing target,
   - on close, keep the existing `section-nav-<id>` focus target — the link now lives in the active task's section list (R-07 unchanged).
5. Reset active task and jump-origin state on a new dataset session; register it with the other App-local resets.
6. Keep every section reachable at all widths in this slice: mark the active task's sections and open its manageable sections. Conditional desktop hiding of inactive tasks is the **deferred target** (§9, `rd-3b`), not part of the shipped slice; <1024px keeps the documented stack.
7. Migrate the named tests deliberately; add the task-switch preservation and zero-extra-work tests.
8. Run the full gate sequence; independent review; changeset.

**Done when (slice 1):** every existing tool is reachable; no capability lost; the four task scopes carry exactly the defined membership and the active one is marked; a task switch preserves drafts/history/overlay/record target with zero extra engine work; heading/purpose/summary contracts are pinned; narrow and both schemes pass axe; all gates green. Conditional exposure is explicitly deferred to `rd-3b`.

**Not in rd-3:** the next-action copy changes beyond neutral facts, the stale-action wiring, the back-to-findings chip, panel copy changes, Help, optional features.

### rd-4 — deliver the repair and recheck journey

**Goal:** make **validation → finding → logical row → typed repair → stale → explicit recheck** work as one coherent flow without Help, and observe it.

1. Complete the `next-action` state machine wiring: failing → `Review findings`; stale → `Recheck` (the existing validate handler) plus `Review findings`; valid → `Export a copy…` (the existing dialog); diff stale → `Review comparison` (reveals the panel's existing run control; key state stays in the panel); busy → `Cancel`. No auto-run, no auto-switch, no second run path.
2. Add the `Back to findings` chip: set on a validation/diff `Show row`, cleared on dataset reset and when the user returns through it. App-local only.
3. Apply the approved stale-sentence copy (validation + diff) and the `Checked dataset snapshot` caption; keep the report bytes unchanged.
4. Verify the finding flow with the existing row jump/filter eligibility and the failed-apply rollback/reseed unchanged.
5. Add the journey test: contract → failing → Show row → commit a repair → stale → Recheck → valid, including a keyboard-only leg, a no-op edit case (stale possible, copy honest), a cancelled validation case and an export-refused case.
6. Run the full gates + the telemetry configured/stock protocol if App/CSS changed; independent review.
7. Run the authorized usability round 1 (or record the accepted limitation) on the **built** slice; write the aggregate results and limitations into this record; do not claim validation if no participants.

**Done when:** RD-T02/03/04/05/07/08 are satisfied or explicitly limited; the J2 journey is usable without Help; session/engine continuity and all preserved semantic/byte tests pass; the study (or its accepted limitation) is recorded.

**Not in rd-4:** comparison continuation (rd-5), pipeline context (rd-6), Help (rd-7), optional SV-D02/03/04/05 work, any engine/domain/protocol change.

---

## 6. What this checkpoint did **not** do

- No production runtime change (no `apps/**` source, CSS, tests, fixtures, configs, lockfiles or dependencies touched).
- No accepted ADR written, rewritten or renumbered; no UI ruling recorded (the recommendation names the ruling needed).
- No git commit, push, tag, release, publication or visibility change; no remote operation.
- No participant session, recruitment, recording, upload, telemetry or external contact.
- No conservative `sv-*` Phase A execution as a prerequisite.
- No feature claim: every SVG/horizon capability not in §3.1 remains unimplemented; deferred decisions remain open.
- No fresh full gate baseline and no fresh remote-CI observation; §1.2 states exactly what ran.

## 7. Files added by this checkpoint (design/evidence; committed as `d441fc3`)

These were uncommitted during the checkpoint and are now integrated as the additive commit `d441fc3` (no runtime change in that commit).

| Path                                                      | Kind                                                       |
| --------------------------------------------------------- | ---------------------------------------------------------- |
| `docs/product/13-workbench-redesign-design-record.md`     | This record.                                               |
| `docs/process/handoff/20261104-rd2-usability-protocol.md` | Moderator protocol, thresholds, missing-evidence register. |
| `assests/prototypes/README.md`                            | Prototype map, how to open, honesty boundary.              |
| `assests/prototypes/rd-nav-a.html`                        | Alternative A, isolated, synthetic, keyboard-operable.     |
| `assests/prototypes/rd-task-led-b.html`                   | Alternative B, isolated, synthetic, keyboard-operable.     |

Existing uncommitted work (`docs/process/handoff.md` + the untracked SVG/spec pack) was preserved and not modified by the prototype work.

## 8. Independent review record

| Item                                                    | Record                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reviewer                                                | Openai-codex/gpt-6-luna at thinking **xhigh**, independent of the authoring session (`docs/process/handoff/operating-model.md` role separation; same model did not implement and approve).                                                                                                                                                                                                                                                                                                                                                                                                               |
| Rounds                                                  | Four: initial **request-changes** (3 Major, 3 Minor) → fix round → **request-changes** (1 Critical count-duplication, 2 protocol warnings, stale-copy scope) → fix round → **request-changes** (alternative A's bar copy) → fix round → **approved**.                                                                                                                                                                                                                                                                                                                                                    |
| Findings closed                                         | Stale copy no longer implies changed contents or a new operation (covers no-op, undo/redo, cursor moves); R-07 focus target preserved via task-scoped section links instead of a new focus rule; round-trip measure redefined as a live moderator action log (no recordings); prototype B actually applies the failure filter; a11y matrix kept whole; comparison B staging/key mode added to the preservation plan; the context bar no longer copies the verdict count (no third surface); protocol no longer claims a badge rule or unimplemented focus restoration; alternative A's bar copy aligned. |
| Residual limitations (accepted for a design checkpoint) | No human usability session (RD-T07 unsatisfied); no AT review; full repository gates were not run (only `pnpm typecheck` + the `web` Vitest project, both green); the prototypes are not the built app; `docs:links:check`, `adr:index:check` and Prettier were the only documentation checks run.                                                                                                                                                                                                                                                                                                       |
| Review scope verified                                   | No `apps/**`/`packages/**` runtime change, no ADR edit, no dependency, no changeset, no commit, no push; pre-existing uncommitted work preserved.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

## 9. Runtime slice record — rd-3/rd-4 (2026-11-04)

**Authorized by:** [decisions and runtime scope](../process/handoff/20261104-rd-decisions-and-runtime-scope.md) under the delegated instruction; rows rd-3 and rd-4, first slice. **Next step:** [next pickup](../process/handoff/20261104-rd-next-pickup.md) — integrate/commit, merged verification, then rd-3b.

**Delivered (code):**

- `apps/web/src/workbench/tasks.ts` — section/task membership, ordering, R-14 purposes, completeness rules.
- `apps/web/src/workbench/next-action.ts` — one pure next-action derivation (contract → check → comparison → delivery), precedence and truthfulness rules.
- `apps/web/src/workbench/TaskNav.tsx` — single-select radio group, roving tabindex, task purpose, task-scoped section links (`section-nav-<id>` preserved) and Workspace anchors.
- `apps/web/src/workbench/DatasetContextBar.tsx` — neutral facts (no filename, no copied count), one action, `Back to findings`.
- `apps/web/src/App.tsx` — app-local task/jump-origin state with dataset reset, task-aware reveal, context action wiring, focus seam; History-before-Export reorder.
- `apps/web/src/index.css` — task nav/context-bar classes, active-task marking, grid reserve 280 → 360 (first-paint contract preserved).
- `apps/web/src/validation/ValidationPanel.tsx`, `apps/web/src/diff/DiffPanel.tsx` — approved stale sentences only.
- Tests: `workbench/tasks.test.ts`, `next-action.test.ts`, `TaskNav.test.tsx`, `DatasetContextBar.test.tsx`, `App.task-switch.test.tsx`; migrated `App.shell`, `App.headings`, `shell-geometry`, `tests/e2e/shell.spec.ts`; new `tests/e2e/workbench-tasks.spec.ts`; one extra assertion in `m5-exit-journey.spec.ts`.
- Changeset: `@assay/web` minor.

**Deliberately deferred:** conditional task visibility at ≥1024px (`rd-3b`), compare/export continuation polish (`rd-5`), pipeline context (`rd-6`), Help/AT/study (`rd-7`), optional SV-D02…SV-D05.

**Verification (2026-11-04, this checkout):** `pnpm format` 0, `pnpm lint` 0, `pnpm typecheck` 0, `pnpm test` **235 files / 3494 tests passed**, `pnpm test:coverage` **89.10 / 83.86 / 91.39 / 90.68** (235 files / 3494 tests) (floors 83/76/80/84, unchanged), `pnpm build` 0 (12/12 tasks), `docs:links:check` **128/0**, `adr:index:check` 46. Full Playwright suite (`CI=1 --retries=0`, fresh servers on 4573/4579/4580, `DUCKDB=/tmp/duckdb`), including `shell`, `workbench-tasks`, `m5-exit-journey`, `a11y`, `a11y-keyboard`, `theme`, `record-keyboard` and `grid-virtualization`: **222 passed + 1 skipped + 1 failed** in the final full run; the single failure (`export-rewrite` arrow copy) was an `open-status: error` from an external DuckDB extension fetch during a JSONL open, and the whole spec passed **9/9** on an immediate isolated rerun. An earlier full run was **223 passed + 1 skipped** with the same environment. After the review fixes, the affected specs (`shell`, `workbench-tasks`, `m5-exit-journey`, `theme`) re-ran **20 passed**, and focused unit suites passed 66/66. The first attempts also exposed a missing `DUCKDB` env and a pointer-hover race in the theme test; `DUCKDB` was set and the theme test now moves the pointer before reading base styles. No threshold, timeout or allowlist was changed.

**Residual limitations (carry forward):**

- Conditional task visibility at ≥1024px is not implemented (deferred, §3.1/§9); the target design remains the prototype.
- The e2e suite now pins first-paint with a 360px grid reserve (context bar chrome), replacing the 280px reserve; this is a deliberate R-11 geometry migration.
- No human usability session or AT review was run for this slice; RD-T07 remains unsatisfied.
- The comparison action is `Review comparison` (focuses the panel's existing run control) because key state lives in the panel; a one-click rerun would need a scoped panel/session change.
- The change was **uncommitted** during the implementation episode; it is now integrated — see the integration record below.

**Integration and merged verification (2026-11-04, integration orchestrator):** commit authority was given by the maintainer's instruction at the end of the implementation episode (the paste of §5 of the [next pickup](../process/handoff/20261104-rd-next-pickup.md), which directs the orchestrator to inspect the tree and commit, with no push). The approved slice was committed as `51ff36e` after a path-by-path check against the [decisions record](../process/handoff/20261104-rd-decisions-and-runtime-scope.md) and §9 above (no `packages/**`, no root config, no ADR, no lockfile, no dependency); the design/prototype pack went in as `d441fc3`; nothing was pushed. The full gate sequence was then re-run from a **clean `git worktree` at `51ff36e`** (`typecheck` and `build` forced, `0 cached`): format 0, lint 0, typecheck 20/20, unit **235 files / 3494 tests**, coverage **89.10 / 83.86 / 91.39 / 90.68**, build 12/12, docs links **129 files / 0 broken**, ADR **46**, full Playwright **223 passed + 1 skipped, 0 failed** on fresh ports 4673/4679/4680, plus the configured telemetry leg (**6 passed**, 2 collector POSTs aborted, nothing sent) and the restored stock build (**0** endpoint hits; affected stock specs **46 passed**). The per-gate table is map §6.4. The 128/0 docs-link figure above was the authoring-checkout count before the pack was committed; the merged count is 129/0.

**Independent review (rd-3/rd-4):** `openai-codex/gpt-6-luna` xhigh, separate session from the implementer. Round 1 **request-changes** (2 Major: workspace anchors did not reveal a collapsed Grid; a running comparison was not cancellable in every contract/check state; 1 Minor: stale visibility comments). Fixes: workspace anchors now call the reveal seam with regression tests; the running-diff Cancel check moved before every contract/check branch with a full truth-table case; comments/docs corrected. Round 2 **request-changes** on two remaining stale comments (App doc comment and a test name) plus the design-record step text; fixed. Round 3 **approve** — comment-only change verified, no behaviour change. Focused unit suites passed 66/66 and the affected e2e specs 20/20 after the fixes.

## 10. Runtime slice record — rd-3b (2026-11-04)

**Authorized by:** the maintainer's instruction _"approve on the rd-3b, lets proceed with that"_, bounded to the [rd-3b conditional visibility contract](../process/handoff/20261104-rd3b-conditional-visibility-contract.md) (authorization record: [decisions and runtime scope](../process/handoff/20261104-rd-decisions-and-runtime-scope.md) §7). **Baseline:** `d85c995`. **Merged:** `0b22024` (one squashed reviewed commit, one `@assay/web` minor changeset). **Merged gates:** [map §6.5](../process/handoff/20261104-svg-implementation-map.md).

**Delivered (code):** two `@media (min-width: 1024px)` rules in `index.css` (sections outside the active task, and inactive section-link groups, are `display: none` and stay mounted; keyed on the pane/section `data-task` and `workbench-nav-group[data-active]`); one focus guard in `App.tsx` (asks the layout rather than re-deriving the media query, so it is inert below 1024px); the task-aware e2e helper layer (`SECTION_TASK`, `activateTask`, auto-activating `openSection`, `expandAllSections(…, { endTask })`, `OpenFixtureOptions.task`); a per-task exposed heading map plus `includeHidden` for the complete DOM map in `shell.spec.ts`; a new `workbench-visibility` browser spec (per-task exposure at 1024/1440, draft preservation with no extra engine work, focus paths, cross-task reveal, 900px unfiltered, axe per task in both schemes); `shell-visibility.test.ts` (rule shape, no hiding outside the media query, attribute wiring, all 12 mounted) and a per-task attribute pin in `App.shell.test.tsx`.

**Deviations from the written contract, each reviewed:**

1. **The guard's negative control was replaced, not waived.** The contract said "remove the guard → the browser test must fail". It cannot: every browser-reachable task change already moves focus (click focuses the radio, arrows focus it, every programmatic reveal focuses its target). Rather than ship an unprovable branch, the guard's _branch_ is now proved by a layout-stubbed unit test with a control case (visible section ⇒ focus is **not** stolen); removing the guard makes that test fail (observed). The browser spec still proves the user-visible guarantee. The reviewer accepted this as a reasonable branch proof.
2. **Four task labels in contract §4.3 were wrong** and the implementer followed measured behaviour: `m6-exit-journey` and `m5-exit-journey` are Check journeys (not Change), `validation-report-export` crosses `check → explore → check` (the filter bar, not Change), and `pipeline-dcr-export` is Prepare-only. `pipeline-gate-journey` / `pipeline-runner-journey` are engine-harness-only and have no workbench surface at all.
3. **Five files outside the written reservation needed an R3/R5 edit** (sanctioned by the contract's failure taxonomy): `grid-editing`, `theme`, `engine-external-parquet-diff`, `export-rewrite` and `support/pipeline-panel.ts`. No assertion was deleted or weakened; the pre/post comparison held for the sampled migrations.
4. **Comment-only edits** to `workbench/tasks.ts` and `workbench/TaskNav.tsx` (reservation amended by the orchestrator) because their comments still described conditional hiding as deferred.

**Independent review (rd-3b):** `openai-codex/gpt-6-luna` xhigh, separate session from the implementer (deepseek-v4.1-flash). Verdict **approve**, with its own full gate run (including the configured/restored telemetry legs), an independent mutation (removing `:not(…)` → the exposure assertion failed, restored byte-identically, rebuilt, clean tree) and its own review of five migrated specs for weakening. One implementation round and one bounded pre-review fix round (guard provability, stale comments) preceded it.

**Residual limitations (carry forward):**

- **Persistent edit feedback is task-local.** With Explore active, a grid edit's durable error text and pending-change summary live in the (hidden) Editing section. The transient `edit-live-region` announcement still fires from outside every section, so the outcome is announced, but no visible persistent feedback exists in Explore. Recorded as **rd-3c — PROPOSED, unauthorized**; not fixed inside this slice and not implied to be visible.
- The focus guard's branch is proved with a stubbed layout, not a browser-reachable trigger (see deviation 1).
- R-07's close-focus move could not be browser-induced outside panel recovery; the spec pins that the link is exposed and focusable, and the move stays covered by the panel-boundary unit tests.
- One unexplained intermittent Parquet-open failure occurred in the first merged full run and did not reproduce on the second, on isolated reruns, in a 12/12 diagnostic loop, or on the pre-rd-3b baseline (14/14). Recorded with its evidence in map §6.5 rather than dismissed.
- No human usability session or AT review; **RD-T07 remains unsatisfied**, and no usability claim is made.
- rd-5, rd-6, rd-7 and optional SV-D02…SV-D05 remain unauthorized; nothing was pushed.

## 11. Runtime slice record — rd-3c (2026-11-04)

**Authorized by:** the maintainer's _"lets proceed with A"_, bounded to the [rd-3c contract](../process/handoff/20261104-rd3c-edit-feedback.md) (record: [decisions and runtime scope](../process/handoff/20261104-rd-decisions-and-runtime-scope.md) §8). **Baseline:** `5397b9b`. **Merged:** `acc8aff` (one squashed reviewed commit, one `@assay/web` patch changeset). **Merged gates:** [map §6.6](../process/handoff/20261104-svg-implementation-map.md).

**The defect it closes:** rd-3b exposed only the active task's sections. The durable edit error — engine rejection, cast refusal, non-applied op — renders in the Editing toolbar (Change), so from Explore a sighted user's rejected edit silently reverted. In-tree evidence: the rd-3b migration had to add `activateTask(page, 'change')` to the engine-rejection journey test before it could assert the message. Client-side typed-input rejections (`grid-edit-error`, grid footer) and the polite live region were never affected.

**Delivered:** an `App.tsx` effect that reveals the Editing section through the existing `revealSectionFromNav` seam when `editError` transitions to non-null — activating Change, expanding the section, and scrolling the **section element** into view via a new opt-in `{ scroll?: boolean }` seam option (default `false`, so every other caller is byte-identical in behaviour); a ref guards once-per-error (initialised to the mount value, reset only when the error clears); the no-op case (Change active + Editing open) is skipped; **no focus call anywhere**; `useEditingSession`, the grid, the messages, the live region and every approved string are untouched.

**Deviations from the written contract, reviewed:**

1. **A transient app-local state was added** (`{ id, seq }` scroll request) although the contract said "no new state field". The reviewer judged it acceptable plumbing for the render-then-act scroll (the same shape as the existing `panelFocus`) rather than duplicated durable/session state, and required the changeset wording to say exactly that — the release note now says "no new **durable or session** state" and names the transient request. Corrected at merge.
2. **"The grid keeps focus" was mis-specified by the orchestrator**, not by the implementer: the reveal adds no focus call, but the commit's own editor unmount leaves `document.activeElement` on `<body>` (pre-existing grid behaviour). The browser pin therefore asserts "focus is not moved into the pane", and the limitation is recorded here rather than claimed away.
3. **The first implementation did not scroll at all** — the reviewer's Critical: `revealSectionFromNav` is not a link, so it never gets the anchor's scroll. Fixed with the opt-in option above; the reviewer independently re-ran the mutation (dropping `{scroll:true}`) and saw the intended assertion fail. The viewport assertion alone is insensitive at 1024×700 because the pane's content collapses to fit once Explore's sections hide; the load-bearing pin is the recorded `scrollIntoView` request on `section-editing`, which the reviewer accepted in preference to a fragile short-viewport case.

**Independent review:** `openai-codex/gpt-6-luna` xhigh, separate session from the implementer (deepseek-v4.1-flash). Two request-changes rounds (Critical: no scroll; then the release-note accuracy) → **approve**. Its own gates: format/lint/typecheck/unit/build/docs/ADR green, configured telemetry green, restored stock green, its own mutation-and-restore clean, and the focus + ref-guard semantics confirmed correct (returning to Explore with the error still on record stays in Explore; a cleared error then a later error reveals again).

**Residual limitations (carry forward):**

- After a rejected edit the cell editor unmounts and `document.activeElement` falls to `<body>` (pre-existing, unchanged by rd-3c); the reveal itself never moves focus.
- Identical repeated error text without an intervening clear does not re-reveal. Intended by the ref guard: the user is already in Change with the message visible.
- The pending-change **detail** stays task-local by decision; the context bar's staged count is the always-visible summary.
- A collapsed pane rail is respected — the reveal does not auto-expand it, so a rail user still does not see the pane message (announced via the live region only).
- **The browser gate depends on an external CDN**: the DuckDB-WASM Parquet/JSON extension autoloads from `extensions.duckdb.org`, so full-suite runs intermittently fail in the open phase (3 of 4 runs for this slice; always green on isolated rerun and once fully green). Recorded with the captured URL and a proposed (unauthorized) harness follow-up in map §6.6.
- No human usability session or AT review; **RD-T07 remains unsatisfied**. No push.

## 12. Runtime slice record — rd-5 (2026-11-04)

**Authorized by:** the maintainer's _"approve on the rd-5, lets proceed"_, bounded to the [rd-5 contract](../process/handoff/20261104-rd5-compare-export-contract.md)
(decisions: D1 approved three exact label strings, D2 = leave + record, D3 = no one-click rerun; recorded
in [decisions and runtime scope](../process/handoff/20261104-rd-decisions-and-runtime-scope.md) §11).
**Baseline:** `1757b44`. **Merged:** `c8ca73a` (one squashed reviewed commit, one `@assay/web` patch
changeset). **Merged gates:** [map §6.7](../process/handoff/20261104-svg-implementation-map.md).

**Scope was set by reading the code, not the row title.** The comparison capability, the A-only "Show
row" jump, the whole-current-dataset export facts and the web/CLI exact agreement already shipped and
were already pinned. rd-5 therefore delivered only:

- **D1 copy** in `DiffPanel.tsx`, three blocks and nothing else: intro first sentence, the zero state,
  and the staged line now name **the open dataset (A)** / **the comparison file (B)**. Value-free, and no
  count is duplicated — the staged line keeps B's existing counts, A's stay in the context bar. The
  separator inside the approved string is `×` ("Comparison file (B) staged — 5 rows × 5 columns").
- **Three exact-string pins** (`DiffPanel.test.tsx`) so a partial reword fails rather than passing on a
  substring.
- **One J3 journey** (`m6-exit-journey.spec.ts`) bound to the task-led shell from the Explore default:
  Check → stage B → drift → deltas → keys → row diff → A-side "Show row" lands on the logical row
  (asserted by the row's `id` cell, the live-region announcement and the inspector, not by position) →
  B-side is report-only with no jump affordance → stale → bar `Recheck` → bar `Review comparison` →
  explicit rerun → bar `Export a copy…` lands in **Change** with the dialog reporting the whole effective
  dataset. Task transitions are asserted (`aria-checked`, pane `data-task`), not only panel contents.
- **One patch changeset.** No comparison/export logic, session hook, bar copy, report byte, CLI
  agreement, grid or config change.

**What the scope deliberately did not change (D2):** the context bar cannot see a staged-but-unrun
comparison — `deriveNextAction` receives the run state only, so a user who has just staged B still sees
the previous next action until a check is current. The decision was to leave it and record it: the
Compare panel is where staging and running happen, and adding a bar state would need a new approved
string plus a new derivation input. Consequence, observed in the journey: reaching the bar's
compare/export actions requires a current valid verdict, so J3 loads and runs a dataset-level contract
first. This is a **recorded limitation**, not an implied capability: the bar does not see "staged, not
run", and the journey does not claim it does.

**Independent review:** `openai-codex/gpt-6-luna` xhigh, separate session from the implementer
(deepseek-v4.1-flash). Verdict **approve**, no Critical and no Warning about the code; its own mutation
(intro reverted to "open one") failed the intended assertion, was restored byte-identically and rebuilt.
It caught one documentation defect of mine: the contract cited "design record §12" before this section
existed — now it does. It also confirmed the prior M6 tests are untouched and that D2's gap is correctly
recorded rather than tested-away.

**Residual limitations (carry forward):**

- The bar cannot represent "comparison staged, not run" (D2, above) — a candidate for a later slice if
  the journey shows it bites.
- One-click rerun stays out (D3): `Review comparison` focuses the panel's run control because key state
  lives in the panel.
- No human usability session or AT review; **RD-T07 remains unsatisfied**, and this slice adds no such
  claim. rd-6, rd-7 and SV-D02…SV-D05 remain unauthorized; nothing was pushed.
