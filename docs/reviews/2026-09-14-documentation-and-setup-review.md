# Documentation and Setup Review — 2026-09-14

> **ARCHIVE — point-in-time record (2026-09-14). Read as history, not as open work.**
> Dispositions shown below as "open" were settled the same day or soon after: C3 license →
> **AGPL-3.0-or-later** (D1, ADR 0036); the fixture-generator question → **DuckDB CLI**
> (D3, ADR 0038); §6 "decisions still needed" — 5 of the 6 decided 2026-09-14 (D1–D5); the M4
> row references the pre-rename `@dataworkbench/*` names (product renamed **Assay**, ADR 0039).
> Current state always: `docs/process/handoff.md`.

Status: complete
Reviewer: automated documentation/setup review (three-pass: docs review, setup review, synthesis)
Scope: `docs/` (10 core documents + 36 ADR files), repository scaffolding, git state, tooling environment.

---

## 1. Method

The review was performed in three passes, mirroring what a three-agent review team would cover:

1. **Documentation pass** — read every core document and ADR; check cross-references, numbering, status consistency, and internal contradictions.
2. **Setup pass** — compare the documented target stack/repository structure against the actual repository scaffolding, git state, and available tooling.
3. **Synthesis pass** — consolidate findings, prioritize, and feed the long-term execution roadmap (`../product/10-execution-roadmap.md`).

---

## 2. Strengths (keep and protect these)

The documentation set is unusually strong for a pre-code project:

- **Coherent end-to-end narrative**: vision → features → architecture → stack → milestones → testing/security, with 35 ADRs cross-referenced at the right moments (e.g., the checklist gates ADR review before each implementation area).
- **Principle discipline**: the same principles (local-first, "AI proposes; deterministic systems enforce", "grid is a view, not the dataset", Arrow interchange) recur consistently across documents with no contradictions found.
- **Explicit non-goals and commercial model** from day one; the MVP scope includes an exclusions list, acceptance criteria, and a concrete demo scenario.
- **Honest security posture**: the docs distinguish presentation-level masking from enforced security, commit to telemetry that excludes dataset contents, and refuse custom cryptography.
- **ADR hygiene**: numbering is contiguous (0001–0035), and every file's status matches the ADR index (verified programmatically).
- **Pragmatic build-vs-buy boundary**: docs consistently refuse to rebuild engines, grids-from-scratch, crypto, auth servers, etc., and name the actual moat.

---

## 3. Findings

Severity: **Critical** (blocks correct setup/release), **High** (blocks contributors/onboarding), **Medium** (consistency/process debt), **Low** (polish).

### Critical

| ID  | Finding                                                                                                                                                                                                                                                   | Disposition                                                                                                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | **Stack mismatch**: repository was scaffolded as a Python project (`main.py`, `pyproject.toml`, `.python-version`) while every document (ADR 0008, ADR 0019, docs 03 §3, 04 §2, 05 §1) specifies a pnpm + Turborepo TypeScript monorepo with DuckDB-WASM. | Resolved this session: Python scaffold removed; TS monorepo bootstrapped. If Python was intentional (e.g., CLI in Python), that conflicts with ADR 0008/0019 and docs 03 §17 — a new ADR would be required to reverse. |
| C2  | **No version-control baseline**: the repository had zero commits; all content was untracked, making any reorganization unsafe and history irrecoverable.                                                                                                  | Resolved: baseline commit created before any changes; default branch renamed `master` → `main`.                                                                                                                        |
| C3  | **No license decision** despite an open-core commercial model (docs 00 §5, ADR 0010). Licensing choice (e.g., Apache-2.0 vs AGPL-3.0 vs dual-license) affects adoption, contribution, and which enterprise features can be closed.                        | **Open — needs maintainer decision** before any public release. Tracked in the execution roadmap decision backlog.                                                                                                     |

### High

