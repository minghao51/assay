# Data Workbench — Execution Roadmap (Canonical)

Status: living document — reviewed quarterly and at every gate passage
Supersedes: the sequencing in `../engineering/04-implementation-plan.md` §17 and `../architecture/09-pipeline-dag-etl.md` §24, which remain valid as descriptive background. When sequences conflict, this document wins.

Related:

- Strategic vision and phases: [`00-roadmap.md`](00-roadmap.md)
- Milestone details and exit criteria: [`../engineering/04-implementation-plan.md`](../engineering/04-implementation-plan.md)
- Pipeline architecture: [`../architecture/09-pipeline-dag-etl.md`](../architecture/09-pipeline-dag-etl.md)
- Findings driving this revision: [`../reviews/2026-09-14-documentation-and-setup-review.md`](../reviews/2026-09-14-documentation-and-setup-review.md)

---

## 1. Why this document exists

The documentation set defines the product in three overlapping lenses — vision phases (00), engineering milestones (04), and a pipeline track (04 §17 / 09 §24) — with partially conflicting sequences and no explicit mapping between them. This document:

1. declares **one canonical delivery sequence**,
2. maps **vision phases ↔ milestones ↔ gating ADRs**,
3. defines **decision gates** that control when later (expensive) phases may begin,
4. maintains a **risk register** and an **open decision backlog**,
5. states the **Now / Next / Later** horizon at any point in time.

---

## 2. Delivery tracks

Work is organized into five tracks so that progress in one never silently blocks the others:

```text
T1  Local Workbench Core     formats, grid, engine, query, profile, editing, validation, diff
T2  Surfaces                 web app, VS Code extension, CLI, CI integration
T3  Pipeline & DAG           Pipeline IR, visual builder, quality/publish gates, ecosystem adapters
T4  Dataset Governance       dataset identity/versions, DCRs, contracts, lineage (local first)
T5  Hosted & Enterprise      workspaces, control plane, policy enforcement, connectors (gated)
```

Rules:

- T1–T4 advance in vertical slices; every slice ends usable by a developer locally.
- **T5 is investment-gated** (Section 5): no hosted/enterprise engineering before its gate passes.
- T2 follows T1 with a short lag (each T1 capability ships to web first, then VS Code/CLI).
- T3 begins only after the T1 foundations (explorer, SQL, validation) are stable (docs 04 §17).

---

## 3. Canonical sequence

### 3.1 Core milestones (T1/T2/T4)

| #   | Milestone                                 | Delivers (summary)                                                                | Vision phase                  | Gating ADRs                        |
| --- | ----------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------- | ---------------------------------- |
| M0  | Repository bootstrap                      | monorepo, packages, CI, shared configs, fixtures harness                          | Phase 0                       | 0008, 0019                         |
| M1  | Local file explorer                       | Parquet/JSONL/CSV open, schema, grid, DuckDB worker, Arrow transport              | Phase 0 spike → Phase 1 start | 0002, 0020, 0021, 0022             |
| M2  | Query and profiling                       | SQL editor, filters/sort, paging, numeric/categorical profiles, charts            | Phase 1                       | 0002                               |
| M3  | Nested data                               | schema tree, JSON tree cells, flatten/explode, record inspector                   | Phase 1                       | 0020                               |
| M4  | Editing and transforms                    | edit overlay, row identity, cell/row/column edits, preview, export/rewrite        | Phase 1 (editing)             | 0011, 0012                         |
| M5  | Validation and contracts                  | contract AST, core rules, invalid-row explorer, CLI `validate`                    | Phase 2 start                 | 0013, 0026                         |
| M6  | Dataset diff                              | schema/profile/distribution diff, key-based row diff, diff reports                | Phase 2                       | 0011                               |
| M7  | VS Code extension                         | custom editors, workspace adapter, Git context, dataset diff command              | Phase 3                       | 0008, 0022                         |
| M8  | AI dataset mode                           | semantic schemas, conversation viewer, LLM diagnostics, eval comparison           | Phase 4                       | 0009                               |
| M9  | Local DCR generation                      | candidate DatasetVersion → change request artifact (schema/quality/drift/privacy) | Phase 5 groundwork (local)    | 0011, 0014                         |
| M10 | Team workspace prototype                  | auth, hosted metadata, DCR review, comments, approvals                            | Phase 5                       | 0010, 0014, 0027                   |
| M11 | Enterprise data gateway                   | connectors, governed query, policy enforcement, audit                             | Phase 7 (data plane first)    | 0005, 0006, 0007, 0018, 0023, 0024 |
| M12 | Governed data products _(to be detailed)_ | catalog, ownership, classification, lineage, promotion                            | Phase 6                       | 0004, 0018                         |

Note: M12 is inserted by this roadmap to give Phase 6 (governed data products) an explicit milestone home; it must be specified before M10 completes. MVP = M0–M6 + VS Code surface of M7 (see `../product/07-mvp-scope-and-acceptance.md`).

### 3.2 Pipeline track (T3) — consolidated sequence

