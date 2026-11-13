# Assay — Project Documentation

This documentation set is intended to be sufficient to start implementation while preserving the long-term product direction.

## Document Index

### Product (`product/`)

| Doc                                                                                                      | Contents                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`product/00-roadmap.md`](product/00-roadmap.md)                                                         | Product vision, positioning, evolution phases 0–7, commercial model, strategic non-goals, north-star principles.                                                                                                                                                                    |
| [`product/01-features.md`](product/01-features.md)                                                       | Feature taxonomy (Understand / Validate / Compare / Repair / Prepare / Govern), surface capabilities, AI/ML dataset features, governance.                                                                                                                                           |
| [`product/02-mvp-scope-and-acceptance.md`](product/02-mvp-scope-and-acceptance.md)                       | MVP boundary, exclusions, acceptance criteria, target demo scenario.                                                                                                                                                                                                                |
| [`product/03-execution-roadmap.md`](product/03-execution-roadmap.md)                                     | **Canonical execution roadmap**: phase↔milestone↔ADR mapping, delivery tracks, decision gates, risk register, open decision backlog.                                                                                                                                                |
| [`product/04-post-mvp-track.md`](product/04-post-mvp-track.md)                                           | **Post-MVP execution track** (D11): PT-0 launch readiness to G0, PT-V VS Code, PT-P pipeline, PT-H hardening carry-overs, PT-Q QoL queue; open decisions D12/D13/C-ar-5.                                                                                                            |
| [`product/05-workbench-shell.md`](product/05-workbench-shell.md)                                         | Workbench shell target IA (ux-5 spec): the two-pane ready state per [ADR 0044](adr/0044-workbench-shell-two-pane.md) (D14), grid-centered layout; slice 1 landed (ux-6), slice 2 = PT-Q q-15.                                                                                       |
| [`product/06-dcr-artifact.md`](product/06-dcr-artifact.md)                                               | DCR artifact v1 scoping proposal (M9, D16) — **ruled by D17** (2026-10-02): v1 field selection, out-of-v1 list, format discipline, candidate DatasetVersion, entry points; §9 carries the 12 ruled D17 outcomes. Companion: [ADR 0046](adr/0046-dcr-artifact-format-v1.md).         |
| [`product/07-p3-dcr-integration.md`](product/07-p3-dcr-integration.md)                                   | **P3 phase document — DCR integration** (ACTIVE): phase purpose/outcome positioned above the P3 queue, per-row design expansion (p3-2…p3-5), cross-cutting notes, and §9 — the eight open v1 spec questions under maintainer review.                                                |
| [`product/08-ux-ui-engine-showcase-plan.md`](product/08-ux-ui-engine-showcase-plan.md)                   | UX/UI investigation, engine-showcase rationale and design direction (**programme complete 2026-11-03**: usability 23/23 and visual uxv-0…uxv-5 closed).                                                                                                                             |
| [`product/09-ux-ui-implementation-spec.md`](product/09-ux-ui-implementation-spec.md)                     | Executable UX/UI requirements (R-01…R-16 — **all implemented and merged-verified by 2026-11-03**), copy/states, reference frames, recovery contracts, verification and STOPs.                                                                                                       |
| [`product/10-ux-ui-demo-rehearsal.md`](product/10-ux-ui-demo-rehearsal.md)                               | **Demo rehearsal pack (R-13)**: two chapters on the shipped UI — the committed nested example (12×10 → Explode 20×11) and the M5 failure→repair→validate→export / M6 confirmed-key journeys on per-run inputs, with CLI continuity, input provenance, and explicit non-claims/gaps. |
| [`product/15-essential-workbench-enhancements.md`](product/15-essential-workbench-enhancements.md)       | **Proposed only (2026-11-12):** essential-workflow improvements informed by Excel/Sheets, Power Query, OpenRefine and DBeaver; bounded candidates, decision mapping and acceptance journeys—not spreadsheet parity or runtime authorization.                                        |
| [`product/16-essential-workbench-first-wave-spec.md`](product/16-essential-workbench-first-wave-spec.md) | Selected first-wave requirements: WF-06 lifecycle/reservation/clarifications and design-only scope/CSV/bulk contracts; acceptance, safety and verification boundaries.                                                                                                              |

### Architecture (`architecture/`)

| Doc                                                                          | Contents                                                                                                                                                 |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`architecture/01-architecture.md`](architecture/01-architecture.md)         | Core architecture, domain model, control/data plane, engine and grid architecture, security boundaries.                                                  |
| [`architecture/02-pipeline-dag-etl.md`](architecture/02-pipeline-dag-etl.md) | Visual pipeline architecture, SQL-first transformations, portable Pipeline IR, dbt/SQLMesh compatibility, dlt ingestion, Dagster orchestration boundary. |

