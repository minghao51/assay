# WF-10 — selected-scope acceptance and closure (2026-11-10)

**Scope of this closure:** only the rows the maintainer selected and approved on 2026-11-10 — **WF-00,
WF-01P, WF-02, WF-01, WF-05** — plus the lifetime decision recorded as **ADR 0047**. It is **not** a claim that
the web-interface follow-up is complete, that every SVG board is implemented, or that any participant or
assistive-technology evidence exists.

Authority: [approval record](20261110-web-followup-approval.md) (WFD-09 selection, WFD-06=B, M-D1…M-D12 sign-off),
[map](20261110-web-followup-map.md) §3 (row register), [spec](../../product/14-web-interface-followup-spec.md) §3
(T-WF acceptance) and §7 (closure rules).

## 1. Requirement-by-requirement trace

| Requirement | Selected?         | Evidence (actual, not inherited)                                                                                                                                                                                                                                                                                                                              | Status                                     |
| ----------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| **T-WF00**  | yes               | `76c1945` clean tree; ten gates green; all 17 boards classified in [audit §3](../../reviews/2026-11-10-web-svg-followup-audit.md); residual crosswalk in [map §4](20261110-web-followup-map.md); approved-subset manifest in the [approval record](20261110-web-followup-approval.md) §3.2                                                                    | **CLOSED**                                 |
| **T-WF01P** | yes               | Read-only matrix at `4051704` in [reviews/2026-11-10-wf01p-temporal-matrix.md](../../reviews/2026-11-10-wf01p-temporal-matrix.md): real-engine observations (DuckDB-WASM 1.32 → DuckDB v1.4.3, Arrow 17), 44 live expressions, 27 columns × 2 rows, 152 cells; main checkout byte-identical; no source/test/fixture edit; `/tmp` probes and commands recorded | **DELIVERED**                              |
| **T-WF01**  | yes               | `b4e0cc3` + `b6b773d` (worker `9ca0328` → `2209663`); independent Luna xhigh review: one request-changes round (precision hole) then approve; merged gates 9/9 at `b6b773d`; contract conformance re-derived by the reviewer; fixture integrity proven (four pre-existing fixtures byte-identical); four mutation drills                                      | **CLOSED**                                 |
| **T-WF02**  | yes               | `b65e304` (worker `855114a`); independent Luna xhigh review **approve** with zero findings; merged gates 9/9; three mutation drills including the reviewer's independent one; node sets/statuses/model/runner/canonical bytes proven unchanged                                                                                                                | **CLOSED**                                 |
| **T-WF05**  | yes (design)      | Design delivered at `c883b42`; two independent reviews (second unanchored) adopted with **three amendments** (A1 candidate-overlay isolation, A2 clean-path editor authority, A3 lifetime); the A3 question is settled by **ADR 0047**; the A1/A2 revision of the transition table is the only remaining design work                                          | **SIGNED — contract revision in progress** |
| **T-WF10**  | yes (this record) | This trace; not a substitute for any row's evidence                                                                                                                                                                                                                                                                                                           | **CLOSED for the selected subset**         |

## 2. Gate ledger (measured at each revision)

| Revision  | What            | Gates        | Unit             | Coverage (st/branch/fn/line)  | Browser      | Links / ADR  |
| --------- | --------------- | ------------ | ---------------- | ----------------------------- | ------------ | ------------ |
| `76c1945` | WF-00 preflight | 10/10 exit 0 | 237 files / 3531 | 89.13 / 83.88 / 91.47 / 90.73 | 249 + 1 skip | 140–141 / 46 |
| `b65e304` | WF-02 merged    | 9/9 exit 0   | 237 files / 3531 | 89.13 / 83.88 / 91.47 / 90.73 | 249 + 1 skip | 141 / 46     |
| `b6b773d` | WF-01 merged    | 9/9 exit 0   | 238 files / 3554 | 89.15 / 83.92 / 91.49 / 90.75 | 253 + 1 skip | 144 / 47     |

