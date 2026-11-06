# rd-3b — conditional task visibility: contract and migration plan

**Status: AUTHORIZED 2026-11-04 by the maintainer (_"approve on the rd-3b, lets proceed with that"_), baseline `d85c995`.** Scope is bounded to this document; the authorization record is [decisions and runtime scope](20261104-rd-decisions-and-runtime-scope.md) §7. The contract was written **before** any code, because the [slice-1 amendment](20261104-rd-decisions-and-runtime-scope.md) deferred conditional visibility on purpose: hiding inactive sections changes how every legacy journey reaches a panel, so the test migration had to be designed first.

**Authority chain:** [SV-D08 = B](20261104-rd-decisions-and-runtime-scope.md) (task-led),
[UI-RD-01](20261104-rd-decisions-and-runtime-scope.md) §3.2 ("conditional hiding at ≥1024px is the
target design"), [map](20261104-svg-implementation-map.md) row `rd-3b`, [design record
§3.1/§9](../../product/13-workbench-redesign-design-record.md). Baseline: `51ff36e` — rd-3/rd-4
CLOSED, merged-verified ([map §6.4](20261104-svg-implementation-map.md)). Do **not** re-decide the
IA, the copy, the radio-group semantics or the flat DOM.

---

## 1. What changes (exact old → new contract)

The **only** behaviour change is exposure. Nothing about state, data, focus targets, copy or DOM
structure moves.

| #   | Surface                                | Today at ≥1024px (rd-3)                                              | rd-3b at ≥1024px                                                                                                                                                                         | At <1024px (both)                        |
| --- | -------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 1   | The 10 tool sections                   | All exposed; the active task's sections carry an inset accent edge   | **Only the active task's sections are exposed**; the others are `display: none`, still mounted                                                                                           | Unchanged: all stacked, nothing filtered |
| 2   | Grid / Record (center column)          | Exposed                                                              | Unchanged — they are workspace, never task-filtered                                                                                                                                      | Unchanged                                |
| 3   | Section link groups in the pane nav    | All five groups exposed (Explore, Check, Change, Prepare, Workspace) | **Only the active task's group + Workspace** are exposed; the other four groups are `display: none`                                                                                      | Unchanged: all five groups exposed       |
| 4   | Task switcher (radio group)            | 4 radios, roving tabindex, ←/→/↑/↓/Home/End                          | Unchanged                                                                                                                                                                                | Unchanged                                |
| 5   | Task purpose line                      | One line under the switcher                                          | Unchanged                                                                                                                                                                                | Unchanged                                |
| 6   | Section `h2`s / purposes / ids         | 12 in the DOM, all exposed                                           | Same 12 in the DOM (attached), 4/2/3/1 per task exposed                                                                                                                                  | Same 12 exposed                          |
| 7   | `section-nav-<id>` (R-07 focus target) | One link per section, always exposed                                 | Same 12 links in the DOM; only the active task's + workspace are exposed. **Revealing a section still activates its task first**, so the link is exposed whenever it is the focus target | Unchanged: all exposed                   |
| 8   | Reveal seam (`revealSectionFromNav`)   | activates the owning task → expands → scrolls → focuses              | Unchanged ordering, now load-bearing: activation must commit before the target is scrolled/focused                                                                                       | Unchanged                                |
| 9   | Marking of the active task             | Inset accent on the active task's sections                           | Dropped or kept — see §2.4 (recommendation: keep, it is now redundant but harmless and pins the attribute)                                                                               | Not applied (media-query scoped today)   |
| 10  | Pane collapsed to rail                 | All sections hidden by the existing rail state                       | Unchanged; the filter applies inside the (hidden) body                                                                                                                                   | N/A                                      |

**Default task on a new dataset:** Explore (unchanged, already reset by the dataset-session hook).
**Task selection never auto-scrolls and never moves focus into content** (unchanged, now pinned).

