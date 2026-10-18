# Project Handoff — Assay

**Last updated:** 2026-10-18. **Current lane:** PT-V slice-2 implementation; ptv2-1/2/3/4/5 closed, ptv2-6 next.
Repository maintenance is closed. This is the current-state index, not the execution-history archive.

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
implemented. Desktop VS Code provides offline open/inspect, session-only overlay editing
with undo/redo, create-only export of the effective view to a new local file,
and contract validation of the effective view with stale marking. Diff and
Git integration remain pending; vscode-web remains **RE-SCOPE**, not authorized implementation (D18).
Hosted/AI/enterprise work remains gated by roadmap G2–G4.

## 2. Current state

| Surface         | Implemented                                                                                                                       | Remaining                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Web + CLI       | Inspect, profile, query, edit/export, validate and diff; pipeline execution and DCR generation                                    | Maintenance and launch readiness                                              |
| Pipeline        | P1 IR/runner, P2 gates/materialization, P3 candidate references + canonical DCR                                                   | P4 adapter priority is a later user-demand decision                           |
| Desktop VS Code | Immutable-source editor, overlay editing/history, create-only export, effective-view validation, virtualized grid, offline engine | PT-V slice 2: diff and Git workflows                                          |
| Release         | Complete packed CLI runtime closure verified under plain Node                                                                     | Private-dependency registry distribution policy + human release prerequisites |

**Verified state (2026-10-18):** ptv2-5 shared canonical diff report projection
integrated as `2d37af5`+`cb4620f` after parent review (three drills: key
order, raw rounding, verdict aspect — all bite, all restore). Forced
typecheck **20**, unit **2993/188**, coverage **88.68/82.84/89.05/90.19**
above floors, build **12**, browser **172 + 1 skip**, packed-CLI consumer
smoke **PASS**, links **107/0**, ADRs **46**. ptv2-4 evidence in the
[slice-2 queue](handoff/20261014-ptv-slice2-queue.md). **159 pending
changesets** (ptv2-5 added one). GLM worker lane regressed to 401
api_key_expired — renewal is human-owned; Luna fallback executed this row
in three serialized phases.

