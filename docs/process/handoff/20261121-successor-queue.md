# Successor queue — remaining work after the 2026-11-20 improvement batch

**Date:** 2026-11-21. **Status:** classified index + dispatch briefs. **The 2026-11-21 batch executed
§2/§3 A1–A3 and B1–B5 and measured B6/C2/C3; the per-row ledger is §8.** The §1–§3 text below is
kept as the contract each row was dispatched against (it is the record of what was authorised, not a
to-do list); §4–§7 keep their meaning for whatever the ledger still lists as open. Rule zero still
applies: record a fresh SHA and run your own gates; never reuse the counts in this file as a pass
claim.

**Authority order:** accepted ADRs → the living [handoff](../handoff.md) current-state block → the
[2026-11-20 execution record](20261120-improvement-plan-execution.md) → dated queue/design records →
this index → older history.

## 0. Verification without remote CI (read first)

Remote CI is **billing-blocked**, not code-blocked. On 2026-11-21 run `44887930938` (`c2af086`) had
all four jobs refused at start with _"recent account payments have failed or your spending limit
needs to be increased"_; no step ran. The last executed run, `44886310732` on `71a67fc`, is green.
Do not read a new red run as a code signal and do not retry to "fix" it.

**The local gate suite is the authority.** Run it once on a clean tree before any push, and after
each merge; paste command tails into the task record.

```bash
corepack pnpm install --frozen-lockfile
pnpm run doctor                                 # offline prerequisite preflight
export DUCKDB=/tmp/duckdb PATH=/tmp:$PATH      # pinned CLI v1.5.5
pnpm format:check
NODE_OPTIONS=--max-old-space-size=4096 pnpm lint   # type-aware lint peaks ≈3 GB RSS
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
pnpm test:e2e                                   # after build; 287 + 1 skip
node apps/vscode/scripts/run-e2e.mjs            # pinned host, offline cache
node apps/cli/scripts/pack-consumer-smoke.mjs
```

Recorded final-tree evidence (2026-11-20, own run, not reusable): 291 files / 4444 tests, coverage
90.22 / 84.97 / 92.11 / 91.9, e2e 287 + 1 skip, pack smoke PASS, pinned host PASS.

**Contention-sensitive tests** (do not change ceilings; re-run solo before declaring a failure):
`apps/web/src/sql/SqlPanel.telemetry.test.tsx` duration-bucket pin, `packages/pipeline/src/dcr-round-trip.test.ts`
fuzz timeout, `packages/validation/src/duckdb-agreement.test.ts` and `re2.test.ts` CLI spawns, and the
`packages/engine-duckdb` pinned-CLI agreement tests. Use `--maxWorkers=4` for coverage; a default-worker
failure in these is environmental.

**Push policy:** batch pushes; verify locally first. A push will show four billing-failed runs — note
it in the task record rather than treating it as signal. The pinned VS Code host, Playwright and the
packed-consumer smoke run offline and are the substitute for remote jobs.

## 1. Readiness at a glance