## 2. The exact CSS contract

### 2.1 Selector (inside the existing `@media (min-width: 1024px)` block only)

```css
/* Sections outside the active task stay mounted but are not exposed. */
.workbench-tools[data-task='explore'] .workbench-section[data-task]:not([data-task='explore']),
.workbench-tools[data-task='check'] .workbench-section[data-task]:not([data-task='check']),
.workbench-tools[data-task='change'] .workbench-section[data-task]:not([data-task='change']),
.workbench-tools[data-task='prepare'] .workbench-section[data-task]:not([data-task='prepare']) {
  display: none;
}

/* The nav exposes only the active task's link group plus Workspace. */
.workbench-nav-group[data-active='false'] {
  display: none;
}
```

Why this shape:

- `[data-task]` is present only on the 10 tool sections (`taskOfSection()` returns `null` for
  Grid/Record, which therefore render no attribute) — the `:not()` rule cannot catch the workspace.
- Keying on the attribute means **no per-section JS filtering and no DOM change**: the 12 sections
  stay children of `.workbench-tools-body`, so React never unmounts a panel and every hook, worker,
  draft, overlay cursor and scroll position survives (this is the whole reason the slice is safe).
- The nav rule reuses the `data-active` attribute `TaskNav` already renders; the Workspace group is
  hard-coded `data-active="true"` so it is never hidden.
- Both rules are inside the ≥1024px query, so the narrow stack is byte-for-byte unchanged.

### 2.2 What must NOT be used

- No `hidden` attribute or conditional render on sections (that would unmount panels).
- No `visibility: hidden` / `opacity: 0` / `height: 0` (leaves focusable ghosts in the tab order).
- No JS filtering of `WORKBENCH_SECTIONS`, no new state field, no change to `tasks.ts` membership.
- No second media query, no new breakpoint, no change to the 360px grid reserve or shell geometry.

### 2.3 Focus must never be lost into a hidden subtree

`display: none` removes the focused element from the tab order; browsers move focus to `<body>`.
Required behaviour (**new, load-bearing**):

- Choosing a task by **mouse**: focus is on the radio that was clicked — no extra logic.
- Choosing a task by **keyboard** (arrow/Home/End): `TaskNav` already focuses the newly checked
  radio — unchanged.
- A **programmatic** task change while focus sits inside a section of the outgoing task (only the
  context bar and the reveal seam can do this): the panel focus seam already moves focus to the
  revealed target, and the context bar's Export/review actions do the same via
  `revealContextPanel`. rd-3b must add **one** guard: after a task change commits, if
  `document.activeElement` is inside a `.workbench-section` that is now `display: none`, focus the
  checked radio (`#task-<active>`). No `aria-live` announcement, no scroll, no new focus ring.
  This guard lives in `App.tsx` and is unit-testable with JSDOM only if the CSS is applied — it is
  not, so the authoritative proof is the e2e case in §6.3 (F-2).

### 2.4 Active-task marking

Keep the existing inset accent rule (it is already media-query scoped). It is redundant once other
sections are hidden, but it keeps `data-task` on the pane/sections load-bearing for the unit pin and
costs nothing. Do not add a second visual marker.

## 3. Preserved invariants (reviewed as blockers, not preferences)

1. **Sections mounted.** Never unmounted, never re-keyed; panel-local state (SQL draft, filter draft,
   record target, scroll offsets) survives any task switch. Proven in the browser, not only in JSDOM.
2. **<1024px unfiltered.** All 12 sections and all 5 nav groups exposed at 900px, no clipping, no
   horizontal scroll (ADR 0044 narrow contract).
3. **No behavioural bytes.** `packages/**` untouched; sessions hooks, engine client/worker, grid
   model, overlay/edit history, export bytes, validation report bytes, diff report bytes and the
   pipeline runner change by zero lines. No session-state read is added.
