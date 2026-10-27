# Project Handoff — Assay

**Last updated:** 2026-10-27. **Current lane:** G0-readiness and recorded-gap batch CLOSED (gb-1…gb-5, queue carries the record). Everything waiting on a human, a decision, or a remote operation is consolidated in the [open-asks checklist](handoff/20261019-open-asks.md). **Pickup-ready (authored 2026-10-26; ug-1/ug-2/ug-7 integrated, next ug-3/ug-8):** the [usability queue](handoff/20261026-usability-queue.md), owning the 37 findings (UG-1…UG-37) of the [usability gap review](../reviews/2026-10-26-usability-gap-review.md) — dispatch from the queue, not the review.
([queue](handoff/20261019-g0-readiness-queue.md)): gb-1 telemetry
disclosure doc → gb-2 PT-Q carry-over pack → gb-3 desktop JSON/JSONL
vendoring → gb-4 DOUBLE row-diff quirk → gb-5 CLI dev error; human inputs
listed in queue §5.
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
implemented. Desktop VS Code reproduces the full MVP workflow end-to-end (slice 2
closed 2026-10-19): offline open/inspect, session-only overlay editing with
undo/redo, create-only export, effective-view validation with stale
marking, confirmed-key staged diff with report delivery, Git context and
the compare command — all proven against the installed CLI; vscode-web remains **RE-SCOPE**, not authorized implementation (D18).
Hosted/AI/enterprise work remains gated by roadmap G2–G4.

## 2. Current state

| Surface         | Implemented                                                                                                                                                                                                                                        | Remaining                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Web + CLI       | Inspect, profile, query, edit/export, validate and diff; pipeline execution and DCR generation                                                                                                                                                     | Maintenance and launch readiness                                |
| Pipeline        | P1 IR/runner, P2 gates/materialization, P3 candidate references + canonical DCR                                                                                                                                                                    | P4 adapter priority is a later user-demand decision             |
| Desktop VS Code | Immutable-source editor, overlay editing/history, create-only export, effective-view validation, staged diff with confirmed keys + installed-CLI agreement, Git context + compare command, exit-acceptance chain, virtualized grid, offline engine | PT-V slice 2 closed; maintenance + track planning               |
| Release         | Complete packed CLI runtime closure verified under plain Node                                                                                                                                                                                      | Private-dependency registry distribution policy + human release |

**Verified state (2026-10-19):** slice 2 CLOSED with ptv2-8 (exit acceptance) integrated as `bce449f` after an independent reviewer approve (one request-changes round added independently-normalized refusal evidence). Forced typecheck **20**, unit **3027/191**, coverage **87.84/81.97/88.65/89.29** above floors, build **12**, browser **175 + 1 skip**, native **9**, spike **15 pins**, real-VSCode **10/10 scenarios** (full MVP-scenario-11 chain: validate 1/0/1/0 → confirmed-key diff 1/1/1 → report + copy delivery; offline JSON/JSONL opens; six staged-diff installed-CLI legs; acceptance agreement). Closure records: [slice-2 queue](handoff/20261014-ptv-slice2-queue.md) and the [G0-readiness/recorded-gap batch](handoff/20261019-g0-readiness-queue.md). **164 pending changesets**, doc links **107/0**, ADRs **46**.

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

