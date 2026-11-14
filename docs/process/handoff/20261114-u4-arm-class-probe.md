# U4 — wasm arm-class probe (CASE arms, `eh` vs legacy `mvp`)

**Date:** 2026-11-14. **Row:** EW-04D §9.1 **U4** — "wasm planner cost at ~m+1 CASE arms; arm-class
refusal boundary" — verdict condition (i). **Status:** probe complete; **no source,
dependency or protocol change**; probes/logs in `/tmp/assay-u4-probe/`; nothing pushed.

**Authority:** [EW-04D](20261113-ew04-bulk-contract.md) §4.2/§4.4/§9.1 and
[ADR 0048](../../adr/0048-engine-bundle-selection-and-honest-error-text.md) (the shipped `eh` bundle);
maintainer instruction "proceed with the next" (2026-11-14) funding U4. This record reports
measurements; it does not re-open EW-04D's decision ledger (the maintainer owns D11/D16/D17).

## 1. Method

- **Bundles:** the shipped capability-selected `eh` pair (`duckdb-browser-eh.worker.js` +
  `duckdb-eh.wasm`, DuckDB `v1.4.3`) and the legacy `mvp` pair as a control, both from
  `@duckdb/duckdb-wasm@1.32.0`, run in Playwright Chromium via an isolated `/tmp` harness.
