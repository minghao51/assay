# Post-MVP Track — Assay

**Status:** living document — defines the work tracks that start now that the MVP feature
milestones (M0–M6) are complete. Created 2026-09-21 after the maintainer decision to move the
VS Code surface (former milestone M7) out of the MVP and into this track. The
[execution roadmap](10-execution-roadmap.md) stays canonical for sequencing and gates; this
document details the post-MVP structure and carries the launch-readiness checklist that gate
**G0** requires. Decision record: [roadmap §7](10-execution-roadmap.md) (D11) and
[handoff §9](../process/handoff.md).

---

## 1. Why the MVP was re-scoped (decision record)

- The original MVP definition (docs 07) was "M0–M6 + the VS Code surface of M7". M0–M6 are
  **complete** (2026-09-21, exit journey green, exact web≡CLI agreement on validation _and_
  diff).
- The maintainer decided (2026-09-21) that the remaining VS Code surface no longer blocks MVP
  status: the product's core loop — inspect → edit → validate → diff, with identical results
  across the web and CLI surfaces — is proven, and deferring M7 keeps launch readiness from
  being gated on VS Code webview feasibility (risk R4) and extension-marketplace logistics.
- Consequence: **the MVP is M0–M6, and it is done.** Everything below is post-MVP. Nothing in
  the accepted ADRs or the decision ledger changes; this is a sequencing decision (D11).
