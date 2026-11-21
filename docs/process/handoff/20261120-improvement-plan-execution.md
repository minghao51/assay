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

Rows close only with a merged commit and an independent reviewer verdict (listed per row). Design
rows deliver a document and stop at `design-closed`; they do not authorize their implementation.

| Row  | Status            | Evidence (merge / commits / review)                                                                                                      |
| ---- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| A00  | **closed**        | this record §1                                                                                                                           |
| A01  | **closed**        | `4b64ff0`, `5354e20`; reviewer `approve` after two request-changes rounds (pickup contradictions, authorized package-README scope)       |
| A02  | **closed**        | `6d11204`; reviewer `approve` (fact mutations fail; closed history does not trigger)                                                     |
| A03  | **closed**        | `5c65f4f`; reviewer `approve`; `pnpm install --frozen-lockfile` exit 0                                                                   |
| A04  | **closed**        | `0219c3c`; reviewer `approve` (seams, exit matrix, no secret leakage)                                                                    |
| B01  | **closed**        | `41850c2`, `8347474`; reviewer `approve` (mutation: duplicate check + wire bytes)                                                        |
| B02  | **closed**        | `407c59f`, `c344b16`; reviewer `approve`; ENG-3 route = wire retained + web display adapter                                              |
| B03  | **closed**        | `0cf8044`; reviewer `approve` (abort matrix, error identity)                                                                             |
| B04  | **closed**        | `170177c`, `5a6c3e0`; reviewer `approve` after seam-stripping fix                                                                        |
| B05  | **closed**        | `ee0b841`, `5a6c3e0`; reviewer `approve` (residue identities, no "nothing written")                                                      |
| B06  | **closed**        | `85014b5`, `a93460d`; reviewer `approve` after the identity-guard pin                                                                    |
| C01  | **design-closed** | `d858ac4`, `9190425`; design review request-changes resolved (R-C01 + settled error API); implementation is C02                          |
| C02a | **closed**        | `d6430d6`, `a4ba9b6`, `9738d49`; reviewer `approve` after T9 interleave + stale-page pin                                                 |
| C02b | **closed**        | `dbb37b9`, `94e558f`, `a670e03`, `f81e904`; reviewer `approve` after drill/copy-claim fix                                                |
| C02c | **closed**        | `3b239f2`, `1c3b77f`, `e5d53cc`, `d1e5c28`; reviewer `approve` after the sort-copy split                                                 |
| C03a | **design-closed** | `d858ac4`; design review verified inventory/contract; implementation is C03b                                                             |
| C03b | **closed**        | `19f86fb`; reviewer `approve` (fail-closed reset + honest activation outcomes)                                                           |
| C04  | **closed**        | `c32a0e9`; reviewer `approve` (shared settlement, one terminate)                                                                         |
| C05  | **closed**        | `f83fd96`, `a9a299e`; reviewer `approve` (count-preserving corruption detected)                                                          |
| D01  | **closed**        | `4d7ef4c`, `e704d02`; reviewer `approve` after caller/stale-token pins                                                                   |
| D02a | **closed**        | `2d7a96f`; reviewer `approve`                                                                                                            |
| D02b | **closed**        | `12e2981`, `65b7d22`; reviewer `approve` after the post-read currency pin                                                                |
| D02c | **closed**        | `fb10abe`, `9f07939`, `89a7cea`; reviewer `approve` after manifest regeneration                                                          |
| D03a | **closed**        | `1d76fed`, `2e46573`; reviewer `approve` after the cancel/close epoch guard                                                              |
| D03b | **closed**        | `6a48583`, `04fed7f`, `d9e23e3`; reviewer `approve` after interrupted-session adoption                                                   |
| D04a | **closed**        | `8b290c0`, `9b065eb`, `8cd015b`; reviewer `approve` after drill evidence + changeset                                                     |
| D04b | **closed**        | `1d5fec3`, `e5374c3`, `b219ecd`; reviewer `approve`                                                                                      |
| E01  | **design-closed** | `bc91591`, `2681de2`; design review request-changes resolved (transport limitation, revert affordance). Implementation not selected (Q6) |
| E02  | **closed**        | `3ac917a`, `e772396`; reviewer `approve` (independent size/manifest spot-checks)                                                         |
| E03  | **closed**        | `a64a144`, `080192c`, `a230a25`, `1367647`; reviewer `approve` after the C02a/C03b refresh                                               |
| E04  | **design-closed** | `bc91591`, `2681de2`; design review request-changes resolved. No runtime row selected (Q7)                                               |

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

## 6. Final integration evidence (2026-11-20)