4. **Zero extra engine work.** A task switch request count is unchanged (the existing
   `App.task-switch` call-count pin covers the JS path; the e2e case re-asserts it with CSS hiding
   active).
5. **Copy unchanged.** Every approved string in the decisions record §2 stays byte-identical,
   including the stale sentences and the context bar states. rd-3b adds no copy.
6. **Radio-group semantics.** `role="radiogroup"` / `role="radio"` / `aria-checked` / roving
   tabindex; no `tab`/`tabpanel` roles anywhere.
7. **R-07 focus target.** Closing a section returns focus to `section-nav-<id>`; the link is exposed
   because its task is active.
8. **Flat DOM.** No task wrappers, no reorder beyond the already-shipped History-before-Export.
9. **One reviewed commit + one changeset.** No dependency, ADR, root config or telemetry change.

## 4. The migration problem, measured (not estimated)

Measured against `51ff36e` (`tests/e2e/`, 55 specs):

| Item                                                                                                 | Count   | Files |
| ---------------------------------------------------------------------------------------------------- | ------- | ----- |
| `openFixture` / `openCustomersFixture` / `openNestedFixture` / `openFixtureAndGetTableId` call sites | **138** | 26    |
| Direct `expandAllSections(page)` call sites                                                          | **9**   | 8     |
| Direct `openSection(page, id)` call sites                                                            | **6**   | 3     |
| `section-toggle-<id>` assertions                                                                     | **24**  | 6     |
| `section-nav-<id>` assertions                                                                        | **4**   | 2     |
| Specs referencing **more than one task group** (the real risk)                                       | **10**  | 10    |

The pickup's "~120 panel-expansion usages" is the 138 open-flow call sites, but they funnel through
**one** helper. Only 10 specs cross task boundaries; 45 do not (25 touch no task at all). That is
the honest size of the risk: a helper rewrite plus a **10-file** journey migration, not a
120-site rewrite.

### 4.1 Failure taxonomy (decides every migration edit)

| Class | Symptom                                                                                   | Sanctioned fix                                                                                             |
| ----- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| R1    | Reads text/attributes of a hidden node (`toHaveText`, `toHaveAttribute`, `toContainText`) | **No edit** — the node is attached. Do not add activation "to be safe".                                    |
| R2    | `toBeVisible` / `toBeInViewport` on a section outside the active task                     | Split into per-task legs, or narrow to `toBeAttached()` with a comment naming `rd-3b`                      |
| R3    | Click/fill/focus inside a panel whose task is inactive                                    | Activate that task first (`activateTask`) or use the auto-activating `openSection`                         |
| R4    | Click on `section-nav-<id>` whose group is hidden                                         | `activateTask` first, then click (the shell itself activates on click, but a hidden link is not clickable) |
| R5    | Whole-journey spec that expects panels from two tasks visible at once                     | Convert to explicit task legs (the real user journey is sequential)                                        |

### 4.2 Helper design (`tests/e2e/support/fixtures.ts`)

```ts
export type WorkbenchTask = 'explore' | 'check' | 'change' | 'prepare'
export const SECTION_TASK: Readonly<Record<string, WorkbenchTask>> = {
  schema: 'explore',
  filters: 'explore',
  sql: 'explore',
  profile: 'explore',
  validation: 'check',
  compare: 'check',
  editing: 'change',
  history: 'change',
  export: 'change',
  pipeline: 'prepare',
}

/** Idempotent: only clicks when the task is not already checked. */
export async function activateTask(page: Page, task: WorkbenchTask): Promise<void>

/** Task-aware and idempotent: activates the owning task, then opens the section. */
export async function openSection(page: Page, id: string, task?: WorkbenchTask): Promise<void>

/** Opens each task's managed sections in task order, then ends on `endTask` (default 'explore'). */
export async function expandAllSections(
  page: Page,
  options?: { readonly endTask?: WorkbenchTask },
): Promise<void>

/** `OpenFixtureOptions` gains `task?: WorkbenchTask` — forwarded as `endTask`. */
```

