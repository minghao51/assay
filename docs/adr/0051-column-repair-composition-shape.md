# ADR 0051: Column-repair composition is stacked projection layers of linear emitted size, and predicate sites use set-membership

## Status

Accepted

## Date

Proposed 2026-11-18 → Accepted 2026-11-18

## Deciders

- Maintainer (product/domain owner; acceptance instruction "accept", 2026-11-18, recorded in the
  [post-EW-03I-a pickup](../process/handoff/20261118-post-ew03ia-pickup.md) — the record this ADR was
  proposed from named acceptance as the maintainer's, and nothing else in it changed at acceptance)

## Context

The merged `column-repair` op (op and caps `packages/domain/src/edit-ops.ts`, fold
`packages/domain/src/overlay.ts`, composer `packages/engine-duckdb/src/overlay-query.ts`) realises a
whole-column `trim∘map` value transform over an overlay prefix. Its undo model is decided by
[ADR 0050](0050-column-repair-undo-by-refold.md) (undo by refold); its chronological semantics —
which repairs apply to which rows — are EW-04D §6.2's forward composition rule, cited there and not
reopened here. What no ADR records yet is the **composition shape**: how a repair prefix becomes SQL,
how large that SQL may grow, and how value predicates read repaired values. That shape is already
implemented in the merged composer and already decided by probe evidence; this record makes it
durable for the merged op and for any future value-transform op, as the
[D16/D17 composition probe](../process/handoff/20261114-d16-d17-composition-probe.md) §9 identified
as the one such decision not covered by an existing ADR.

Two evidence sets decide the shape. The [U4 arm-class probe](../process/handoff/20261114-u4-arm-class-probe.md)
measured multi-repair prefixes under both readings of EW-04D §4.2's "nested wraps … earliest
innermost". Read as **one nested expression** (the inner wrap textually embedded in every outer arm)
it duplicates the inner wrap and grows multiplicatively: 2,405,139 SQL bytes and ~2.35 s at two
repairs (19,345 bytes for the flat 500-arm wrap), and a third repair fails with
`Out of Memory Error: Allocation failure` on the shipped `eh` bundle. Read as **stacked projection
layers** it stays in the flat-wrap cost class: 3 × 166 arms cost 15.8 ms planning / 19.6 ms execution
against 14.7 / 16.6 ms for the flat 500-arm wrap at a 1,000-row window (U4 §2.2). The same probe
found 500 CASE arms cost ~15 ms planning + ~17 ms execution at a 1,000-row window with the planner
linear through 30,000 arms, and that the cited ≥1,000-branch abort is a different node class
(`UNION ALL` branches, not CASE arms — U4 §3). The D16/D17 probe measured the predicate sites: a
CASE arm chain as a predicate is 100–200× more expensive than set-membership in the existence-probe
context (16–24 s vs 0.10–0.12 s per 200 k rows at m = 500; probe §6/§7).

The rules those measurements establish are recorded below; the decisions they rest on are not
re-made. D11's accepted stacked-projection qualifier (post-R1 decision sheet §4.4, accepted in the
[post-R1 acceptance record](../process/handoff/20261114-post-r1-decisions-accepted.md) D4) names the
shape; the D16 wrapped `DESCRIBE`/split-form cast check and the D17 literal rewrite are accepted
shapes this record cites. [ADR 0049](0049-csv-options-preview-and-retention.md) item 8 (EW-03D D15,
[CSV contract](../process/handoff/20261113-ew03-csv-contract.md)) supplies the standing capability
rule the measurements must be read under.

**Evidence limits.** No probe, build or test was run to write this record. Every number below is
quoted from a cited record or from the merged source at `56fafad`; nothing is measured here.

## Decision

