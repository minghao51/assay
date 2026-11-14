# Post-R1 decision sheet — D2–D7 (presented, not chosen)

**Date:** 2026-11-14. **Status:** decision sheet only. It selects nothing, authorizes no runtime row, no
protocol/dependency change and no push. Every recommendation below is the author's, not an approved
default; the maintainer (and, for ADR-gated rows, the engine/protocol owner) decides.

**Authority order:** accepted ADRs → [EW-10 §8](20261113-ew10-first-wave-integration.md) dated selection →
[post-R1 pickup](20261114-post-r1-pickup.md) → the contracts ([EW-02D](20261113-ew02-scope-contract.md),
[EW-03D](20261113-ew03-csv-contract.md), [EW-04D](20261113-ew04-bulk-contract.md)) → this sheet.

**Rule zero:** the records cited here are evidence, not authority. Nothing in this sheet reopens R1, ADR
0048, the U4 measurements, or any RETAIN row. R13 (EW-05…08 and the other unselected rows) stays
unselected; no decision below implies it.

## 0. Own baseline (fresh, this session)

- **SHA:** `cf44f3b` (`docs: align the post-R1 state and add the next-agent pickup prompts`), working
  tree clean before and after this record.
- **Docs gates run here (documentation-only; no runtime claim):** prettier `--check` clean; docs links
  **158 files / 0 broken**; ADR index **48 records**; `git diff --check` clean.
- **Not run in this pass:** unit, coverage, build, browser, configured/restored telemetry. This sheet
  makes no runtime, performance or browser claim of its own; the U4 and R1 measurements are cited as
  records, not re-derived.
- Source facts below were re-read at `cf44f3b` (e.g. the schema `DESCRIBE` still composes over the base
  branch only at `packages/engine-duckdb/src/overlay-query.ts:845-857`, and the cast check is still the
  existence shape at `:919-1000`), but the contracts' full probe evidence was not re-executed.

## 1. Decision map

| Pickup ID | Decision(s) presented                                                              | Owner             | Unblocks / effect                                                                   |
| --------- | ---------------------------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------- |
| **D2**    | EW-02D: 3 exact sentences (its D1) + 2 pager/profile questions (its D2/D3)         | maintainer        | an **EW-02I** brief; 49 RETAIN rows need no code                                    |
| **D3**    | EW-03D D1–D15 (15 rows), incl. the **D12 ADR** route and **D15** version policy    | maintainer (+E)   | an **EW-03I** scope; D12 needs its own ADR before any protocol/option carrier       |
| **D4**    | EW-04D conditions (ii)–(vii) + the U4-driven D11 qualifier + an export cost budget | maintainer (+ADR) | an **EW-04I** brief; nothing may be briefed from the SQL shape alone                |
| **D5**    | Fund U5 (real composer/domain behaviour tests)                                     | maintainer        | closes EW-04D condition (vii); de-risks EW-04I before it starts                     |
| **D6**    | R2 `TIMESTAMP 'infinity'` ownership; R3 human usability evidence                   | maintainer        | one small web/grid row (R2); R3 stays a recorded limitation or a commissioned study |
| **D7**    | R8 real-engine N9/T9b fixture                                                      | maintainer        | only if the post-registration failure case must be asserted against a real engine   |

**Dependency order if everything is accepted:** D2 and D5 are independent of the rest; D3's D12 ADR can
start now (read-only draft); D4's D16/D17 probe informs (ii)/(iii) but does not replace the decision;
D6/R2 is independent of the EW track; D7 depends on nothing else.

## 2. D2 — EW-02D copy/scope (unblocks EW-02I)

### 2.1 The three proposed sentences (byte-exact; accept/decline each)

1. **SQL hint** — append to `p.sql-hint`:
   `Queries read the file as opened — staged grid edits and grid filters are not part of this view.`
2. **Validation intro** — append to `p.validation-intro`:
   `Validation runs on the whole edited dataset — grid filters and sorting are not applied.`
3. **Pipeline source binding** — render inside the existing `openDatasetAvailable` fragment, immediately
   after the `Use the open dataset` button:
   `Use the open dataset binds the opened file itself — staged grid edits and grid filters are not part of pipeline runs.`