Rules for the helper rewrite:

1. `openSection(page, id)` derives the task from `SECTION_TASK` and **activates it before touching
   the toggle**; the `profile` inner disclosure is opened as today (Explore).
2. `expandAllSections` keeps opening **every** managed section (so no spec silently loses its
   "everything expanded" starting state) but does so **per task**, and ends on `endTask` so the last
   activation is the one the spec needs. It must not assert visibility of a section it opened after
   switching away.
3. `openFixture`'s existing `expandSections` option keeps its meaning; `task` defaults to
   `'explore'` (the shell default), so single-task specs whose task is Explore need **no edit**.
4. `openFilterBar`, `openFixtureAndGetTableId`, `openNestedFixture` stay signature-compatible; they
   inherit the task pass-through.
5. The helpers must stay **assertion-honest**: no retries-until-visible loops, no `force: true`, no
   `waitForTimeout`. Any `force` would hide exactly the bug this slice can introduce.

### 4.3 Per-file migration list

Legend: **T** = needs an explicit `task`/`activateTask`; **L** = needs task legs; **N** = expected
no edit (re-verify after the CSS change; R1 assertions only).

Single-task, non-Explore (need `task`):

| File                                  | Task    | Note                                                         |
| ------------------------------------- | ------- | ------------------------------------------------------------ |
| `diff-panel.spec.ts`                  | check   | opens Compare and drives the diff run                        |
| `validation-panel.spec.ts`            | check   | opens Validation                                             |
| `a11y-keyboard.spec.ts`               | change  | editing/history keyboard journey                             |
| `history-shortcuts.spec.ts`           | change  | History auto-expand and undo/redo                            |
| `m4-exit-journey.spec.ts`             | change  | staged edit → export                                         |
| `m6-exit-journey.spec.ts`             | change  | repair → validate → export (starts in Change, ends in Check) |
| `pipeline-gate-journey.spec.ts`       | prepare | gate execution                                               |
| `pipeline-panel-gate-journey.spec.ts` | prepare | gate panel                                                   |
| `pipeline-runner-journey.spec.ts`     | prepare | ordered runner                                               |

Cross-task (need legs `L`):

| File                               | Tasks                     | Prescription                                                                                                                                                                                                                |
| ---------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `m5-exit-journey.spec.ts`          | check → change            | Check leg (contract → failing → `Show row`), then Change leg (repair → History → Export). Sequential already; add activation at the two boundaries.                                                                         |
| `validation-report-export.spec.ts` | check → change            | Check leg for the report, Change leg for delivery.                                                                                                                                                                          |
| `column-ops.spec.ts`               | explore → change          | Explore leg (schema/filters), Change leg (editing).                                                                                                                                                                         |
| `profile-honesty.spec.ts`          | explore → change          | Explore leg (profile), Change leg (overlay revision).                                                                                                                                                                       |
| `pipeline-dcr-export.spec.ts`      | change → prepare          | Change leg (Artifact/Export), Prepare leg (pipeline run).                                                                                                                                                                   |
| `pipeline-panel-journey.spec.ts`   | explore → check → prepare | Three legs; assert each panel only inside its leg.                                                                                                                                                                          |
| `section-summaries.spec.ts`        | explore/check/change      | Summaries live inside collapsed toggles of Check/Change: read them per leg (R1 reads work attached, but `toBeVisible`/click needs the leg).                                                                                 |
| `a11y.spec.ts`                     | explore/check/prepare     | Each scan stays inside one task; activate before `scanA11y`, keep the existing empty allowlist.                                                                                                                             |
| `shell.spec.ts`                    | all four                  | Heading map split per task + full DOM-presence assertion; narrow (900px) keeps the complete exposed map.                                                                                                                    |
| `workbench-tasks.spec.ts`          | all four                  | Extend the existing rd-3 spec with the new exposure assertions (this is the natural home) or leave it and put them in the new spec (§6.3). Recommendation: **new spec**, so the rd-3 assertions stay as the slice-1 record. |

