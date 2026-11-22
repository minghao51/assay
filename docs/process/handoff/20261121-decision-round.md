# 2026-11-21 decision round — remaining decision-first rows

**Date:** 2026-11-21. **Status:** decisions recorded under the maintainer's instruction to proceed
without a further approval round ("do we still need node 22 floor? if not we just need to proceed with
node 24.x … proceed with the remaining items with your best judgement"). This record **decides**
rows that the [successor queue](20261121-successor-queue.md) §1/§4 classified as decision-first and
the [RD decision sheet](20261104-rd-open-decisions.md) §1 left open. It does not claim usability
evidence, release authority or any human action.

**Authority order unchanged:** accepted ADRs → the living [handoff](../handoff.md) current-state block
→ dated records → this file. Where a decision would need an ADR, the ADR is named and **not** written
here.

## 1. Node floor — answered: Node 22 is not needed (C4)

**Decision: the product floor is Node 24, the line every gate runs on.** The `node: ">=22"` floor
declared in twelve manifests was never exercised (this environment has only Node 24.13.0; the
[node support contract](20261120-node-support-contract.md) recorded that limitation rather than a
pass). No product behaviour needs 22 only, and no consumer is known to run it. The range is now
`"^24.0.0"` on `apps/{cli,web,vscode}` and the nine publishable library packages, with the development
policy (`^24.0.0`) and `.node-version` (`24`) unchanged.

- **Claim shape:** `^24.0.0`, not a bare `>=` floor — the first draft of this change used `>=24`,
  and the independent review correctly rejected it: a `>=` range also accepts Node 25+, which no gate
  runs and which is exactly the unverified-claim shape that made `>=22` wrong. The caret admits 24.x
  patches/minors (24.13.0 is the tested runtime; no individual minor is claimed) and nothing later.
- **Enforced, not just documented:** `pnpm current-state:check` now has fact 6 `product-node-floor` —
  every manifest that declares `engines.node` must equal the root line, and the three shipped apps must
  declare one, so a silent drift back to `>=22` (or a dropped field) fails the gate.
- **No released artifact is narrowed:** nothing is published yet, so a major bump would only
  manufacture a `1.0.0`. Recorded as minor in `.changeset/c4-node-floor-24.md`, which states that a
  published version would have made this a major.
- **If a Node 22 consumer ever appears:** re-widening is a manifest change plus a 22-line gate run; the
  contract keeps that path explicit.

## 2. Webview coverage (C1) — collect, no invented floor

`apps/vscode/webview/**` (minus the `test-proof` harness) is now inside the coverage denominator. The
measured artifact separates unit-covered controllers (validation-panel 89.5 %, dirty-history 84.4 %,
diff-panel 81.6 %, dom 75 %, grid-provider 50 %, data-grid 45 % of lines) from boot/entry files at
0 %, whose only real execution is the pinned extension host. **No webview-specific floor is set** — a
floor over the whole glob would be satisfiable by the controllers while every boot file stayed at
0 %. The global floor now includes these files, so a controller regression is enforced. Totals moved
from 90.26/85.07/92.18/91.96 to **86.19/81.46/87.79/87.67** against floors 83/76/80/84: the old
numbers measured a narrower include, the new ones measure the product as shipped, and no floor was
lowered or raised for it. Full reasoning: [assurance map §4.2](../../engineering/11-assurance-coverage-map.md).

## 3. RD sheet — recommendations accepted as decisions

The sheet's own recommendations are the reasoned options; each is now **accepted**, with the
consequence and the reopen trigger stated so nobody re-decides silently.

| Item                                       | Decision                                              | Consequence / reopen trigger                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------ | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D-01** rd-6 scope                        | **A** — reuse shipped surfaces                        | rd is complete; B (DCR inspector) only on demand, with its lifetime question                                                                                                                                                                                                                                                                                      |
| **D-02** RD-T07 human evidence             | **A** — explicit accepted limitation                  | No "validated"/"intuitive"/"easier" wording in docs, release notes or copy. Reopen only by running the prepared 5–8 participant protocol                                                                                                                                                                                                                          |
| **D-03** rd-7 Help                         | already resolved 2026-11-04 (A, copy byte-approved)   | no change                                                                                                                                                                                                                                                                                                                                                         |
| **D-04** rd-7 performance budget           | **A** — pin measured counts, no wall-clock thresholds | C3 adds a second bundle baseline; a threshold follows a measured regression, not a guess                                                                                                                                                                                                                                                                          |
| **D-05** web WASM extensions offline       | **A** — leave the documented CDN autoload             | The privacy promise ("data doesn't leave the machine") holds; the offline limitation stays in product/09 R-05. Reopen if launch copy promises offline web use                                                                                                                                                                                                     |
| **D-06** staged-comparison indicator       | **A** — leave the recorded gap                        | Reopen if a journey or a study shows it bites; option B is small and scoped                                                                                                                                                                                                                                                                                       |
| **D-07** dirty-replacement guard           | **A** — defer                                         | WF-06 already preserves the live session across picker cancel and candidate failure; the residual is an explicit dirty-edit modal, which nothing measured asks for                                                                                                                                                                                                |
| **D-08** SQL sizing                        | **A** — defer (uxv-6)                                 | No evidence; the deferral is deliberate and unchanged                                                                                                                                                                                                                                                                                                             |
| **D-09** overlay-aware profiling           | **A** — defer                                         | It changes what a number means; needs an engine/client/state consistency contract first                                                                                                                                                                                                                                                                           |
| **D-10** VS Code format truth              | **CLOSED by evidence**                                | Verified 2026-11-21: the manifest contributes exactly `*.parquet`, `*.csv`, `*.jsonl`/`*.ndjson`, `*.json`; the README states Arrow-family **input** (`.arrow`, `.feather`, `.ipc`) is not offered and why (`detectFileFormat` returns `null`). Arrow **export** is a real engine format (`isExportFormat` accepts it), so the export option is not a false claim |
| **D-11** run-origin metadata               | **A** — leave open                                    | The current stale wording avoids implying origin; reopen only if a user needs to distinguish run origins                                                                                                                                                                                                                                                          |
| **D-12** release / publication             | **B** for push, **C** not authorized                  | Pushing `main` to `origin` is now established practice (and this batch did it). A release cut still needs the publication/registry policy and the human steps in §4 — no release is authorized by this record                                                                                                                                                     |
| **D-13** "completed before the stop" label | **CLOSED by WF-02**                                   | Verified 2026-11-21: the section is `Recorded node outcomes:`, which does not claim completion for a gate-blocked node                                                                                                                                                                                                                                            |
| **D-14** "N outputs" count                 | **CLOSED by WF-02**                                   | Verified 2026-11-21: the summary reads `N terminal node(s)`, and terminal nodes are badged `terminal` — the count now says what it counts                                                                                                                                                                                                                         |
| **U-1** unbounded replacement waits        | **No timeout; keep fail-closed**                      | A UI timer cannot interrupt a DuckDB-WASM call (ADR 0040; B7 finds the cancel API but its mid-execution effect is unverified). An "unavailable" state before a real interrupt would be a claim the engine cannot keep. Reopen **with B7**, and only after a probe shows the interrupt works                                                                       |
| **P4** adapter priority                    | **No adapter until user demand**                      | dbt/SQLMesh/Dagster runtimes stay out of `packages/pipeline` (ADRs 0031/0032); the decision is demand-driven and recorded here so it is not re-litigated                                                                                                                                                                                                          |

## 4. Still human (cannot be done from the repository)

- **Publication / registry policy, first release** — private vs public registry, the flip timing and
  the 229-entry changeset ledger; needs the publish runbook plus a versioned release decision.
- **npm `@assay` org**, **trademark/domain**, **telemetry collector hosting**, **demo dataset source** —
  external accounts/legal/procurement.
- **GitHub Actions billing** — until it is restored, every push shows four job-start refusals; the
  local gate suite, the pinned host and the pack smoke remain the verification authority.
- **RD-T07 human study** (D-02 A) — recruitment and compensation are human tasks; the accepted
  limitation is the honest alternative until then.

## 5. What remains deferred by decision (not by neglect)

WF-03/04/07/08/09 (shell/panel presentation, contextual next action, visible row range, layout study),
WF-O2 (nested/Record/SQL temporal parity), uxv-6 (adjustable SQL sizing) and the overlay-aware profile
candidate each need an itemized WFD design plus usability evidence that does not exist (D-02). They
stay **decided-not-now**: no runtime row is authorised, ADR 0044's grid-centric layout stands, and any
of them can be reopened by naming the WFD option and the evidence it answers.
