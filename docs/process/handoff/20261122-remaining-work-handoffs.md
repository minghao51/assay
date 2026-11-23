# Remaining work — implementation handoffs (2026-11-22)

**Date:** 2026-11-22. **Base:** `main` at `6b2c9fd` ("docs(handoff): record the follow-up review round
and the pushed run"). **Status:** dispatch-ready briefs; nothing here is selected or authorised by
being written down. Every brief was written against the tree at that base — **record a fresh SHA and
re-run the gates before editing**, and treat any `path:line` anchor as drift-prone.

This index is the entry point for the work left after the 2026-11-21 batches. It is deliberately
split by _who can execute it_:

| File                                                                 | Covers                                                                                                | IDs         |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------- |
| [H1 — UX runtime briefs](20261122-h1-ux-runtime-briefs.md)           | the UX rows that are decided-not-now; each needs a WFD selection and/or evidence before a runtime row | R-1 … R-7   |
| [H2 — technical carry briefs](20261122-h2-technical-carry-briefs.md) | the engineering carries left after B3/B7/C2/C3/U-1/type-boundary work                                 | R-8 … R-14  |
| [H3 — human runbooks](20261122-h3-human-runbooks.md)                 | publication, registry, legal, hosting, CI billing, the usability study                                | R-15 … R-22 |

**Authority order (unchanged):** accepted ADRs → the living [handoff](../handoff.md) current-state block
→ the [2026-11-21 successor queue](20261121-successor-queue.md) §8/§9 (what closed, and the carried
limits) → the [2026-11-21 decision round](20261121-decision-round.md) (what was decided) → dated design
records → these briefs.

## 0. Verification protocol without remote CI (read before anything else)

**Remote GitHub Actions is billing-blocked, not code-blocked.** Every push since 2026-11-21 produces
four jobs (`playwright e2e`, `configured telemetry disclosure (isolated)`, `typecheck / lint / test /
build`, `VS Code real extension host / offline harness`) that complete as `failure` in ~4 s with **no
steps and no logs**. That is an account payment/spending-limit refusal. It is **not** a code signal:
do not read it as a red test run, and do not retry a push to "fix" it.

**The local suite is the authority.** Run it on a clean tree before a push and again after each merge;
paste command tails into the closing record.

```bash
corepack pnpm install --frozen-lockfile
pnpm run doctor                                   # offline preflight (11 checks; a port held by
                                                  # another project is a warn, not a failure)
export DUCKDB=/tmp/duckdb PATH=/tmp:$PATH          # pinned CLI v1.5.5
pnpm format:check
NODE_OPTIONS=--max-old-space-size=4096 pnpm lint   # type-aware lint peaks ≈3 GB RSS on 16 GB
pnpm typecheck
pnpm test
pnpm exec tsc --build apps/cli/tsconfig.build.json
pnpm exec vitest run --coverage --testTimeout=20000 --maxWorkers=4   # floors 83/76/80/84
pnpm build
pnpm docs:links:check
pnpm adr:index:check
pnpm current-state:check                           # 6 facts, 107 assertions at this base
pnpm assurance-map:check
node scripts/dependency-report.mjs --check
pnpm measure:bundle
pnpm test:e2e                                      # 288 + 1 skip at this base
node apps/vscode/scripts/run-e2e.mjs                # pinned host 1.130.0, offline cache
node apps/cli/scripts/pack-consumer-smoke.mjs
```

**Recorded evidence at this base (own run — not reusable):** 295 files / **4586 tests**, coverage
**86.19 / 81.46 / 87.79 / 87.67** (statements / branches / functions / lines), e2e **288 + 1 skip**
(axe pass included), pinned host **PASS** with CLI agreement, pack smoke **PASS**, typecheck 20/20,
lint and format clean, docs 191 files / 0 broken links.

**Contention-sensitive tests** — a failure here at default workers is environmental; re-run solo before
declaring a failure, and never raise a ceiling:

- `apps/web/src/sql/SqlPanel.telemetry.test.tsx` (duration-bucket pin)
- `packages/pipeline/src/dcr-round-trip.test.ts` (fuzz timeout)
- `packages/validation/src/duckdb-agreement.test.ts` and `packages/validation/src/re2.test.ts` (CLI spawns)
- `packages/engine-duckdb` real-CLI agreement suites (spawns; `DUCKDB` must be set)
- the `cli-integration` project (spawn-heavy; already carries a 20 s budget — do not add to it)

**Push policy:** batch pushes, verify locally first. A push will show the four refused runs; record it
in the closing message rather than waiting or treating it as signal. The pinned VS Code host,
Playwright and the packed-consumer smoke run offline and substitute for the remote legs.

## 1. Item index (dependency-ordered)

Order is _suggested_, not enforced: pick the row whose dependency is actually satisfied.

| Order | ID       | Item                                                      | Kind               | Needs                                                          | Where |
| ----- | -------- | --------------------------------------------------------- | ------------------ | -------------------------------------------------------------- | ----- |
| 1     | **R-11** | E02 bundle budgets — stable second baseline               | measurement        | two consecutive stable rounds                                  | H2    |
| 2     | **R-10** | Remove TEST-PROOF code from the production webview bundle | decision + code    | the maintainer's stub-vs-split judgement                       | H2    |
| 3     | **R-12** | Validator tighter bounds (`TIMESTAMP(n)`, `TIME`)         | code               | none                                                           | H2    |
| 4     | **R-13** | Nested `UHUGEINT` leaves                                  | code               | none                                                           | H2    |
| 5     | **R-8**  | B3 diff staging registry lifecycle                        | code + ADR check   | none (ADR 0047 boundary is recorded)                           | H2    |
| 6     | **R-9**  | B7 SQL true interrupt                                     | **probe first**    | a probe of the pinned bundle; likely an ADR                    | H2    |
| 7     | **R-14** | U-1 bounded replacement wait                              | code               | **R-9** (a real interrupt must exist)                          | H2    |
| 8     | **R-5**  | WF-O2 temporal parity (nested / Record / SQL)             | code               | a type-propagation contract                                    | H1    |
| 9     | **R-2**  | WF-04 contextual next action                              | code               | WFD-03 selection                                               | H1    |
| 10    | **R-3**  | WF-07 visible row range                                   | code               | WFD-07 selection                                               | H1    |
| 11    | **R-1**  | WF-03 shell / panel presentation                          | code or copy-only  | WFD-05 selection                                               | H1    |
| 12    | **R-4**  | WF-08 / WF-09 layout study                                | study then code    | WFD-04 selection + ADR 0044 check                              | H1    |
| 13    | **R-6**  | uxv-6 / UX-D2 adjustable SQL sizing                       | decision           | evidence that it bites                                         | H1    |
| 14    | **R-7**  | Overlay-aware profile candidate                           | contract then code | a consistency contract decision                                | H1    |
| 15    | **R-20** | GitHub Actions billing restore                            | human              | the account owner                                              | H3    |
| 16    | **R-15** | Publication / registry policy + first release             | decision + human   | R-16, R-20 (R-17 runs in parallel, not a publish prerequisite) | H3    |
| 17    | **R-16** | npm `@assay` scope ownership                              | human              | account/2FA                                                    | H3    |
| 18    | **R-17** | Trademark / domain posture                                | human              | legal/procurement (independent of R-15)                        | H3    |
| 19    | **R-18** | Telemetry collector hosting + disclosure                  | human              | hosting + TLS                                                  | H3    |
| 20    | **R-19** | Demo dataset sourcing                                     | human              | licence-compatible source                                      | H3    |
| 21    | **R-21** | RD-T07 usability study                                    | human              | recruitment + two synthetic study fixtures                     | H3    |
| 22    | **R-22** | Re-widen the Node floor to 22 (conditional)               | code               | a real Node 22 consumer                                        | H3    |

## 2. Dispatch envelope (one item at a time)

```text
ITEM: <R-n> — <title>
BASE: <sha> (verify clean; record your own baseline)
CONTRACT: <the brief's record links + the accepted ADRs it names>
DECISIONS: <the selected option(s), or "none needed">
ALLOWED: <the brief's reserved paths>
FORBIDDEN: docs/** unless the item is docs; shared root configs; other packages; pnpm-lock; new deps
DONE-WHEN: <the brief's done-when, plus its named tests>
GATES: §0 targeted first, then the full suite, plus the item's own leg
EVIDENCE: pre-change probe/failure, post-change pass, one mutation drill, exact commands/exits
STOP: ADR conflict, unselected policy/UX, wire/persisted-format change, package-boundary crossing,
      impossible prerequisite, failing pre-existing gate, sensitive data, release/publish action
REVIEW: independent reviewer (different model), read-only, runs the gates and a mutation itself
```

Two working rules that are not negotiable: **an implementer never approves its own change**, and a
row closes only with merged commits, Conventional Commits, changesets where a package changed, the full
local suite green on the merged tree, an independent reviewer verdict, and the ledger
([successor queue](20261121-successor-queue.md) §8/§9 or a dated successor) updated in the same change.

## 3. Paste-ready prompt for the next thread

```text
You are continuing Assay maintenance from the 2026-11-22 remaining-work handoffs. The repository is
local; remote GitHub Actions is billing-blocked (four job-start failures per push are NOT code signal).

Read, in order: AGENTS.md; docs/process/handoff.md (current-state block);
docs/process/handoff/20261122-remaining-work-handoffs.md (this file, especially §0);
docs/process/handoff/20261121-successor-queue.md §8/§9;
docs/process/handoff/20261121-decision-round.md; then the selected item's brief (H1/H2/H3) and every
record it cites.

SELECTED_ITEM = <R-n>        # exactly one
DECISIONS = <the options chosen, if the brief asks for any>

If SELECTED_ITEM is empty: do not modify anything. Return the single decision or human action that
unblocks the next item, and a proposed envelope.

Reserve one item, use a scoped branch, and follow worker → independent reviewer → integration from
docs/process/handoff/operating-model.md. Record your own base SHA, run the §0 local suite, perform at
least one load-bearing mutation, and record the billing-blocked CI caveat instead of waiting for
Actions.

Never weaken an assertion, floor, cap, timeout or privacy rule; keep refactors and behaviour changes
separate; stop (BLOCKED, not CLOSED) for an ADR conflict, an unselected UX/policy, a wire or persisted
format change, a package-boundary crossing, an impossible prerequisite, or a publish/release action.
Report: item id, diagnosis, files/commits, gates with exits, reviewer verdict, unchanged invariants,
remaining limits.
```

## 4. What is _not_ in these briefs (deliberately)

- **Anything already closed**, including MVP M0–M6, PT-V slices 1–2, pipeline P1–P3, local DCR v1, the
  UX/a11y queues, telemetry implementation, the whole 2026-11-20 improvement batch, and the 2026-11-21
  successor batch (A1, A2, A3, B1–B5) plus its follow-up (C1, C4, the RD decisions). Do not re-dispatch
  or re-litigate them; the ledger says which commits closed what.
- **The gated G2–G4 tracks** (AI features, hosted workspace, enterprise) — no work starts before the
  adoption/auth evidence in the roadmap's gates.
- **Usability claims.** RD-T07 is an accepted limitation (D-02 A): no document, release note or piece
  of copy may say "validated", "intuitive", "easier" or anything equivalent until R-21 runs.