All three are static, value-free, inside existing paragraphs/spans, add no state/prop/engine call, and
are proven render-only by EW-02D §5. The 49 RETAIN rows and the shell context bar are the contract and
change nothing.

### 2.2 The two open questions (EW-02D §8 D2/D3)

- **Pager disclosure.** Source proves SQL paging re-runs the last executed statement, so a later page can
  differ if the relation changed (`SqlPanel.tsx:6-13`). No current copy claims otherwise.
  - (a) **RETAIN** — no copy change (recommended in the contract).
  - (b) Add one sentence, e.g. `Paging re-runs the last executed query.` — a wording decision.
- **Profile/filter symmetry.** The Profile standing hint says "file as opened", which excludes grid
  filters semantically but does not name them; Export names them.
  - (a) **RETAIN** — strongest claim wins; naming filters again duplicates (recommended in the contract).
  - (b) Add a filter-symmetry sentence — one more wording decision.

### 2.3 Options, costs, evidence, recommendation

| Option                                                   | Cost                                                                                                                | Evidence / risk                                                                               | Recommendation                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Accept all three sentences verbatim                      | One small runtime row (EW-02I): 3 production files, 3–4 literal tests, 1 changeset, full gates + independent review | EW-02D §3/§5/§7; no new engine call; no collision with WFD-03/04/05/07, WF-O1/O2, SV-D04 (§6) | **Accept as written**                                     |
| Accept a subset / reword one                             | Same row, fewer surfaces; reworded strings must be re-pinned byte-exact                                             | A decline leaves that surface RETAIN (no code)                                                | Accept 1/2/3 independently                                |
| Decline all                                              | Zero code; EW-02I becomes unnecessary (49 RETAIN rows need nothing)                                                 | The three gaps remain silent; no false statement exists today                                 | Viable, but leaves the SQL/pipeline relation unstated     |
| Accept any pager-disclosure or symmetry sentence (2.2 b) | +1 sentence and +1 literal test each                                                                                | Wording is not derivable from source; both are wording decisions, not defects                 | **Retain** both unless product wants the extra disclosure |

**What acceptance authorizes:** an EW-02I brief only, with the accepted strings pasted into it. It does
not authorize a heading/copy sweep, a context-bar change, revision stamps, or filter-chip wording.

## 3. D3 — EW-03D ledger (15 rows; D10 now unblocked)

**Status change since the contract:** R1 closed and ADR 0048 is accepted, so **D10's classification
blocker is resolved** for EH-capable browsers (the engine's real first line reaches the surface; non-EH
browsers keep the opaque fallback). D10 still needs a decision on what the CSV surface _shows_, but it is
no longer blocked on masking.

### 3.1 The fifteen rows (alternatives → contract recommendation)

