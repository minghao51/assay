# Open threads — continuation handoff (after the PT-0 arc)

> **PICKUP MAP — authored 2026-09-26** after closing the **PT-0 launch-readiness queue**
> (pt0-0…pt0-4 all ✅: pt0-3 `77a89d8`, changeset-tooling fix `c0d1600`, pt0-4 `ffa844b`+`e137d41`,
> integration + paperwork `8c07d45`/`e02b4ff`; **2026-09-26 session: Dependabot triage complete, q-1/q-9/q-10 landed, publish cut dry-run validated**). Baseline `main` = `07c2d99` (AU-2 integration): six gates green locally, remote CI green
> (2026-09-26/27 runs) — typecheck 18, vitest **1866**, build 9, e2e **144 + 1 skip** (`DUCKDB=/tmp/duckdb`), fixture regen clean, ADRs 43 (35 accepted / 8 proposed),
> `pnpm changeset status` green (92 pending changesets, au2 included; tooling validated 2026-09-24, see the
> changesets row below). Roster + dispatch runbook: [operating-model §7.6](operating-model.md).
>
> **This file is a map, not a second copy:** every thread points at its authoritative row or file
> (single-ownership discipline, doc-queue dr-2). When a thread closes, strike its row here and
> update the authoritative file — do not narrate in this file. **Supersedes
> [archive/20260924-open-threads.md](archive/20260924-open-threads.md)** — that map's PT-0 rows
> closed this arc; every other row carries forward here unchanged.

## 1. Recommended pickup order (next session)

1. ~~**Dependabot triage**~~ **✅ DONE 2026-09-26**: #2 (actions) and #7 (npm minor-patch) merged on green
   branch CI; #6 (@types/node 26) and #4 (vite 8) merged after full local gate+e2e verification passes;
   #5 (typescript 6) needed one code fix — `packages/engine` tsconfig `types: ["node"]` (TS 6 dropped
   ambient @types inclusion; the type-only-import alternative was proven non-viable via TS2591) —
   worker `d133a8b`, reviewer-approved ×2. All five PRs merged; zero open.
2. ~~**PT-Q lanes**~~ **✅ ALL CLOSED 2026-09-26**: q-1, q-3, q-4, q-5, q-6, q-7 (slice 1), q-8,
   q-9, q-10, q-11, q-12, q-13 landed reviewer-approved (unit baseline 1772 –> **1865**, e2e 136+1 –>
   **144+1** incl. dual-scheme axe scans + theme smoke). Residue lives ON the rows: carry-overs per
   lane + **q-14** (UNION-arm projection check) + **q-7 slice 2** (`testing` flags).
3. **Maintainer rulings** (minutes each, unblock the most — humans only) —
   **handoff written, ready to pick up cold: [`handoff/20260926-maintainer-rulings.md`](20260926-maintainer-rulings.md)**: **C-pt0-1**
   telemetry-design approval → **D12** first post-MVP engineering track (PT-V vs PT-P) →
   **D13** `DataEngine`/scaffold fate → **D14** workbench-shell direction — **all four ruled 2026-09-29**
   (see the [rulings file](20260926-maintainer-rulings.md); D14: ADR 0044 Accepted as written → ux-6 unblocked).
4. **UX residue** — **CLOSED 2026-09-29 (third pass):** all §5 carry-over rows **uxc-1…uxc-5** landed through the worker→reviewer loop, and **ux-6 (shell slice 1) landed 2026-09-29 → the UX queue is complete and closed** (counts **2026/150+1/120 changesets**). Follow-on: product/04 §7 **q-15** (slice 2, two-pane) is now pickup-ready.
5. **Publish-readiness day** (rides manual **M1**) — **runbook written, ready to execute cold:
   [`handoff/20260926-publish-runbook.md`](20260926-publish-runbook.md)** (preconditions, cut sequence,
   consumer smoke, tag/release, abort policy; dry-run validated 2026-09-26). The cut is mechanical once
   M1 lands.

## 2. Open threads (authoritative pointers)

