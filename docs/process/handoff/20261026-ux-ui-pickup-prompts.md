# UX/UI Pickup Prompts — current pack

**Refreshed 2026-10-29 (docs only).** This is a small ready-to-paste pack for the **current**
frontier, not an archive of completed dispatches. Re-read the live queues and the tree before
every use; a prompt never overrides a closed/claimed/blocked row.

## Current state

- **Runtime baseline recorded at `385649b`** — not the current `main` tip, which is the later
  docs-only reconciliation commit `ea41533` at the time of this refresh. Re-check HEAD; later docs
  refinements do not establish a new runtime baseline. At the baseline: **195 unit files / 3089 tests, e2e 185
  passed + 1 skipped, coverage 88.08/82.24/89.08/89.60**, docs links 116/0 at that revision
  (current pack: 117/0), ADR index 46, all gates exit 0. Evidence: `/tmp/assay-merged-ug9/`.
- **Next runtime candidates:** **ug-16 (Panels, READY)**, **ug-17 (Shell)** and **ug-4 (Grid)**; choose one bounded row,
  preserving each lane's order and shared-file reservations. Do not redispatch closed rows
  **ug-1, ug-2, ug-3, ug-7, ug-8, ug-9, ug-13**; their evidence is in the
  [usability queue §1/§5](20261026-usability-queue.md) and [handoff §9](../handoff.md).
- **Visual row:** **uxv-1** is factually eligible now, **only** with an exclusive
  CSS/theme-test reservation held by the orchestrator. **uxv-2…uxv-5** stay dependency-gated
  (uxv-2 after uxv-1; uxv-3 after uxv-2; uxv-4 after ug-3 and uxv-3; uxv-5 after uxv-1…4 plus
  ug-3/7/8). **uxv-6** is design-only/deferred.
- **UX-D1 RESOLVED 2026-10-30 (Option C); ug-10 CLOSED at `f667a87`:** R-16 shipped (base-as-opened
  hint + staged-changes note, no stale/re-run banner). The overlay-aware profile is a separate
  planning-only engine candidate ([20261030-overlay-profile-candidate.md](20261030-overlay-profile-candidate.md)),
  not authorized for dispatch. **ug-16 CLOSED 2026-10-31 at `3b494f5`** (profile stats
  click-to-act; typed refusal, no remap; see [the design record](20261030-ug16-renamed-column-design.md)),
  **ug-17 CLOSED 2026-10-31 at `9a31cd6`** (collapsed section state summaries), **ug-4 CLOSED
  2026-10-31 at `784805c`** (capability-true grid interaction language) and **ug-5 CLOSED
  2026-10-31 at `d814fdf`** (focused-cell copy), so the Panels successor **ug-20 and the Grid
  successor ug-6 are now eligible**.
- **Ownership:** the usability queue owns R-01…R-08, R-14, R-15 and R-16; the
  [visual queue](20261026-ux-ui-execution-queue.md) owns R-09…R-13.
- **Roster (user-requested):** worker **`opencode-go/deepseek-v4.1-flash`**; independent
  reviewer **`openai-codex/gpt-6-luna`** at **thinking high**. Never implement and approve the
  same change. Serialize provider sessions.
- **Push/remote:** latest verified push is **`dee10f8`**; **`ea41533` is local-only (HEAD 1
  ahead / 0 behind)**.
  The local uncommitted `README.md`, `docs/assets/` and `.dsh/` are another agent's work: leave
  them untouched and do not describe the checkout as clean. **Workers never push**, and no
  blanket remote/push permission is granted by this pack or by an old handoff episode. Remote
  CI remains M6-blocked; local green is not remote green.
- **Historical evidence:** [usability queue](20261026-usability-queue.md),
  [visual queue](20261026-ux-ui-execution-queue.md), [UX-D1 brief](20261029-ux-d1-amendment.md),
  [implementation spec](../../product/09-ux-ui-implementation-spec.md) §8. Closed task
  templates were deliberately removed; cite those records instead of re-running them.

## 1. Orchestrator — paste into the next session

