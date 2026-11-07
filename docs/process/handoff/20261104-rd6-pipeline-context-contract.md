# rd-6 — pipeline and artifact context: scope contract

**Status: CLOSED 2026-11-04 — merged `570e9be`, independently approved, gates in
[map §6.9](20261104-svg-implementation-map.md), runtime record in [design record §13](../../product/13-workbench-redesign-design-record.md).**
Test-only: no runtime file changed, so no changeset. The two display defects found during review are
recorded as D-13/D-14, not fixed (D-01 forbids copy/derivation changes in this slice).

Requirements: [map](20261104-svg-implementation-map.md) row `rd-6`; [review](../../product/12-workbench-redesign-review.md)
RD-R03/04/06/08 and RD-T03/04/06/08; [conservative spec](../../product/11-svg-implementation-spec.md)
SV-R12 / SV-T12 / SV-T14.

## 1. What already ships (do not rebuild)

| Claim                          | Where it already exists                                                                                                                                                                                                                                                                |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordered execution plan         | `PipelinePanel` renders `<ol data-testid="pipeline-nodes">` with `pipeline-node` items in plan order, each with kind, materialization, relation, status and output/export evidence (`pipeline/PipelinePanel.tsx` ~484–540).                                                            |
| Real statuses and gate refusal | `pipeline-node-status`, `pipeline-node-gate`, bind/cross-link controls (`pipeline-bind-open-dataset`, `pipeline-bind`, `pipeline-contract-bound`); gate refusal stops downstream work — pinned in `tests/e2e/pipeline-gate-journey.spec.ts` and `pipeline-panel-gate-journey.spec.ts`. |
| Preview, lineage and delivery  | Panel preview + lineage + `pipeline-dcr-export.spec.ts` (canonical DCR artifact parity).                                                                                                                                                                                               |
| Runner semantics               | `pipeline-runner-journey.spec.ts` (ordered runner), `PipelinePanel.test.tsx` (node order/status mapping).                                                                                                                                                                              |
| Task framing                   | Prepare is the pipeline's task; choosing it opens the Pipeline section; the section link keeps `section-nav-pipeline` (R-07).                                                                                                                                                          |
| Gate → validation cross-link   | App-level `revealSectionFromNav('validation')` on the gate-failure action, with the render-then-focus seam.                                                                                                                                                                            |

## 2. The real gaps (both are recorded, not fixed — D-01 = reuse)

1. **The Pipeline section has no collapsed-state summary.** `validation`, `compare`, `history` and
   `export` all render a summary inside their managed toggle; `pipeline` renders only the title and its
   R-14 purpose, so a collapsed Prepare task shows no run/gate state.
2. **The context bar has no pipeline awareness.** `deriveNextAction` receives contract/validation/diff
   state only, so in Prepare the bar either stays on the Explore-era action or shows a validation action
   that belongs to Check.

Both need a new approved string (and, for (2), a new derivation input). Under D-01 they are **recorded
limitations** — the same treatment as rd-5's D2 gap — not part of this slice. If the journey shows one
of them actively misleads the user, stop and report rather than inventing copy.

## 3. Deliverable

**Evidence/continuity slice — no new surface, no new copy, no new state.**

1. One **Prepare journey** bound to the task strip, in `tests/e2e/pipeline-panel-journey.spec.ts` (extend
   it; keep every existing assertion): from the Explore default, choose Prepare (`task-prepare`
   `aria-checked`, pane `data-task="prepare"`, Pipeline expanded and every other task's sections
   `display: none`), open the pipeline file, bind the source and the contract, run, and assert:
   - the plan is an ordered list in file order (assert document order of at least three node ids, not
     just presence), with each node's real status and evidence;
   - a gate refusal leaves downstream nodes **not** executed and the refusal readable;
   - the gate → validation cross-link switches to **Check**, exposes and focuses the Validation panel,
     and closing it returns focus to `section-nav-validation`;
   - preview/lineage/delivery evidence is visible inside Prepare and no count is duplicated;
   - switching Prepare → Check → Prepare preserves the pipeline run state (no re-run, no remount).
2. **Only if** the journey proves a genuine defect that needs no new copy (e.g. a reveal that does not
   expose the section, a cross-link that lands on a hidden page), fix it inside `App.tsx`'s reveal seam
   and say exactly what was wrong; otherwise change **no runtime file**.
3. If no runtime file changes, **no changeset** (tests only). If one does, one `.changeset/*.md` for the
   affected package.

## 4. Files reserved

`tests/e2e/pipeline-panel-journey.spec.ts` (primary); only if proven necessary, `apps/web/src/App.tsx`
(reveal/activation seam only, no logic, no copy, no state) and the narrow unit test that pins it.

**Forbidden:** `packages/**`; `packages/pipeline` semantics; runner/build/serializer/DCR generation;
`workbench/tasks.ts` or `next-action.ts` (no new state or string — D-01 forbids it); sessions hooks;
grid/record/export/profile/SQL/schema logic; telemetry; thresholds/timeouts/allowlists; dependencies;
root configs; ADRs; push.

## 4a. Findings recorded during review (not fixed here)

Two **pre-existing** pipeline display defects surfaced while binding the journey. Neither is in scope
(D-01 option A: no new copy, no derivation change), and neither is silently absorbed:

1. **“Completed before the stop” includes the gate-blocked node** — the runner records the blocked node's
   refusal outcome, and the panel labels every recorded outcome as completed. The journey therefore
   asserts node-level facts (status `gated`, downstream `Pending`, no verdict/preview) instead of
   codifying the misleading set.
2. **“N outputs” counts gate/publish nodes** — `isOutput = !consumed`, so a five-node plan can read
   “3 outputs”. The journey deliberately does not pin that number.

Both are recorded as [D-13 and D-14](20261104-rd-open-decisions.md) with a recommendation to decide their
meaning in a later scoped slice.

## 5. Gates, review, rollback

Full map §6.1 sequence from the committed revision in a clean worktree; if `App.tsx`/CSS changes, also the
configured + restored telemetry legs. Independent reviewer on a different model/session, with its own
mutation of the load-bearing assertion. Rollback is `git revert <commit>`. **Stop** on: any need for new
copy, any pipeline/runner semantic change, any report/DCR byte change, any gate/tooling failure.