1. **Stacked projection layers, not nested expressions.** A repair prefix composes as one projection
   layer per repair, earliest innermost (each layer reads the previous layer's output column), and
   each wrap is emitted once per statement. The arms added are `Σ(m_k + 1)` + per-repair exception
   arms (m_k = repair k's mapping pairs; the merged composer emits `m_k + x_k + 1` per layer
   including its ELSE, `overlay-query.ts:70–95`), independent of the live-insert branch count
   (EW-04D §4.2's k). One-expression nesting is forbidden: it duplicates the inner wrap into every
   outer arm and OOMs at three repairs (U4 §2.2); stacked layers add linearly (U4 §2.2; D16/D17
   probe §4.2). Realised by `composeEffectiveSourceSql` (`overlay-query.ts:1180`) and pinned by the
   merged tests (`packages/engine-duckdb/src/overlay-repair-query.test.ts:218`, `:241`).
2. **Linear emitted size.** Each statement's added arms are linear in that statement's effective
   plan, never multiplied by the live-insert branch count; insert branches take the D17 compose-time
   literal rewrite and add **0** arms — the literal path replaces the wrap, never accompanies it. The
   bound is stated exactly as EW-04D §4.2 states it: for the **window and export paths** the repair
   adds `m + x + 1` CASE arms per statement (m pairs once, x base-branch exception arms, 1 ELSE),
   independent of live-insert branch count k; insert branches add 0 arms via the compose-time literal
   rewrite (D17). **This bound is NOT claimed for schema/cast-check** — those sites needed the D16
   work (the wrapped `DESCRIBE` and the split-form cast check scoped to repair-composed columns;
   D16/D17 probe §1/§3/§7). The insert-site rewrite is `rewriteRepairsForInsertBranch`
   (`overlay-query.ts:1134`), pinned by 26 hostile literals with 0 TypeScript↔SQL disagreements
   (D16/D17 probe §2.3); a non-text insert value refuses (`OverlayRepairInsertValueError`,
   `overlay-query.ts:257`) rather than re-nest the wrap.
3. **Set-membership at predicate sites.** Value predicates read the wrapped effective value at the
   predicate site and must not duplicate or re-nest the wrap; membership is decided by the same
   composed relation the projection reads. Per site: window filters `WHERE`-compose above the wrapped
   relation (`composeOverlayWindowSql`, `overlay-query.ts:1816`), so a filter reads the same wrapped
   effective column the projection reads (EW-04D §4.2 places the wrap inside the filter layer, so
   grid filters see post-repair values). The repair-column cast check operands on the wrap-input
   value and decides failing membership as hashed set-membership — a constant-relation semi-join
   over the collapsed finite map, never a per-row CASE chain (`composeRepairCastCheckSql`,
   `overlay-query.ts:1567`; D16/D17 probe §3.3, collapse probe18 18/18) — because DuckDB evaluates
   CASE arms linearly and `IN (…)` set-wise (probe §7.1 constraint 5). The repair's own exception
   arms read the layer input at the arm (`THEN <ref>`, `repairWrapExpressionSql`,
   `overlay-query.ts:1094`) with membership taken from the prefix fold's value-independent metadata
   — not-live-at-apply ordinals and applied suffix value-ops (EW-04D §6.2; `RepairStepRecord`,
   `overlay.ts:122`) — so the composer decides exceptions without reading values and the projection
   and its predicates cannot disagree.

## Consequences

### Positive

- Multi-repair prefixes cost the flat-wrap class, not the nested class: stacked 2 × 250 and 3 × 166
  arms measure 17.6 and 15.8 ms planning at a 1,000-row window against 14.7 ms for a flat 500-arm
  wrap (U4 §2.2), and emitted size is additive `O(Σ(m_k + x_k + 1))` (D16/D17 probe §4.2).
- Because emitted arms are linear in the effective plan, the caps and the export budget are product
  bounds, not planner-risk bounds (U4 §4): no arm-class refusal cliff exists anywhere near 500 arms.
- Insert branches cost 0 SQL arms (decision 2), so the live-insert branch count never multiplies
  repair cost.
- Set-membership at predicate sites keeps the pre-apply cast gate in the split-form class
  (0.10–0.12 s per 200 k rows native at m = 500) instead of the wrap-as-predicate class (16–24 s
  per 200 k; D16/D17 probe §6).

### Negative / risks

- The natural one-expression reading is not merely slower but fatal (OOM at three repairs, U4 §2.2),
  so any future composer change must keep the stacked shape; the shape is realised at
  `composeEffectiveSourceSql` and pinned byte-wise by
  `packages/engine-duckdb/src/overlay-repair-query.test.ts:218–268`.
- The CASE-as-predicate penalty behind decision 3 is native-measured with an inferred mechanism —
  the ratio is stable but the operator was not named via `EXPLAIN` (D16/D17 probe §8) — and no
  browser measurement of that penalty exists: not measured here.
- Multi-repair exception-mask signatures (up to 2^L surviving sub-chains for L layers) were not
  cost-probed (D16/D17 probe §8); the merged split form classifies them exactly
  (`overlay-query.ts:1525`) but no cost figure is claimed here for wide signature spreads — not
  measured here.
- Over-cap plans refuse with typed value-free errors (`OverlayRepairExceptionLimitError`,
  `OverlayRepairExportBudgetError`) rather than degrading silently, so a large repair session stops
  before the engine does.

### Neutral

- **The published export budget and its refusal.** `MAX_REPAIR_EXPORT_CELL_WORK` = 1,000,000,000
  cell rewrites, projected as rows × mapping pairs, is refused before any SQL is composed by
  `assertRepairExportBudget` (`overlay-query.ts:1263`) with the value-free
  `OverlayRepairExportBudgetError` — post-R1 decision sheet D4 option (a), "publish the measured
  envelope and refuse pre-apply", accepted in the post-R1 acceptance record. The envelope is U4's
  measured cost line: ~4.0 s at 2 M rows × 500 pairs on `eh` (3,953.8 ms execution, U4 §2.3). It is
  a pre-apply refusal, never an interrupt — the engine has none. This record does not move it.
- **The plan caps.** 500 mapping pairs and 16 trim code points per repair
  (`MAX_REPAIR_MAPPING_PAIRS`, `MAX_REPAIR_TRIM_CODE_POINTS`, `edit-ops.ts:200`, `:203`; EW-04D
  §4.4) and ≤ 500 base-branch exception arms per repair layer (`MAX_REPAIR_EXCEPTION_ARMS`,
  `overlay-query.ts:206`; D15, accepted). This record does not move them.
- **Browser is the only capability truth.** Per EW-03D D15 (standing rule, restated as ADR 0049
  item 8) the shipped browser engine is the only capability truth and the native CLI is a comparison
  control only. The arm-cost measurements are native-versus-browser separated accordingly: U4's
  numbers are the shipped `eh` wasm bundle in Playwright Chromium (browser); the D16/D17 probe's
  numbers are native DuckDB CLI v1.5.5 (comparison only); EW-04D §4.2 notes native ≠ wasm planner.
  Any capability claim derived from these numbers is re-proven in-browser after an engine bump.
- **Nothing else changes.** This ADR adds no protocol, telemetry, dependency or schema behaviour
  (ADR [0025](0025-telemetry-and-data-privacy-boundary.md)/[0037](0037-telemetry-opt-out-consent.md));
  it does not change the undo model (ADR 0050), EW-04D §6.2's chronological rule, the D16/D17
  shapes, the caps or the budget.

## What this ADR does not decide

- **Nothing is re-decided.** EW-04D §6.2's forward composition and masking, D11's representation
  choice and its accepted stacked-projection qualifier, D15's cap, D16's wrapped `DESCRIBE` and
  split-form cast check, D17's literal rewrite, the export budget and ADR 0050's undo-by-refold are
  cited at their sources, not reopened here.
- **No measurement of its own.** Every figure above is quoted from the U4 probe, the D16/D17 probe
  or the merged source; where a figure does not exist this record says "not measured here".
- **No schema/cast-check bound.** EW-04D §4.2's `m + x + 1` bound is scoped to the window and export
  paths; schema and cast-check needed the D16 work and their accounting lives in the D16/D17 record
  and its tests, not here.
- **No implementation or UI surface.** The rules constrain the merged composer and any future
  value-transform op; EW-04I's web surface is out of scope.

## Alternatives considered

- **One nested CASE expression per statement** (the literal reading of "nested wraps, earliest
  innermost"). **Rejected:** falsified by U4 — it duplicates the inner wrap into every outer arm
  (2,405,139 SQL bytes at two repairs against 19,345 for the flat wrap) and OOMs at a third repair.
  The stacked reading is the only one under which EW-04D §4.2's additive-arms claim holds.
- **Per-branch wrap on insert branches (`m × k` arms)** (D17 option (b), post-R1 decision sheet
  §4.3). **Rejected:** it multiplies arms by the live-insert branch count and reaches the caps
  quickly; the compose-time literal rewrite adds 0 arms and is pinned by the D17 conformance cases
  (26/26, D16/D17 probe §2.3).
- **CASE arm chains at predicate sites** (a "wrap as a predicate" for the cast check, or filters
  re-nesting the wrap). **Rejected:** DuckDB evaluates CASE arms linearly and `IN (…)` set-wise —
  100–200× apart in the existence-probe context (D16/D17 probe §6/§7.1) — so set-membership over
  the same composed relation answers the identical question at split-form cost.
