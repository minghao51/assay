# rd-5 — compare and reviewed export: scope contract

**Status: SCOPE PREPARED 2026-11-04 — implementation NOT authorized until the two decisions in §5 are
answered.** Authorized to scope first (decisions record §10). Baseline `9c947a4`; **hf-1 is CLOSED** (`ea38938`) — the browser gate is now deterministic (two
consecutive full runs at 237 passed + 1 skipped).

Requirement source: [map](../handoff/20261104-svg-implementation-map.md) row `rd-5`, [review](../../product/12-workbench-redesign-review.md)
RD-R02/RD-T02 (+RD-R03/04/08), [conservative spec](../../product/11-svg-implementation-spec.md) SV-R11 / SV-T07 / SV-T11 / SV-T15.

## 1. What already ships (do not rebuild)

Verified in source, not from memory:

| Claim                                                           | Where it already exists                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Confirmed-key A/B comparison                                    | `DiffPanel` renders comparison info (`diff-comparison-info`, rows/columns), schema drift before deltas before keys, key candidates with evidence (`diff-key-selection`, `diff-key-evidence`), and the row diff after confirmation (`diff-aspects`, `diff-samples`).                         |
| Structural order the requirement asks for (A/B before findings) | Render order is comparison → schema drift → distribution deltas → **keys** → **row diff** (`DiffPanel.tsx` ~429/459/487/534/674), i.e. orientation and key state precede row findings.                                                                                                      |
| **A-only** navigation                                           | `SampleRow` gives `diff-sample-jump` ("Show row") only for `side === 'A'`; B-side samples render `diff-sample-report-only` ("report only — the comparison file is not shown in the grid"). Pinned in `diff-panel.spec.ts` (`addedSamples…diff-sample-jump` count 0; removed/A-side clicks). |
| Whole-current-dataset delivery                                  | `ExportDialog` states staged count, effective view rows in natural order, filtered note, format description, refusal/result states (`export-staged-count`, `export-view-rows`, `export-filtered-note`, `export-refused`). Byte/source assertions live in `export-rewrite.spec.ts`.          |
| Cross-surface agreement                                         | `m6-exit-journey.spec.ts`: exact web/CLI agreement (drift → deltas → row diff), identical-file zero state, and >K key selection.                                                                                                                                                            |
| Stale comparison + rerun path                                   | Approved stale sentence in `DiffPanel`, `diffStale` in the derivation, bar action `Review comparison` focuses the panel's existing run control.                                                                                                                                             |
| Dataset-swap / reset                                            | `useDiffSession` clears comparison and run on a new session; pinned in the session tests.                                                                                                                                                                                                   |

**Consequence:** rd-5 is not a feature build. It is (a) closing two specific presentation gaps that the
new IA exposed, and (b) binding the existing M6/export evidence to the **task-led** shell (Check and
Change) with a J3 journey test. Do not re-implement comparison, export or the CLI agreement.

## 2. The real gaps

1. **A/B orientation is implicit.** The panel says "Stage a second dataset version to compare against
   the open one" and "comparison staged — N rows, M columns". Neither side is named A or B, so
   "orientation before row findings" (RD-R02) relies on the reading of prose. The samples are labelled
   only by position.
2. **The context bar cannot represent "comparison staged, not run".** `comparisonState` exists in
   `useDiffSession` and the panel uses it, but `deriveNextAction` receives only `diffRun.kind`, so
   after staging B with a current valid verdict the bar still says `Export a copy…`. A user who just
   staged B gets no "run the comparison" hint. This is a genuine gap in RD-R02's "next useful action",
   not a styling issue.
3. **Nothing binds J3 to the task-led IA.** The M6 journeys predate the task strip; they now open
   sections explicitly (rd-3b migration) but do not assert the Check→Change handoff (compare → export)
   or the bar's cross-task actions for this journey.

## 3. Decisions

### D1 — A/B labels (copy; needs approval)

Proposed, minimal, value-free, no duplicated counts:

- Intro first sentence → “Stage a second dataset version to compare against the open dataset (A).”
- Staged line → “Comparison file (B) staged — N rows × M columns” (keeps the existing counts, which
  are B's; A's counts already live in the context bar and must **not** be repeated).
- B-side sample note stays exactly as shipped (“report only — the comparison file is not shown in the
  grid”); A-side button stays “Show row”.

No other string changes. If approved, the three strings join the approved-copy table with the same
enforcement rule as rd-3c (`APPROVED_COPY`-style pin or an explicit assertion in the panel tests).

### D2 — the "staged B, not run" bar state (behaviour + copy; needs approval)

Options:

- **(a) Leave it** (default recommendation): the Compare panel is the place to stage and run; the bar
  keeps `Export a copy…` for a current valid verdict. Record the gap as a known limitation.
- **(b) Add one approved state:** `Comparisons staged — no comparison has run yet` → `Review
comparison`, derived from `comparisonState === 'staged' && diffRun.kind === 'idle'`. Requires one new
  approved string, a new input to `deriveNextAction`, and truth-table + bar tests. Small, but it is new
  copy and a new derivation branch.

### D3 — one-click rerun (decided: **no**)

Keep `Review comparison` focusing the panel's existing run control. A one-click rerun would need a
scoped panel/session change for key state, which the invariants protect; the recorded reasoning stands.

## 4. Deliverable (once D1/D2 are answered)

- `diff/DiffPanel.tsx` — the approved label strings only (no logic, no data, no counts added).
- `App.tsx` / `workbench/next-action.ts` — **only if D2(b)** is chosen: one input, one branch, one
  approved string.
- Tests: `diff-panel.spec.ts` (labels + A-only jump unchanged), `m6-exit-journey.spec.ts` (J3 in the
  task IA: Check → stage B → drift → deltas → confirm keys → row diff → A-only jump → stage again →
  stale → explicit rerun → `Export a copy…` from the bar lands in Change with the dialog), plus focused
  unit pins for any D2 branch.
- One `.changeset/*.md` (`@assay/web`, minor if D2(b), patch otherwise).

**Forbidden:** `packages/**`; `sessions/**` except the `deriveNextAction` input plumbing if D2(b) is
chosen (no session-hook logic change); diff report bytes, export bytes, logical row identity, CLI
agreement tests; grid/validation/profile/SQL/pipeline logic; telemetry; thresholds/timeouts/allowlists;
dependencies; push.

## 5. Gates, review, rollback

Full map §6 sequence from the committed revision in a clean worktree, including both telemetry legs if
`App.tsx`/CSS changes; independent reviewer on a different model/session with one mutation of the
load-bearing assertion; rollback is `git revert <commit>`. **Stop conditions:** any byte change in
diff/export reports, any change to CLI agreement, any need to duplicate a count into a second surface,
any copy beyond D1/D2 as approved.
