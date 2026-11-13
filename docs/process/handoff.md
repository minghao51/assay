# Project Handoff — Assay

**Last updated:** 2026-11-13. **Current lane:** launch readiness; essential-workbench first wave selected (WF-06 runtime after fresh preflight, EW-02D/03D/04D design only); the original UX/UI programme and bounded audit follow-up are complete. The
[usability queue](handoff/20261026-usability-queue.md) owns the 37 findings (UG-1…UG-37) of the
[usability gap review](../reviews/2026-10-26-usability-gap-review.md) in 23 rows (ug-1…ug-23):
**all 23 are CLOSED** and merged-verified (Shell, Grid and Panels lanes complete). The
[visual queue](handoff/20261026-ux-ui-execution-queue.md) owns uxv-0…uxv-6: **uxv-0…uxv-5 are CLOSED**
and merged-verified (R-09…R-13 implemented), and **uxv-6 is design-only/deferred** behind a maintainer
decision. **No original runtime UX row remains.** The new
[audit follow-up queue](handoff/20261103-ux-audit-followup.md) owns documentation repair,
verification/CI hardening and keyboard accessibility; all three follow-up rows are now closed.
It did not reopen the original queues.
The programme's records are §2 (verified state), the two queue
files and §9, and the rehearsal deliverable is [product/10](../product/10-ux-ui-demo-rehearsal.md).
Everything waiting on a human, a decision, or a remote operation is consolidated in the
[open-asks checklist](handoff/20261019-open-asks.md) (refreshed 2026-11-04 against this
index). The earlier G0-readiness/recorded-gap batch (gb-1…gb-5, [queue](handoff/20261019-g0-readiness-queue.md))
and repository maintenance are CLOSED; their queues carry the record. This is the current-state
index, not the execution-history archive.

**Web-interface follow-up (2026-11-10; planned under planning-only authority, then partially executed on dated scope approval):** the [plan audit/corrections](../reviews/2026-11-10-web-svg-followup-audit.md), [full specification](../product/14-web-interface-followup-spec.md), [implementation map and decisions](handoff/20261110-web-followup-map.md) and [agent briefs](handoff/20261110-web-followup-pickups.md) supersede the preceding conversational P0/P1 recommendations. All 17 SVG boards and old sv/rd residuals are classified. rd remains complete; no WF runtime row is authorized. Important corrections: tasks are navigation, not read-only modes; replacing the central grid conflicts with ADR 0044; profile/histogram and SQL-status claims were retracted. The source-backed replacement issue includes cancelling a picker from a clean ready session, not only dirty edits. Temporal display first targets scalar grid/display-copy, with nested/Record/SQL parity separate. Next orchestrator obtains explicit WFD selection, then fresh WF-00 preflight, then one bounded writer/reviewer at a time. **Scope has since been selected:** the maintainer approved the map's decision request on 2026-11-10, recorded in the [approval record](handoff/20261110-web-followup-approval.md) — read-only WF-01P, runtime WF-02 (pipeline label honesty, WFD-08 label-only), read-only WF-05 design under WFD-01=B, tasks stay navigation (WFD-02=A). **WF-00 preflight is CLOSED at `76c1945`** with all ten gates green (237 files / 3531 unit tests, 249+1 browser, coverage 89.13/83.88/91.47/90.73, 140 doc links, 46 ADRs). **WF-02 is CLOSED at `b65e304`**: the pipeline panel now says `N terminal node(s)`, badges terminal nodes `terminal` and heads a gated run's collection `Recorded node outcomes:`; node sets, statuses, `isOutput` derivation, runner and canonical bytes unchanged (worker `855114a`, independent Luna xhigh approve, merged gates 9/9 green). WF-01 runtime, WF-03/04/06/07/08/09, WF-O1/O2 remain BLOCKED or unselected; next action is read-only WF-01P, which returns the temporal matrix and stops for explicit WFD-06 approval. **WF-01P is DELIVERED** ([matrix](../reviews/2026-11-10-wf01p-temporal-matrix.md), read-only at `4051704`, no repository change): DATE/TIMESTAMP/TIMESTAMPTZ arrive as epoch **milliseconds** (TIMESTAMP can be fractional), TIME as **bigint microseconds**; `formatCell`'s `Date` branch is dead code for engine payloads (0/152 cells); base and overlay projections are identical; `TIMESTAMP 'infinity'` throws in Arrow's accessor **before** any formatter (projection-boundary blocker, not a formatter bug); offsets are unrecoverable for TIMESTAMPTZ/TIMETZ; grid and focused copy already agree 151/151 and the editor draft already formats correctly. WF-01 stays **BLOCKED** on one WFD-06 choice: display fractional-ms payloads at ms (reuse `temporalDraft` byte-for-byte, accepting truncation), or fall back to the raw number when `delivered*1000` is non-integral. **Settled 2026-11-10: WFD-06 = option B** — UTC ISO-like at the exact delivered precision (`…sssZ`, `…sssSSSZ` or `…sssSSSSSSZ`), raw fallback whenever `ms*1000` is non-integral (the `TIMESTAMP_NS` case), TIME as `HH:mm:ss[.ffffff]`; display may differ from the ms-only editor draft by approval, and nested/Record/SQL stay WF-O2. **WF-01 is CLOSED at `b6b773d`** (worker `9ca0328` + `2209663`, independent Luna xhigh review: one request-changes round fixed a real precision hole — an integral `ms*1000` is not proof of recovery, so `TIMESTAMP_NS` now always stays raw — then approve; merged gates 9/9, 238 files/3554 tests, coverage 89.15/83.92/91.49/90.75, 253+1 browser). Typed `DATE`/`TIMESTAMP`/`TIME` cells now render UTC ISO-like text at the exact delivered precision with raw fallback; storage, overlay, editor seeds, filters and export are untouched, and nested/Record/SQL stay WF-O2. One approved deviation: three existing e2e specs had asserted the defect (raw epoch text) and were updated defect-only, with the reviewer verifying no coverage loss and that CSV export still pins raw values. **WF-10 is CLOSED for the selected subset** in the [selected-scope closure record](handoff/20261110-wf10-selected-closure.md): five rows traced to merged or read-only evidence, and the residual register (RD-T07, WF-O2, `TIMESTAMP 'infinity'`, the deliberate editor/display divergence, WF-03/04/06/07/08/09, WF-O1, D-06/D-11, SV-D02/03/04/05, SV-F01…F07) carried forward explicitly rather than marked done. **WF-05 is DELIVERED** as a read-only successor design ([design](handoff/20261110-wf05-replacement-design.md)): preservation across picker cancel/failure is feasible **without** an engine or `session-reset.ts` change (ordering in `App.tsx`; B-side staging already holds a second table), with the honest gap that no per-table release exists so a retired table leaks for the app lifetime (bounded to ≤1 per adoption). Two same-boundary defects recorded, not fixed: clicking Open mid-edit commits the draft and then destroys it in the same click; and Open is not disabled while the Export dialog is open, so `openDataFile` unmounts it mid-export while the write continues. WF-06 was **BLOCKED** through four review rounds: the sign-off was delegated to independent review and three decisions were amended (candidate preparation must use a candidate-local overlay; an invalid/unsettled editor draft must block the clean as well as the dirty path; no finite table-lifetime bound may be claimed). The reviews then found more — a boolean cell editor with no blur handler, an "only `adopt()` writes history" rule that ordinary edits falsify, an impossible T4 assertion, and a **real concurrency hole**: G4 read a single `castPendingColumn`, so two column cast checks could overlap and the later `finally` could clear the marker while the earlier was in flight. All of it is fixed in the [v5 contract](handoff/20261110-wf05-replacement-contract.md), which the final review returned as **sufficient**; the lifetime question is settled by [ADR 0047](../adr/0047-web-session-replacement-retains-retired-tables.md). WF-06 is now **READY pending explicit runtime authorization** — a verified contract is not dispatch authority. Old dated status entries below are history; use the new map for current follow-up dispatch. No participant/AT evidence or new runtime gate result is claimed by this planning pass.

**Current first-wave pickup (2026-11-13):** the maintainer reviewed the proposal and asked to proceed. Start with the [dated approval and cold-pickup handoff](handoff/20261113-essential-workbench-pickup.md) and [implementation specification](../product/16-essential-workbench-first-wave-spec.md). WF-06 is now runtime-selected, not implemented; run EW-00 fresh baseline gates and fill the worktree/reservation/reviewer envelope before code. EW-02D scope/copy, EW-03D CSV and EW-04D bulk repair are design-first; their successor runtime rows and EW-05…08 remain blocked/unselected. This narrowly supersedes earlier WF-06 authorization-pending prose, not other WFD/ADR decisions. No runtime gates were run by authoring this pack, and nothing is pushed.

**Essential-workflow comparison (2026-11-12; historical research/proposal status, first-wave selection above):** the maintainer requested comparison with spreadsheet and adjacent workbench functionality, emphasizing essential coverage rather than parity. Three read-only subagents and official web documentation informed the [comparison report](../reviews/2026-11-12-essential-workbench-comparison.md) (24 sources; source/test-qualified Assay inventory) and [bounded enhancement proposal](../product/15-essential-workbench-enhancements.md) (EW-01…EW-08, priorities and acceptance journeys). Recommended focus: the already-designed WF-06 session-preservation work (runtime not implemented or authorized), explicit scope, CSV interpretation, and a small atomic bulk-repair slice; existing features are not proposed as new. All candidates remain proposed; WF/WFD/engine-track decisions and RD-T07 remain unchanged. No runtime or competitor hands-on tests ran, and no implementation or push is authorized by this research.

**Visual task companion (2026-11-13; design only):** the maintainer commissioned a
[four-board essential-workbench SVG pack](../../assests/svg/essential-workbench/README.md) for the next
agents: replacement, scope clarity, CSV interpretation and bulk repair. Each board separates specified
behavior from proposed controls/copy and maps to the first-wave contracts/tests. Static artwork is not
runtime verification, a new technical contract or authority to implement blocked successors; it does not
hold up WF-06. Use the textual handoff/specification before the pictures.

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

Assay is a local-first dataset workbench for four input formats — **Parquet, CSV, JSONL and
JSON**. Arrow is used internally as transport; **Arrow/Feather input is not supported today**
and remains a separate engine-track decision. Dataset contents stay local by default; telemetry
contains only allowlisted operational metadata (ADRs 0025/0037/0045).

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

**Verified state (2026-11-10, web follow-up subset):** WF-00 preflight green at `76c1945`; **WF-02** pipeline
label honesty merged `b65e304`; **WF-01** exact-precision temporal display merged `b6b773d` (one request-changes
round: an integral `ms*1000` is not evidence of recovery, so `TIMESTAMP_NS` always renders raw); **WF-01P** read-only
matrix delivered; **WF-05** successor contract verified after four review rounds; **ADR 0047** accepted (unbounded
retained engine tables, no release primitive); **WF-10** closed for the selected subset. Latest full gates at
`b6b773d`: forced typecheck **20**, unit **238 files / 3554**, coverage **89.15 / 83.92 / 91.49 / 90.75**, build
**12**, browser **253 + 1 skip**, doc links **146/0**, ADRs **47**. **WF-06 is READY but unauthorised** (a verified
contract is not dispatch authority); WF-03/WF-04/WF-07 need their WFD decisions, WF-08/WF-09/WF-O1/WF-O2 are
unselected, `TIMESTAMP 'infinity'` has no owning row, and RD-T07 remains an unsatisfied limitation.

**Verified state (2026-10-19):** slice 2 CLOSED with ptv2-8 (exit acceptance) integrated as `bce449f` after an independent reviewer approve (one request-changes round added independently-normalized refusal evidence). Forced typecheck **20**, unit **3027/191**, coverage **87.84/81.97/88.65/89.29** above floors, build **12**, browser **175 + 1 skip**, native **9**, spike **15 pins**, real-VSCode **10/10 scenarios** (full MVP-scenario-11 chain: validate 1/0/1/0 → confirmed-key diff 1/1/1 → report + copy delivery; offline JSON/JSONL opens; six staged-diff installed-CLI legs; acceptance agreement). Closure records: [slice-2 queue](handoff/20261014-ptv-slice2-queue.md) and the [G0-readiness/recorded-gap batch](handoff/20261019-g0-readiness-queue.md). **164 pending changesets at that date (live count 172 on 2026-10-29)**, doc links **107/0** at that date, ADRs **46**.

**UX/UI programme verified state (2026-11-03):** both UX queues' runtime rows are **CLOSED** — usability **ug-1…ug-23 (23/23)** and visual **uxv-0…uxv-5** — so every requirement in the [implementation spec](../product/09-ux-ui-implementation-spec.md) (R-01…R-16) is implemented and merged-verified. Last code verification (clean worktree `cd4fb3f`…`6457113`, default ports, `CI=1 pnpm exec playwright test --retries=0`): **227 unit files / 3408 tests, e2e 217 passed + 1 skipped, coverage 89.15/83.89/91.42/90.73** (floors unchanged), docs links **120/0**, ADR **46**, **192** changesets. uxv-5 added one documentation file only ([rehearsal pack](../product/10-ux-ui-demo-rehearsal.md)), verified docs-only (links/prettier/ADR index) with no runtime delta. Deferred by design: **uxv-6** (SQL sizing) and the overlay-aware profile candidate are design-only and need a maintainer decision before any code. Records: [usability queue](handoff/20261026-usability-queue.md) §1/§2/§5, [visual queue](handoff/20261026-ux-ui-execution-queue.md) §2/§4, [pickup pack](handoff/20261026-ux-ui-pickup-prompts.md), and §6/§9 above.

**Latest audit-follow-up verification (2026-11-04):** ux-a1…ux-a3 are **CLOSED**. Last verified
code is `fc6fd0f` (native disclosure modal lifecycle and explicit record-open focus, including a
reviewer-discovered stale-render race fix). Clean isolated merged gates: **230 unit files / 3441
tests**, e2e **219 passed + 1 skipped**, coverage **89.19/83.90/91.47/90.78**, docs links **121/0**,
ADR **46**, **193** pending changesets. Configured disclosure **6 passed** in both schemes with
collector routes aborted before navigation; original AA legs logged 4 aborted attempts, 0 delivered.
Stock restored endpoint-free, **31 focused stock legs passed**; direct web typecheck also passed.
Logs `/tmp/assay-uxa3-merged-logs/`. No active row remains in the audit queue; optional future QoL is
listed there and is not implicitly authorized. That local verification did not establish remote
CI success; the later push/run observation below supersedes the old billing-block assumption.

**Push / remote CI (2026-11-04 integration episode):** the user authorized adopting the remaining
README/usage-SVG and optional `.dsh` skills, and a normal, non-force `main` push. The prior verified
push before this episode was `dee10f8` (2026-10-29). The normal push to `1769a71` succeeded;
local HEAD and `git ls-remote` agreed and divergence was 0/0 before this status-note update.
The earlier pre-import tip `af985f7` was 75 ahead / 0 behind: a dated fact, not a live counter.
Verify subsequent documentation pushes by
comparing `git rev-parse HEAD` with `git ls-remote --heads origin main`; no blanket permission for
publication, visibility, billing, tags or force-push follows from this authorization.

The previously foreign files are now adopted with user authorization: the README/diagram no longer
advertise Arrow/Feather input; the optional developer skills retain both upstream MIT notices and
explicitly defer to project policy. The gate skill now names the complete runtime gate, not just
three checks. Repository-root `pnpm format:check` passes after formatting the imported skill files;
there is no longer a foreign `.dsh` formatting exception. Exact original upstream import revision
was not recorded and is not claimed. Historical preservation notes below describe earlier episodes.

