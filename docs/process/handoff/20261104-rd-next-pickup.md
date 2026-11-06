# Next pickup — integrate rd-3/rd-4, then continue the redesign

**Authored:** 2026-11-04, at the end of the rd-3/rd-4 implementation episode. Read this before claiming anything.

> **INTEGRATION UPDATE (2026-11-04, later the same day): §1 is DONE.** The slice was committed as `51ff36e` (design pack `d441fc3`), the merged gates were re-run from a clean worktree at that revision, and rd-3/rd-4 are **CLOSED** — evidence in [map §6.4](20261104-svg-implementation-map.md). Nothing was pushed. The next action is **rd-3b scope approval**, not integration: the exact contract, the 55-spec audit and the helper migration plan are in the [rd-3b conditional visibility contract](20261104-rd3b-conditional-visibility-contract.md). Sections 0–1 below are kept as the historical pickup record; §2 remains the live rd-3b brief, now backed by that contract.

> **Next thread starts here.** Paste the prompt in §5 verbatim, then read the contract. It assumes rd-3/rd-4 are integrated (`51ff36e`) and that no new features are authorized beyond `rd-3b` after explicit approval.

## 0. What state the repository is in

> **Superseded by the integration update above for the HEAD/working-tree/verification rows**; the table is kept as the state this pickup was authored from.

| Item                        | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HEAD                        | `bba491a` — **no commit was made** in this episode.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Working tree                | The rd-3/rd-4 slice is **complete, gate-green and independently approved, but uncommitted**. Modified: `apps/web/src/{App.tsx,index.css,App.shell.test.tsx,App.headings.test.tsx,shell-geometry.test.ts,validation/ValidationPanel.tsx,diff/DiffPanel.tsx}`, `tests/e2e/{shell,m5-exit-journey,theme}.spec.ts`, `docs/process/handoff.md`. Untracked: `apps/web/src/workbench/`, `apps/web/src/App.task-switch.test.tsx`, `tests/e2e/workbench-tasks.spec.ts`, `.changeset/rd-task-navigation.md`, the design/decision/protocol docs, and the pre-existing `assests/` pack. |
| Authorizations already used | SV-D08 = task-led (B); UI-RD-01; approved copy; SV-D01 = rd-3 + rd-4 only. Record: [decisions and runtime scope](20261104-rd-decisions-and-runtime-scope.md).                                                                                                                                                                                                                                                                                                                                                                                                               |
| Review                      | `openai-codex/gpt-6-luna` xhigh: two request-changes rounds (workspace-anchor reveal, running-comparison cancel precedence, stale comments) → **approved**. Not merged/committed.                                                                                                                                                                                                                                                                                                                                                                                           |
| Verification                | format/lint/typecheck 0; unit **235 files / 3494 tests**; coverage **89.10/83.86/91.39/90.68**; build 12/12; full Playwright **222 passed + 1 skipped + 1 env-flaky** (`export-rewrite` JSONL open needed an external DuckDB extension; 9/9 isolated); docs **129/0**; ADR 46; 194 changesets.                                                                                                                                                                                                                                                                              |
| Not done                    | Commit, push, rd-3b (conditional visibility), rd-5, rd-6, rd-7, human usability/AT study, optional SV-D02…SV-D05.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

**Do not** re-decide SV-D08, the UI ruling, the copy, or the slice-1 deferral. **Do not** push, publish or change visibility. **Do not** treat the `assests/` prototypes as shipped behaviour.

## 1. First task — integrate the approved slice

The next orchestrator must do this before new feature work:

1. Inspect `git status` / `git diff` yourself; confirm the diff matches the [design record §9](../../product/13-workbench-redesign-design-record.md) and the [decisions record](20261104-rd-decisions-and-runtime-scope.md). Reject accidental files outside the reservation.
2. Obtain explicit **commit authority** from the maintainer if it is not already given. Workers never commit; the orchestrator commits with a Conventional Commit, e.g. `feat(web): add task navigation and repair-recheck journey`. Do **not** push.
3. Establish the merged/committed baseline in a clean checkout (or `git stash`-free clean worktree) and re-run the full gate sequence from the committed revision: `format:check`, `lint`, `typecheck`, `test`, `test:coverage`, `build`, `CI=1 pnpm exec playwright test --retries=0` (needs `DUCKDB=/tmp/duckdb` and fresh ports), `docs:links:check`, `adr:index:check`. Record exits/counts; do not reuse this episode's logs as merged evidence.
4. Update the map rows rd-3/rd-4 from “approved by independent review” to CLOSED with the merged revision and gate counts; update the handoff active paragraph.

