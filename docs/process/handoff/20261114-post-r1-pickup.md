# Post-R1 pickup — remaining work and paste-ready prompts

**Date:** 2026-11-14. **Status:** **R1 is CLOSED** (R1-C `837b638`, R1-A `b0b78bc`, R1-B `5426979`;
ADR 0048 Accepted); **EW-04D condition (i) U4 measured**; **nothing else is authorized**. This record
is the cold-pickup index for the next agent; it does not select any row.

**Authority order:** accepted ADRs → [EW-10 §8](20261113-ew10-first-wave-integration.md) dated selection
→ this record → the contracts ([EW-02D](20261113-ew02-scope-contract.md),
[EW-03D](20261113-ew03-csv-contract.md), [EW-04D](20261113-ew04-bulk-contract.md))
→ proposal/research/history. **Rule zero:** every record here
is evidence, not authority. Record your own clean SHA and run fresh gates; never reuse the counts
below as a current pass claim.

## 1. Verified state (2026-11-14, own observations at merge time)

| Row          | Merge            | Evidence                                                                                                                                                                                |
| ------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1-C         | `837b638`        | pre-commit edit-value refusal (serialized mutation chain, no unchecked path); 3 review rounds + comment-only verification; §3.7 of the [R1 record](20261114-r1-masked-engine-errors.md) |
| R1-A         | `b0b78bc`        | capability-guarded `eh`/`mvp` selection, real engine text, absolute `wasm_eh` pins; 2 review rounds; §3.9                                                                               |
| R1-B         | `5426979`        | desktop `eh`-only vendored set, `wasm_eh` autoload paths, drill evidence restored; 1 review + fix; §3.12                                                                                |
| U4           | `7211699` (docs) | CASE arms have no cliff near 500; export ~4.0 s at m=500/2 M rows; stacked multi-repair only; [U4 record](20261114-u4-arm-class-probe.md)                                               |
| Docs closure | `a0ec074`        | ADR 0048 Accepted, handoff §2/§6/§9, fixture comments, historical-doc pointer                                                                                                           |

Merged gates at `5426979`/`a0ec074` (recorded, not reusable): forced typecheck 20/20 (0 cached), unit
246 files / 3661 tests, coverage 89.34 / 84.05 / 91.66 / 91.00, forced build 12/12 (0 cached), docs
157/0, ADR 48, web browser 265 + 1 skipped, configured telemetry 7 passed / zero delivered, restored
stock 76 passed, package build 11 artifacts, runtime 9/9, real-VS-Code e2e PASS, normal and
`missing-extension` spikes exit 0, `eh-boot-failure` exit 1.

## 2. Remaining queue (decision-gated unless marked)

| #   | Item                                                                                                                                                                                           | Gate                                | Notes                                                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D2  | EW-02D: 3 append-only strings + 3 open questions                                                                                                                                               | maintainer accept/decline           | then an **EW-02I** brief (49 RETAIN rows need no code)                                                                                                    |
| D3  | EW-03D D1–D9, D11, D13, D14; **D12 ADR**; D15 version policy                                                                                                                                   | maintainer (+ engine owner for D12) | **D10 is unblocked** by R1's honest text; D12 needs its own ADR before any protocol/option carrier                                                        |
| D4  | EW-04D conditions (ii)–(vii): **D16** schema/cast-check composition, **D17** literal-rewrite conformance, **D15** exception cap, **D14** undo-by-refold ADR, U1–U3, **U5** real composer tests | maintainer (+ ADR for D14)          | plus the U4-driven **D11 qualifier**: the multi-repair composition must be _stacked projection layers_, and the export path needs a published cost budget |
| D5  | Fund U5 (real composer tests)                                                                                                                                                                  | maintainer                          | U4 is done; U5 is implementation-side                                                                                                                     |
| D6  | R2 `TIMESTAMP 'infinity'` ownership; R3 human study                                                                                                                                            | maintainer                          | R2 = projection-boundary vs formatter (with WF-O2); R3 = study or recorded limitation                                                                     |
| D7  | R8 fixture (real-engine N9/T9b)                                                                                                                                                                | maintainer                          | only if the case must be asserted                                                                                                                         |
| —   | EW-05…08, WF-03/04/07/08/09, WF-O1/O2, WFD-03/04/05/07, D-06/D-11, SQL sizing, overlay profiles                                                                                                | unselected                          | **R13 stays unselected**; no implicit selection                                                                                                           |

