# Project Handoff — Assay

**Last updated:** 2026-10-14. **Current lane:** repository maintenance, then PT-V
slice 2. This is the current-state index, not the execution-history archive.

## 0. How to use this document

Read this file, [AGENTS.md](../../AGENTS.md), the
[execution roadmap](../product/03-execution-roadmap.md), and the relevant queue
before claiming work. Accepted [ADRs](../adr/README.md) win over other documents.
The [operating model](handoff/operating-model.md) governs dispatch and review.

Historical narratives and globally sequential §9 codes through **ev** are
preserved in the [pre-cleanup snapshot](handoff-snapshot-20261014.md). Closed
queue rows remain their authoritative implementation/review evidence. Never
execute historical pickup prompts without checking the living queue.

## 1. Product and scope

Assay is a local-first dataset workbench for Parquet, JSONL/JSON, CSV and
Arrow/Feather. Dataset contents stay local by default; telemetry contains only
allowlisted operational metadata (ADRs 0025/0037/0045).

MVP M0–M6 is complete. Pipeline P1–P3 and local DCR artifact v1 generation are
implemented. PT-V slice 1 provides desktop VS Code open/inspect with a vendored,
offline engine. Editing, validation, diff and Git integration in VS Code are
next; vscode-web remains **RE-SCOPE**, not authorized implementation (D18).
Hosted/AI/enterprise work remains gated by roadmap G2–G4.

## 2. Current state

| Surface         | Implemented                                                                                    | Remaining                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Web + CLI       | Inspect, profile, query, edit/export, validate and diff; pipeline execution and DCR generation | Maintenance and launch readiness                                             |
| Pipeline        | P1 IR/runner, P2 gates/materialization, P3 candidate references + canonical DCR                | P4 adapter priority is a later user-demand decision                          |
| Desktop VS Code | Read-only custom editor, virtualized grid, sort/filter-lite, offline engine                    | PT-V slice 2: edit, validate, diff, Git context and diff command             |
| Release         | Compiled artifacts and local consumer-smoke infrastructure exist                               | Current CLI dependency closure needs repair/revalidation; no npm publication |

**Verification baseline:** `1c4b50f` (2026-10-14): format, lint, typecheck
(20 tasks), unit tests (**2938 / 180 files**) and build (10 tasks) passed.
Typecheck/build used Turbo cache; this is not fresh remote-CI evidence. Last
recorded coverage at slice-1 close: **89.17/83.33/89.2/90.72**, thresholds
83/76/80/84. There are **151 pending changesets**. Recount after implementation.

**Known verification gaps:** the consumer smoke omits CLI dependencies
`@assay/pipeline` and `@assay/telemetry`; pipeline has no compiled build/export
setup. Root build currently skips VS Code (`build:spike` only), and CI runs
neither its real-VSCode e2e nor the slice-1 exit harness. These are maintenance
queue tasks, not evidence that current publication is safe.

## 3. Decision ledger

The [roadmap §7](../product/03-execution-roadmap.md) and
[maintainer rulings](handoff/20260926-maintainer-rulings.md) are authoritative.
D13 keeps `DataEngine` as a target with compatibility pins; D17/D19 bind DCR v1;
D18 authorizes the desktop-extension webview, not vscode-web. Do not re-decide
these or widen publication/telemetry boundaries in a packaging fix.

## 4. Environment and tooling

- Node 24 on this host; Node ≥22 supported. pnpm **11.26.0** via corepack.
- `DUCKDB=/tmp/duckdb` (pinned CLI **1.5.5**) for generated large fixtures and
  real-engine tests. Regenerate committed Parquet deliberately and verify digests.
- Playwright Chromium must be installed; e2e serves built output, so build first.
- Desktop VS Code verification needs `xvfb-run` when headless. The canonical
  cache is `~/.vscode-test/vscode-linux-x64-1.130.0`; see the
  [clean-worktree runbook](../../apps/vscode/README.md).
- Host-load timeout flakes are recorded in the
  [October 11 snapshot](handoff/20261011-next-steps.md) §5. Re-run isolated and
  escalate recurring signatures; do not silently ignore failures.
- Current session: worker **`openai-codex/gpt-6-luna`**, parent orchestrator +
  independent reviewer, explicitly selected by the maintainer 2026-10-14.
  Serialized dispatches; briefs/logs in `/tmp`; no remote push or publication.

## 5. Definition of done

Follow [AGENTS.md](../../AGENTS.md) and operating-model §7.3: format, lint,
typecheck, unit tests and build green; coverage floors preserved; doc links and
ADR index current. Run relevant e2e/harnesses for behavior changes. Workers do
not approve their own changes. Package changes need changesets; dataset-shape
bugs need minimal golden fixtures and regression pins. Durable decisions need
an ADR, never a silent rewrite of an accepted decision.

## 6. Task queues

### Active

[20261014-repository-maintenance.md](handoff/20261014-repository-maintenance.md):
current-state docs → packed CLI closure → VS Code build/CI → q-14 correctness.
After those rows, author and execute PT-V slice 2 from the recorded scope.

PT-Q residue remains pickup-ready under
[product/04 §7](../product/04-post-mvp-track.md): **q-5b** e2e helper
consolidation and **q-7 slice 2** testing-package strictness. These are separate
maintenance tasks, not scope riders on an engine feature change.

### Closed and historical

- [P3 queue](handoff/20261002-p3-queue.md): six rows closed 2026-10-11; local
  DCR generation on web + CLI, conformance and honesty pins.
- [PT-V slice-1 queue](handoff/20261002-ptv-slice1-queue.md): five rows closed
  2026-10-11; §5 contains the slice-2 candidate list.
- [Q-15/PT-P2 carry-over queue](handoff/20261002-q15-queue.md): closed.
- Earlier queue index and detailed outcomes: [historical snapshot](handoff-snapshot-20261014.md).
- [October 11 pickup pack](handoff/20261011-p3-ptv-pickup.md) is **historical;
  do not dispatch**. Every implementation row in that pack has landed.

### Human-only launch work

npm org claim, trademark/domain clearance, telemetry collector deployment,
public disclosure, org transfer/public visibility and demo-data approval are
maintainer actions. See [manual actions](manual-actions.md). The
[publish runbook](handoff/20260926-publish-runbook.md) must be revalidated against
the repaired dependency closure before a release; its September validation is
historical, not a present-day release approval.

## 7. Multi-agent operating model

See [operating-model.md](handoff/operating-model.md), preserving §7.1–§7.6.
Orchestrator owns shared docs/root configuration; workers execute one bounded
implementation task; parent independently reviews, verifies and integrates.

## 8. Handoff checklist

- Read current queue status, relevant ADRs and task STOP boundaries.
- Establish a clean-tree baseline and verification logs before implementation.
- Record review outcomes and unresolved blockers in the queue immediately.
- Update this index only when current state changes; keep detailed history in
  queue records. Preserve old evidence, but never label it dispatch-ready.

## 9. Changelog for this document

Historical codes through **ev** are in the
[preserved snapshot §9](handoff-snapshot-20261014.md#9-changelog-for-this-document).
New codes continue sequentially; link to queue evidence instead of duplicating it.

- 2026-10-14 (**ew**) — current-state truth pass and compact handoff; historical
  evidence preserved, obsolete dispatch prompts labeled, packaging/VS Code CI
  gaps recorded; [repository maintenance queue](handoff/20261014-repository-maintenance.md).
