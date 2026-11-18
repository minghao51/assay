# Post-EW-03I-a pickup — remaining runtime rows and paste-ready prompts

**Date:** 2026-11-18. **Status:** the post-R1 runtime wave has closed **EW-02I**, **R2**, **U5**
(EW-04D condition vii) and **EW-03I-a**; **ADR 0049** and **ADR 0050** are Accepted. **No product-policy
decision is pending.** What remains is two web-runtime rows, one test-budget follow-up, and one optional
Proposed ADR. This record is the cold-pickup index for the next agent; it does not select any
unrequested row.

**Authority order:** accepted ADRs → [EW-10 §8](20261113-ew10-first-wave-integration.md) dated selection →
the [post-R1 acceptance record](20261114-post-r1-decisions-accepted.md) → this record → the contracts
([EW-02D](20261113-ew02-scope-contract.md), [EW-03D](20261113-ew03-csv-contract.md),
[EW-04D](20261113-ew04-bulk-contract.md)) and the probe records → proposal/research/history.

**Rule zero:** every record here is evidence, not authority. Record your own clean SHA and run fresh
gates; never reuse the counts below as a current pass claim.

## 1. Verified state (2026-11-18, own observations at merge time)

`main` was clean at `076705c` when this record was written. Docs gates: **165 files / 0 broken links**,
**ADR 50 (42 accepted, 8 proposed)**, prettier and `git diff --check` clean.

| Row / decision                 | Merge / status                               | Evidence                                                                                                                                                                                                                                                 |
| ------------------------------ | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 (ADR 0048)                  | CLOSED earlier                               | `837b638` (R1-C), `b0b78bc` (R1-A), `5426979` (R1-B); [R1 record](20261114-r1-masked-engine-errors.md)                                                                                                                                                   |
| **EW-02I** (D2)                | **CLOSED** `fd5a92a`                         | three accepted EW-02D sentences + literal tests; gpt-6-luna xhigh approve with two mutation drills; [acceptance record](20261114-post-r1-decisions-accepted.md)                                                                                          |
| **R2** (D6)                    | **CLOSED** `0f77e38` + `a17f3a3`             | projection-boundary guard for ±int64 timestamp sentinels; validity-first (NULL stays NULL); delivered negative sentinel `-9223372036854775807`; [probe](20261114-r2-infinity-probe.md)                                                                   |
| **U5 / EW-04D (vii)**          | **CLOSED** `94128b2` + `120af28` + `6688f71` | `column-repair` op + forward fold/masking, ADR 0050 undo-by-refold, stacked repair layers, D17 literal rewrite, D16 wrapped DESCRIBE + split-form cast check, caps, projected-rows export budget; [D16/D17 probe](20261114-d16-d17-composition-probe.md) |
| **EW-03I-a** (D3, engine half) | **CLOSED** `ae0f6cf` + `a6059c6` + `4d56036` | `csv-options` closed vocabulary, `engine/csv-preview` + options on `engine/open`, single-slot `PreviewRegistry`, 100k inference budget, strict response domains, six golden CSV fixtures; [acquisition probe](20261116-csv-acquisition-probe.md)         |
| ADR 0049                       | **Accepted 2026-11-16**                      | resolving the acquisition/retention route in its "Acceptance resolutions"                                                                                                                                                                                |
| ADR 0050                       | **Accepted 2026-11-16**                      | undo-by-refold; resolutions + the `maskedRows` boundary note                                                                                                                                                                                             |

Merged gate numbers (recorded, not reusable): EW-02I 246/3664, coverage 89.34/84.05/91.66/91.00,
browser 265+1; R2 246/3672, 89.33/84.05/91.67/90.99, browser 268+1; U5 248/3737,
89.50/84.20/91.88/91.12, browser 268+1; EW-03I-a 249/3814, 89.54/84.36/91.83/91.17, browser 268+1.
Each merged run also passed configured telemetry **7 passed / zero delivered** and restored stock
endpoint-free.

**Known flake / budget residual:** the U5 seeded-history test sits near its 20 s coverage budget; the
first merged coverage run for EW-03I-a had one unreproduced failure at the suite's 45 s mark, and two
consecutive full coverage reruns were green. See TB-1 below — do not weaken a threshold to hide it.