| #   | Work item                                                           | Recorded where                                                                                              | Spec status                     | Next action                            |
| --- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------- |
| A1  | E01 telemetry opt-out cancellation                                  | [E01 design](20261120-e01-optout-cancellation-design.md)                                                    | **Complete design**             | select + one copy decision             |
| A2  | E04 / WF-O1 filter-draft clarity                                    | [E04 design](20261120-e04-bounded-ux-design.md) §3                                                          | **Complete design**             | select + implement                     |
| A3  | C02 recovery parity in profile/validation panels                    | C02b/c limits in the [execution record](20261120-improvement-plan-execution.md) §6                          | **Missing**                     | small spec first                       |
| B1  | ENG-2 typed `repair-preview` count op                               | [pickup](20261118-post-ew03ia-pickup.md) ENG-2 row; handoff §2                                              | **One-line record**             | spec-first (engine brief)              |
| B2  | PT-H engine type-boundary trio                                      | [post-MVP §6](../../product/04-post-mvp-track.md#6-pt-h--hardening--backlog-inventory-recorded-carry-overs) | **One-line records**            | probe + spec-first                     |
| B3  | PT-H registry lifecycle (`profileComparison`/`closeTable`)          | post-MVP §6                                                                                                 | **Missing**                     | spec + ADR-0047 check                  |
| B4  | PT-H CLI `runDiffPlan` side-A hardcoding                            | post-MVP §6                                                                                                 | **One-line record**             | small spec/brief                       |
| B5  | PT-H `scanOrdinalScopes` join blind spot                            | post-MVP §6                                                                                                 | **One-line record**             | probe + test-or-fix brief              |
| B6  | PT-H diff scale benchmark                                           | post-MVP §6, roadmap risk R7                                                                                | **Method sketch only**          | verification brief                     |
| B7  | SQL true interrupt / second connection                              | post-MVP §6                                                                                                 | **Idea only**                   | design + ADR (ADR 0040)                |
| C1  | Webview coverage collector / floor                                  | [assurance map §4.2](../../engineering/11-assurance-coverage-map.md)                                        | **Decision + design**           | maintainer config decision             |
| C2  | Proof-orchestration exclusion from the production webview bundle    | D03b acceptance; D03 briefs                                                                                 | **Measured decision**           | measurement design                     |
| C3  | E02 bundle budgets                                                  | [measurements](../../engineering/10-dependency-and-bundle-measurements.md)                                  | **Method complete, no budgets** | repeated-baseline task                 |
| C4  | Node 22 product-floor verification                                  | [node contract](20261120-node-support-contract.md)                                                          | **Blocked by environment**      | provision Node 22, or narrow the floor |
| D1  | WF-03 / WF-04 / WF-07 / WF-08 / WF-09                               | [open-asks](20261019-open-asks.md) §0; [RD sheet](20261104-rd-open-decisions.md)                            | **Decision-first**              | WFD-05 / WFD-03 / WFD-07 / WFD-04      |
| D2  | WF-O2 temporal parity (nested/Record/SQL)                           | [E04 design](20261120-e04-bounded-ux-design.md) §4                                                          | **Outline only**                | design after selection                 |
| D3  | RD sheet items not yet resolved                                     | [RD decision sheet](20261104-rd-open-decisions.md)                                                          | **Decision-first**              | check each row's resolution            |
| D4  | UX-D2 / uxv-6 adjustable SQL sizing                                 | [open-asks](20261019-open-asks.md) §2                                                                       | **Design decision**             | maintainer + bounded design            |
| D5  | Overlay-aware profile candidate                                     | [candidate](20261030-overlay-profile-candidate.md)                                                          | **Planning-only sketch**        | select before any spec                 |
| D6  | U-1 unbounded replacement waits                                     | [open-asks](20261019-open-asks.md) §0                                                                       | **Open question**               | decide policy, then spec               |
| D7  | P4 adapter priority                                                 | roadmap §7 D9                                                                                               | **Decision only**               | user-demand decision                   |
| D8  | Publication / registry policy, first release                        | [publish runbook](20260926-publish-runbook.md), open-asks §2                                                | **Decision + human**            | maintainer                             |
| D9  | npm `@assay` org, trademark/domain, collector hosting, demo dataset | open-asks §1                                                                                                | **Human actions**               | maintainer                             |
| D10 | GitHub Actions billing                                              | open-asks §1 (new row)                                                                                      | **Human action**                | restore, then re-run CI                |
| E1  | G2–G4 growth tracks (AI, hosted workspace, enterprise)              | roadmap §5                                                                                                  | **Gated**                       | do not start before evidence           |

**What is not remaining:** MVP M0–M6, PT-V slices 1–2, pipeline P1–P3, local DCR v1, the UX/visual
queues, a11y CI, telemetry implementation/disclosure, ENG-3, and the 2026-11-20 improvement batch.
Do not re-dispatch or re-litigate those.

## 2. Ready to dispatch (design contract complete)

### A1 — E01 telemetry opt-out cancellation

**Contract:** [design](20261120-e01-optout-cancellation-design.md) §3–§5. Optional `send(batch, { signal? })`,
runtime-owned per-generation `AbortController`, timeout-abort (retryable) vs caller-abort (drop, never
retry), cancellation checked before each attempt and after backoff, off/dispose aborts and clears,
off→on starts a fresh generation, no replay.

**One decision before code:** whether `DISCLOSURE_REVISION` bumps (§3.4). If the user/maintainer
selects "no bump", the exact replacement wording still applies and the revision stays; state it in
the task record.

**Boundary:** `apps/web/src/telemetry/{runtime,transport}.ts`, copy module, their tests. CLI parity is a
separate follow-up (`apps/cli/src/telemetry/transport.ts`) — do not bundle it.

**Acceptance:** the design's test matrix (off-before-send, off-in-fetch, off-in-backoff, off→on,
dispose-during-send, repeated flush, timer/listener cleanup) with synthetic canaries only; the
never-reject production policy unchanged; stock endpoint-free build delivers nothing; disclosure says
"stops further attempts and attempts to abort in-flight delivery", never "recalls". Mutation drill:
remove the post-backoff cancellation check → a test fails.