| ID  | Decision                     | Alternatives (abridged)                                                                     | Contract recommendation                                                                                         | Owner |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----- |
| D1  | Delimiter                    | auto only / auto + explicit `delim`/`sep` / free-text option names                          | auto + explicit `delim`/`sep`; echo sniffed value; refuse `delimiter`/`separator`                               | M     |
| D2  | Header                       | always sniffed / sniffed + toggle                                                           | first-class `header`, default = sniffed, disclosed                                                              | M     |
| D3  | Duplicate/empty column names | accept engine renames / refuse file / rename in UI                                          | accept engine renames + disclose the rename list before adoption                                                | M     |
| D4  | Types / all-text             | always auto / auto + per-column override / default all-text                                 | auto + per-column override, `all_varchar` as the lexeme-safe mode; validated types                              | M     |
| D5  | Dates                        | sniffed temporal + `dateformat` / always text                                               | sniffed temporal, expose and disclose `dateformat`; no locale/date-order inference                              | M     |
| D6  | Quoted empty vs NULL         | DuckDB default both NULL / `nullstr` / promise a distinction                                | (c) is impossible in this build; default (a), (b) as an explicit choice, say so in copy                         | M     |
| D7  | Sample disclosure            | none / show `sniff_csv` / new format                                                        | show `sniff_csv` (delimiter, header, types, date format, sample size, Prompt), local                            | M     |
| D8  | "Complete check" definition  | `count(*)` / per-column `try_cast` + lexeme invariants + row equality / sample-only         | (b) exactly §5.1; (a) is not proof; (c) is explicitly a sample                                                  | M     |
| D9  | Adoption identity            | new id / reuse source id + base anchor + `isSameEntry`                                      | reuse the captured source identity; no cross-session identity (ADR 0017)                                        | M     |
| D10 | Failure/refusal text         | show engine message / pre-validate + value-free generic / upstream fix                      | (b) pre-validate + generic failure with technical detail; never classify from glue text                         | E     |
| D11 | Cancellation/resource bounds | add engine cancel / token-guard discard + check budget + refusal                            | (b): no `Cancel`; budget the complete check and refuse over budget; late results dropped                        | E     |
| D12 | Registration/lifecycle       | registration-free preview / single-slot registering preview / per-preview view / reuse name | (a) is the target but **unproven**; (b) is the honest today-shaped fallback; **either route needs its own ADR** | E     |
| D13 | Row-skip / reject policy     | `ignore_errors` / `store_rejects` / refuse both and fail on any conversion error            | (c) refuse both, fail on any conversion error; disclose `strict_mode` default                                   | M     |
| D14 | Unsafe integers              | let sniff pick DOUBLE / force BIGINT or VARCHAR / disclose + choose                         | disclose + choose, with BIGINT/VARCHAR as the default for integer-looking columns                               | M     |
| D15 | Engine/CLI version policy    | assume parity / browser 1.4.3 is the only capability truth                                  | (b): re-prove every capability in-browser after any engine bump                                                 | E     |

### 3.2 Costs and evidence

- **Per-row cost:** a policy decision is docs-only. A runtime **EW-03I** is cross-package
  (`engine-duckdb` plus `apps/web` plus fixtures) and cannot start until the parse policy (D1–D6, D13,
  D14), the completeness definition (D8/D11) and the preview route (**D12 + its ADR**) are settled.
- **D12 is the long pole:** route (a) needs a new protocol/option carrier and an ADR; route (b) is the
  honest single-slot registering fallback shaped like today's code, still retention-unbounded per ADR 0047. The read-only D12 ADR draft (P3) can start now.
- **Evidence:** EW-03D §2.1 (allowlist/refusals), §5 (inference vs complete check), §6.1 (now updated),
  §6.2–6.3 (cancel/bounds), §7 (probe transcript). Probe facts are browser-1.4.3-specific; D15 is the
  rule that keeps them honest after a bump.

### 3.3 Recommendation (non-binding)

Accept the ledger **as a block** (it is internally consistent and each row has probe evidence), with two
explicit caveats: keep D12's ADR separate and do not let a CSV runtime row assume a per-table release
primitive (D17 is already fixed by ADR 0047); and record D15 as a standing rule in the EW-03I brief.
If the maintainer wants a smaller first slice, D1/D2/D3/D4/D6/D7/D8/D10/D13/D14 are the coherent
"quick preview + honest disclosure" subset; D5, D9, D11, D12, D15 can follow.

**What acceptance authorizes:** an EW-03I scope, not a runtime row until D12's ADR exists. No dependency,
protocol or telemetry change is implied.

## 4. D4 — EW-04D conditions (ii)–(vii), D11 qualifier and export budget

Condition (i) U4 is **measured**: no CASE-arm cliff near 500 on the shipped `eh` bundle (≈15 ms plan /
17 ms exec at m=500 for a 1k-row window); the export path is the cost centre (≈4.0 s at m=500 over 2 M
rows); multi-repair is cheap only as **stacked projection layers** (one-expression nesting: 2.4 MB SQL at
two repairs, OOM at three). That resolves (i) for the flat wrap with a cost caveat and a composition
qualifier.

### 4.1 The remaining conditions

