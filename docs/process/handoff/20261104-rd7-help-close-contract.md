# rd-7 — Help, accessibility/performance gates and closure: scope contract

**Status: CLOSED 2026-11-04 — merged `2ddd67a` (+ test pin `de342da`), independently approved, gates in
[map §6.10](20261104-svg-implementation-map.md), review and runtime record in [design record §14](../../product/13-workbench-redesign-design-record.md).**
The approved copy shipped byte-exact; RD-T07 remains an accepted limitation and no usability claim is made.

Requirements: [map](20261104-svg-implementation-map.md) row `rd-7`; [review](../../product/12-workbench-redesign-review.md)
RD-R01…RD-R08 / RD-T01…RD-T08, especially RD-T05 (keyboard/AT/zoom/schemes/modal competition) and RD-T07.

## 1. What this slice is (and is not)

It closes the redesign, so it is the only slice whose acceptance is _cumulative_: every RD-T row must be
either evidenced (already, by rd-3…rd-6) or explicitly limited. It is **not** a feature slice: the Help
surface is secondary guidance, and D-02 means **no usability claim** is made anywhere.

**Deliverables**

1. **Minimal Help** — one global guide in a native `<dialog>`, opened from a header control, with
   app-local modal ownership arbitrated against Export, the telemetry disclosure and Settings.
2. **Accessibility/recovery pass** — Help in both schemes at 1024/1440/900, keyboard-only, Esc, focus
   return to the opener, one-modal-at-a-time; the existing axe/keyboard/theme/recovery suites re-run
   unchanged.
3. **Performance record** — measure and record the current numbers in design record §14 (first paint at
   1024×700, task-switch cost, and the existing render/query/worker count pins). **No new thresholds.**
4. **RD-T07 record** — the explicit accepted limitation (no participants, no AT study), stated in design
   record §13 and in the map row, with the prohibition on “validated/intuitive” wording.
5. **Closure accounting** — RD-R01…R08 / RD-T01…T08 either evidenced (pointing at the existing tests and
   slice records) or limited; the map row closed with the merged revision and gates.

## 2. Help content contract (structure)

One native `<dialog>` (`data-testid="workbench-help"`), opened by a header button
(`data-testid="help-open"`), closed by a close button (`help-close`) and Esc; focus returns to the opener.
Content order: **what this is → the four tasks → formats and locality → keyboard**. No new modal library,
no navigation, no links out, no telemetry.

## 3. Constraints that shape the copy

- The guide must be **accurate about capability**: four input formats (Parquet, CSV, JSONL/NDJSON, JSON);
  Arrow is export/transport only; the VS Code surface, not this one, is the offline one.
- It must **not** claim offline operation for the web app, and must not contradict `product/09` R-05
  (“DuckDB may separately autoload its JSON engine extension over the network … cold-cache offline opening
  is not promised”).
- It must **not** claim user validation (D-02).
- Copy is **value-free** (ADR 0025): no file names, no counts, no dataset content.
- Reuse the approved task purposes **byte-exactly** — they are already approved for the task strip.

## 4. Approved copy (2026-11-04, byte-exact — copy it verbatim)

**Title and open control:** “Workbench guide” / button label “Help”.

### 1. What this is

> Inspect, check, change and deliver a dataset without leaving this machine. Nothing is uploaded; the
> file you open is never modified. Changes are staged in this session and exported as a new copy.

### 2. The four tasks

Reuse the approved purposes exactly; this section is a list of task name → approved purpose:

- **Explore** — Understand what is in the file: fields, filters, query and statistics.
- **Check** — Find quality issues or explain differences between two versions.
- **Change** — Make a reversible repair, review staged operations and deliver a copy.
- **Prepare** — Run deterministic steps and inspect gate and delivery evidence.

Followed by:

> Choose a task to see the sections it uses. Grid and Record stay available in every task.

### 3. Formats and locality

