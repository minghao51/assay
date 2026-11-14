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

## 6. Residual register (accounted, not absorbed)

**Maintainer acceptance recorded 2026-11-13 (this session):** the boundary below is accepted as written —
EW-02I stays blocked on **exact copy acceptance plus a new runtime brief**; the EW-02D proposals, EW-03D's
15 decisions and EW-04D's 17 decisions plus its seven verdict conditions **remain maintainer-owned**;
EW-05…08 remain unselected. Acceptance of the boundary is not acceptance of any proposal, decision or
successor runtime row, and it authorizes no push, release or scope.

Each residual names an owner and the next concrete action, so nothing depends on remembering this record.
Rows marked **accepted** need no action to keep the selected wave closed; they must not be silently
"fixed" by a later row without its own brief.

| ID  | Residual                                                                                               | Why it is open                                                                                                                                                                                                                     | Owner                                                 | Next action                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| R1  | **Browser SQL errors are masked** (`ReferenceError: _setThrew is not defined`, EW-03D §6.1/D10)        | Pre-existing defect in the MVP worker glue, found by the CSV probe; there is no honest way to classify engine failures today                                                                                                       | maintainer + engine owner                             | Open a small engine/worker row (own ADR if the protocol changes). Not absorbed into this wave        |
| R2  | `TIMESTAMP 'infinity'`                                                                                 | Throws inside Arrow's accessor before any formatter; no owning row                                                                                                                                                                 | maintainer                                            | Decide projection-boundary vs formatter row (with WF-O2)                                             |
| R3  | **RD-T07 — human usability evidence**                                                                  | No participant or AT session exists; automation is not evidence                                                                                                                                                                    | maintainer                                            | Commission a study, or keep it recorded as an accepted limitation                                    |
| R4  | Native chooser cancellation                                                                            | Playwright cannot dismiss an OS chooser; RTL-mocked only                                                                                                                                                                           | accepted                                              | No action; keep the test header labelled                                                             |
| R5  | Candidate supersession (N8)                                                                            | Unreachable in e2e by design (one intent, no Cancel after candidate opening)                                                                                                                                                       | accepted                                              | No action; unit-only, declared in the spec header                                                    |
| R6  | ADR 0047 retention / registry size                                                                     | No protocol op reads the registry; not assertable at runtime                                                                                                                                                                       | accepted                                              | No action; stated without a bound                                                                    |
| R7  | Download persistence                                                                                   | Fallback leg only initiates a browser download                                                                                                                                                                                     | accepted                                              | No action; copy never says "saved"                                                                   |
| R8  | Real-engine post-registration failure (N9/T9b)                                                         | No committed fixture opens but fails to materialise                                                                                                                                                                                | maintainer                                            | Reserve a fixture if the case must be asserted; RTL injection covers the logic                       |
| R9  | WF-06 Export-overlap test description                                                                  | It checks notice persistence across a modal overlap, not a G1 refusal (source covered by the gate matrix)                                                                                                                          | accepted                                              | No post-approval test edit; correct only with a new reviewed change                                  |
| R10 | **EW-02D copy/decisions**                                                                              | 3 append-only proposals + 3 open questions (pager disclosure, profile/filter symmetry) are recommendations                                                                                                                         | maintainer                                            | Accept/decline exact strings, then issue an EW-02I brief with a fresh baseline                       |
| R11 | **EW-03D decisions D1–D15**                                                                            | Policy rows (delimiter/header/dupes/types/dates/quoted-empty/sample/full-check/identity/cancel/reuse/skip/unsafe-int/version) are unresolved                                                                                       | maintainer (+ engine owner for ADR-gated D10/D12/D15) | Decide the ledger; D12 needs its own ADR before any protocol change                                  |
| R12 | **EW-04D decisions D1–D17 + seven conditions**                                                         | Verdict is conditional on (i) wasm arm cost U4, (ii) D16 DESCRIBE/cast-check composition, (iii) D17 literal-rewrite conformance, (iv) D15 exception cap, (v) D14 undo-by-refold ADR, (vi) U1–U3 host paths, (vii) U5 real composer | maintainer (+ ADR for D14)                            | Resolve the seven items before any bulk-runtime brief; do not issue a brief from the SQL shape alone |
| R13 | **EW-05…08** and WF-03/04/07/08/09, WF-O1/O2, WFD-03/04/05/07, D-06/D-11, SQL sizing, overlay profiles | Proposal/decision-gated, not selected by the 2026-11-13 instruction                                                                                                                                                                | maintainer                                            | Unchanged; no implicit selection follows from this wave                                              |

**Update 2026-11-14 (post-wave):** residual **R1 is closed** — the maintainer selected it, ADR 0048
was accepted, and three reviewed runtime rows merged (`837b638` R1-C, `b0b78bc` R1-A, `5426979`
R1-B); EW-04D condition (i) U4 was then measured read-only. R2/R3/R8 and the EW-02D/03D/04D
decision ledgers are unchanged and still maintainer-owned; EW-05…08 remain unselected. Record:
[R1 masked engine errors](20261114-r1-masked-engine-errors.md) and
[U4 arm-class probe](20261114-u4-arm-class-probe.md). This paragraph is a status pointer, not a
re-opening of the wave.

## 7. Status, cleanup, no-push statement