| Condition | Item                                                          | Current status                     | Decision needed                                                     |
| --------- | ------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------- |
| (ii)      | **D16** schema `DESCRIBE` + cast-check composition            | Open; contract design only         | Composition shape (below) + conformance tests                       |
| (iii)     | **D17** compose-time literal rewrite for insert branches      | Open; contract design only         | Literal rewrite iff conformance tests pin TS trim/map ≡ SQL CASE    |
| (iv)      | **D15** exception-set cap                                     | Open; recommendation x ≤ 500       | Accept the cap + typed value-free refusal, or choose another bound  |
| (v)       | **D14** undo-by-refold as an ADR                              | Open; no ADR exists yet            | Proposed ADR before runtime; the property test is a row deliverable |
| (vi)      | **U1–U3** host paths (no-op refusal, stale preview, ordering) | Unverified; app-level behaviour    | Close inside EW-04I with named tests, or fund pre-row probes        |
| (vii)     | **U5** real composer/domain behaviour vs the P8 model         | Unverified; probe-only equivalence | Fund U5 (see D5) — the model is not the code                        |

### 4.2 D16 options (schema + cast check)

| Option                                                                                         | Cost / consequence                                                                                                                                    | Recommendation                                              |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| (a) **Wrapped DESCRIBE + restructured cast check** (outer projection over the effective union) | Restores the m + x + 1 bound uniformly; needs new composer work and type-preservation tests; the schema site currently describes the base branch only | **Recommended**, subject to the read-only composition probe |
| (b) **Unwrapped DESCRIBE + explicit type-preservation proof; per-arm cast check**              | Cheaper schema change, but the cast check's honest cost is O((1+e+i)·(m+1)) (session-bounded × mapping) and must be accepted explicitly               | Viable only if (a) proves too invasive                      |
| (c) Require a separate architecture row before either                                          | Adds a dependency and delays EW-04I                                                                                                                   | Not recommended; the contract already located the sites     |

### 4.3 D17 options (insert branches)

| Option                                              | Cost / consequence                                                                                                                 | Recommendation                                           |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| (a) **Compose-time literal rewrite** (0 added arms) | Cheapest; must be pinned by conformance tests: TS trim∘map on a literal ≡ SQL `CASE`, incl. NULL, surrogate guard, binary equality | **Recommended iff** the conformance tests are in the row |
| (b) Per-branch wrap (m × k arms)                    | Honest but multiplies arms by live-insert branches; hits the cap quickly                                                           | Only if (a) conformance cannot be pinned                 |
| (c) Defer insert-branch repair entirely             | Smaller row, but the op is then incomplete for inserted rows                                                                       | Not recommended                                          |

### 4.4 D15 (exception cap), D14 (ADR) and D11 qualifier

- **D15:** accept cap **x ≤ 500** base-branch exception arms with a typed value-free refusal aligned to
  the existing live-insert cap (`MAX_OVERLAY_LIVE_INSERT_BRANCHES`). Alternatives: uncapped (unbounded SQL)
  or refuse any exception (the common apply-at-tail case would fail). Cost: one refusal path + tests.
- **D14:** commission a **Proposed ADR** for "undo by refold" (the existing bulk-op inverse primitive is
  empty-inverse + note; the amendment makes undo a refold with a P1 property test). Alternatives: keep
  the empty-inverse+note semantics (then the repair op cannot undo correctly) or materialize inverses
  (rejected in the contract). ADR before runtime is mandatory.
- **D11 qualifier (U4):** amend the representation wording to name **stacked projection layers** for
  multi-repair prefixes and pin emitted-SQL linearity; the additive-arms claim is false for
  one-expression nesting. Recommendation: **accept the qualifier** (it is evidence-backed, not a
  preference). Leaving the old wording would let a runtime row implement the OOM shape.

### 4.5 Export / full-scan budget (new, U4-driven)

U4 measured ≈4.0 s at m=500 over 2 M rows on `eh`; full-scan cost is execution-bound and linear in
rows × arms, and the engine has no user-facing interrupt.

| Option                                                                                            | Cost / consequence                                                                     | Recommendation                                      |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------- |
| (a) Publish the measured envelope and **refuse pre-apply** when projected rows × pairs exceeds it | One projected-cost check + typed refusal + tests; keeps the contract's m ≤ 500 cap     | **Recommended**                                     |
| (b) Lower the **export-path** cap (e.g. m_export ≤ 100) while keeping m ≤ 500 for windows         | Simpler rule, smaller export; changes the contract's single cap into two               | Viable if product prefers a hard lower export bound |
| (c) Document the cost only, no refusal                                                            | No code, but a 2 M-row export at m=500 can freeze the UI for seconds with no interrupt | Not recommended                                     |