| Thread                                  | Authoritative home                                                                                                                                                                                                                              | Next concrete step                                                                                                                                                                                                   | Blocked on                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| ~~AU-3 — impl-audit remediation~~       | **[handoff/20260927-impl-audit-remediation.md](20260927-impl-audit-remediation.md)** — au3-1…au3-12, pick-up-cold specs: P0 CSV header guard + LF (au3-1), row-diff type policy (au3-2), export error wrapping (au3-3)                          | ✅ **CLOSED 2026-09-28** — all 13 tasks + probe landed (every task independently reviewed; unit 1866→**1959**, e2e **145+1**); residual non-blocking notes live in the queue file                                    | none — future rounds self-serve         |
| **AU-2 follow-ups (audit round 2)**     | **[handoff/20260927-audit-remediation.md](20260927-audit-remediation.md)** — f-1…f-10 (App.tsx decomposition, layering encoding, coverage, report.ts split…); au2-1…au2-4 all landed 2026-09-27                                                 | ✅ **CLOSED 2026-09-28** — f-1…f-11 all landed (every task independently reviewed; unit 1862→**1967**); residual carry-overs explicitly deferred (queue §3)                                                          | none — closed                           |
| **UX queue (interface audit) — CLOSED** | **[handoff/20260929-ux-queue.md](20260929-ux-queue.md)** — complete 2026-09-29 (ux-1…ux-7 + **uxc-1…uxc-5**; **ux-6 shell slice 1 landed 2026-09-29**; unit 1967→**2026**, e2e 145+1→**150+1**)                                                 | closed — follow-on q-15 (slice 2) pickup-ready                                                                                                                                                                       | —                                       |
| ~~Dependabot PRs~~                      | ✅ **CLOSED 2026-09-24/26** — all five merged (#2, #7 routine; #6, #4 verified; #5 + one tsconfig fix, reviewer-approved)                                                                                                                       | none — future Dependabot rounds land through the same triage                                                                                                                                                         | —                                       |
| ~~PT-Q~~                                | ✅ **CLOSED 2026-09-26** — all lanes landed; residue = per-row carry-overs + q-14 + q-7 slice 2 (rows in [product/04 §7](../../product/04-post-mvp-track.md))                                                                                   | q-14, q-5b helpers, q-7 slice 2                                                                                                                                                                                      | none                                    |
| ~~D12 / D13~~ + C-pt0-1 + D14 rulings   | **[handoff/20260926-maintainer-rulings.md](20260926-maintainer-rulings.md)** — ✅ **CLOSED 2026-09-29**: all four ruled (C-pt0-1 approve + ADR 0045; D12 PT-P first; D13 keep-as-target; D14 ADR 0044 accepted); records in the file's sections | none — queue closed; spawned queues: [telemetry](20260929-telemetry-queue.md) + [PT-P](20260929-ptp-queue.md)                                                                                                        | none                                    |
| Publish-readiness day                   | **[handoff/20260926-publish-runbook.md](20260926-publish-runbook.md)** (authored 2026-09-26; ar-5 carry-overs enumerated inside)                                                                                                                | land M1, then execute the runbook (one orchestrator lane + reviewer on steps 4/6/8)                                                                                                                                  | manual **M1**                           |
| Unreleased changesets                   | `.changeset/` (**123 pending**: MVP/AR-era set + dr-4 six + the twelve 2026-09-26 lane changesets + au2 + **13 AU-3** + au2-f1/f2/f3/f5/f9/f10 + **ux-1/2/3/4 + uxc-1/2/4/5 + ux-6** 2026-09-29 + **t-1 + t-2 + p-1**)                          | `pnpm version-packages` at the first release cut — tooling validated 2026-09-24 (`privatePackages.version` in config, `c0d1600`; was failing invalid-tree before)                                                    | manual **M1**                           |
| ar-4 / ar-6 / ar-2 carry-overs          | [archived AR queue](archive/20260922-ar-queue.md) rows ar-4 / ar-6 / ar-2                                                                                                                                                                       | ar-6 n1: root typecheck task covering `playwright.config.ts` (small, worth a task — natural rider on Dependabot CI touches); ar-6 n2/n3 + ar-4 w1/w2/s3/s4 opportunistic; ar-2 B-side per-open engine release → PT-H | opportunistic / PT-H                    |
| dr-2 reviewer suggestions               | [archived doc queue](archive/20260923-doc-queue.md) row dr-2                                                                                                                                                                                    | arch-02 §2 could also cite ADR 0035; product/04 §4 hyperlink the §5 pointer; docs/README principle sentence stays full (honest minimum — noted, likely wontfix)                                                      | opportunistic (fold into any doc touch) |
| Demo dataset (O5)                       | [manual-actions.md](../manual-actions.md) O5 note                                                                                                                                                                                               | approach decided (hybrid); curation not started — needs the maintainer's source pick, then an agent-doable curation task can be queued                                                                               | maintainer source pick                  |

## 3. Maintainer checkpoints & manual actions (humans only)

- **Decisions: ALL RULED 2026-09-29** (the [rulings queue](20260926-maintainer-rulings.md) is closed): **C-pt0-1** ✅ telemetry approved (ADR 0045; implementation **complete 2026-09-29** — t-1/t-2/t-3 in the [telemetry queue](20260929-telemetry-queue.md); collector deployment + public disclosure = G0 tail) · **D12** ✅ PT-P first ([PT-P queue](20260929-ptp-queue.md) — **p-1 IR core landed 2026-09-30, p-2 next**; PT-V after — R4 spike) · **D13** ✅ keep-as-target (arch-01 §7) · **D14** ✅ ADR 0044 Accepted as written — ux-6 **landed 2026-09-29** (UX queue closed), q-15 (slice 2) unblocked/pickup-ready.
- **Manual actions open** ([manual-actions.md](../manual-actions.md)): **M1** npm org claim
  (gates first publish, D6 tail) · **M4** trademark/domain clearance (G0 tail) · org
  transfer + public flip (G0; the SECURITY.md private-reporting caveat resolves at flip).
- **Gate posture:** G0's **agent-side checklist is complete** (PT-0 closed 2026-09-24 — SECURITY.md,
  README front door, a11y CI all landed; telemetry **design approved 2026-09-29** — implementation
  queued in the [telemetry queue](20260929-telemetry-queue.md)). The G0 tail is human: M1, M4, org
  transfer + public flip, telemetry collector deployment. G2 evidence is **web-only** until PT-V
  exits (DM-2a, 2026-09-23).