All touched lanes were independent-worktree branches; each was reviewed by a
different agent (model/provider distinct from the implementer) before merge.
The merged gates below were run by the orchestrator on `main` after the last
merge (`D02c`).

| Gate                                             | Result                                                                                                                                                     |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm format:check`                              | exit 0                                                                                                                                                     |
| `pnpm lint`                                      | exit 0                                                                                                                                                     |
| `pnpm typecheck`                                 | exit 0 (20/20 tasks)                                                                                                                                       |
| `pnpm test`                                      | exit 0 — **291 files / 4444 tests**                                                                                                                        |
| `pnpm build`                                     | exit 0 — 12/12 tasks                                                                                                                                       |
| `pnpm docs:links:check`                          | exit 0                                                                                                                                                     |
| `pnpm adr:index:check`                           | exit 0 (51 records)                                                                                                                                        |
| `pnpm current-state:check`                       | exit 0 (91 assertions / 5 facts)                                                                                                                           |
| `pnpm assurance-map:check`                       | exit 0                                                                                                                                                     |
| `node scripts/dependency-report.mjs --check`     | exit 0 (114 entries / 31 annotations)                                                                                                                      |
| `pnpm measure:bundle`                            | exit 0 (deterministic; see `10-dependency-and-bundle-measurements.md`)                                                                                     |
| `pnpm test:coverage` (`--maxWorkers=4`)          | exit 0 — **statements 90.22 % (19856/22007), branches 84.97 % (13227/15565), functions 92.11 % (3259/3538), lines 91.9 % (17957/19538)**; floors unchanged |
| `pnpm test:e2e` (`DUCKDB=/tmp/duckdb`)           | exit 0 — **287 passed, 1 skipped** (the 1M-row fixture leg)                                                                                                |
| `node apps/cli/scripts/pack-consumer-smoke.mjs`  | exit 0 — `PACK CONSUMER SMOKE: PASS`                                                                                                                       |
| Pinned VS Code extension host (per desktop rows) | exit 0 — `ALL SCENARIOS PASSED`, CLI agreement legs pass                                                                                                   |

A first `test:coverage` attempt at default worker count failed two
contention-sensitive tests (a telemetry `duration_bucket` boundary and the
`dcr-round-trip` fuzz timeout at 20 s); both pass at four workers and the
suite is green there. No timeout, ceiling or threshold was changed.

### Carried limits (not erased)

1. **Node 22 product-floor minimum is unexercised.** Development policy is Node
   24 (`^24.0.0`, tested 24.13.0); each package keeps a declared `>= 22`
   product floor, and no Node 22 runtime exists in this environment. Narrow the
   floor or exercise it elsewhere before claiming it tested.
2. **CSV `quote = ''` (quoting disabled) is CLI-controlled, not UI-reachable.**
   The shipped form treats blank as "reader choice"; B02 proves disabled
   semantics at the DuckDB 1.5.5 CLI-control level and in a dialog test, and
   every reachable UI case in the real WASM browser.
3. **Browser `abort()` does not roll back a destination.** B03 attempts one
   abort on failure and rethrows the primary error; it makes no claim that the
   destination is restored or that a download is durable.
4. **Cleanup identity-check → unlink is not atomic (B04/B05).** A replacement
   appearing between the check and the unlink can still be removed; both tasks
   document this and leave unverifiable residue rather than deleting it.
5. **Cancel after a verified desktop close can leave a complete file** (D03a
   writer contract); response correctness is fixed, file removal in that
   narrow window is not.
6. **Desktop webview has no coverage instrumentation.** D03b adds real unit
   subjects (the `vscode-webview` happy-dom project) but the coverage include
   and floors are unchanged; browser-level webview coverage remains a separate
   config decision.
7. **`TEST-PROOF` code remains in the production webview bundle.** Removing it
   is a separate measured bundling decision, not part of D03b.
8. **Reset callbacks cannot be rolled back** (C03b). A fault abandons the
   session into an honest, value-free recovery frame; it does not restore
   arbitrary effects from other React owners.
9. **C02b/C02c copy affordances are local.** Accepted-reload/unknown-state
   recovery is offered from the filter bar; the profile and validation panels
   reuse the sentences without panel-local buttons.
10. **E02 budgets are deliberately unset** pending representative repeated
    baselines; no dependency was removed or upgraded.

### Program status

All 24 planned rows are accounted for: 20 implementation/verification rows are
`closed` with merged evidence, and 4 design rows (C01, C03a, E01, E04) are
`design-closed`. C02/C03/E01/E04 implementation choices remain separate
decisions where the plan said they were (Q6/Q7 design-only; C02 children were
selected and executed). No push, publish, collector traffic or remote CI was
performed.