```text
You are the Assay UX/UI orchestrator. Continue the current pack; do not restart the
investigation or redesign broadly.

Read first, in order: AGENTS.md; docs/process/handoff.md §§4–6; operating-model.md fully;
docs/process/handoff/20261026-usability-queue.md §1–§5; docs/product/09-ux-ui-implementation-spec.md
fully (especially §6 gates, §7 STOPs, §8 index); docs/process/handoff/20261026-ux-ui-execution-queue.md;
docs/process/handoff/20261026-ux-ui-pickup-prompts.md; task-relevant ADRs and ADR 0044.

Current truth to confirm, not assume: branch/commit/status, queue owners, toolchain, ports.
The runtime baseline is recorded at 385649b (195f/3089t, e2e 185p+1s, coverage
88.08/82.24/89.08/89.60); dee10f8 was the later verified docs push, ea41533 is local-only, and
neither is a permanent HEAD.
Verify current HEAD and a fresh baseline from
a clean isolated worktree at your chosen base before runtime dispatch. Preserve all foreign
uncommitted work (README.md, docs/assets/, .dsh/). Never reset/stash/delete unknown work.

Select one of these eligible candidates, one bounded row per worker, with an independent reviewer
(no new cross-lane dependency is imposed by this list):
1) ug-6 (Grid) — undo/redo keyboard shortcuts + history surface cue (read the live ug-6 row).
2) ug-20 (Panels) — validation on-ramp + filter-replacement disclosure (eligible after ug-16's
   landed `3b494f5`; no ready-to-paste brief in this pack yet — read the live ug-20 row).
3) ug-21 (Shell) — opening progress + cancel (read the live ug-21 row).
4) uxv-1 (Visual) — theme completeness, ONLY if you can hold an exclusive CSS/theme-test
   reservation; otherwise keep it unclaimed and do not improvise a styling batch.
Do not redispatch closed rows ug-1/2/3/4/5/7/8/9/10/13/14/15/16/17. Do not dispatch uxv-2…5
(dependencies) or uxv-6 (design-only). The overlay-profile candidate is planning only.

Before dispatch, reserve shared files and state the reservation in the brief. Lanes are NOT
absolutely parallel-safe: App/CSS/FilterBar are touched by ug-14/ug-23 (Shell) and ug-18 (Grid).
Serialize such conflicts and inspect integration diffs.

Roster: worker opencode-go/deepseek-v4.1-flash; independent reviewer openai-codex/gpt-6-luna
thinking high. Workers never push. Latest verified push is dee10f8; ea41533 is local-only — do
not claim the current
uncommitted tree is pushed or grant blanket remote permission.

Use the task templates in this file. Record starting commit, clean-status evidence, environment,
ports, exit codes and log paths under /tmp. A request-changes verdict returns to a fresh worker
brief quoting the exact fixes. Integrate only independently approved rows and re-run merged gates.
Update the owning queue, handoff index/changelog and open-issues map in the same change. Do not
mark the UX program complete because a row lands.

First response: checkout/queue state, proposed base, reservations for the next row, blockers, and
the single next dispatch.
```

## 2. Worker — ug-14 (Shell) — CLOSED 2026-10-30, do not dispatch

> Retained only as the shape of a bounded worker brief. ug-14 is CLOSED at `c694eca` and ug-15 at
> `8a38e0e`; the next Shell row is **ug-17**. Do not paste this as a live task.

```text
Implement exactly ug-14: open-failure recovery + error-copy consolidation.
Read AGENTS.md, docs/process/handoff/operating-model.md, the live usability queue ug-14 row,
findings UG-5/UG-30/UG-25 in docs/reviews/2026-10-26-usability-gap-review.md, and spec §2
(Open error), §6 (gates) and §7 (STOPs). Confirm the orchestrator-provided base
commit, isolated worktree, Shell ports (4273/4279/4280 or assigned free set), reserved files and
baseline evidence before editing. Requirement basis is the queue row (UG-5/UG-30/UG-25); there is
no R-ID for this row, so the queue is authoritative.

Allowed: apps/web/src/App.tsx, sql/SqlPanel.tsx, profile/ProfilePanel.tsx, grid/FilterBar.tsx,
edit/session.ts (shared first-line-reducing helper), focused tests, and one changeset. No engine
or grid protocol change, no new dependency, no broad restyle, no shared docs/root config.

(a) open-error pairs a one-line human cause with "Choose a different file…" retry that
re-triggers openDataFile; raw engine detail stays behind <details>; pin with a corrupt fixture.
(b) adopt a shared first-line-reducing engine-error helper with per-panel framing on
open/SQL/profile/filter; fix the validation/diff edit-leak per UG-25; unit pins for single-line
messages on those paths. Keep errors local and honest; do not hide them under welcome copy.

Run focused tests, then the six gates + coverage/docs/ADR checks from spec §6; build before e2e.
Focused starting points: pnpm exec vitest run apps/web/src/App.open-status.test.tsx
apps/web/src/grid/FilterBar.test.tsx; pnpm exec playwright test tests/e2e/data-sources.spec.ts
tests/e2e/smoke.spec.ts tests/e2e/shell.spec.ts. Add the corrupt-fixture retry pin.

Leave one bounded fix(web): commit plus changeset. No push, no self-approval, no silent scope
growth. Report files, requirement evidence, exact commands/exit codes/counts, logs and blockers.
```

