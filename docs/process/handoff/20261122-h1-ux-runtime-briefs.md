# H1 — UX runtime briefs (2026-11-22)

**Date:** 2026-11-22. **Base:** `main` at `6b2c9fd`. **Status:** dispatch-ready briefs for the UX
rows the [decision round](20261121-decision-round.md) §3/§5 and the
[successor queue](20261121-successor-queue.md) §9 recorded as **DECIDED-NOT-NOW**. Writing them
down authorises nothing: each item opens only through its named reopen trigger. Entry point,
dispatch envelope and the local-only gate suite: the
[remaining-work index](20261122-remaining-work-handoffs.md) §0/§2.

**Line anchors drift.** Every `path:line` below was read at the base revision and is drift-prone
(the index says the same); re-verify with a read or grep before citing one in a commit.
Anchor-free claims cite a record section instead.

**Closed rows are not reopened here.** WF-00/01/01P/02/05/06/10, E01, E04-WF-O1 (shipped as A2
`030aa87`, successor queue §8.1), ADR 0044/0047/0049/0050/0051 and the rd programme stay exactly
as their closing records say. In particular: **WFD-06 = B is settled** (scalar temporal display,
WF-01 closed `b6b773d`); **ADR 0044's grid-centric layout stands**; **D-02 A is the evidence
rule** — no copy, record or commit message produced from these briefs may say "validated",
"intuitive", "easier" or anything equivalent (RD-T07 is an accepted limitation until R-21 runs).

**Stale sources — read with care.** The [pickup briefs](20261110-web-followup-pickups.md)
self-declare "history, not a dispatch queue": their WF-03/04/07/08/O2 inserts are reusable method
but were written against `7fa1e78` and before WFD-06 settled. The
[map](20261110-web-followup-map.md) §3 still shows WF-06 as "SELECTED — awaiting preflight" and
the [spec](../../product/14-web-interface-followup-spec.md) header still says WF-06 needs runtime
authorization; WF-06 merged `ba36091` on 2026-11-13 (handoff current-state block; EW-10 record).
None of that changes the items below.

### R-1 — WF-03 shell/panel presentation

