# EW-04D — deterministic scalar-text repair: bounded atomic representation contract

**Status: DESIGN ONLY.** This document is a technical design with bounded disposable probes.
It implements nothing, approves nothing, and removes no gate. Every trim/mapping/NULL/collision/
no-op choice below is a **RECOMMENDATION AWAITING DECISION** — decision owner: the **maintainer**
(per handoff §1 authority order; this agent cannot decide or approve its own output). No runtime row
is authorized by this delivery.

> **Review round 1 (2026-11-13, independent review `openai-codex/gpt-6-luna` @ xhigh):** four
> corrections applied — per-branch bound retracted in favour of an emitted-once outer wrap;
> permutation claim retracted for chronological semantics; filter contradiction resolved
> (whole-effective only); no-op/stale/out-of-order evidence marked unverified.
>
> **Review round 2 (same reviewer, xhigh): three corrections applied:**
>
> 1. **(#1, site analysis)** The claim that all four emission sites are covered by existing
>    outer-projection structure was **false**: only the window (`overlay-query.ts:1013`) and
>    export (`:1106`) project over `composeSourceSql`'s union. The schema `DESCRIBE` composes over
>    the **base branch only** (`:854–857`), and the cast check is an existence shape
>    `SELECT 1 … UNION ALL SELECT 1 … LIMIT 1` (`:955–965`) with **no** outer projection. Schema
>    and cast-check therefore need **new composition work** — now decision **D16** and verdict
>    condition (iv). The bound claim is scoped to the sites where it is actually established.
> 2. **(#2, chronological equivalence)** The final-value CASE formulation was **falsified**
>    (a later `cell-set` writing the mapping-source value would be wrongly re-mapped). Fixed via
>    option (a): exceptions **derived from prefix folding** — per repair op at position p, a row is
>    excepted iff it is **not live at p** or has a **suffix overlay value-op** (`cell-set`/
>    `cell-revert` on the repair column) after p; repairs compose in **reverse order** starting
>    from the cursor underlying value u. **Equivalence proven by replay-model probe P8** (2 000
>    seeded randomized histories over insert/delete/restore/revert/set/multi-repair: 7 590 cell
>    checks, 0 failures; falsifying case explicit; naive formulation shown falsified). Probe P7
>    demonstrates the emitted-SQL shape. Insert branches apply the repair as a **compose-time
>    literal rewrite** (0 added arms) — pinned by new decision **D17**.
> 3. **(#3, P3 correction)** A restored row shows its **pre-repair effective value** — overlay
>    cell edits from before deletion remain (`row-restore` only removes the tombstone,
>    `overlay.ts:482–527`) — not "its base value". P1/P2 audited: P1 restated without value
>    claims; P2 now includes the later-write-wins-over-mapping case.
>
> New discovered nuance (from P8's failures before the fix): a no-match repair still applies its
> **trim** to live-at-p values (trim∘map is one function; passthrough = trimmed value). §1 wording
> corrected.
>
> **Review round 3 (same reviewer, xhigh): counterexample to the round-2 composition rule —
> corrected:**
>
> 1. **(#1, critical)** Reverse-prefix repair composition is **wrong for multiple repairs**:
>    `old→middle` then `middle→final` over `'old'` gives `final` chronologically but `middle`
>    reversed. **Rule replaced: FORWARD position-order composition** of guarded repairs over the
>    cursor underlying value (§6.2, with the masking/induction argument). Probe P8 rev 2 extends
>    the differential replay: non-commuting mapping pool, forced multi-repair cases, intervening
>    sets/inserts/reverts, plus the explicit counterexample — **forward: 27 084 cell checks,
>    0 failures; reverse control: 888 failures (823 multi-repair cases)** — the old rule is
>    empirically falsified, the new rule verified. Equivalence claim narrowed: "equivalent by an
>    induction argument under absolute-overwrite semantics and differentially verified over P8
>    rev 2"; real-code equivalence stays **U5**, now added to the return-gate conditions.
> 2. **(#3, warning)** Return-gate conditions were incomplete: **U5 added as condition (vii)**;
>    round-2 note's "D16 = verdict condition (iv)" mislabel fixed — D16 is condition **(ii)**.

> **Review round 4 (same reviewer, xhigh): three findings on the proof's premises and the
> summaries — corrected:**
>
> 1. **(#1, critical)** The premise "every `cell-set`/`cell-revert` in the log was applied" is
>    **false**: conflicts are refused, but **no-ops are appended** (`history.ts:34–39`,
>    `:101–115`; `overlay.ts:308–310`, `:342–343`). Rule restated with the true premise: **only
>    APPLIED value-ops mask a repair; logged no-ops never mask** — a no-op set between two repairs
>    changes no value, so the later repair still applies to the earlier repair's output. Guards
>    read the history outcome (`outcome.status === 'applied'`). P8 rev 3 models outcomes
>    domain-faithfully (edit-map no-op detection) and generates no-op cases; a new **no-op-blind
>    control** (the false premise) is empirically falsified (499 failures).
> 2. **(#2, critical)** The round-3 induction step "u equals the value at p_k for every repair
>    with no later value-op" is **false** (u = `'old'` but the value at p₂ is `'middle'` in the
>    document's own example). Induction **corrected**: u-equality holds only for the **earliest
>    surviving** repair; per-repair predicates are evaluated on the effective value **entering**
>    that repair (possibly already transformed by earlier survivors) but are value-independent
>    metadata, so the composer can evaluate them without reading values.
> 3. **(#3, warning + summaries)** Return-gate summary said "by construction" and "(i)–(vi)" —
>    both fixed to match §6.2 exactly and include **U5 as condition (vii)** in both summaries;
>    P8 scope limits (single-column, base-row-only reverts, model-not-code) stated wherever the
>    evidence is described.

> **Review round 5 (same reviewer, xhigh): one critical PROBE-corpus defect — corrected (the
> rule/premise/induction confirmed correct, not in dispute):**
>
> 1. The round-4 generator could draw value-op targets that were **dead at emission** (its
>    `liveBase` derived from unchanged `rows0`; `liveIns` included every inserted id) and the walk
>    applied them, while the real domain conflicts them (`overlay.ts:303–304, 337–343, 673–676`)
>    and `appendOp` refuses to log them (`history.ts:101–103`). Fixed via **option (a)**: the
>    generator mirrors liveness as it emits (set/revert/del → live rows, restore → dead rows), so
>    conflict-class ops are excluded **by construction**, and `walk` asserts **zero dead-target
>    value-op attempts** (the probe FAILs otherwise; observed 0). **Corrected corpus: forward
>    rule 27 258 live-cell checks, 0 failures** (8 006 cases; 2 513 multi-repair; 2 630 with
>    no-ops+repairs); controls: reverse 893, no-op-blind 530, naive 2 939. Scope limits unchanged.
> 2. Text fixes: duplicated "Counterexample resolved" label removed; "U5.beyond" run-together
>    fixed; §6.2/§9 counts refreshed to the corrected corpus (earlier round notes keep their
>    historical numbers as a log).

- **Baseline:** `c841fe4332a980ccd6a926b4e7520104068af70a` (main), tree clean at start and end
  (`git status --short` → 0 lines; 14-file sha256 manifest verified unchanged after all probes —
  §9.5). Read-only access to `/home/howt/work/dataworkbench`. Artifacts written only under
  `/tmp/assay-ew/`. **Baseline note (round 4):** HEAD advanced docs-only during this design
  (`b220e3e` EW-02D integration, then `56c3695` EW-03D integration — orchestrator flows, no
  source/test/config/fixture changes); all reads, anchors and probes were performed against
  `c841fe4`, whose cited files remain byte-identical at `56c3695` (§9.5 manifest).
- **Probes:** native DuckDB CLI `v1.5.5 (Variegata) d8cdaa33fd` at `/tmp/duckdb` (repo-pinned CLI)
  - Node `v24.13.0` for the dependency-free replay model. Browser engine **not re-run**: shipped
    bundle `@duckdb/duckdb-wasm@1.32.0`; wasm planner bounds cited from `overlay-query.ts:76–88` are
    **UNION-branch measurements, a different node class** — CASE-arm cost unverified (§9.1 U4). No
    installs, no network, no collector, telemetry env unset, synthetic `/tmp` data only (≤1 000-row
    temp tables; probe8 ≤2 000 seeded cases), outputs ≤7 rows/query.
- **Authority:** ADRs 0003/0011/0012/0025/0029/0030/0047 → 2026-11-13 selection → spec §2/§6 →
  handoff §1–§4.4. Anchors at `c841fe4`. Out of scope unchanged: regex, dedupe, fuzzy match,
  formulas, scripting, range paste, multi-column, general transforms, engine interrupt.

**Return-gate verdict (conditional):** a bounded atomic representation is established in
representation terms — alternative (a), a compact relational repair op composed as an
**emitted-once conditional wrap** whose semantics are **equivalent to chronological prefix
folding by a corrected induction argument and differential verification (§6.2; P8 rev 4) —
real-code equivalence remains U5** — **CONDITIONAL on all of**: (i) wasm planner cost at
the recommended arm cap (U4 — unverified; may force a lower m-cap); (ii) **D16** — schema DESCRIBE
and cast-check have no outer projection over the effective union today and need new composition
work (or an unwrapped-DESCRIBE decision with a type-preservation proof) before those surfaces can
see a repair; (iii) **D17** — compose-time literal rewrite for insert branches (TypeScript
trim/map ≡ SQL CASE) must be pinned by conformance tests; (iv) **D15** — exception-set cap; (v)
**D14** — the undo-by-refold domain amendment as an approved ADR; (vi) host-path verification
(U1–U3); (vii) **U5** — real domain/composer behaviour (the P8 model proves the semantic rule,
not the code; the §11 domain/composer tests must pin the implementation). Alternative (b) remains rejected as primary (§4.3). No architecture split is required;
no runtime row follows until (i)–(vii) are resolved.

---

## 1. Exact operation examples

One scalar-text column, one authored plan: a **mapping** (exact, simultaneous, whole-value) and a
**separately specified edge trim** (explicit closed code-point set, edge-only). The repair is the
composed function **trim∘map**: even a non-matching value's passthrough is its **trimmed** value
(probe P8 nuance). Authoritative examples (synthetic; probes §9):

| effective value at apply                                   | mapped result                       | note                                                               |
| ---------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------ |
| `' alpha '`                                                | `'ALPHA'`                           | trim, then map key (P5a)                                           |
| `'beta'`                                                   | `'beta'`                            | non-matching, no ws: unchanged (context only)                      |
| `'gamma'`                                                  | `'GAMMA'`                           | exact whole-value map key                                          |
| `'  alpha  x '`                                            | `'alpha  x'`                        | non-matching passthrough = **trimmed** value; interior kept (P4-2) |
| `'x\r\n'`                                                  | `'x'`                               | CRLF edge pair removed (P4-3)                                      |
| `'\u00A0x\u00A0'` (NBSP)                                   | unchanged                           | NBSP not in recommended default set (P4-4)                         |
| `NULL`                                                     | `NULL`                              | NULL never matches, never produced by trim (B1/B3)                 |
| `''`                                                       | `''` unless `''` is an explicit key | empty is data, distinct from NULL (B2/B4)                          |
| row set to `'old'` **after** the repair, mapping `old→new` | `'old'`                             | later absolute write wins — the falsifying case, probe P7/P8       |

Recommended default trim set (D1): exactly `U+0020, U+0009, U+000A, U+000D`, both edges; `ELSE`
passthrough is mandatory (probe D1: `CASE` without `ELSE` yields NULL).

**Exact emitted shape (single repair entry; base branch, one column)** — the repair wraps the
**underlying cursor value** u (the existing fold: edit arms over base), with per-row exception
arms derived from prefix folding (§6.2):

```sql
CASE
  WHEN <ord> = 5 THEN <u_5>            -- exception arms (x): per-row underlying value, untransformed —
  WHEN <ord> = 2 THEN <u_2>            --   suffix value-ops; not-live-at-p rows restored later
  ELSE CASE trim( CASE <ord> = 7 THEN <u_7_persistent> ELSE CAST(<base col> AS <effectiveType>) END
             , ' ' || chr(9) || chr(10) || chr(13))
       WHEN 'alpha' THEN CAST('ALPHA' AS <effectiveType>)        -- m pair arms, ONCE
       WHEN 'gamma' THEN CAST('GAMMA' AS <effectiveType>)
       ELSE trim(<same inner expr>, <same set>)                  -- 1 ELSE
  END
END
```

Live insert branches: values are engine literals, so the repair is applied **at compose time** in
TypeScript (`r_literal(v)` or exception) — **0 added arms** (conformance condition (iii)/D17).
Literals via `cellLiteralSql` escaping + surrogate guard (`overlay-query.ts:340–424`); types via
`assertValidEffectiveTypes` (`:577–615`). NULL cells are data (`edit-ops.ts:20–31`).

## 2. Captured identity/revision/schema and predicate

A plan captures (host-side, plain data — no engine state):

1. **Identity:** `base.baseAnchor` + `base.overlayAnchor` (`overlay.ts:97–104`); a new file
   version or session anchors → **stale** (survival boundary, `row-identity.ts:30–50`).
2. **History position:** `history.cursor` + `historyRevision` (`useEditingSession.ts:159–163`);
   any op, undo, redo, cursor jump, reset after capture → stale.
3. **Schema fingerprint:** target column's base-derived name + effective name/type + schema hash;
   a later `column-rename`/`column-cast` → stale (D9).
4. **Plan payload:** mapping pairs + trim code points + ordering.

**Scope and filters (round-1 ruling, unchanged):** scope is **whole-effective only**; grid filters
(`FilterSpec`, `contracts.ts:44–56`) are not captured and never affect target membership — the
target set is the folded effective relation, frozen by construction (pure fold over immutable
base; `overlay.ts` 3–20; `overlay-query.ts:7–16`). Re-sorting/re-filtering/paging **never
invalidates** the plan or preview. Probe F7 stands as the gate for any _future_ filter-scope
proposal (D10). Grid filters still compose over the post-repair layer for grid display (§4.2).
Scope is a logical row set (`base:<anchor>#<ordinal>` / `ins:<anchor>#<seq>`), never a DOM
selection (`provider.ts:31–44`).

**Invalidation:** §2.1–3 changes only; scrolling/sorting/filtering alone never invalidate (H6).

## 3. Preview examples/counts/invalidation

- **Complete counts, one scan, no row arrays:** scanned / affected / unaffected via
  `count(*)` + `count(*) FILTER` (H2: 5/4/1; zero-match P5c: 3/0/3). Whole-effective —
  filter-independent. Per-arm counts bounded by mapping size.
- **Bounded examples:** ≤10 before/after pairs via `LIMIT` (H3), each logical row id + two
  strings. No sample-as-proof; no silent top-N (cap stated: "first N of K affected"); no
  matching-row arrays in React (ADR 0003).
- **Invalidation:** §2.1–3 changes; preview tagged with the captured revision and refused stale at
  render (cast-path precedent, `useEditingSession.ts:330–390`) — **end-to-end path unverified**
  (U2).

## 4. Representation alternatives and resource bounds

**Current facts (pinned):** one closed-union `EditOp` per history entry (`history.ts:43–60`;
union `edit-ops.ts:56–88`); the engine statelessly re-folds the active prefix per request
(`session.ts:25–33`; `overlay-query.ts:7–16`; `protocol.ts:200–235`). Neither representation
exists today; no op implementation is authorized now.

**Exact replay/refolding + chronological semantics** are given in §6.2 (round-2 corrected and
probe-proven). Prior ops interact by prefix position, not special cases: prior cell edits fold
into u (H1 row 1; P8); tombstoned rows are never projected (H1 row 2; composer
`groupBaseColumnEdits` skips them); prior renames/casts rename the alias / set the CAST the wrap
reads.

### 4.2 Alternative (a) — compact relational repair op, emitted-once conditional wrap (RECOMMENDED)

New closed-union op `{ kind: 'column-repair', column, trim?, mapping }`; domain fold does schema
checks only; History: one entry, one undo step.

**Per-emission-site analysis (round-2 finding #1 — the honest inventory):**

| Site                                                                    | Composition today                                                                                                    | Outer projection over the effective union? | Repair composition work                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Window (`composeOverlayWindowSql`, `overlay-query.ts:995–1040`)         | `SELECT <projection> FROM (<composeSourceSql union>)` + WHERE/ORDER/LIMIT (`:1013`)                                  | **Exists**                                 | Add wrap + exception arms to the projection (inside the filter layer, so grid filters see post-repair values). Bound: m + x + 1 added arms per statement, independent of k                                                                         |
| Export / arrow (`composeOverlayExportSql` / `…SelectSql`, `:1056–1110`) | `SELECT <projection> FROM (<source>)` (`:1106`)                                                                      | **Exists**                                 | Same wrap in the existing outer projection. Bound: m + x + 1                                                                                                                                                                                       |
| Insert branches                                                         | per-live-insert literal `SELECT`s (`insertBranchSql`, `:757–789`)                                                    | n/a (per-row literals)                     | **Compose-time literal rewrite** (0 added arms) — requires **D17** conformance pinning; multi-repair = per-repair application                                                                                                                      |
| Schema `DESCRIBE` (`composeOverlaySchemaSql`, `:845–860`)               | `DESCRIBE SELECT <exprs> FROM (<base-branch inner>)` — **base branch only, no union** (`:854–857`)                   | **Does not exist**                         | **New composition work (D16)**: either a wrapped DESCRIBE, or keep unwrapped with an explicit type-preservation argument (outputs are `CAST` to `<effectiveType>`, so declared types cannot change) pinned by composer tests — maintainer decision |
| Cast check (`composeOverlayCastCheckSql`, `:908–970`)                   | existence shape `SELECT 1 … UNION ALL SELECT 1 … LIMIT 1` over raw value arms — **no outer projection** (`:955–965`) | **Does not exist**                         | **New composition work (D16)**: either restructure the check over the wrapped effective value (restores m + x + 1) or wrap each raw arm (honest cost O((1+e+i)·(m+1)), session-bounded × mapping) — maintainer decision                            |
| Count (`composeOverlayCountSql`, `:972–984`)                            | `count(*)` over the union                                                                                            | not needed                                 | None (values don't affect counts; no filter scope in v1)                                                                                                                                                                                           |

**Bound statement (precise, scoped):** for the **window and export paths** the repair adds
**m + x + 1 CASE arms per statement** (m pairs once, x base-branch exception arms, 1 ELSE),
independent of live-insert branch count k; insert branches add 0 arms via the compose-time
literal rewrite (D17). **This bound is NOT claimed for schema/cast-check** — those sites need the
D16 work first (the round-1 claim that existing structure covered all four sites was wrong).
Multi-repair prefixes compose **nested wraps in forward order** (earliest surviving repair innermost): arms Σ(m_k + 1) + per-repair exception arms — still emitted once per statement, not multiplied by k.

**Unverified (explicit):** wasm planner cost at ~m+1 arms — the cited measurements
(`overlay-query.ts:79–88`: ~180 ms at 500 UNION branches, abort ≥1000) cover branch counts, not
CASE arms. Probe P5d proves a 501-arm CASE on **native** CLI (0.014 s wall, 1 000 rows); native ≠
wasm planner. Condition (i).

### 4.3 Alternative (b) — bounded engine-owned delta (documented, rejected as primary)

Unchanged from round 1: needs a new History grouping primitive; per-compose O(edited rows) CASE
arms hit the wasm planning cliff; affected-row arrays are the forbidden failure mode.

### 4.4 Resource bounds (both alternatives)

Plan m ≤ 500 pairs (conditional on (i)); trim code points ≤ 16; x ≤ 500 base-branch exception
arms (**D15**; x=0 in the common apply-at-tail case); typed value-free over-cap refusals aligned
with `MAX_OVERLAY_LIVE_INSERT_BRANCHES`/`OverlayLiveInsertLimitError` (`overlay-query.ts:156–179`).
Insert-branch count cap stays 500 and untouched. Preview = counts + ≤10 examples. **No unbounded
matching-row arrays in React, no silent top-N, no per-cell JS loop, no relaxed overlay/insert
limits.**

## 5. Joint worker/host publication and rollback

Unchanged from round 1: the one logical boundary is `commitWithRollback` (`session.ts:419–456`)
via `commitHistory` (`useEditingSession.ts:188–241`): sync `setActive(next)` (`:172–186`) → one
`model.refresh()`; engine/transport failure → `setActive(previous)` + re-refresh, `restoreFailed`
Retry only if restoration fails; stale plan re-verified at append (`MAX_CAST_CHECK_ATTEMPTS`
pattern, `:27–31`) — end-to-end unverified (U2/U3); no partial computation (one composed
statement); repeat Apply refused via plan identity (D7); redo = cursor move; no engine interrupt
claimed.

## 6. Undo/redo/refolding/branching

- **Undo/redo = cursor moves** (`history.ts:128–144`); stateless refold; no inverse SQL
  materialized on the web path (`useEditingSession.ts:243–257`).
- **6.1 Domain amendment (D14, unchanged):** repair entries carry an empty inverse + `AppliedNote:
'undo-by-refold'`, exactness pinned by P1; ADR required before any runtime row.
- **6.2 Chronological semantics (round-2 corrected; option (a) — exceptions derived from prefix
  folding; probe-proven):** let p be a repair op's prefix position and u a row's **underlying
  cursor value** (the existing fold with the repair's value effect excluded — the domain fold
  never reads values, so u is exactly what the composer already projects: edit arms / base / insert
  values). **Composition rule (round-3 corrected — FORWARD position order):** let the repair ops at
  positions p_1 < … < p_m carry functions r_1, …, r_m (trim∘map, per D1/D3/D5). For a row live at
  the cursor, **final = r_m(…r_2(r_1(u))…)** where repair k is **included** iff the row is
  **live at p_k** AND **no applied `cell-set`/`cell-revert` on the repair column exists at any
  position > p_k**; excluded (masked) repairs are skipped entirely — their output is never
  applied. Dead-at-cursor rows are unprojected. For v1's single-entry Apply this reduces to:
  exception set x = {rows not live at p} ∪ {rows with an applied suffix value-op}; others get
  r(u).
  **Why forward order is correct (corrected induction, round 4):** Assumptions:
  (i) applied `cell-set`/`cell-revert` are **absolute overwrites** of the underlying value and the
  fold map-collapses per cell to the last applied value-op; (ii) **logged no-ops are not masking
  value-ops** — their outcome (`overlay.ts:308–310` `cell-value-unchanged`, `:342–343`
  `cell-already-base`) records that the state did not change, determined against the
  **underlying edit map** (the fold never reads base data or repair outputs), and they ARE
  appended (`history.ts:34–39`); (iii) conflicts are never logged (`history.ts:101–115` refuses
  them), so every logged value-op has an outcome and the guards read exactly
  `outcome.status === 'applied'`. **No-op semantics (explicit):** a logged no-op set/revert
  between two repairs changes no value, so it masks nothing — the later surviving repair still
  applies to the earlier repair's output (probe case `noop-set-between`: `'old'` → r₁ →
  `'middle'` → no-op set `'old'` → r₂ → `'final'`; the no-op-blind rule that treats it as a
  masker yields `'old'` and is empirically falsified — 530 failures on the round-5 faithful corpus, P8 rev 4). **Induction:** let s be the
  **earliest surviving** repair; every applied value-op precedes p_s (else s would be masked),
  and any earlier non-surviving repair was followed by an applied value-op that reset the
  underlying value absolutely — so **the value entering r_s is u**. For the next survivor t > s:
  no applied value-op lies in (p_s, p_t] (none after p_t by survival, none between p_s and p_t or
  s would be masked), so the value entering r_t is exactly r_s's output; induction over the
  survivors gives final = r_m(…r_s(u))…, and the per-repair predicates (liveness at p_k, suffix
  applied value-ops) are **value-independent metadata**, so the composer evaluates them without
  reading values. (The round-3 text wrongly claimed "u equals the value at p_k for every repair" —
  false when an earlier repair transformed the value: u = `'old'` but the value at p₂ is
  `'middle'`; the corrected statement claims u-equality only for the first survivor.)
  **Counterexample resolved:** `old→middle` (p_1) then `middle→final` (p_2), row
  `'old'`, live at both: chronological = `final`; the round-2 reverse loop gave `middle`; forward
  composition gives `final` ✓ — P8 rev 2 includes it explicitly. **Equivalence claim (narrowed, round 4):** equivalent **by the corrected induction above**
  (assumptions (i)–(iii)) **and differentially verified** by probe P8 rev 4 — **27 258 live-cell
  checks, 0 failures** over 8 006 seeded randomized cases (2 513 multi-repair; 2 630 cases
  containing no-ops alongside repairs; non-commuting pool `old→middle`/`middle→final`/`old→new`/
  `a→b`; intervening applied sets, inserts between repairs, reverts, delete/restore), plus five
  explicit cases (counterexample; intervening applied set; **no-op set between repairs**;
  **no-op revert between repairs**; applied-revert-masks). Controls on the same corpus: reverse
  round-2 rule **893 failures**; **no-op-blind rule (the round-3 false premise — logged no-ops
  treated as maskers) 530 failures**; naive no-guard rule 2 939 failures. **Corpus faithfulness
  (round 5):** the generator mirrors liveness at emission (set/revert/del → live rows;
  restore → dead rows) so conflict-class ops are excluded by construction, and `walk` asserts
  zero dead-target value-op attempts (the probe FAILs otherwise). **P8 scope limits:**
  single-column; `cell-revert` generated on base rows only (cell-revert on inserted rows,
  `row-uninsert` expunge and multi-column cases are NOT modelled); a value-level semantics model,
  not the real domain/composer code — that equivalence is U5; algebraic proof beyond these stated assumptions is
  not claimed.
  - **P1 (prefix replay):** `stateAtCursor` is invariant under cursor moves; undo/redo of repair
    entries is exact refold. (No value claims; extend the existing property tests to repair ops.)
  - **P2 (chronological scoping):** repair applies iff live at p and no suffix value-op; **later
    absolute writes win even when they write a mapping-source value** — the falsifying case
    (`repair old→new`, then `cell-set 'old'` ⇒ final `'old'`), evidenced by P7 (naive wrap wrong,
    exception wrap right in emitted SQL) and P8; forward multi-repair composition with non-
    commuting maps and no-op interplay evidenced by P8 rev 4.
  - **P3 (corrected):** a base row deleted before p and restored after p shows its **pre-repair
    effective value** — overlay cell edits from before deletion remain (`row-restore` only
    removes the tombstone, `overlay.ts:482–527`) — the repair never touched it (not live at p ⇒
    exception ⇒ u untransformed). Evidence: P8 randomized class (delete-before/restore-after with
    pre-existing edits and reverts) — 0 mismatches; P5b's earlier "base value stands" phrasing is
    superseded.
- **No-op/dirty (D8) and branching:** unchanged from round 1 (zero-affected refusal keyed on
  P5c; applied entry ⇒ dirty per WF-06 policy; append-after-undo truncates the redo tail,
  `HistoryPanel.tsx:17–24`).

## 7. Races/cancellation

Unchanged from round 1: serialized single lane + `requestId`; revision-tagged apply/preview with
bounded re-checks then typed refusal (cast-path pattern); plan caps refuse value-free pre-apply;
no engine interrupt claimed; worker restart loses nothing. **U2 (stale preview), U3
(out-of-order for repair-sized requests), U4 (wasm arm cost) remain unverified** (§9.1).

## 8. SQL/wire/privacy validation

Unchanged from round 1, with two additions: (i) the **D17 conformance surface** — the TypeScript
compose-time `r_literal` (trim∘map on a string literal, NULL → NULL) must be pinned equal to the
SQL `CASE` behaviour (binary equality, same trim set) by composer tests; (ii) exception arms carry
per-row literals through the same `cellLiteralSql` escaping/surrogate guard. Wire parser rules for
the new op (bounded arrays, no foreign kinds) per `overlay-wire.ts:1–40`. Privacy (ADR 0025)
unchanged: mapping values are local-UI content only.

## 9. Probe transcript

Native DuckDB CLI v1.5.5 (`/tmp/duckdb`, stdin, `.mode list`, ≤1 000-row temp tables, ≤7 output
rows/query) + Node v24.13.0 (dependency-free replay model, seeded). Scripts + outputs under
`/tmp/assay-ew/ew04-probe*`.

| #   | File                           | What it proved                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `ew04-probe1.sql` / `-out.txt` | Trim/class facts (A: default `trim()` unusable — trims NBSP, keeps tab/LF/CR; explicit set edge-only A6/A7), NULL/empty (B), binary equality + canonics (C), simultaneous CASE + mandatory `ELSE` (D1), cascading rejected (D2), stable counts (F4/F5), complete-counts+bounded-preview shape (G).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 2   | `ew04-probe2.sql` / `-out.txt` | Fold over effective values incl. prior edit + merged insert edit (H1 — insert-before-repair only); counts 5/4/1 (H2); LIMIT preview (H3); unaffected md5 identical (H4); cast-literal (H5); id stability under re-sort (H6); E1/E2 idempotence classes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 3   | `ew04-probe3.sql` / `-out.txt` | F7: volatile predicate membership drifts (519/511/489) — grounds D10's future gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 4   | `ew04-probe4.sql` / `-out.txt` | P4: explicit trim set edge-only (space/tab/LF/CR; CRLF pairs; interior kept; NBSP kept).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 5   | `ew04-probe5.sql` / `-out.txt` | P5a-prime: outer wrap (3 arms) ≡ per-branch wrap (12 arms), symmetric diff 0/0 — emitted-once applies uniformly (equivalence at the _value level_ for exception-free wraps over k=3). P5a: exception wrap differs in exactly the excepted row. P5b: chronological cases incl. insert-after and restored-after (superseded in part by P7/P8 for the later-write case). P5c: zero-match counts 3/0/3.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 6   | `ew04-probe6.sql` / `-out.txt` | P5d: 501-arm CASE on **native** CLI, 1 000 rows, 0.014 s — native headroom only; wasm arm-class unverified (U4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 7   | `ew04-probe7.sql` / `-out.txt` | P7 (round 2): the falsifying case in emitted-SQL form — naive wrap maps the later-written `'old'` to `'new'` (wrong); exception wrap yields b0=`'new'`, b1=`'old'` = replay truth.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 8   | `ew04-probe8.mjs` / `-out.txt` | P8 (round-5 revision, domain-faithful corpus): genuine **differential replay** with domain-faithful outcomes AND op targets — the generator mirrors liveness at emission (set/revert/del → live rows, restore → dead rows), so conflict-class ops are excluded by construction (round 4 had drawn dead targets and applied them); `walk` asserts zero dead-target value-op attempts and FAILs otherwise (observed: 0). No-op determination against the underlying edit map (`set w` no-op iff edit = w; revert no-op iff no edit); only **applied** value-ops mask. **Forward rule: 27 258 live-cell checks, 0 failures** over 8 006 seeded cases (2 513 multi-repair; 2 630 with no-ops+repairs; non-commuting pool; intervening applied sets/inserts/reverts/delete-restore) plus five explicit cases (counterexample; intervening set; no-op set between repairs; no-op revert between repairs; applied-revert-masks). **Controls:** reverse round-2 rule **893 failures**; no-op-blind rule **530 failures** (falsifies the round-3 premise); naive no-guard **2 939 failures**. **Scope limits:** single-column; reverts generated on base rows only (inserted-row cell-revert, `row-uninsert`, multi-column NOT modelled); a value-level semantics model, not the real domain/composer code — implementation equivalence is U5. |

### 9.1 Unverified cases (explicit)

| ID  | Case                                                             | Status                       | Why / what stands in                                                                                     |
| --- | ---------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------- |
| U1  | No-op host refusal (refuse to append zero-affected plan)         | Unverified (app logic)       | Count probed (P5c); refusal is design (D8)                                                               |
| U2  | Stale-preview refusal end-to-end                                 | Unverified (web app)         | Cast-path precedent cited, not re-run                                                                    |
| U3  | Out-of-order results for repair-sized requests                   | Unverified (worker protocol) | Lane/requestId discipline cited, not re-run                                                              |
| U4  | Wasm planner cost at ~m+1 CASE arms; arm-class refusal boundary  | Unverified (browser bundle)  | Branch-count citations are a different node class; native-only evidence (P5d). **Verdict condition (i)** |
| U5  | Real composer/domain behaviour of the §6.2 rule (vs probe model) | Unverified (implementation)  | P8 proves the semantic formulation; the §11 domain/composer tests must pin the code                      |

**Other limits:** first volatile attempt failed on a UUID↔VARCHAR cast (recorded, corrected to
`random()`); probe1-A8 construct error superseded by P4; U+000B/000C unprobed (covered by omission
in D1); collation beyond `COLLATE NOCASE` existence unprobed; probe5 rev-1 construction errors
(fixed rev 2); probe8 pre-fix failures retained as evidence of the trim nuance.

### 9.5 Source-byte proof

14-file sha256 manifest (`/tmp/assay-ew/ew04-source-manifest-before.txt`) re-verified after all
probes incl. round-2 additions: **14/14 OK**; `git status --short` → 0 lines. (Out-of-scope
observation, recorded not acted on: sibling WF-06 worktree `../dataworkbench-wf-06` holds
untracked in-flight `apps/web/src/replace/` files owned by that row; lens diagnostics against it
were dispositioned `false-positive` — stale cross-workspace captures, not this baseline.)

## 10. Decision ledger — 17 rows (D1–D17), each a RECOMMENDATION AWAITING DECISION (owner: maintainer)

| #   | Item                                                         | Alternatives                                                                               | Recommendation                                                                                                                                                                                                                                                                                                  | Evidence                                                                           |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| D1  | Exact trim code points                                       | default `trim()` / explicit set / all Unicode ws                                           | Explicit closed set; default candidate **U+0020, U+0009, U+000A, U+000D**                                                                                                                                                                                                                                       | A2–A5, P4                                                                          |
| D2  | Edge-only behaviour                                          | edge-only vs full-string                                                                   | Edge-only, both sides; interior untouched                                                                                                                                                                                                                                                                       | A7, P4-2                                                                           |
| D3  | Case/equality/collation                                      | binary / NOCASE / unicode folding                                                          | Exact binary whole-value equality; no folding in v1                                                                                                                                                                                                                                                             | C1–C4                                                                              |
| D4  | Duplicate mapping keys                                       | dedupe vs refuse                                                                           | Refuse plan construction, typed value-free error                                                                                                                                                                                                                                                                | —                                                                                  |
| D5  | Simultaneous vs cascading                                    | CASE-simultaneous vs chained REPLACE                                                       | Simultaneous only                                                                                                                                                                                                                                                                                               | D1/D2                                                                              |
| D6  | Target∩keys (a→b, b→c)                                       | allow+disclose vs refuse                                                                   | Refuse at plan construction                                                                                                                                                                                                                                                                                     | E1                                                                                 |
| D7  | Repeat Apply / NULL/empty                                    | refusal vs no-op entry; map `''`; NULL targets                                             | Refuse already-active repeat; `''` matchable only as explicit key; NULL never matches nor targets; zero-affected refused                                                                                                                                                                                        | E1/E2, B1–B4, P5c                                                                  |
| D8  | No-op/dirty treatment                                        | refuse-to-append vs append a no-op entry for a zero-affected plan                          | **Recommendation (awaiting decision):** refuse to append a zero-affected plan with an honest typed message. Dirty treatment itself is NOT re-decided here — it follows the **adopted WF-06 policy** (applied outcome ⇒ dirty; no-op-only/undo-to-zero ⇒ clean), cited as adopted evidence constraining this row | spec §3.1.3 (adopted); `overlay.ts:130–146`; P5c (U1 for the refusal logic itself) |
| D9  | Prior-op interaction + rename/cast staleness                 | chronological refold vs re-resolve                                                         | Chronological semantics (§6.2, forward composition); tombstones untouched; rename/cast after capture ⇒ stale refusal                                                                                                                                                                                            | H1, P7, P8; `row-identity.ts`                                                      |
| D10 | Filters and scope                                            | filters narrow scope vs whole-effective only                                               | **Filters never affect scope in v1**; future filter scope needs the determinism gate                                                                                                                                                                                                                            | F7; `contracts.ts:44–56`                                                           |
| D11 | Representation (rev 2)                                       | (a) relational op via conditional emitted-once wrap + literal rewrite vs (b) bounded delta | **(a)**; m ≤ 500 **conditional on U4**; bound claimed only for window/export sites                                                                                                                                                                                                                              | §4.2; P5a-prime, P7, P8                                                            |
| D12 | Publication boundary                                         | new protocol vs reuse `commitWithRollback`                                                 | Reuse the existing boundary                                                                                                                                                                                                                                                                                     | §5; `session.ts:419–456`                                                           |
| D13 | Rollback policy                                              | rollback vs retry-forward                                                                  | Existing rollback + `restoreFailed` Retry                                                                                                                                                                                                                                                                       | §5                                                                                 |
| D14 | Bulk-op inverse amendment                                    | empty-inverse+note vs materializable vs (b)                                                | `'undo-by-refold'` + P1 property test; **ADR before runtime**                                                                                                                                                                                                                                                   | §6.1; `history.ts:43–48`                                                           |
| D15 | Exception-set bound (round 1)                                | uncapped / cap+refuse / refuse-any                                                         | Cap **x ≤ 500** base-branch exception arms, typed value-free refusal, existing remedy                                                                                                                                                                                                                           | §6.2; P8 (session-bounded analysis)                                                |
| D16 | **Schema/cast-check composition (new — round 2)**            | wrapped DESCRIBE + restructured check vs unwrapped DESCRIBE + per-arm check                | Wrapped/restructured (restores m+x+1); if unwrapped DESCRIBE is chosen, its type-preservation argument must be pinned by composer tests; per-arm check cost O((1+e+i)·(m+1)) must be accepted explicitly if chosen                                                                                              | Finding #1; `overlay-query.ts:854–857, 955–965, 1013, 1106`                        |
| D17 | **Compose-time literal rewrite conformance (new — round 2)** | literal rewrite (0 arms) vs per-branch wrap (m×k arms)                                     | Literal rewrite **iff** conformance tests pin TypeScript trim/map ≡ SQL CASE (incl. NULL, surrogate guard, binary equality); else per-branch wrap with the honest m×k bound                                                                                                                                     | §4.2; P8 model; `cellLiteralSql`                                                   |

## 11. Future files/fixtures/tests — hypothetical reservation only (nothing created here)

- Domain: `column-repair` op + step rule + `describeOp` + wire parser; tests: P1 refold-undo,
  **P2/P3 chronological scoping against the real fold** (closes U5), caps/refusals. Blocking:
  D14, D15.
- Engine: composer conditional wrap at window/export; **D16 schema/cast-check work**; **D17
  conformance tests**; **U4 browser-bundle arm-cost probe**. Blocking: U4/D16/D17.
- Web: `apps/web/src/edit/repair/` plan capture/preview/publication via §5; tests closing U1–U3;
  RTL + real-engine legs per spec §7. Blocking: D6–D10, D12–D13.
- Fixtures: synthetic golden fixture only under the repo fixture rule if a runtime row is later
  selected. **No runtime row is unlocked by this document**; verdict conditions (i) U4, (ii) D16,
  (iii) D17, (iv) D15, (v) D14, (vi) U1–U3, (vii) U5 must each resolve first.

---

_Design-only status: delivered as analysis; no repository file changed; no approval claimed;
all runtime/ADR decisions remain with the maintainer._