**Stop:** do not invent a later-batch regression test under unreachable defaults, deploy a collector,
or claim already-sent bytes can be recalled.

### A2 — E04 / WF-O1 filter-draft clarity

**Contract:** [E04 design](20261120-e04-bounded-ux-design.md) §3 — draft-vs-accepted model with exact
string equality (not SQL equivalence), the 9-case state table, one modest `Not applied` marker
(operable button, accessible name/state, focus return, value-free live region), copy table, and the
manual-recovery path after C01/C02 unknown state.

**Boundary:** `apps/web/src/grid/FilterBar.tsx` + a small copy/state module + tests; do not touch the
SQL escape hatch, the compose-value input, or any WF-02/03/04/07/08/09 surface.

**Acceptance:** every state row asserted; dirty marker only on accepted-vs-draft mismatch; activating
it reverts only the draft (no dispatch); keyboard/focus/live-region behavior pinned; C02 phase copy and
`filtersUnknown` recovery unchanged; no DOM identity churn in the grid; e2e filter journeys green.
Mutation drill: make equality SQL-normalize or dispatch on activation → a test fails.

**Stop:** no clear-all control, no status union, no "unsaved dataset" claim, no global ErrorBus.

### A3 — C02 recovery parity for profile/validation panels (spec first, then implement)

C02b/c left `Retry` / `Clear filters` only in the filter bar; the profile top-k and validation
filter-to-failures paths show the same sentences without a panel-local action. Write a **short spec**
(one page) choosing: (a) keep bar-only recovery and say so in each panel's copy, or (b) add one
panel-local action via existing alert/status components. Then implement the chosen option. Do not
redefine the C01 phases or move restoration out of the model.

## 3. Spec-first briefs

### B1 — ENG-2 typed `repair-preview` count op

**Why:** the web layer composes the affected-count from preview data; exactness is not engine-owned.
**Spec deliverable (before code):** inventory the current web composition and its tests; define the
typed request/response (count + refusal categories), caps/sample semantics (no new scans beyond the
existing preview), error categories, conformance scenario, and the web caller migration. State whether
the preview payload and DCR/repair flows change bytes (they must not).
**Then implement:** engine op first with conformance + hostile-wire/pre-execution refusal tests, then
the web caller switch, with the old composition deleted only after the new path is proven. Changesets:
`@assay/engine-duckdb` (minor for a new op) and `@assay/web` if the caller changes. No cap or memory
change; no ADR-0051 shape changes.

### B2 — PT-H engine type-boundary trio

Probe each before fixing, one commit per defect: `VARCHAR(<huge>)` fails late (bound the modifier at
validation); `VARBIT` over-acceptance (reject outside the supported materialization); `UHUGEINT`
byte-render (exact render or a documented signed-range refusal). Each needs a real-engine test and a
mutation. Do not widen type support.

### B3 — PT-H registry lifecycle (`profileComparison`/`closeTable`)