- **Status:** EW-10 CLOSED for the selected denominator. WF-06 is merged-green at `ba36091`;
  EW-02D/03D/04D are delivered with independent approval and integrated as documentation.
- **Cleanup:** worker branch `feat/wf-06-session-preservation` and worktree
  `../dataworkbench-wf-06` removed after merge; main checkout clean.
- **Nothing was pushed.** No release, publication, visibility, telemetry-semantic, dependency or
  ADR change was made. Design delivery is not implementation completion; the maintainer still owns
  every copy/proposal and every D-row.

## 8. Handoff to the next pickup

**Rule zero:** this record is evidence, not authority. The next agent records its **own** clean SHA and
runs **fresh** gates — the counts above must never be reused as a current pass claim. Nothing here
authorises a runtime row, a push, a dependency or a decision.

**Read order:** `AGENTS.md` → [handoff](../handoff.md) §2/§6 → [operating model](operating-model.md) →
this record → the [pickup authority](20261113-essential-workbench-pickup.md) (dated selection, envelope,
stop rules) → [spec product/16](../../product/16-essential-workbench-first-wave-spec.md) → the contract for
the specific row ([EW-02D](20261113-ew02-scope-contract.md) · [EW-03D](20261113-ew03-csv-contract.md) ·
[EW-04D](20261113-ew04-bulk-contract.md)).

### 8.1 Maintainer decisions that unblock work (smallest first)

| #   | Decision                                                                                         | Unblocks                                   | Detail                                              |
| --- | ------------------------------------------------------------------------------------------------ | ------------------------------------------ | --------------------------------------------------- |
| D1  | Select **R1** (`_setThrew` masked SQL errors) as a defect row                                    | Honest failure text everywhere; EW-03D D10 | §6 R1; probe evidence EW-03D §6.1                   |
| D2  | Accept/decline the **3 EW-02D strings** + answer its 3 open questions                            | EW-02I brief                               | Contract §3/§8; 49 RETAIN rows need no code         |
| D3  | Resolve **EW-03D D1–D9, D11, D13, D14**; commission **D12's ADR**; settle **D15** version policy | EW-03I scope                               | Contract §8 ledger; D10 depends on D1               |
| D4  | Resolve **EW-04D D16/D17** (architecture), then **D14 ADR**, **D15 cap**, semantics D1–D13       | EW-04I brief                               | Contract §10; verdict is conditional on seven items |
| D5  | Decide whether to fund **U4** (wasm arm-class probe) and **U5** (real composer tests)            | EW-04D's conditional verdict               | Contract §9.1 U4/U5                                 |
| D6  | Decide **R2** (`TIMESTAMP 'infinity'` ownership) and **R3** (human study)                        | R2/R3 rows                                 | §6                                                  |
| D7  | Reserve a fixture only if real-engine **N9/T9b** must be asserted                                | R8                                         | §6                                                  |

### 8.2 Dispatch order once decisions land

Only one web-runtime writer may be CLAIMED at a time; design/investigation rows are read-only and may run
alongside. Each row needs a filled envelope, an independent reviewer (different model **and** thinking),
and fresh baseline gates.

1. **R1 investigation (read-only, no decision needed beyond selection):** root-cause why the MVP bundle
   throws `_setThrew is not defined`, compare the `eh`/`coi` bundles and worker glue, and return fix
   options (worker-glue shim vs engine upgrade vs pre-validation) with an ADR recommendation. No source
   change.
2. **R1 fix (runtime, small):** only after (1) and D1. Reservation: the worker glue/client error path and
   its tests; no protocol change without an ADR.
3. **EW-02I (runtime, small):** only after D2. Three append-only sentences + their literal tests, rebased
   on post-WF-06 main; nothing else changes.
4. **EW-03D → EW-03I (runtime, cross-package):** only after D3 and R1. Start from the contract's future
   reservation; D12 needs its own ADR before any protocol/option-carrier work.
5. **EW-04D → EW-04I (runtime, cross-package):** only after D4/D5. Start with D16/D17 and the U4 probe; do
   not issue a brief from the SQL shape alone.
6. **R2/R3/R8** as decided; **R13** stays unselected.

### 8.3 Paste-ready pickup prompt

```text
Pick up docs/process/handoff/20261113-ew10-first-wave-integration.md (the first-wave closure and
residual register). Read AGENTS.md, docs/process/handoff.md §2/§6 and the operating model, then
the first-wave pickup authority and product/16 before claiming anything. The EW-10 record is
evidence, not authority: record your own clean SHA and run fresh gates (do not reuse its counts).

WF-06 is merged at ba36091 and the three design contracts are integrated. Do not reopen them.
The maintainer accepted the boundary: EW-02I needs exact copy acceptance plus a new runtime brief;
EW-02D's proposals, EW-03D's 15 and EW-04D's 17 decisions (plus its seven verdict conditions) are
maintainer-owned; EW-05…08 stay unselected.

Start with the decision queue in §8.1. The only row that can begin without a new product decision is
the read-only R1 investigation (masked browser SQL errors: `ReferenceError: _setThrew is not
defined`). For every runtime row: fill a dispatch envelope, reserve a branch/worktree and free
ports, keep one web-runtime writer, run full stock + configured + restored gates, require an
independent reviewer with mutation controls, and stop rather than choose unresolved policy.
Never push.
```