## 2. Remaining queue (no policy gate unless marked)

| #            | Row                                                                                                        | Gate                                                                          | Notes                                                                                                |
| ------------ | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **EW-03I-b** | Web CSV preview panel/flow (non-adopting preview, options, sniff disclosure, bounded sample, adopt/cancel) | **none** — ADR 0049 accepted, EW-03I-a merged                                 | **web-runtime writer**; uses `csvPreview()` + `open(options)`; no engine/protocol changes            |
| **EW-04I**   | Web bulk-repair plan capture/preview/publication + **U1–U3** host paths                                    | **none** — U5 merged, D16/D17 pinned, D14 accepted, export budget implemented | **web-runtime writer**; serialized after EW-03I-b; no engine/domain changes unless a real gap (stop) |
| **TB-1**     | Test-budget follow-up for the seeded-history test                                                          | none (test-only)                                                              | may run alongside EW-03I-b in a separate worktree (disjoint files); three green coverage runs        |
| **ADR 0051** | Optional Proposed ADR: repair composition shape (stacked layers, linear size, set-membership)              | maintainer request                                                            | **optional**; D11 qualifier + U4/D16/D17 already cover EW-04I; docs-only                             |
| R3 / R8      | Human study / real-engine N9-T9b fixture                                                                   | recorded limitations                                                          | no action unless the maintainer re-decides                                                           |
| R13          | EW-05…08, WF-03/04/07/08/09, WF-O1/O2, WFD-03/04/05/07, D-06/D-11, SQL sizing, overlay profiles            | unselected                                                                    | **do not start**; no implicit selection                                                              |

**One web-runtime writer at a time.** EW-03I-b and EW-04I both touch `apps/web`; TB-1 is test-only and
may run in parallel with a separate worktree. The optional ADR 0051 is docs-only and may run alongside.

## 3. Dispatch order

1. **EW-03I-b** (web writer) — the CSV preview UI.
2. **TB-1** (test-only) — can start alongside EW-03I-b; do not touch web source.
3. **EW-04I** (web writer) — after EW-03I-b merges/closes; closes (vi) U1–U3.
4. **ADR 0051** — only if requested.

Every runtime row: filled envelope, branch/worktree, shifted ports, one web writer, full stock +
configured + restored gates, an independent reviewer (different model **and** thinking) with mutation
controls and byte-identical restoration, and **never push**.

## 4. Paste-ready prompts

### P0 — cold pickup (paste to the next orchestrator)

```text
Pick up docs/process/handoff/20261118-post-ew03ia-pickup.md (the post-EW-03I-a state, remaining queue
and dispatch order). Read AGENTS.md, docs/process/handoff.md §2/§6, the operating model, then ADR 0048,
ADR 0049, ADR 0050, the post-R1 acceptance record, the three probe records (R2 infinity, D16/D17
composition, CSV acquisition), EW-10 §8 and the three EW contracts before claiming anything. These
records are evidence, not authority: record your own clean SHA and run fresh gates; do not reuse their
counts.

Closed and not to be reopened: R1/ADR 0048, EW-02I, R2, U5 (EW-04D condition vii), EW-03I-a, and the
accepted ADR 0049/0050 resolutions. No product-policy decision is pending. The remaining queue is
EW-03I-b (web CSV preview), EW-04I (bulk-repair web + U1–U3), the TB-1 test-budget follow-up, and the
optional ADR 0051. R3/R8 stay recorded limitations; R13 stays unselected.

Start with EW-03I-b (one web-runtime writer), then TB-1 if useful, then EW-04I. For every runtime row:
fill a dispatch envelope, reserve a branch/worktree and free ports, keep one web-runtime writer, run
full stock + configured + restored gates on shifted ports, require an independent reviewer (different
model and thinking) with mutation controls, and stop rather than choose unresolved policy. Never push.
```

### P1 — EW-03I-b worker brief (web CSV preview; paste after the orchestrator's envelope)