**What acceptance authorizes:** an EW-04I brief only after (ii)–(vii) are closed. The brief must name the
stacked composition, the export budget, and the D14 ADR; it may not be issued from the SQL shape alone.

## 5. D5 — fund U5 (real composer/domain tests)

U5 is verdict condition (vii): P8 proves the _semantic rule_ over 27,258 differential checks, not that
`packages/domain`'s fold and `packages/engine-duckdb`'s composer implement it.

| Option                                         | Cost                                                                                                 | Risk / evidence                                                          | Recommendation     |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------ |
| (a) **Standalone test-only row before EW-04I** | Moderate: property tests over the real fold + composer tests for the forward rule, refusals and caps | De-risks the runtime row; closes (vii) independently; no production code | **Recommended**    |
| (b) Fold U5 into EW-04I                        | Smaller total row count, but the runtime row's "done" then depends on tests that do not exist yet    | Reviewer cannot separate semantic failure from UI failure                | Viable, less clean |
| (c) Defer U5                                   | Zero cost, but the conditional verdict stays open and EW-04I cannot honestly claim equivalence       | The contract explicitly forbids claiming model-proof as code-proof       | Not recommended    |

U5's scope is already fenced in EW-04D §11: domain `column-repair` fold + step rule + wire parser; engine
composer wrap, D16/D17 pins, caps/refusals. The P8 corpus is the differential oracle; the row must use
real code, not a model.

## 6. D6 — R2 `TIMESTAMP 'infinity'` and R3 human evidence

### 6.1 R2 — `TIMESTAMP 'infinity'` throws inside Arrow's accessor

**Root cause (WF-01P, confirmed by source read):** `TIMESTAMP 'infinity'` arrives as
`Timestamp<MICROSECOND>`; `vector.get(i)` calls Arrow's `getTimestampMicrosecond` → `divideBigInts` and
throws `TypeError: 9223372036854775 is not safe to convert to a number.` **before** any formatter.
Because both `projectBatchToRows` and `projectOverlayPage` (`apps/web/src/grid/provider.ts:106`,
`:121`) call `get()` for every cell, **one infinite timestamp fails the whole window/page**, on both
base and overlay projections. A formatter guard cannot fix it.

| Option                                                                                                                              | Cost                                                                                                      | Risk / constraint                                                                                                   | Recommendation   |
| ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------- |
| (a) **Projection-boundary guard**: detect the non-finite/unsafe case and emit the raw value (same fallback class as `TIMESTAMP_NS`) | One small web/grid row + a minimal golden fixture (parquet with `TIMESTAMP 'infinity'`) + regression test | Must preserve WF-01 exact precision: `TIMESTAMP_NS` still always raw; no locale/format invention                    | **Recommended**  |
| (b) Formatter guard only                                                                                                            | Zero engine change, but cannot run — the throw precedes the formatter                                     | Does not fix anything; only useful as defense-in-depth after (a)                                                    | Not viable alone |
| (c) Record as a limitation                                                                                                          | Zero cost                                                                                                 | A single infinite value makes the grid page unusable; not honest for a data workbench unless the case is impossible | Not recommended  |

**Scope note:** nested/Record/SQL temporal parity stays **WF-O2**, not R2; the row should stay tight.

**Owner:** maintainer; the row touches `apps/web` (grid provider), not the engine protocol. It should be
serialized against other web-runtime writers.

### 6.2 R3 — human usability evidence (RD-T07)

| Option                                                 | Cost                                               | Evidence value                                                   | Recommendation                           |
| ------------------------------------------------------ | -------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------- |
| (a) **Commission a study** (moderated tasks + AT pass) | Human/calendar cost; protocol + analysis; external | The only path to a usability claim                               | Only if a launch gate requires the claim |
| (b) **Keep RD-T07 as a recorded limitation**           | Zero                                               | Honest; already accepted 2026-11-04; no usability claim anywhere | **Recommended**                          |
| (c) Bounded internal heuristic review                  | Low                                                | Not participant evidence; cannot lift the limitation             | Not sufficient to change RD-T07          |