The diff B-side profiling accumulates `assay_tN` registry entries. **Spec first:** define a
`profileComparison`/`closeTable` op (or an explicit decision to keep accumulation), its identity
rules, lane, refusal categories, and retention semantics. **Check ADR 0047 before proposing any
release op** — web session retention is accepted and must not be reopened; this op is about the diff
staging registry, not the web session. If the design would weaken ADR 0047, stop for an ADR.

### B4 — CLI `runDiffPlan` side-A hardcoding

`runDiffPlan` hardcodes side A to `DATASET_VIEW`. Write a one-page spec choosing parameterization vs a
self-explanatory assertion, then implement with CLI integration + cross-surface agreement tests. No
wire-format change.

### B5 — `scanOrdinalScopes` join blind spot

A same-SELECT bare `JOIN … ON` filter would not be caught. Probe the composer with a bounded hostile
plan; either extend the scan (with tests) or record an accepted, tested limitation. Byte goldens make
any SQL change review-visible.

### B6 — Diff scale benchmark

Verification only: pick representative A/B fixtures (including a large pair), record TTFR, staged-diff
latency and memory with the pinned host, and compare against the M6/M1 method. No threshold until two
stable baselines exist. Do not change diff behavior in this task.

### B7 — SQL true interrupt / second connection

**Design first, likely ADR:** ADR 0040 explicitly has no hard-cancel promise and the UI copy says a
query may finish in the background. A true interrupt changes the engine/lane contract. Return a
decision request with the cheapest option (e.g. second connection for reads) and its failure modes;
do not implement from this index.

## 4. Maintainer decisions and human actions

Use the [RD decision sheet](20261104-rd-open-decisions.md) and [open-asks](20261019-open-asks.md);
check each row's current resolution before asking again.

- **WFD-05 → WF-03** (shell/panel presentation), **WFD-03 → WF-04** (contextual next action),
  **WFD-07 → WF-07** (visible row range), **WFD-04 → WF-08/WF-09** (layout study; ADR 0044 stands):
  each needs an itemized choice before any runtime row.
- **WF-O2** (nested/Record/SQL temporal parity): needs a type-propagation contract decision.
- **UX-D2 / uxv-6** adjustable SQL sizing; **D-09** overlay-aware profile; **D-06** comparison-staged
  indicator; **D-07** dirty-replacement guard; **D-05** offline WASM extensions; **D-11** run-origin;
  **D-03/D-04** Help and performance budget; **D-01/D-02** (rd-6/SV-D02, RD-T07 human evidence).
- **U-1** unbounded replacement waits: decide whether a hung engine gets an explicit unavailable state.
- **P4** adapter priority (dbt/SQLMesh/Dagster) — user demand.
- **Publication/registry policy** and first release (229 pending changesets; runbook ready);
  **npm `@assay` org**, trademark/domain, telemetry collector hosting, demo dataset source.
- **GitHub Actions billing** — restore to get remote CI back; until then use §0.
- **Node 22** product floor: either provision a 22 runtime to verify the floor or narrow the claim (the
  development policy is Node 24; product manifests declare `>= 22`).

## 5. Dispatch envelope template (one task at a time)

```text
TASK: <ID> — <title>
BASE: <sha> (verify clean; record your own baseline)
CONTRACT: <design/decision record + accepted ADRs>
DECISIONS: <selected option(s)>
ALLOWED: <paths>
FORBIDDEN: docs/** unless the task is docs; shared root configs; other packages; pnpm-lock; new deps
DONE-WHEN: <behavior + tests from the contract>
GATES: §0 suite (targeted first, full after), plus the task-specific e2e/host/pack leg
EVIDENCE: pre-fix probe failure, post-fix pass, one mutation drill, exact commands/exits, log paths
STOP: ADR conflict, unselected policy/UX, wire/persisted-format change, package-boundary crossing,
      impossible prerequisite, failing pre-existing gate, sensitive data, release/publish action
REVIEW: independent reviewer (different session/model), read-only, runs gates + a mutation itself
```

## 6. Paste-ready prompt for the next agent