## 3. Worker — ug-4 (Grid)

```text
Implement exactly ug-4: make the grid interaction language visible.
Read AGENTS.md, handoff/operating-model, the live usability queue ug-4 row, and spec §2 state
table, §6 gates and §7 STOPs. Confirm the assigned base commit, isolated worktree, Grid ports,
reserved files and baseline evidence. Requirement basis is the queue row (UG-9/UG-33).

Allowed: apps/web/src/grid/DataGrid.tsx, its focused tests, and one changeset. No engine/grid
protocol change, no App shell restyle, no other row's feature.

(a) Persistent one-line editing hint on ready grids, verbatim: "Double-click a cell to edit ·
Enter edits the focused cell · Esc cancels", wired as aria-describedby for the grid role.
(b) A "Keyboard" section in the existing grid footer <details> listing edit/inspect/navigate keys.
Done-when: hint visible on first ready paint (component + one e2e); shortcut list pinned;
DataGrid.keyboard and a11y-keyboard specs green.

Run focused tests, then the six gates + coverage/docs/ADR checks from spec §6; build before e2e.
Focused starting points: pnpm exec vitest run apps/web/src/grid/DataGrid.keyboard.test.tsx
apps/web/src/App.shell.test.tsx; pnpm exec playwright test tests/e2e/a11y-keyboard.spec.ts
tests/e2e/grid-editing.spec.ts.

Leave one bounded fix(web): commit plus changeset. No push, no self-approval, no scope growth.
Report files, requirement evidence, exact commands/exit codes/counts, logs and blockers.
```

## 3b. Worker — ug-16 (Panels) — CLOSED 2026-10-31, do not dispatch

> Retained only as the shape of a bounded worker brief. ug-16 is CLOSED at `3b494f5` (feature
> `30063f4` + review fix `3b494f5`, worker commits `9c5310b`/`472be2a`). The next Panels row is
> **ug-20**; ug-17 (Shell) and ug-4 (Grid) remain eligible. Do not paste this as a live task.

```text
Implement exactly ug-16: profile stats click-to-act, under the settled design.
Read AGENTS.md, docs/process/handoff/operating-model.md, the live usability queue ug-16 row,
docs/process/handoff/20261030-ug16-renamed-column-design.md (authoritative: resolution rule,
byte-exact copy, acceptance), spec §2 R-16, §6 gates and §7 STOPs. Confirm the orchestrator-provided
base commit, isolated worktree, Panels ports (4373/4379/4380 or assigned free set), reserved files
and baseline evidence before editing.

Allowed: apps/web/src/profile/**, App.tsx click-to-act bridge + refusal state, edit/session.ts
(pure rename-chain resolver), reuse grid/filter-builder.ts and query-state.ts, focused tests, one
e2e journey, one feat(web): changeset. No packages/** engine/protocol/domain change, no new
dependency, no broad restyle, no telemetry, no push, no docs.

(a) Top-k value click applies a builder-compiled = 'value'; null-count click applies IS NULL; chips
appear via the existing FilterBar (no grammar change).
(b) Resolve the profile's base column against the current effective schema before compiling. A
renamed column applies NO filter and shows the byte-exact renamed refusal (naming base and current);
an unresolved column applies NO filter and shows the generic refusal. Never remap silently.
(c) Cast/type mismatch: compile against the effective column type; show the builder's readable
single-line rejection (or the existing framed filter error after an engine rejection); never coerce.
(d) Zero-row results after a resolved click keep the existing empty state. R-16 hint/note and
profile-table-id unchanged; no re-profile.

Pins: unit for the resolver (rename chain, rename-back, unresolved, undo/redo); component per
action + both refusals + zero-row; one e2e profile→filtered grid; mutation drills: remove the
rename/unresolved guard (renamed click applies a base-name filter → pin fails) and drop the
current-name lookup (copy loses the name → pin fails).

Run focused tests, then the six gates + coverage/docs/ADR checks from spec §6; build before e2e.
Leave one bounded feat(web): commit plus changeset. No push, no self-approval, no silent scope
growth. Report files, requirement evidence, exact commands/exit codes/counts, logs and blockers.
```