> Reads Parquet, CSV, JSONL/NDJSON and JSON; Arrow is an export format, not an input. This browser app may
> download DuckDB's Parquet or JSON reader from `extensions.duckdb.org` the first time it opens such a
> file, so opening one without a network connection is not guaranteed. The desktop app ships those readers
> locally.

### 4. Keyboard

> The task strip is a radio group: arrow keys move between tasks, Home and End jump to the first and last.
> Section links move focus to the section. In the grid, arrows move the focused cell and Enter opens the
> editor. Esc closes a dialog.

Nothing else. These strings are approved as a set: implement them **verbatim** (including punctuation) and
pin each with an exact-string test. Any change requires a new approval.

## 5. Tests (done-when)

**Unit** (`apps/web/src/help/WorkbenchHelp.test.tsx`, new): renders the four approved purposes
byte-exactly; opens as a native dialog with an accessible name; Esc and the close button both close;
focus returns to the opener; no value/filename text; no telemetry call.

**Browser** (`tests/e2e/workbench-help.spec.ts`, new): open from the header at 1024×700 and 1440×900 in
both schemes → dialog visible, initial focus inside, Tab stays inside, Esc closes, focus back on
`help-open`, axe with the **unchanged** allowlist; the content states the four formats and does **not**
claim offline web operation or user validation; at 900×900 the guide is usable without horizontal clip.

**Modal arbitration** (extend the same spec): with Export open, the Help control is not reachable behind
the modal and no second dialog opens; opening Help from Settings or the telemetry disclosure is blocked the
same way; closing each modal returns focus to its own opener. No new trap implementation — the existing
app-local modal ownership is reused.

**Cumulative**: the existing `a11y`, `a11y-keyboard`, `theme`, `record-keyboard`, `panel-recovery`,
`grid-virtualization`, `shell` and `workbench-*` suites pass unchanged (no threshold/allowlist edits).

## 6. Performance record (no new gate)

Capture, in design record §14, the measured values from the built app at 1024×700: first-paint
(picker→first row), a task switch (state-preserving, zero extra engine work), and the existing pinned
counts (`shell-geometry`, `grid-virtualization` fetch counts, `App.task-switch` call counts). State
plainly that these are observations, not a threshold, and why (D-04: a wall-clock gate on shared CI is
noise).

## 7. Files reserved

- New: `apps/web/src/help/WorkbenchHelp.tsx`, `apps/web/src/help/WorkbenchHelp.test.tsx`,
  `tests/e2e/workbench-help.spec.ts`.
- `apps/web/src/App.tsx` (header control, modal intent/ownership, render location), `apps/web/src/index.css`
  (scoped Help classes only), and their narrow existing tests if the header changes their assertions.
- One `.changeset/*.md` (`@assay/web`, minor: new user-visible Help surface).

**Forbidden:** any session hook, engine/grid/export/validation/diff/pipeline logic, report or export bytes,
copy other than §4, `workbench/tasks.ts` membership or purposes (reused, not edited), telemetry semantics,
root configs/lockfile/ADRs/dependencies, thresholds/timeouts/allowlists, push.

## 8. Gates, review, rollback

Full map §6.1 sequence from the committed revision in a clean worktree, **plus** the configured and
restored telemetry legs (this slice changes `App.tsx`/CSS). Independent reviewer on a different
model/session with its own mutation (e.g. drop the Esc handler or the focus return). Rollback is
`git revert <commit>`.

**Stop conditions:** a Help string that cannot be made accurate without a new capability decision; any
modal arbitration that requires a new trap or a session change; any capability/offline/validation claim
the docs do not support; any gate/allowlist pressure.

## 9. Closure accounting (the part that makes this “rd-7”)

Record in the design record: RD-R01…R08 / RD-T01…T08 with either the evidence pointer (slice record +
test) or the explicit limitation (RD-T07, and the D-02/D-06/door-gap notes). That table — not the Help
surface — is the actual deliverable of “validate and close”.
