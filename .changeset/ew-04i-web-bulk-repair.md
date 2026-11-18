---
'@assay/web': patch
---

Web bulk repair for the merged `column-repair` op: plan capture → preview →
publication, and the renamed EW-04D host conditions (vi) U1–U3.

- `apps/web/src/edit/repair/` — plan capture (column, the explicit trim
  code-point set from `DEFAULT_REPAIR_TRIM_CODE_POINTS` / a user-listed set,
  exact whole-value mapping pairs) with the domain's typed, value-free refusals
  surfaced **without an engine call** (non-text column, 500-pair cap, 16
  code-point trim cap, dead mapping key, one trim set per chain, identity); a
  preview that reads complete `scanned/affected/unaffected` counts from one
  engine `count(*)` plus ≤10 `LIMIT`-bounded before/after examples with the cap
  **stated**; and a native-dialog surface that applies through the existing
  `commitWithRollback` boundary.
- Preview is whole-effective only: grid filters/sort/paging are never captured
  and never invalidate, while an anchor, cursor, history-revision or schema
  change is refused stale at render and again at publication (U2).
- Apply is exactly one history entry and one undo step; undo is the exact
  refold at the cursor (ADR 0050) — no inverse is minted. A zero-affected plan
  is refused and appends nothing (U1), the identical plan already at the cursor
  is refused by identity, and out-of-order preview results never publish or
  overwrite a newer one (U3).
- The published export envelope (`MAX_REPAIR_EXPORT_CELL_WORK`) is refused
  **pre-apply** from the same projection the engine uses (rows × pairs, the
  whole repair prefix), never after a failed export and never as an interrupt.
- No new telemetry, no dependency, no protocol change, no `packages/**` change.