```text
Row: EW-03I-b — web CSV preview panel/flow (non-adopting review, then adoption).

Authority: ADR 0049 (Accepted 2026-11-16) and its acceptance resolutions; the CSV acquisition probe
record; EW-03D §3 (quick-open vs advanced flow), §5 (inference vs complete check), §6 (failures/cancel/
bounds), §8 (D1–D15); EW-02D's RETAIN discipline and copy rules; ADR 0044 (two-pane shell); the merged
engine API in packages/engine-duckdb (csvPreview(), open(source, options)).

Envelope: branch/worktree from the current clean main; shifted ports; one web-runtime writer; allowed
paths apps/web/src/csv/** plus the named App/session wiring and tests; one @assay/web changeset;
forbidden: engine/protocol/domain/dependency/lockfile/docs changes, telemetry, any new copy sweep.

Done-when:
1. Quick open stays the default and byte-identical; the advanced review is an explicit path from the
   picker/drop for CSV.
2. The preview is non-adopting: options (delimiter/header/types or all_varchar/sample_size) compose
   through the engine's typed vocabulary; the effective options and the sniff disclosure (delimiter,
   quote, escape, newline, comment, skip, header, per-column types, dateformat, Prompt as display text)
   are shown; a bounded sample renders read-only with its cap stated.
3. Honest copy, literal-pinned: a sample is never "validated/checked/verified"; a failure beyond the
   sample is normal; duplicate/empty header renames are disclosed before adoption; quoted-empty/NULL
   defaults are stated; unsafe integers are disclosed; no locale inference, no silent row-skip.
4. Adopt = a fresh open carrying the reviewed options (exactly once); cancel/abandon releases the
   preview slot and drops late results; no partial state, no engine Cancel claim.
5. Failures use the honest engine first line on EH-capable browsers and value-free refusals otherwise;
   never classify from glue text. No dataset values/filenames in logs or telemetry.
6. Tests: RTL + a real-engine e2e; literal copy pins; the option matrix; cancel/abandon and late-result
   dropping; a catalog-neutrality assertion; no new telemetry.

Gates: format, lint, forced typecheck (0 cached), unit, coverage floors, forced build (0 cached), docs
links, ADR index, full browser suite, configured + restored telemetry legs; independent reviewer with
at least two mutation drills (e.g. remove the sample-not-validation wording pin, adopt without the
reviewed options). Stop if the merged engine API is insufficient (that is a new engine row) or if copy
policy is unresolved. Never push.
```

### P2 — EW-04I worker brief (web bulk repair + U1–U3; paste after EW-03I-b closes)

```text
Row: EW-04I — web plan capture/preview/publication for the column-repair op, closing EW-04D condition
(vi) U1–U3.

Authority: EW-04D §3 (preview/counts/invalidation), §5 (publication/rollback), §6 (undo), §7 (races),
§11; the D16/D17 composition probe; ADR 0050 (Accepted 2026-11-16); the merged U5 domain+engine slice;
the post-R1 acceptance record (D4).

Envelope: branch/worktree from the current clean main; shifted ports; one web-runtime writer; allowed
paths apps/web/src/edit/repair/** plus the named editing-session/App wiring and tests; one @assay/web
changeset; forbidden: changing packages/domain or packages/engine-duckdb (the composer and caps are
merged — if a real gap is found, stop and report a new row), protocol/dependency/lockfile/docs edits,
telemetry.

Done-when:
1. Plan capture: column choice, the explicit trim code-point set (never String.prototype.trim()),
   mapping pairs; the domain's typed value-free refusals (non-text/ENUM/CHAR column, >500 pairs, >16
   trim code points, dead keys, one trim spec per chain, identity) surface without an engine call.
2. Preview: complete scanned/affected/unaffected counts plus ≤10 before/after examples, revision-tagged
   and refused stale at render; no matching-row arrays in React; no silent top-N (cap stated); the
   export-budget refusal is surfaced pre-apply when projected rows × pairs exceed the published envelope.
3. Publish: exactly one history entry / one undo step through the existing commitWithRollback; undo is
   exact refold (ADR 0050); U1 (zero-affected refusal, no-op append), U2 (stale preview refused
   end-to-end), U3 (out-of-order results) are pinned by tests.
4. No per-cell JS loop, no full-row materialization, no filter-scope change (whole-effective only), no
   engine interrupt claim, no new telemetry.
5. Tests: RTL + real-engine e2e; U1–U3; caps/refusals; undo/redo and dirty semantics; count/example
   literals.

Gates: full stock + configured + restored; independent reviewer with at least two mutations (e.g.
apply without a fresh preview, append a zero-affected plan, remove the budget refusal). Stop on any
engine/domain gap or unresolved copy policy. Never push.
```

