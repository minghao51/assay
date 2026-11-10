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
| `pnpm docs:links:check`                      | 0    | 140 files, 0 broken links (141 in later runs — this record adds a file)                                |
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

| Row                                                           | Status after this record     | Next action                                                                                                                                        |
| ------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| WF-00                                                         | **CLOSED**                   | evidence above                                                                                                                                     |
| WF-02                                                         | **CLOSED `b65e304`**         | merged + verified; integration record §6                                                                                                           |
| WF-01P                                                        | **DELIVERED 2026-11-10**     | matrix at [reviews/2026-11-10-wf01p-temporal-matrix.md](../../reviews/2026-11-10-wf01p-temporal-matrix.md); **stops for the WFD-06 decision** (§7) |
| WF-05                                                         | **READY** — read-only design | successor lifecycle spec + transition/copy tables, no code                                                                                         |
| WF-01, WF-03, WF-04, WF-06, WF-07, WF-08, WF-09, WF-O1, WF-O2 | BLOCKED / not selected       | need a new decision (WFD-06 matrix approval for WF-01; WFD-03/04/05/07 approvals or a new selection for the rest)                                  |

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
- **Pipeline labels** — **fixed in WF-02** (`b65e304`); the count's `isOutput` derivation is deliberately unchanged (D-14), so a node read only by a validate/publish gate is still counted as "terminal".
- **D-06, D-11, D-07 runtime, SV-D02/03/04/05, SV-F01…F07** — unchanged.

## 6. Row WF-02 — integration record (pipeline label honesty)

**Selected requirements / approved decision and copy:** WF-02 / **T-WF02** / **WFD-08 label-only**, exact strings in §2.5 above (approved 2026-11-10). Preserve node sets, per-node statuses, `isOutput` derivation, run-outcome model, runner, IR and every canonical DCR/report/export byte; change visible wording only.

| Field                 | Value                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline              | `764151c` on `main`, clean worktree (WF-00 baseline `76c1945`)                                                                                                                                                                                                                                                                                                        |
| Worker commit         | `855114a` — branch `wf-02`, worktree `../dataworkbench-wf-02` (writer `opencode-go/deepseek-v4.1-flash`, one Conventional Commit)                                                                                                                                                                                                                                     |
| Reviewer-approved SHA | `855114a` — independent `openai-codex/gpt-6-luna` (explicit xhigh), **VERDICT: approve**, zero critical/warning findings                                                                                                                                                                                                                                              |
| Merged SHA            | `b65e304` — cherry-picked onto `main`, no conflicts                                                                                                                                                                                                                                                                                                                   |
| Changed files         | `.changeset/wf-02-pipeline-label-honesty.md`, `apps/web/src/pipeline/PipelinePanel.tsx`, `apps/web/src/App.pipeline.test.tsx`, `tests/e2e/pipeline-panel-journey.spec.ts` — exactly the reserved set (4 files, +53/−26)                                                                                                                                               |
| Deviations            | None requiring new authority. Three additive test-side choices inside the reserved files, disclosed by the worker and accepted by the reviewer: heading positive + old-claim-absent pins where the heading previously had no coverage; one count-free plural pin (`terminal nodes`); the three recorded-defect comment rewrites with every pinned node fact retained. |

**Evidence.** Worker gates 9/9 exit 0 (`/tmp/assay-wf-02-logs/`); reviewer gates 9/9 exit 0 (`/tmp/assay-wf-02-review-logs/`); **merged** gates at `b65e304` 9/9 exit 0 (`/tmp/assay-wf02-merged/`): format, lint, typecheck 20/20 forced, **237 files / 3531 tests**, coverage **89.13 / 83.88 / 91.47 / 90.73**, build 12/12 forced, links 141/0, ADR index 46, browser **249 passed + 1 skipped, 0 failed, 0 flaky**. No failed run; nothing retried to green.

**Mutation / negative control.** Worker drill A (badge → `output`) and drill B (heading → `Completed before the stop:`) each failed the intended assertion at the built `dist` after `build --force`, then restored byte-identically (`sha256 2fe626c6…`, panel blob back to `f89b750`), rebuilt and went green with a clean tree. Reviewer added an **independent** drill the worker had not used (summary label → `endpoint`), failing `'1 terminal node'` at `pipeline-panel-journey.spec.ts:90` with `…· 1 endpoint node ·…`, restored byte-identically, 5/5 green, temporary worktree removed.

**Configured/restored telemetry legs:** **not applicable** — required only for App/header/CSS/modal/build-config changes (spec §6.2); the merged path list contains none. No configured endpoint was built, no collector was contacted, no token used.

**No semantic change proof:** `git diff --name-only 764151c..HEAD` is the four paths above; zero diff lines in `packages/**`, `pipeline-model.ts`, `pipeline-state.ts`, `usePipelineSession.ts`, `sanitize.ts`, `dcr-export.ts`, the runner, `index.css`, `App.tsx`, help copy, docs, or the lockfile. `pipeline-model.test.ts` `isOutput` expectations untouched. `Preview output`, schema/materialized-relation wording, candidate references and DCR/export copy byte-identical.

