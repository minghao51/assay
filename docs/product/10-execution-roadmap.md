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
- [x] **M1 test-hardening batch (T1–T4)** — done 2026-09-16: engine conformance suite + data-source behavior suite in `@assay/testing` (docs/engineering/05 §4; commits `75a6657`/`b7a8587`/`ce54c05`/`738f791`), worker-side operation serialization, bench-rig hardening; records in `docs/process/handoff.md` §6/§9. **G1 / M1-exit decision: PASSED 2026-09-16 — M2 unblocked.**
- [x] **G1 evidence: multi-GB benchmark re-run (task G1-R)** — done 2026-09-16 (`57dbcb0`): 10.24 GiB / 150M-row round recorded in `docs/engineering/07-m1-benchmarks.md` (medians of 3 cold repeats: TTFR 411 ms, picker→first-row 2.11 s, filtered scan 21.0 s at 0.487 GiB/s — linear, deep-offset windows ≤ 0.47 s at 148.5M-row offsets, main-thread heap 3 MB; all three recorded scaling assumptions confirmed). **G1 pass/pivot record: PASSED 2026-09-16 (maintainer, manual-actions M5; no pivot) — M2 unblocked.**
- [x] **M2 (query & profiling)** — **done 2026-09-17** (queue m2-1…m2-7, per-task records in handoff §6/§9): grid sort/filter state + engine filtered/sorted windows (conformance + injection suites), web filter/sort UI, SQL editor with paged results + honest cancel, profiling engine (numeric/categorical/null/distinct), profile panel with dependency-free SVG distribution charts, two-op-lane engine scheduling (ADR 0040, measured). Exit criterion met: notebook-style exploration without Python, all web-visible and e2e-proven (58 specs).
- [x] **M3 (nested data)** — **done 2026-09-17** (m3-0…m3-5; per-task records in handoff §6/§9): nested fixtures + engine-conformance fidelity pins (Arrow nested values, epoch-ms boundary contract), bounded/depth-aware cell previews, full-depth record inspector, pure flatten/explode/path SQL composer (injection-probed, CLI-verified), one-click nested actions from schema tree + grid headers into the paged result pane. Exit criterion met: nested JSONL materially easier to inspect than plain text — journey-pinned from cold start (71 e2e specs total).
- [x] **M4 (editing and transforms)** — **done 2026-09-19** (m4-0…m4-6 + m4-2b in handoff §6; rounds 1–3 + m4-2b merged: m4-0 web hygiene; m4-1 pure edit-ops domain model; m4-2 engine overlay materialization + export/rewrite; m4-3 web cell editing/row ops/dirty state over the overlay — logical-row-id targeting, typed editors, undo/redo, rejection rollback, inspector freshness, grid inflight epoch-tagging; m4-2b engine insert-edit merge fix; m4-4b engine cast-conversion check; m4-4 web column ops + transformation history + preview; m4-5 export/rewrite UX; m4-6 exit-criterion journey (byte-identical undo, byte-pinned CSV, source checksum, re-open round-trips) — **M4 COMPLETE**; vitest 790 / e2e 114+1). Exit criteria: edits reversible; Parquet rewritten, never treated as in-place mutable.
- [x] **M5 (validation and contracts)** — **done 2026-09-19** (m5-0…m5-6 in handoff §6, signed off 2026-09-19; every task adversarially reviewed — seven request-changes findings across six review rounds, all probe-verified and pinned; reviewer lane on GLM from m5-2 onward per maintainer instruction after a Codex usage-limit block. Merged chain: m5-0 pure `@assay/contracts` (canonical AST + YAML, total located-error parser, byte-stable serializer, 21-spelling vocabulary, exact-or-rejected numerics); m5-1 pure `@assay/validation` (deterministic byte-identical rule→SQL plan compiler, typed binding errors, RE2-subset checker with documented bounds, injection-hard helpers, gated real-DuckDB agreement suites); m5-2 engine `validate(handle, plan, overlay?)` on the query lane (byte-identical plan SQL over the effective view, clamped samples with logical row keys, exact half-up `failPercent`, pre-execution plan gate + rollback containment + never-hang client, conformance scenario #20 + vocabulary agreement + overlay-interaction battery); m5-5 JSON Schema adapter (typed unsupported-key reporting with JSON Pointer paths, conservative self-contained RE2-subset filter, round-trip shield); m5-3 web validation panel + invalid-row explorer (documented severity ordering, filter-to-failures honesty for complete sample sets, stale-verdict discipline, sanitized new-file-only report export, two exact-count journeys); m5-4 CLI `assay validate` (Node backend `@duckdb/node-api` behind the `./node` seam — ADR 0041; byte-pinned integration suite; per-outcome result-sanity bounds on both surfaces); m5-6 exit journey (same contract + same file: web ≡ CLI exactly on every rule; fix-all → clean; privacy sweep). Exit criteria met: dirty dataset + one contract → web report and CLI `validate` agree exactly (asserted, not sampled); violations explorable and fixable in-place via M4 editing; six gates green — **vitest 1416, e2e 119+1skip** (134 commits). Next: M6 queue authoring (per §7 decision backlog).
- [ ] Telemetry design (D2 tail) — **approach decided 2026-09-16: self-hosted minimal collector**; remaining: allowlisted event-schema + sampling design doc (pre-G0).
- [x] Product name decision — **Assay** (ADR 0039) — 2026-09-14.
- [ ] Demo dataset curation for the MVP demo scenario begins (opportunity O5) — **approach decided 2026-09-16: hybrid** (real open data + injected flaws).

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

| Gate | Before                                      | Evidence required (indicative — calibrate as data arrives)                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G0   | First public launch (any surface)           | License chosen; telemetry design approved (opt-in stance, no dataset contents per ADR 0025); security disclosure channel live; demo scenario passes end-to-end.                                                                                                                                                                                                                                                                                                                                                       |
| G1   | Committing to grid/engine strategy at scale | Phase-0 exit criteria met: multi-GB Parquet opens; column/filter queries stream; grid stays responsive; no data leaves the browser. If memory ceilings fail → pivot decision (OPFS spill-over, Tauri earlier — ADR 0028). **— ✅ PASSED 2026-09-16** (maintainer record, manual-actions M5; evidence: `docs/engineering/07-m1-benchmarks.md` G1-R round — 10.24 GiB/150M rows, all three scaling assumptions held; no pivot — 60 GiB-scale extrapolation and worker-side-heap measurement not required for the gate). |
| G2   | Phase 4/5 engineering (M8–M10)              | Adoption signals: repeat usage of web + VS Code; validation/diff actually used (per privacy-safe metrics, docs 04 §15); qualitative feedback from ≥ 10 recurring users.                                                                                                                                                                                                                                                                                                                                               |
| G3   | Hosted workspace build-out (M10 full)       | G2 passed; support capacity; DCR artifact format stable (M9 done); authn/authz approach selected (ADR 0024 + provider decision).                                                                                                                                                                                                                                                                                                                                                                                      |
| G4   | Enterprise track (M11/M12)                  | ≥ 2 design partners with signed requirements; policy language decision (ADR 0018 → engine choice); enterprise AI governance requirements documented.                                                                                                                                                                                                                                                                                                                                                                  |

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

| ID  | Decision                        | Options / notes                                                                                              | Target gate |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------- |
| D2  | Telemetry vendor & sampling     | Vendor approach decided 2026-09-16: self-hosted minimal collector. Remaining: event schema + sampling design | G0          |
| D7  | Authorization engine            | Cedar vs OpenFGA vs OPA (ADR 0018, 0006 — evaluate at G3/G4)                                                 | G3          |
| D8  | Identity provider               | Keycloak vs WorkOS vs Auth0 (ADR 0024)                                                                       | G3          |
| D9  | dbt vs SQLMesh adapter priority | user-demand driven (ADR 0031)                                                                                | P4          |
| D10 | CLI distribution                | npm-only vs native binaries (Rust CLI later, docs 03 §17)                                                    | M5          |

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
  - 2026-09-20 — **M6 queue authored (m6-0…m6-5) in handoff §6** — dataset diff: pure diff core (schema drift + distribution deltas per C1's deterministic metric set) → row-diff plan compiler + key inference (C2: propose-and-confirm, never silent) → engine staging + `diff` op (C3: comparison file staged via the m4-5 OPFS scratch pattern) → CLI `assay diff` ∥ web diff panel (progressive disclosure per the docs-07 honesty rule) → cross-surface exit journey. Completes the MVP (M0–M6). Awaiting maintainer sign-off; checkpoints C1 (drift metrics, no p-values), C2 (key inference discipline), C3 (web staging model) resolve at stated defaults unless overridden. Non-goals recorded: p-value tests, three-way/merge, remote tables, FK detection, git-style visual diffs (M7), DCR (M9), B-side editing.
  - 2026-09-20 — **M5 COMPLETE — m5-6 exit journey green** (`44f28ed`, approved on first review pass): one continuous journey over the SAME staged dataset + contract — browser opens both through the real UI, spawned CLI reads the same paths; web JSON export ≡ CLI `--format json` exactly for EVERY rule (counts, frozen percents, sample multisets as type-tagged pairs, verdict, datasetRows), CLI byte-determinism pinned; fix-all via M4 editing → clean with stale-then-fresh export discipline; consolidated privacy sweep (no file names in page/exports/CLI paths, anchor tokens absent, stderr empty). Reviewer mutation-checked (corrupted count, corrupted value, incomplete fix — all killed) and re-derived the severity order from both comparators. Zero journey-exposed defects — the m5-4 addendum had already fixed the one cross-surface defect (uniform failCount guard). CHANGELOG gained M4+M5 product-narrative sections (M4's close had skipped it). Merged on `main`: six gates green — **vitest 1416, e2e 119+1skip** (134 commits). **M5 closed; next: M6 queue authoring per the §7 decision backlog.**
  - 2026-09-19 — **m5-3 + m5-4 complete (parallel lanes; ADR 0041 CLI Node backend = @duckdb/node-api behind the `./node` seam)**: web validation panel (severity ordering, filter-to-failures honesty, stale-verdict discipline, sanitized report export, two exact-count journeys) + CLI `assay validate` (byte-pinned integration, cross-surface agreement, exit codes). Cross-surface defect found and fixed pre-review: the m5-2 result-sanity guard rejected the legal min-rows-on-empty violation — refined to per-outcome bounds on both surfaces. vitest 1416 / e2e 118+1skip. Next: m5-6 (exit journey), then M5 close.
  - 2026-09-19 — **m5-5 complete** (`7aa71d0` + fix `6865ab7`): `@assay/contracts` JSON Schema adapter — total, typed unsupported-key reporting with pointer paths, documented subset, conservative self-contained RE2-subset pattern filter, round-trip shield; review caught a silent under-constraint (`required` without `properties` converted to a contract validating nothing) fixed with an unconditional required-walk + generator-coverage fix. vitest 1337 / e2e 116+1skip. Next: m5-3 ∥ m5-4, then m5-6.
  - 2026-09-19 — **m5-2 complete** (`91d2769` + 2 fix rounds; reviews ran live browser probes that falsified a bypassable plan-SQL gate, an unconditional view DROP, and a client-promise hang; `sampleLimit` adjudicated to clamping): engine-duckdb `validate(handle, plan, overlay?)` — byte-identical plan SQL over the effective view, clamped samples with logical row keys, exact half-up `failPercent`, pre-execution gate + rollback containment + never-hang client; conformance scenario #20 + vocabulary agreement + validation-journey e2e. Reviewer lane switched to GLM mid-milestone (maintainer instruction, after a Codex usage-limit block). vitest 1265 / e2e 116+1skip. Next: m5-5 fills the lane; then m5-3 ∥ m5-4; m5-6 last.
  - 2026-09-19 — **m5-1 complete** (`64d2c69` + 2 fix rounds; first interrupted-session adoption after a mid-work provider 429): pure `@assay/validation` rule→plan compiler — deterministic serializable `ValidationPlan`, typed binding errors, fail-closed type classifier, RE2-subset checker, injection-hard helpers, total option handling; reviews caught alias-collision undercounting (fixed structurally via range-qualified refs + `assay_*`-only derived aliases), checker/DuckDB RE2 disagreements, a nesting stack-overflow, and non-total error rendering — all pinned incl. gated real-DuckDB agreement suites. vitest 1185 / e2e 114+1skip. Next: m5-2 (engine validate op); m5-5 unblocked to fill the lane.
  - 2026-09-19 — **M5 sign-off + m5-0 complete** — maintainer pickup treated as sign-off (same pattern as M4); D10 confirmed at default (npm-only); CLI Node backend resolves spike-first in m5-4 (ADR finalized by the orchestrator). m5-0 (`bfeed3a` + 3 fix rounds): pure `@assay/contracts` canonical AST + YAML — total parser (typed line/column errors), byte-stable serializer, 21-spelling type vocabulary, exact-or-rejected numerics; the three adversarial review rounds caught silent numeric-precision corruption, prototype-chain lookups (incl. a never-throws violation), rule-less-entry normalization drift, a rounded-value echo in the fix's own error messages, and a false fuzz-floor rationale (reviewer re-derived the true count). vitest 876 / e2e 114+1skip. Next: m5-1 (rule→plan compiler, pure).
  - 2026-09-19 — **M5 queue authored (m5-0…m5-6) in handoff §6** — contracts AST+YAML → deterministic plan compiler → engine validate op → web explorer ∥ CLI validate (backend spike + ADR) → JSON Schema adapter → cross-surface exit journey. Awaiting maintainer sign-off; checkpoints: D10 default (npm-only), CLI Node backend. Non-goals recorded: cross-field/cross-row rules, non-JSON-Schema adapters, SARIF, suggested repairs.
  - 2026-09-19 — **m4-6 complete — M4 milestone complete** (one continuous exit journey: open → 8 ops + refused cast → undo-everything byte-identical → rewind/truncate → export Parquet+CSV byte-pinned → source sha256 unchanged → re-open round-trips → privacy sweep; sensitivity self-check added after review mutants; zero web defects surfaced). Next: author the M5 queue (validation track).
  - 2026-09-19 — **m4-5 complete** (export dialog with five formats, FSA/download save flow, copy that never implies in-place, effective-count honesty, same-source overwrite refused, arrow advertised as an IPC-stream interchange format, re-open journey pinned; two fix rounds closed a real data-loss path and filter/sort copy). Next: m4-6 (exit-criterion journey) — the last M4 task.
  - 2026-09-18 — **m4-4 complete** (column rename/cast UI with validate-before-commit via the engine cast check, transformation-history panel with selective undo, preview resolved as the live reversible overlay + pending summary; two fix rounds closed a silent mid-dataset cast failure, unreadable DECIMAL cells, a stale-verdict race, and a stale schema panel). Next: m4-5 (export/rewrite UX).
  - 2026-09-18 — **m4-4b complete** (engine `overlayCastCheck` for validate-before-commit after three adversarial fix rounds — cast-chain collapse, pre-TRY_CAST hard casts, and DuckDB-WASM 1.4.3 dead-edit evaluation each closed with pins; 13-case check/commit agreement battery). Next: m4-4 fix round, then m4-5.
  - 2026-09-18 — **m4-2b complete** (engine overlay composer now merges folded cell edits on inserted rows; new `overlay-insert-edits` conformance scenario + CLI-derived pins; the defect was discovered by m4-3). Next: m4-4 (column rename/cast + transformation history panel + preview).
  - 2026-09-18 — **M4 round 3 complete** (m4-3 web cell editing + row ops + dirty state; one fix round closed silent engine-rejection swallowing; the m2-1 inflight epoch-tagging carry-over and the m3-3 inspector-freshness carry-over are closed; a real m4-2 engine defect was found and queued as m4-2b). Next: m4-2b, then m4-4 (column ops + history panel).
  - 2026-09-18 — **M4 round 2 complete** (m4-2 engine overlay materialization + export/rewrite; approved after two fix rounds that closed an executable type-string defect, a CSV sanitization alias bypass, a fix-introduced array-classification regression, malformed-request silence, and an alias-pin gap). Next: m4-3 (web cell editing + row ops + dirty state).
  - 2026-09-18 — **M4 round 1 complete** (m4-0 web hygiene carry-overs, m4-1 pure edit-operations domain model in `@assay/domain`; records in handoff §6/§9 — op union w/ inverse closure, logical `RowId` survival boundary, overlay fold, history cursor w/ branch truncation; 5 seeded property suites). Next: m4-2 (engine overlay materialization + export/rewrite).
  - 2026-09-18 — **M4 queue authored** (m4-0…m4-6, handoff §6; sign-off pending). Dispatch runbook (worker→reviewer subagent loop) recorded durably in handoff §7.6.
  - 2026-09-17 — **M3 (nested data) complete** (m3-0…m3-5; records in handoff §6/§9): nested schema tree + actions, cell previews, record inspector, one-click flatten/explode/path extraction; engine conformance pins for nested Arrow fidelity; classifier hardening. M4 (editing and transforms) is next.
  - 2026-09-17 — **M2 (query & profiling) complete** (m2-1…m2-7; records in handoff §6/§9): filters/sorting end-to-end, SQL editor + paged results, profiling engine + profile panel with SVG charts; engine concurrency moved to two op lanes (ADR 0040) on measured evidence. M3 (nested data) is next.
  - 2026-09-16 — **G1 passed** (maintainer record, manual-actions M5): multi-GB evidence from task G1-R accepted (10.24 GiB/150M rows, `docs/engineering/07-m1-benchmarks.md`); **no pivot** — grid/engine strategy continues as-is; 60 GiB-scale extrapolation and worker-side-heap (OQ #1) measurement explicitly not required for the gate (deferred). **M1 exit complete; M2 unblocked.**
  - 2026-09-14 — product named **Assay** (D6, ADR 0039); workspace scope renamed `@assay/*`; historical docs keep "Data Workbench" wording per naming-convention note.
  - 2026-09-14 — maintainer decisions recorded: AGPL-3.0-or-later license (D1, ADR 0036); opt-out telemetry consent (D2a, ADR 0037); DuckDB CLI fixture generation (D3, ADR 0038); changesets + root changelog (D4); capacity-based sequencing (D5). Decision backlog split into open/resolved.
  - 2026-09-16 — maintainer decisions: GitHub for git hosting (org/repo push = manual action, docs/process/manual-actions.md); telemetry = self-hosted minimal collector (D2b narrowed); demo dataset = hybrid (O5).
  - 2026-09-16 — maintainer gate policy: **G1 requires the multi-GB re-run before passage** (bench note OQ #2; queued as task G1-R in handoff §6). M2 feature work stays blocked until the re-run lands and the gate is recorded.
  - 2026-09-14 — created; consolidated pipeline sequence (P1–P5); added M12 for governed data products; defined gates G0–G4; risk register and decision backlog initialized from docs 00/04/09 and the 2026-09-14 review.