Reconciles 04 §17 (M1–M6) and 09 §24 (Phases 1–5) into one sequence:

| #   | Pipeline stage                        | Contents                                                                      | Gating ADRs      |
| --- | ------------------------------------- | ----------------------------------------------------------------------------- | ---------------- |
| P1  | IR and local runner                   | Pipeline IR schema, DAG validation, source/SQL/transform nodes, DuckDB runner | 0029, 0030, 0032 |
| P2  | Quality and publish                   | validation nodes, publish gates, preview, materialization modes, lineage      | 0033, 0035       |
| P3  | DCR integration                       | candidate DatasetVersion from pipeline runs, DCR generation                   | 0014             |
| P4  | Ecosystem compatibility               | dbt inspect/import/export, SQLMesh adapter (environments, plans, incremental) | 0031             |
| P5  | Ingestion and orchestration _(gated)_ | dlt ingestion adapter, Dagster adapter, scheduling/backfill                   | 0034, 0032       |

Entry condition: M2 and M5 stable. P5 additionally requires validated user demand (docs 09 §13).

---

## 4. Now / Next / Later

### Now (this quarter)

- [x] M0 repository bootstrap — done 2026-09-14 (see `../process/08-project-start-checklist.md`).
- [x] Decision: license — AGPL-3.0-or-later (ADR 0036) — 2026-09-14.
- [x] Decision: fixture tooling — DuckDB CLI generator (ADR 0038) — 2026-09-14.
- [x] Decision: changesets + product changelog + capacity-based sequencing — 2026-09-14.
- [x] AGENTS.md for AI coding agents — 2026-09-14.
- [x] M0 remainder: DuckDB-WASM worker spike; first Arrow batch through the worker; first virtualized grid render; measure time-to-first-row and memory (the original Phase-0 spike items). _All done 2026-09-15: m1-1/m1-2 (worker boot + Arrow batch), m1-5 (1M-row virtualized grid), m1-7 (benchmark: 1.09 GiB → TTFR ~0.3 s, heap 4 MB/3.6 GB — `docs/engineering/07-m1-benchmarks.md`; multi-GB re-run open before G1 sign-off)._
- [ ] **M1 test-hardening batch (T1–T4)** — conformance/behavior suites in `@assay/testing` (docs/engineering/05 §4), worker-side operation serialization, bench-rig hardening; queue and dependencies in `docs/process/handoff.md` §6. _In progress 2026-09-15: T1 done (`75a6657`); T4 in review; T2/T3 queued._ **G1 / M1-exit decision (maintainer) blocks M2 feature work.**
- [ ] Telemetry vendor + sampling design (D2 tail).
- [x] Product name decision — **Assay** (ADR 0039) — 2026-09-14.
- [ ] Demo dataset curation for the MVP demo scenario begins (opportunity O5).

### Next

- M1 → M4 (local explorer through editing) as vertical slices, web-first.
- Playwright E2E grows with each slice; benchmarks wired at M1 (opportunity O2).
- Telemetry design before first public launch (gate G0).

### Later

- M5–M7 completing the MVP; then P1–P2 pipeline foundation.
- M8+ strictly per gates G2/G3.

---

## 5. Decision gates

Gates prevent investment ahead of evidence. Passing a gate is a recorded event (update this document; consider an ADR if the decision is architectural).

| Gate | Before                                      | Evidence required (indicative — calibrate as data arrives)                                                                                                                                                                |
| ---- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G0   | First public launch (any surface)           | License chosen; telemetry design approved (opt-in stance, no dataset contents per ADR 0025); security disclosure channel live; demo scenario passes end-to-end.                                                           |
| G1   | Committing to grid/engine strategy at scale | Phase-0 exit criteria met: multi-GB Parquet opens; column/filter queries stream; grid stays responsive; no data leaves the browser. If memory ceilings fail → pivot decision (OPFS spill-over, Tauri earlier — ADR 0028). |
| G2   | Phase 4/5 engineering (M8–M10)              | Adoption signals: repeat usage of web + VS Code; validation/diff actually used (per privacy-safe metrics, docs 04 §15); qualitative feedback from ≥ 10 recurring users.                                                   |
| G3   | Hosted workspace build-out (M10 full)       | G2 passed; support capacity; DCR artifact format stable (M9 done); authn/authz approach selected (ADR 0024 + provider decision).                                                                                          |
| G4   | Enterprise track (M11/M12)                  | ≥ 2 design partners with signed requirements; policy language decision (ADR 0018 → engine choice); enterprise AI governance requirements documented.                                                                      |

---

## 6. Risk register