**Status:** DECIDED-NOT-NOW · reopen trigger: a recorded WFD-05 selection naming the chosen
subparts and every changed string (approval record §4 keeps WFD-05 "pending": "No WF-03 subparts
selected; no new welcome/first-minute strings approved").
**Row/source:** [map](20261110-web-followup-map.md) §2 WFD-05 row, §3 WF-03 row and the WF-03
file-reservation row; [spec](../../product/14-web-interface-followup-spec.md) §3 T-WF03 and §4.3;
[decision round](20261121-decision-round.md) §5; successor queue §9 final row; pickups §3 "WF-03"
insert (method only).
**Why it is not shipped yet:** the 2026-11-10 approval selected only WF-00/01P/02/05-design; WFD-05
(bounded presentation and copy) was left pending and the 2026-11-21 decision round kept WF-03
decided-not-now. The subparts exist and are small — what is missing is the maintainer's itemized
choice and, for any new string, its approval.

**Contract (already decided — do not reopen):**

- WFD-02 = A: tasks stay navigation/exposure; WF-03 must not add edit gating (map §2 WFD-02).
- ADR 0044 (grid-centric two-pane shell, accepted ruling D14) stands; no centre replacement and
  no pane/geometry change under this row.
- The rd-7 Help copy is approved byte-exact (D-03 resolved 2026-11-04, decisions record §13); the
  Help surface is one global native dialog (`apps/web/src/help/WorkbenchHelp.tsx`) with one opener
  (`data-testid="help-open"`, `apps/web/src/App.tsx`).
- Preserve the heading map, focus targets, and each section toggle's name/aria description;
  removing or replacing an h2 needs a recorded old→new heading/reading-order contract first
  (spec §4.3.2). `apps/web/src/App.headings.test.tsx` is load-bearing.
- Modal ownership (Help/Export/disclosure/Settings arbitration) and idle/ready focus return are
  preserved; both telemetry legs are mandatory for App/header/CSS/modal changes (spec §6.2).
- No new theme preference, tokens overhaul, layout breakpoint or SQL resizing (spec §4.3); SQL
  sizing is R-6, not a rider here.

**The choice this item still needs:** the WFD-05 subpart selection (map §2 WFD-05), itemized:

1. **Help beside Settings** (the map's recommended first subpart): move the single Help opener
   from its inline header line into the Settings cluster (`TelemetrySettings` opener near the page
   heading, `apps/web/src/App.tsx`). Consequence: one App.tsx move plus opener-position and
   focus-return assertions; all copy unchanged; no duplicate responsive Help button.
2. **Hierarchy cleanup**: remove visual repetition by style/spacing only. Consequence: scoped CSS
   and markup classes; h2s stay; the heading-map tests must pass unchanged.
3. **Optional welcome layout (idle-only) with existing copy** — capability/format/privacy/engine/
   example strings already in `apps/web/src/lib/app.ts`. Consequence: an idle-block insertion plus
   scoped CSS; no new promises; Open/example/drop remain available after failures.
4. **New first-minute strings** — only by itemized approval of the spec §4.3 candidate rows
   (`Session changes are not saved automatically. Export a copy to keep them.`,
   `Opening another dataset replaces this session.`, `Arrow/Feather input is not supported.`).
   Consequence per row: a truth check against delivered behaviour and a byte-exact pin. Note the
   second row's gate ("never imply a guard before WF-06") must be re-read against the shipped
   WF-06 replacement guard (`ba36091`) before approval.

**"Keep current + copy" — the smallest implementable option:** if the maintainer keeps the current
header/panel arrangement and approves no markup move, the smallest landed option is subpart 3
alone — an idle-only welcome block assembled from **existing** copy strings, inserted in the
existing `phase.kind === 'idle'` region of `apps/web/src/App.tsx` (the uxv-4 insertion pattern),
with scoped CSS only if needed and phase presence/absence tests. It needs zero string approvals,
no header move and no heading change. If even that is declined, WF-03 closes as a recorded
"keep current" no-op and only subpart 4 could ever reopen it.

**Files (reserved):** from the map's WF-03 reservation row, verified to exist at base:

- `apps/web/src/App.tsx` — header cluster and/or idle block.
- `apps/web/src/index.css` — scoped presentational CSS only.
- `apps/web/src/App.headings.test.tsx`, `apps/web/src/App.shell.test.tsx`,
  `apps/web/src/App.section-purposes.test.tsx` — regression, additive assertions only.
- `apps/web/src/help/WorkbenchHelp.tsx`, `apps/web/src/help/WorkbenchHelp.test.tsx` — only if
  opener wiring/position assertions need it.
- `apps/web/src/lib/app.ts`, `apps/web/src/lib/app.test.ts` — copy constants if (and only if)
  approved new strings land.
- `tests/e2e/shell.spec.ts`, `tests/e2e/workbench-help.spec.ts` — affected journeys, additive.
- `(new)` `apps/web/src/workbench/WelcomeBlock.tsx` (+ test) — only if the selection wants the
  welcome block as its own presentational component; otherwise the idle block stays in App.tsx.

**Implementation steps:**

1. Re-read the WFD-05 selection record; stop if absent or if copy is unapproved.
2. (Subpart 1) Relocate the Help opener beside the Settings opener in `apps/web/src/App.tsx`,
   keeping `data-testid="help-open"`, `aria-haspopup="dialog"`, the
   `helpBlocked || intent.kind !== 'none'` disabled guard and the `openModal` arbitration
   unchanged. Behaviour: one Help opener in idle/ready/configured, focus returns to it on close.
3. (Subpart 2) Scoped CSS/markup classes in `apps/web/src/index.css` and the named nodes in
   `apps/web/src/App.tsx`. Behaviour: reduced visual repetition with an unchanged heading map.
4. (Subpart 3) Idle-only block in the `phase.kind === 'idle'` region composing existing `IDLE_*`
   strings from `apps/web/src/lib/app.ts`. Behaviour: the welcome content is absent in
   opening/ready and claims nothing new.
5. (Subpart 4, per approved row only) Add byte-exact constants in `apps/web/src/lib/app.ts` and
   render them; pin the exact strings in `apps/web/src/lib/app.test.ts`.
6. Add the focused assertions named under Tests; run both telemetry legs (configured + restored).

**Tests:** `App.headings.test.tsx` heading-map pins pass unchanged; `App.shell.test.tsx` header
geometry and 1024×700 first-row/footer pins; `WorkbenchHelp.test.tsx` byte-exact Help copy and
opener focus return; `lib/app.test.ts` byte-exact copy pins plus the existing forbidden-claim
scan pattern; idle/ready absence-presence legs in `App.open-status.test.tsx` style;
`tests/e2e/shell.spec.ts` ready-top/first-paint; `tests/e2e/workbench-help.spec.ts` idle/ready/
configured modal matrix. **Mutation drill:** change one byte of the Help dialog copy (or of an
approved welcome string) — the byte-exact pin must fail; restore byte-identically and prove the
tree matches the candidate commit.

**Gates:** targeted first (the touched unit files, `tests/e2e/shell.spec.ts`,
`tests/e2e/workbench-help.spec.ts`), then the full local suite per
[Verification protocol](#verification-protocol); App/header/CSS/modal changes additionally need
both telemetry legs (spec §6.2: configured endpoint-present run, then endpoint-free stock rebuild
plus affected stock suites).

**Evidence to record:** the closing commit message names the WFD-05 selection and each approved
string verbatim; the ledger entry (successor queue §8/§9 or a dated successor) carries the map
§5 integration record fields (baseline/worker/reviewer/merged SHAs, reservation, gate exits and
counts, focused proof + mutation + restore, telemetry leg results, limitations).

**Stop rules:** any ADR 0044 conflict (grid-centre or pane geometry change); unselected subparts
or unapproved copy; heading removal without an approved heading contract; a wire or persisted
change; a package-boundary crossing; missing telemetry legs; any usability claim (D-02 A).

**Done-when:** the selected subparts render the approved arrangement/copy with the Help text,
heading map and modal ownership unchanged, proven by the named pins and both telemetry legs — or
the row closes as a recorded "keep current" no-op.

**Depends on:** the maintainer's WFD-05 answer (subparts + exact strings). Nothing else; WF-06
(`ba36091`) is merged and does not block this row.

### R-2 — WF-04 contextual next action

**Status:** DECIDED-NOT-NOW · reopen trigger: an approved WFD-03 decision/copy truth table — the
policy option plus the full input/output/copy set, approved as a unit (map §2 WFD-03; approval
record §4 keeps WFD-03 "pending").
**Row/source:** map §2 WFD-03 row, §3 WF-04 row and the WF-04 file-reservation row; spec §3
T-WF04 and §4.4; [rd decisions](20261104-rd-open-decisions.md) §1 D-06/D-11 and §4; decision
round §3 D-06/D-11 rows and §5; pickups §3 "WF-04" insert.
**Why it is not shipped yet:** WFD-03 is unselected; spec §4.4 states "Given the missing approved
table, WF-04 is not ready for a runtime worker". The 2026-11-21 round re-accepted D-06 = A (the
staged-comparison gap stays recorded) and D-11 = A (run-origin metadata stays open), so both
inputs are still out of scope unless the WFD-03 selection explicitly reopens them.

**Contract (already decided — do not reopen):**

- WFD-02 = A (tasks remain navigation); no task-purpose or Help copy changes (map §2).
- Policy constraints from spec §4.4: global busy cancellation, stale/error review and
  `Back to findings` stay reachable across tasks; at most one primary action; a neutral Explore
  suggestion must not erase a current stale warning; Export is never gated on a loaded contract;
  changing tasks changes presentation only — never schedules a run or other engine work.
- Pipeline `refused`/`gated`/`error`/`cancelled` are distinct from completion/delivery; no
  pipeline action label may be invented by a worker. The "WF-02 before naming pipeline outcomes"
  prerequisite is satisfied — WF-02 closed `b65e304` (label-only).
- The current precedence in `apps/web/src/workbench/next-action.ts` (`deriveNextAction`:
  validation-running → diff-running → contract none/unreadable → validation states →
  comparison/delivery after a current valid verdict) is the baseline; the `APPROVED_COPY` set and
  cross-product test in `apps/web/src/workbench/next-action.test.ts` are load-bearing and must
  stay independently authored (no import of implementation constants — synchronized drift is a
  rejected pattern, spec §4.4).
- D-06 = A and D-11 = A unless the WFD-03 record explicitly reopens them; origin metadata
  additionally needs atomic capture and its own session-file authorization (spec §4.4).

**The choice this item still needs:** the WFD-03 policy option (map §2 WFD-03), itemized:

- **A — keep the current global check→comparison→delivery priority.** Consequence: smallest
  change; the truth table mostly pins existing behaviour plus any approved wording fixes.
- **B — task-aware nonurgent suggestions while keeping global busy/stale/error access** (the map's
  design recommendation). Consequence: a larger approved output set; the same global precedence
  for busy/exception states; the exhaustive cross-product grows by every task × state pair.
- **C — task-only actions that suppress other-task state.** Not recommended; would remove global
  access and contradicts spec §4.4.

Plus two yes/no answers carried inside WFD-03: reopen **D-06** (add the staged state
`Comparisons staged — no comparison has run yet` → `Review comparison`, decision round §3 D-06
option B — "small and scoped" but new copy and a derivation branch) and reopen **D-11**
(run-origin metadata; recommended no). Finally: approve every output string and the complete
reachable output set as one unit.

**Files (reserved):** from the map's WF-04 reservation row, verified to exist:

- `apps/web/src/workbench/next-action.ts`, `apps/web/src/workbench/next-action.test.ts`.
- `apps/web/src/workbench/DatasetContextBar.tsx`,
  `apps/web/src/workbench/DatasetContextBar.test.tsx`.
- Narrow action wiring in `apps/web/src/App.tsx` (normalization of existing session states only).
- `(new)` app-local pure selector + test (e.g. `apps/web/src/workbench/action-policy.ts` +
  `action-policy.test.ts`) if the approved table is implemented as a selector.
- `apps/web/src/pipeline/pipeline-model.ts`, `apps/web/src/pipeline/usePipelineSession.ts` —
  **read-only** (pipeline type reads; no runner/model edits).

**Implementation steps:**

1. Confirm the approved WFD-03 table exists; stop without it (a docs-only table proposal is the
   only permitted first substep if the maintainer asks for one).
2. Encode the approved table as the pure selector over the existing input domain (contract /
   validation / diff / stale flags / jump origin; staged-B only if D-06 was reopened; pipeline
   states only if selected). File: the new selector or `next-action.ts`.
3. Wire `App.tsx` to pass normalized existing state only — no shadow session, no timers.
4. Extend the exhaustive cross-product and bidirectional copy-set equality in
   `next-action.test.ts`, keeping `APPROVED_COPY` independently authored.
5. Pin concurrency precedence (two independent busy sources; delayed outcomes land on the right
   owner) and the "one primary action" rule in `DatasetContextBar.test.tsx`.
6. Verify task switches perform no engine work (see Tests).

**Tests:** `next-action.test.ts` exhaustive selector cross-product plus full output-set equality
and independent bidirectional copy equality; `DatasetContextBar.test.tsx` (single primary,
`context-back-to-findings` reachable, `context-review` only where the table allows);
`App.task-switch.test.tsx` asserting zero engine calls on task switch; a concurrent-busy case
(validation + diff running) with defined precedence. **Mutation drill:** invert one precedence
branch (e.g. let `contract === 'none'` render while validation is running) — the cross-product
pin must fail on that input tuple; restore byte-identically.

**Gates:** targeted (workbench unit tests, `App.task-switch.test.tsx`, then the narrow e2e legs in
`tests/e2e/workbench-tasks.spec.ts` / `tests/e2e/workbench-visibility.spec.ts`), then the full
local suite; App wiring changes require both telemetry legs (spec §6.2).

**Evidence to record:** closing commit message names the WFD-03 option and any reopened D-06/D-11
row; ledger entry with map §5 integration record fields; the full approved output set quoted in
the record; mutation + restore proof.

**Stop rules:** runtime work without the approved table; any new engine call on task switch or
hidden extra query; session-hook edits (need separate approval); D-06/D-11 content without an
explicit reopen; a wire or report-metadata change; a package-boundary crossing; a second primary
action or automatic run; usability claims (D-02 A).

**Done-when:** every reachable render maps to exactly one approved action with the approved
strings, pinned by the exhaustive cross-product and copy-set equality, with global busy/stale/
error access preserved in every task.

**Depends on:** the maintainer's WFD-03 answer (policy + table + copy, ± D-06/D-11). WF-02 is
merged; no other item blocks this one.

### R-3 — WF-07 visible row range

**Status:** DECIDED-NOT-NOW · reopen trigger: an approved WFD-07 wording plus the exact
bounds/zero/loading/filter/sort/overlay contract (map §2 WFD-07; approval record §4: "No
`Visible rows X–Y of N` contract approved; WF-07 stays BLOCKED").
**Row/source:** map §2 WFD-07 row, §3 WF-07 row and the WF-07 file-reservation row; spec §3
T-WF07 and §4.6; decision round §5; [EW-02 scope contract](20261113-ew02-scope-contract.md) §3.2
"Not a WFD-07 collision" note; pickups §3 "WF-07" insert.
**Why it is not shipped yet:** the wording choice (WFD-07) was never made; the decision round
kept the row decided-not-now. The measurement source already exists — `DataGrid` owns the
rendered geometry — so what is missing is the approved copy and the state contract, not machinery.

**Contract (already decided — do not reopen):**

- Positions are **1-based current-view positions**, not durable base row IDs; a filtered/sorted/
  insertion view keeps its existing gutter/logical-ID semantics (spec §4.6).
- X/Y = rows whose data area actually intersects the viewport, excluding the sticky header and
  overscan (`VIRTUALIZER_OVERSCAN_ROWS = 6`, `apps/web/src/grid/DataGrid.tsx:29`); clamp to the
  known total; a partly visible first/last row counts; when all rows fit, show `1–N` — not the
  overscanned window (spec §4.6).
- Static text only: no live region, no per-scroll announcement, no new keyboard trap or focus
  target; the footer must keep fitting the accepted desktop geometry (uxv-3 pinned the footer in
  frame at 1024×700) and keeps its existing busy/diagnostic siblings
  (`grid-footer`, `DataGrid.tsx:1445`).
- No `packages/grid` API expansion, no new engine count/fetch/query, no paging, selection,
  bulk operations or base-row renumbering (spec §4.6; map WF-07 reservation).
- The SQL result page label `rows {a}–{b}` (`apps/web/src/sql/paged-query.ts`) is a different
  surface; EW-02 scope contract §3.2 records it is **not** a WFD-07 collision and must not be
  reworded here.
- WF-01's shared grid work is merged (`b6b773d`); the map's "after WF-01 shared grid changes"
  dependency is satisfied.

**The choice this item still needs:** the WFD-07 wording (map §2 WFD-07), itemized:

- **A — `Visible rows X–Y of N`** for viewport positions, with empty `No rows` and
  unknown/loading `Row range unavailable` (the map's recommendation, spec §4.6 exact copy).
  Consequence: one footer label plus the state table below; needs the bounds contract approved.
- **B — keep the current total-only display.** Consequence: WF-07 closes as a recorded no-op.
- **C — logical base-row IDs.** Not recommended: it is not a viewport range and would collide
  with the existing gutter/logical-ID semantics.

Plus: approve the zero/one/many/loading/error/filtered/sorted/insert/delete/resize state contract
(spec §4.6 lists the cases) with the exact strings.

**Files (reserved):** from the map's WF-07 reservation row, verified to exist:

- `apps/web/src/grid/DataGrid.tsx` — geometry derivation and footer label.
- `(new)` `apps/web/src/grid/DataGrid.row-range.test.tsx`; additive assertions only in
  `apps/web/src/grid/DataGrid.busy.test.tsx`, `DataGrid.scroll.test.tsx`,
  `DataGrid.row-number.test.tsx`.
- `apps/web/src/index.css` — scoped only if the footer layout needs it.
- `(new)` `tests/e2e/grid-row-range.spec.ts`, or a narrow leg added to
  `tests/e2e/grid-virtualization.spec.ts`.

**Implementation steps:**

1. Confirm the approved WFD-07 wording/contract; stop without it.
2. Derive X/Y from the rendered row elements' intersection with the scroll viewport (excluding
   the sticky header and the overscan tail of `virtualItems`, `DataGrid.tsx:761`) — not from the
   virtualizer window bounds. File: `DataGrid.tsx`.
3. Render the approved string in `grid-footer` beside the existing counters and `busyStatus`
   (`DataGrid.tsx:1552`); update on scroll/resize through the existing virtualizer re-render.
4. Implement the zero/unknown states per the approved table (`No rows` /
   `Row range unavailable`) without touching query/paging code.
5. Prove no extra fetch/query/render work (call-count pin) and footer fit at 1024×700.

**Tests:** zero rows; single row; all-rows-fitting shows `1–N`; middle scroll `X–Y`; end clamp;
filter with no results; sort reorder; inserted/deleted/undone rows; loading/unknown total; resize
and scroll-restoration updates; overscan exclusion (the label must never name an overscan-only
row); request-counter/call-count pin (no extra engine work). **Mutation drill:** report the last
visible index as the `virtualItems` end (overscan-inclusive) — the overscan-exclusion assertion
must fail; restore byte-identically.

**Gates:** targeted (the named DataGrid unit files + the narrow e2e leg), then the full local
suite; if `apps/web/src/index.css` is touched, both telemetry legs are required (spec §6.2 covers
CSS edits).

**Evidence to record:** closing commit message quotes the approved wording; ledger entry with map
§5 integration record fields; the state-table proof (all named states rendered in tests); the
mutation drill and its restore proof.

**Stop rules:** overscan-based or base-ID ranges; a new live region or scroll announcement; an
extra engine count/fetch; a `packages/grid` change; rewording the SQL page label (EW-02 §3.2);
unapproved copy; footer geometry regression; usability claims (D-02 A).

**Done-when:** the grid footer shows the approved wording whose X/Y equal the actually visible
1-based positions in every listed state, with no extra engine work and unchanged gutter semantics.

**Depends on:** the maintainer's WFD-07 answer. WF-01 is merged; nothing else blocks it.

### R-4 — WF-08 / WF-09 layout study

**Status:** DECIDED-NOT-NOW · reopen trigger: a WFD-04 selection — option A commissions the
WF-08 study; option B additionally requires a **new accepted superseding ADR** before any runtime
row; option C is prohibited.
**Row/source:** map §2 WFD-04 row, §3 WF-08 and WF-09 rows; spec §3 T-WF08/T-WF09 and §4.7;
decision round §5; [ADR 0044](../../adr/0044-workbench-shell-two-pane.md); the SVG board
references in spec §3 (T-WF08: boards 03/06/07/08/12; sketches under `assests/svg/`).
**Why it is not shipped yet:** WFD-04 (geometry/IA) is unselected; the decision round kept the
pair decided-not-now with ADR 0044 standing. The map is explicit that WF-09 is "Not executable
from this pack" — implementation needs a successor spec and architecture approval that do not
exist. This item is therefore a **study/measurement brief first**; implementation follows only
after the study and (for any centre change) a new superseding ADR.

**Contract (already decided — do not reopen):**

- ADR 0044 stands: the grid is the persistent centre at ≥1024; tools left; Record dock;
  <1024 stacks. Option C (immediate grid-centre replacement) is prohibited (map §2 WFD-04).
  A new ADR supersedes; the accepted one is never rewritten or renumbered (spec §4.7).
- Study only for WF-08: no production editing, no pane-width change, and no reopening of SQL
  sizing (SV-D04/uxv-6 = R-6) merely because the study mentions it (map §2 WFD-04; the pickup
  orchestrator brief repeats this).
- Fixed synthetic cases, not five rows and an empty panel (spec §4.7): long plans, wide schemas,
  long contract/rule names, real failure examples, sparse/many rows, dirty session, staged B and
  SQL page states.
- Viewport/scheme matrix (spec §2): both schemes, 1024×700, 1440×900, 1920×1080, 900px fallback
  and 200% zoom; capture actual canvas bounds (the whole 1600×1120 board or scaled fit) and the
  same app fixture per comparison.
- Static screenshots are not a usability result; the missing human evidence must be stated
  (RD-T07, D-02 A). No participant claim may be made from this study.

**The choice this item still needs:** the WFD-04 option (map §2 WFD-04), itemized:

- **A — keep ADR 0044, study in-shell legibility first** (recommended). Consequence: WF-08 runs
  as a read-only study comparing in-shell fixes vs alternatives; no runtime authority follows.
- **B — prototype alternate centre content, then seek a new accepted superseding ADR.**
  Consequence: the study may compare B without runtime authority; WF-09 stays blocked until the
  ADR is accepted and an exact contract exists.
- **C — immediately replace the grid centre.** Prohibited; stop if requested.

Plus: the study scope (which cases/excerpts of the board set) and whether the report includes a
counterbalanced human-study **design** (design only — recruitment belongs to R-21/H3).

**Files (reserved):** WF-08 is docs and isolated prototypes only:

- `(new)` study report under `docs/reviews/` (dated path fixed at dispatch by the orchestrator).
- `(new)` prototype files under `assests/prototypes/` (the existing prototype home:
  `assests/prototypes/rd-nav-a.html`, `rd-task-led-b.html`).
- Read-only: `apps/web/src/App.tsx`, `apps/web/src/index.css`, `apps/web/src/workbench/`,
  `apps/web/src/grid/DataGrid.tsx`.
- WF-09: **no runtime reservation exists** (map §3); do not edit production code under this item.

**Implementation steps (study phase):**

1. Build the fixed case matrix (every case × viewport × scheme listed in the contract).
2. Produce before/after prototypes for A (in-shell hierarchy/density fixes) and B
   (task-dominant centre with a persistently reachable grid/Record) at the required sizes.
3. Measure and record: canvas bounds, reading order, focus flow, scroll behaviour, and any
   additional worker/query/render effects (counted, not estimated).
4. Rank the options by cost, record exact ADR impacts (0044 for B; none for A) and the human-
   evidence gap. STOP: no production editing.
5. (Only after a WFD-04=B selection and a new accepted superseding ADR) WF-09 proceeds under its
   own successor spec with named old→new geometry/DOM/reading-order/focus contracts, shared-state
   lifetime proof and staged, reversible migration — that brief is out of scope here.

**Tests:** the study's completeness proof is its case matrix: every required fixture × viewport ×
scheme case present and captured; prototypes run standalone; `git status` shows changes only in
the reserved docs/prototype paths (no production diff). **Mutation drill:** delete one required
case (e.g. the 1024×700 long-plan cell) from the recorded matrix — the completeness check
(walk of cases vs captures) must fail; restore byte-identically.

**Gates:** docs-only: `pnpm format:check`, `pnpm docs:links:check`, `pnpm adr:index:check` plus
the no-runtime-diff proof; explicitly record that runtime was **not** revalidated (spec §6.3
docs-only rule). Any future WF-09 runtime row gets the full suite instead.

**Evidence to record:** closing commit message names the WFD-04 option; the report records every
measured bound, the ranked comparison, the exact ADR impacts and the evidence gaps; ledger entry
(successor queue §8/§9 or a dated successor).

**Stop rules:** production editing; a pane-width change; reopening SQL sizing; ADR 0044 rewritten
or renumbered; any usability claim from screenshots/prototypes (D-02 A); dispatching WF-09
without the new accepted ADR and exact contract.

**Done-when:** a reviewed study report and isolated prototypes compare A vs B at the required
sizes with measured bounds, ranked costs, ADR impacts and stated evidence gaps — and no runtime
change has been made.

**Depends on:** the maintainer's WFD-04 answer (A or B). WF-09 additionally depends on the study
result, a new accepted superseding ADR and an exact migration contract.

### R-5 — WF-O2 temporal parity for nested previews / Record tree / untyped SQL results

**Status:** DECIDED-NOT-NOW · reopen trigger: an approved type-propagation contract — its own
scope/type/fixture/reservation approval (map §3 WF-O2: "design required"; "no runtime
reservation until type propagation is specified").
**Row/source:** map §2 WF-O2 row and the WF-O2 reservation row; spec §3 T-WFO2 and §4.8 WF-O2;
[E04 design](20261120-e04-bounded-ux-design.md) §4 (the WF-O2 outline, explicitly "NOT
AUTHORIZED NOW") and §2/§3 for what is already closed; decision round §5.
**Why it is not shipped yet:** WF-01 deliberately left nested/Record/SQL rendering raw and named
this as the explicit residual (closed `b6b773d`; `apps/web/src/grid/format.ts` module doc says so
in the `wf-01` paragraph). E04 §4 supplies the design outline only; the contract that says who
owns declared child types and SQL result metadata has not been written or approved.

**Contract (already decided — do not reopen):**

- **WFD-06 = B stands**: UTC deterministic ISO-like text at the exactly delivered precision, raw
  fallback otherwise, `TIMESTAMP_NS` always raw (`apps/web/src/grid/temporal-display.ts`); scope
  was scalar grid cells + display-copy (approval record §9/§10). This item must not alter the
  scalar rules, the editor seeds, or any raw transport.
- Invariants preserved verbatim: the nested preview's total/deterministic/length-capped
  (120)/depth-capped (3)/distinct-null contract (`apps/web/src/grid/nested-preview.ts` module
  doc) and the record tree's circular/unreadable markers
  (`apps/web/src/record/record-tree.ts` module doc). Type-decoding must fail soft to the raw
  value on any payload/type mismatch (E04 §4).
- Copy parity goal (E04 §4): one value renders identically in the grid cell, nested preview,
  Record tree and SQL result — the record tree already reuses `formatNestedPreview` summaries.
- Non-goals (E04 §4; spec §4.8): export/edit/filter raw fidelity unchanged; no Arrow→rows
  projection change; no engine/wire change; no "parse any number into a date"; no unsupported
  timezone/precision inference.
- Today's state is deliberate, not a bug to sweep: nested previews decode decimal leaves through
  the declared type when known but keep MAP children type-blind and do not decode temporal leaves
  (`nested-preview.ts`); the Record tree pins raw timestamp summaries; the SQL result calls
  `formatCell(cell)` with no declared type from a page carrying column names only
  (`apps/web/src/sql/SqlPanel.tsx` result table; `apps/web/src/sql/paged-query.ts`).
- E04 §2/§3 scope is closed elsewhere and must not be reopened here: the filter-draft clarity
  work shipped as A2 (`030aa87`), and the scalar WF-01 surfaces stay as delivered.

**The choice this item still needs:** the contract's itemized decisions (E04 §4, spec §4.8) —
none is decided yet, so "none" does not apply:

1. Declared child-type ownership through struct/list/map/union (the list element type, struct/
   union field types; what happens for MAP children and unmodelled containers).
2. Record full-depth tree schema ownership and the hostile-input safety rule.
3. SQL result metadata source: real Arrow result field metadata under computed expressions and
   aliases — never base-table column guessing.
4. The disposition table: which byte-exact raw-timestamp assertions are intentionally replaced
   and which raw-fidelity tests are retained (export/edit/filter pins stay).
5. The fixture/performance matrix and the exact file reservation.

**Files (reserved):** design phase: `(new)` dated type-propagation contract under
`docs/process/handoff/` (path fixed at dispatch). Runtime is **not reserved** until the contract
is approved; the map's inspection set — verified to exist — is the expected surface:
`apps/web/src/grid/nested-preview.ts` + `nested-preview.test.ts`, `apps/web/src/grid/format.ts` +
`format.test.ts`, `apps/web/src/record/record-tree.ts` + `record-tree.test.ts`,
`apps/web/src/record/RecordInspector.tsx`, `apps/web/src/sql/SqlPanel.tsx`,
`apps/web/src/sql/paged-query.ts` + `paged-query.test.ts`, plus a fixture reservation named by
the approved contract.

**Implementation steps:**

1. (Design) Enumerate the consumer × type matrix at the current transport — reuse the WF-01P
   method (real-engine probes with temporary `/tmp` synthetic inputs, no repository edits).
2. (Design) Write the contract: items 1–5 above, the precision/timezone limits (exactly the
   WFD-06 = B rules), and the fail-soft rule. STOP for maintainer approval.
3. (Runtime, after approval) Propagate declared child types into `formatNestedPreview` and the
   Record tree so nested and Record leaves decode decimals **and** temporals under the scalar
   rules; keep totality.
4. (Runtime) Thread the SQL result's declared column metadata through `paged-query`/`SqlPanel`
   into `formatCell`; never guess types from base-table columns.
5. (Runtime) Replace exactly the enumerated raw-timestamp assertions; keep the retained
   raw-fidelity pins for export/edit/filter green.
6. Record the residual (what remains raw and why) instead of claiming a full fix.

**Tests:** cross-surface parity (one temporal/decimal value renders identically in grid cell,
nested preview, Record tree and SQL result); nested struct/list decimal **and** temporal leaves;
MAP/UNION and hostile containers remain total (circular/unreadable markers intact); SQL alias and
computed-expression metadata; NULL/`TIMESTAMP_NS`-always-raw cases; existing `format.test.ts`,
`copy-cell.test.ts`, `nested-preview.test.ts`, `record-tree.test.ts`, `paged-query.test.ts`
behaviour retained or explicitly replaced per the contract. **Mutation drill:** drop the
declared-type channel in one nested leaf branch (render raw) — the cross-surface parity assertion
must fail; restore byte-identically.

**Gates:** targeted (the named unit files + `tests/e2e/nested-grid.spec.ts`,
`tests/e2e/nested-decimal.spec.ts`, `tests/e2e/record-inspector.spec.ts`,
`tests/e2e/sql-editor.spec.ts`, `tests/e2e/temporal-display.spec.ts`), then the full local suite;
telemetry legs only if App/header/CSS/modal surfaces are touched (spec §6.2).

**Evidence to record:** closing commit message cites the approved contract and WFD-06 = B as
unchanged; the disposition table (replaced vs retained assertions) in the ledger entry; parity
and raw-fidelity proofs; mutation + restore proof.

**Stop rules:** reopening WFD-06 = B or the scalar scope; an engine/wire change; a
package-boundary crossing without an amendment; weakened hostile-input totality; any "all
temporal displays fixed" claim; usability claims (D-02 A).

**Done-when:** nested previews, the Record tree and typed SQL results render temporal/decimal
leaves under the same approved rules as scalar cells, with the contract's assertion disposition
honoured and raw fidelity unchanged for export/edit/filter.

**Depends on:** maintainer approval of the type-propagation contract (a human/maintainer action);
E04 §4 is outline material, not approval.

### R-6 — uxv-6 / UX-D2 adjustable SQL sizing

**Status:** DECIDED-NOT-NOW · reopen trigger: a dated record of concrete evidence that the fixed
SQL pane blocks a real task (see the exact evidence list below), plus a maintainer request/
approval of the bounded spec amendment (D-08 = B).
**Row/source:** uxv-6 row in the [visual queue](20261026-ux-ui-execution-queue.md) §2 and the
UX-D2 row in the [product/09](../../product/09-ux-ui-implementation-spec.md) open-decision table;
[rd decisions](20261104-rd-open-decisions.md) §1 D-08 and §4; decision round §3 D-08 and §5;
map §2 WFD-04 ("SQL sizing remains SV-D04 unless explicitly reopened") and §4 sv-10/11 crosswalk.
**Why it is not shipped yet:** D-08 = A was accepted on 2026-11-21 with the stated reason "No
evidence; the deferral is deliberate and unchanged". The row is design-only and "DEFERRED / NOT
DISPATCHABLE AS CODE" (visual queue §2); UX-D2 requires a maintainer-approved bounded spec
amendment before anything moves.

**Contract (already decided — do not reopen):**

- The fixed-pane spec stands: tool pane ~320–360px per
  [product/05](../../product/05-workbench-shell.md) §3 (as delivered: 320px at 1024–1199px,
  360px at ≥1200px, uxv-3). Exceeding those bounds needs "exact changes to product/05" and
  architect escalation (uxv-6 row).
- WF-03 excludes SQL resizing (spec §4.3); WF-08/WF-04 must not reopen it as a rider
  (map §2 WFD-04). ADR 0044 stands.
- SQL outcome copy is pinned by the EW-02 scope contract §3.2 (status words, empty/truncated/
  cancel notes); sizing work must not reword any of it.

**The choice this item still needs:** D-08, itemized (rd decisions §1 D-08):

- **A — keep deferred** (current, re-accepted 2026-11-21). Consequence: this item stays
  decided-not-now; nothing is implemented.
- **B — reopen**: specify sizing/placement and outcome focus, then implement. Consequence: a
  maintainer-requested amendment of the uxv-6 shape — adjustable pane limits, minimum grid
  width, keyboard resize/reset, below-breakpoint behaviour, a test plan, and exact changes to
  `docs/product/05-workbench-shell.md` if its pane bounds would be exceeded; accepted-ADR changes
  require architect escalation.

**Evidence that would reopen it (exactly one of):**

1. A dated journey or measurement showing a real task impeded by the fixed SQL pane at a
   supported viewport (1024×700, 1440×900, 1920×1080) — e.g. wide result sets or long
   statements that cannot be worked in the delivered pane; or
2. an explicit maintainer instruction that the sizing direction is wanted despite D-08 = A.

Nothing weaker reopens it: the existence of roomy SVG boards is not evidence ("Roomy board 03 is
not approval", map §3 sv-10 row), and neither is a layout study mentioning SQL space (R-4's stop
rules).

**Files (reserved):** design phase only: `docs/product/05-workbench-shell.md` (the amendment) and
`(new)` a dated design record under `docs/process/handoff/`. Runtime paths are **not reserved**;
named for planning only: `apps/web/src/App.tsx`, `apps/web/src/index.css`,
`apps/web/src/workbench/PanelBoundary.tsx`, `apps/web/src/sql/SqlPanel.tsx`,
`apps/web/src/shell-geometry.test.ts`, `tests/e2e/shell.spec.ts`, `tests/e2e/sql-editor.spec.ts`.

**Implementation steps:**

1. (Design, after reopen) Write the bounded design covering exactly the uxv-6 list: adjustable
   pane limits, minimum grid width, keyboard resize/reset, below-breakpoint behaviour (the <1024
   stack is unchanged), the test plan, and the exact product/05 text changes.
2. STOP for maintainer approval and, if pane bounds change, architect escalation.
3. (Runtime, only after approval) Implement pointer + keyboard resize with the minimum-grid-width
   clamp and a reset; update the geometry pins at 1024×700/1440×900/1920×1080.
4. Prove SQL outcome copy is byte-identical (EW-02 §3.2 pins) and no document horizontal
   clipping appears at any supported viewport or at 200% zoom.

**Tests (for the eventual runtime row):** minimum grid width held at every resize limit; keyboard
resize/reset parity with pointer resize; below-breakpoint layout unchanged; SQL outcome copy
byte-identical (the EW-02 pins); footer/first-row fit at 1024×700 (uxv-3 pins retained).
**Mutation drill:** drop the minimum-grid-width clamp — the geometry pin at the smallest
supported viewport must fail; restore byte-identically. (In the design phase the drill is a
completeness check: every uxv-6 list item answered in the amendment — deleting one item must
fail that check.)

**Gates:** design phase is docs-only (`pnpm format:check`, `pnpm docs:links:check`,
`pnpm adr:index:check`; record that runtime was not revalidated); any runtime row gets targeted
geometry/SQL tests then the full local suite.

**Evidence to record:** the reopening evidence record itself (journey/measurement or maintainer
instruction); the approved amendment text; if implemented, the measured geometry matrix and the
independent review verdict in the ledger entry.

**Stop rules:** implementation before the evidence and approval are recorded; exceeding
product/05 bounds without amendment + escalation; rewording SQL outcome copy; an ADR 0044
conflict; usability claims (D-02 A).

**Done-when:** (design) an approved bounded amendment answers every uxv-6 list item; (runtime,
if ever) the SQL pane resizes within approved limits with pinned keyboard parity and unchanged
copy. Until the reopen trigger is recorded, the correct state is the documented deferral.

**Depends on:** human/maintainer action — the evidence plus a D-08 = B decision and amendment
approval. No other item feeds it.

### R-7 — overlay-aware profile candidate

**Status:** DECIDED-NOT-NOW · reopen trigger: a maintainer decision accepting an
engine/client/state consistency contract (D-09 = B), plus the architect ruling named below if the
contract crosses package boundaries.
**Row/source:** [overlay-profile candidate](20261030-overlay-profile-candidate.md) §§1–6 (the
UX-D1 Option C charter and footprint); [rd decisions](20261104-rd-open-decisions.md) §1 D-09 and
§4; decision round §3 D-09 and §5; map §4 sv-10/11 crosswalk.
**Why it is not shipped yet:** D-09 = A was accepted on 2026-11-21 — "It changes what a number
means; needs an engine/client/state consistency contract first". The candidate file is
planning-only by its own charter ("no worker may claim it, no protocol, domain, `DataEngine`
target or engine source may change until a later explicit maintainer decision").

**Contract (already decided — do not reopen):**

- The profile reads the **base view** today: `profile(handle)` sends
  `{type:'engine/profile', requestId, tableId}` and the worker profiles `entry.viewName`
  (candidate §2, verified at `25f05b3`–`8a38e0e`). Call sites include
  `apps/web/src/profile/ProfilePanel.tsx` (`engineClient.profile(handle)`) and
  `apps/web/src/sessions/useDiffSession.ts`.
- R-16's honest labeling is the shipped truth and must be **replaced, not doubled** when an
  effective-view profile exists (candidate §4/§6): `STANDING_HINT` "Statistics describe the file
  as opened — staged changes are not included." plus `stagedChangesNote`
  (`apps/web/src/profile/ProfilePanel.tsx:122`). `ProfilePanel.honesty.test.tsx`,
  `App.profile-honesty.test.tsx` and `tests/e2e/profile-honesty.spec.ts` pin that copy.
- The overlay is stateless per request; overlay-aware surfaces already exist
  (`overlaySchema`, `overlayRowCount`, `fetchOverlayRange`, `overlayCastCheck`, `exportView`,
  `validate`, `diff` — candidate §2) but none is a profile. Effective-view SQL composition
  exists: `composeSourceSql` in `packages/engine-duckdb/src/overlay-query.ts`.
- The 500-live-insert refusal must survive: `MAX_OVERLAY_LIVE_INSERT_BRANCHES = 500`
  (`overlay-query.ts`), readable refusal, never a silent base fallback (candidate §2/§4).
- ADR 0012 (overlay/transaction semantics), ADR 0025/0037 (telemetry/privacy — no values or
  filenames), ADR 0038 (pinned-CLI fixture generation) apply; no source mutation; base-profile
  behaviour unchanged for callers passing no overlay (candidate §4 compatibility pin).
- ug-16's top-k click semantics are base-derived (`apps/web/src/profile/filter-action.ts` module
  doc: `planProfileFilter` → `resolveProfileColumn`); an effective-view profile changes what a
  click filters on, so the renamed/deleted-column mapping/refusal rule needs re-decision
  (candidate §3.6).

**The choice this item still needs:** first the consistency contract, itemized (candidate §3),
then D-09 = A vs B:

1. Protocol shape: an optional `overlay` on `engine/profile` vs a new request type — plus the
   response semantics (which view the numbers describe).
2. Client shape: `profile(handle, overlay?)` vs `overlayProfile(handle, overlay)`; every existing
   call site keeps base behaviour unless it opts in.
3. Domain/`DataEngine` scope: does `packages/domain` or the public `DataEngine` target change?
   The architect resolves this under the engine's compatibility rules (candidate §3.4) — a
   pure `engine-duckdb` client-protocol addition may suffice, but that is a ruling, not an
   assumption.
4. Consistency rule: how the profiled effective view is pinned to the grid's current view (the
   overlay being stateless per request), and what happens when staged state changes mid-profile.
5. UI: replace the R-16 base-only hint **and** staged note with explicit effective-view labeling
   (never show both contracts), and re-decide the top-k click mapping rule.

**Files (reserved):** design phase: `(new)` dated contract under `docs/process/handoff/` (path
fixed at dispatch). Runtime is **not reserved** until items 1–5 are decided; the candidate's
footprint (verified to exist) is: `packages/engine-duckdb/src/protocol.ts`, `client.ts`,
`engine-executor.ts`, `profile-query.ts`, `overlay-query.ts` and their tests; pinned-CLI
conformance fixtures (ADR 0038); `apps/web/src/profile/ProfilePanel.tsx`,
`apps/web/src/profile/filter-action.ts`, `apps/web/src/profile/ProfilePanel.honesty.test.tsx`,
`apps/web/src/App.profile-honesty.test.tsx`, `tests/e2e/profile-honesty.spec.ts`,
`tests/e2e/profile-filter.spec.ts`, `tests/e2e/engine-profile.spec.ts`.

**Implementation steps:**

1. (Contract) Resolve items 1–5 plus the conformance matrix (base vs effective stats across
   edits/inserts/deletes/renames/casts and the >500-insert refusal) and the fixture plan. STOP
   for maintainer acceptance and the architect ruling on item 3.
2. (Runtime) Add the overlay-bearing request and response semantics to
   `packages/engine-duckdb/src/protocol.ts` / `client.ts` / `engine-executor.ts` with opt-in
   default-off; non-opt-in callers stay byte-compatible.
3. (Runtime) Compose the effective relation via `composeSourceSql` for the aggregate scan and
   each top-k scan (`profile-query.ts`), keeping the 500-branch refusal and its copy.
4. (Runtime) Pin conformance: effective stats equal the same aggregates over the composed
   relation for every supported op class, derived from the pinned DuckDB CLI (ADR 0038).
5. (UI) Replace the R-16 base-only hint and staged note with effective-view labeling in
   `ProfilePanel.tsx` — with a pin that the old base-only copy cannot reappear alongside it —
   and apply the approved top-k mapping/refusal rule.

**Tests:** effective-view stats equal fixture/CLI-derived aggregates per op class; >500 live
inserts refuses readably and never silently falls back to base; base-profile compatibility pin
(callers without an overlay unchanged); the R-16 copy-replacement pin; top-k click mapping and
renamed/deleted-column refusal cases; existing honesty/filter e2e retained. **Mutation drill:**
pass the overlay unconditionally (ignore the opt-in) — the base-compatibility pin must fail;
restore byte-identically.

**Gates:** targeted (`packages/engine-duckdb` unit + real-CLI agreement suites with `DUCKDB`
set, web profile tests, `tests/e2e/engine-profile.spec.ts`, `tests/e2e/profile-honesty.spec.ts`),
then the full local suite; telemetry legs if App/CSS/modal surfaces change (spec §6.2).

**Evidence to record:** the approved contract and architect ruling; conformance commands with the
pinned CLI version; the compatibility pin; the copy-replacement proof (old hint absent, new
labeling present); changesets (engine + web); ledger entry with map §5 fields.

**Stop rules:** any runtime edit before the contract decision (the protocol change is itself a
wire change — that is exactly what the contract gates); a package-boundary crossing without the
architect ruling; a silent base fallback on profile failure; showing both profile contracts at
once; telemetry carrying values or filenames; usability claims (D-02 A).

**Done-when:** profile statistics describe the overlay-effective view under the approved
contract, base behaviour is unchanged for non-opt-in callers, the 500-insert refusal is intact,
and the R-16 base-only copy is replaced — not duplicated.

**Depends on:** maintainer D-09 = B plus acceptance of the consistency contract (items 1–5);
architect ruling if item 3 widens scope. No other item feeds it.

## Verification protocol

Remote GitHub Actions is **billing-blocked, not code-blocked**. Every push shows four job-start
refusals (`playwright e2e`, `configured telemetry disclosure (isolated)`, `typecheck / lint /
test / build`, `VS Code real extension host / offline harness`) completing as `failure` in ~4 s
with no steps and no logs. That is **not** code signal: do not read it as a red run and do not
retry a push to "fix" it. The local suite is the authority
([remaining-work index](20261122-remaining-work-handoffs.md) §0 restates the same protocol).

Run on a clean tree before a push and again after each merge; paste command tails into the
closing record:

```bash
corepack pnpm install --frozen-lockfile
pnpm run doctor                                   # offline preflight; held ports are a warn
export DUCKDB=/tmp/duckdb PATH=/tmp:$PATH          # pinned CLI v1.5.5
pnpm format:check
NODE_OPTIONS=--max-old-space-size=4096 pnpm lint
pnpm typecheck
pnpm test
pnpm exec tsc --build apps/cli/tsconfig.build.json
pnpm exec vitest run --coverage --testTimeout=20000 --maxWorkers=4   # floors 83/76/80/84
pnpm build
pnpm docs:links:check
pnpm adr:index:check
pnpm current-state:check
pnpm assurance-map:check
node scripts/dependency-report.mjs --check
pnpm measure:bundle
pnpm test:e2e                                      # 288 + 1 skip at the index's base
node apps/vscode/scripts/run-e2e.mjs                # pinned host, offline cache
node apps/cli/scripts/pack-consumer-smoke.mjs
```

Record exact commands, exits, test/skip counts, coverage and tool versions; a failing run stays
in the record (no retry-to-green). Contention-sensitive tests (re-run solo before declaring a
failure, never raise a ceiling): `apps/web/src/sql/SqlPanel.telemetry.test.tsx`,
`packages/pipeline/src/dcr-round-trip.test.ts`,
`packages/validation/src/duckdb-agreement.test.ts`, `packages/validation/src/re2.test.ts`, the
`packages/engine-duckdb` real-CLI agreement suites (`DUCKDB` must be set) and the
`cli-integration` project. App/header/CSS/modal changes add the two telemetry legs (configured
endpoint-present run, aborted collector before navigation, then endpoint-free stock rebuild plus
affected stock suites — spec §6.2). Docs-only rows run format/links/ADR index and must state
that runtime was not revalidated (spec §6.3). Every new load-bearing behaviour gets at least one
independent negative control (a mutation that must fail its named assertion, restored
byte-identically with the tree proven clean). An implementer never approves its own change; one
item at a time, worker → independent reviewer → integration
([operating-model](operating-model.md) governs the roster and shared-file handling).

## Paste-ready prompt

```text
You are continuing Assay maintenance from the 2026-11-22 remaining-work handoffs. The repository
is local; remote GitHub Actions is billing-blocked (four job-start failures per push are NOT code
signal — see this file's Verification protocol).

Read, in order: AGENTS.md; docs/process/handoff.md (current-state block);
docs/process/handoff/20261122-remaining-work-handoffs.md §0/§2;
docs/process/handoff/20261121-successor-queue.md §8/§9;
docs/process/handoff/20261121-decision-round.md; then this file (H1) and every record your item
cites.

SELECTED_ITEM = <R-n>        # exactly one of R-1 … R-7
DECISIONS = <the WFD/decision options chosen, or "none needed">

If SELECTED_ITEM is empty or the item's reopen trigger is unmet: modify nothing. Return the
single decision, evidence or human action that unblocks it and a proposed envelope.

Reserve exactly one item: its "Files (reserved)" list is your whole scope (the map's WF
reservations bind where they exist). Use a scoped branch and follow worker → independent
reviewer → integration per docs/process/handoff/operating-model.md. Record your own base SHA,
run the Verification protocol gate suite above (targeted tests first, then the full suite; both
telemetry legs for App/header/CSS/modal changes), perform at least one load-bearing mutation of
the item's named drill and restore it byte-identically, and record the billing-blocked CI caveat
instead of waiting for Actions.

Never weaken an assertion, floor, cap, timeout or privacy rule; never claim "validated",
"intuitive" or "easier" (D-02 A / RD-T07). Stop (BLOCKED, not CLOSED) for an ADR conflict, an
unselected UX/policy, a wire or persisted-format change outside an approved contract, a
package-boundary crossing, missing evidence, or a publish/release action. Record the closing
evidence named in the item's "Evidence to record" — closing commit message, ledger entry with
the map §5 integration-record fields, mutation and restore proof — and report: item id,
diagnosis, files/commits, gate exits/counts, reviewer verdict, unchanged invariants, remaining
limits.
```
