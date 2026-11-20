# Improvement-plan execution record — baseline, decisions and dispatch

**Date:** 2026-11-20. **Status:** execution record for the 2026-11-20 improvement plan
(`improvement-plan.md` / `tasks.json`, preserved outside the repository and summarised in
[§3](#3-task-queue-status)). This record owns the baseline evidence, the selected policy
decisions and the lane reservations. It does **not** claim any runtime row is closed; rows close
only with merged evidence and independent review, recorded per row below.

## 1. Fresh baseline (A00)

Observed in this checkout, not copied from an earlier record.

| Fact        | Observed value                                                    |
| ----------- | ----------------------------------------------------------------- |
| SHA         | `e68bde91d32b38a854c9fa573819a34ee418135f` (`main`, clean tree)   |
| Node / pnpm | `v24.13.0` / `11.26.0` (`.node-version`: `24`)                    |
| DuckDB CLI  | `/tmp/duckdb` → `v1.5.5 (Variegata)`                              |
| VS Code     | `/usr/bin/code` present (pinned extension host tested separately) |
| OS          | Linux 6.14 (Ubuntu 24.04), x86_64, 16 CPUs                        |
| Playwright  | installed; Chromium caches present                                |
| E2E ports   | 4173/4179/4180 free at baseline                                   |

Baseline gates (own run, 2026-11-20, `main`, clean tree):

| Gate                    | Result                                          |
| ----------------------- | ----------------------------------------------- |
| `pnpm format:check`     | exit 0 — all files Prettier-clean               |
| `pnpm lint`             | exit 0                                          |
| `pnpm typecheck`        | exit 0                                          |
| `pnpm docs:links:check` | exit 0 — 167 files, 0 broken links              |
| `pnpm adr:index:check`  | exit 0 — 51 records                             |
| `pnpm test`             | exit 0 — 264 files / 4058 tests passed (54.7 s) |
| `pnpm build`            | exit 0 — 12/12 tasks                            |

Historical counts above are evidence, **not** a reusable pass claim; each merged lane re-runs the
full suite.

## 2. Selected policy decisions (Q1–Q7)

The maintainer delegated selection to the executing orchestrator for this batch; each selection is
recorded here as project policy for the dependent row.

| ID                                      | Selected option                                                                                                                                                                                                                                                                                                                                                                                                                                     | Notes / limits                              |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| **Q1** development Node support         | **Node 24 line for development** (`^24.0.0` in the root manifest, matching `.node-version` and CI). Product manifests keep their declared `>=22` floor; the 22-line minimum is **not exercisable in this environment** and is recorded as an unexercised declared floor, not a tested claim. Tested development runtime: `24.13.0`. Locked floors: ESLint 10 → `^20.19.0 \|\| ^22.13.0 \|\| >=24`; Vitest 4 → `^20.0.0 \|\| ^22.0.0 \|\| >=24.0.0`. | A03 implements; A04 checks the same policy. |
| **Q2** duplicate CSV declared types     | **Refuse** a repeated parsed name (including identical-type repeats) with a value-free line-level refusal. Names stay case-sensitive.                                                                                                                                                                                                                                                                                                               | B01.                                        |
| **Q3** failed File acquisition          | **Retry on rejection on the same source instance**; a fulfilled snapshot is retained for the instance lifetime and never re-fetched.                                                                                                                                                                                                                                                                                                                | B06.                                        |
| **Q4** whole-list filters               | **Optional `replaceFilters(list)` provider capability**; legacy non-atomic path stays documented.                                                                                                                                                                                                                                                                                                                                                   | C01 design → C02 children.                  |
| **Q5** reset/activation callback faults | **Fail closed**: after probing, attempts every reset, never publishes ready after a failed callback, and reports an explicit unknown/restoration-failed outcome for commit activation.                                                                                                                                                                                                                                                              | C03a design → C03b.                         |
| **Q6** telemetry opt-out                | **Design-only** (E01): abort active send and stop retries; no recall claim. Implementation is not selected by this batch.                                                                                                                                                                                                                                                                                                                           | E01.                                        |
| **Q7** larger UX work                   | **Design-only** (E04): WF-O1 filter-draft clarity first; no runtime change.                                                                                                                                                                                                                                                                                                                                                                         | E04.                                        |
| **B02** ENG-3 route                     | **Keep the wire representation; fix the engine comment and interpret display sentinels at an explicit web display adapter.** No engine payload/type/guard migration.                                                                                                                                                                                                                                                                                | B02.                                        |

## 3. Task queue status

Statuses use the plan's vocabulary. All rows were `proposed` at dispatch; this record is updated as
rows land. Design rows deliver a document and stop.

| Row      | Wave | Status                           | Evidence       |
| -------- | ---- | -------------------------------- | -------------- |
| A00      | W0   | **closed**                       | this record §1 |
| A01      | W0   | dispatched                       |                |
| A02      | W1   | dispatched (after A01)           |                |
| A03      | W0   | dispatched                       |                |
| A04      | W1   | dispatched                       |                |
| B01      | W1   | dispatched                       |                |
| B02      | W1   | queued (after web lane)          |                |
| B03      | W1   | dispatched                       |                |
| B04      | W1   | dispatched                       |                |
| B05      | W2   | queued (after B04 design review) |                |
| B06      | W2   | dispatched                       |                |
| C01      | W2   | queued                           |                |
| C02a/b/c | W2   | queued (after C01)               |                |
| C03a     | W2   | queued                           |                |
| C03b     | W2   | queued (after C03a)              |                |
| C04      | W1   | dispatched                       |                |
| C05      | W1   | dispatched                       |                |
| D01      | W2   | dispatched with web lane         |                |
| D02a/b/c | W3   | queued                           |                |
| D03a/b   | W3   | queued                           |                |
| D04a/b   | W3   | queued                           |                |
| E01      | W4   | queued (design)                  |                |
| E02      | W4   | queued                           |                |
| E03      | W2   | queued                           |                |
| E04      | W4   | queued (design)                  |                |

## 4. Lane reservations and conflict rules

- One writer per package at a time; web lanes serialise. Each lane runs in its own git worktree
  with shifted e2e ports (`.pi`/plan conventions: `ASSAY_E2E_PORT_WEB/ENGINE/DS`).
- Workers do not edit `docs/**` (orchestrator-owned) except the `A01` documentation lane and
  `.changeset/*` entries for their own packages.
- No push, publish, remote collector traffic, network dependency installs beyond the warmed pnpm
  store, or destructive git cleanup.
- Every row ships a Conventional Commit, a package changeset when a package changes, a regression
  probe before the fix where a runtime behavior changes, and an independent reviewer verdict.