## 2. Then — rd-3b (conditional task visibility), by explicit scope

This is the deferred half of the IA. It must be its own reviewed slice, because it changes how legacy journeys reach panels.

**Design target:** at ≥1024px, sections outside the active task are not exposed (`display: none` keyed on the pane `data-task` and each section's `data-task`), still mounted; <1024px unchanged (all sections stacked). Radio group unchanged; task-scoped section links stay.

**The migration problem to solve before coding:**

- `tests/e2e/support/fixtures.ts` `expandAllSections()` clicks every managed section toggle. Hidden toggles are not clickable once visibility is filtered.
- ~120 e2e usages go through `openFixture` / `openCustomersFixture` / `expandAllSections`, and many specs then interact with one panel (validation, diff, pipeline, export, profile, filters, SQL).
- The 12 section links are currently all exposed; hiding inactive groups would break `section-nav-<id>` clicks in specs.

**Recommended plan:**

1. Add a task map to the e2e support module (`section → task`) and make `openSection(page, id)` activate the owning task first, then open the section, leaving that task active.
2. Replace `expandAllSections(page)` with a task-aware version that activates each task, opens its sections, and ends on a caller-specified task (default Explore), or add `activateTask(page, task)` and migrate each spec's setup to the task it needs.
3. Migrate `shell.spec.ts` heading-map assertions to per-task maps plus a DOM-presence assertion; keep the narrow complete map.
4. Keep `App.shell` unit DOM-order/nav-group pins; add a per-task exposure test driven by the CSS attribute (unit CSS is not applied, so the real exposure proof is e2e).
5. Decide and pin: whether task selection auto-scrolls; default task on new dataset (Explore); whether inactive nav groups are hidden or all groups stay visible (recommend: hide inactive groups at desktop, show all at narrow — mirrors the target and reduces the visible list to the active task + workspace).
6. Add a `rd-3b` e2e spec: at 1024/1440, only the active task's section headings are exposed; switching tasks exposes the other set; at 900 all are exposed; the grid stays mounted; no horizontal clip; axe per task in both schemes (keep the existing scans).
7. Full gates + independent review + changeset. Rollback = revert the single commit.

**Do not** combine rd-3b with rd-5/rd-6; the helper migration is the risk.

## 3. Then — remaining slices (unchanged plan)

- **rd-5 — compare and reviewed export:** confirmed-key A/B context before row findings, A-only navigation, whole-current-dataset delivery continuity; existing diff/export semantic and byte tests must stay green; no subset export or second dataset view.
- **rd-6 — pipeline and artifact context:** reuse the existing ordered runner/gate/preview/lineage/delivery; optional richer DCR inspector remains **SV-D02** and separately authorized.
- **rd-7 — validate and close:** concise secondary Help (native dialog + app-local modal ownership), accessibility/zoom/recovery/performance gates, and the usability round. **No human usability evidence exists yet**: run the [protocol](20261104-rd2-usability-protocol.md) on the built app, or record the maintainer's explicit accepted limitation; never claim user validation from automated tests.
- **Optional, still OPEN:** SV-D02 DCR inspector, SV-D03 dirty replacement, SV-D04 SQL sizing, SV-D05 overlay-aware profile, run-origin metadata. Do not start them implicitly.

## 4. Environment quirks to plan for

- Export `DUCKDB=/tmp/duckdb` (pinned 1.5.5) for generated fixtures and real-engine e2e; missing it produces “DuckDB CLI not found” failures.
- Use free per-run ports (defaults 4173/4179/4180; alternates 4573/4579/4580). A stale preview server makes Playwright refuse with “http://localhost:4173 is already used”.
- One full-run failure was an external `extensions.duckdb.org` fetch during a JSONL open; re-run isolated before treating it as a regression, and record it honestly.
- Theme tests read computed base styles: move the pointer away after opening a dialog before asserting, or hover colours can race the read.
- The configured-telemetry disclosure leg and restored stock build are required for any `App.tsx`/CSS change (see map §6.2); no collector/token.

## 5. Paste-ready orchestrator prompt

```text
You are the next Assay orchestrator, continuing the workbench redesign after the
rd-3/rd-4 implementation episode. Read AGENTS.md, docs/process/handoff.md,
docs/process/handoff/20261104-rd-decisions-and-runtime-scope.md,
docs/process/handoff/20261104-rd-next-pickup.md, docs/product/12 and 13, and the
live map docs/process/handoff/20261104-svg-implementation-map.md.

The rd-3/rd-4 slice is implemented, gate-green and independently approved but
UNCOMMITTED. Do not re-decide SV-D08 (task-led), UI-RD-01, the approved copy, or
the slice-1 deferral of conditional visibility.

First: inspect the actual working tree; confirm the diff matches the design record
§9 and the decisions record; obtain explicit commit authority; commit with a
Conventional Commit (do not push). Then establish a clean committed baseline in a
clean checkout and re-run the FULL gates from that revision (format, lint,
typecheck, unit, coverage, build, CI=1 Playwright with DUCKDB=/tmp/duckdb and
fresh ports, docs links, ADR index). Record actual exits/counts in the map; do not
reuse the prior episode's logs as merged evidence. Update rd-3/rd-4 to CLOSED with
the merged revision and evidence.

Then prepare rd-3b (conditional task visibility) as its OWN reviewed slice:
write the exact old→new layout/heading/nav contract and the e2e helper migration
plan before dispatch. The work must keep sessions/hooks/engine/grid/export bytes
unchanged, keep sections mounted, and keep <1024px unfiltered. The known risk is
the task-aware migration of ~120 e2e panel-expansion usages; propose the helper
design and file reservations and get explicit scope approval before coding.

After rd-3b: rd-5 (compare/export continuation), rd-6 (pipeline context), rd-7
(Help + accessibility/performance + the usability study or an explicit accepted
limitation). Optional SV-D02…SV-D05 and run-origin metadata remain OPEN and must
not be started implicitly.

Use one web writer at a time, deepseek-v4.1-flash workers, and an independent
gpt-6-luna xhigh reviewer; never the same model for implement and approve. Run the
configured/restored telemetry protocol for any App/CSS change. No push,
publication, visibility change, dependency, ADR rewrite, or human-usability claim
without evidence. Stop on gate/tooling/scope conflicts and report the blocker.
```

## 6. Worker brief skeleton (fill every field from the live approved row)

```text
ROLE: bounded worker for <rd-3b / rd-5 / rd-6 / rd-7>. Read AGENTS.md, the live map,
the decisions record, the design record, and the relevant ADRs/specs first.
TASK / APPROVAL: <row id + exact text + decision reference/date>.
BASELINE: <committed revision, clean checkout, gates green with counts>.
RESERVATION: <exact files incl. tests/changeset; one web writer>.
WHAT TO CHANGE: <observed current behaviour → exact desired delta; preserve the
session/engine/grid/export invariants; keep old→new copy/test contracts explicit>.
DONE WHEN: <RD-Txx / exact focused tests + negative controls + a11y/geometry>.
BOUNDARY: no packages/**, sessions hooks, grid/record/export/profile/SQL/schema
logic, telemetry, root configs, ADRs, dependencies, push. Stop on conflict.
VERIFY: <focused commands + full map §6 gates + configured/restored stock protocol
if App/CSS changed; log paths; no threshold weakening>.
DELIVER: changed behaviour/files, actual exits/counts/skips, scope/privacy/byte
claims, one commit + changeset only if authorized, blockers, reviewer instructions.
```

## 7. Reviewer brief skeleton

```text
ROLE: independent reviewer (different model/session). Read the actual diff, the
authorized row, the decisions record, the preserved invariants and the tests.
Independently run the full required gates and focused cases; verify rendered
keyboard/focus/modal/state behaviour in a real browser in both schemes and the
required viewports. Try to falsify the strongest claim with a safe isolated
mutation (show the assertion fails, restore, rebuild, prove no changes remain).
Check: session-state preservation and zero extra engine work; no copied
count/filename; truthful stale wording; logical row identity; no subset export or
byte change; radio-group (not tab) semantics; R-07 focus target; narrow stack.
Return VERDICT: approve or request-changes with numbered findings (file+quote,
evidence). Do not close the row or push.
```
