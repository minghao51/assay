# UX/UI Pickup Prompts — historical, consumed pack

**Retired 2026-11-03 — do not dispatch from this pack.** All original runtime rows are closed.
The consumed worker briefs below are historical evidence, not ready-to-paste authorization.
New maintenance is tracked in the [audit follow-up queue](20261103-ux-audit-followup.md);
read the [live handoff](../handoff.md) and its owning queue before any dispatch.

## Current state

- **Merged-verified code tip `6457113`** (uxv-4) remains the last code change; **uxv-5 adds one
  documentation file** (`docs/product/10-ux-ui-demo-rehearsal.md`): **227 unit files / 3408 tests,
  e2e 217 passed + 1 skipped, coverage 89.15/83.89/91.42/90.73, docs links 120/0, ADR 46, 192
  changesets** (`/tmp/assay-ux-uxv4-merged/`; the doc delta was verified docs-only with links,
  prettier and the ADR index).
  **All 23 usability rows are CLOSED — the batch is complete**; the Grid, Panels and Shell lanes are
  all closed, as is the original visual lane's implementation work.
- **No original runtime UX row remains.** **uxv-1 (R-09) is CLOSED** at
  `d85dec2`, **uxv-2 (R-10) at `b487788`**, **uxv-3 (R-11) at `cd4fb3f`**, **uxv-4 (R-12) at
  `6457113`** and **uxv-5 (R-13) at `e3ae857`** (the
  [rehearsal pack](../../product/10-ux-ui-demo-rehearsal.md)). **Every runtime row in both UX queues
  is CLOSED**; uxv-6 is design-only and needs a maintainer decision before any code, and the
  remaining launch work is the human-only list. Do not redispatch any closed row **ug-1…ug-23** or
  **uxv-1…uxv-5**; anything that reopens a lane (e.g. the recorded `row-uninsert` domain-gloss
  trigger, uxv-2's two-of-nine browser focus coverage, uxv-3's unpinned Settings-over-Open check,
  uxv-4's inherited body styling for the engine lines, or uxv-5's evidence-only prose numbers) is a
  **new** row or an explicitly recorded rider.
- **Dispatch disposition:** uxv-1…uxv-5 are closed, not eligible or dependency-gated.
  uxv-6 remains design-only/deferred; the audit follow-up is a separate bounded queue.
- **Ownership:** the usability queue owns R-01…R-08, R-14, R-15 and R-16; the
  [visual queue](20261026-ux-ui-execution-queue.md) owns R-09…R-13.
- **Roster (user-requested):** worker **`opencode-go/deepseek-v4.1-flash`**; independent reviewer
  **`opencode-go/mimo-v2.6-flash`** at **thinking high** (switched from `openai-codex/gpt-6-luna`
  on 2026-10-31 when the Luna credit was exhausted). Never implement and approve the same change.
  Serialize provider sessions.
- **Push/remote:** latest recorded verified push is **`dee10f8`**. Subsequent UX changes are
  local-only; re-measure divergence with `git rev-list --left-right --count origin/main...HEAD`
  rather than treating this historical pack as a live counter. The local uncommitted `README.md`,
  `docs/assets/` and `.dsh/` are another agent's work: leave them untouched and do not describe the
  checkout as clean. **Workers never push**, and no blanket remote/push permission is granted by
  this pack or by an old handoff episode. Remote CI remains M6-blocked; local green is not remote
  green.
- **Historical evidence:** [usability queue](20261026-usability-queue.md) §1/§5,
  [visual queue](20261026-ux-ui-execution-queue.md), [handoff](../handoff.md) §9,
  [implementation spec](../../product/09-ux-ui-implementation-spec.md) §8. Closed worker briefs
  were deliberately removed; cite those records instead of re-running them.

## 1. Orchestrator prompt — RETIRED

The original paste-ready prompt was consumed by ug-21…ug-23 and uxv-1…uxv-5.
It is deliberately not a current dispatch template: use the
[audit follow-up queue](20261103-ux-audit-followup.md) and the [live handoff](../handoff.md).
Confirm each new row's base, reservations and independent-review gates before starting.