### Engineering (`engineering/`)

| Doc                                                                                        | Contents                                                                                                                                                       |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`engineering/01-tech-stack.md`](engineering/01-tech-stack.md)                             | Recommended stack, alternatives, library choices, frontend/data/enterprise technologies.                                                                       |
| [`engineering/02-implementation-plan.md`](engineering/02-implementation-plan.md)           | Milestone sequence M0–M11 from repo bootstrap through enterprise gateway.                                                                                      |
| [`engineering/03-repository-structure.md`](engineering/03-repository-structure.md)         | Monorepo layout, package ownership, dependency direction, conformance testing.                                                                                 |
| [`engineering/04-testing-security-quality.md`](engineering/04-testing-security-quality.md) | Testing strategy, privacy rules, fuzz/property testing, accessibility, performance benchmarks.                                                                 |
| [`engineering/05-m1-benchmarks.md`](engineering/05-m1-benchmarks.md)                       | M1 grid/engine benchmarks: 1.09 GiB/16M-row + G1-R 10.24 GiB/150M-row measurements (TTFR, picker→first-row, scan throughput, deep offsets, heap).              |
| [`engineering/06-telemetry-design.md`](engineering/06-telemetry-design.md)                 | Telemetry design (D2 tail; design-only pending C-pt0-1): 10 allowlisted metadata-only events, no free-form strings, opt-out mechanics, ADR 0025 privacy table. |

### Process (`process/`)

| Doc                                                                                                                | Contents                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`process/handoff.md`](process/handoff.md)                                                                         | **Start here when picking up the project**: current state, decision ledger, environment quirks, definition of done, active-queue index, recent changelog. Active task queues live in dated files under [`process/handoff/`](process/handoff/) (completed queues archived there). |
| [`process/handoff/20261113-essential-workbench-pickup.md`](process/handoff/20261113-essential-workbench-pickup.md) | **Current first-wave pickup:** dated approval, live task register, baseline/worktree envelope, copyable WF-06 and design briefs, runtime/configured/restored gates and stop rules.                                                                                               |
| [`process/handoff/20261113-ew02-scope-contract.md`](process/handoff/20261113-ew02-scope-contract.md)               | **EW-02D design-only (delivered):** exact per-surface scope/copy/state/placement/acceptance table for Profile, SQL, pipeline binding, validation, diff and export; 49 RETAIN vs 3 proposals; independent review approved round 2; maintainer acceptance pending.                 |
| [`process/handoff/operating-model.md`](process/handoff/operating-model.md)                                         | The multi-agent protocol: roles, task state machine, reviewer checklist (§7.3), parallelism/conflict rules, dispatch runbook.                                                                                                                                                    |
| [`process/handoff/20260926-open-threads.md`](process/handoff/20260926-open-threads.md)                             | **Open-threads pickup map** — post-PT-0 continuation: Dependabot triage, PT-Q lanes, maintainer rulings, publish-day + carry-overs, all as pointers to authoritative rows.                                                                                                       |
| [`process/handoff/20260927-audit-remediation.md`](process/handoff/20260927-audit-remediation.md)                   | **Audit round 2 (AU-2) queue** — 2026-09-27 four-lane audit findings (incl. corrected false positives), what landed (au2-1…au2-4), and the prioritized follow-up backlog.                                                                                                        |
| [`process/handoff/20260927-impl-audit-remediation.md`](process/handoff/20260927-impl-audit-remediation.md)         | **Implementation audit (AU-3) queue** — 2026-09-27 four-lane implementation audit: verified findings ledger (2 criticals, 9 should-fixes), pick-up-cold remediation specs au3-1…au3-12, and the metadata-adversarial-fixtures convention.                                        |
| [`process/handoff/20260926-maintainer-rulings.md`](process/handoff/20260926-maintainer-rulings.md)                 | **ACTIVE — maintainer queue**: C-pt0-1 telemetry approval → D12 first post-MVP track → D13 `DataEngine` fate.                                                                                                                                                                    |
| [`process/handoff/20260926-publish-runbook.md`](process/handoff/20260926-publish-runbook.md)                       | **ACTIVE — publish-readiness runbook**: preconditions (M1), validated cut sequence, consumer smoke, tag/release, abort policy.                                                                                                                                                   |
| [`process/manual-actions.md`](process/manual-actions.md)                                                           | Human-only track: git hosting/org transfer, npm org claim (M1), telemetry stance, demo dataset (O5), trademark/domain clearance.                                                                                                                                                 |
| [`process/project-start-checklist.md`](process/project-start-checklist.md)                                         | Pre-implementation checklist and architecture-review gates.                                                                                                                                                                                                                      |
| [`process/contributing.md`](process/contributing.md)                                                               | Developer setup, commands, conventions, ADR process, dependency rules, release conventions.                                                                                                                                                                                      |