```text
You are continuing Assay maintenance after the 2026-11-20 improvement batch. Repository is local;
remote GitHub Actions is billing-blocked (job-start failures are not code signal).

Read, in order: AGENTS.md; docs/process/handoff.md current-state block;
docs/process/handoff/20261121-successor-queue.md (this file);
docs/process/handoff/20261120-improvement-plan-execution.md §6; the task's design/decision record;
the relevant ADRs. Record a fresh SHA and run the §0 local gate suite before edits.

SELECTED_TASK = <A1|A2|A3|B1..B7>   # one task (or one named child) only
DECISIONS = <chosen options>         # e.g. DISCLOSURE_REVISION bump yes/no; WF-O1 selected

If SELECTED_TASK is empty: do not modify code. Return the minimum decision(s) needed and a proposed
envelope for the next dependency-ready item.

Reserve one task, use a scoped branch/worktree, and follow worker → independent reviewer →
integration from docs/process/handoff/operating-model.md. The implementer must not approve its own
change. Run the full §0 suite locally, paste tails, perform at least one load-bearing mutation, and
record the billing-blocked CI caveat instead of waiting for Actions.

Never weaken existing assertions, floors, caps, timeouts or privacy rules. Keep refactors and behavior
changes separate. Stop (BLOCKED, not CLOSED) for an ADR conflict, unselected policy or UX, a new
wire/persisted format, a package-boundary crossing, an impossible prerequisite, or a release/publish
action. Report task ID, diagnosis, files/commits, gates with exits, reviewer verdict, unchanged
invariants, remaining limits.
```

## 7. Definition of done for the next batch

A row is closed only with: merged commit(s), Conventional Commit(s), package changeset(s) where a
package changed, a regression/fault probe before a behavior change, the full local §0 suite green on
the merged tree, an independent reviewer verdict, and this file + the living handoff updated in the
same change (row status, evidence, carried limits). A design row is `design-closed` only with a
recorded contract and its open decisions named; designing is not authorization to implement.

## 8. Execution ledger — the 2026-11-21 batch

**Branch:** `work/20261121-successor-batch`, 21 commits over `main` at `e3fa5fd`. **Authority:** the
maintainer's instruction to pick the remaining dispatchable rows up without further approval; every
selection made here is named in §8.2 so it can be reversed in one place. **Remote CI:** still
billing-blocked — the push shows four job-start refusals, which is not code signal (see §0).

### 8.1 Rows