### P3 — TB-1 test-budget follow-up (test-only; can run alongside EW-03I-b)

```text
Row: TB-1 — remove the seeded-history test's timeout flake without weakening coverage.

Evidence: the U5 seeded-history test in packages/engine-duckdb/src/overlay-repair-query.test.ts runs
near the coverage leg's 20 s budget (≈17.5 s alone; the first merged EW-03I-a coverage run had one
unreproduced failure at the suite's 45 s mark; two full reruns were green). The gd-1 precedent allows a
documented test-budget fix.

Task: identify the failing test by rerunning the coverage leg with a verbose reporter; then make the
minimal test-only fix (a documented per-file/test budget, or an equivalent-coverage corpus change, or a
dedicated project budget like gd-1). Allowed: test files and vitest config only. Forbidden: source
changes, threshold weakening, corpus reduction without proving equivalent coverage.

Done-when: three consecutive full `pnpm test:coverage` runs green; the seeded-history assertions and
coverage floors unchanged; the fix documented in the record/changeset (test-only; no package change if
only config/tests). Reviewer re-runs the three coverage legs. Never push.
```

### P4 — ADR 0051 (optional, Proposed; only if requested)

```text
Row: ADR 0051 — Proposed record for the repair composition shape (stacked projection layers, linear
emitted size, set-membership at predicate sites). Docs-only.

Authority: the D16/D17 composition probe §9 candidate, U4, EW-04D D11, the ADR 0049/0050 acceptance
records. It must not re-decide D16/D17 or the semantics; it records the durable composition rule and its
measured bounds. No implementation, no source change. Docs gates only. Only start if the maintainer asks;
EW-04I does not depend on it.
```

### P5 — reviewer brief skeleton (every runtime row)

```text
Read the worker brief, the worker report, the contract/ADR and operating model §7.3. Verify by running
commands, not by reading diffs. Re-run every gate yourself on the assigned ports; compare with the
worker's claims, do not trust them. Drill at least two mutations (one per load-bearing claim), restore
byte-identically (sha256sum) and rebuild before browser re-checks. Check scope (allowed paths only), no
protocol/dependency drift, no dataset values/filenames in logs/telemetry, and that the record's evidence
is pasted, not asserted. End with exactly `VERDICT: approve` or `VERDICT: request-changes` plus
numbered, testable items. Never implement a fix yourself.
```

### P6 — stop / escalate (paste into every brief)

```text
Stop and report instead of choosing: unresolved copy or product policy; a real engine/domain gap; a
gate failing outside the row; a needed dependency/protocol change without its own accepted ADR; a second
web-runtime writer; any push/release/publication/visibility request. Leave the tree clean and commit
nothing partial.
```

## 5. Do-not list and open risks

- Do not reopen R1, ADR 0048, EW-02I, R2, U5, EW-03I-a, the U4 measurements, or the accepted ADR
  0049/0050 resolutions. Do not re-decide the EW-02D copy, the EW-03D ledger, or the EW-04D conditions.
- Keep visible: the web build carries both wasm pairs (+~33.4 MiB raw, one fetched per session);
  non-EH browsers keep the opaque fallback; no boot-failure retry; `row-insert` is uncovered; one extra
  engine round-trip per applied cell edit; the desktop package keeps the `mvp` fixture pins for the web
  e2e (not shipped).
- Carry-risks: the 100k CSV inference budget bounds **rows**, not bytes/heap/elapsed time; the
  seeded-history test is near its coverage budget (TB-1); the `packages/testing` conformance mirror is
  compile-forced across the workspace; the repair errors are exported from the engine barrel; the
  `no-unknown-returns`/`no-sql-in-code` lens findings are deliberate-contract false positives (eslint/tsc
  are the binding gates).
- No push, release, publication, visibility, telemetry-semantic, dependency or protocol change follows
  from this record.