**UX/UI programme — COMPLETE (2026-11-03).** Both queues' runtime rows are closed and
merged-verified: usability **ug-1…ug-23 (23/23)** and visual **uxv-0…uxv-5**, so every requirement
in the [implementation spec](product/09-ux-ui-implementation-spec.md) (R-01…R-16) is implemented. The
records live in the [usability queue](process/handoff/20261026-usability-queue.md), the
[visual execution queue](process/handoff/20261026-ux-ui-execution-queue.md) (uxv-6 remains
design-only/deferred) and the [pickup pack](process/handoff/20261026-ux-ui-pickup-prompts.md), with
the rehearsal deliverable in [product/10](product/10-ux-ui-demo-rehearsal.md) and the merged
evidence in [handoff §6/§9](process/handoff.md). No runtime claim precedes a clean-worktree gate
baseline; the original programme's last code verification is recorded in handoff §2.
The [2026-11-03 audit follow-up](process/handoff/20261103-ux-audit-followup.md) also closed on
2026-11-04 (documentation reconciliation, isolated verification/CI and keyboard accessibility).
Its queue records current verification and optional residuals; the retired pickup pack is not dispatchable.

### Reviews (`reviews/`)

| Doc                                                                                                              | Contents                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`reviews/2026-09-14-documentation-and-setup-review.md`](reviews/2026-09-14-documentation-and-setup-review.md)   | Full documentation/setup review: strengths, findings, opportunities, open decisions.                                                                                                                                                                                                                     |
| [`reviews/2026-09-22-whole-repo-implementation-audit.md`](reviews/2026-09-22-whole-repo-implementation-audit.md) | Whole-repo implementation audit (7 lanes, all packages/apps/infra): 2 criticals, ~35 warnings with stable `AR-*` IDs; findings feed the handoff §6 AR queue and the PT-Q track.                                                                                                                          |
| [`reviews/2026-09-23-documentation-audit.md`](reviews/2026-09-23-documentation-audit.md)                         | Documentation audit (6 lanes, whole doc set): 16 truth defects, 3 contradictions, 14 duplication pairs, 10 structure findings (`DC/DX/DD/DS` IDs) + 7 maintainer decisions (`DM`); fed the doc-remediation queue (closed 2026-09-23, all five tasks merged — archived under `process/handoff/archive/`). |
| [`reviews/2026-11-12-essential-workbench-comparison.md`](reviews/2026-11-12-essential-workbench-comparison.md)   | Functional comparison using 24 retrieved official sources and source/test-qualified Assay capabilities; essential gaps, platform caveats, current scope boundaries and evidence limits.                                                                                                                  |

### ADRs (`adr/`)

See [`adr/README.md`](adr/README.md). The ADR series (0001–0046 — 46 records: 38 accepted, 8 proposed) covers local-first execution, DuckDB-WASM, dataset identity, Arrow interchange, worker architecture, grid ownership, edit overlays, contracts, validation compilation, dataset change requests, connectors, enterprise policy, authentication/authorization, encryption/KMS, telemetry, hosted control plane, pipeline IR and DAG semantics, two-op-lane engine wiring, the Node CLI backend, the product name (Assay), tsc
project-reference library builds (ADR 0042), the changesets-as-intake-ledger stance until first publish (ADR 0043), and future Rust/DataFusion/Tauri directions. New ADRs use [`adr/template.md`](adr/template.md).

## Reading Orders

### For implementation (engineers)

```text
product/00-roadmap
    ↓
product/02-mvp-scope-and-acceptance
    ↓
architecture/01-architecture
    ↓
engineering/01-tech-stack
    ↓
engineering/03-repository-structure
    ↓
engineering/02-implementation-plan
    ↓
engineering/04-testing-security-quality
    ↓
relevant ADRs during implementation (gate map: process/project-start-checklist;
current state + live queue: process/handoff.md §2/§6)
```

### For new contributors (fastest path to a PR)

```text
product/00-roadmap (§1–2 only)
    ↓
process/contributing
    ↓
process/handoff (§0–§2 + §6 — current state, decisions, live queues)
    ↓
engineering/03-repository-structure
    ↓
process/project-start-checklist (ADR-gate map)
```

### For long-term planning

