> **STATUS 2026-11-20 — EXECUTED.** This bundle is preserved planning evidence, not dispatch authority.
> All 24 rows are accounted for (20 closed with merged commits + independent review, 4 design-closed);
> `tasks.json` carries the per-row status and evidence, and the authoritative record is
> [`../../20261120-improvement-plan-execution.md`](../20261120-improvement-plan-execution.md).
> The "not implemented yet" statements below describe the bundle as written on 2026-11-20 before execution.

# Start here — Assay improvement handoff

## Files

1. **`implementation-plan.md`** — full plan, task specifications, acceptance matrices, decisions, dependencies, review and rollback rules.
2. **`tasks.json`** — machine-readable queue. Every item starts proposed and execution is unauthorized; dependencies do not grant authority.
3. **`evidence-notes.md`** — directly inspected sources, semantics and existing ownership reconciliation; accepted audit evidence remains authoritative for what was actually observed.
4. **`dispatch-envelopes.md`** — narrow first-slice file reservations, fillable worker envelope and independent reviewer prompt.
5. **`plan-review.md`** — independent planning review and disposition, once completed. This is not implementation approval.
6. **`assay-audit-phase1.tar.gz`** — frozen copy of the source-inspection evidence bundle used to plan. Extract separately; do not import its stale generation scripts as implementation truth.
7. **`validation.json`** — plan structural checks and final packaging record; not behavioral evidence.

## Suggested delivery order

- First reserve A00: actual clean/current baseline and one bounded execution envelope.
- Recommended first selected set: **A01 → A03 → B01 → B03 → B04 → C04 → C05**.
- To execute A03 record **Q1** (recommended Node 24 development support, product runtime separate); to execute B01 record **Q2** (recommended refuse duplicate names).
- Then A02/A04 guard against drift. B02 is the existing **ENG-3**, requiring its own selection/engine + web coordination.
- C01/C03 are design/probe stages; C02 and C03b do not execute automatically when a design is delivered.
- D02/D03/D04 are **split parent rows**, not single giant PRs. Select their children one at a time.
- E01/E04 are optional designs, not implied priorities or authority to reopen existing UX decisions.

This is a proposal, not a severity ranking. No fixes have been implemented by this bundle.

## Paste-ready prompt for a new orchestrator

```text
You are continuing Assay maintenance from the improvement handoff.

PLAN_DIR = /tmp/assay-improvement-plan
AUDIT_BASELINE = e68bde91d32b38a854c9fa573819a34ee418135f
SELECTED_TASKS = []      # Fill explicitly; [] means planning/preflight only.
APPROVED_DECISIONS = {}  # Fill Q1/Q2/etc. with chosen option and authority.

Read PLAN_DIR/START-HERE.md, implementation-plan.md, tasks.json,
evidence-notes.md, dispatch-envelopes.md and plan-review.md. Extract/read the enclosed Phase1
archive if the live /tmp/assay-audit-phase1 directory is unavailable.
Never execute report-reproduction scripts just to inspect the evidence;
some earlier inventory scripts include network-dependent metadata refresh.

Then read current AGENTS.md; docs/process/handoff.md §2/§6;
docs/process/handoff/operating-model.md; the roadmap and relevant ADRs;
docs/process/handoff/20261118-post-ew03ia-pickup.md current header/queue.
Reconcile current SHA/dirty state and newer ownership before choosing work.
The latest accepted ADR and live closure win over stale copied prompts.
ENG-1/TB-2 and WF-06/CSV/repair work are closed; ENG-2/ENG-3 unselected;
ADR0047 retention and ADR0049 option C are intentional. Preserve ADR0051.

If SELECTED_TASKS is empty, return a proposed A00 envelope and the minimum
choices needed for the first slice; do not modify product/config/docs.
If selected, reserve only the next dependency-ready task (or explicit child),
record its scope/decisions/ports, and verify a fresh baseline before edits.
Do not treat dependent tasks as selected automatically.

Follow the worker -> independent reviewer -> integration protocol. One web
writer; no package-boundary expansion or shared-config/docs edits by a worker.
Use a scoped worktree/branch, Conventional Commits and per-package changesets.
No publish, push, remote collector traffic, destructive cleanup or sensitive data.

Each runtime correction begins with a regression/fault probe; a refuted
candidate may legitimately become docs-only or be closed without a code fix.
Never weaken existing assertions, floors, caps, timeouts or privacy rules.
Keep refactors and behavior changes separate. Browser tests serve built dist;
rebuild for reviewer mutation drills. Mark missing prerequisites BLOCKED.

Report task ID, actual diagnosis, exact files/commits, tests + exits/logs,
reviewer verdict, unchanged invariants, measured merged gate results and
remaining limits. Only integrate/close after independent review. Stop for
unapproved policy/ADR/wire/format changes or a boundary crossing.
```

## Persistence

`/tmp` can disappear. Before changing hosts or ending a long-running session, preserve both archives externally or explicitly select a documentation task to copy this plan and necessary evidence into a durable repository location. No repository plan/queue was created automatically; that avoids silently changing the current dispatch authority.