## 2. Historical worker briefs

Closed rows' briefs (ug-14, ug-4, ug-16, …) were deliberately removed from this pack. Their
authoritative evidence lives in the [usability queue](20261026-usability-queue.md) rows and
[handoff §9](../handoff.md). Sections 3c–4 retain consumed briefs for provenance only.

## 3c. Worker — ug-21 (Shell) — CONSUMED (ug-21 CLOSED at `8458ad1`; kept as the brief shape)

```text
Implement exactly ug-21: opening progress + cancel.

Read AGENTS.md, docs/process/handoff/operating-model.md, the live usability queue ug-21 row,
docs/product/09-ux-ui-implementation-spec.md §2 (Opening state), §6 (gates), §7 (STOPs), ADR 0044 and
ADR 0025, and the open flow: App.tsx (open-status, phase.kind === 'opening', openDataFile,
beginSession/datasetSession.tokenRef), lib/app.ts (openStatusCopy), sessions/session-reset.ts.
Confirm the orchestrator-provided base commit, isolated worktree, Shell ports 4273/4279/4280,
reserved files (apps/web/src/App.tsx + apps/web/src/lib/app.ts) and baseline evidence before editing.

Allowed: apps/web/src/App.tsx, apps/web/src/lib/app.ts (status/copy helpers only), focused tests, one
e2e spec or a focused addition, one feat(web): changeset. No change to the open chain's guards or
engine calls, no engine/grid protocol change, no new dependency, no broad restyle, no telemetry.

Contract:
(a) The opening state gains an indeterminate progress affordance (a native <progress> with no value,
or an equivalent role=progressbar with no invented percentage) next to the existing "Opening…"
status, visually subtle and value-free. Keep the existing open-status and live-region copy.
(b) Add a Cancel control visible only in the opening phase. It restores idle through the EXISTING
session-token guard: bump the session token the same way a new open would (reuse
datasetSession.beginSession(), or the smallest helper that bumps tokenRef and runs the registered
resets) and set the phase back to idle. Do not add a second cancellation path, do not touch
openDataFile's guard order, and do not introduce a new abort/engine mechanism (the engine op has no
interrupt — say so honestly if needed). A late result of the cancelled open must be discarded by the
token comparison (no phase flip, no error, no stale data), and a subsequent open must work normally.
Cancelling must not show an error and must not emit new telemetry.

Pins (non-vacuous):
- Component: opening renders the progress affordance + Cancel; Cancel -> idle, the in-flight open's
  late resolve is dropped (controllable deferred open), and a subsequent open reaches ready; ready/
  idle/error states render no Cancel; accessible names for the progress and the Cancel button.
- E2E: cancel mid-open with a deterministic slow open (a large synthetic temp fixture or a test-only
  delay in the file-read path — never a production hook) -> data-phase="idle", no error, and a
  follow-up open reaches data-phase="ready".
- Mutation drills (run, paste evidence, revert): (a) drop the token bump on cancel -> the
  late-resolve pin fails (phase flips to ready after cancel); (b) remove the Cancel control -> the
  UI/e2e pin fails; (c) give the progress a fixed value/percentage -> the indeterminate/a11y pin
  fails.

Run focused tests, then the six gates + coverage/docs/ADR checks from spec §6 (build before e2e,
CI=1 --retries=0). Leave one bounded feat(web): commit plus changeset. No push, no self-approval, no
silent scope growth. Report files, requirement evidence, exact commands/exit codes/counts, mutation
results, logs and blockers.
```

## 3d. Worker — ug-22 (Shell) — CONSUMED (ug-22 CLOSED at `e73dda4`; two commits, one request-changes round)