No run was retried to green; every failed run is recorded in the row's integration record (there were reviewer
request-changes rounds, not red gates). Logs: `/tmp/assay-wf00/`, `/tmp/assay-wf-02-logs/`,
`/tmp/assay-wf-02-review-logs/`, `/tmp/assay-wf02-merged/`, `/tmp/assay-wf-01-logs/`,
`/tmp/assay-wf-01-review-logs/`, `/tmp/assay-wf01-merged/` (ephemeral; the records carry the numbers).

## 3. What this closure does **not** claim

- **No human or assistive-technology evidence.** RD-T07 stands: no participants, no AT review, no usability
  result. Screenshots or gate counts are not a study.
- **No "all temporal displays fixed".** Nested cell previews, the Record tree (no declared-type channel) and
  untyped SQL results still render raw temporals — **WF-O2**, unselected, pinned by tests so it cannot be
  widened silently.
- **No pipeline semantics change.** WF-02 changed three visible strings; terminal-node counts are still
  `isOutput`-derived and deliberately unchanged (D-14). A terminal node is not a delivery.
- **No replacement safety.** WF-06 is not implemented and has no runtime authority; today's app still destroys a
  ready session when the picker is cancelled, and leaks a registered table on post-`engine.open` failures.
- **No layout change.** ADR 0044 stands; no pane/geometry/SQL-sizing change was made or studied.
- **No atlas parity, hosted/AI/governance features, or release/push authorization.**

## 4. Residual register carried forward (nothing here is "done by association")

| Item                                                                   | State                                                                                        | Owner / gate                                                                     |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `TIMESTAMP 'infinity'`                                                 | Throws inside Arrow's accessor during projection (base **and** overlay) before any formatter | Separate projection-boundary blocker; no row owns it yet; needs its own decision |
| Display vs editor draft for sub-ms cells                               | Intentional divergence, approved under WFD-06=B                                              | Documented; pinned in the WF-01 browser spec                                     |
| Near-epoch sub-ms µs values                                            | Render raw (float rounding fails the integrality guard)                                      | Accepted trade-off, documented in approval record §9                             |
| WF-O2 temporal parity                                                  | Unselected; needs a type-propagation contract for nested/Record/SQL                          | Decision required                                                                |
| WF-06 replacement runtime                                              | BLOCKED: needs A1/A2 in the contract (in progress) **and** explicit runtime authorization    | Maintainer                                                                       |
| WF-03 shell/panel, WF-04 context actions, WF-07 range text             | Unselected; need WFD-05 / WFD-03 / WFD-07 decisions respectively                             | Maintainer                                                                       |
| WF-08 layout study, WF-09 alternate layout, WF-O1 filter-draft clarity | Unselected; WF-09 also needs a superseding ADR                                               | Maintainer                                                                       |
| ADR 0047 retention limitation                                          | Accepted: unbounded in-process table/file retention until `dispose()`                        | Superseded only by an authorized release primitive                               |
| D-06 staged-B reopen, D-11 run origin, SV-D02/03/04/05, SV-F01…F07     | Deferred/unselected                                                                          | Horizon register ([map §4](20261110-web-followup-map.md))                        |
| Pipeline labels                                                        | Fixed in WF-02 (`b65e304`)                                                                   | CLOSED                                                                           |
| rd-0…rd-7, rd-3b/3c, hf-1, D-10                                        | Closed earlier; evidence preserved                                                           | Not re-dispatched                                                                |

## 5. Closure statement

For the approved subset, every selected requirement traces to a merged commit with worker, reviewer and merged
evidence, or to an explicit read-only artifact with its commands recorded. Every unselected requirement, every
deliberate limitation and every deferred decision remains listed above rather than being marked done. WF-10 is
therefore **CLOSED for the selected subset**; a future selection reopens a new closure with its own denominator.
