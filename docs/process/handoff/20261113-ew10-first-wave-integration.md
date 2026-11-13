# EW-10 — essential-workbench first-wave integration record

**Date:** 2026-11-13. **Status:** selected first wave **CLOSED**: WF-06 merged-green; EW-02D, EW-03D and
EW-04D delivered as reviewed design-only contracts. This record traces the selected denominator only.
It does not close, broaden or re-open any other queue, and nothing here is a usability, benchmark,
offline or remote-CI claim.

**Authority:** accepted ADRs → [dated selection](20261113-essential-workbench-pickup.md) →
[specification](../../product/16-essential-workbench-first-wave-spec.md) §2–§3 and IC-01…05 →
[WF-05 v5 contract](20261110-wf05-replacement-contract.md) → proposal/research/history.

## 1. EW-00 — baseline (CLOSED)

- **Baseline:** `c841fe4332a980ccd6a926b4e7520104068af70a`, clean. Delta from planning anchor
  `5466470` = 3 commits, docs/SVG only (no `apps/**` or `packages/**`), so v5 citations stayed valid.
- **Fresh gates** (not reused November counts): format/lint 0; forced typecheck **20/20, 0 cached**;
  unit **238 files / 3554 tests**; coverage **89.15 / 83.92 / 91.49 / 90.75**; forced build **12/12,
  0 cached**; docs links **150/0**; ADR **47**; browser **253 passed + 1 skipped**; configured
  telemetry **7 passed**, endpoint present, collector POSTs aborted, **zero delivered**; restored
  stock endpoint **absent**, **65 passed**. Logs `/tmp/assay-ew00-logs/`.
- Preflight matched v5 R2/K04 exactly (`beginSession(` 4 lines without the test filter, 5 with).
- Dispatch envelope filled (`/tmp/assay-ew/dispatch-envelope.md`); worktree/branch and free ports
  reserved before any code.

## 2. WF-06 — session-preservation runtime (MERGED)

- **Row/authority:** WF-06 (= EW-01), spec §3 + v5 C1–C16/G1–G6/T0–T11/N1–N17/K01–K43, IC-01…05.
- **SHAs:** baseline `c841fe4` → worker `3b84bf7` (feat) → `2eebfc9`, `dcda9bf`, `d4526ba` (review
  fixes) → **integrated `ba36091`** on `main` (cherry-picked with `-x`; tree parity with the branch
  verified for `apps/`, `tests/`, `.changeset/`).
- **Roles:** worker `opencode-go/deepseek-v4.1-flash` (thinking high) in worktree
  `../dataworkbench-wf-06`; independent reviewer `openai-codex/gpt-6-luna` (thinking xhigh, fresh
  sessions). No participant approved its own work.
- **Amendments (orchestrator-granted, reviewer-verified, test-only):**
  - **A1** — five pre-existing App unit tests whose scenarios the reviewed lifecycle replaces
    (`App.{grid-busy,history-shortcut,panel-boundary,profile-filter,section-purposes}.test.tsx`):
    four setup-only, one contract-mandated assertion replacement in `App.grid-busy` (G5 makes "open
    while a filter epoch is in flight" unreachable; the replacement also kept epoch-retirement
    coverage on the reachable adoption path).
  - **A2** — two setup lines in `App.telemetry.test.tsx` (dismiss the first-run disclosure before the
    open gesture; assertions byte-identical) needed once K17 correctly disabled Open behind any owned
    modal in `idle`.
- **Changed paths (28):** `apps/web/src/{App.tsx,index.css}`, `replace/{gate,machine,messages}.ts`,
  `replace/ReplaceGuard.tsx`, `edit/session.ts`, `sessions/useEditingSession.ts`,
  `grid/provider.ts`, `grid/DataGrid.tsx`, `schema/SchemaPanel.tsx`, the named new/updated tests and
  `tests/e2e/replace-guard.spec.ts`, `.changeset/wf-06-session-preservation.md`, plus the five A1 files
  and `App.telemetry.test.tsx` (A2). No `packages/**`, `export/**`, `session-reset.ts`, `types.ts`,
  telemetry or config change; no new dependency or fixture.