```text
Implement exactly ug-22: nav reading order (ruling-compliant).

Read AGENTS.md, docs/process/handoff/operating-model.md, the live usability queue ug-22 row, spec §2
state table, §6, §7, ADR 0044 and the q-15 placement ruling cited in the queue, and App.tsx
(WORKBENCH_SECTIONS, the sticky nav, revealSectionFromNav), App.shell.test.tsx (NAV_ORDER pin),
App.headings.test.tsx, App.section-purposes.test.tsx. Confirm the assigned base commit, isolated
worktree, Shell ports 4273/4279/4280, reserved files (apps/web/src/App.tsx + the nav/heading pins) and
baseline evidence.

Allowed: apps/web/src/App.tsx (WORKBENCH_SECTIONS order only), nav-order pins in App.shell.test.tsx /
App.headings.test.tsx if they assert order, one chore(web): changeset. Forbidden: ANY DOM reorder
(section element order, heading map, two-pane layout), copy changes to the twelve R-14 purposes,
engine/grid changes, new dependency, docs, push.

Contract: set WORKBENCH_SECTIONS to exactly schema, filters, grid, validation, compare, sql, editing,
history, export, record, profile, pipeline — a pure array edit. The pipeline stays last. The sticky
nav's link order, the reveal/scroll behavior and aria-describedby wiring follow the array; the DOM
order and heading map must be unchanged. Cite ADR 0044/q-15 in the commit message (the ruling
authorizes nav order only, not DOM reorder). Update NAV_ORDER and any nav-order pins; the twelve R-14
purpose/name pins and heading-map pins must stay green and unchanged.

Pins (non-vacuous): nav link testids in the exact new order; DOM section/heading order pinned
unchanged; clicking a nav link still expands/scrolls its target; pipeline last. Mutation drills:
(a) move a section element in the DOM instead of the array -> the heading-map pin fails; (b) drop
"record" from the array -> the nav-order pin fails.

Run focused tests, then the six gates + coverage/docs/ADR checks from spec §6 (build before e2e). Leave
one bounded chore(web): commit plus changeset. No push, no self-approval, no scope growth. Report
files, requirement evidence, exact commands/exit codes/counts, mutation results, logs and blockers.
```

## 3e. Worker — ug-23 (Shell) — CONSUMED (ug-23 CLOSED at `07a37d4`; approved on the first review)

```text
Implement exactly ug-23: code-observation riders CO-1…CO-4.

Read AGENTS.md, operating-model.md, the live ug-23 row, spec §6/§7, ADR 0044/0025; read App.tsx (the
pane toggle's and section nav's aria-labels; the usePipelineSession call-site comment),
grid/FilterBar.tsx (FilterChip key composition — note ug-18's header chips are removable and the body
chips are display-only), edit/op-summary.ts (row-uninsert: 'row expunge'), and the pane-toggle / nav /
chip pins. Confirm the assigned base commit, isolated worktree, Shell ports 4273/4279/4280, reserved
files (App.tsx, grid/FilterBar.tsx, edit/op-summary.ts) and baseline evidence.

Allowed: apps/web/src/App.tsx, apps/web/src/grid/FilterBar.tsx, apps/web/src/edit/op-summary.ts,
focused tests, one chore(web): changeset. No engine/grid protocol change, no copy beyond (d), no
behavior changes, no new dependency, no docs, no push.

Contract — land all four with pins where applicable:
(a) Correct the stale pipeline-jump comment at the usePipelineSession call site (p2-6 made previews
grid-native); comment-only, accurate, no code change.
(b) Make the FilterBar chip React key injective: today key = `${column}:${predicate}` can collide
(e.g. column "a:b" + predicate "c" vs column "a" + predicate "b:c"). Introduce a small injectable key
helper (e.g. JSON.stringify([column, predicate]) or a length-prefixed composite) used by the header
chips (and the display-only body list), with a pin that a deliberately colliding pair renders two
distinct chips and removes independently.
(c) De-duplicate the pane-toggle accessible name from the nav's "Workbench sections": give the pane
toggle its own action-reflecting name (e.g. "Collapse workbench pane" / "Expand workbench pane", or
"Toggle workbench pane") while the nav keeps "Workbench sections"; keep aria-expanded and
aria-controls, update name-based pins, and pin that the two names differ.
(d) Decide the plain-language gloss for the row-uninsert history summary ("row expunge") and apply it
consistently (e.g. "undo row insert" / "remove added row" — pick one, value-free) with a pin on the
rendered summary; if you judge no change is warranted, record the decision in the report instead of
inventing copy.
Mutation drills: revert the key to the colon join -> the collision pin fails; restore the shared
pane/nav name -> the distinct-name pin fails; revert (d) -> its copy pin fails.

Run focused tests, then the six gates + coverage/docs/ADR checks from spec §6 (build before e2e). Leave
one bounded chore(web): commit plus changeset. No push, no self-approval, no scope growth. Report
files, per-rider evidence, exact commands/exit codes/counts, mutation results, logs and blockers.
```