| #   | Risk (source)                                                   | Likelihood/Impact | Mitigation                                                                                            |
| --- | --------------------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------- |
| R1  | Browser memory ceilings on very large datasets (04 §16)         | M/H               | Phase-0 spike measures early (G1); OPFS spill-over design; Tauri fallback (ADR 0028).                 |
| R2  | Virtualized grid UX at extreme row counts (04 §16)              | M/H               | Owned headless grid model (ADR 0022); canvas renderer option behind interface; benchmark in CI.       |
| R3  | Stable row identity for editing/diff (04 §16)                   | M/M               | Design in M4 behind ADR 0011/0012; explicit identity strategy per source kind.                        |
| R4  | DuckDB-WASM startup cost & VS Code webview constraints (04 §16) | M/M               | Measure at M1; lazy engine init; caching; webview feasibility spike before M7 commitment.             |
| R5  | Cross-browser filesystem behavior divergence (04 §16)           | M/M               | Capability detection layer in data-sources package; OPFS/FSA fallback matrix documented.              |
| R6  | Contract language usability (04 §16)                            | M/M               | Contract format spike inside M5 with real users; adapters from JSON Schema (ADR 0013).                |
| R7  | Diff performance at scale (04 §16)                              | M/H               | Progressive diff strategy (metadata → schema → profile → rows, docs 03 §14); fingerprints; benchmark. |
| R8  | Accessibility in custom grid interactions (04 §16)              | M/H               | A11y in definition-of-done (docs 06 §10); a11y CI (opportunity O3); screen-reader test plan at M1.    |
| R9  | Enterprise scope creep before adoption (review)                 | H/H               | Gates G2–G4; T5 investment-blocked until gates pass.                                                  |
| R10 | Licensing ambiguity blocks ecosystem growth (review C3)         | M/H               | G0 forces decision before public launch.                                                              |
| R11 | Pipeline track drifting into rebuilding orchestration (docs 09) | M/M               | ADR 0032 boundary; P5 gated on demand; IR must stay orchestrator-neutral.                             |
| R12 | Key-person/bus-factor on pre-team project (review)              | H/M               | Docs + ADRs capture rationale; conventional commits; recorded gate decisions.                         |
| R13 | WASM/dependency supply chain (review)                           | L/H               | Lockfiles committed; dependency review in CI later (OpenSSF, opportunity O10).                        |

---

## 7. Decision backlog

Decisions required, with target gates. Add new rows here rather than deciding silently. Durable decisions are recorded as ADRs (see `../process/contributing.md`).

### Open

| ID  | Decision                        | Options / notes                                                                     | Target gate |
| --- | ------------------------------- | ----------------------------------------------------------------------------------- | ----------- |
| D2  | Telemetry vendor & sampling     | Stance decided (opt-out, ADR 0037). Remaining: self-host vs vendor, sampling design | G0          |
| D7  | Authorization engine            | Cedar vs OpenFGA vs OPA (ADR 0018, 0006 — evaluate at G3/G4)                        | G3          |
| D8  | Identity provider               | Keycloak vs WorkOS vs Auth0 (ADR 0024)                                              | G3          |
| D9  | dbt vs SQLMesh adapter priority | user-demand driven (ADR 0031)                                                       | P4          |
| D10 | CLI distribution                | npm-only vs native binaries (Rust CLI later, docs 03 §17)                           | M5          |

### Resolved

| ID  | Decision        | Resolution (date)                                                                                                                                         |
| --- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | License         | AGPL-3.0-or-later for the open core; hosted/enterprise surfaces may be separately licensed (ADR 0036) — 2026-09-14                                        |
| D2a | Consent stance  | Opt-out with first-run disclosure, in-product toggle, ADR 0025 exclusions unchanged (ADR 0037) — 2026-09-14                                               |
| D3  | Fixture tooling | DuckDB CLI generator script; small canonical fixtures committed with checksum manifest (ADR 0038) — 2026-09-14                                            |
| D4  | Versioning      | Changesets for package releases + curated root `CHANGELOG.md` for product-level narrative — 2026-09-14                                                    |
| D5  | Timeline        | Capacity-based sequencing; quarterly roadmap review; no dated quarters until a team exists — 2026-09-14                                                   |
| D6  | Product name    | **Assay** (ADR 0039); npm org `@assay` must be claimed before first publish; trademark/domain clearance before branding investment (G0 tail) — 2026-09-14 |

---

## 8. Roadmap maintenance

- **Cadence**: quarterly review; immediate update on any gate passage or new ADR that changes sequencing.
- **Change process**: sequencing changes require a note in this document's changelog below; architectural changes require an ADR.
- **Changelog**:
  - 2026-09-14 — product named **Assay** (D6, ADR 0039); workspace scope renamed `@assay/*`; historical docs keep "Data Workbench" wording per naming-convention note.
  - 2026-09-14 — maintainer decisions recorded: AGPL-3.0-or-later license (D1, ADR 0036); opt-out telemetry consent (D2a, ADR 0037); DuckDB CLI fixture generation (D3, ADR 0038); changesets + root changelog (D4); capacity-based sequencing (D5). Decision backlog split into open/resolved.
  - 2026-09-14 — created; consolidated pipeline sequence (P1–P5); added M12 for governed data products; defined gates G0–G4; risk register and decision backlog initialized from docs 00/04/09 and the 2026-09-14 review.