| ID  | Finding                                                                                                                                                  | Disposition                                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| H1  | **Empty root `README.md`** — no entry point, no quickstart, no docs map.                                                                                 | Resolved: root README written (what/why, quickstart, docs map, repo layout, status). |
| H2  | **`docs/README.md` index omits document 08** (`08-project-start-checklist.md` exists but is not listed or linked).                                       | Resolved: index rewritten; all documents indexed by category.                        |
| H3  | **No developer onboarding/contributing documentation** — no bootstrap commands, conventions, ADR process, or dependency-boundary rules for contributors. | Resolved: `../process/contributing.md` added; root `CONTRIBUTING.md` pointer added.  |
| H4  | **No CI** despite the checklist requiring GitHub Actions for typecheck/lint/test/build.                                                                  | Resolved: CI workflow added (verify + e2e jobs).                                     |

### Medium

| ID  | Finding                                                                                                                                                                                                                                                                                                                                                                  | Disposition                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | **Package-list divergence**: docs 02 §18 monorepo listing is missing `security`, `ai`, `testing`, and `pipeline` relative to the authoritative structure in docs 05.                                                                                                                                                                                                     | Resolved: 02 §18 aligned with 05.                                                                                                                                                                                 |
| M2  | **Pipeline sequencing conflict**: docs 04 §17 defines the pipeline track as **M1–M6** (M4 = DCR integration, M5 = ecosystem, M6 = ingestion/orchestration) while docs 09 §24 defines **Phase 1–5** with different ordering (Phase 3 = ecosystem + DCR, Phase 4 = SQLMesh/incremental, Phase 5 = ingestion). Two overlapping, non-identical sequences for the same track. | Resolved: `../product/10-execution-roadmap.md` declares one canonical pipeline sequence (superset) and marks docs 04/09 as descriptive inputs.                                                                    |
| M3  | **Roadmap↔milestone mapping is implicit**: docs 00 defines Phases 0–7, docs 04 defines Milestones 0–11, but no explicit mapping (which milestone delivers which phase, and which ADRs gate it) existed.                                                                                                                                                                  | Resolved: mapping table added to the execution roadmap.                                                                                                                                                           |
| M4  | **Naming inconsistency**: `data-workbench/` (docs 05 root), `dataworkbench` (repo dir, CLI name), `@dataworkbench/*` (docs 03 package scope), "Data Workbench" (display name).                                                                                                                                                                                           | Standardized this session: repo dir `dataworkbench`, npm scope `@dataworkbench/*`, display name "Data Workbench", CLI binary `dataworkbench`. Docs 05 updated. Trademark check remains an open low-priority item. |
| M5  | **No ADR template or process document** — future ADRs risk format drift.                                                                                                                                                                                                                                                                                                 | Resolved: `../adr/template.md` added and referenced from the ADR index.                                                                                                                                           |
| M6  | **`.gitignore` was Python-only** — no Node/TS/tooling ignores.                                                                                                                                                                                                                                                                                                           | Resolved: comprehensive Node/TS/monorepo ignore set.                                                                                                                                                              |
| M7  | **Binary fixture tooling undefined**: docs 06 §3 and 03 §24 commit to golden Parquet fixtures, but nothing defines how they are generated/regenerated (script? tool? committed binaries?).                                                                                                                                                                               | **Open — decision needed.** Interim: fixtures directory with text fixtures + per-directory READMEs; tracked in decision backlog.                                                                                  |
| M8  | **No release/versioning conventions** despite being an M0 deliverable (docs 04 §2).                                                                                                                                                                                                                                                                                      | Partially resolved: conventions section added to `contributing.md` (0.x.y, changesets later). Full policy (publishing cadence, deprecation) deferred to M0 completion.                                            |

### Low

| ID  | Finding                                                                                                 | Disposition                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| L1  | Placeholder artifacts: `main.py` hello-world, `pyproject.toml` description "Add your description here". | Resolved (removed with C1).                                                                             |
| L2  | Telemetry implementation plan (docs 03 §23, ADR 0025) has no concrete vendor/sampling/consent design.   | Deferred by design; must exist before first public launch — tracked as a gate in the execution roadmap. |
| L3  | No issue/PR templates, CODEOWNERS, or discussion conventions.                                           | Deferred (listed as opportunity O11).                                                                   |
| L4  | No automated docs link checking.                                                                        | Opportunity O6 — recommended for CI once docs grow.                                                     |
| L5  | No `SECURITY.md` / vulnerability-reporting channel.                                                     | Resolved: minimal `SECURITY.md` added, aligned with docs 06 principles.                                 |