- Docs 07 keeps its historical text (it predates the Assay rename); a dated annotation at its
  top points here. Scenarios in docs 07 that reference VS Code (e.g. "open the same workflow in
  VS Code") are post-MVP acceptance criteria for PT-V, not MVP gaps.

## 2. Where things stand (evidence base, 2026-09-21)

- **Surfaces:** web app (inspect/nested/edit/export/validate/diff), CLI (`assay validate`,
  `assay diff`), shared pure packages (`@assay/domain`, `@assay/contracts`, `@assay/validation`,
  `@assay/diff`), engine (DuckDB-WASM in the browser worker + `@duckdb/node-api` behind the
  `./node` seam for the CLI, ADR 0041), headless grid (ADR 0022), data-sources with
  capability detection. `apps/vscode` is a placeholder.
- **Quality posture:** six gates green at every integration (vitest 1688, e2e 128 + 1 skip,
  typecheck 18/18, build 3/3); engine conformance suite + data-source behavior suite +
  seeded property suites with exact non-vacuity pins; every milestone closed with an exit
  journey asserting cross-surface agreement (M5 validation, M6 diff); adversarial
  worker/reviewer protocol for every task (handoff §7).
- **Not yet done (all tracked, none blocking local use):** no telemetry implementation exists
  (design-only: ADR 0037 opt-out stance, ADR 0025 exclusions); no remote — the 155-commit
  `main` has never been pushed (CI authored but never run remotely); no npm org claim; no
  demo dataset; a11y CI not started.

## 3. Track structure

| Track                                  | Contents                                                                                                                                                                                                                     | Entry condition                                                   | Exit / gate                                                                                |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **PT-0 Launch readiness**              | the G0 checklist (§4): telemetry design tail (D2), GitHub push + remote CI (manual M2/M3), npm org (manual M1), trademark/domain (manual M4), demo dataset (O5), a11y CI (O3), security disclosure channel, docs/site basics | now                                                               | **G0** — required before any public launch                                                 |
| **PT-V VS Code extension** (former M7) | custom editors, workspace adapter, Git context, dataset diff command (roadmap §3.1 M7 row); ADRs 0008/0022                                                                                                                   | R4 webview feasibility spike first                                | parity subset e2e-proven in VS Code; MVP-acceptance scenarios of docs 07 that name VS Code |
| **PT-P Pipeline foundation** (P1–P2)   | P1: pipeline IR, DAG validation, source/SQL/transform nodes, DuckDB runner (ADRs 0029/0030/0032). P2: validation nodes, publish gates, preview, materialization, lineage (ADRs 0033/0035)                                    | **met** — roadmap §3.2 required "M2 and M5 stable"; both are done | P2 exit per docs 04 §17; P3+ (DCR integration) follows M9 scoping                          |
| **PT-H Hardening & backlog**           | recorded carry-overs (§6), scale/bench open questions, a11y, supply chain                                                                                                                                                    | any time (fills lanes between track tasks)                        | per-item                                                                                   |
| **Gated (unchanged)**                  | M8 AI dataset mode (G2), M9 local DCR generation, M10 team workspace (G3), M11/M12 enterprise (G4); T5 investment-gated                                                                                                      | per gate evidence — no change                                     | roadmap §5                                                                                 |

Sequencing rule (unchanged from roadmap §2): T1–T4 advance in vertical slices; **T5 stays
investment-gated** — nothing in this track re-opens that.

## 4. PT-0 — launch readiness (the G0 checklist)

G0 (roadmap §5) requires: license chosen ✅ (AGPL-3.0-or-later, ADR 0036); telemetry design
approved (opt-in stance per ADR 0025 exclusions, opt-out toggle per ADR 0037); security
disclosure channel live; demo scenario passes end-to-end. The concrete remaining items:

| #   | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Kind                      | Tracked                            |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------- |
| 1   | **Telemetry design doc (D2 tail):** allowlisted event schema + sampling for the self-hosted minimal collector (D2b, 2026-09-16). Metadata-only per ADR 0025 — never dataset contents, filenames-where-sensitive, raw SQL results, cell values, PII. Opt-out (`ASSAY_NO_TELEMETRY`) with first-run disclosure per ADR 0037. No telemetry code exists yet — this is a design-then-implement task, queueable in handoff §6 when the maintainer wants it | design + impl             | roadmap §7 D2; manual-actions note |
| 2   | **GitHub org/repo + first push** (manual M2): org `assay`, repo, `origin`, push `main` (155 commits, never left this machine). Unlocks remote CI (verify + e2e jobs authored, never run remotely), PR flow, dependabot                                                                                                                                                                                                                               | human                     | manual-actions M2                  |
| 3   | **Remote CI green + SHA-pin actions** (manual M3, blocked by 2): confirm Actions runs green on `main`, then SHA-pin `actions/*` (m1-8 carry-over; supply-chain risk R13)                                                                                                                                                                                                                                                                             | human + one agent task    | manual-actions M3                  |
| 4   | **npm org claim** (manual M1): `@assay` scope must be ours before first publish (D6 tail)                                                                                                                                                                                                                                                                                                                                                            | human                     | manual-actions M1                  |
| 5   | **Trademark/domain clearance** (manual M4, G0 tail)                                                                                                                                                                                                                                                                                                                                                                                                  | human                     | manual-actions M4                  |
| 6   | **Demo dataset (O5):** hybrid approach decided 2026-09-16 (real open data + injected flaws); curation not started — best after the diff/validation story is demoable (it now is)                                                                                                                                                                                                                                                                     | non-code track            | manual-actions note                |
| 7   | **A11y CI (O3):** not started; a11y is in the definition of done (docs 06 §10) and the grid/schema tree already use disclosure patterns — wire axe or equivalent into CI                                                                                                                                                                                                                                                                             | agent tasks               | roadmap opportunities              |
| 8   | **Security disclosure channel:** a SECURITY.md + private contact route (G0 requirement; complements ADR 0007's "no invented crypto" and the untrusted-cell-content rules)                                                                                                                                                                                                                                                                            | small doc + human routing | —                                  |
| 9   | **Docs/site basics:** README as a front door, install/try steps for web + CLI, fixture story                                                                                                                                                                                                                                                                                                                                                         | agent tasks               | —                                  |

PT-0 is deliberately small: items 2–5 are human actions, 1/6–9 are one-to-few agent tasks each.
**Recommendation (needs maintainer sign-off — see §8): run PT-0 to G0 before starting PT-V or
PT-P engineering**, so early public use (and the G2 adoption evidence it generates) is not
blocked and telemetry exists from the first public commit.

## 5. PT-V — VS Code extension (former M7)

Scope as recorded in roadmap §3.1: custom editors for the supported formats, a workspace
adapter (VS Code FS → data-sources capabilities), Git context (the working-tree version is a
natural diff "B side"), and a dataset diff command — reusing the M6 architecture end-to-end
(pure `@assay/diff` → engine op → panel; the webview reuses the same pure packages; the grid's
rendering is replaceable per ADR 0022).

Entry work (first task when PT-V starts): the **R4 feasibility spike** — DuckDB-WASM worker
boot + OPFS/file-handle access inside the extension host/webview, memory ceilings, and
marketplace packaging constraints (vscode-web). Gating ADRs: 0008 (Electron/Node
capabilities), 0022 (headless grid). Exit: the docs 07 VS Code scenarios (open → edit →
validate → diff in VS Code) pass as e2e.

## 6. PT-H — hardening & backlog inventory (recorded carry-overs)

Everything below is already recorded in handoff §6 rows or §9; listed here so the post-MVP
lanes have a single index:

- Engine: bound the optional integer modifier (`VARCHAR(<huge>)` fails late); `VARBIT`
  over-acceptance; `UHUGEINT` byte-render; a `profileComparison`/`closeTable` op so diff
  B-side profiling stops accumulating `assay_tN` registry entries (m6-4 measured carry-over).
- CLI: `runDiffPlan` hardcodes side A to `DATASET_VIEW` (parameterize or assert with a
  self-explanatory error).
- Diff: `scanOrdinalScopes` would not catch a same-SELECT bare `JOIN … ON` filter (byte
  goldens make any SQL change review-visible; extend the scan if builders change);
  `report.ts` "row-level comparison is m6-1+" phrasing touch-up.
- Scale/perf: diff performance benchmark at scale (risk R7 — progressive diff strategy
  docs 03 §14); bench open questions OQ #1 (worker-side heap) and the eh-bundle swap option
  (bench note); SQL-editor true interrupt/second connection (m2-7 note).
- Quality infra: a11y CI (O3, also PT-0 item 7); dependency review/OpenSSF (O10); diff-panel
  note visibility assertions (m6-4 non-blocking note).
- Deferrals deliberately recorded in M6 (non-goals, not re-decided): statistical drift tests
  (KS etc.), three-way/merge diffs, remote/connector tables, cross-dataset FK detection,
  DCR generation (M9), B-side editing.

## 7. Gated tracks (unchanged)

M8 (AI dataset mode) waits on **G2** adoption evidence (repeat usage of web + VS Code,
validation/diff actually used per privacy-safe metrics, ≥10 recurring users qualitative);
M10 waits on **G3**; M11/M12 on **G4**. P3–P5 per roadmap §3.2 (P5 additionally requires
validated user demand). The gates exist precisely so these tracks never start on enthusiasm —
no change.

## 8. Open decisions (maintainer)

| ID  | Decision                                        | Options / notes                                                                                                                                                            | Target                         |
| --- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| D12 | First post-MVP engineering track after PT-0     | (a) PT-V VS Code (completes the original MVP vision, another surface for G2 evidence) vs (b) PT-P P1 pipeline (opens the quality/publish story; T3 foundations are stable) | first lane after G0 items land |
| D2  | Telemetry event schema + sampling (design tail) | self-hosted minimal collector decided; schema/sampling open                                                                                                                | G0                             |
| —   | Demo dataset curation start                     | hybrid decided; needs a maintainer go + source-data pick                                                                                                                   | G0 (demo scenario)             |

## 9. Maintenance

This document is orchestrator-owned (like the roadmap and handoff). Track tasks are still
sliced into handoff §6 queues and executed under the §7 multi-agent protocol; the roadmap
remains canonical for sequencing, and any durable/architectural decision made here gets an
ADR (next free number: 0042). Update §2's evidence line at every milestone close.