**Recorded limitations.** (1) Testids `pipeline-node-output` and `pipeline-run-gated-completed` keep their old names by approval — retained, not renames. (2) The count still comes from the unchanged `isOutput` derivation (`!consumed` over transform/sql inputs), so nodes read only by a validate/publish gate also count as terminal; WFD-08 leaves that derivation alone, and the changeset/tests/comments say so rather than implying a delivery count. (3) The 0-node grammar case is unreachable with real plans (asserted by construction, not by a fixture). (4) The summary singular assertion uses `toContain`, so it does not independently exclude a trailing `s` — the reviewer noted the ternary still renders the correct singular.

**Release-note wording:** the changeset says the three labels changed and that node sets, statuses, the derivation, the model, the runner, the IR and canonical bytes did not — no "outputs are now deliveries" claim.

**Final status:** WF-02 **CLOSED**. Next: read-only **WF-01P** matrix (then stop for WFD-06 approval), read-only **WF-05** design. Worktree/branch cleanup performed after the merged run.

## 7. Row WF-01P — read-only temporal matrix (delivered, decision pending)

**Status:** evidence delivered; **no implementation and no acceptance claim**. The artifact is
[reviews/2026-11-10-wf01p-temporal-matrix.md](../../reviews/2026-11-10-wf01p-temporal-matrix.md)
(read-only agent at `4051704`; main checkout byte-identical afterwards — verified: clean tree, no stray
worktree or branch). Nothing was patched, no fixture committed, no formatter/editor/test edited.

**Method actually used:** a throwaway detached worktree plus a probe-only Playwright page importing the
pinned app source, driving the real `DuckDbEngineClient` (DuckDB-WASM 1.32.0 → DuckDB v1.4.3, Arrow 17)
and `DuckDbGridProvider` base **and** overlay paths; synthetic Parquet built with `/tmp/duckdb`; 44 live
expressions, 27 columns × 2 rows, 152 described cells, plus alias/precision/profile/Record probes. All
matrix values were machine-rendered from the captured probe JSON.

**Load-bearing observations (all observed, not inferred):**

1. `DATE`, `TIMESTAMP` and `TIMESTAMP WITH TIME ZONE` all arrive as **numbers in epoch ms**; `TIMESTAMP`
   can be **fractional** (`…123.456`). `TIME` arrives as **bigint microseconds-since-midnight**.
   `formatCell`'s `instanceof Date` branch is therefore **dead code** for engine payloads (0 of 152 cells).
2. Base and overlay projections are **identical** for all 27 columns (same Arrow unit, same JS shape);
   the only divergence is a failure, not a value (see 4).
3. `TIMESTAMP_S`/`TIMESTAMP_MS` collapse to `TIMESTAMP` after a Parquet round-trip; `TIMESTAMP_NS` keeps
   `NANOSECOND` and its sub-millisecond digits are **already lost** in delivery (`delivered*1000`
   non-integral). `TIMESTAMPTZ`/`TIMETZ` offsets are **unrecoverable** — the Arrow type carries no zone
   and DuckDB text is already `+00` / zone-free.
4. `TIMESTAMP 'infinity'` **throws inside Arrow's accessor during projection** (both paths) — it never
   reaches a formatter, so no scalar formatter can cover it; fixing it needs the projection/engine
   boundary, which WF-01P is forbidden to touch. Reported as a blocker, not silently absorbed.
5. Grid display and focused copy are already in **perfect parity** (151/151 pairs); the **editor draft
   already renders temporal values correctly** (`temporalDraft`), and extracting that helper into the
   formatter is **byte-equivalent** for editor seeds — but it inherits ms truncation, a
   `-0.001 → 1970-01-01T00:00:00.000Z` snap, and NS display at ms.
6. Consumers with **no** declared type: SQL results (`formatCell(cell)`) and the Record tree
   (`RecordRowInput` has no type channel). Nested preview receives the type but ignores it for temporals.
   These stay **WF-O2**, as WFD-06 scope A already says.

**The one decision this row needs (WFD-06):** either display fractional-millisecond payloads at ms
precision by reusing `temporalDraft` byte-for-byte (accepting truncation and the negative-sub-ms snap),
or fall back to the raw delivered number whenever `delivered*1000` is not an integer (bit-honest, but the
grid would then disagree with the editor draft for those cells). Everything else in the observed matrix
supports the direction already recorded as WFD-06=A.

**Not verified (explicit):** named-timezone `AT TIME ZONE` conversion (ICU not pinned/available), no
React-rendered panel, no file-picker journey, no CSV/JSONL temporal sniffing, no clipboard/DOM-title
observation, editor submission/export fidelity untested. Browser locale was Asia/Singapore while delivery
was timezone-independent — a useful control, not a non-UTC-display proof.

**Final status:** WF-01P **DELIVERED**; WF-01 remains **BLOCKED** pending the approval above.