[Usability queue](handoff/20261026-usability-queue.md): **opened 2026-10-26, pickup-ready** —
23 rows (ug-1…ug-23) across three lanes (Shell / Grid / Panels) owning the
[usability gap review](../reviews/2026-10-26-usability-gap-review.md) findings UG-1…UG-37
(first-run contract, affordance visibility, failure containment, journey coherence). Read
the queue's §2 lane rules, §3 standing constraints and §5 execution clarifications before
claiming. **UX/UI pickup pack (2026-10-26, docs only):**
[implementation spec](../product/09-ux-ui-implementation-spec.md),
[visual execution queue](handoff/20261026-ux-ui-execution-queue.md) and
[next-agent prompts](handoff/20261026-ux-ui-pickup-prompts.md#1-next-ai-orchestrator-start-here).
Baseline **recorded 2026-10-26 at `7d8e1ca`** (clean tree; six gates, coverage, docs/ADR checks
green: 3029 unit / 175 e2e passed). **ug-1 integrated at `e92c0dd`, ug-2 at `8e5fd62`, ug-7 at
`9c29da4`** after independent review (ug-7 needed a test-only amendment for the new-dataset
recovery-reset pin); merged gates 193 unit files / 3056 tests, e2e 180 passed + 1 skipped,
coverage 87.98/82.08/88.89/89.46. **ug-3 (Shell)** and **ug-8 (Panels)** are the next eligible
rows in isolated worktrees. ug-10 is decision-blocked (UX-D1), and SQL sizing remains deferred
design-only. The visual queue does not replace ug ownership.

[PT-V slice-2 queue](handoff/20261014-ptv-slice2-queue.md): eight serialized
rows CLOSED 2026-10-19 — all eight rows integrated and independently
reviewed (the exit-acceptance chain reproduces MVP scenario 11 with
installed-CLI agreement). Do not redispatch slice 2 or its completed q-5b/q-7 maintenance.
The [repository maintenance queue](handoff/20261014-repository-maintenance.md)
is **closed**: docs, packaging, VS Code build/CI and q-14 all integrated.

PT-Q q-5b and q-7 **landed 2026-10-19** (records fk/fl below). The remaining q-6a
performance-probe harness is tracked under [product/04 §7](../product/04-post-mvp-track.md);
it is separate maintenance, not a rider on this UX/UI batch.

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

- 2026-10-28 (**fx**) — ug-3 integrated at `5253c06`: idle-only bundled synthetic nested
  example through the guarded open chain, 12 rows / 10 columns, no picker or fixture fetch.
  Luna xhigh worker → independent GLM Flash approve; merged 3067 unit / 181 e2e + 1 skip,
  coverage87.99/82.09/88.93/89.47. ug-8 claimed in isolated Panels worktree; ug-10 stays UX-D1 blocked.

- 2026-10-27 (**fw**) — ug-7 residual review evidence closed by test-only `8367fbd`
  (Luna xhigh worker → independent GLM Flash approve). All ten panel crashes, independent copy
  pins and two native-keyboard recovery journeys; merged 3064 unit / 180 e2e + 1 skip,
  coverage 87.98/82.09/88.89/89.46. Exact-main-revision verification used a clean isolated
  worktree, preserving another agent's uncommitted work. Foreign server occupied 4173;
  identity-checked full rerun on 4573/4579/4580 passed. Detailed evidence in usability queue §5.

Historical codes through **ev** are in the
[preserved snapshot §9](handoff-snapshot-20261014.md#9-changelog-for-this-document).
New codes continue sequentially; link to queue evidence instead of duplicating it.

- 2026-10-27 (**fv**) — **ug-2 + ug-7 integrated** (`8e5fd62`, `9c29da4`): first-run idle
  contract + standards-valid picker hints; panel-scoped error boundaries with recoverable
  close/reopen and an App-owned session-scoped SQL request ledger. ug-2 approved directly
  (the `behavior-subject.ts` test adapter was proven necessary and behavior-preserving);
  ug-7 review requested a missing new-dataset reset pin → test-only amendment (`c15d618`) →
  approve. Merged gates: 193 unit files / 3056 tests, e2e 180 passed + 1 skipped, coverage
  87.98/82.08/88.89/89.46, docs 116/0, ADR 46; logs `/tmp/assay-ux-merged/`. Model diversity
  unavailable (deepseek-flash only); independent session separation disclosed.
- 2026-10-26 (**fu**) — **ug-1 integrated** (`e92c0dd`): nested Flatten/Explode now opens the
  SQL section through the existing seam, scrolls and focuses the matching populated/empty/error
  outcome; composition rejection opens nothing and manual runs/paging never steal focus.
  Fresh-session review found empty/error focus unpinned, requested a test-only amendment, and
  approved after the named pins failed under mutation. Merged gates: 192 unit files / 3034
  tests, e2e 179 passed + 1 skipped, coverage 87.87/82.03/88.70/89.33, docs 116/0, ADR 46;
  logs `/tmp/assay-ux-ug-1-merged/`. Model diversity unavailable in this runtime
  (deepseek-flash only); independent session separation used and disclosed.
- 2026-10-26 (**ft**) — integrated the reviewed UX/UI documentation pack (`7d8e1ca`) and
  recorded the **uxv-0 clean-main baseline** at that revision: format/lint/typecheck/build exit 0,
  **191 unit files / 3029 tests passed**, **175 e2e passed + 1 skipped**, coverage 87.85/81.98/
  88.63/89.31, docs links 116/0, ADR index 46; logs in `/tmp/assay-ux-uxv-0-orchestrator/`.
  No implementation row was claimed by this record; ug-1 is next eligible.
- 2026-10-26 (**fs**) — authored the
  [UX/UI executable pickup pack](handoff/20261026-ux-ui-pickup-prompts.md): requirement spec,
  four light/dark reference frames, uxv queue and role prompts; ug scope clarifications and
  explicit ug-10 profiling decision block. Docs only; no baseline/runtime/remote-green claim.
  Removed stale §6 instructions to repeat already-closed PT-V/q-5b/q-7 work.
- 2026-10-19 (**fr**) — gb-5 done + G0-readiness batch CLOSED: honest
  repo-root CLI dev error (`60a3fcd`, boundary-pinned); all five rows
  integrated; all three slice-2 recorded gaps closed.
- 2026-10-19 (**fq**) — gb-4 done: external-parquet DOUBLE quirk
  investigated — false-changed NOT reproducible (guarded by 3 new
  browser-engine journeys); adjacent REAL limitation found + pinned
  (near-DBL_MAX stats ranges crash the v1.4.3 reader at staging; typed
  failure + rollback). Role-flip row; reviewer 2 rounds. Browser e2e now
  175+1.
- 2026-10-19 (**fp**) — gb-3 done: DuckDB json extension vendored
  (v1.4.3/wasm_mvp, digest-pinned); desktop JSON/JSONL opens offline —
  slice-2 gap (1) closed; real-host e2e 10/10; digest + deregistration
  drills bite.
- 2026-10-19 (**fo**) — gb-2 done: PT-Q carry-over pack landed
  (`2e990db`); 8 items + q-6a re-recorded open (probe absent); +2 CliIo
  pins; unit now 3023/3023.
- 2026-10-19 (**fn**) — gb-1 done: public telemetry disclosure doc
  (`docs/telemetry-disclosure.md`) with claim→source appendix; every
  load-bearing claim parent-verified against code; README front-door
  linked.
- 2026-10-19 (**fm**) — lane planned: G0-readiness and recorded-gap
  batch queued (gb-1…gb-5) from the PT-0 agent tail + slice-2 recorded
  gaps; handoff table corruption from the fj edit repaired (`8018ba3`,
  `116b8fb` for the pt-q table).
- 2026-10-19 (**fl**) — q-7 slice 2 done: strict indexed/optional TS
  checks on packages/testing; 17 value-preserving fallout fixes across
  testing/contracts/validation/diff (`a52ab8b`); violation + revert drills
  verified by parent; full suite 3021/3021 in one invocation; q-7 CLOSED.
- 2026-10-19 (**fk**) — q-5b done: remaining spec-local e2e helpers
  consolidated to one definition each (`ac992e4`); `beforeOpen` generalized
  into the shared open flow; parent drills all bite; e2e green ×2
  back-to-back + parent re-verify.
- 2026-10-19 (**fj**) — ptv2-8 exit acceptance integrated (parent-
  implemented, reviewer approve after the refusal-evidence fix); SLICE 2
  CLOSED — all eight rows done. En-route fixes: proof polarity bug, loud
  dist/ pack guard; nullability-drift exclusion documented (same class as
  the ptv2-6 columnDeltas gap). Maintenance queue next.
- 2026-10-19 (**fi**) — ptv2-7 Git context + compare command integrated:
  worker A/B, parent e2e (host-side adapter asserts after a resource
  block; reduced command proof), reviewer approve after the
  observation-derived fix; two adapter bugs fixed (nonexistent API field,
  numeric Status enum). ptv2-8 exit acceptance next.
- 2026-10-19 (**fh**) — ptv2-6 staged diff integrated: worker phases A/B,
  parent-implemented phase C after three worker stalls (role-flip),
  independent reviewer approve after fixes (fixture-class agreement legs,
  shape validation); six-leg installed-CLI agreement green on the real
  host; three gaps recorded (JSONL json-extension vendoring,
  external-parquet DOUBLE quirk, repo-root CLI dist error). ptv2-7 next.
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