- **Shape:** EW-04D §4.2's emitted-once conditional wrap in a window projection —
  `SELECT id, CASE WHEN label = 'label_0' THEN 'v0' … ELSE label END AS label FROM base WHERE id < 1000`
  — over a 2,000,000-row `base` (so the window evaluates 1,000 rows, matching probe P5d's scope).
- **Measurement:** `EXPLAIN` isolates planner cost; the query itself isolates planner + executor.
  Medians of 3 warm runs (1 for the deliberately slow cases). Host load 4–5 (16 cores); a separate
  low-load (3.4) stability run reproduced flat-500 at ~13–15 ms, so the table below is conservative.
- **Variants:** flat arms (1 … 30,000), stacked-projection multi-repair wraps (Σ≈500), one-expression
  multi-repair nesting (the literal "earliest repair innermost" reading), and the full-scan export
  shape at m=100/500 over the full 2 M rows.
- **Artifacts:** `/tmp/assay-u4-probe/u4final-out.json` (consolidated), `u4b-out.json` (nested/OOM),
  `u4d` stability, `u4final-load.txt`.

## 2. Results (milliseconds, medians)

### 2.1 Flat CASE arms, window over 1,000 rows

| m (arms)      | `eh` plan | `eh` exec | `mvp` plan | `mvp` exec | SQL bytes |
| ------------- | --------- | --------- | ---------- | ---------- | --------- |
| 1             | 6.1       | 1.3       | 8.8        | 3.0        | 100       |
| 100           | 5.2       | 5.6       | 25.2       | 28.0       | 3,745     |
| 250           | 10.8      | 10.9      | 52.4       | 51.1       | 9,595     |
| **500 (cap)** | **14.7**  | **16.6**  | 92.1       | 86.9       | 19,345    |
| 1,000         | 24.1      | 27.4      | 180.5      | 172.9      | 38,845    |
| 2,000         | 50.2      | 50.6      | 351.2      | 355.3      | 79,845    |
| 5,000         | 109.3     | 129.0     | 769.7      | 909.7      | 202,845   |
| 10,000        | 303.3     | 267.0     | 1,585.3    | 1,392.9    | 407,845   |
| 20,000        | 559.6     | 651.2     | 2,265.1    | 2,323.1    | 837,845   |
| 30,000        | 896.4     | 994.5     | 3,412.0    | 3,536.6    | 1,267,845 |

**No arm-class refusal occurred at any measured size** (through 30,000 arms, 1.27 MB of SQL) on
either bundle: the cost is planner ≈ executor and grows roughly linearly. The `eh` planner is
~4–6× faster than `mvp` at the same arm count.

### 2.2 Multi-repair wraps (Σ arms ≈ 500)

| Shape                              | `eh` plan | `eh` exec | `mvp` plan | `mvp` exec | SQL bytes     |
| ---------------------------------- | --------- | --------- | ---------- | ---------- | ------------- |
| flat 500 (baseline)                | 14.7      | 16.6      | 92.1       | 86.9       | 19,345        |
| **stacked projections** 2 × 250    | 17.6      | 17.2      | 60.3       | 60.4       | 19,696        |
| **stacked projections** 3 × 166    | 15.8      | 19.6      | 58.7       | 60.8       | 19,443        |
| **one-expression nesting** 2 × 250 | 2,346.2   | 2,374.6   | — (failed) | —          | **2,405,139** |

The one-expression nesting duplicates the inner wrap inside every outer `WHEN` condition, so its SQL
grows multiplicatively (2.4 MB at two repairs, ~140× the flat cost). A third such repair failed with
`Out of Memory Error: Allocation failure` on `eh` and `_setThrew is not defined` on `mvp`. **Multi-repair
prefixes are only cheap when each repair is a separate stacked projection layer** (additive arms,
no expression duplication) — the shape EW-04D's "arms Σ(m_k + 1), emitted once per statement" claim
implicitly assumes.

### 2.3 Export shape (full 2 M rows, no window)

| m   | `eh` plan | `eh` exec   | `mvp`          |
| --- | --------- | ----------- | -------------- |
| 100 | 12.7      | **910.3**   | 24.9 / 589.7   |
| 500 | 28.7      | **3,953.8** | 92.1 / 2,892.1 |

Full-scan evaluation is execution-bound and linear in rows × arms: at the 500-pair cap, a 2 M-row
export pays ~4.0 s on `eh`. `mvp` sometimes returns numbers and sometimes `_setThrew` for the same
export shape across runs, so it is not a trustworthy control for success/failure classes.

## 3. Findings

1. **U4's core question is answered: there is no arm-class cliff near the cap.** On the shipped `eh`
   bundle, 500 CASE arms cost ~15 ms planning + ~17 ms execution for a 1,000-row window; the planner
   stays linear through 30,000 arms. The cited ≥1,000-branch abort is indeed a different node class
   (`UNION ALL` branches), consistent with EW-04D §4.2's warning.
2. **`eh` is materially cheaper than `mvp`** at identical SQL (4–6× on planning), so any arm-cost
   budget derived from the old `mvp` measurements was pessimistic.
3. **The export site is the real cost centre**, not the planner: ~4.0 s at m=500 over 2 M rows,
   scaling with rows × arms. The window path evaluates only the window and stays in the tens of ms.
4. **Multi-repair composition is under-specified, and one reading fails.** "Nested wraps … earliest
   innermost" read as one nested CASE expression explodes (2.4 MB SQL, OOM at three repairs).
   Read as stacked projection layers it is indistinguishable from a flat 500-arm wrap. EW-04D must
   pin the stacked shape (and the emitted SQL size) before a runtime row relies on Σ arms.
5. **`mvp` is unusable as a failure-class control** (intermittent `_setThrew` on the same export
   shape in different runs); `eh` gives honest messages.

## 4. Verdict on condition (i)

- **Satisfied for the flat `m ≤ 500` wrap on the window path**: ~15 ms planning and ~17 ms execution
  at the cap, no refusal boundary anywhere near it. The cap remains a product bound, not a
  planner-risk bound.
- **Satisfied with a cost caveat for the export path**: the same arms cost ~4 s per 2 M rows, so a
  published export budget (or a lower full-scan `m`) is needed; this is execution, not planning.
- **Conditional for multi-repair prefixes**, on EW-04D adopting the stacked-projection composition.
  The additive-arms claim is true only for that shape; the expression-nested reading is falsified at
  two repairs and OOMs at three.
- **D16/D17/U1–U3/U5 are untouched by this probe** and remain as recorded in EW-04D §9.1.

## 5. What this changes for EW-04D (for the maintainer; no decision taken here)

- D11's representation note should name the **stacked-projection** multi-repair composition and pin
  its SQL-size linearity; the "nested wrap" sentence needs that qualifier.
- The resource bounds (§4.4) should add a **full-scan/export cost statement** (measured: ~4 s at
  m=500 over 2 M rows on `eh`), not just the planner bound.
- The arm cap `m ≤ 500` can stay; the probe removes condition (i) as a blocker for the flat wrap.
- Verdict conditions (ii) D16 composition, (iii) D17 literal rewrite, (iv) D15 exception cap,
  (v) D14 undo ADR, (vi) U1–U3 host paths, (vii) U5 real composer tests remain open.

**Nothing was pushed.** No source, dependency, protocol, ADR or contract change was made; the only
artifacts are this record and the `/tmp` probes.