- **Focused evidence:** G1–G6 gate order and synchrony (editor ref incl. boolean, mutation counter,
  aggregate cast set, settled-history dirty), C1–C16 byte-exact copy, native `<dialog>` guard with
  Stay/Escape and export-first, candidate-local overlay (negative distinct-schema assertion), order
  reset → republish → rebind → phase → intent, synchronous adopt with no `model.refresh()`, late-result
  seq+phase rejection, inert/busy with explicit progress focus, C13/C15/C16 lifecycle-derived from
  their own observables (C15 precedence, no auto-resume), C14 closed `details`/`pre` scoping with
  zero app-initiated clipboard writes and an unsuppressed user copy, ADR 0047 retention stated
  without a bound, dataset-keyed panels so adoption (not preparation) discards SQL/filter/rename/cast
  drafts. `beginSession(` call expressions: **5** source matches / **6** including tests (one new).
- **Negative controls (reviewer-run, restored byte-identically with sha256 + rebuild):** drop the G3
  refusal; drop the G4/cast-clear rule; remove the SQL dataset key; remove the synchronous
  `dialog.close()`; point the candidate provider at the live overlay closure (browser check expected 2
  rows, received 5); make C16 clear on a G3 refusal (regression to the round-2 bug); make C15/C16
  gesture-only; remove the N9 second-schema injection. Each failed its targeted assertion.
- **Merged gates at `ba36091`** (`/tmp/assay-ew-wf06-merged-logs/`): format/lint 0 · forced typecheck
  **20/20, 0 cached** · unit **245 files / 3629 tests** · coverage **89.31 / 84.02 / 91.65 / 90.97**
  (floors 83/76/80/84) · forced build **12/12, 0 cached** · docs **153/0** · ADR **47** · browser
  **264 passed + 1 skipped, 0 failed** · configured telemetry **7 passed**, endpoint present in
  `dist`, 4 collector POSTs intercepted and aborted, **zero delivered** · restored stock endpoint
  **absent**, **76 passed**.
- **Review rounds:** three. Round 1 request-changes (T8 draft disposal at adoption, T5 picker before
  guard close, state write before gate, N17 non-committing case, N14 timeout widening, K17 idle
  phase, N9 wrong injection, N16 user-copy half, K14 under-assertion). Round 2 request-changes
  (C15/C16 could be cleared by a higher-priority refusal; N9 still not a provider/model-load failure;
  A1 report gap). Round 3 **approve**, with one non-blocking nit recorded below.

## 3. EW-02D — scope/copy contract (DELIVERED, integrated `b220e3e`)

- **Deliverable:** [`20261113-ew02-scope-contract.md`](20261113-ew02-scope-contract.md) — six surfaces
  (Profile, SQL, pipeline binding, validation, mixed-scope diff, export), exact current strings, true
  relations, triggers, DOM placement, state applicability, independent literal assertions and a future
  reservation. **49 RETAIN / 3 append-only proposals** (SQL hint names the base view excluding staged
  edits/filters; validation intro names the whole edited dataset excluding filters/sorting; pipeline
  binding names the open-dataset action only). 9 collision boundaries reported; 3 decisions left to
  the maintainer (proposal wording, SQL pager disclosure, profile/filter symmetry).
- **Review:** 2 rounds (round 1: pipeline sentence was false on the picker path — fixed by scoping it
  to the action and returning the picker path to RETAIN). **Approved.** EW-02I stays blocked until the
  maintainer accepts exact copy and issues a runtime brief.

## 4. EW-03D — CSV interpretation contract (DELIVERED, integrated `56c3695`)

- **Deliverable:** [`20261113-ew03-csv-contract.md`](20261113-ew03-csv-contract.md) — browser-WASM
  probe transcript (duckdb-wasm 1.32.0 → DuckDB **v1.4.3** in the MVP worker; CLI 1.5.5 only as a
  control), parse-time lexeme findings, ownership/registration lifecycle with per-event retention,
  complete-check definition (per-column `try_cast` over the whole relation, not `count(*)`), and a
  **15-row decision ledger (D1–D15), all unresolved**.