---

## 4. Opportunities for enhancement

Not gaps — deliberate future improvements, ordered roughly by expected value:

1. **O1 — One-command quickstart.** `pnpm install && pnpm dev` booting the web app; keep this sacred as the project grows (no steps that require reading a doc first).
2. **O2 — Benchmark harness in CI.** Docs 06 §9 already define the metrics (time-to-first-row, scroll FPS, profile latency). A smoke benchmark job prevents perf regressions from the start; full budgets later.
3. **O3 — Accessibility CI.** The docs make unusually strong a11y commitments (06 §10); an axe/Playwright a11y check keeps that promise enforceable.
4. **O4 — Fixture generator.** A small deterministic generator (committed scripts producing Parquet fixtures) resolving M7 and enabling reproducible conformance tests.
5. **O5 — Curated demo dataset.** The MVP demo scenario (docs 07 §5) needs a stable, redistributable demo dataset (1 GB Parquet with nested columns); prepare it early and store generation scripts, not binaries where licensing is unclear.
6. **O6 — Docs link checker** (e.g., `lychee` or `markdown-link-check`) in CI.
7. **O7 — Docs site.** The documentation set is already structured well enough to publish as a static site (e.g., VitePress) when public launch approaches.
8. **O8 — Component workbench** (Storybook or similar) for `ui`/`grid` packages once real components exist.
9. **O9 — Design tokens / design system doc** before large UI investment; the grid UX (docs 03 §6) will need a documented interaction model.
10. **O10 — OpenSSF Scorecard / best-practices badge** after the repository is public.
11. **O11 — Issue/PR templates + labels** matched to the roadmap tracks, so incoming work self-classifies.
12. **O12 — Threat model document** (STRIDE-lite) for the browser/WASM boundary and, later, the gateway; extends ADR 0001/0006/0025.

---

## 5. Actions taken in this session

- Created baseline commit; default branch `main`.
- Reorganized `docs/` into `product/`, `architecture/`, `engineering/`, `process/`, `reviews/` (ADR directory unchanged); all cross-references updated; original filenames preserved for traceability.
- Rewrote `docs/README.md` as a complete index including document 08 and the new documents.
- Added: `docs/product/10-execution-roadmap.md` (canonical long-term roadmap), `docs/process/contributing.md`, `docs/adr/template.md`, this review.
- Fixed: docs 02 §18 package list (M1), docs 08 checklist completion state, docs 05 naming standardization.
- Removed the Python scaffold; bootstrapped the pnpm + Turborepo + TypeScript monorepo exactly per docs 05 (apps: web/cli/vscode placeholder; 16 packages; fixtures; shared TS/ESLint/Prettier/Vitest/Playwright config).
- Added CI (GitHub Actions: typecheck, lint, unit tests, build, e2e), root `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `.gitignore`, `.gitattributes`, `.editorconfig`, `.node-version`.

## 6. Decisions still needed from the maintainer

1. **License** (C3) — recommend deciding before the first public commit; candidates: Apache-2.0 (max adoption, weaker copyleft for open-core) vs AGPL-3.0 (stronger open-core protection) vs dual-license.
2. **Pipeline sequencing** — confirm the consolidated sequence in `10-execution-roadmap.md` supersedes both docs 04 §17 and 09 §24 (or amend).
3. **Fixture generation tooling** (M7) — e.g., small DuckDB CLI script vs committed binaries vs Rust helper.
4. **Timeline policy** — the docs deliberately avoid dates; confirm whether the roadmap should stay time-boxed by capacity (recommended pre-team) or adopt target quarters.
5. **Telemetry stance** — opt-in vs opt-out, self-host vs vendor; required before launch.
6. **Trademark/name clearance** — "Data Workbench" is a descriptive name; a search is advisable before public branding investment.
