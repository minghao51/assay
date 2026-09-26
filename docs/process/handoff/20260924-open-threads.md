# Open threads — continuation handoff (after the audit + remediation arcs)

> **PICKUP MAP — authored 2026-09-24** after closing the whole-repo implementation-audit arc
> (AR queue, 2026-09-22/23) and the documentation-audit arc (doc queue dr-0…dr-4,
> 2026-09-23). Baseline `main` = `ca79661`, six gates green (typecheck 18, vitest 1772,
> build 9, e2e 131+1skip — `DUCKDB=/tmp/duckdb`), ADRs 42 (35 accepted / 7 proposed,
> `pnpm adr:index:check` OK). Roster + dispatch runbook: [operating-model §7.6](operating-model.md).
>
> **This file is a map, not a second copy:** every thread points at its authoritative row or
> file (single-ownership discipline, doc-queue dr-2). When a thread closes, strike its row
> here and update the authoritative file — do not narrate in this file.

## 1. Recommended pickup order (next session)

1. **Maintainer rulings** (minutes, unblocks the most): **C-pt0-1** telemetry-design approval →
   **D12** first post-MVP engineering track (PT-V vs PT-P) → **D13** `DataEngine`/scaffold fate.
2. ~~**PT-0 finish**~~ **✅ CLOSED 2026-09-24** — pt0-3 (dr-1 re-check + remainder `77a89d8`; every documented
   command re-run fresh ×2; changeset tooling fixed `c0d1600`) and pt0-4 (axe a11y e2e
   `ffa844b`+`e137d41`; two real findings fixed at the root, empty allowlist, reviewer-approved).
   The agent-doable half of G0 has no remaining items; the human tail lives in
   [manual-actions.md](manual-actions.md).
3. **Dependabot triage:** merge the routine groups (#2 actions, #7 npm minor-patch); run
   verification passes for the majors (#4 vite 8, #5 typescript 6, #6 @types/node 26) — full
   gates + e2e on the PR branch; expect small code fixes under ts 6 / vite 8.
4. **PT-Q lanes:** q-1 first (**re-check its row against ar-2's `DataGrid.tsx`/`App.tsx`
   changes** — the row predates them), then any order; q-10…q-13 are the newly parked
   audit findings (engine + vitest advisories).
5. **Publish-readiness day** (rides manual M1): ar-5 publish-day carry-overs +
   `pnpm version-packages` (six dr-4 README changesets ride it).

## 2. Open threads (authoritative pointers)

| Thread                            | Authoritative home                                                                                                                                              | Next concrete step                                                                                                                                                                                                                                | Blocked on                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| ~~PT-0 launch readiness (to G0)~~ | ✅ **CLOSED 2026-09-24** — [`archive/20260921-pt0-queue.md`](archive/20260921-pt0-queue.md) (all five ✅) + [product/04 §4](../../product/04-post-mvp-track.md) | none — agent-side G0 checklist complete; human tail (M1/M4/O5/C-pt0-1) in [manual-actions](manual-actions.md)                                                                                                                                     | —                                       |
| Telemetry design approval         | [product/04 §4 item 1](../../product/04-post-mvp-track.md) + [`engineering/06-telemetry-design.md`](../../engineering/06-telemetry-design.md)                   | maintainer approves → implementation task becomes queueable (pre-G0; no code exists until then)                                                                                                                                                   | **C-pt0-1** (maintainer)                |
| PT-Q q-1…q-13                     | [product/04 §7](../../product/04-post-mvp-track.md) (self-serve pickup protocol there)                                                                          | q-1 after the post-ar-2 re-check; q-2…q-13 any order                                                                                                                                                                                              | nothing                                 |
| Dependabot PRs #2, #4, #5, #6, #7 | GitHub (repo `minghao51/assay`) — #3 closed/superseded by #7                                                                                                    | merge routine groups; verification passes for the three majors                                                                                                                                                                                    | nothing                                 |
| ar-5 publish-day carry-overs      | [archived AR queue](archive/20260922-ar-queue.md) row ar-5                                                                                                      | phantom `@duckdb/node-api` optional-peer story; CLI standalone-on-npm behind M1 registry versions; harness subpath leg; friendlier pack error; profile src-level determinism pin                                                                  | manual **M1** (npm org)                 |
| Unreleased changesets             | `.changeset/` (78 pending: six dr-4 patch + full MVP/AR-era set)                                                                                                | `pnpm version-packages` at the first release cut — tooling validated 2026-09-24 (`privatePackages.version` in config, `c0d1600`; `changeset status` green — `pnpm changeset` had been failing with an invalid tree, reproduced on base `af14ee3`) | manual **M1**                           |
| ar-4 / ar-6 / ar-2 carry-overs    | [archived AR queue](archive/20260922-ar-queue.md) rows ar-4 / ar-6 / ar-2                                                                                       | ar-6 n1: root typecheck task covering `playwright.config.ts` (the `report`→`reporter` typo gap — small, worth a task); ar-6 n2/n3 + ar-4 w1/w2/s3/s4 opportunistic; ar-2 B-side per-open engine release → PT-H                                    | opportunistic / PT-H                    |
| dr-2 reviewer suggestions         | [archived doc queue](archive/20260923-doc-queue.md) row dr-2                                                                                                    | arch-02 §2 could also cite ADR 0035; product/04 §4 hyperlink the §5 pointer; docs/README principle sentence stays full (honest minimum — noted, likely wontfix)                                                                                   | opportunistic (fold into any doc touch) |

## 3. Maintainer checkpoints & manual actions (humans only)

- **Decisions open:** **C-pt0-1** (approve [`engineering/06-telemetry-design.md`](../../engineering/06-telemetry-design.md) — no implementation queues before it) ·
  **D12** (first post-MVP engineering track; [roadmap §7](../../product/03-execution-roadmap.md)) ·
  **D13** (`DataEngine`/scaffold fate; arch-01 §7's annotation is deliberately D13-neutral).
- **Manual actions open** ([manual-actions.md](manual-actions.md)): **M1** npm org claim
  (gates first publish, D6 tail) · **M4** trademark/domain clearance (G0 tail) · org
  transfer + public flip (G0; the SECURITY.md private-reporting caveat resolves at flip).
- **Gate posture:** G0 is the next gate — its **agent-side checklist is complete** (PT-0 closed
  2026-09-24: telemetry design awaiting C-pt0-1 approval, SECURITY.md, README, a11y CI all done);
  the G0 tail is human: M1, M4, org transfer + public flip, then post-approval telemetry
  implementation. G2 evidence is **web-only** until PT-V exits (DM-2a, 2026-09-23).

## 4. Conventions now in force (learned the hard way, 2026-09-22/23)

- Queue rows are the authoritative task narratives; handoff §9 is one-liners with the
  splice-on-queue-close trigger (DM-5a) — both exercised, working.
- Queue files use the 3-column shape (DS-4); reviews get point-in-time banners; docs are
  single-sourced per the dr-2 owner map; ADR index is generated (`pnpm adr:index`) and the
  template carries Date/Deciders; the six patch changesets in `.changeset/` are expected.
- Worker/reviewer loop: briefs to `/tmp` per §7.6; workers on shifted ports; reviewers
  verify-only; approve-with-carry-overs is the norm; remediation may expand a worker's
  boundary in a round-2 brief when the root cause is out of round-1 scope.
