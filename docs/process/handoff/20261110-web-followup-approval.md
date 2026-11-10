# Web follow-up — maintainer approval record (2026-11-10)

**Authority:** the maintainer approved the pre-filled decision request in
[map §2 "Suggested authorization response"](20261110-web-followup-map.md#2-decision-register-not-self-executing-defaults)
("approve", 2026-11-10). This file is the approval of record. It converts only the named IDs from
unapproved defaults into dated choices; every unlisted ID stays an unapproved recommendation, and no
accepted ADR, closed rd row or prior deferral is rewritten. Read it together with the
[audit](../../reviews/2026-11-10-web-svg-followup-audit.md), the
[specification](../../product/14-web-interface-followup-spec.md) and the [map](20261110-web-followup-map.md).

## 1. Approved scope (WFD-09)

```text
WF-00  preflight + durable ledger            → executed, CLOSED (§3)
WF-01P read-only temporal matrix             → selected (read-only; returns matrix, then stops)
WF-02  pipeline label honesty                → selected as the FIRST runtime writer
WF-05  replacement design (read-only)        → selected under WFD-01=B, design only
```

**Not selected — do not dispatch, do not treat as prerequisites:** WF-01 (runtime), WF-03, WF-04,
WF-06, WF-07, WF-08, WF-09, WF-O1, WF-O2. **WF-10** closes only this subset once its selected rows
and read-only artifacts are integrated.

## 2. Decision register — dated choices

| ID         | Decision                  | Choice recorded 2026-11-10                                                                  | Consequence                                                                                                                                                                                                                                                                                |
| ---------- | ------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **WFD-01** | replacement safety        | **B — commission WF-05 design only.** D-07/SV-D03 reopened **for design**, not for runtime. | WF-05 is authorized read-only. WF-06 stays BLOCKED: no runtime authority follows from this approval.                                                                                                                                                                                       |
| **WFD-02** | task semantics            | **A — retain navigation/exposure semantics.**                                               | Tasks reveal tools; cross-task editing and its rejection recovery stay as shipped (UI-RD-01/rd-3b). No read-only task mode, no Delete-only hiding.                                                                                                                                         |
| **WFD-03** | context action policy     | **pending**                                                                                 | No WFD-03 truth table is approved; WF-04 stays BLOCKED. D-06/D-11 stay in force.                                                                                                                                                                                                           |
| **WFD-04** | geometry/IA               | **pending**                                                                                 | ADR 0044 intact; WF-08 study and WF-09 runtime both unselected.                                                                                                                                                                                                                            |
| **WFD-05** | bounded presentation/copy | **pending**                                                                                 | No WF-03 subparts selected; no new welcome/first-minute strings approved. rd-7 Help copy and the current heading map stay authoritative.                                                                                                                                                   |
| **WFD-06** | temporal presentation     | **A (UTC deterministic ISO-like) as the direction, with the matrix return.**                | Read-only WF-01P may produce the type/unit/precision/consumer matrix and then STOPS. **WF-01 runtime remains BLOCKED** until the returned matrix is explicitly approved on a fresh baseline. Scalar-grid + display-copy scope only; nested/Record/SQL parity is WF-O2 and is not selected. |
| **WFD-07** | range wording             | **pending**                                                                                 | No `Visible rows X–Y of N` contract approved; WF-07 stays BLOCKED.                                                                                                                                                                                                                         |
| **WFD-08** | pipeline labels           | **Label-only honesty** with the exact strings in §2.5.                                      | WF-02 replaces only visible wording under D-13/D-14. Node sets, statuses, model, runner, IR and canonical DCR/report bytes are unchanged.                                                                                                                                                  |
| **WFD-09** | selected scope/evidence   | See §1.                                                                                     | Closure denominator is this subset; RD-T07 stays a limitation. No push authority follows.                                                                                                                                                                                                  |

### 2.5 WFD-08 approved copy (verbatim, WF-02)

| Current visible string                                                              | Approved replacement                       | Preserved meaning                                                                                                                                         |
| ----------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<N> output` / `<N> outputs` in the plan summary (`data-testid="pipeline-summary"`) | `<N> terminal node` / `<N> terminal nodes` | Counts the **same** `isOutput` set (`!consumed`), which includes terminal gate/publish nodes. Never a count of successful deliveries, saves or artifacts. |
| node badge `output` (`data-testid="pipeline-node-output"`)                          | `terminal`                                 | Same `isOutput` boolean; no model rename, no testid rename, no wire change.                                                                               |
| `Completed before the stop:` (`data-testid="pipeline-run-gated-completed"`)         | `Recorded node outcomes:`                  | The same recorded outcome collection, including the refused/gated node. Status text still supplies each node's actual result.                             |

Not changed: `Preview output`, schema/materialized-relation wording, candidate references, DCR/export
copy and every genuine-output label. No global replacement of the word "output".

## 3. WF-00 preflight — measured, not inherited

**Row WF-00: CLOSED** (orchestrator-executed, no source edit).

| Field                            | Value                                                                                                      |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Baseline                         | `76c1945561b323a012f40cb85617aa2be57facd8` on `main`, clean worktree, committed                            |
| Delta from the planning baseline | `7fa1e78..76c1945` = 8 files, **docs only**, zero runtime/test/config/fixture/ADR change                   |
| Toolchain                        | Node `v24.13.0`, pnpm `11.26.0`, `DUCKDB=/tmp/duckdb` (`v1.5.5 Variegata d8cdaa33fd`), Playwright `1.63.0` |
| Ports                            | stock `9273 / 9279 / 9280` (all verified free before the run)                                              |
| Logs                             | `/tmp/assay-wf00/` (`00-baseline.txt`, one file per gate, `summary.txt`)                                   |

| Gate                                         | Exit | Counts                                                                                                 |
| -------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------ |
| `pnpm install --frozen-lockfile`             | 0    | lockfile unchanged                                                                                     |
| `pnpm format:check`                          | 0    | all files match Prettier style                                                                         |
| `pnpm lint`                                  | 0    | —                                                                                                      |
| `pnpm exec turbo run typecheck --force`      | 0    | 20/20 tasks, 0 cached                                                                                  |
| `pnpm test`                                  | 0    | **237 test files, 3531 tests passed**, 0 failed                                                        |
| `pnpm test:coverage`                         | 0    | stmts 89.13, branch 83.88, funcs 91.47, lines 90.73 (17171/19264, 11625/13859, 2790/3050, 15543/17130) |
| `pnpm exec turbo run build --force`          | 0    | 12/12 tasks                                                                                            |
| `pnpm docs:links:check`                      | 0    | 140 files, 0 broken links                                                                              |
| `pnpm adr:index:check`                       | 0    | 46 records                                                                                             |
| `CI=1 pnpm exec playwright test --retries=0` | 0    | **249 passed, 1 skipped**, 0 failed, 0 flaky                                                           |

Failed runs: none. Nothing was retried to green. The historical `237/3531` and `249+1` figures are now
**re-measured at this baseline**, not asserted from memory; they are still not target constants for
later rows.

### 3.1 Board/residual ledger

All 17 SVG boards are classified in [audit §3](../../reviews/2026-11-10-web-svg-followup-audit.md) and
crosswalked in [map §4](20261110-web-followup-map.md#4-residual-crosswalk-not-a-second-queue); this
approval changes no board's disposition. rd-0…rd-7 + rd-3b/3c, hf-1, D-10 remain CLOSED and are not
re-dispatched. sv-0 was never executed (no backdated completion), and sv-1…sv-12 / SV-F01…F07 keep
their listed owners or separate gates.

### 3.2 Approved-subset manifest (dispatch index)

| Row                                                           | Status after this record         | Next action                                                                                                       |
| ------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| WF-00                                                         | **CLOSED**                       | evidence above                                                                                                    |
| WF-02                                                         | **READY** — first runtime writer | one writer, isolated worktree, independent review, merged gates                                                   |
| WF-01P                                                        | **READY** — read-only            | produce matrix + proposed scope-A fallback, then STOP                                                             |
| WF-05                                                         | **READY** — read-only design     | successor lifecycle spec + transition/copy tables, no code                                                        |
| WF-01, WF-03, WF-04, WF-06, WF-07, WF-08, WF-09, WF-O1, WF-O2 | BLOCKED / not selected           | need a new decision (WFD-06 matrix approval for WF-01; WFD-03/04/05/07 approvals or a new selection for the rest) |

## 4. Invariants carried into every dispatched row

One web writer at a time; isolated worktree + independent reviewer; the implementer never approves its
own change. No push, publication, visibility, dependency or lockfile change. No package payload, engine
protocol, report/DCR/export byte, threshold, timeout, allowlist, skip or retries-to-green change under a
presentation row. No `force: true` browser interactions. CLI/export encoders and raw editing values must
never consume formatted display strings. Dataset contents, filenames and PII stay out of telemetry and
guidance copy. ADR 0044 and the accepted ADRs are not rewritten; a durable new decision needs its own ADR.

## 5. Residuals this approval does not remove

- **RD-T07** — no participant or assistive-technology study. Nothing here is "validated with users".
- **WF-01 temporal display** — unimplemented; scalar dates/timestamps/times still render raw in the
  grid until the matrix is approved and a separate runtime row lands.
- **WF-O2** — nested previews, Record tree and untyped SQL results keep raw/declared-type-free temporal
  output even after a scalar fix.
- **Pipeline labels** — remain misleading until WF-02 is merged and verified.
- **D-06, D-11, D-07 runtime, SV-D02/03/04/05, SV-F01…F07** — unchanged.