## 7. D7 — R8 real-engine N9/T9b fixture

N9/T9b is "candidate `engine.open` succeeds, then schema/rowCount/`model.load`/preload fails". No committed
fixture opens but fails to materialize; RTL injection covers the logic, and R6 records that no protocol
op reads the registry, so retention accounting is not assertable at runtime even with a fixture.

| Option                                                                             | Cost                                                         | Evidence value / risk                                                                                  | Recommendation                    |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------- |
| (a) **No fixture; keep RTL injection + record the real-engine case as unasserted** | Zero                                                         | Honest; retention accounting stays unassertable (R6); the copy/lifecycle logic is already pinned       | **Recommended**                   |
| (b) Reserve a synthetic "opens but cannot materialize" golden fixture + e2e        | Fixture generator + checksums + e2e + version-stability work | Adds a real-engine failure leg, but the fixture is inherently brittle across DuckDB/extension versions | Only if the launch claim needs it |
| (c) Mock provider in e2e                                                           | Low, but duplicates the RTL evidence without a real engine   | No new evidence                                                                                        | Not useful                        |

## 8. Read-only probes that may start now (no new product decision)

These are permitted by the pickup; each is docs/probe-only, writes artifacts under `/tmp`, and changes no
source, protocol, dependency or fixture.

1. **D16/D17 composition probe** (P1) — exact composed SQL for the schema/cast-check sites under wrapped
   shapes and for insert branches under the literal rewrite; conformance cases the §11 tests would pin;
   costs at the U4 shape; recommendation per D16/D17. Informs §4.2/§4.3.
2. **R2 root-cause probe** (P2) — a reproducer, the exact Arrow accessor path, and 2–3 fix options that do
   not break WF-01 exact precision (projection boundary vs formatter defense; WF-O2 interaction). Informs §6.1.
3. **D12 ADR draft (Proposed)** (P3) — CSV options/preview-sniff/cancel, retention, browser-vs-CLI
   boundary; no implementation. Informs §3.2.

Each probe still needs a filled envelope (baseline SHA, paths, ports if any, no source change) and an
independent review of its record.

## 9. Dispatch order once decisions land

1. Read-only: D16/D17, R2, D12 ADR draft (may run in parallel; no web-runtime writer claimed).
2. **D5 U5** test-only row (if funded) — closes EW-04D (vii) before any repair runtime code.
3. **D2 EW-02I** — after accepted copy; three append-only sentences + literal tests; rebase on current main.
4. **D3 EW-03D → EW-03I** — after the ledger + D12 ADR; start from the contract's reservation.
5. **D4 EW-04D → EW-04I** — after (ii)–(vii), the D11 qualifier, the export budget and the D14 ADR.
6. **R2** web/grid row; **R3/R8** as decided. R13 stays unselected.

Every runtime row: filled envelope, branch/worktree, shifted ports, one web-runtime writer, full stock +
configured + restored gates, an independent reviewer (different model and thinking) with at least two
mutation drills and byte-identical restoration, and no push.

## 10. Carried risks and do-not list (unchanged)

- Do not reopen R1, ADR 0048 or the U4 measurements; do not re-decide R1's support floor or the
  visible-text policy.
- Keep visible: the web build carries both wasm pairs (+~33.4 MiB raw, one fetched per session);
  non-EH browsers keep the opaque fallback; no boot-failure retry; `row-insert` is uncovered; one extra
  engine round-trip per applied cell edit; the desktop package keeps the `mvp` fixture pins for the web
  e2e (not shipped).
- No decision here authorizes a dependency, lockfile, protocol, telemetry-semantic, release,
  publication or visibility change.

## 11. What this record is not

It is not an approval, a scope selection, a brief, or a runtime claim. It does not accept any EW-02D
string, any EW-03D row, any EW-04D condition or any R-row. Its own gates are documentation-only (§0);
the contracts' probe counts and the U4/R1 measurements remain evidence owned by their records.