**Decision sheet (2026-11-14):** [20261114-post-r1-decision-sheet.md](20261114-post-r1-decision-sheet.md)
presents D2–D7 with options, costs, evidence and a non-binding recommendation per item, plus the
read-only probe scopes and the post-decision dispatch order. It selects nothing and authorizes no row.
**All recommendations were accepted on 2026-11-14** — see
[20261114-post-r1-decisions-accepted.md](20261114-post-r1-decisions-accepted.md) for the acceptance record
and the resulting authorizations (EW-02I, U5, the read-only probes, the D12/D14 ADR drafts, R2).
EW-03I still waits on the D12 ADR; EW-04I still waits on conditions (ii)–(vii).

**Read-only work that can start now (no new product decision needed once the maintainer asks):**
D16/D17 composition probe, R2 root-cause probe, D12 ADR draft (Proposed). Everything else needs the
decision first.

## 3. Dispatch order once decisions land

1. Read-only probes: **D16/D17** (informs D4) and **R2** (informs D6); **D12** ADR draft (informs D3).
2. **EW-02I** (after D2): three append-only sentences + literal tests, rebased on current main.
3. **EW-03D → EW-03I** (after D3 + D12 ADR): start from the contract's future reservation.
4. **EW-04D → EW-04I** (after D4/D5): D16/D17 + the U4-derived stacked composition + export budget;
   never issue a brief from the SQL shape alone.
5. R2/R3/R8 as decided.

Only one web-runtime writer may be CLAIMED at a time; read-only probes may run alongside with a
filled envelope and no source change.

## 4. Paste-ready prompts

### P0 — cold pickup (paste to the next orchestrator)

```text
Pick up docs/process/handoff/20261114-post-r1-pickup.md (post-R1 state, remaining queue, dispatch
order). Read AGENTS.md, docs/process/handoff.md §2/§6, the operating-model, then ADR 0048, the R1
record (20261114-r1-masked-engine-errors.md), the U4 record (20261114-u4-arm-class-probe.md), EW-10 §8
and the three EW contracts before claiming anything. These records are evidence, not authority:
record your own clean SHA and run fresh gates; do not reuse their counts.

R1 is CLOSED (R1-C 837b638, R1-A b0b78bc, R1-B 5426979; ADR 0048 Accepted) and EW-04D condition (i)
U4 is measured. Do not reopen them. Everything else is decision-gated: EW-02I needs accepted copy; the
EW-03D/04D ledgers and conditions are maintainer-owned; EW-05…08 stay unselected.

Start by producing a decision sheet for D2–D7 from §2 with options, costs, evidence and a
recommendation per item — present decisions, do not choose policy. Only the read-only probes may
begin without a new decision: D16/D17 composition, R2 root cause, D12 ADR draft (Proposed).
For every runtime row: fill a dispatch envelope, reserve a branch/worktree and free ports, keep one
web-runtime writer, run full stock + configured + restored gates on shifted ports, require an
independent reviewer (different model and thinking) with mutation controls, and stop rather than
choose unresolved policy. Never push.
```

### P1 — D16/D17 composition probe (read-only, no source change)

```text
Row: EW-04D conditions (ii) D16 and (iii) D17 — composition probe (read-only).
Authority: EW-04D §4.2/§4.4/§9.1, the U4 record, and the current composer in
packages/engine-duckdb/src/overlay-query.ts (window/export projection, insert branches, schema
DESCRIBE, cast-check).
Deliverable (a dated handoff record; probes/artifacts under /tmp):
1. For each site, the exact composed SQL under (a) the wrapped DESCRIBE / wrapped cast-check shapes
   and (b) the compose-time literal rewrite for insert branches — with the emitted-SQL-size argument
   for multi-repair (stacked projection layers only, per U4).
2. Correctness/conformance cases the §11 tests would need to pin each shape (schema type preservation,
   TRY_CAST/exception arms, trim/CASE semantics, literal escaping, no reserved-name shadowing).
3. Costs at the U4 shape: planner vs executor, with the export/full-scan budget stated.
4. A recommendation per D16/D17, and any ADR candidate (e.g. D14) — but no protocol change and no
   source edit in this row.
Gates: docs-only (format, docs links, ADR index, git diff --check); no runtime claim. Never push.
```

### P2 — R2 `TIMESTAMP 'infinity'` probe (read-only)

