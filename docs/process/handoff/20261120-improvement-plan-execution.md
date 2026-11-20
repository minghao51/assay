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

## 5. A01 documentation reconciliation — corrected-statement map (2026-11-20)

Delivered as the A01 slice (commit `docs(a01)`); row closure still requires the independent review
this record requires — this section is evidence, not a closure. Each row corrects a present-tense
statement to match code or a dated closure; no closed row was made pending and no
runtime/support-policy change is hidden in the editorial diff (the SECURITY.md exclusion remains
explicit policy; the Node development policy is A03's separate, Q1-selected change).

| Corrected statement (was → is)                                                                                                                                                                                                   | Evidence (code / closure)                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SECURITY.md intro listed **Arrow** among input dataset formats → the four input formats, Arrow as internal transport                                                                                                             | `docs/process/handoff.md` §1 ("Arrow/Feather input is not supported today"); D-10 format-truth fix (merged `7105963`)                                                                                         |
| SECURITY.md out-of-scope called `apps/vscode` a **placeholder with no attack surface** → implemented desktop functionality acknowledged; exclusion kept as explicit scope policy (pre-launch, not distributed)                   | `apps/vscode/package.json` contributions; `apps/vscode/src/extension.ts` activation; PT-V slice 2 closure 2026-10-19 (`docs/product/04-post-mvp-track.md` §3)                                                 |
| Telemetry collector §2 gave one timing row (1.5 s / 200–400 ms) for both clients → **CLI** 1.5 s, backoff base 200 ms vs **web** 5 s, backoff base 250 ms                                                                        | `apps/cli/src/telemetry/transport.ts` `DEFAULT_TIMEOUT_MS=1_500`, `BACKOFF_BASE_MS=200`; `apps/web/src/telemetry/transport.ts` `DEFAULT_TIMEOUT_MS=5_000`, `BACKOFF_BASE_MS=250`; retry/drop policy unchanged |
| `packages/engine-duckdb/README.md` said `files` globs are flat/top-level only → allowlist also includes recursive `dist/pipeline-runner/**` for the `./node` seam; no fresh tarball claimed                                      | `packages/engine-duckdb/package.json` `files` + manifest note; recursive globs added in `a7dfe35`                                                                                                             |
| `docs/engineering/03-repository-structure.md` §7 said desktop export/validation/diff/Git parity “remain PT-V slice-2 work” → parity implemented, slice 2 closed 2026-10-19                                                       | closure record `docs/product/04-post-mvp-track.md` §3/PT-V rows; `apps/vscode/src/dataset.ts`, `apps/vscode/src/git-adapter.ts`                                                                               |
| `docs/process/handoff.md` header + §6 listed EW-03I-b / EW-04I / optional ADR 0051 / TB-2 / the ADR 0049 decision-4 row as remaining → all closed/accepted; remainder is unselected ENG-2/ENG-3                                  | closures `233dc6a`+`e954d8c`, `52da4ca`+`9e62172`+`d0069be`, `6e97d14`, `f2fb523`+`81bb8dc`; ADR 0051 Accepted (`cb8637b`); pickup §1/§2                                                                      |
| 20261118 pickup §4 prompts read as dispatchable → labelled **historical / do-not-dispatch** (P0 explicitly)                                                                                                                      | pickup §2 (every named row closed); label added without deleting text                                                                                                                                         |
| `20261014-ptv-slice2-queue.md` header said **ACTIVE** and “Next dispatch is ptv2-5” → status-correction banner (CLOSED 2026-10-19; do not dispatch)                                                                              | the same file's §4 closure                                                                                                                                                                                    |
| open-asks listed R1 open and `TIMESTAMP 'infinity'` unowned → both ticked with dated closures                                                                                                                                    | R1 record `837b638`/`b0b78bc`/`5426979`; R2 probe `0f77e38`+`a17f3a3`                                                                                                                                         |
| `.changeset/au2-f10-qol-residue.md` map omitted `@assay/web` although its body declares the web engines change → **intake correction**: `'@assay/web': patch` added to the frontmatter (no `changeset version`, no version bump) | commit `c1906ba` changed `apps/web/package.json` (engines) and corrected the body to name `@assay/web`; the map had stayed narrower — map now equals the body's declared change                               |
| `.changeset/p-2-transform-sql.md` map omitted `@assay/contracts` although its body announces the re-exports → **intake correction**: `'@assay/contracts': patch` added (no `changeset version`, no version bump)                 | commit `2046e73` added `canonicalDecimal`/`isExactDecimalLiteral`/`CanonicalDecimal` to `packages/contracts/src/index.ts` (+4) and the body announces them                                                    |
| `.dsh/skills/assay-gates/SKILL.md` gate checklist omitted the `pnpm changeset` requirement → requirement added as a skill rule                                                                                                   | `AGENTS.md` § Commands (`pnpm changeset` — "with PRs that change packages"); provenance/notices in `.dsh/skills/PROVENANCE.md` untouched                                                                      |
| Accepted ADRs carried drifted line anchors / a stale status marker → recorded in a clarification/errata record; **no accepted decision text changed**                                                                            | `docs/adr/20261120-editorial-errata.md` (ADR 0044 Deciders leftover; ADR 0049 `CsvReviewDialog.tsx:442-452`; ADR 0050 `history.ts` ranges; ADR 0051 `overlay-query.ts:70-95`)                                 |

**Scope note (reviewer warning, 2026-11-20) — the `packages/engine-duckdb/README.md` edit is in
A01's scope.** The improvement plan's A01 **Targets** list names "package README" among the
reconciliation targets ("…repository structure, security scope rationale, telemetry collector timing
and package README"), and A01 spec item 3 directs "Document recursive pipeline-runner package
allowlist; do not imply a tarball was freshly audited". The README row of the table above implements
exactly that target: the edit is **in scope per the A01 target list**, authorized, and intentionally
left in place (not reverted).

**Follow-up reconciliation (commit `docs(a01): reconcile the post-EW-03I-a pickup with the closure
record`).** Reviewer items on `20261118-post-ew03ia-pickup.md`: its §2 still called closed **D3-1**
"the only live web row" and its §3 gave D3-1 a live dispatch step, and the §4 banner claimed "Every
row they name is closed" although **R3/R8** are recorded limitations and **R13** is unselected.
Corrected in place with history preserved: **D3-1** recorded **CLOSED** `a16eea5` + `9a39fe3` +
`d941b51`, no live web row remains, the §3 dispatch order is labelled historical/do-not-dispatch, and
the remaining recorded items are the unselected **ENG-2/ENG-3** plus **R3/R8** (recorded limitations)
and **R13** (unselected) — each keeping the status already recorded in the pickup §2 and the post-R1
acceptance record (D6/D7). No status vocabulary changed; no closed-row narrative, date or commit
evidence was removed.