**Remote CI observation (2026-11-04):** [run 41758900607](https://github.com/minghao51/assay/actions/runs/41758900607)
for pushed `1769a71` was **in progress**, with checkout/setup/dependency installation completed and
all four jobs executing (including the new configured-telemetry job). Thus the historical
before-any-steps billing failure does **not** describe this observed run. Its conclusion was still
pending; do not infer remote green or claim the account's billing configuration was changed by an
agent. Later documentation pushes may supersede/cancel this run under the workflow concurrency
policy: check the run matching the current remote HEAD, not merely the latest remembered run ID.

Historical M6 evidence is preserved: [38615821301](https://github.com/minghao51/assay/actions/runs/38615821301)
and [38616340554](https://github.com/minghao51/assay/actions/runs/38616340554) failed before steps on
payment/spending-limit annotations, deferred by the user on 2026-10-15. [M6](manual-actions.md) now
awaits latest-main CI verification; account actions remain human-only if an access failure recurs.
No billing, visibility, publication or force-push change is authorized. Local green is not remote green.
Dependabot triage remains separate; this push did not merge dependency branches.

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
- Worker roster: **current user-requested roster (2026-11-01)** — implementer
  **`opencode-go/deepseek-v4.1-flash`**, independent reviewer
  **`opencode-go/mimo-v2.6-flash` at thinking high** (switched from `openai-codex/gpt-6-luna`
  on 2026-10-31 when the Luna credit was exhausted; the switch is recorded per row); the same
  model never both implements and reviews. The earlier maintainer preference (2026-10-17:
  `zai/glm-5.3-flash` first, Luna reviewer; Luna implements with parent review when the GLM lane
  429s) is historical.
  Serialized dispatches; briefs/logs in `/tmp`. Push authorization is episode-specific:
  this episode authorizes a normal `main` push; verify current remote SHA equality rather than reusing historical ahead/behind counts.
  **Workers never push**, and publication remains
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

**Essential workbench — first wave selected 2026-11-13.** The [cold pickup](handoff/20261113-essential-workbench-pickup.md) owns current task status and the dated approval; [product/16](../product/16-essential-workbench-first-wave-spec.md) owns requirements/reservations. First executable action is EW-00 at the current clean commit, then one WF-06 writer and independent review. EW-02D/03D/04D are read-only designs/probes; do not implement all eight proposals. The older WF queue below remains evidence for completed work and other pending decisions, not a competing WF-06 dispatch authority.

**Web-interface follow-up — subset executed, remainder decision-gated (2026-11-10).** The
[approval record](handoff/20261110-web-followup-approval.md) records the maintainer's dated decisions
(WFD-01=B, WFD-02=A, WFD-06=B, WFD-08 label-only, WFD-09 subset) and the executed evidence: **WF-00** preflight
(`76c1945`), **WF-02** pipeline-label honesty (`b65e304`), **WF-01** exact-precision temporal display (`b6b773d`),
read-only **WF-01P** matrix, **WF-05** verified contract
([v5](handoff/20261110-wf05-replacement-contract.md)) with **ADR 0047** accepted, and **WF-10** closure for that
subset ([record](handoff/20261110-wf10-selected-closure.md)). Dispatch only rows that record marks READY:
**WF-06** (replacement runtime) is now selected in the [first-wave handoff](handoff/20261113-essential-workbench-pickup.md), which supplies its brief; green EW-00 gates and a filled dispatch envelope are still required. **WF-03/04/07** need
WFD-05/03/07 decisions; **WF-08/09/WF-O1/O2** are unselected. Current open asks are indexed in
[open-asks §0](handoff/20261019-open-asks.md). No participant or AT evidence exists (RD-T07), and nothing is pushed.
The historical queues below remain closed records, not a second dispatch list.

**SVG vision follow-on — planning only (2026-11-04).** The [SVG pack](../../assests/svg/README.md) now has a proposed [implementation map](handoff/20261104-svg-implementation-map.md), [specification](../product/11-svg-implementation-spec.md) and [pickup prompts](handoff/20261104-svg-pickup-prompts.md). Following the user's openness to larger UI changes, the [stack/UX review](../product/12-workbench-redesign-review.md) recommends validating a bounded task-led redesign (rd-0…rd-7); conservative Phase A (sv-0…sv-7) remains a fallback, not its prerequisite. The map now separates design/IA selection from runtime scope and corrects snapshot/no-op/filter-draft assumptions against actual source. Existing engine/session/data guarantees remain; selected structural changes need explicit UI/ADR decisions. No runtime task is claimed or authorized by authoring the pack; optional DCR inspection/dirty-replacement protection, deferred SQL/profile work and future/gated tracks remain separate decisions. This does not reopen or change the closure of the programmes below.

**rd-0…rd-2 design checkpoint complete (2026-11-04, docs/prototypes only).** Authorized design work produced the [design record](../product/13-workbench-redesign-design-record.md) (source-qualified friction inventory, recommended IA **B** — four task goals in the existing tools-left pane with the grid/record composition unchanged — and A as the explicit fallback), two isolated keyboard-operable [prototypes](../../assests/prototypes/README.md), and the [rd-2 usability protocol](handoff/20261104-rd2-usability-protocol.md). No participant session ran, so **RD-T07 remains unsatisfied**; the heuristic walkthrough is recorded as non-evidence. No production runtime, ADR, dependency, gate, push or release change was made, and conservative `sv-*` Phase A was not executed. The checkpoint was independently reviewed (`openai-codex/gpt-6-luna` xhigh; three request-changes rounds → **approved**, record in the design record §8) with no runtime/ADR/dependency/commit change. **Resolved 2026-11-04 under the delegated instruction:** SV-D08 = B (task-led), UI-RD-01 recorded, copy approved, SV-D01 = rd-3 + rd-4 only — see the [decisions and runtime scope](handoff/20261104-rd-decisions-and-runtime-scope.md). rd-3b (deferred conditional visibility), rd-5…rd-7 and optional SV-D02…SV-D05 remain OPEN/unauthorized.

**rd-3/rd-4 first runtime slice CLOSED and merged-verified (2026-11-04, delegated).** Committed as `51ff36e` (design pack `d441fc3`), nothing pushed. Merged gates re-run from a clean worktree at that revision (not reused from the implementation episode): format/lint 0, typecheck **20/20** and build **12/12** both forced `0 cached`, unit **235 files / 3494 tests**, coverage **89.10/83.86/91.39/90.68** (floors unchanged), full Playwright **223 passed + 1 skipped, 0 failed** (`DUCKDB=/tmp/duckdb`, ports 4673/4679/4680), docs links **129/0**, ADR **46**, plus the configured-telemetry leg (**6 passed**, 2 collector POSTs aborted) and the restored stock rebuild (**0** endpoint hits, affected stock specs **46 passed**). Full record: [map §6.4](handoff/20261104-svg-implementation-map.md). Independent review was `gpt-6-luna` xhigh (two request-changes rounds → approved). Implemented: task radio group + task-scoped section links, `DatasetContextBar` with one next action, `Back to findings`, task-aware reveal, approved stale copy, History-before-Export, and a 360px grid reserve keeping the 1024×700 first-paint contract. Conditional hiding stays deferred. **rd-3b CLOSED (2026-11-04, merged `0b22024`)** — conditional task exposure at ≥1024px shipped exactly as the [contract](handoff/20261104-rd3b-conditional-visibility-contract.md) specified, independently approved by `gpt-6-luna` xhigh (approve, own gates, own mutation), with sections still mounted and <1024px unfiltered. Merged gates: [map §6.5](handoff/20261104-svg-implementation-map.md) — unit **236 files / 3506 tests**, coverage **89.10/83.86/91.40/90.68**, full browser **233 passed + 1 skipped** (a first run had one unexplained intermittent Parquet-open failure, triaged and preserved, not claimed away), configured telemetry **6 passed** and restored stock **0** endpoint hits. Runtime record: [design record §10](../product/13-workbench-redesign-design-record.md). **rd-3c AUTHORIZED (2026-11-04, baseline `5397b9b`)** — the maintainer selected option A for the feedback gap the rd-3b review recorded: on a durable edit error the shell reveals the Editing section through the existing seam, once per error, **without moving focus** ([contract](handoff/20261104-rd3c-edit-feedback.md), [decisions §8](handoff/20261104-rd-decisions-and-runtime-scope.md)). Pending-change detail stays task-local by decision. **rd-3c CLOSED (2026-11-04, merged `acc8aff`)** — the durable edit error is reachable from every task again: the shell reveals the Editing section (activate Change, expand, scroll) once per error, without moving focus; unit truth table plus a browser spec pinned from the Explore default. Independent review needed two rounds — the first implementation only switched the task without scrolling — and approved after an opt-in scroll option and its own mutation proof. Merged gates: [map §6.6](handoff/20261104-svg-implementation-map.md) — unit **236 files / 3511 tests**, coverage **89.11/83.87/91.40/90.69**, full browser **234 passed + 1 skipped**, configured telemetry **6 passed**, restored stock **80** affected passed. **hf-1 CLOSED (merged `ea38938`):** the e2e open path no longer touches `extensions.duckdb.org` — a shared fixture serves the committed, checksum-pinned DuckDB-WASM extensions through a per-context route and aborts unknown paths loudly, so the browser gate is deterministic (**two consecutive full runs: 237 passed + 1 skipped, 0 failed**). Tests-only; production and the web bundle are unchanged, and web-side offline parity remains an unauthorized product decision. **rd-5 CLOSED (2026-11-04, merged `c8ca73a`)** — the compare journey now names its sides: the three approved D1 labels give “open dataset (A)” / “comparison file (B)” (value-free, no duplicated count), with exact-string pins, and a new J3 journey binds compare → stale → rerun → reviewed export to the task strip (Explore → Check → … → bar Export lands in Change with the whole-effective-dataset dialog). Merged gates: [map §6.7](handoff/20261104-svg-implementation-map.md) — unit **236 files / 3514 tests**, full browser **238 passed + 1 skipped, 0 failed**. Runtime record: [design record §12](../product/13-workbench-redesign-design-record.md), including the recorded D2 limitation (the bar cannot see a staged-but-unrun comparison). **Still UNAUTHORIZED:** rd-6, rd-7 and SV-D02…SV-D05; **RD-T07** (human usability) remains unsatisfied. The approved context-bar copy table is now machine-enforced (`APPROVED_COPY` in `next-action.test.ts`, full input cross-product, set equality both ways), including the one comparison state recorded as an integration amendment. rd-5…rd-7 and optional SV-D02…SV-D05 remain OPEN and unauthorized, and no human usability evidence exists (RD-T07 unsatisfied).

**Redesign remainder — RESOLVED 2026-11-04 (all twelve as recommended).** The [decision sheet](handoff/20261104-rd-open-decisions.md) is now a record, not an ask: rd-6 reuses the existing pipeline surfaces (SV-D02 stays closed), rd-7 ships minimal native-dialog Help with the performance baseline pinned and **RD-T07 recorded as an accepted limitation** (no usability claim), web offline parity and the rd-5 bar gap stay recorded, SV-D03/04/05 stay deferred, and SV-D07 gets a documentation/manifest truth fix only. Work goes to **new agents**, rd-6 before rd-7, with the `apps/vscode` truth fix disjoint and parallel. Nothing is pushed.

**WORKBENCH REDESIGN COMPLETE (2026-11-04).** rd-7 merged as `2ddd67a` (+ test pin `de342da`), independently approved after two request-changes rounds; gates in [map §6.10](handoff/20261104-svg-implementation-map.md), record in [design record §14](../product/13-workbench-redesign-design-record.md). The redesign now delivers the task-led IA (rd-3/rd-3b), the repair-recheck journey (rd-4), the A/B compare and reviewed export (rd-5), the pipeline/Prepare context (rd-6), and one minimal native-dialog Help with modal arbitration (rd-7), plus a deterministic e2e harness (hf-1) and a truthful VS Code format surface (D-10). **No human usability evidence exists** — RD-T07 is an accepted limitation and no usability claim is made anywhere. Recorded and deliberately open: D-13/D-14 (pipeline display labels), the rd-5 D2 bar gap, the bar's pipeline blindness, and the panel-recovery-only close focus. Nothing is pushed.

**Process lesson from rd-7 (for later slices):** a config-source pin is a unit test. Changing a config file (the configured telemetry leg's `testMatch`) required the **unit** suite, not just that leg's own run; both the implementation and the review omitted it, and the merged run caught the stale pin. Prefer making such pins require the full set (both discovery patterns), not just the old one.

**Superseded pickup (kept as the slice briefing record):** rd-7 was READY FOR DISPATCH on 2026-11-04 and is now closed; do not dispatch it again. The Help copy was **approved byte-exact** (decisions §13, D-15) and the [rd-7 contract](handoff/20261104-rd7-help-close-contract.md) has no open decision. A self-contained next-agent briefing — read order, approved strings, file reservation, invariants, gates including both telemetry legs, review protocol, stop conditions and the cumulative RD-R/RD-T closure accounting — is in the [rd-7 pickup](handoff/20261104-rd7-pickup.md). **rd-6 also CLOSED (merged `570e9be`)**: the Prepare journey is bound to the task strip, test-only, with two pre-existing pipeline display defects recorded as D-13/D-14 rather than silently fixed.

**D-10 CLOSED (2026-11-04, merged `7105963`)** — the VS Code surface no longer claims Arrow-family **input** it cannot read: manifest patterns, description, README, dialog labels and the unsupported-format text name the four engine-proven formats, with a truth test that reads the real manifest and fails if a claim returns. Export, transport and result-type statements are untouched, Arrow input stays unimplemented (SV-F07), and the dated historical queue wording is deliberately left as history. Merged gates: [map §6.8](handoff/20261104-svg-implementation-map.md). **rd-6 is in review; rd-7 is queued after it.**

**Superseded ask (kept for history):** the remainder decisions were listed as pending until the maintainer resolved them on 2026-11-04. rd-3/rd-3b/rd-3c/rd-4/rd-5 and hf-1 are closed; what remains is a decision set, not a backlog. Options, trade-offs and recommendations for all twelve open items — rd-6 scope/SV-D02, the RD-T07 human-evidence choice, rd-7 Help and performance budget, web offline parity, rd-5's recorded bar gap, SV-D03/04/05, SV-D07, run-origin metadata and push/publication — are consolidated in the [redesign remainder decision sheet](handoff/20261104-rd-open-decisions.md), including paste-ready authorization lines and an explicit “not pending” list.

**UX/UI programme: COMPLETE (2026-11-03).** Both queues' runtime rows are CLOSED and merged-verified — usability **ug-1…ug-23 (23/23)** and visual **uxv-0…uxv-5** — so every requirement in the [implementation spec](../product/09-ux-ui-implementation-spec.md) (R-01…R-16) is implemented. The original programme's deferred candidates still need a maintainer decision: **uxv-6** (SQL sizing, UX-D2) and the overlay-aware profile candidate. Current verified state: §2; per-row evidence: the two queue files and §9; the rehearsal deliverable is [product/10](../product/10-ux-ui-demo-rehearsal.md). The paragraphs below keep the per-row record.

[Usability queue](handoff/20261026-usability-queue.md): **closed** —
23 rows (ug-1…ug-23; **23 CLOSED: ug-1/2/3/4/5/6/7/8/9/10/11/12/13/14/15/16/17/18/19/20/21/22/23**, 0 open,
none decision-blocked — **batch complete** — all three lanes closed) across three lanes (Shell /
Grid / Panels) owning the
[usability gap review](../reviews/2026-10-26-usability-gap-review.md) findings UG-1…UG-37
(first-run contract, affordance visibility, failure containment, journey coherence). Read
the queue's §2 lane rules, §3 standing constraints and §5 execution clarifications before
claiming. **UX/UI pickup pack (2026-10-26, docs only):**
[implementation spec](../product/09-ux-ui-implementation-spec.md),
[visual execution queue](handoff/20261026-ux-ui-execution-queue.md) and
[retired pickup prompts](handoff/20261026-ux-ui-pickup-prompts.md).
Baseline **recorded 2026-10-26 at `7d8e1ca`** (clean tree; six gates, coverage, docs/ADR checks
green: 3029 unit / 175 e2e passed). **ug-1 integrated at `e92c0dd`, ug-2 at `8e5fd62`, ug-7 at
`9c29da4`** after independent review (ug-7 needed a test-only amendment for the new-dataset
recovery-reset pin); merged gates 193 unit files / 3056 tests, e2e 180 passed + 1 skipped,
coverage 87.98/82.08/88.89/89.46 at that historical checkpoint. **ug-7 evidence follow-up** landed
at `8367fbd`; **ug-3** at `5253c06`. **ug-8** is **CLOSED 2026-10-28** — code `cb64c32` was independently approved, and its merged gate was unblocked by test-only **gd-1** `b6fb78a` (dedicated `cli-integration` vitest project budget + contracts fuzz budget; the failure was a 5000 ms harness ceiling against six compiled-CLI spawns, proven by `--maxWorkers=4` green and a 5000 ms mutation drill). **Runtime baseline recorded at `385649b`** (not the current main tip — later docs-only commits follow; clean isolated worktree, free ports 4573/4579/4580): **195 unit files / 3089 tests, e2e 185 passed + 1 skipped, coverage 88.08/82.24/89.08/89.60, docs links 116/0 at that revision (current docs pack 117/0), ADR 46, 172 changesets — all gates exit 0** (`/tmp/assay-merged-48/`, `/tmp/assay-merged-ug13/`, `/tmp/assay-merged-ug9/`). **ug-13 (Shell) CLOSED 2026-10-29** at `36cead3` + test-only amendment `793ba90` after two independent reviews (R-14 purpose subtitles on all twelve collapsed section headers, Record dock closed-state hint with a pinned lifecycle, no Record rename). **ug-9 (Panels) CLOSED 2026-10-29** at `71fa03a` + Critical fix `385649b`: R-15 pipeline binding continues the journey (source/validate primaries bind from App-held state with a zero-picker-call proof; the failed-gate cross-link loads the run-start contract snapshot — the reviewer's live-binding rebind defect closed and pinned; first DCR mention expands with a purpose sentence). **ug-14 (Shell) CLOSED 2026-10-30** at `c694eca` (worker `deepseek-v4.1-flash` → independent `gpt-6-luna` xhigh reviewer, two request-changes rounds → approve; code `5439107` + fixes `edf07a5`, `00f045e`, `c694eca`): `open-error` shows a classified one-line cause with the exact `Choose a different file…` retry re-entering the guarded open chain, raw detail only in a collapsed `<details>` (synthetic corrupt fixture, component + real-picker e2e); the shared `engineErrorLine`/`engineErrorMessage`/`classifyOpenFailure` helper is adopted by open/SQL/profile/filter and the validation/diff call sites (UG-25 “edit” leak gone; DOM file-read names threaded through `Phase['error'].errorName`). Merged verification at `c694eca` (clean worktree, default ports): **199 unit files / 3121 tests, e2e 186 passed + 1 skipped on two consecutive fresh-server runs (`CI=1 --retries=0`), coverage 88.58/82.72/89.81/90.13, docs 117/0, ADR 46, 173 changesets — all gates exit 0** (`/tmp/assay-ug14-merged/`). **ug-15 (Shell) CLOSED 2026-10-30** at `8a38e0e` (worker `deepseek-v4.1-flash` → independent `gpt-6-luna` xhigh reviewer, one request-changes round → approve; code `1261bdb` + fix `8a38e0e`): a dropped `File` is consumed by the same `openDataFile` chain (same generation guard, token checks, identity resets, phase transitions, ug-14 classified error, telemetry) with no picker call; window `dragover`/`drop` preventDefault in every phase but act only on idle, with a synchronous phase mirror closing the reviewer’s same-task click-then-drop race; idle-only `Or drop a data file anywhere on this page` affordance plus a readable no-`File` notice. Merged verification at `8a38e0e` (clean worktree; the merged e2e ran on the documented alternate ports 4573/4579/4580 because an unrelated local preview server held 4173, `CI=1 --retries=0`): **200 unit files / 3127 tests, e2e 188 passed + 1 skipped, coverage 88.59/82.73/89.83/90.15, docs 117/0, ADR 46, 174 changesets — all gates exit 0** (`/tmp/assay-ug15-merged/`). **UX-D1 RESOLVED 2026-10-30 — Option C.** ug-10 is **authorized** with the amended R-16 honest-labeling contract (spec §2: byte-exact base-as-opened hint + staged-changes note; no stale/re-run banner, no auto-recompute, engine untouched); the overlay-aware profile is chartered as a separate **planning-only** engine candidate ([20261030-overlay-profile-candidate.md](handoff/20261030-overlay-profile-candidate.md)) and is not authorized for dispatch. **ug-10 (Panels) CLOSED 2026-10-30** at `f667a87` (worker `deepseek-v4.1-flash` → independent `gpt-6-luna` xhigh reviewer, approved on the first review): R-16 shipped byte-exact — base-as-opened standing hint in every expanded state, singular/plural staged-changes note at N≥1 (absent at 0 and after undo), no stale/re-run banner, no auto-recompute, `profile(handle)`/engine untouched. Merged verification at `f667a87` (clean worktree; e2e on 4573/4579/4580, `CI=1 --retries=0`): **202 unit files / 3142 tests, e2e 189 passed + 1 skipped, coverage 88.60/82.74/89.83/90.15, docs 118/0, ADR 46, 175 changesets — all gates exit 0** (`/tmp/assay-ug10-merged/`). **ug-16 (Panels) CLOSED 2026-10-31** at `3b494f5` (worker `deepseek-v4.1-flash` → independent `gpt-6-luna` xhigh reviewer, **request-changes** on two async-lifecycle Majors → fix commit → fresh-session re-review **approve**; worker `9c5310b` + fix `472be2a`, integrated as `30063f4` + `3b494f5`): profile top-k values and null counts are real buttons — a click is planned against the active ops + effective schema first (`planProfileFilter` → `resolveProfileColumn`), a resolved column compiles through the existing builder against the **effective** type and applies via `replaceColumnFilter`/`setFilters` (chips from the existing FilterBar), a renamed column applies no filter and shows the byte-exact refusal naming base+current, an unresolved column shows the byte-exact generic refusal, cast/type mismatch shows the builder's readable rejection with no coercion, and zero-row results keep the existing empty state. Round 2 closed the reviewer's two Majors: a FilterBar-style synchronous single-flight gate + disabled filter controls (no failure rollback can overwrite a later action), and attempt/model/dataset identity checks after every `await` (late rejections after undo or a new dataset are silent no-ops). R-16 copy, `profile-table-id`, `profile(handle)`/engine untouched; no re-profile, no telemetry. Merged verification at `3b494f5` (clean worktree, default ports, `CI=1 --retries=0`): **205 unit files / 3183 tests, e2e 192 passed + 1 skipped, coverage 88.72/82.77/90.39/90.31, docs 119/0, ADR 46, 176 changesets — all gates exit 0** (`/tmp/assay-ux-ug16-merged/`). **ug-17 (Shell) CLOSED 2026-10-31** at `9a31cd6` (worker `deepseek-v4.1-flash` → independent `gpt-6-luna` xhigh reviewer, **approved on the first review**): managed section toggles carry optional, value-free session summaries visible while collapsed — `Validation · N failing` (current verdict’s failing **rule** count), `Compare · N changed` (current row-diff `changed.count`) and `History · N pending` (`activeOps(history).length`), each only at N>0 and only in verdict/result states; the summary sits in the toggle’s text column above the `hidden` body, the accessible name stays `Expand/Collapse <Title>`, `aria-describedby` gains the summary id only when present (purpose first), and inner-disclosure sections keep their own idioms. One scoped `workbench-section-summary` block; the twelve R-14 purpose/name pins and heading pins unchanged and green; no DOM reorder; no engine/grid change; no telemetry. Merged verification at `9a31cd6` (clean worktree, default ports, `CI=1 --retries=0`): **206 unit files / 3190 tests, e2e 193 passed + 1 skipped, coverage 88.84/83.41/90.68/90.44, docs 119/0, ADR 46, 177 changesets — all gates exit 0** (`/tmp/assay-ux-ug17-merged/`). **ug-4 (Grid) CLOSED 2026-10-31** at `784805c` (worker `deepseek-v4.1-flash` → independent `gpt-6-luna` xhigh reviewer, **request-changes** on one Major (the interaction copy claimed edit/inspect/navigate capabilities in the read-only pipeline preview) → fix commit → fresh-session **approve**; integrated `178ffa5` + `784805c`): a persistent one-line hint — byte-exact `Double-click a cell to edit · Enter edits the focused cell · Esc cancels` — renders on editable ready grids, outside the role=grid subtree, with a per-instance `useId` id as the grid’s `aria-describedby`; the footer gained a native Keyboard `<details>` (Edit / Inspect / Navigate) with only the verified shortcuts. Every claim is capability-derived (`editingEnabled` / `onOpenRecord` / `interactive`), so the read-only pipeline preview renders no hint, no disclosure and no description; Diagnostics untouched, no new key handlers, no DOM reorder, no telemetry. Pins: `DataGrid.interaction-hints.test.tsx` 11 (editable / inspect-only / preview-shaped read-only + rerender flips) plus one e2e first-ready leg; mutations killed: unconditional hint, Edit group without editing, dropped describedby, dropped hint id, altered copy, deleted key row. Merged verification at `784805c` (clean worktree, default ports, `CI=1 --retries=0`): **207 unit files / 3201 tests, e2e 194 passed + 1 skipped, coverage 88.84/83.45/90.68/90.44, docs 119/0, ADR 46, 178 changesets — all gates exit 0** (`/tmp/assay-ux-ug4-merged/`). **ug-5 (Grid) CLOSED 2026-10-31** at `d814fdf` (worker `deepseek-v4.1-flash` → independent `gpt-6-luna` xhigh reviewer, **approved on the first review**): Ctrl/Cmd+C on a focused non-editing grid cell copies the display value composed with the same `formatCell` the cell renders with, announcing exactly `Value copied.` through the existing single polite live region; empty cells copy nothing (`Nothing to copy — this cell is empty.`) and a missing/rejected clipboard announces `Copy failed — the clipboard is unavailable.`; the handler is cell-scoped, never intercepts while an editor is open or on input/select/textarea/contenteditable, and copy mutates nothing. No telemetry/logging of values (ADR 0025). Pins: `copy-cell.test.ts` 11, `DataGrid.copy.test.tsx` 8, one real-Chromium clipboard e2e; mutations killed: dropped editor guard, `String(raw)`, dropped write/preventDefault. Merged verification at `d814fdf` (clean worktree, default ports, `CI=1 --retries=0`): **209 unit files / 3220 tests, e2e 195 passed + 1 skipped, coverage 88.88/83.53/90.73/90.48, docs 119/0, ADR 46, 179 changesets — all gates exit 0** (`/tmp/assay-ux-ug5-merged/`). **ug-6 (Shell) CLOSED 2026-10-31** at `b2c6ce1` (worker `deepseek-v4.1-flash` → independent `gpt-6-luna` xhigh reviewer, **approved on the first review**): one document-level keydown listener maps Ctrl/Cmd+Z to undo and Ctrl/Cmd+Shift+Z / Ctrl/Cmd+Y to redo through the existing handlers (ready only, one listener, cleaned up, preventDefault only when handled), never hijacking native text undo in editable targets including nested contenteditable hosts (pure `lib/history-shortcut.ts` classifier). The History section auto-expands on the first appended op only, never on undo/redo or dataset open, and never re-opens after a collapse; ug-17’s `History · N pending` summary is untouched. The single visible Undo/Redo pair is preserved (ux-3); no telemetry, no engine/overlay change. Pins: helper 11 + App 6 + one real-Chromium e2e; mutations killed: dropped editable guard, cue on every append, swapped undo/redo. Merged verification at `b2c6ce1` (clean worktree, default ports, `CI=1 --retries=0`): **211 unit files / 3237 tests, e2e 196 passed + 1 skipped, coverage 88.92/83.57/90.76/90.50, docs 119/0, ADR 46, 180 changesets — all gates exit 0** (`/tmp/assay-ux-ug6-merged/`); one known engine-side `row-diff-agreement` coverage flake passed on immediate rerun (no threshold weakened). **ug-12 (Grid) CLOSED 2026-10-31** at `d3af2ec` (worker `deepseek-v4.1-flash` → independent `gpt-6-luna` xhigh reviewer, **approve**): an explicit `.grid-cell:focus-visible` rule reusing `--color-focus` is pinned by a keyboard-driven computed-style assertion, and validation/diff “Show row” announces exactly `Showing <displayKey> in the grid and record inspector` through the existing polite region (domain `displayRowKey` — value-free row identity), with roving focus landing on the target row and the record inspector open on it. Failed jumps keep the existing error flow and announce nothing. Pins: three new unit/component files + computed-style and journey e2e legs; mutations killed: removed focus-visible rule, dropped announcement, dropped row focus. Merged verification at `d3af2ec` (clean worktree, default ports, `CI=1 --retries=0`): **214 unit files / 3247 tests, e2e 196 passed + 1 skipped, coverage 89.05/83.67/91.00/90.65, docs 119/0, ADR 46, 181 changesets — all gates exit 0** (`/tmp/assay-ux-ug12-merged/`; the first e2e attempt was refused by a stale preview server on 4173, the default-port retry was green). **ug-11 (Grid) CLOSED 2026-11-01** at `79febe5` (worker `deepseek-v4.1-flash`; reviewer `gpt-6-luna` xhigh → **request-changes** on an unbounded adjacent-ready scan → `mimo-v2.6-flash` re-review → **request-changes** on a vacuous error-neighbour pin → pin-only fix → **approve**; integrated `e3e0dc1` + `eb23b53` + `79febe5`): a sticky, 1-based row-number gutter is the first track in the header and every body row (`rowheader`, `#` columnheader, `aria-colcount` +1, opaque striped, stays pinned on horizontal scroll), and the record dock title/region/reloading labels moved to the same 1-based convention with every old 0-based pin updated (ug-12’s `base #<ordinal>` announcement remains the logical ordinal). Dock ◀ Prev / ▶ Next step to the immediate neighbour only (N-1 / N+1), disabled at bounds or on an `error` neighbour, with a `loading` neighbour riding the existing pending gesture; stepping is O(1) and a 100k-row sparse-cache call-count pin kills render-path and click-only dataset walks. Same dock re-read, no close, opener only on a fresh open. Pins: row-number 5, steps 9, App step wiring, the sticky-gutter e2e leg, a new grid-row-numbers spec, and deliberate `nth-child` offset updates (commented). Residual (non-blocking follow-up): the “later notification is not a second drop” assertion is vacuous against the `handledSeqRef` guard (behaviour idempotent). Merged verification at `79febe5` (clean worktree, default ports, `CI=1 --retries=0`): **217 unit files / 3262 tests, e2e 198 passed + 1 skipped, coverage 89.07/83.70/91.01/90.65, docs 119/0, ADR 46, 182 changesets — all gates exit 0** (`/tmp/assay-ux-ug11-merged/`). **ug-18 (Grid) CLOSED 2026-11-01** at `4d3cb54` (worker `deepseek-v4.1-flash` → `mimo-v2.6-flash` xhigh reviewer, **request-changes** on a Critical untouched-row Apply that silently removed the filter after a programmatic `setFilters` (plus stale prefill, an unpinned removal guard/rollback, duplicate removal surfaces) → fix → **approve**; integrated `51a3e46` + `4d3cb54`): the expanded Filters body is one `Filter on:` compose row compiled through the existing builder, followed by editable active rows that always apply what they display and a collapsed `SQL predicates` escape-hatch disclosure; the collapsed summary names the active columns (`Filters · N active: col1, col2`) with sibling chips and working removal, exactly one removal control per filter per state. uxc-4 latch/pending/rollback/programmatic bridges preserved; no grammar/engine/protocol/telemetry change. Boundary: four e2e specs re-pointed locator-only (reviewed). Pins: 47 FilterBar tests + wide.csv non-SQL journey + untouched-row real-stack leg; mutations killed: chips-in-body, duplicate compose row, bypassed compile, old apply source, dropped sync, removal bypass, re-added body-chip removal. Merged verification at `4d3cb54` (clean worktree, default ports, `CI=1 --retries=0`): **217 unit files / 3288 tests, e2e 199 passed + 1 skipped, coverage 89.13/83.72/91.22/90.70, docs 119/0, ADR 46, 183 changesets — all gates exit 0** (`/tmp/assay-ux-ug18-merged/`). Residual (non-blocking): the internal `applyList` pending guard is unreachable behind disabled controls and unpinned (refusal pinned via the affordance). **ug-19 (Grid) CLOSED 2026-11-01** at `0ac3447` (worker `deepseek-v4.1-flash` → `mimo-v2.6-flash` xhigh reviewer, **request-changes** on two Majors — a queued edit could open on a renumbered logical row after an overlay-induced reorder, and the dataset-replacement pin was vacuous — plus a NULL-marker AA failure → fix → **approve**; integrated `b1444dc` + `0ac3447`): empty-state/secondary text moved to `--color-text-secondary` and the record NULL marker to a new `--color-null-text` token measured ≥4.5:1 on every real surface in both schemes (both-scheme axe scans now drive a NULL row and the grid/SQL zero-result states with the empty allowlist); the grid exposes `aria-busy` plus a polite `Sorting…`/`Filtering…` footer status cleared on settle (success and failure, Filtering wins, sort epochs counted, preview unaffected); and one loading-row edit gesture opens only on the captured logical key, retires on an overlay revision change, drops visibly on error, and is replaced/cleared correctly. Pins: 20 new tests + `theme-contrast.test.ts` source pins + both-scheme e2e scans; ten mutations killed. Merged verification at `0ac3447` (clean worktree, default ports, `CI=1 --retries=0`): **221 unit files / 3316 tests, e2e 203 passed + 1 skipped, coverage 89.19/83.85/91.42/90.77, docs 119/0, ADR 46, 184 changesets — all gates exit 0** (`/tmp/assay-ux-ug19-merged/`). Residual (non-blocking): the error-notice inside the overlay-retirement branch is unpinned and the captured-key guard is defensive. **Grid lane complete.** **ug-20 (Panels) CLOSED 2026-11-02** at `5bad2c3` (worker `deepseek-v4.1-flash` → `mimo-v2.6-flash` xhigh reviewer, **request-changes** on a vacuous accessible-name pin and a stale starter status on a schema-equal dataset swap → fix → **approve**; integrated `3078797` + `5bad2c3`): the validation zero state offers a starter-contract download built from the dataset’s confidently mappable schema columns through the canonical serializer (no filename/values, new file only, success/failure status cleared on dataset swaps), and each enabled failure-filter control states `Replaces the current N filters` when filters are active (absent at 0, enabled controls’ accessible names unchanged). App adds exactly two prop passes; report export, engine, protocol, dependencies and telemetry untouched. Pins: builder round-trip/omission/privacy, component state and enabled-control name pins, a real Playwright download e2e and a disclosure e2e; eight mutations killed. Merged verification at `5bad2c3` (clean worktree, default ports, `CI=1 --retries=0`): **223 unit files / 3334 tests, e2e 204 passed + 1 skipped, coverage 89.14/83.88/91.41/90.73, docs 119/0, ADR 46, 185 changesets — all gates exit 0** (`/tmp/assay-ux-ug20-merged/`). Residual (non-blocking): synchronous-only delivery catch; the schema-equal swap trigger is code-read-verified rather than e2e-pinned; timestamptz types are conservatively omitted. **Panels lane complete.** **ug-21 (Shell) CLOSED 2026-11-02** at `8458ad1` (worker `opencode-go/deepseek-v4.1-flash` → `opencode-go/mimo-v2.6-flash` xhigh reviewer, **approve on the first review**): the opening phase shows a native, genuinely indeterminate `<progress aria-label="Opening progress">` (no `value`/`max`, outside the single polite live region, no percentage or byte/row count) beside the unchanged `Opening…` copy, and a `Cancel opening` button rendered only while opening restores idle through the **existing** session guard — `datasetSession.beginSession()` (token bump first, then the registered resets) plus `setPhase({ kind: 'idle' })` — so every post-`await` token comparison drops the cancelled open's late result (no phase flip, no error, no stale dataset) and a follow-up open reaches `ready`. No second cancellation path, no `AbortController`, no engine interrupt (the protocol has none, and the comment/changeset say so honestly); `openDataFile` and its guard order are byte-identical to base (the commit is insertions-only). Pins: three `App.open-status.test.tsx` legs (indeterminate + accessible name; controllable deferred open resolved **after** cancel stays `idle` with zero schema calls, then a follow-up open reaches `ready`; idle/ready/error absence), an `lib/app.test.ts` copy/label pin, and one real-Chromium `tests/e2e/open-cancel.spec.ts` holding the first real `engine/open` behind a **test-owned** `addInitScript` gate (no production hook) before cancelling. Mutants killed: dropped `beginSession()` bump (cancelled open flipped to `ready`), fixed progress `value`, and the reviewer's own removal of the post-`engine/open` token check. Residual (non-blocking): the e2e's post-release "late result discarded" assertion is deterministically vacuous w.r.t. the token bump (the component pin is the load-bearing evidence — a follow-up candidate), the opening state is not axe-driven, and a cancelled chain past `rowCount` leaves `historyRef`/`overlayRef`/an engine handle exactly as today's pre-existing AR-W13 stale-chain behaviour does. Merged verification at `8458ad1` (clean worktree, default ports, `CI=1 pnpm exec playwright test --retries=0`): **223 unit files / 3338 tests, e2e 205 passed + 1 skipped, coverage 89.15/83.89/91.41/90.73, docs 119/0, ADR 46, 186 changesets — all gates exit 0** (`/tmp/assay-ux-ug21-merged/`; one known engine-side `row-diff-agreement` CLI internal-error flake failed the first coverage run and passed isolated and on the full rerun, no threshold weakened). **ug-22 (Shell) CLOSED 2026-11-02** at `e73dda4` (worker `opencode-go/deepseek-v4.1-flash` → `opencode-go/mimo-v2.6-flash` xhigh reviewer, **request-changes** on a trivially-true nav/DOM decoupling pin plus a false evidence claim in the comment, changeset and commit message → fix commit → fresh-session **approve**; integrated as `25f95b9` + `e73dda4`): `WORKBENCH_SECTIONS` is now exactly **schema, filters, grid, validation, compare, sql, editing, history, export, record, profile, pipeline** — a pure array edit, same twelve ids/titles, `pipeline` still last (q-15), so the "why do my rows look like this?" loop is one link away. **No DOM reorder**: the reviewer independently extracted the `<WorkbenchSection id>` JSX order and the `h2` order at base and change and found them byte-identical, `index.css` untouched, `App.headings.test.tsx` green and unedited; the commit cites ADR 0044 / D14 + q-15 (nav order only). Pins: `NAV_ORDER` + `pipeline`-last + `filters`-before-`grid`-in-nav, the `DOM_ORDER`/`TOOL_DOM_ORDER` `toEqual` pins, `App.headings.test.tsx`, a live decoupling test (nav grid 2 vs DOM 10 with `>= 0` guards, so a −1/−1 pass is impossible), and the nav list + `pipeline`-last assertion in `tests/e2e/shell.spec.ts` (re-pointed locator-only, reviewed in scope). Mutants killed: JSX DOM swap (heading map + shell DOM pins fail), dropping `record` from the array (nav-order pin fails), nav/DOM indexes made equal (decoupling pin fails on its own line), id removal (the `>= 0` guard fires). Residual (non-blocking): `ef89942`'s original message keeps the superseded claim in history (not amended; `deec89e` and the changeset record the correction), and the decoupling test pins absolute-index inequality for two of twelve ids (the `toEqual` pins, heading map and e2e cover the rest). Merged verification at `e73dda4` (clean worktree; the default 4173 was held by a foreign preview server, so the merged e2e ran on the documented alternate ports 4573/4579/4580, `CI=1 pnpm exec playwright test --retries=0`): **223 unit files / 3339 tests, e2e 205 passed + 1 skipped, coverage 89.15/83.89/91.41/90.73, docs 119/0, ADR 46, 187 changesets — all gates exit 0** (`/tmp/assay-ux-ug22-merged/`, logs `/tmp/assay-ux-ug22-merged-logs/`). **ug-23 (Shell) CLOSED 2026-11-02** at `07a37d4` (worker `opencode-go/deepseek-v4.1-flash` → `opencode-go/mimo-v2.6-flash` xhigh reviewer, **approve on the first review**): all four code-observation riders landed in the reserved paths. (a) The `usePipelineSession` call-site comment no longer claims a jump into the SQL pane's result surface — it states that p2-6 made previews grid-native (a materialized node's relation opens through `registerPipelineRelation` and drives the same handle-based grid model a dataset open uses, rendered by the existing `DataGrid`) and that the `data-bind-revision` ordinal and the ug-9/R-15 gate cross-link belong to the panel/session pair (comment-only, verified hunk-by-hunk against the code). (b) One pure `filterChipKey` (`JSON.stringify([column, predicate])`) replaces the colliding `` `${column}:${predicate}` `` join at all three chip-key sites (removable header chips, editable active rows, display-only body list); a colliding pair (`a:b`+`c` vs `a`+`b:c`) renders two distinct chips with zero duplicate-key warnings and removes independently, and a reviewer-designed drill proved each of the three sites is individually killable. (c) The pane toggle's accessible name is state-dependent and action-reflecting (`Collapse workbench pane` / `Expand workbench pane`) while the `<nav>` keeps `Workbench sections`; `aria-expanded`/`aria-controls` are unchanged and the pins assert uniqueness per role, name inequality, no cross-role leakage and label↔`aria-expanded` tracking in unit and real Chromium. (d) The `row-uninsert` gloss is decided and applied as `undo row insert` (plural-safe, aligned with the toolbar's `Insert row`, distinct from `row delete`), pinned at function level (singular, plural, `/expunge/i` negative over all eight kinds) and at the rendered toolbar surface. The reviewer confirmed the domain-side `describeOp` text `expunge inserted row N` is **dormant, not live** — web producers are only `row-insert`/`cell-set`/`row-delete`/`column-rename`/`column-cast`, undo/redo are pure cursor moves and history is in-memory — so no screen shows the jargon and the same is honestly true of the new string until a producer exists (disclosed in the changeset and the pin's header). Mutants killed: all three keys reverted to the colon join, the shared nav name restored on the toggle (unit + rebuilt e2e), the gloss reverted (five pins). Residual (non-blocking, recorded): **a future row that adds a web producer for `row-uninsert` must also gloss `packages/domain/src/edit-ops.ts`'s `describeOp` string** (with a `@assay/domain` changeset) or `HistoryPanel` would render the jargon; CO-2's load-bearing lines are the duplicate-key-warning assertions. Merged verification at `07a37d4` (clean worktree, default ports, `CI=1 pnpm exec playwright test --retries=0`): **224 unit files / 3349 tests, e2e 205 passed + 1 skipped, coverage 89.15/83.89/91.42/90.73, docs 119/0, ADR 46, 188 changesets — all gates exit 0** (`/tmp/assay-ux-ug23-merged/`, logs `/tmp/assay-ux-ug23-merged-logs/`). **All 23 usability rows are CLOSED and the batch is complete.** The visual lane then opened: **uxv-1 (R-09) CLOSED 2026-11-03** at `d85dec2` (worker `opencode-go/deepseek-v4.1-flash` → `opencode-go/mimo-v2.6-flash` xhigh reviewer, **approve** after three comment/evidence fix rounds; the orchestrator held an exclusive `index.css` + theme/telemetry-test reservation). Root cause: the telemetry Settings dialog and disclosure were styled with `var(--color-surface-panel, #fff)`, a token defined nowhere, so the hard-coded `#fff` won in both schemes and the panels stayed white in dark mode (measured 1.21:1). They now use the defined scheme-aware `--color-surface-elevated` with **no colour fallback**; a driven both-scheme browser measurement proves Settings title/label 16.95:1 light / 13.43:1 dark and the disclosure copy the same, surface identity is asserted against the resolved token, and axe scans cover both surfaces in both schemes with the allowlist still empty. The isolated configured-disclosure leg (`tests/visual/telemetry-disclosure-theme.spec.ts` + config, ports 4473/4479/4480, collector route aborted before navigation, service workers blocked, fresh storage) ran on a bundle **proven** to carry the endpoint: 2 passed per scheme, 3 POSTs intercepted and all aborted, 0 delivered, then stock output restored and re-verified. Two documentation defects were found and fixed in spec §6: its configured-build command could never configure the bundle (turbo 2.x strict env mode drops the undeclared variable and a cache hit wins), and its restore step left stale configured chunks — §6 now builds the web package directly and greps `apps/web/dist` for the endpoint before and after. Merged verification at `d85dec2` (clean worktree, default ports, `CI=1 pnpm exec playwright test --retries=0`, configured leg on 4473/4479/4480): **225 unit files / 3353 tests, e2e 208 passed + 1 skipped, coverage 89.15/83.89/91.42/90.73, docs 119/0, ADR 46, 189 changesets — all gates exit 0, configured leg 2 passed, restored dist endpoint-free** (`/tmp/assay-ux-uxv1-merged/`). **uxv-2 (R-10) CLOSED 2026-11-03** at `b487788` (worker `opencode-go/deepseek-v4.1-flash` → `opencode-go/mimo-v2.6-flash` xhigh reviewer, **approve on the first review**; orchestrator-held reservation for `index.css`, the named App/toolbar/export/telemetry classes and the theme pins): one scheme-independent `:root` token block adds spacing 4/8/12/16/24/32, control heights 32/36, radii 4/6/8 and type aliases (UI 14 / body 16 / metadata 13 / page-title 24) without touching a single colour token; adoption is bounded to the idle Open + example controls (new `.open-button`/`.example-button`), the section and pane toggles, the telemetry Settings/disclosure controls, the export dialog's new `.export-action-primary`/`.export-action-secondary` plus its format controls, and the two classes ug-8 left unstyled — with exactly **two** primaries carrying the one restrained accent rule and the consent pair deliberately neutral so a privacy answer is never steered by colour (ADR 0037). One shared `2px solid var(--color-focus)` + 2px offset rule covers all nine adopted selectors; no `button {}` selector, no colour literal, no motion and no grid/schema/filter/SQL selector entered the adopted block; every component diff is a class attribute only. Pins: a new `design-tokens.test.ts` (46 source pins, including “no bare element selector anywhere” and a retention pin keeping `.grid-sort-toggle` at 1.92/4.48px padding, 3px radius and 11.52px type) and three both-scheme computed-style e2e legs (scale resolves identically in both schemes while colour tokens differ; primary vs secondary accent/neutral, 36px, 4px, 14px, weight 600 vs 500, keyboard-reached 2px ring on both; export/telemetry/ug-8 adoption) with browser-measured AA on every adopted pair. Mutants killed: dropping `.open-button` from the accent rule, dropping `.example-button` from the geometry rule, and a reviewer-designed global `button { padding: 2px }`. Residual (non-blocking): the browser focus proof covers two of nine adopted controls (the rest are source-pinned, and no `outline: none/0` exists in the tree), the disabled-control AA claim is hand-computed rather than asserted, `--font-size-page-title`/`--radius-md/lg`/`--font-family-mono` are declared and pinned but await uxv-3/5 adoption, two sanctioned export values changed without retention pins, and turbo's cache-restore can leave stale hashed chunks in `apps/web/dist` (`rm -rf` before restored rebuilds). Merged verification at `b487788` (clean worktree, default ports, `CI=1 pnpm exec playwright test --retries=0`): **226 unit files / 3399 tests, e2e 211 passed + 1 skipped, coverage 89.15/83.89/91.42/90.73, docs 119/0, ADR 46, 190 changesets — all gates exit 0** (`/tmp/assay-ux-uxv2-merged/`). **uxv-3 (R-11) CLOSED 2026-11-03** at `cd4fb3f` (worker `opencode-go/deepseek-v4.1-flash` → `opencode-go/mimo-v2.6-flash` xhigh reviewer, **approve** in round 1 after independently re-deriving every box, plus one **text-only** record correction verified by a round-2 re-review; reservation held for `index.css`, the scoped header/open/status classes in `App.tsx` and the shell/geometry/memo tests): the `main { max-width: 72rem }` cap is gone and `body` padding is now the tokenised 16px gutter with a 24px step at ≥1440px, so the page inset is the only horizontal inset; the two-pane grid runs 320px + 16px gap at 1024–1199px and 360px at ≥1200px with the 1024px breakpoint, the rail variant and every ≤1023px `order` rule unchanged. Measured matrix (reviewer's own probe, both runs agreeing, all deltas 0px): 1024×700 → 16/992/320/16/656; 1440×900 → 24/1392/360/16/1016; 1920×1080 → 24/1872/360/16/1496; 900×900 → 16/868/stack/—/868. Four scoped classes on **existing** nodes (h1, tagline, open-flow block, table-info line) cut the ready-workspace top from 225.16px to 127.88/135.88/135.88 against the ≤140px budget. The grid viewport is `clamp(280px, calc(100vh - 280px), 640px)` then the `dvh` variant: the spec's 240px candidate was measured and **rejected inside this task** because it put the footer's last pixel at 728.27 — 28.27px below the 700 fold — and defeated 1440×900 too (916.27 > 900), so the reserve was raised to the measured 268.27px (211.27 above the viewport + 3px gap + 54px footer) giving **420/620/640** with 11.73px of slack at the smallest sample. At 1024×700 the heading, purpose, column headers, first ready row and the **whole** footer are in frame, and no sample has horizontal overflow. Invariants held: DOM/heading map untouched (`App.tsx` diff = four class attributes + dropping the unused `export` on `paneToggleLabel`), grid internals and `App.memo-probe.test.tsx` untouched, 28px rows/header/horizontal scroll/overscan/dock unchanged, no `overflow: hidden` added, no JS row-estimate change. Pins: five real-browser geometry legs (one per matrix row plus the 1024×700 first-paint acceptance) and four structural source pins in the new `shell-geometry.test.ts`. Mutants killed: restoring the 72rem cap (1440/1920 gutters 264/744px), the spec's 240px reserve (footer leg + heights), and a reviewer-designed restore of the base `minmax(300px, 360px)` pane track (360 vs 320). Residual (non-blocking): the viewport-height pins restate the clamp so the footer leg is what binds the constant; spec §4's “Settings must not cover the Open CTA at 1024px” was measured (0px² overlap) but is unpinned; `.workbench-tools` still uses `100vh`; `--radius-md/lg`/`--font-family-mono` remain unadopted (uxv-5). Merged verification at `cd4fb3f` (clean worktree, default ports, `CI=1 pnpm exec playwright test --retries=0`): **227 unit files / 3403 tests, e2e 216 passed + 1 skipped, coverage 89.15/83.89/91.42/90.73, docs 119/0, ADR 46, 191 changesets — all gates exit 0** (`/tmp/assay-ux-uxv3-merged/`). **uxv-4 (R-12) CLOSED 2026-11-03** at `6457113` (worker `opencode-go/deepseek-v4.1-flash` → `opencode-go/mimo-v2.6-flash` xhigh reviewer, **approve on the first review** after a character-level copy comparison and two independent drills; reservation held for the idle-copy seam): the idle screen now carries the two R-12 lines **byte-exact** — `Powered by DuckDB-WASM · local query execution` and `Dataset contents are processed locally. Edits are staged; export writes a copy.` — as `IDLE_ENGINE_LINE`/`IDLE_ENGINE_NOTE` constants with a doc comment stating the static-only contract, rendered inside the **existing** `phase.kind === 'idle'` block (`idle-engine-line` / `idle-engine-note`, after the capability/format lines, before the drop hint). Static text only: no live status, spinner, benchmark, timing, memory or version claim, no engine/session read, timer, effect, network request or telemetry event, and the metadata disclosure/opt-out is untouched — `index.css` needed no new class (the lines inherit the idle paragraph style, measured legible). No DOM reorder beyond inserting two paragraphs, no new role/`aria-live`/heading. Pins: byte-exact string pins plus a forbidden-claim scan in `lib/app.test.ts`, three phase-driving component legs (idle present; opening absent; ready absent) plus the extended R-03 error-phase absence, and one built-app smoke leg whose literals are declared locally so bundle drift is caught. Mutants killed: “engine connected and ready” copy (three pins), the removed node (component + rebuilt e2e), the reviewer's duplicates-outside-the-gate drill (four pins) and a `·`→`-` drift (unit + e2e; the self-referential component pin alone still passes, which is why the literal layers exist). Merged verification at `6457113` (clean worktree, default ports, `CI=1 pnpm exec playwright test --retries=0`): **227 unit files / 3408 tests, e2e 217 passed + 1 skipped, coverage 89.15/83.89/91.42/90.73, docs 119/0, ADR 46, 192 changesets — all gates exit 0** (`/tmp/assay-ux-uxv4-merged/`). **uxv-5 (R-13) CLOSED 2026-11-03** at `e3ae857` (orchestrator-authored document from worker `opencode-go/deepseek-v4.1-flash` rehearsal evidence; `opencode-go/mimo-v2.6-flash` xhigh reviewer, **request-changes** on two false self-references → fix → fresh-session **approve**): [`docs/product/10-ux-ui-demo-rehearsal.md`](../product/10-ux-ui-demo-rehearsal.md) is a two-chapter rehearsal of the shipped, built UI with CLI continuity **inside Chapter 2**. Chapter 1 uses the only committed demo input (`fixtures/jsonl/nested.jsonl`): 12 rows × 10 columns, schema + record inspector, Explode → visible composed SQL and a **20 × 11** result — all re-derived with native DuckDB 1.5.5 rather than copied — and completed **keyboard-only in both schemes**, with the honest gap that `Escape` does not close the inspector after Enter. Chapter 2 derives per-run temporary inputs from `writeValidationDatasetA` and `writeExitJourneyPair` (recorded suffixes `A769De`/`vw887E`): `4 of 9 rules fail (7 rows checked)` → four staged repairs → stale banner → `Valid: 0 violations across 9 rules` → report export → copy export `7 rows as JSON Lines (324 B)` with the source SHA-256 unchanged; CLI continuity on the **same raw files** (pre-fix report 0 differences; the raw file still `INVALID — 4 of 9` after the staged repair, the documented base-view-only behaviour; the explicitly exported copy validates `VALID`). The separate M6 pair — explicitly **not** the repaired M5 export — shows 4 schema findings, 4 column deltas, 3 key candidates, `id` confirmed → `2 added, 2 removed, 2 changed — rows 5 → 5 (keys: id, inferred)`, with the CLI envelope equal after removing only the fields each surface omits. The honesty section records that “processed locally” does **not** mean zero network requests (a JSONL open issues a real DuckDB-WASM extension fetch from `extensions.duckdb.org`; no collector host, no collector string in the endpoint-free build), and the gaps section lists what was not exercised. Scope: **one document**, no fixture, test, source or data change, no runtime changeset; `docs:links:check` **120/0**, ADR 46, prettier clean. Residual (non-blocking): the prose numbers are evidence-only by design, §3.2's “exactly two new directories” is scoped to the `assay-*` globs the snapshot covered, and the keyboard trail is a recorded observation rather than a pin. **The visual queue's runtime rows are complete; uxv-6 remains design-only/deferred behind a maintainer decision.** SQL sizing remains deferred design-only. Other agent's uncommitted files (README, `docs/assets/`, `.dsh/`) are preserved; verification runs use a clean isolated worktree at the exact base revision. **Ownership:** the usability queue owns R-01…R-08, R-14, R-15 and R-16; the visual queue owns R-09…R-13. The visual queue does not replace ug ownership.

[PT-V slice-2 queue](handoff/20261014-ptv-slice2-queue.md): eight serialized
rows CLOSED 2026-10-19 — all eight rows integrated and independently
reviewed (the exit-acceptance chain reproduces MVP scenario 11 with
installed-CLI agreement). Do not redispatch slice 2 or its completed q-5b/q-7 maintenance.
The [repository maintenance queue](handoff/20261014-repository-maintenance.md)
is **closed**: docs, packaging, VS Code build/CI and q-14 all integrated.

PT-Q q-5b and q-7 **landed 2026-10-19** (records fk/fl below). The remaining q-6a
performance-probe harness is tracked under [product/04 §7](../product/04-post-mvp-track.md);
it is separate maintenance, not a rider on this UX/UI batch.

### Completed audit follow-up

- [2026-11-03 UX audit follow-up](handoff/20261103-ux-audit-followup.md): ux-a1 documentation repair
  closed at `12d6154` after independent approve and clean-worktree prettier/links **121/0**/ADR **46**.
  ux-a2 closed at `9489773` after independent approve and full clean merged gates (§2).
  ux-a3 closed at `fc6fd0f` after the stale-render race fix, independent re-review and full clean
  merged gates (§2). All three rows are closed; optional residuals remain separately listed.
  Fresh bounded rows; original ug/uxv implementation rows stay closed. Exact reservations and gates
  are in that queue. Deferred SQL/profile scope and all human release boundaries are unchanged.
- Token residual disposition: `--radius-md`, `--radius-lg` and `--font-family-mono` remain deliberately
  unadopted aliases, not unfinished uxv-5 work (that row was documentation-only). Historical narratives
  assigning them to uxv-3/5 are superseded by this disposition; no speculative styling is authorized.

### Closed and historical

- [P3 queue](handoff/20261002-p3-queue.md): six rows closed 2026-10-11; local
  DCR generation on web + CLI, conformance and honesty pins.
- [PT-V slice-1 queue](handoff/20261002-ptv-slice1-queue.md): five rows closed
  2026-10-11; §5 contains the slice-2 candidate list.
- [Q-15/PT-P2 carry-over queue](handoff/20261002-q15-queue.md): closed.
- [Visual execution queue](handoff/20261026-ux-ui-execution-queue.md) — **closed 2026-11-03**: uxv-0…uxv-5 all landed and merged-verified (R-09 theme completeness, R-10 token layer + named controls, R-11 desktop canvas, R-12 idle engine explanation, R-13 rehearsal pack); uxv-6 stays design-only.
- [UX/UI pickup pack](handoff/20261026-ux-ui-pickup-prompts.md) — **historical; do not dispatch**: every runtime row in the pack is closed; it is retained as the audit trail for how the rows were briefed.
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

- 2026-11-04 (**hf**) — Normal push `dee10f8..1769a71` verified by local/remote SHA equality and
  0/0 divergence; checkout clean. Actions run `41758900607` started all four jobs and completed
  setup steps, superseding the old before-any-steps billing-block assumption. Result still pending
  at observation; no remote-green, billing-change or publication claim. Current run must match HEAD.

- 2026-11-04 (**he**) — User authorized integration of the previously foreign README/usage SVG and
  optional `.dsh` development skills, plus a normal `main` push. Corrected unsupported Arrow input
  claims and stale VS Code status, retained both upstream MIT notices, documented unknown import
  revision and policy precedence, and expanded the gate checklist. Root formatting, doc links,
  ADR index, SVG static-safety validation and shell-template syntax checks pass. Independent
  MiMo Flash high review approved `548bbfb`; follow-up wording clarifies template adaptation.
  No runtime/package
  code or visibility/publication/billing change; push/remote-CI status must be verified separately.

- 2026-11-04 (**hd**) — ux-a3 **CLOSED** at `fc6fd0f`; the [audit follow-up](handoff/20261103-ux-audit-followup.md)
  is complete. Native disclosure modal focus/Tab/inertness, Escape without an implicit choice, and
  explicit record activation → inspector focus → Escape/restore are pinned; Show row/step/editing
  behavior remains intact. Independent review found a same-commit overlay-revision focus race;
  regression plus guard fixed it, then fresh-session approve. Clean merged gates: 3441 tests,
  e2e219+1skip, configured6, restored31, coverage89.19/83.90/91.47/90.78, docs121/0, ADR46,
  193 changesets (§2). No push or remote-green claim.

- 2026-11-04 (**hc**) — ux-a2 **CLOSED** at `9489773`: dedicated isolated configured-telemetry CI
  job, package-direct endpoint build/proof, bounded attempt polling and source/config regression pins.
  Independent request-changes on false evidence wording → fix → approve; clean merged full gates and
  configured/restored-stock legs passed (§2; [follow-up queue](handoff/20261103-ux-audit-followup.md)).
  ux-a3 now owns bounded keyboard accessibility. Remote CI remains M6-blocked; no push.

- 2026-11-03 (**hb**) — User authorized the [UX audit follow-up](handoff/20261103-ux-audit-followup.md)
  after the review of `7ead4e0..6920469`: reconcile current/historical documentation, harden fresh-server
  and configured-telemetry verification, then complete bounded disclosure/record keyboard paths.
  Original queues stay closed; no push, publication, billing change or deferred engine/SQL work authorized.

- 2026-11-03 (**ha**) — **uxv-5 (Visual) CLOSED; R-13 rehearsal pack — the visual queue's runtime rows are
  complete.** The orchestrator wrote [docs/product/10-ux-ui-demo-rehearsal.md](../product/10-ux-ui-demo-rehearsal.md)
  from a worker `opencode-go/deepseek-v4.1-flash` rehearsal; reviewer `opencode-go/mimo-v2.6-flash` xhigh
  returned **request-changes** on two false self-references (a pointer to suffixes "in §7" that §7 did not
  contain, and a pointer to a §6 bullet that did not exist — which also left spec §5's "record which generated
  paths a manual run used" unmet), the fix printed the recorded suffixes (`A769De` M5, `vw887E` M6) and added the
  §6 inference bullet, and a fresh session **approved** after re-deriving the numbers. Integrated as `57503fd` +
  `e3ae857`. The document is a two-chapter rehearsal of the shipped, built UI at `b40e37a`, with CLI continuity
  **inside Chapter 2** and no third chapter. Chapter 1 (the only committed demo input,
  `fixtures/jsonl/nested.jsonl`): idle → `Try with example data` → 12 rows × 10 columns → schema + record
  inspector → Explode `tags` → visible composed SQL and a **20 × 11** result; the reviewer re-derived 12/10/20/11
  with native DuckDB 1.5.5 rather than trusting the prose, and the whole path was completed **keyboard-only in
  both schemes** (3/16/22/40/58 cumulative Tabs) with the honest gap that `Escape` does not close the inspector
  after Enter and closing costs 18 further Tabs past 12 `Delete row N` stops. Chapter 2 uses per-run temporary
  inputs from `writeValidationDatasetA()` (`tests/e2e/support/validation-datasets.ts`) and
  `writeExitJourneyPair()` (`tests/e2e/support/diff-datasets.ts`) — never committed — and walks
  `4 of 9 rules fail (7 rows checked)` → four staged repairs through the `Show row` channel → stale banner →
  `Valid: 0 violations across 9 rules (7 rows checked)` → report export → copy export
  `7 rows as JSON Lines (324 B)` with the opened source's SHA-256 unchanged. CLI continuity is stated exactly:
  the web pre-fix report and the CLI agree on the **same raw files** (0 differences across all 9 ruleIds, counts,
  frozen percentages and sample multisets), the raw file still reports `INVALID — 4 of 9` **after** the staged
  repair (the documented base-view-only behaviour, not a disagreement), and the **explicitly exported** repaired
  copy validates `VALID` in the CLI. The separate M6 pair — explicitly **not** the repaired M5 export, and no
  same-dataset agreement claimed anywhere — shows 4 schema findings, 4 column deltas, 3 key candidates with `id`
  confirmed → `2 added, 2 removed, 2 changed — rows 5 → 5 (keys: id, inferred)` (added rows report-only, 0 jump
  affordances), and the CLI `diff` envelope is equal after removing only the fields each surface legitimately
  omits. The honesty section records that "processed locally" does **not** mean zero outbound requests: a JSONL
  open issues a real DuckDB-WASM extension fetch from `extensions.duckdb.org` (the base host and versioned path
  template are compiled into the shipped engine binary; the concrete platform/filename segment is composed at
  runtime, so the exact URL is not a bundle literal), no collector host was contacted, and the endpoint-free
  build contains no collector string. The gaps section lists what was not exercised (the real FSA picker path,
  Chapter 2 keyboard-only end to end, the M6 zero-state/>K manual legs, the browser re-open of the export, the
  inferred automated-leg temp paths, one unexplained console warning). Scope: **one documentation file**; no
  fixture, test, source or data change and no runtime changeset (192 unchanged); `docs:links:check` **120/0**,
  ADR 46, prettier clean; the reviewer re-ran the M5/M6 journeys (4 passed) and confirmed the doc-only scope of
  both commits. Residual (non-blocking): the prose numbers are evidence-only by design (no test pins them),
  §3.2's "exactly two new directories" is scoped to the `assay-*` globs the snapshot actually covered, and the
  keyboard trail is a recorded observation rather than a pin. **The visual queue's runtime rows are complete;
  uxv-6 remains design-only/deferred.** No push; no engine/protocol/dependency/telemetry change.

- 2026-11-03 (**gz**) — **uxv-4 (Visual) CLOSED; R-12 idle engine explanation.** Worker
  `opencode-go/deepseek-v4.1-flash` → `opencode-go/mimo-v2.6-flash` xhigh reviewer, **approved on the
  first review** after a character-level comparison against spec §2 and two reviewer-designed drills;
  integrated as `6457113`, with the orchestrator holding the idle-copy seam reservation. The idle
  screen now states the engine honestly in two **static** lines, byte-exact to the spec —
  `Powered by DuckDB-WASM · local query execution` and `Dataset contents are processed locally. Edits
are staged; export writes a copy.` — added as `IDLE_ENGINE_LINE` / `IDLE_ENGINE_NOTE` constants in
  `lib/app.ts` with a doc comment that records the static-only contract, and rendered as
  `idle-engine-line` / `idle-engine-note` paragraphs inside the **pre-existing**
  `phase.kind === 'idle'` block (after the capability and format lines, before the drop hint). The
  change is additive: no existing `IDLE_*` copy was rewritten, and the diff's only deletion is a
  rewritten test import. Static-only was verified by grepping the added lines for
  `fetch`/`XMLHttpRequest`/`sendBeacon`/`localStorage`/`useEffect`/timers/`performance.` (comment prose
  only), and the disclosure/opt-out nodes are absent from the diff (ADR 0037 unchanged). No DOM
  reorder beyond inserting the two paragraphs; no new role, `aria-live` or heading; `index.css` needed
  no new class — the lines inherit the idle block's paragraph style (measured 16px, `rgb(26,26,26)`,
  legible in both schemes). Pins: byte-exact string pins plus a curated forbidden-claim scan
  (`connected`/`online`/`status`/`benchmark`/`latency`/`throughput`/`memory`/`faster`/`version`/`v1.`/
  `v2.`) in `lib/app.test.ts`; three `App.open-status.test.tsx` legs that **drive the real phase**
  before asserting absence (idle present, opening absent, ready absent) plus the extended R-03
  error-phase absence; and one built-app `smoke.spec.ts` leg whose literals are declared locally (not
  imported) so a bundle drift is caught. Mutants killed: rewriting the line to “engine connected and
  ready” (three pins), removing the explanatory node (component pin + rebuilt e2e), the reviewer's
  own drill that rendered the lines outside the idle gate (four pins including the pre-existing R-03
  one), and a `·` → `-` copy drift (unit + e2e). Residual (non-blocking): the two lines inherit body
  paragraph styling rather than the metadata type token (a one-rule scoped addition is available but
  was deliberately not taken under “minimal existing-class use only”); the forbidden-claim scan is a
  curated word list over the idle block, not a general copy linter; opening/error absence is pinned at
  component level only; and the component pin compares against the imported constant, so it is
  self-referential by design — the literal unit and smoke pins are what catch copy drift. Merged
  verification at `6457113` (clean worktree, default ports, `CI=1 pnpm exec playwright test
--retries=0`): **227 unit files / 3408 tests, e2e 217 passed + 1 skipped, coverage
  89.15/83.89/91.42/90.73, docs 119/0, ADR 46, 192 changesets — all gates exit 0**
  (`/tmp/assay-ux-uxv4-merged/`). Visual frontier: **uxv-5** (the final row, a documentation
  deliverable). No push; no engine/protocol/dependency/telemetry change.

- 2026-11-03 (**gy**) — **uxv-3 (Visual) CLOSED; R-11 desktop canvas.** Worker
  `opencode-go/deepseek-v4.1-flash` → `opencode-go/mimo-v2.6-flash` xhigh reviewer, **approved in
  round 1** after the reviewer re-derived every box with its own probe; one text-only record
  correction (`8e749be`) closed wrong measurement figures and a parts list that did not sum, then
  passed a round-2 re-review. Integrated as `fb195b4` + `cd4fb3f`; the orchestrator held the
  `index.css` + scoped header/open/status class + shell/geometry/memo test reservation. The page cap
  is gone: `body` padding is the tokenised 16px gutter with a 24px step at ≥1440px and
  `main { max-width: 72rem }` was deleted, so the page inset is the only horizontal inset; the
  two-pane grid now runs `320px minmax(0,1fr)` with a 16px gap at 1024–1199px and a
  `@media (min-width: 1200px)` step to 360px, while the 1024px breakpoint, the `[data-pane]` rail
  variant and every ≤1023px `order` rule stay byte-identical apart from the sanctioned inset. Measured
  matrix, re-derived independently by the reviewer (all deltas 0px inside the ±2px window): 1024×700 →
  16/992/320/16/656; 1440×900 → 24/1392/360/16/1016; 1920×1080 → 24/1872/360/16/1496; 900×900 →
  16/868/stack/—/868. Four scoped classes on **existing** nodes only (h1 → page-title token, tagline
  → UI size, open-flow block, table-info → metadata size) cut the ready-workspace top from 225.16px
  to **127.88 / 135.88 / 135.88** against the ≤140px budget, with explicit line-heights so the
  figures do not depend on font metrics. The grid viewport became
  `clamp(280px, calc(100vh - 280px), 640px)` plus the `dvh` variant: the spec's 240px candidate was
  measured and **rejected inside this task** — it yields a 460px viewport whose footer's last pixel
  lands at 728.27, i.e. **28.27px below the 700px fold**, and it also defeats 1440×900 (footer bottom
  916.27 > 900) — so the reserve was raised to the measured **268.27px** (211.27px above the viewport
  - 3px gap + 54px footer), giving **420/620/640** and **11.73px** of slack at the smallest sample.
    At 1024×700 the section heading, its purpose, the column headers, the first ready row and the whole
    footer are in frame (footer 634.27–688.27), and no sample has horizontal document overflow.
    Invariants held: DOM sequence and heading map untouched (`App.tsx` changed four `className`
    attributes and dropped the unused `export` on `paneToggleLabel`, which nothing imported and whose
    accessible names remain pinned through the rendered DOM); grid internals and
    `App.memo-probe.test.tsx` untouched; 28px rows, header measurement, horizontal scroll, overscan
    contracts and dock placement unchanged; eight pre-existing `overflow: hidden` rules and no new one;
    no JS row-estimate change; ≤1023px ordering and scroll-never-clip behaviour unchanged. Pins: five
    real-browser geometry legs (one per matrix row asserting gutter/main/pane/gap/grid within ±2px,
    pane↔grid top alignment, ready-top ≤140, viewport height ±2px and no horizontal clip, plus the
    1024×700 first-paint acceptance) and four structural source pins in the new
    `apps/web/src/shell-geometry.test.ts`. Mutants killed: restoring the 72rem cap (1440/1920 right
    gutters measure 264/744px), the spec's 240px reserve (the footer leg and both height pins fail),
    and a **reviewer-designed** restore of the base `minmax(300px, 360px)` pane track (measured 360 vs
    the 320 matrix). Residual (non-blocking): the viewport-height pins restate the clamp so the footer
    leg is what binds the constant to the requirement; spec §4's “Settings must not cover the Open CTA
    at 1024px” was measured by hand (0px² overlap in idle and ready) but is not pinned;
    `.workbench-tools` still bounds the sticky pane with `100vh`; `--radius-md/lg` and
    `--font-family-mono` remain declared-but-unadopted (uxv-5). Merged verification at `cd4fb3f` (clean
    worktree, default ports, `CI=1 pnpm exec playwright test --retries=0`): **227 unit files / 3403
    tests, e2e 216 passed + 1 skipped, coverage 89.15/83.89/91.42/90.73, docs 119/0, ADR 46, 191
    changesets — all gates exit 0** (`/tmp/assay-ux-uxv3-merged/`). Visual frontier: **uxv-4** → uxv-5.
    No push; no engine/protocol/dependency/telemetry change.

- 2026-11-03 (**gx**) — **uxv-2 (Visual) CLOSED; R-10 token layer and named controls.** Worker
  `opencode-go/deepseek-v4.1-flash` → `opencode-go/mimo-v2.6-flash` xhigh reviewer, **approved on
  the first review**; integrated as `b487788`, with the orchestrator holding the `index.css` + named
  App/toolbar/export/telemetry class + theme-pin reservation. One new scheme-independent `:root`
  block adds semantic spacing (`--space-1/2/3/4/6/8` = 4/8/12/16/24/32px), control heights
  (`--control-height-compact`/`--control-height` = 32/36px), radii (`--radius-sm/md/lg` = 4/6/8px)
  and type aliases (`--font-size-ui/body/metadata/page-title` = 14/16/13/24px, plus UI and mono
  families) without renaming, removing or adding a single colour token. Adoption is deliberately
  bounded: the idle **Open** control and **Try with example data** (new `.open-button` /
  `.example-button` — previously bare buttons), the existing `.workbench-section-toggle` and
  `.workbench-pane-toggle` (spacing/height/radius/focus only, type size untouched so ug-13's
  title/purpose hierarchy survives), the telemetry Settings toggle plus a new Close and consent
  action, the export dialog's new `.export-action-primary` / `.export-action-secondary` and its
  format controls, and the two classes ug-8 left unstyled (`.edit-overlay-explanation`,
  `.export-staged-count` — type/spacing only). Exactly **two** primaries carry the single restrained
  accent rule (Open, export confirm); the consent pair is neutral by design so an accented answer
  cannot steer a privacy choice (ADR 0037); one shared `outline: 2px solid var(--color-focus)` with a
  2px offset covers all nine adopted action selectors plus the export radio; errors and stale state
  keep text **and** colour. No `button {}` selector, no colour literal, no motion and no
  `.grid-*`/`.schema-*`/`.filter-*`/`.sql-*` selector entered the adopted block, and every component
  diff is a class attribute only (App, ExportDialog, TelemetrySettings, TelemetryDisclosure — no
  logic, name, copy, testid, DOM-order or save/telemetry behaviour change). Pins: a new
  `design-tokens.test.ts` with 46 source pins (each scale alias declared once with its px value and
  absent from the dark block, type ranges, 24 per-control adoption assertions, exactly-two-primaries,
  neutral secondaries, consent never accent, the single 2px/2px focus rule over all nine selectors,
  **no bare element selector anywhere in the stylesheet**, no colour literal/motion/grid selector in
  the adopted block, and a retention pin keeping `.grid-sort-toggle` at 1.92/4.48px padding, 3px
  radius and 11.52px type) plus three both-scheme computed-style e2e legs (the whole scale resolves
  identically in light and dark while the colour tokens differ; primary vs secondary accent/neutral
  at 36px/4px/14px with weight 600 vs 500 and a **keyboard-reached** 2px ring on both; export,
  telemetry and ug-8 adoption) with browser-measured AA on every adopted pair (Open 10.53/7.57,
  example 16.26/12.46, export confirm 10.53/7.57, export close 16.26/12.46, staged count 5.18/8.13,
  explanation 7.46/8.62, Settings toggle 16.26/12.46 — light/dark). Mutants killed: dropping
  `.open-button` from the accent rule (unit + browser primary pin), dropping `.example-button` from
  the shared geometry/secondary rule (two unit pins + browser height pin), and a
  **reviewer-designed** global `button { padding: 2px }` (the no-bare-selector pin fires). The worker
  also re-ran uxv-1's configured-disclosure leg as extra evidence: the consent affordances now
  measure 16.26:1 light / 12.46:1 dark (was 5.33:1 dark on the UA control face), 3 collector POSTs
  intercepted and aborted, stock output restored endpoint-free. Residual (non-blocking): the browser
  `:focus-visible` proof covers two of nine adopted controls (the rest are source-pinned and no
  `outline: none/0` exists anywhere), the disabled-control AA claim is hand-computed rather than
  asserted, `--font-size-page-title`/`--radius-md/lg`/`--font-family-mono` are declared and pinned but
  await uxv-3/5 adoption, `.export-actions` margin-top 8→12px and `.export-formats` row-gap 12→8px are
  sanctioned value changes without retention pins, and turbo's cache-restore can leave stale hashed
  chunks in `apps/web/dist` (process note: `rm -rf` before a restored rebuild). Merged verification at
  `b487788` (clean worktree, default ports, `CI=1 pnpm exec playwright test --retries=0`): **226 unit
  files / 3399 tests, e2e 211 passed + 1 skipped, coverage 89.15/83.89/91.42/90.73, docs 119/0, ADR
  46, 190 changesets — all gates exit 0** (`/tmp/assay-ux-uxv2-merged/`). Visual frontier: **uxv-3**
  → uxv-4 → uxv-5. No push; no engine/protocol/dependency/telemetry change.

- 2026-11-03 (**gw**) — **uxv-1 (Visual) CLOSED; R-09 theme completeness.** Worker
  `opencode-go/deepseek-v4.1-flash` → `opencode-go/mimo-v2.6-flash` xhigh reviewer, **approve** after
  three fix rounds that were all about the evidence record, not the fix; integrated as `55784f1`,
  `334b9c0`, `f62607b`, `d85dec2`. The orchestrator held the exclusive `index.css` +
  theme/telemetry-test reservation for the row. **Defect:** `.telemetry-settings-dialog` and
  `.telemetry-disclosure` were painted with `var(--color-surface-panel, #fff)`; that token is defined
  nowhere in the token layer, so the hard-coded `#fff` fallback won in both schemes and both panels
  stayed white in dark mode — measured 1.21:1 (light `#e8eaed` text on `#ffffff`). **Fix:** the rule
  uses the defined, scheme-aware `--color-surface-elevated` (`#fbfcfe` light / `#1d2126` dark — the
  floating-panel semantic `.export-dialog` already uses) with the colour fallback **removed entirely**,
  so a future token typo fails evidence instead of silently repainting white. **Evidence:** a driven
  both-scheme browser measurement (the test computes contrast from live computed styles, not
  literals) gives Settings title/label 16.95:1 light and 13.43:1 dark, the disclosure copy the same,
  and the UA-rendered Close/consent controls 18.26:1 / 5.33:1; surface identity is asserted against the
  resolved token in both schemes; axe scans of both surfaces stay green with `DEFERRED_A11Y` still
  empty. A new unit pin requires a **bare `var(--token)`** (any colour fallback fails), the token must
  be declared in both scheme blocks with different values, and `--color-text` on it must clear 4.5:1
  in both schemes. The isolated configured-disclosure leg (its own spec + config outside the stock
  `tests/e2e` testDir, ports 4473/4479/4480, collector route registered **before** navigation and
  aborted, service workers blocked, fresh local storage) ran against a bundle **proven** to carry the
  endpoint: 2 passed per scheme, 3 collector POSTs intercepted and all aborted, 0 delivered, then
  stock output restored and the stock theme/telemetry/a11y legs re-run green — no production hook, no
  consent/storage/event change (only `index.css`, tests and one changeset changed). Round 1's reviewer
  found the privacy gate vacuously true on an empty interception array (now `intercepted.length > 0`
  per scheme, with a mutation showing zero attempts fail); rounds 2 and 3 corrected two provenance
  claims in the same evidence comment (the 1.21:1 figure is a standalone browser measurement, not an
  axe result and not a `theme.spec.ts` output, and the mutant repaints the **light** panel too — light
  axe passes because light text stays dark on white). Mutants killed: restoring the `, #fff` fallback
  (four unit pins, both identity pins and the dark pre-scan pin fail), and a reviewer drill pointing
  the rule at the defined page surface `--color-surface` (the unit pins pass and only the browser
  identity pin fails — proving the browser layer is load-bearing). **Documentation defect found and
  fixed here:** spec §6's configured-build command could never configure the bundle — turbo 2.x runs
  in strict env mode, `turbo.json` declares no `env`, so the variable is dropped and the task is
  usually a cache hit (`--force` does not help) — and its restore step left stale configured chunks
  because a cache-hit rebuild does not delete them. §6 now builds `@assay/web` directly and greps
  `apps/web/dist` for the endpoint before and after the leg, with the residual `turbo.json` `env`
  declaration recorded as the cleaner long-term fix (root config, deliberately not changed inside a
  visual row). Merged verification at `d85dec2` (clean worktree, default ports,
  `CI=1 pnpm exec playwright test --retries=0`, plus the configured leg on 4473/4479/4480): **225 unit
  files / 3353 tests, e2e 208 passed + 1 skipped, coverage 89.15/83.89/91.42/90.73, docs 119/0, ADR 46,
  189 changesets — all gates exit 0, configured leg 2 passed, restored dist endpoint-free**
  (`/tmp/assay-ux-uxv1-merged/`, logs `/tmp/assay-ux-uxv1-merged-logs/`). Residual (non-blocking): the
  UA-rendered buttons inside both surfaces still paint the platform control face (uxv-2's
  named-control inventory owns that), light `--color-surface-elevated`/`--color-surface` differ by one
  step so panel separation is mostly the 1px border (uxv-2 revisits), and the comment-only rounds live
  in the commit chain rather than being rewritten. Visual frontier: **uxv-2** → uxv-3 → uxv-4 →
  uxv-5. No push; no engine/protocol/dependency/telemetry change.

- 2026-11-02 (**gv**) — **ug-23 (Shell) CLOSED; the usability batch is complete (23 of 23 rows).**
  Worker `opencode-go/deepseek-v4.1-flash` → `opencode-go/mimo-v2.6-flash` xhigh reviewer, **approved
  on the first review**; integrated as `07a37d4`. All four code-observation riders landed in the
  reserved paths. (a) **CO-1** — the `usePipelineSession` call-site comment no longer claims the
  pipeline "jump[s] its outputs into the SQL pane's result surface": it states that p2-6 made previews
  grid-native (a materialized node's relation opens through the p2-1 `registerPipelineRelation` handle
  op and drives the same handle-based grid model a dataset open uses, rendered by the existing
  `DataGrid`), that the SQL-pane detour is retired, and that the later `data-bind-revision` contract
  ordinal and the ug-9/R-15 gate cross-link belong to the panel/session pair. Comment-only — the
  reviewer walked every changed line and each claim against `usePipelineSession.ts`,
  `PipelinePanel.tsx` and `App.tsx`. (b) **CO-2** — one pure `filterChipKey(filter)`
  (`JSON.stringify([column, predicate])`, the ordered-pair grammar the file already used for
  `filterListSignature`) replaces the colliding `` `${filter.column}:${filter.predicate}` `` join at
  **all three** chip-key sites (removable collapsed header chips, editable active rows and the
  display-only expanded-body list); rendering, labels, removal semantics and the FilterSpec grammar are
  untouched, and a deliberately colliding pair (`a:b`+`c` vs `a`+`b:c`) renders as two distinct chips
  with zero duplicate-key warnings and removes independently. (c) **CO-3** — the pane toggle's
  accessible name is now state-dependent and action-reflecting (`Collapse workbench pane` /
  `Expand workbench pane`, from a pure exported `paneToggleLabel`) while the in-pane `<nav>` keeps
  `Workbench sections`; `aria-expanded` and `aria-controls` are byte-identical to before, and the pins
  assert name uniqueness per role, that the two names differ, that neither leaks onto the other role,
  and that the label tracks `aria-expanded` — in unit tests and in real Chromium inside the ≥1024px
  shell test. (d) **CO-4** — the `row-uninsert` gloss is decided and applied as `undo row insert`
  (pluralises under the existing rule, matches the toolbar's own `Insert row` affordance, stays
  distinct from `row delete`), pinned at function level (singular, plural, plus a `/expunge/i` negative
  over all eight op kinds) and at the rendered toolbar surface through the real `EditToolbar`. Mutants
  killed: all three chip keys reverted to the colon join (duplicate-key warnings on both surfaces), the
  shared `Workbench sections` name restored on the toggle (unit and, after a rebuild, e2e), the gloss
  reverted (five pins), and a **reviewer-designed** partial-application drill that mutated each of the
  three key sites individually — proving no half-applied key fix can pass. The reviewer's CO-4
  assessment is **satisfied as scoped**: the domain-side `describeOp` text `expunge inserted row N`
  (`packages/domain/src/edit-ops.ts`) is **dormant, not live** — the web producers are only
  `row-insert`/`cell-set`/`row-delete`/`column-rename`/`column-cast`, undo/redo are pure cursor moves
  and history is in-memory only — so the jargon reaches no screen today, and the changed summary string
  is likewise unreachable until a producer exists, which the changeset and the render-pin header
  disclose instead of dressing it up as a fixed screen. Residual (non-blocking, recorded): **any future
  row that adds a web producer for `row-uninsert` must also gloss the `@assay/domain` `describeOp`
  string** (with a `@assay/domain` changeset), otherwise `HistoryPanel` would render the jargon; CO-2's
  load-bearing assertions are the duplicate-key-warning lines (the removal leg pins removal semantics,
  not the collision). Merged verification at `07a37d4` (clean worktree, default ports,
  `CI=1 pnpm exec playwright test --retries=0`): **224 unit files / 3349 tests, e2e 205 passed + 1
  skipped, coverage 89.15/83.89/91.42/90.73, docs 119/0, ADR 46, 188 changesets — all gates exit 0**
  (`/tmp/assay-ux-ug23-merged/`, logs `/tmp/assay-ux-ug23-merged-logs/`). **The usability batch is
  complete: ug-1…ug-23 CLOSED, all three lanes closed.** The only UX work left in this pack is the
  visual lane, where uxv-1 is eligible only under an exclusive CSS/theme-test reservation. No push; no
  engine/protocol/dependency/telemetry change.

- 2026-11-02 (**gu**) — **ug-22 (Shell) CLOSED; sticky-nav reading order, DOM untouched.** Worker
  `opencode-go/deepseek-v4.1-flash` → `opencode-go/mimo-v2.6-flash` xhigh reviewer,
  **request-changes** on a trivially-true pin and a false evidence claim → fix commit → fresh-session
  **approve**; integrated as `25f95b9` + `e73dda4`. `WORKBENCH_SECTIONS` now reads **schema,
  filters, grid, validation, compare, sql, editing, history, export, record, profile, pipeline** — a
  pure array edit with the same twelve ids and titles and `pipeline` last per the q-15 placement
  ruling, so the "why do my rows look like this?" loop (filter → validate → compare → query) is one
  nav link away instead of Filters sitting eighth. This is the one change the ruling authorizes: the
  reviewer independently extracted the `<WorkbenchSection id>` JSX order and the `h2` order at base
  and at the change and found them byte-identical, `index.css` carried no `order:`/`display:contents`
  change, and `App.headings.test.tsx` stayed green without edits; the commit cites ADR 0044 / D14 +
  q-15 and states the boundary. Pins: `App.shell.test.tsx` `NAV_ORDER`, `pipeline`-last and
  `filters`-before-`grid`-in-the-nav; the pre-existing `DOM_ORDER`/`TOOL_DOM_ORDER` `toEqual` pins
  and the twelve-`h2` map for the unchanged DOM; one dedicated live decoupling test reading the
  rendered nav `<a>` list and the rendered `.workbench-section` list with `>= 0` guards on both ids
  and asserting `navIds.indexOf('grid') !== domIds.indexOf('grid')` (nav 2 vs DOM 10); and the nav
  list plus a `pipeline`-last assertion in `tests/e2e/shell.spec.ts`, re-pointed locator-only and
  reviewed as an in-scope pin update (no assertion removed or weakened, `DOM_ORDER`, heading map,
  geometry, sticky and `scroll-margin` legs untouched). Round 1's finding: the worker's first
  `grid`-before-`filters`-in-the-DOM assertion scoped its query to `.workbench-tools`, which never
  contains `grid` (it renders in `.workbench-center`), so it evaluated `-1 < 6` behind an earlier
  `toEqual` and could never fail — and the comment, changeset and commit message claimed the pair
  "makes the decoupling non-vacuous" when nav and DOM actually agree for that pair. The fix replaced
  it with the live comparison above and corrected all three claim sites (`ef89942` itself was not
  amended; `deec89e` records the correction). Mutants killed: a JSX DOM swap instead of an array
  edit (heading map + shell DOM pins fail), dropping `record` from the array (nav-order pin fails),
  making the nav and DOM indexes equal (the decoupling pin fails on its own line — `expected 10 not
to be 10`), and removing `grid` from the nav (the `>= 0` guard fires at `:334`). Residual
  (non-blocking): the superseded claim survives in `ef89942`'s commit message by design (history is
  not rewritten), and the decoupling test pins absolute-index inequality for two of twelve ids while
  the `toEqual` pins, heading map and e2e cover the rest. Merged verification at `e73dda4` (clean
  worktree; the default 4173 was held by a foreign preview server, so the merged e2e ran on the
  documented alternate ports 4573/4579/4580, `CI=1 pnpm exec playwright test --retries=0`): **223
  unit files / 3339 tests, e2e 205 passed + 1 skipped, coverage 89.15/83.89/91.41/90.73, docs 119/0,
  ADR 46, 187 changesets — all gates exit 0** (`/tmp/assay-ux-ug22-merged/`, logs
  `/tmp/assay-ux-ug22-merged-logs/`). Remaining runtime row: Shell **ug-23**. No push; no
  engine/protocol/dependency/telemetry change.

- 2026-11-02 (**gt**) — **ug-21 (Shell) CLOSED; opening progress + session-token cancel.** Worker
  `opencode-go/deepseek-v4.1-flash` → `opencode-go/mimo-v2.6-flash` xhigh reviewer, **approved on
  the first review**; integrated as `8458ad1`. (a) While `phase.kind === 'opening'` the UI shows a
  native, genuinely indeterminate `<progress aria-label="Opening progress">` — no `value`, no `max`,
  no `aria-valuenow`, no `aria-live`, placed outside the existing single polite live region — beside
  the unchanged `Opening…` status copy. Nothing in the affordance carries a percentage, byte count,
  row count or filename (ADR 0025). (b) A `Cancel opening` button, rendered **only** in the opening
  phase, returns the app to a clean idle frame through the **existing** guard:
  `datasetSession.beginSession()` (bump `tokenRef` first, then run every registered domain reset)
  followed by `setPhase({ kind: 'idle' })`. The in-flight open's existing post-`await` token
  comparisons therefore drop its result — no phase flip, no `open-error`, no stale dataset — and a
  subsequent open behaves exactly as before and reaches `ready`. There is no second cancellation
  path, no `AbortController` and no engine interrupt (the protocol has none; the code comment and the
  changeset state that honestly, and the cancel is documented as a session discard plus UI reset).
  `openDataFile`, its guard order and its post-await checks are byte-identical to base — the commit
  is insertions-only across seven files. (c) `idle`/`ready`/`error` render neither affordance and the
  Open button's opening-phase `disabled` is unchanged. Pins: `App.open-status.test.tsx` gains three
  legs (indeterminate + accessible-name contract; a controllable deferred open resolved **after**
  cancel leaves the phase `idle` with zero schema calls and no error, then a follow-up open reaches
  `ready`; idle/ready/error absence), `lib/app.test.ts` pins the exact labels/copy, and one
  real-Chromium `tests/e2e/open-cancel.spec.ts` holds the first real `engine/open` behind a
  **test-owned** `addInitScript` gate (no production hook, no arbitrary sleep), cancels mid-open,
  releases the held response, asserts `data-phase="idle"` with no error, then opens
  `customers.parquet` to `ready` (5 rows × 4 columns). Mutations killed: dropping the
  `beginSession()` bump (the cancelled open flipped to `ready` — `expected 'ready' to be 'idle'`),
  giving the progress a fixed `value` (indeterminate pin failed), and the reviewer's own drill
  removing the post-`engine/open` token comparison (the late chain ran on, `expected 1 to be +0`
  schema calls — proving no single post-await check is decorative). Residual (non-blocking): the
  e2e's post-release "late result discarded" assertion is deterministically vacuous with respect to
  the token bump (the reviewer removed the bump and the spec still passed 3/3; the component pin is
  the load-bearing evidence, so strengthening the gate or correcting its comment is a follow-up
  candidate), the opening state is not driven by the axe scans (component aria pins substitute), and
  a cancelled chain that already passed `rowCount` leaves `historyRef`/`overlayRef`/an engine handle
  exactly as today's pre-existing AR-W13 stale-chain behaviour does — nothing renders it in `idle`
  and the next open overwrites it. Merged verification at `8458ad1` (clean worktree at the merged
  tip, default ports, `CI=1 pnpm exec playwright test --retries=0`): **223 unit files / 3338 tests,
  e2e 205 passed + 1 skipped, coverage 89.15/83.89/91.41/90.73, docs 119/0, ADR 46, 186 changesets —
  all gates exit 0** (`/tmp/assay-ux-ug21-merged/`, logs `/tmp/assay-ux-ug21-merged-logs/`); one
  known engine-side `row-diff-agreement` CLI internal-error flake failed the first coverage run and
  passed isolated and on the full rerun (recorded, no threshold weakened). Current frontier: Shell
  **ug-22** → ug-23; uxv-1 only under an exclusive CSS/theme-test reservation. No push; no
  engine/protocol/dependency/telemetry change.

- 2026-11-02 (**gs**) — **ug-20 (Panels) CLOSED; Panels lane complete.** Worker
  `opencode-go/deepseek-v4.1-flash` → `opencode-go/mimo-v2.6-flash` xhigh reviewer,
  **request-changes** on a vacuous accessible-name pin (the enabled `Show only failing rows`
  control was never checked) and a stale starter status on a schema-equal dataset swap → fix →
  **approve**; integrated as `3078797` + `5bad2c3`. (a) The validation zero state offers
  `Download a starter contract`: a pure builder maps only confidently mappable schema columns to
  the real contract vocabulary (aliases exact, `DECIMAL(p,s)`/`VARCHAR(n)` validated, arrays,
  nested and unknown types omitted rather than guessed), emits canonical YAML with static
  `starter-contract` metadata and `dataset.min-rows: 1` (no dataset filename or values), and
  delivers a NEW file through the established hidden-anchor discipline; the button is disabled
  without a schema, absent outside the `none` state, never auto-imports, reports value-free
  success/failure, and the status clears on dataset swaps. (b) Each enabled failure-filter control
  states `Replaces the current 1 filter` / `Replaces the current 2 filters` when filters are
  active (absent at 0, not on disabled variants), wired from the real `model.filters` count; the
  enabled controls’ accessible names are unchanged (pinned, note as a sibling). App adds exactly
  the two prop passes; `report-export.ts`, engine, protocol, dependencies and telemetry are
  untouched. Eight mutations were killed (dropped type mapping, note at 0, wrong plural,
  enabled-without-schema, note nested in the enabled button, dropped status-clear dependency,
  success-on-throw, filename leak). Merged verification at `5bad2c3` (clean worktree, default
  ports, `CI=1 --retries=0`): **223 unit files / 3334 tests, e2e 204 passed + 1 skipped, coverage
  89.14/83.88/91.41/90.73, docs 119/0, ADR 46, 185 changesets — all gates exit 0**
  (`/tmp/assay-ux-ug20-merged/`). Residual (non-blocking): synchronous-only delivery catch; the
  schema-equal swap trigger is code-read-verified rather than e2e-pinned; timestamptz types are
  conservatively omitted. **Panels lane complete.** Current frontier: **ug-21 (Shell)** → ug-22 →
  ug-23; uxv-1 only under an exclusive CSS/theme-test reservation. No push; no
  engine/protocol/dependency/telemetry change.

- 2026-11-01 (**gr**) — **ug-19 (Grid) CLOSED; contrast + in-flight feedback hardening; Grid lane
  complete.** Worker `opencode-go/deepseek-v4.1-flash` → `opencode-go/mimo-v2.6-flash` xhigh
  reviewer, **request-changes** on two Majors (a queued loading-row edit could open on a renumbered
  logical row after an overlay-induced reorder; the dataset-replacement pin was vacuous) plus a
  NULL-marker AA failure → fix → **approve**; integrated as `b1444dc` + `0ac3447`. (a)
  Empty-state/secondary text uses `--color-text-secondary`; the record inspector’s NULL marker uses
  a new semantic `--color-null-text` measured ≥4.5:1 on every real surface in both schemes (light
  5.37/5.03, dark 7.70/6.37); both-scheme axe scans now drive a DuckDB-verified NULL row and the
  grid/SQL zero-result states with the empty allowlist unchanged. (b) The grid exposes `aria-busy`
  and a polite footer `Sorting…`/`Filtering…` status through minimal App/FilterBar/DataGrid wiring,
  cleared on settle for success and failure, Filtering winning when both run, sort epochs counted,
  unmount cleanup pinned, and the read-only preview rendering no busy UI. (c) A loading-row
  double-click/Enter queues one pending edit that opens only on the captured logical key and retires
  silently on an overlay-revision change, drops visibly on an error settle, is replaced by newer
  gestures and cleared by dataset swaps; ready-row editing is unchanged. Ten mutations were killed
  (faint on an empty-state rule, dropped settle clear, restored early return, dataset/overlay/key
  guards, unmount cleanup, App dataset clear, profile faint, old NULL token). Merged verification at
  `0ac3447` (clean worktree, default ports, `CI=1 --retries=0`): **221 unit files / 3316 tests, e2e
  203 passed + 1 skipped, coverage 89.19/83.85/91.42/90.77, docs 119/0, ADR 46, 184 changesets — all
  gates exit 0** (`/tmp/assay-ux-ug19-merged/`). Residual (non-blocking): the error-notice in the
  overlay-retirement branch is unpinned; the captured-key guard is defensive. Grid lane complete;
  current frontier: **ug-20 (Panels)**, **ug-21 (Shell)**, then ug-22/ug-23; uxv-1 only under an
  exclusive CSS/theme-test reservation. No push; no engine/protocol/dependency/telemetry change.

- 2026-11-01 (**gq**) — **ug-18 (Grid) CLOSED; filter compose row + collapsed chips.** Worker
  `opencode-go/deepseek-v4.1-flash` → `opencode-go/mimo-v2.6-flash` xhigh reviewer,
  **request-changes** on a Critical untouched-active-row Apply that silently removed the filter
  after a programmatic `setFilters` (plus stale prefill, an unpinned removal guard/rollback and
  duplicate removal surfaces) → fix → **approve**; integrated as `51a3e46` + `4d3cb54`. The
  expanded Filters body is now one `Filter on:` compose row (column, kind-derived operator, value
  only when needed, Apply) compiled through the existing builder with single-line rejections and
  the existing pending/rollback path, followed by editable active rows that always apply what they
  display (an explicitly emptied input still removes) and the per-column SQL-fragment escape hatch
  inside a collapsed `SQL predicates` disclosure. The collapsed summary names the active columns
  (`Filters · N active: col1, col2`) with chips and remove buttons as siblings of the toggle
  (never nested), and removal works while collapsed through the same guard/rollback; exactly one
  removal control per filter per state. The uxc-4 latch (including collapse-mid-apply), Enter
  handling, framed filter errors and programmatic bridges are preserved; no grammar, engine,
  protocol or telemetry change. Four e2e specs were re-pointed locator-only and reviewed. Merged
  verification at `4d3cb54` (clean worktree, default ports, `CI=1 --retries=0`): **217 unit files /
  3288 tests, e2e 199 passed + 1 skipped, coverage 89.13/83.72/91.22/90.70, docs 119/0, ADR 46, 183
  changesets — all gates exit 0** (`/tmp/assay-ux-ug18-merged/`). Residual (non-blocking): the
  internal `applyList` pending guard is unreachable behind disabled controls and therefore unpinned.
  Current frontier: **ug-19 (Grid)**, **ug-20 (Panels)**, **ug-21 (Shell)**; uxv-1 only under an
  exclusive CSS/theme-test reservation. No push; no engine/protocol/dependency/telemetry change.

- 2026-11-01 (**gp**) — **ug-11 (Grid) CLOSED; row identity visible, and the reviewer roster
  changed.** Two independent review rounds at `5857685`/`e80a185`/`edd15de`, integrated as
  `e3e0dc1`/`eb23b53`/`79febe5`. (a) A sticky, 1-based row-number gutter is the first track in the
  header and every body row (`role=rowheader`, `#` columnheader, `aria-colcount` +1, opaque striped
  background, right separator, z-index under the sticky header) and stays pinned on horizontal
  scroll. The record dock title, region label and reloading label deliberately moved to the same
  1-based convention with every old 0-based pin updated; ug-12’s `base #<ordinal>` announcement
  remains the logical base ordinal. (b) Dock ◀ Prev / ▶ Next step to the immediate neighbour
  (N-1 / N+1), disabled only at dataset bounds or when the neighbour is `error`; a `loading`
  neighbour rides the existing uxc-2 pending gesture, pinned for the open-dock “pending lands
  error” drop (same section stays on row N, `onClosed` once, no stranded focus). Stepping is O(1)
  (one `getRow` per direction, bounds-checked first); a 100k-row sparse-cache call-count pin (≤6,
  actual 4) kills a render-path and a click-only dataset walk. The review rounds caught an
  unbounded adjacent-ready scan (real main-thread risk on million-row data) and then a vacuous
  error-neighbour pin; both were fixed before integration. **Roster:** the independent reviewer
  switched from `openai-codex/gpt-6-luna` to `opencode-go/mimo-v2.6-flash` on 2026-10-31 when the
  Luna credit was exhausted; the switch is now recorded in §4 and operating-model §7.6. Merged
  verification at `79febe5` (clean worktree, default ports, `CI=1 --retries=0`): **217 unit files /
  3262 tests, e2e 198 passed + 1 skipped, coverage 89.07/83.70/91.01/90.65, docs 119/0, ADR 46, 182
  changesets — all gates exit 0** (`/tmp/assay-ux-ug11-merged/`). Residual (non-blocking,
  follow-up candidate): the “later notification is not a second drop” assertion is vacuous against
  the `handledSeqRef` guard because the harness clears the request first; behaviour is idempotent.
  Current frontier: **ug-18 (Grid)**, **ug-20 (Panels)**, **ug-21 (Shell)**; uxv-1 only under an
  exclusive CSS/theme-test reservation. No push; no engine/protocol/dependency/telemetry change.

- 2026-10-31 (**go**) — **ug-12 (Grid) CLOSED; keyboard completion.** Worker
  `opencode-go/deepseek-v4.1-flash` → independent `openai-codex/gpt-6-luna` xhigh reviewer, **approve**
  at `d3af2ec`. (a) One explicit `.grid-cell:focus-visible` rule (existing `--color-focus` token,
  2px, offset -2px) with a keyboard-driven computed-style pin in the roving-tabindex e2e leg. (b)
  Validation and diff “Show row” announce exactly `Showing <displayKey> in the grid and record
inspector` through the existing single polite live region — `<displayKey>` is the domain
  `displayRowKey(rowKey)` (`base #12` / `insert #3`), value-free row identity per ADR 0025 — and
  roving focus lands on the target grid row (active element is the `[data-row-index]` row at
  `tabIndex=0`) with the record inspector open on the same row. `NavigateToRow` gained an optional
  display label, passed by both session jump handlers; failed jumps keep the existing `jumpError`
  flow and announce nothing; repeated jumps re-announce via the existing sequence. Merged
  verification at `d3af2ec` (clean worktree, default ports, `CI=1 --retries=0`): **214 unit files /
  3247 tests, e2e 196 passed + 1 skipped, coverage 89.05/83.67/91.00/90.65, docs 119/0, ADR 46, 181
  changesets — all gates exit 0** (`/tmp/assay-ux-ug12-merged/`; the first e2e attempt was refused
  by a stale preview server on 4173 and the retry on the same default ports was green). Dual-scheme
  axe clean. Current frontier: **ug-11 (Grid)**, **ug-20 (Panels)**, **ug-21 (Shell)**; uxv-1 only
  under an exclusive CSS/theme-test reservation. No push; no engine/protocol/dependency/telemetry
  change.

- 2026-10-31 (**gn**) — **ug-6 (Shell) CLOSED; undo/redo shortcuts + first-append History cue.**
  Worker `opencode-go/deepseek-v4.1-flash` → independent `openai-codex/gpt-6-luna` xhigh reviewer,
  **approve on the first review** at `b2c6ce1`. A single document-level keydown listener (ready
  only, cleaned up on unmount, at most one call per event, preventDefault only when handled) maps
  Ctrl/Cmd+Z → undo and Ctrl/Cmd+Shift+Z / Ctrl/Cmd+Y → redo to the existing handlers, and never
  hijacks native text undo inside input/textarea/select/contenteditable hosts (including nested
  children) — the classification is a pure Node-tested helper. The History section auto-expands on
  the first appended operation only (0→>0), never on undo/redo or dataset open, and never re-opens
  after a user collapse; ug-17’s `History · N pending` summary is unchanged. The ux-3 single visible
  Undo/Redo pair is preserved (shortcuts only). No telemetry; no engine/overlay change. Merged
  verification at `b2c6ce1` (clean worktree, default ports, `CI=1 --retries=0`): **211 unit files /
  3237 tests, e2e 196 passed + 1 skipped, coverage 88.92/83.57/90.76/90.50, docs 119/0, ADR 46, 180
  changesets — all gates exit 0** (`/tmp/assay-ux-ug6-merged/`); one known engine-side
  `row-diff-agreement` coverage flake passed on immediate rerun, recorded not hidden. Current
  frontier: **ug-12 (Grid)**, **ug-20 (Panels)**, **ug-21 (Shell)**; uxv-1 only under an exclusive
  CSS/theme-test reservation. No push; no engine/protocol/dependency/telemetry change.

- 2026-10-31 (**gm**) — **ug-5 (Grid) CLOSED; focused-cell copy shipped.** Worker
  `opencode-go/deepseek-v4.1-flash` → independent `openai-codex/gpt-6-luna` xhigh reviewer,
  **approve on the first review** at `d814fdf`. Ctrl/Cmd+C on a focused, non-editing grid cell
  copies the display value (the same `formatCell(value, type, parsedType)` composition the cell
  renders, never `String(raw)` or DOM scraping) and announces exactly `Value copied.` via the
  existing single polite live region. Null/empty display values copy nothing and say
  `Nothing to copy — this cell is empty.`; a missing/rejected clipboard says
  `Copy failed — the clipboard is unavailable.` with no unhandled rejection. The shortcut is
  cell-scoped (no document listener), only Ctrl/Cmd+C without Alt, and never intercepts while an
  editor is open or the target is an input/select/textarea/contenteditable. Copy mutates no state,
  history, overlay or filters; messages are value-free; no telemetry. Merged verification at
  `d814fdf` (clean worktree, default ports, `CI=1 --retries=0`): **209 unit files / 3220 tests, e2e
  195 passed + 1 skipped, coverage 88.88/83.53/90.73/90.48, docs 119/0, ADR 46, 179 changesets —
  all gates exit 0** (`/tmp/assay-ux-ug5-merged/`). Current frontier: **ug-6 (Grid)**, **ug-20
  (Panels)**, **ug-21 (Shell)**; uxv-1 only under an exclusive CSS/theme-test reservation. No push;
  no engine/protocol/dependency/telemetry change.

- 2026-10-31 (**gl**) — **ug-4 (Grid) CLOSED; capability-true grid interaction language shipped.**
  Worker `opencode-go/deepseek-v4.1-flash` → independent `openai-codex/gpt-6-luna` xhigh reviewer,
  **request-changes** on one Major (unconditional interaction copy claiming edit/inspect/navigate in
  the read-only pipeline preview; the review also caught tests pinning the misleading output) → fix
  commit → fresh-session **approve**. Integrated at `784805c` (`178ffa5` + `784805c`). The editable
  ready grid carries the byte-exact one-line hint `Double-click a cell to edit · Enter edits the
focused cell · Esc cancels`, outside the role=grid subtree and referenced by the grid’s
  `aria-describedby` via a per-instance `useId`; the footer has a native Keyboard `<details>` listing
  only the verified shortcuts (double-click/Enter edit, Esc cancel, Enter-on-row inspect, arrows,
  Home/End, Ctrl/Cmd+Home/End, Tab/Shift+Tab). Hint, keyboard groups and the description are all
  capability-derived, so the read-only pipeline preview claims nothing false; Diagnostics is
  untouched; no new key handlers, no DOM reorder, no telemetry. Merged verification at `784805c`
  (clean worktree, default ports, `CI=1 --retries=0`): **207 unit files / 3201 tests, e2e 194 passed
  - 1 skipped, coverage 88.84/83.45/90.68/90.44, docs 119/0, ADR 46, 178 changesets — all gates exit
    0** (`/tmp/assay-ux-ug4-merged/`). Current frontier: **ug-5 (Grid)**, **ug-20 (Panels)**,
    **ug-21 (Shell)**; uxv-1 only under an exclusive CSS/theme-test reservation. No push; no
    engine/protocol/dependency/telemetry change.

- 2026-10-31 (**gk**) — **ug-17 (Shell) CLOSED; collapsed section state summaries shipped.** Worker
  `opencode-go/deepseek-v4.1-flash` → independent `openai-codex/gpt-6-luna` xhigh reviewer,
  **approve on the first review** at `9a31cd6`. `WorkbenchSection` accepts an optional `summary`
  slot for managed disclosures only: byte-exact `Validation · N failing` (current verdict’s failing
  **rule** count), `Compare · N changed` (current row-diff `changed.count`) and `History · N pending`
  (`activeOps(history).length`), each rendered only at N>0 in verdict/result states and visible
  while the section is collapsed. The toggle’s accessible name is unchanged, the summary is appended
  to `aria-describedby` only when present, inner-disclosure sections keep their own idioms, and the
  twelve R-14 purpose/name pins plus heading pins are unchanged and green. Counts are value-free; no
  telemetry; no DOM reorder; no engine/grid change. Merged verification at `9a31cd6` (clean worktree,
  default ports, `CI=1 --retries=0`): **206 unit files / 3190 tests, e2e 193 passed + 1 skipped,
  coverage 88.84/83.41/90.68/90.44, docs 119/0, ADR 46, 177 changesets — all gates exit 0**
  (`/tmp/assay-ux-ug17-merged/`). Current frontier: **ug-4 (Grid)**, **ug-20 (Panels)** and
  **ug-21 (Shell)**; uxv-1 only under an exclusive CSS/theme-test reservation. No push; no
  engine/protocol/dependency/telemetry change.

- 2026-10-31 (**gj**) — **ug-16 (Panels) CLOSED; profile stats click-to-act shipped under the settled
  typed-refusal design.** Worker `opencode-go/deepseek-v4.1-flash` (commits `9c5310b` + review fix
  `472be2a`) → independent `openai-codex/gpt-6-luna` xhigh reviewer, **request-changes** on two
  async-lifecycle Majors (an earlier failure rollback could overwrite a later successful filter;
  a late rejection after undo or a new dataset could restore stale filters and resurrect feedback)
  → fix commit → fresh-session re-review **approve**; integrated as `30063f4` + `3b494f5`. Profile
  top-k values and null counts are real buttons: every click is planned against the active ops +
  effective schema first, a resolved column compiles through the existing builder against the
  **effective** type and applies via `replaceColumnFilter`/`setFilters` (chips from the existing
  FilterBar, no grammar change), a renamed column applies no filter and renders the byte-exact
  refusal naming base+current, an unresolved column renders the byte-exact generic refusal,
  cast/type mismatch surfaces the builder's readable rejection with no coercion, and zero-row
  results keep the existing empty state. Round 2 added the FilterBar-style synchronous single-flight
  gate + disabled filter controls and attempt/model/dataset identity checks after every `await`.
  R-16 hint/note, `profile-table-id`, `profile(handle)`/engine untouched; no re-profile; no telemetry.
  Merged verification at `3b494f5` (clean worktree, default ports, `CI=1 --retries=0`): **205 unit
  files / 3183 tests, e2e 192 passed + 1 skipped, coverage 88.72/82.77/90.39/90.31, docs 119/0,
  ADR 46, 176 changesets — all gates exit 0** (`/tmp/assay-ux-ug16-merged/`). Current frontier:
  **ug-17 (Shell)**, **ug-4 (Grid)** and **ug-20 (Panels, now eligible)**; uxv-1 only under an
  exclusive CSS/theme-test reservation; no maintainer decision blocks the runtime lane. No push; no
  engine/protocol/dependency/telemetry change.

- 2026-10-30 (**gi**) — **ug-16 design pass settled; pickup pack ready for another thread.** At the
  maintainer's request, the ug-16 renamed/deleted-column prerequisite is decided in
  [20261030-ug16-renamed-column-design.md](handoff/20261030-ug16-renamed-column-design.md):
  **typed refusal, no remap** — a base-derived stat is actionable only when its column resolves on
  the edited view; a renamed column refuses with byte-exact copy naming base and current, an
  unresolved column refuses generically, cast/type mismatch never coerces, and zero-row results
  keep the existing empty state. The ug-16 queue row is now **READY** (predecessor ug-10 CLOSED at
  `f667a87`), the spec §1 status reflects it, and the pickup pack gained a ready-to-paste §3b
  worker brief. Current frontier: **ug-16 (Panels, ready)**, **ug-17 (Shell)**, **ug-4 (Grid)**;
  uxv-1 only under an exclusive CSS/theme-test reservation; no maintainer decision blocks the
  runtime lane. Docs-only; no runtime/engine/dependency/telemetry/remote change.

- 2026-10-30 (**gh**) — **ug-10 (Panels) CLOSED; R-16 profile honesty shipped.** Worker
  `opencode-go/deepseek-v4.1-flash` → independent `openai-codex/gpt-6-luna` xhigh reviewer,
  **approved on the first review** at `f667a87`. The panel now renders the byte-exact standing hint
  `Statistics describe the file as opened — staged changes are not included.` in every expanded
  state and the byte-exact singular/plural note (`1 staged change is not reflected here — the grid
uses the edited view. Validation must be run explicitly against the edited view.` / `N staged
changes are …`) while `activeOps(history).length >= 1`, disappearing at 0 and after undo, with no
  stale/re-run banner, no re-run-for-edits control and no auto-recompute on overlay revision
  change; `profile(handle)` and `packages/**` untouched, idle `profile-table-id` preserved.
  Merged verification at `f667a87` (clean worktree; e2e on 4573/4579/4580, `CI=1 --retries=0`):
  **202 unit files / 3142 tests, e2e 189 passed + 1 skipped, coverage 88.60/82.74/89.83/90.15,
  docs 118/0, ADR 46, 175 changesets — all gates exit 0** (`/tmp/assay-ug10-merged/`). Next Panels
  row **ug-16**, whose renamed/deleted-column disclosure/refusal/mapping design is a dispatch
  prerequisite; then ug-20. No push; no engine/protocol/telemetry change.

- 2026-10-30 (**gg**) — **UX-D1 RESOLVED by the maintainer: Option C** (honest labeling now;
  overlay-aware profile chartered separately). Recorded in
  [20261029-ux-d1-amendment.md](handoff/20261029-ux-d1-amendment.md) §7 (ticked, dated, attributed) and in
  spec §7; **R-16 is now authorized** in spec §2 (byte-exact base-as-opened hint + singular/plural
  staged-changes note, all four expanded states, no stale/re-run banner, no auto-recompute, engine
  untouched) and in the spec §8 index (owner ug-10). The ug-10 queue row is reworded to the amended
  contract and marked AUTHORIZED; the Panels lane frontier is now **ug-10 → (after merged landing)
  ug-16 → ug-20**. Option B is chartered as a **planning-only** engine candidate
  ([20261030-overlay-profile-candidate.md](handoff/20261030-overlay-profile-candidate.md)) — no dispatch,
  no protocol/domain/`DataEngine` change authorized; the architect must resolve that footprint
  before any future ruling. Spec header/§1, visual queue, pickup pack, product/08, open-threads and
  open-asks were updated in the same change. Docs-only; no runtime, engine, dependency, telemetry or
  remote change.

- 2026-10-30 (**gf**) — **ug-15 (Shell) CLOSED; drag-and-drop open.** Worker
  `opencode-go/deepseek-v4.1-flash` → independent `openai-codex/gpt-6-luna` xhigh reviewer, one
  request-changes round (idle guard read a passive-effect phase mirror, so a same-task
  click-then-drop could start a second open) → approve. Code `1261bdb` + fix `8a38e0e`: a dropped
  `File` is parked in a one-shot ref and consumed by the same `openDataFile` (same `beginSession`
  guard, post-await token checks, identity resets, phase transitions, ug-14 classified error,
  telemetry) with no picker call; window-level `dragover`/`drop` preventDefault in every phase but
  act only when idle; the phase mirror is synchronous with every transition; idle-only affordance
  plus a readable no-`File` notice. Pins: 6 App-level (including the same-task interleaving) + 2
  e2e (genuine `DataTransfer` with real fixture bytes → `data-phase="ready"`, 5 rows, zero chooser
  events; non-file payload → readable copy, still idle). Merged verification at `8a38e0e` (clean
  worktree; e2e on 4573/4579/4580 because an unrelated preview server held 4173, `CI=1
--retries=0`): **200 unit files / 3127 tests, e2e 188 passed + 1 skipped, coverage
  88.59/82.73/89.83/90.15, docs 117/0, ADR 46, 174 changesets — all gates exit 0**
  (`/tmp/assay-ug15-merged/`). Next runtime rows **ug-17 (Shell)** and **ug-4 (Grid)**; Panels still
  behind the UX-D1 ruling. No push; no engine/protocol/telemetry change.

- 2026-10-30 (**ge**) — **ug-14 (Shell) CLOSED; open-failure recovery + error-copy consolidation.**
  Worker `opencode-go/deepseek-v4.1-flash` → independent `openai-codex/gpt-6-luna` xhigh reviewer,
  two request-changes rounds (cause-mapping honesty; filter rollback copy; end-to-end
  exception-name threading) → approve. Code `5439107` + fixes `edf07a5`, `00f045e`, `c694eca`:
  `open-error` shows a classified one-line cause with the exact `Choose a different file…` retry
  re-entering the guarded open chain, raw engine text only in a collapsed `<details>`, pinned with
  synthetic `fixtures/invalid/corrupt.parquet` (component + real-picker e2e); the shared
  `engineErrorLine`/`engineErrorMessage`/`classifyOpenFailure` helper is adopted by
  open/SQL/profile/filter and the validation/diff call sites (UG-25 “edit” leak gone; DOM file-read
  names threaded through `Phase['error'].errorName`). Merged verification at `c694eca` (clean
  worktree, default ports): **199 unit files / 3121 tests, e2e 186 passed + 1 skipped on two
  consecutive fresh-server runs (`CI=1 --retries=0`), coverage 88.58/82.72/89.81/90.13, docs 117/0,
  ADR 46, 173 changesets — all gates exit 0** (`/tmp/assay-ug14-merged/`). Two earlier e2e attempts
  died with `ERR_CONNECTION_REFUSED` (a reused preview server), recorded rather than dropped. Next
  runtime rows **ug-15 (Shell)** and **ug-4 (Grid)**; Panels still behind the UX-D1 ruling. No
  push; no engine/protocol/telemetry change.

- 2026-10-29 (**gd**) — **docs coherence refinement of the UX/UI pack (no runtime change).**
  Corrected current-state claims without touching implementation or decisions: the spec header now
  separates 2026-10-26 authorship from the 2026-10-29 status; the runtime baseline is **recorded at
  `385649b`** (not a main-tip claim) with docs 116/0 at that revision and the current pack 117/0;
  ug-1/2/3/7/8/9/13 are listed CLOSED with 16 ug rows remaining (15 open + ug-10 blocked);
  **uxv-1** is eligible only with an exclusive CSS/theme-test reservation; uxv-2…5 stay
  dependency-gated and uxv-6 deferred; ownership is ug R-01…R-08/R-14/R-15 and uxv R-09…R-13, with
  R-16 proposed only. Fixed the product format claim (four inputs — Parquet/CSV/JSONL/JSON;
  Arrow is internal transport, Arrow/Feather input unsupported/deferred). Latest verified push is
  `dee10f8`; the uncommitted `README.md`/`docs/assets/`/`.dsh/` are foreign work and **not pushed**.
  Live changesets 172. The UX-D1 brief now cites its own §7 decision block, proposes safer profile
  copy (no validation-freshness promise), and treats domain/`DataEngine` changes as open Option B
  design options, not a mandate. **This entry corrects the previous gc changelog: R-16 is an §8
  index row only — never §2 before a maintainer approval.**
- 2026-10-29 (**gc**) — **docs coherence pass + UX-D1 amendment drafted (pending a maintainer ruling).** The handoff pack now presents one current state for the next thread: spec §8 gained a **proposed
  R-16 index row** — not §2; §2 gains R-16 only if the maintainer approves UX-D1 — plus a living [requirement-status index](../product/09-ux-ui-implementation-spec.md#8-requirement-status-living-index) (R-01…R-08, R-14, R-15 implemented with commit pointers; R-09…R-13 gated; R-16 unauthorized), spec §7 UX-D1 points at the new decision brief, and the usability queue §1/§5 rows for ug-10 and ug-16 carry the blocker and its known corner. New brief: [20261029-ux-d1-amendment.md](handoff/20261029-ux-d1-amendment.md) — verified facts (`profile(handle)` base-only, `query(sql)` carries no overlay, `overlaySchema`/`overlayRowCount`/`exportView`/`validate` already overlay-aware), Options A/B/C with costs, the proposed R-16 copy and acceptance criteria, the exact doc edits that approval would trigger, and a decision block. **No ruling has been made; ug-10 stays blocked and the Panels lane (ug-16 → ug-20) stays closed until the maintainer ticks it.** Next eligible runtime rows remain ug-14 (Shell) and ug-4 (Grid). No runtime, engine, dependency, telemetry, remote or publication change in this entry; push authority unchanged from the 2026-10-28 record.
- 2026-10-29 (**gb**) — **ug-9 (Panels) CLOSED.** R-15 authored (source/validate primaries “Use the open dataset” / “Use the loaded contract” with no picker, “Inspect this contract in Validation”, and the expanded “Dataset Change Request (DCR)” first mention plus purpose sentence) and implemented at `71fa03a` + Critical fix `385649b`. The open flow now retains the opened `File` in App-held `openSourceRef`; the failed-gate cross-link loads the **run-start contract snapshot** (`PipelineRunContractSnapshot` on the `gated` state, frozen before `runPipeline`) and is suppressed when the snapshot lacks the node. The independent reviewer's REQUEST CHANGES — the cross-link resolving the live binding, so a rebind after a failed run loaded the wrong contract — was closed and pinned at component, App and e2e level; mutants fail (4 unit assertions; e2e loads `gate-pass` instead of `gate-strict`). Zero-picker proof via a `filechooser` spy armed before the primaries. Merged verification at `385649b`: format/lint/typecheck(forced)/build/unit/e2e/coverage/docs/ADR all exit 0 — 195f/3089t, e2e 185p+1s, coverage 88.08/82.24/89.08/89.60, docs 116/0, ADR 46, `@assay/web` real build (`/tmp/assay-merged-ug9/`). Two e2e specs the reviewer saw fail once (`engine-overlay` source-immutability, `grid-editing` open timeout) were attributed to host-load flake after ×2 isolated passes and two full green runs — recorded, not silently dropped. Next: **ug-14 (Shell)** / **ug-4 (Grid)**; the rest of Panels (ug-16/ug-20) stays behind ug-10 (UX-D1 maintainer decision).
- 2026-10-29 (**ga**) — **ug-13 (Shell) CLOSED.** R-14 authored in the implementation spec (exact copy for twelve section purpose subtitles, the Record closed-state hint, and the no-rename decision) and implemented at `36cead3` + test-only amendment `793ba90`: subtitles render with the section COLLAPSED and are exposed through `aria-describedby` so the `Expand/Collapse <Title>` accessible names stay stable; the Record hint is pinned across its full lifecycle (before selection → absent while open → back after close → back after epoch shift). Worker `deepseek-v4.1-flash` → independent `gpt-6-luna` reviewer **approve**, then a fresh-session delta review **approve** of the amendment (mutants killed: hidden subtitle, dropped description, unconditional hint, removed close/epoch clear). Merged verification at `793ba90` in a clean isolated worktree: format/lint/typecheck(forced)/build/unit/e2e/coverage/docs/ADR all exit 0 — 194f/3077t, e2e 183p+1s, coverage 88.07/82.15/89.07/89.55, docs 116/0, ADR 46, `@assay/web` build a real cache-miss so the browser evidence covers the new CSS (`/tmp/assay-merged-ug13/`). No DOM reorder (ADR 0044/q-15), no new state/telemetry, value-free copy. Next candidates ug-14 (Shell) / ug-9 (Panels); ug-10 stays UX-D1 blocked. gd-1 and gd's cli-integration budget from `b6fb78a` held for all runs.
- 2026-10-28 (**fz**) — **ug-8 CLOSED; gate determinism fixed (gd-1).** The "merged verification blocked"
  state was a harness-budget defect, not a UI regression: one compiled-CLI spawn costs ≈300 ms, the grouped
  `diff` usage-error test spawns six times (1.75 s solo) against vitest's 5000 ms default at `maxWorkers=16`,
  and `pnpm exec vitest run --maxWorkers=4` was green at `46abebd` (193 files / 3071 tests) while the default
  failed twice (3070/1). Test-only **gd-1** `b6fb78a` adds a dedicated `cli-integration` vitest project
  (commented 20 s budget; `node` project keeps 5000 ms and excludes the glob) plus the same budget for the
  contracts 2500-case round-trip fuzz (4864–5092 ms in-suite). Worker `deepseek-v4.1-flash` → independent
  `gpt-6-luna` reviewer **approve**: collection counts unchanged (193/3071), disjoint projects, mutation to
  5000 ms reproduced the timeout (5805 ms), a non-CLI probe still failed at 5000 ms. Merged verification at
  `b6fb78a`: format/lint/typecheck(forced)/build/unit/e2e/coverage/docs/ADR all exit 0 — 193f/3071t,
  e2e 181p+1s, coverage 88.03/82.12/89.00/89.51, docs 116/0, ADR 46 (`/tmp/assay-merged-48/`, gd-1 evidence
  `/tmp/assay-gd1-worker/`, `/tmp/assay-gd1-evidence/`). No assertion, byte pin, threshold or engine contract
  changed. Residual (recorded, not hidden): the pinned DuckDB 1.5.5 row-diff agreement internal assertion
  still surfaces occasionally — separate engine-side class, tracked in open-asks §5. Next eligible rows
  ug-13 (Shell) / ug-9 (Panels); ug-10 stays UX-D1 blocked. **Pushed 2026-10-28:** `a3f2733..0bd9866`
  (18 commits) with remote SHA equality 0/0; remote CI is still M6-blocked, so the green baseline above
  remains locally verified only.
- 2026-10-28 (**fy**) — ug-8 approved by independent GLM Flash after Luna xhigh implementation;
  code integrated at `cb64c32`, but **merged verification blocked**, not closed. Independent
  reviewer green: 3071 unit / 181 e2e + 1 skip, coverage88.03/82.12/89.00/89.51; copy/count mutants
  fail as intended. Merged full unit runs hit recurring CLI timeout / pinned DuckDB assertion;
  no tests weakened, no further runtime dispatch. Detailed evidence and next unclaimed candidates
  ug-13/ug-9 in usability queue §5; UX-D1 unchanged.

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

- 2026-11-10 (**hg**) — Web-interface follow-up executed under the maintainer's dated scope decision
  ([approval record](handoff/20261110-web-followup-approval.md)): WF-00 preflight green at `76c1945`; WF-02
  pipeline-label honesty merged `b65e304`; WF-01 exact-precision temporal display merged `b6b773d` (an independent
  review proved an integral `ms*1000` is _not_ evidence of recovered precision, so `TIMESTAMP_NS` stays raw);
  read-only WF-01P matrix delivered; WF-05 successor contract verified after four review rounds; ADR 0047 accepted
  for unbounded retained engine tables; WF-10 closed for the selected subset. Every runtime row carries worker +
  independent `openai-codex/gpt-6-luna` (xhigh) review + merged-gate evidence; the doctrine "a row is not done until
  reviewed and merged-green" held. No push. WF-06, WF-03/04/07/08/09 and WF-O1/O2 remain unauthorised or blocked, and
  no participant/AT evidence exists.