## 4. Worker — uxv-1 (Visual) — CONSUMED (uxv-1 CLOSED at `d85dec2`; uxv-2 also closed at `b487788`)

```text
Implement exactly uxv-1 (R-09): repair theme completeness.
Do not start unless the orchestrator states in this brief that (i) the recorded uxv-0 baseline and
the already-integrated ug-1/ug-2/ug-7 prerequisites are green, and (ii) you hold an EXCLUSIVE
reservation for index.css and the theme/telemetry test files. ug-21/ug-22/ug-23 (Shell) and
ug-18/ug-19 (Grid, closed) also touch CSS/App/FilterBar seams; no concurrent writer is allowed at
this seam.

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
session/model: reviewer opencode-go/mimo-v2.6-flash at thinking high; worker is
opencode-go/deepseek-v4.1-flash.

Read AGENTS.md, operating-model §7.3/7.6, the owning queue, the spec (§2 requirement/copy, §3
recovery, §4 visual contract where applicable, §6 gates/evidence, §7 STOPs, §8 index) and the
worker brief/report. Confirm the base/worktree/ports match the reviewed commit.

Inspect git show/diff and scope. Run the six core gates plus coverage/docs/ADR checks yourself,
then the row's focused tests/specs. Rebuild before browser evidence. Verify counts, new
assertions, absence of vacuous mocks, and same-input/view agreement. Check copy/privacy, no new
telemetry, no changed export/report bytes, no new dependency, no DOM direction change, and a
Conventional Commit plus changeset where required.

Run meaningful temporary mutations for load-bearing behavior (e.g. remove the token bump on cancel,
swap the nav array for a DOM reorder, restore the colliding chip key, restore the shared pane/nav
name), confirm the right test fails, then revert only your mutants and rebuild restored source.
Never fix the author's runtime code while approving, never commit, never push.

Return: files reviewed; numbered must-fix findings with file:line evidence; exact checks and
mutation results; remaining risks; final line exactly
VERDICT: approve
or
VERDICT: request-changes
```

## 6. Thread sequencing and shared-file reservations

- **The original usability and visual batches are complete.** ug-21 closed at `8458ad1`,
  ug-22 at `e73dda4`, ug-23 at `07a37d4`; uxv-1…uxv-5 are also closed. There is no next
  dispatch in this pack. The reservations below describe consumed work, not active claims.
- **Shared-file reservations:** ug-21 reserves `App.tsx` + `lib/app.ts`; ug-22 reserves `App.tsx` +
  the nav/heading pins; ug-23 reserves `App.tsx` + `grid/FilterBar.tsx` + `edit/op-summary.ts`.
  State the reservation in each worker brief.
- **Ports:** Shell lane 4273/4279/4280 via `ASSAY_E2E_PORT_WEB/ENGINE/DS`; merged verification uses
  the default ports 4173/4179/4180 (or the documented alternate 4573/4579/4580 if occupied).
- **Docs closure:** after each row, update the owning queue row + §2 lane/frontier, handoff §6/§9,
  spec §1/§6 (and §8 if a requirement row is touched), the open-threads map and this pack's
  current-state block — in the same change as the code integration.