**Push / remote CI:** user-authorized normal `main` pushes verified at
`3a3a94b`/`ddd72f4`/`1f6cbb9` (remote SHA equality, 0/0 divergence). CI
runs [38615821301](https://github.com/minghao51/assay/actions/runs/38615821301),
[38616340554](https://github.com/minghao51/assay/actions/runs/38616340554)
and later runs on `1f6cbb9` failed **before any steps ran**: GitHub reports
account payments failed **or** spending limit needs increasing. No code gate
ran remotely; user deferred this blocker 2026-10-15. Human **[M6](manual-actions.md)**
must restore Actions billing/limit access, then re-run latest `main` CI.
No billing, visibility, publication or force-push change is authorized; local
green is not remote green. Remote hygiene: four dependabot branches were
force-updated on the origin remote 2026-10-17 (github-actions pin,
apache-arrow 21, vite plugin-react, npm minor-patch); triage is pending and
none are merged.

**Release boundary:** complete local CLI tarball closure is verified, but
registry distribution of private runtime dependencies remains an explicit
release-policy blocker. Local artifact/harness proof is not publication approval.

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
- Worker roster (maintainer preference, recorded 2026-10-17): implementer
  **`zai/glm-5.3-flash` first**, ideally reviewed by **`openai-codex/gpt-6-luna`**;
  when the GLM lane is unavailable (Go-lane usage-limit 429s, as throughout
  ptv2-3/4), **Luna implements and the parent orchestrator independently
  reviews** — the same model never both implements and reviews a change.
  Serialized dispatches; briefs/logs in `/tmp`; normal `main` pushes follow
  each independently verified row (ptv2-2/3/4 pushed); publication remains
  unauthorized.

## 5. Definition of done

Follow [AGENTS.md](../../AGENTS.md) and operating-model §7.3: format, lint,
typecheck, unit tests and build green; coverage floors preserved; doc links and
ADR index current. Run relevant e2e/harnesses for behavior changes. Workers do
not approve their own changes. Package changes need changesets; dataset-shape
bugs need minimal golden fixtures and regression pins. Durable decisions need
an ADR, never a silent rewrite of an accepted decision.

## 6. Task queues

### Active

[PT-V slice-2 queue](handoff/20261014-ptv-slice2-queue.md): eight serialized
rows authored. **ptv2-1 foundation, ptv2-2 overlay editing, ptv2-3
new-file export, ptv2-4 effective-view validation and ptv2-5 shared diff
report projection are DONE**; **ptv2-6 staged diff with confirmed keys is
next**, followed by Git context/command and real-host exit. These remaining
workflows are not yet delivered; slice 2 is not closed. The [repository maintenance queue](handoff/20261014-repository-maintenance.md)
is **closed**: docs, packaging, VS Code build/CI and q-14 all integrated.

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

- 2026-10-18 (**fg**) — ptv2-5 shared diff report projection integrated
  (new pure `report-projection` module in `@assay/diff`; CLI/web adapters
  consume it, −306 duplication lines, byte contracts pinned unchanged;
  serialized key-order pins added at package level). Full merged gates;
  three parent drills bite. GLM lane now 401 api_key_expired (human
  renewal); ptv2-6 next.
- 2026-10-18 (**ff**) — roster/plan refresh before ptv2-5 dispatch:
  operating-model §7.6 re-pinned to the maintainer's GLM-first worker /
  Luna-reviewer preference with Luna-worker/parent-reviewer fallback
  (Go-lane 429s current); queue §1 and this handoff aligned; dependabot
  remote-hygiene note added. No code change.
- 2026-10-18 (**fe**) — ptv2-4 effective-view validation integrated after
  parent drills (overlay drop, stale flip) and full merged gates; 2988/187,
  validationProof on the real host, 15 pins. GLM lane still 429-blocked;
  Luna fallback. Restored the Push/remote-CI paragraph lost in the fd edit.
  ptv2-5 next; remote CI still blocked on human billing (M6).
- 2026-10-17 (**fd**) — ptv2-3 create-only export integrated after a
  withdrawn STOP (stale-dist timeout, not unreadable scratch), real scratch
  read proof, parent drills (wx/overlay/early-finish) and full merged gates;
  2982/186, 7 real-host scenarios, 15 pins. Pre-existing default-mode CLI/contracts
  contention timeouts documented with an unmodified-main control. ptv2-4 next;
  remote CI still blocked on human billing action (M6).
- 2026-10-15 (**fc**) — ptv2-2 integrated after independent correction loops,
  cast/history mutants and full gates + real-host/offline proofs; 2977/184,
  15 pins, scalar codec limits disclosed. Session overlays do not save sources.
  ptv2-3 next; user authorizes normal push, not publication or a slice exit.
- 2026-10-14 (**fb**) — ptv2-1 pure bridge helpers/test discovery integrated
  after independent mutation + full gates/harnesses; 2960/182, coverage improves,
  merged host-contention retries recorded, no limits loosened. ptv2-2 next;
  no slice-2 exit claim, push or publication.
- 2026-10-14 (**fa**) — PT-V slice-2 queue authored with bounded scopes,
  explicit new-file delivery/key-confirmation/privacy defaults and STOPs;
  execution begins with ptv2-1. No slice-2 exit claim or release authorization.
- 2026-10-14 (**ez**) — q-14 integrated after parent mutation + full gates,
  e2e and VS Code harness verification; maintenance queue closed. Slice-2
  authoring next; registry publication and human G0 work still not authorized.
- 2026-10-14 (**ey**) — rm-3 real-VSCode build/CI integrated after independent
  policy/drill/harness verification; pinned runtime, unchanged vendored assets,
  formatter exclusion. Remote workflow not yet run; maintenance queue holds evidence.
- 2026-10-14 (**ex**) — rm-2 packed runtime closure integrated after independent
  review + mutation + full gates/e2e; local artifact proof does not authorize
  registry publication. Evidence in the maintenance queue.
- 2026-10-14 (**ew**) — current-state truth pass and compact handoff; historical
  evidence preserved, obsolete dispatch prompts labeled, packaging/VS Code CI
  gaps recorded; [repository maintenance queue](handoff/20261014-repository-maintenance.md).
