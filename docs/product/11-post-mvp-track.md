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
  worker/reviewer protocol for every task ([handoff operating model](../process/handoff/operating-model.md)).
- **Not yet done (all tracked, none blocking local use):** no telemetry implementation exists
  (design-only: ADR 0037 opt-out stance, ADR 0025 exclusions); remote **now exists** — private
  [`minghao51/assay`](https://github.com/minghao51/assay), `main` pushed 2026-09-21, CI green on
  the first remote run and again after the `actions/*` SHA-pin (M2/M3 done; org-transfer +
  public flip remain maintainer calls); no npm org claim; no demo dataset; a11y CI not started.
- **Whole-repo audit (2026-09-22):** seven-lane read-only audit of every package/app/infra
  ([report](../reviews/2026-09-22-whole-repo-implementation-audit.md)) — 2 criticals (BLOB CSV
  formula-injection bypass; web cell-editor wrong-row commit), ~35 warnings, structural gaps.
  Correctness/security/honesty findings → the handoff **AR queue**
  ([`20260922-ar-queue.md`](../process/handoff/20260922-ar-queue.md); ar-1…ar-6); QoL/perf/polish
  findings → **PT-Q** (§7 below); interface/stub fate → open decision **D13** (§9).

## 3. Track structure

| Track                                  | Contents                                                                                                                                                                                                                                                 | Entry condition                                                   | Exit / gate                                                                                |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **PT-0 Launch readiness**              | the G0 checklist (§4): telemetry design tail (D2), GitHub push + remote CI (manual M2/M3), npm org (manual M1), trademark/domain (manual M4), demo dataset (O5), a11y CI (O3), security disclosure channel, docs/site basics                             | now                                                               | **G0** — required before any public launch                                                 |
| **PT-V VS Code extension** (former M7) | custom editors, workspace adapter, Git context, dataset diff command (roadmap §3.1 M7 row); ADRs 0008/0022                                                                                                                                               | R4 webview feasibility spike first                                | parity subset e2e-proven in VS Code; MVP-acceptance scenarios of docs 07 that name VS Code |
| **PT-P Pipeline foundation** (P1–P2)   | P1: pipeline IR, DAG validation, source/SQL/transform nodes, DuckDB runner (ADRs 0029/0030/0032). P2: validation nodes, publish gates, preview, materialization, lineage (ADRs 0033/0035)                                                                | **met** — roadmap §3.2 required "M2 and M5 stable"; both are done | P2 exit per docs 04 §17; P3+ (DCR integration) follows M9 scoping                          |
| **PT-H Hardening & backlog**           | recorded carry-overs (§6), scale/bench open questions, a11y, supply chain                                                                                                                                                                                | any time (fills lanes between track tasks)                        | per-item                                                                                   |
| **PT-Q QoL & performance**             | the quality-of-life / optimization thread split out of the 2026-09-22 whole-repo audit (§7): render/theme/a11y polish, CLI UX, e2e hygiene, engine perf budgets, tooling strictness — correctness/security findings went to the handoff AR queue instead | any time (independent thread; see §7 for the pickup protocol)     | per-item                                                                                   |
| **Gated (unchanged)**                  | M8 AI dataset mode (G2), M9 local DCR generation, M10 team workspace (G3), M11/M12 enterprise (G4); T5 investment-gated                                                                                                                                  | per gate evidence — no change                                     | roadmap §5                                                                                 |

Sequencing rule (unchanged from roadmap §2): T1–T4 advance in vertical slices; **T5 stays
investment-gated** — nothing in this track re-opens that.

## 4. PT-0 — launch readiness (the G0 checklist)

G0 (roadmap §5) requires: license chosen ✅ (AGPL-3.0-or-later, ADR 0036); telemetry design
approved (opt-out stance per ADR 0037 — first-run disclosure + `ASSAY_NO_TELEMETRY`; metadata-only per ADR 0025); security
disclosure channel live; demo scenario passes end-to-end. The concrete remaining items:

| #   | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Kind                      | Tracked                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ---------------------------------- |
| 1   | **Telemetry design doc (D2 tail):** allowlisted event schema + sampling for the self-hosted minimal collector (D2b, 2026-09-16). Metadata-only per ADR 0025 — never dataset contents, filenames-where-sensitive, raw SQL results, cell values, PII. Opt-out (`ASSAY_NO_TELEMETRY`) with first-run disclosure per ADR 0037 — **design authored 2026-09-21 (`docs/engineering/08-telemetry-design.md`, pt0-1, reviewer-approved); ⏸ awaiting maintainer C-pt0-1 approval before any implementation** | design + impl             | roadmap §7 D2; manual-actions note |
| 2   | **GitHub org/repo + first push** (manual M2): org `assay`, repo, `origin`, push `main` (155 commits, never left this machine). Unlocks remote CI (verify + e2e jobs authored, never run remotely), PR flow, dependabot — **done 2026-09-21** (deviation: private repo under the maintainer account `minghao51/assay`, not an org; transfer possible later; public flip separate)                                                                                                                   | human (done)              | manual-actions M2 (done)           |
| 3   | **Remote CI green + SHA-pin actions** (manual M3, was blocked by 2): confirm Actions runs green on `main`, then SHA-pin `actions/*` (m1-8 carry-over; supply-chain risk R13) — **done 2026-09-21** (first run `35559237075` green; pin commit `d19232c`; re-run `35559638256` green)                                                                                                                                                                                                               | done                      | manual-actions M3 (done)           |
| 4   | **npm org claim** (manual M1): `@assay` scope must be ours before first publish (D6 tail)                                                                                                                                                                                                                                                                                                                                                                                                          | human                     | manual-actions M1                  |
| 5   | **Trademark/domain clearance** (manual M4, G0 tail)                                                                                                                                                                                                                                                                                                                                                                                                                                                | human                     | manual-actions M4                  |
| 6   | **Demo dataset (O5):** hybrid approach decided 2026-09-16 (real open data + injected flaws); curation not started — best after the diff/validation story is demoable (it now is)                                                                                                                                                                                                                                                                                                                   | non-code track            | manual-actions note                |
| 7   | **A11y CI (O3):** not started; a11y is in the definition of done (docs 06 §10) and the grid/schema tree already use disclosure patterns — wire axe or equivalent into CI                                                                                                                                                                                                                                                                                                                           | agent tasks               | roadmap opportunities              |
| 8   | **Security disclosure channel:** a SECURITY.md + private contact route (G0 requirement; complements ADR 0007's "no invented crypto" and the untrusted-cell-content rules)                                                                                                                                                                                                                                                                                                                          | small doc + human routing | —                                  |
| 9   | **Docs/site basics:** README as a front door, install/try steps for web + CLI, fixture story                                                                                                                                                                                                                                                                                                                                                                                                       | agent tasks               | —                                  |

PT-0 is deliberately small: items 2–5 are human actions, 1/6–9 are one-to-few agent tasks each.
**Recommendation (needs maintainer sign-off — see §9): run PT-0 to G0 before starting PT-V or
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

Everything below is already recorded in the handoff queue files (now
[`docs/process/handoff/`](../process/handoff/), completed queues archived there) or in its
changelog; listed here so the post-MVP
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

## 7. PT-Q — QoL & performance track (the separate thread)

Created 2026-09-22 when the whole-repo audit's findings were split: everything that is
**correctness/security/honesty remediation** went to the handoff AR queue
([`20260922-ar-queue.md`](../process/handoff/20260922-ar-queue.md); ar-1…ar-6);
everything that is **quality-of-life, performance, polish, or tooling headroom** lives here —
as one coherent thread a fresh agent session can pick up without further triage.

**Pickup protocol (for any new agent session):**

1. Read `docs/process/handoff.md` (§2 state, §5 definition of done),
   [`docs/process/handoff/operating-model.md`](../process/handoff/operating-model.md) (multi-agent
   model), and the
   [audit report](../reviews/2026-09-22-whole-repo-implementation-audit.md) sections cited below
   (each item carries stable `AR-*` finding IDs with file:line).
2. Take items **in order** (q-1 first); one item per worker dispatch, reviewer per §7.5
   (worker `opencode-go/deepseek-v4.1-flash`, reviewer `zai/glm-5.3-flash`, briefs to `/tmp`
   per the operating model's dispatch runbook §7.6).
3. **Conflict rule:** q-1 touches `apps/web/src/grid/DataGrid.tsx` + `App.tsx`, which ar-2 also
   edits — serialize q-1 against ar-2 (land one before dispatching the other). Every other item is
   parallel-safe against the AR queue (disjoint paths).
4. Each item ships under the standard definition of done (six gates, changeset for package
   changes, regression/e2e pins for behavior changes). Items are intentionally small: one
   Conventional Commit each (`refactor:`/`perf:`/`chore:`/`test:` as appropriate).

| #   | Item (done-when)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Audit refs         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| q-1 | **Web render-performance pass:** precompute per-column parsed types (`parseDuckDbType` once per column, not per cell per render — editor-kind + decimal + object paths) or memoize it; narrow the App-level model subscription that re-renders the whole panel tree on every fetch notify (small schema wrapper or `React.memo` panels). Done-when: profiler or count-based evidence of reduced renders/parse calls on a scroll trace; zero behavior change (existing e2e/component suites green unchanged).                                                                 | AR-W7 (report §3)  |
| q-2 | **Theme token layer + dark mode:** extract the ~145 hard-coded color literals in `apps/web/src/index.css` into `:root` custom properties; add `prefers-color-scheme` support + `color-scheme` meta; all components read tokens. Done-when: grep-provable no raw color literals outside the token block (or a documented allowlist); light/dark screenshots pinned by an e2e smoke.                                                                                                                                                                                           | report §3 S1       |
| q-3 | **A11y polish pack (beyond pt0-4's axe CI):** ExportDialog gets `aria-modal`, initial focus, focus trap, Escape-to-close (AR-W10); `aria-live` announcement for grid edit commit/reject; keyboard path audit for open → edit → export. Done-when: dialog e2e pins focus/Escape behavior; axe scan (from pt0-4) reports zero serious on the touched surfaces.                                                                                                                                                                                                                 | AR-W10 (report §3) |
| q-4 | **CLI UX pack:** `--quiet`; TTY-aware color (none when piped); progress output for long scans; `--version`/`--help` documented as global options; honest "profile deltas" counting (columns with non-zero delta, not all compared columns — keep the JSON exact); render collected `issues` in the human diff report; shared `identical`/delta-differs helper to stop drift; use `DATASET_VIEW` not the `'assay_t1'` literal. Done-when: each behavior e2e/unit-pinned; byte-stability of JSON outputs re-pinned.                                                            | AR-C6 (report §4)  |
| q-5 | **E2e hygiene pack:** consolidate duplicated helpers (`row`/`cell`/`headerCell`, `openFixture*`, `openEditor`/`editCell`/`renameColumn`/`castColumn`, `sha256`, `median`/`percentile`, `runScenario`) into `tests/e2e/support/`; replace magic `waitForTimeout`s (virtualization 90/35 ms per step, sql-editor 300 ms) with `expect.poll`/`waitForFunction` on observable state. Done-when: helper census grep shows one definition each; no `waitForTimeout` outside a documented exception; full e2e green ×2 back-to-back (jitter host rule per handoff §4).              | AR-F4, AR-F6       |
| q-6 | **Engine perf budgets:** document session-bounded costs (deep-offset windows, per-insert UNION ALL branches, overlay composer O(cols×edited-rows)) and add cheap guards where honest: an op-count cap on live-insert branches with a typed clear error, `baseColumnEdits` pregrouping per column, path-sharing in `insertSortKeys`. Done-when: conformance still byte-green (no SQL change visible in goldens unless a guard fires); caps pinned by unit tests; budgets written into the module docs. **Serialize against ar-1** (same package, hot files).                  | AR-E10 (report §2) |
| q-7 | **Tooling strictness:** eslint `no-console` (src only, allowlist harness/scripts), import-cycle detection (`eslint-plugin-import` or equivalent), purity rules extended to `packages/grid`, `packages/ui`, `packages/core`; tsconfig `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` adopted package-by-package (fix fallout inline; if the fallout is too broad for one task, land the flag on the pure packages first and record the remainder as the next q-7 slice). Done-when: lint green with the new rules on; a deliberate violation drill fails the lint. | AR-D9, AR-R9       |
| q-8 | **Value-free edit-error consistency (privacy posture):** map overlay materialization failures to the same value-free failure classes the validate/diff paths use, instead of passing raw DuckDB error text to the web edit session (local-only today, but the invariant should be mechanical). Done-when: rejection path renders the readable class + retains the rollback behavior (existing m4-3 e2e stays green); a probe with a quote-laden value shows no value in the alert.                                                                                           | AR-W12, AR-E9      |
| q-9 | **Dev QoL:** `turbo.json` cleanup (drop unused `test`/`lint` tasks, add `globalDependencies` for `tsconfig.base.json`); root + package `repository`/`homepage`/`bugs` fields; per-package `license` field + SPDX headers (AGPL-3.0-or-later, ADR 0036); pin `yaml` to exact `2.9.1` (canonical bytes are a golden-pinned surface). Done-when: gates green; `pnpm lint`/`format:check` green; license fields present in every workspace package.                                                                                                                              | AR-R9, AR-V8       |

PT-Q has no exit gate — it runs as lanes between AR-queue and PT-0/PT-V/PT-P tasks, or as a
dedicated thread if the maintainer prefers. New QoL findings from future work land here with the
same `AR-*`-style referencing discipline.

## 8. Gated tracks (unchanged)

M8 (AI dataset mode) waits on **G2** adoption evidence (repeat usage of web + VS Code,
validation/diff actually used per privacy-safe metrics, ≥10 recurring users qualitative);
M10 waits on **G3**; M11/M12 on **G4**. P3–P5 per roadmap §3.2 (P5 additionally requires
validated user demand). The gates exist precisely so these tracks never start on enthusiasm —
no change.

## 9. Open decisions (maintainer)

| ID  | Decision                                                                   | Options / notes                                                                                                                                                                                                                                                                                                                                                                                             | Target                                        |
| --- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| D12 | First post-MVP engineering track after PT-0                                | (a) PT-V VS Code (completes the original MVP vision, another surface for G2 evidence) vs (b) PT-P P1 pipeline (opens the quality/publish story; T3 foundations are stable)                                                                                                                                                                                                                                  | first lane after G0 items land                |
| D2  | Telemetry event schema + sampling (design tail)                            | self-hosted minimal collector decided; schema/sampling open                                                                                                                                                                                                                                                                                                                                                 | G0                                            |
| D13 | Fate of the `@assay/engine` `DataEngine` abstraction + the 7 stub packages | (a) delete `packages/engine` until a second engine exists (docs 05/AGENTS corrected to match); (b) realign the interface to the real client shape + a type-level pin; (c) keep as aspirational spec. Stub packages (`ai`/`core`/`pipeline`/`security`/`transforms`/`ui`/`engine-parquet`): keep as track placeholders or prune from the workspace until their track starts. Audit finding AR-D7 (report §5) | before ar-3 edits the docs that describe them |
| —   | Demo dataset curation start                                                | hybrid decided; needs a maintainer go + source-data pick                                                                                                                                                                                                                                                                                                                                                    | G0 (demo scenario)                            |
| —   | ar-5 publishability checkpoint (C-ar-5)                                    | library build tooling pick (tsup vs tsc project references vs per-package vite lib mode) before any `@assay/*` packaging work; npm org claim (M1, human) before first publish                                                                                                                                                                                                                               | before ar-5 dispatches                        |

## 10. Maintenance

This document is orchestrator-owned (like the roadmap and handoff). Track tasks are still
sliced into handoff queue files ([`docs/process/handoff/`](../process/handoff/)) and executed under the
operating-model protocol; the roadmap
remains canonical for sequencing, and any durable/architectural decision made here gets an
ADR (next free number: 0042). Update §2's evidence line at every milestone close.