- **Decisive blockers recorded:** every browser SQL error surfaces as
  `ReferenceError: _setThrew is not defined`, so failure classification needs pre-validation or a
  separate fix (D10); no protocol carries CSV options or a preview/sniff/cancel op (D12 needs an ADR);
  browser 1.4.3 ≠ CLI 1.5.5 (`store_rejects` diverges); quoted-empty vs empty is indistinguishable;
  repeated previews must not manufacture registered tables (ADR 0047).
- **Review:** 4 rounds (ownership over-claim; retention contradiction + wrong probe citation;
  adoption-delta contradiction) → **approved**. The spec §5 return gate stays closed.

## 5. EW-04D — bulk-repair contract (DELIVERED, integrated `696430e`)

- **Deliverable:** [`20261113-ew04-bulk-contract.md`](20261113-ew04-bulk-contract.md) — compact
  relational repair op composed as an emitted-once conditional wrap; **forward chronological
  prefix-fold semantics**; per-site SQL composition truth; provenance-tracked replay probe P8 with
  falsifying controls and a nonzero-exit gate; **17 decisions (D1–D17)** and a **conditional** verdict.
- **What the review forced (all corrections, no lost evidence):** the `O(mapping)` bound was wrong
  (per-branch wrapping ≈ 250,500 arms) → scoped to the two sites with an existing outer projection
  (window, export), with schema DESCRIBE and cast-check recorded as new work (D16) and insert literal
  rewrite as D17; the permutation property, the final-value CASE and the reverse-prefix order were all
  falsified in turn → forward composition with per-repair guards; the replay corpus was made
  domain-faithful (liveness-mirrored generation, applied-only masking, dead-target assertion) with
  controls reverse **893** / no-op-blind **530** / naive **2,939** failures against **27,258** passing
  checks; the probe now exits nonzero on any failure (proven by two mutants).
- **Verdict:** bounded atomicity is establishable **conditionally** on seven items: (i) wasm arm-class
  cost U4, (ii) D16 schema/cast-check composition, (iii) D17 literal-rewrite conformance, (iv) D15
  exception-set cap, (v) D14 undo-by-refold ADR, (vi) U1–U3 host paths, (vii) U5 real
  domain/composer behaviour. **No bulk runtime row is authorized.**
- **Review:** 7 rounds. EW-04D was the round's hard case; every reversal is preserved in the record.

## 6. Residuals carried forward (not fixed by this wave)

- `TIMESTAMP 'infinity'` projection boundary (no owning row); **RD-T07** (no human usability evidence);
  native chooser cancellation is RTL-only; N8 supersession is unit-only and unreachable in e2e; ADR
  0047 retention and registry size are not runtime-assertable (no introspection); download persistence
  is initiation-only; real-engine post-registration failure (N9/T9b) has no fixture.
- **New observation (EW-03D probe):** browser SQL errors are masked by
  `ReferenceError: _setThrew is not defined` — a pre-existing defect with no owning row. It is not
  fixed here; it needs its own row/decision (recorded, not absorbed).
- **Non-blocking review nit (WF-06):** the Export-overlap test calls Export open/close without
  invoking the ready gate, so it checks notice persistence across a modal overlap rather than a G1
  refusal; the G1 branch itself is covered by the gate matrix. Left as-is after approval (no
  post-review test edits without re-review).
- Unselected and untouched: EW-05…08, EW-02I/03I/04I, WF-03/04/07/08/09, WF-O1/O2, WFD-03/04/05/07,
  D-06/D-11, SQL sizing, overlay profiles, checkpoints, release/persistence work.

## 7. Status, cleanup, no-push statement

- **Status:** EW-10 CLOSED for the selected denominator. WF-06 is merged-green at `ba36091`;
  EW-02D/03D/04D are delivered with independent approval and integrated as documentation.
- **Cleanup:** worker branch `feat/wf-06-session-preservation` and worktree
  `../dataworkbench-wf-06` removed after merge; main checkout clean.
- **Nothing was pushed.** No release, publication, visibility, telemetry-semantic, dependency or
  ADR change was made. Design delivery is not implementation completion; the maintainer still owns
  every copy/proposal and every D-row.