## 4. Worker — uxv-1 (Visual), only with an exclusive reservation

```text
Implement exactly uxv-1 (R-09): repair theme completeness.
Do not start unless the orchestrator states in this brief that (i) the recorded uxv-0 baseline and
the already-integrated ug-1/ug-2/ug-7 prerequisites are green, and (ii) you hold an EXCLUSIVE
reservation for index.css and the theme/telemetry test files. App/CSS/FilterBar are also touched by ug-14/ug-23
(Shell) and ug-18 (Grid); no concurrent writer is allowed at this seam.

Read AGENTS.md, handoff/operating-model, the live visual queue uxv-1 row, spec R-09, §4 (semantic
surfaces), §6 (configured-disclosure evidence, gates) and §7 STOPs.

Allowed: apps/web/src/index.css; telemetry theme/component tests; tests/e2e/theme.spec.ts;
tests/e2e/a11y.spec.ts; a new isolated tests/visual/telemetry-disclosure-theme.spec.ts and its
config (outside the default tests/e2e testDir). No consent/storage/event changes, no new
dependency, no production testing hook, no collector traffic.

Fix undefined surface usage so Settings and the telemetry disclosure use a defined semantic
surface in both schemes; prove both real surfaces readable (normal text >= 4.5:1) with axe clean
and no new allowlist. Run the configured-disclosure leg exactly as spec §6 specifies (abort
https://collector.example.invalid/**, fresh local storage, no service workers), then restore and
rebuild the stock output before stock gates. Stock telemetry.spec.ts intentionally asserts no
disclosure; do not run it against the configured build.

Mutation: restoring the undefined white fallback must fail the dark contrast evidence; revert the
mutant and rebuild restored source before final verification.

Run focused checks plus the six gates + coverage/docs/ADR checks from spec §6. Leave one bounded
fix(web): commit plus changeset. No push, no self-approval, no visual scope beyond R-09. Report
screenshots (scheme/surface), axe results, evidence, logs and blockers.
```

## 5. Independent reviewer — generic for any current runtime row

```text
Independently review the assigned row and worker commit against the live queue done-when and the
spec requirement IDs, not against the worker's preferred implementation. You must be a distinct
session/model: reviewer openai-codex/gpt-6-luna at thinking high; worker is
opencode-go/deepseek-v4.1-flash.

Read AGENTS.md, operating-model §7.3/7.6, the owning queue, the spec (§2 requirement/copy, §3
recovery, §4 visual contract where applicable, §6 gates/evidence, §7 STOPs, §8 index) and the
worker brief/report. Confirm the base/worktree/ports match the reviewed commit.

Inspect git show/diff and scope. Run the six core gates plus coverage/docs/ADR checks yourself,
then the row's focused tests/specs. Rebuild before browser evidence. Verify counts, new
assertions, absence of vacuous mocks, and same-input/view agreement. Check copy/privacy, no new
telemetry, no changed export/report bytes, no new dependency, no DOM direction change, and a
Conventional Commit plus changeset where required.

Run meaningful temporary mutations for load-bearing behavior (e.g. remove the hint/description
wiring, remove the corrupt-file retry path, restore the white surface), confirm the right test
fails, then revert only your mutants and rebuild restored source. Never fix the author's runtime
code while approving, never commit, never push.

Return: files reviewed; numbered must-fix findings with file:line evidence; exact checks and
mutation results; remaining risks; final line exactly
VERDICT: approve
or
VERDICT: request-changes
Approval covers this row only, not the program, release or remote CI.
```

## 6. Continuation after request-changes or interruption

```text
Continue the assigned row only. Re-read live status. Independent review required exactly these
fixes: PASTE_NUMBERED_ITEMS. Existing work/commits: LIST_AND_SHA. Do not discard or blindly adopt
artifacts. Fix only the requested items inside the original boundary, re-run the required gates
and focused checks, and send the result to a fresh independent reviewer. STOP if scope must grow.
No self-approval, push, unrecorded skip or queue closure. State precisely what is committed,
uncommitted, verified and still blocked.
```