Everything else (`grid-*`, `record-*`, `engine-*`, `smoke`, `telemetry`, `theme`, `nested-*`,
`schema-panel`, `sql-editor`, `filter-builder`, `open-*`, …) is expected **N**; any failure there is
a real R2/R3 signal to triage, not a mechanical edit.

## 5. Unit-level pins (JSDOM cannot apply CSS — state this in the test)

`App.shell.test.tsx` already pins DOM order and nav-group membership; `App.task-switch.test.tsx`
pins preservation and zero extra work. rd-3b adds:

- `apps/web/src/shell-visibility.test.ts` (CSS-text + DOM-attribute pin, the `shell-geometry.test.ts`
  pattern): the two rules exist, live inside the `min-width: 1024px` block, use `data-task`/`:not`,
  and **no** `display: none` is declared for `.workbench-section` outside that block;
  `.workbench-tools` carries exactly one `data-task` value per render; Grid/Record carry **no**
  `data-task` attribute; all 12 sections stay in the DOM for every task.
- `App.shell.test.tsx`: a per-task exposure **attribute** test (section set present/absent by
  `data-task`), explicitly commented as "the real exposure proof is e2e; JSDOM applies no CSS".

## 6. Browser proof (the actual acceptance)

New `tests/e2e/workbench-visibility.spec.ts` (8 tests):

1. **1024×700 and 1440×900, Explore:** exposed section ids == `['schema','filters','sql','profile']`
   (+ Grid/Record in the center column); the other six have computed `display: none` and are
   `toBeAttached()`. Exposed nav groups == Explore + Workspace.
2. **Same, Check / Change / Prepare:** exposed sets are `[validation, compare]`,
   `[editing, history, export]`, `[pipeline]`; nav groups follow.
3. **Switch keeps state:** type a SQL draft in Explore → switch to Check → back to Explore: the
   draft is byte-identical, the panel was never remounted (no request logged), and the engine call
   count is unchanged.
4. **F-2 focus guard:** focus the SQL editor, then click Change (mouse) and Check (keyboard): focus
   is the checked radio, never `<body>`, and `document.activeElement` is never inside a hidden
   section.
5. **Reveal from a filtered state:** from Prepare, trigger the pipeline → validation cross-link (an App-level `revealSectionFromNav` action): the task switches to Check, the section is exposed, expanded, scrolled and focused; closing it returns focus to `section-nav-validation` (R-07). Separately, a `section-nav-<id>` click is only attempted after `activateTask` (R4) — a hidden link is never clicked.
6. **Context bar actions cross tasks:** `Review findings` from a stale verdict lands in Check and
   `Export a copy…` lands in Change with the dialog open and focus inside the dialog.
7. **900px:** all 12 sections and all 5 nav groups exposed, no horizontal clip, grid promoted, sticky
   jump strip — the ADR 0044 narrow contract, pinned in both schemes.
8. **axe per task, both schemes** (Explore/Check/Change/Prepare at 1024 and 1440): zero
   unallowlisted critical/serious violations, allowlist unchanged.

Negative controls (in the isolated worktree, never on uncommitted user work):

- Mutate the section rule to drop `:not([data-task='…'])` → test 1 must fail; restore, rebuild, prove
  the tree is clean.
- Mutate the nav rule to remove `data-active='false'` hiding → the nav-group assertion must fail;
  restore, rebuild.
- Remove the focus guard → test 4 must fail.

## 7. File reservations (one web writer)

**Runtime (2 files):** `apps/web/src/index.css`, `apps/web/src/App.tsx` (focus guard only; no new
state field unless the guard needs one — prefer the existing `activeTask` + an effect).