## 4. Conventions now in force (learned the hard way, 2026-09-22 → 24)

- Queue rows are the authoritative task narratives; handoff §9 is one-liners with the
  splice-on-queue-close trigger (DM-5a); queue files use the 3-column shape (DS-4); docs are
  single-sourced per the dr-2 owner map; ADR index is generated (`pnpm adr:index`).
- **A11y scans gate CI** (pt0-4, 2026-09-24): `tests/e2e/a11y.spec.ts` must stay green on all four
  surfaces with the **empty** `DEFERRED_A11Y` allowlist — new deferrals need an entry with reason +
  tracking pointer, and the stale-entry guard fails if an allowlisted rule stops firing. App-source
  fixes that touch scanned surfaces should re-run the a11y spec.
- **E2e drills that mutate app source must `pnpm build` first** — the runner serves built `dist`;
  a source-only mutation false-passes (recorded in operating-model §7.6 after the pt0-4 review).
- Changeset tooling validated (`privatePackages.version`): contributors' `pnpm changeset` works;
  `pnpm version-packages` stays reserved for the first release cut (M1).
- Reviewer gate lists must include `pnpm format:check` — it is NOT in CI, so a missed
  prettier pass reaches main silently (q-5 did; fixed in `cb14a10`).
- Reviewer reports MUST end with the literal verdict line; a missing line = no verdict —
  re-dispatch a focused confirmation rather than inferring (exercised on the TS-6 lane, 2026-09-26).
- Worker/reviewer loop: briefs to `/tmp` per §7.6; workers on shifted ports; reviewers
  verify-only and fresh per dispatch; approve-with-carry-overs is the norm; round-2 briefs may
  expand a worker's boundary when the root cause is out of round-1 scope (exercised in pt0-4).