```text
product/00-roadmap  →  product/03-execution-roadmap  →  ADR index
```

## Current Architectural Summary

```text
                              Assay

                 ┌──────────── Product Surfaces ────────────┐
                 │                                           │
               Web                VS Code                  CLI
                 │                    │                       │
                 └──────────── shared TypeScript core ────────┘
                                      │
                               Domain / Use Cases
                                      │
              ┌───────────────────────┼───────────────────────┐
              │                       │                       │
          Grid Core               Validation                Diff
              │                       │                       │
              └──────────────────── DataEngine ──────────────┘
                                      │
                       ┌──────────────┴───────────────┐
                       │                              │
                 DuckDB-WASM                    parquet-wasm
                       │                              │
                       └──────── Apache Arrow ────────┘

Future enterprise:

                  Hosted Control Plane
                 TypeScript + PostgreSQL
                           │
                    policy / metadata
                           │
                    Governed Gateway
                  Rust + Axum + DataFusion
                           │
               S3 / ADLS / GCS / Lakehouse
```

## Product Principle

Assay should win on dataset understanding, validation, comparison, repair, review, and governance
rather than on rebuilding commodity infrastructure such as query engines, cryptography, storage
systems, or generic charting. The full vision statement is owned by
[product/00-roadmap.md §1](product/00-roadmap.md#1-product-vision).

## Legacy document numbering (renumbered 2026-09-23, decision DM-4b)

The pre-2026-09-14 flat `00`–`11` series survived the category reorg with cross-category
collisions. On 2026-09-23 all numbered docs were renumbered **within their category by
reading order** (`product/` keeps `00` as its entry point; `process/` drops numbers — its
files are unnumbered). Immutable records — accepted ADRs, archived queues, dated review
snapshots — intentionally still cite the legacy paths; resolve them here:

**Legacy "docs NN" shorthand.** Docs and code comments written before the 2026-09-23 renumber
also cite files by old bare numbers ("docs 03 §17", "docs 06 §5"). Map the number, not the
current file that happens to carry it: docs 00/01 vision+principles, docs 02 data model,
docs 03 architecture, docs 04 MVP scope, docs 05 repository structure → `engineering/03`,
docs 06 testing/security/quality → `engineering/04`, docs 07 implementation plan →
`engineering/02`, docs 08 tech stack → `engineering/01`, docs 09 execution roadmap →
`product/03`, docs 10 pipeline → `architecture/02`, docs 11 post-MVP → `product/04`,
docs 12 telemetry → `engineering/06`.

| Legacy path (cited in ADRs/archives/reviews ≤ 2026-09-23) | Current path                                 |
| --------------------------------------------------------- | -------------------------------------------- |
| `product/07-mvp-scope-and-acceptance.md`                  | `product/02-mvp-scope-and-acceptance.md`     |
| `product/10-execution-roadmap.md`                         | `product/03-execution-roadmap.md`            |
| `product/11-post-mvp-track.md`                            | `product/04-post-mvp-track.md`               |
| `architecture/02-architecture.md`                         | `architecture/01-architecture.md`            |
| `architecture/09-pipeline-dag-etl.md`                     | `architecture/02-pipeline-dag-etl.md`        |
| `engineering/03-tech-stack.md`                            | `engineering/01-tech-stack.md`               |
| `engineering/04-implementation-plan.md`                   | `engineering/02-implementation-plan.md`      |
| `engineering/05-repository-structure.md`                  | `engineering/03-repository-structure.md`     |
| `engineering/06-testing-security-quality.md`              | `engineering/04-testing-security-quality.md` |
| `engineering/07-m1-benchmarks.md`                         | `engineering/05-m1-benchmarks.md`            |
| `engineering/08-telemetry-design.md`                      | `engineering/06-telemetry-design.md`         |
| `process/08-project-start-checklist.md`                   | `process/project-start-checklist.md`         |

(`product/00-roadmap.md` and `product/01-features.md` kept their numbers.)

## Documentation Conventions

- **Naming (ADR 0039):** the product is **Assay**. Documents written before 2026-09-14 use the old descriptive name "Data Workbench" and paths like `.dataworkbench/` — they refer to the same product and to today's `.assay/` workspace. Where a pre-rename document and a newer one disagree on naming, the newer one wins.
- Numbered documents are strategic/engineering references; numbers encode reading order within their category (per-category scheme re-established by the 2026-09-23 renumber — see the legacy table above), not importance.
- Durable decisions belong in ADRs, not in these documents; when a doc and an ADR conflict, the ADR wins and the doc should be updated.
- Reviews are dated snapshots and are not living documents.