**Helpers/tests:** `tests/e2e/support/fixtures.ts`; the **9** single-task migration files in §4.3
(`diff-panel`, `validation-panel`, `a11y-keyboard`, `history-shortcuts`, `m4-exit-journey`,
`m6-exit-journey`, `pipeline-gate-journey`, `pipeline-panel-gate-journey`,
`pipeline-runner-journey`); the **10** cross-task files in §4.3 (`m5-exit-journey`,
`validation-report-export`, `column-ops`, `profile-honesty`, `pipeline-dcr-export`,
`pipeline-panel-journey`, `section-summaries`, `a11y`, `shell`, `workbench-tasks`); new
`tests/e2e/workbench-visibility.spec.ts`; `apps/web/src/App.shell.test.tsx`; new
`apps/web/src/shell-visibility.test.ts`; one `.changeset/*.md` for `@assay/web`. Total ≈ 26 files.

**Explicitly forbidden:** any `packages/**`; `apps/web/src/workbench/*` membership/copy files (only
`TaskNav` if a `data-*` attribute must be added — prefer CSS-only); sessions hooks; grid, record,
export, profile, SQL, schema, pipeline logic; telemetry; `apps/cli`, `apps/vscode`; root configs,
lockfiles, ADRs; any new dependency; any copy change; any threshold/timeout/allowlist change; push.

## 8. Budget and rollback

- Expected diff: ~2 runtime files (small), 1 helper, ~13–15 browser specs, 2 unit files, 1 changeset.
  No new component, no new state machine, no dependency.
- Rollback: `git revert <one commit>` restores "mark, don't hide" exactly; there is no storage, URL
  or router state. If the 10-file migration exceeds two fix rounds in review, **revert and
  re-scope** rather than growing the slice.

## 9. Done when

- §1 rows 1–7 hold in a real browser at 1024/1440; §1 width-check at 900 unchanged.
- §3 invariants proven: mounted panels survive task switches with a real draft; zero extra engine
  work; every approved string byte-identical; R-07 target intact; narrow unfiltered; no clip.
- §6 tests 1–8 pass, the three negative controls fail-then-restore, and the full gate sequence from
  map §6.1 is re-run **from the committed revision in a clean worktree** (format, lint, typecheck,
  unit, coverage, build, docs links, ADR index, full Playwright with `DUCKDB=/tmp/duckdb` and fresh
  ports, configured + restored telemetry legs because `App.tsx`/CSS change).
- Independent review (different model/session — `gpt-6-luna` xhigh per the standing roster) approves
  after reading the diff and running the gates itself. RD-R01/RD-T01 recorded as satisfied for the
  redesign; map row `rd-3b` closed with the merged revision and evidence.

## 10. Stop conditions

Stop and report (do not improvise) if: a `R1` assertion cannot stay untouched without weakening it;
a journey genuinely needs two tasks visible **at the same time** (that would question the IA, not the
CSS); the focus guard cannot be implemented without a new global state or a focus trap; any
`packages/**`/session/grid/engine/export byte changes; any gate or tooling failure; any threshold or
allowlist pressure; any request to hide at <1024px; any push.

## 11. Approval wording (maintainer)

> Authorize rd-3b exactly as scoped in
> `docs/process/handoff/20261104-rd3b-conditional-visibility-contract.md`: the two media-query
> CSS rules, the focus guard, the task-aware e2e helper rewrite, the 10-file cross-task migration and
> the new visibility spec, with the §3 invariants and §7 file reservations unchanged. One web writer,
> independent reviewer, full gates from the committed revision including the configured/restored
> telemetry legs, no push. Stop on any condition in §10.

_Superseded 2026-11-04: the maintainer gave exactly this authorization — [decisions record §7](20261104-rd-decisions-and-runtime-scope.md).
The paragraph below is kept as the pre-authorization gate it was._

Until that instruction exists, **rd-3b remains PROPOSED and no production or test file may be
changed for it.**