| Row                                  | Outcome                       | Commits                                                                | Evidence and carried limits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------ | ----------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1 E01 opt-out cancellation          | **CLOSED**                    | `048b70a`, `42c04ff`                                                   | Optional `send(batch,{signal})`; runtime per-generation abort on off/dispose; caller abort ≠ timeout; cancellable backoff; listeners/timers removed in `finally`; drained batch dropped, never replayed. Disclosure's final sentence replaced at revision **1** (§8.2 D2). +379 telemetry tests across transport/runtime suites. **Limit:** a transport that ignores the signal keeps its own retry loop (design §5), and `keepalive` unload behaviour stays platform-defined; CLI parity remains a separate row. **Drill note:** removing only the post-backoff check leaves the suite green because the loop-head check and the early-abort sleep enforce the same guarantee — the recorded drill therefore removes the whole no-fetch-after-abort guarantee and fails as documented. |
| A2 E04/WF-O1 filter-draft clarity    | **CLOSED**                    | `030aa87`                                                              | Exact-string draft rule (`grid/filter-draft.ts`, 18 tests); `Not applied` button on the active-row and escape-hatch inputs only; revert is draft-only with focus return, no dispatch; no-op Apply (trimmed equality + content identity, §8.2 D3); FilterBar 61 → 78 tests; one additive e2e journey; quiet scoped CSS. **Limit:** no clear-all, no status union, no "unsaved dataset" claim; no AT study or zoom measurement (E04's carried evidence gaps).                                                                                                                                                                                                                                                                                                                             |
| A3 C02 recovery parity               | **CLOSED**                    | `7f044d7`, `f4178d6`                                                   | Option (b) chosen (§8.2 D4): panel-local `Retry`/`Clear filters` beside each alert, same classes as the bar, phase-derived; copy byte-identical. The validation hook's recovery now captures the session token + validation sequence, so a late recovery cannot write feedback onto a replaced dataset (test fails without it).                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| B1 ENG-2 typed repair-preview count  | **CLOSED**                    | `d457eec`, `4de7233`, `6e7a6d2`                                        | New `engine/repair-preview-count` op (query lane); predicate + statement engine-side (`repair-preview-query.ts`), web composition deleted after a parity window. Byte-identical statement proved three ways (transitional parity test, engine unit pin, conformance case (i)); real-CLI conformance a–i; 38 unit tests; drills: dropping term A fails the cancellation case, running pre-repair fails the stacked case. Refusals pre-execution and value-free; duplicate keys refused (not normalised); NUL/lone-surrogate text refused instead of failing late. Changesets: engine minor, web patch.                                                                                                                                                                                   |
| B2 engine type-boundary trio         | **CLOSED**                    | `247ab1c`, `f93315f`, `617ea11`, `0138dab`                             | Optional integer modifier bounded to `0..2147483647` (CLI-pinned both ends); `VARBIT`/`BIT VARYING` refused, `BIT`/`BIT(n)`/`CHARACTER VARYING` kept; `UHUGEINT` renders its exact unsigned 128-bit value (byte order probed against the shipped transport, not assumed). Nested `UHUGEINT` leaves and BLOB summaries deliberately unchanged. **Carried limits:** `TIMESTAMP(n)` precision `0..9` and TIME's no-parameter rule stay binder-enforced (recorded in the module and pinned by an e2e that uses `TIME(3)` as its engine-rejected example).                                                                                                                                                                                                                                   |
| B3 registry lifecycle                | **DESIGN-CLOSED**             | — ([record](20261121-b3-registry-lifecycle-spec.md))                   | ADR 0047 verdict first: the proposal does not weaken it as scoped, and widening `closeTable` to replacement-path tables is named as the ADR's own supersession trigger. Verified transient leak (`useDiffSession.ts:129-133`) and a `profileComparison` + scoped `closeTable` contract. **Not implemented**; open decisions recorded (naming, retention window, cap, refusal copy).                                                                                                                                                                                                                                                                                                                                                                                                     |
| B4 CLI side-A hardcoding             | **CLOSED**                    | `82e9973` ([record](20261121-b4-cli-diff-side-a.md))                   | Base view is a required argument (no silent `DATASET_VIEW` default); both call sites explicit; renamed-side-A test proves the parameter is load-bearing and that an absent base view is a fixed value-free refusal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| B5 ordinal-scan blind spot           | **CLOSED**                    | `f020cde`, `acdb19d`                                                   | Same-scope `JOIN` (whole family), `HAVING`, `GROUP BY`, `QUALIFY` now flagged with `WHERE`; hostile-shape test per clause; no-false-positive nested case; generated plan SQL unchanged. The scan's line-formatting assumption is documented as its tested limitation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| B6 diff scale benchmark              | **MEASURED**                  | `4202a6c`, `b6cd245` ([record](20261121-measurement-rows-b6-c3-c2.md)) | 10k / 250k / 1M pairs: `diff` medians 0.60 / 0.95 / 1.87 s, peak RSS 145 / 369 / 794 MiB, TTFR 0.22–0.30 s (≈250–320 ms is process boot); counts matched an independent derivation. **No threshold set**; the host was contended (load 38–59 on 16 cores), so these are not two stable baselines.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| B7 SQL interrupt / second connection | **DESIGN-CLOSED**             | — ([record](20261121-b7-sql-interrupt-decision.md))                    | Cancel is UI-level abandonment today; the pinned duckdb-wasm 1.32.0 **does** expose `cancelSent`/`cancelPendingQuery` (API verified; mid-execution effect **not** verified). Recommendation: probe-gated cooperative cancel, falling back to honest copy. No implementation; likely ADR if selected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| C1 webview coverage collector/floor  | **unchanged**                 | —                                                                      | Still a maintainer config decision; D03b's real webview test subjects landed without changing coverage include/floors.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| C2 proof-bundle exclusion            | **MEASURED (decision input)** | `4202a6c`                                                              | TEST-PROOF code in `webview/dataset.js`: **44,655 B** by metafile and **−44,729 B** by a stubbed rebuild (0.17 % apart), 4.14 % raw / 3.72 % gzip of that script; gate verified at three layers. The judgement whether that buys a build seam is the maintainer's — recorded, not decided.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| C3 E02 bundle budgets                | **unchanged**                 | `4202a6c`                                                              | Second baseline recorded; `measure:bundle` is byte-identical across repeats; deltas vs the 2026-11-20 baseline attributed per commit. **Budgets still unset**, with the precise definition of a stable second baseline now recorded.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| C4 Node 22 product floor             | **unchanged (environment)**   | —                                                                      | This host has only Node 24.13.0 (nvm); the floor's minimum remains unexercised. Provision 22 or narrow the claim.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| D1–D10, E1                           | **unchanged**                 | —                                                                      | Decision-first rows, human actions and gated tracks are exactly as §1/§4 classify them. Nothing here decided a WF/RD policy, a release, a publication or a G2–G4 track.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### 8.2 Decisions taken by this batch (reverse here, not in five places)

- **D1 — rows selected.** A1, A2, A3, B1–B5 were implemented; B3/B7 produced their spec/decision
  records without implementation; B6/C2/C3 produced measurement records. C1/C4/D*/E1 were left
  untouched because they need a maintainer decision, a human action or a gate, not code.
- **D2 — `DISCLOSURE_REVISION` stays `1`.** The constant is recorded for **both** surfaces, and
  `CLI_DISCLOSURE_COPY` is unchanged (CLI parity is out of scope), so a bump would attribute
  revision-2 consent to a CLI still showing revision-1 text. The web wording replacement applies at
  revision 1; the web/CLI divergence is named in the changeset.
- **D3 — WF-O1 no-op identity treats a pure reordering as unchanged content.** E04 §3.1's reorder
  caveat is only satisfied if the check is order-insensitive for the unchanged re-apply case; pair
  multiplicity still counts, so a duplicate-column collapse dispatches. Order stays part of the list's
  identity everywhere else.
- **D4 — C02 parity took option (b), panel-local controls.** Option (a) (point at the filter bar) was
  rejected on evidence: the bar's `failure` state is set only by the bar's own apply, so a
  profile/validation failure leaves no bar control to point at.
- **D5 — B1 refuses duplicate mapping keys and unrepresentable text** rather than normalising them;
  both were previously silent or late-failing behaviours.
- **D6 — B6 sets no threshold**, C3 sets no budget, C2 makes no removal decision. Each row recorded
  the input the maintainer needs, not the outcome.

### 8.3 Batch gates (this tree, this run — not reusable)

`pnpm typecheck` 20/20 tasks · `pnpm lint` clean · `pnpm format:check` clean · full suite **295 files /
4582 tests** with coverage **90.26 / 85.07 / 92.18 / 91.96** (`--maxWorkers=4`, floor 83/76/80/84) ·
`pnpm build` 12/12 · `pnpm test:e2e` **288 passed, 1 skipped** (an axe pass included) · pinned VS Code
host `e2e: PASS` with CLI agreement · `pack:consumer-smoke` **PASS** · `docs:links:check`,
`adr:index:check`, `current-state:check`, `assurance-map:check`, `dependency-report --check` and
`measure:bundle` green. The dependency-use manifest was regenerated for the new files
(`--write`), which is a derived artefact, not a dependency change.

### 8.4 What this batch did not fix

- The `TIMESTAMP(n)`/TIME tighter-bound gap in the type validator (binder-enforced; B2 records it).
- Diff B-side registry accumulation (B3 is a spec; nothing is released), SQL true interrupt (B7 is a
  decision request), the TEST-PROOF production bytes (C2 measures only), and E02 budgets (C3 records a
  second baseline only).
- The known non-reproducible measurement rows: the CLI tarball (a `pnpm pack` one-off) and the
  install-size table (±56–400 B across installs).
- Everything in §4 (maintainer/human), §5's dispatch envelope discipline and §6's prompt still stand
  for the next row.