```text
Row: R2 — `TIMESTAMP 'infinity'` throws inside Arrow's accessor before any formatter (no owning row).
Authority: EW-10 §6 R2, the WF-01 exact-precision record, product/14 temporal rules.
Deliverable: a reproducer and root cause (which Arrow accessor/path fails; projection boundary vs
formatter), the exact-precision constraint it must not break (WF-01: a TIMESTAMP_NS is rendered raw),
and 2–3 fix options (projection-boundary clamp vs formatter guard, with WF-O2 interaction) with cost,
risk and a recommendation. No source change; probes under /tmp; record with the docs gates only.
```

### P3 — EW-03D D12 ADR draft (Proposed, no implementation)

```text
Row: EW-03D D12 — CSV options / preview-sniff / cancel protocol (Proposed ADR, next free number).
Authority: EW-03D §2.1/§6.2/§8-D12, ADRs 0020/0040/0047, the shipped engine protocol
(packages/engine-duckdb/src/protocol.ts) — read-only.
Deliverable: a Proposed ADR that carries exactly the options the allowlist needs, the preview/sniff
semantics and retention (ADR 0047 honesty), cancellation/abandon, and the browser-vs-CLI version
boundary; explicit open questions for the maintainer. No protocol or source change; docs-only gates.
```

### P4 — EW-02I implementation (ONLY after D2: exact copy accepted + this brief issued)

```text
Row: EW-02I — implement ONLY the accepted EW-02D copy/scope. The 49 RETAIN rows need no code.
Authority: the maintainer's written acceptance of the three append-only sentences and answers to the
three open questions (paste them into the brief), EW-02D §3/§8, ADR 0048 decision 2.
Workspace: branch/worktree from the current clean main; shifted ports; one writer.
Allowed: the six copy surfaces named in the accepted table and their literal tests; nothing else.
Done-when: byte-exact strings in the accepted DOM placements, literal assertions (set equality, no
"contains"), the existing semantics unchanged, one changeset.
Gates: format, lint, forced typecheck (0 cached), unit, coverage floors, forced build (0 cached), docs
links, ADR index, full browser suite, configured + restored telemetry legs; independent reviewer with
mutation controls (delete/reword one accepted sentence → the literal test fails). Never push.
```

### P5 — generic runtime row (instantiate for EW-03I or EW-04I once D3/D4/D5 land)

```text
Row: <EW-03I | EW-04I> — <one sentence>. Authority: <contract §future reservation + the maintainer's
dated decisions, quoted>. Read the contract, the relevant ADRs and the current source before claiming.
Envelope: baseline SHA + clean proof; branch/worktree; stock/configured/restored ports (shifted);
allowed + forbidden paths; named behavior; evidence required.
Constraints: one web-runtime writer; no dependency/lockfile change; no protocol change without its
own accepted ADR; no push; stop on unresolved policy.
For EW-04I additionally: the multi-repair composition must be stacked projection layers (U4), the
export/full-scan budget must be stated, and D16/D17 must be decided before any code.
Gates: full stock + configured + restored; focused e2e/literal tests; independent reviewer with
mutation controls and byte-identical restoration; merged gates on main; record the row immediately.
```

### P6 — reviewer brief skeleton (for every runtime row)

```text
Read the worker brief, the worker report, the contract/ADR and the operating model §7.3. Verify by
running commands, not by reading diffs. Re-run every gate yourself on the assigned ports; compare with
the worker's claims, do not trust them. Drill at least two mutations (one per load-bearing claim),
restore byte-identically (sha256sum) and rebuild before browser re-checks. Check scope (allowed paths
only), no protocol/dependency drift, no dataset values/filenames in logs/telemetry, and that the
record's evidence is pasted, not asserted. End with exactly `VERDICT: approve` or
`VERDICT: request-changes` plus numbered, testable items. Never implement a fix yourself.
```

## 5. Do-not list and open risks

- Do not reopen R1, ADR 0048 or the U4 measurements; do not re-decide R1's support floor or the
  visible-text policy.
- Open risks to keep visible: the web build carries both wasm pairs (+~33.4 MiB raw; one fetched per
  session) to keep non-EH browsers working; non-EH browsers keep the opaque fallback; no
  boot-failure retry; `row-insert` is uncovered; one extra engine round-trip per applied cell edit;
  the desktop package keeps the `mvp` fixture pins for the web e2e (not shipped).
- No push, release, publication, visibility or telemetry-semantic change follows from this record.
