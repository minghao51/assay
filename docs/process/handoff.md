# Project Handoff — Assay

**Last updated:** 2026-10-31. **Current lane:** UX usability + visual continuation. The
[usability queue](handoff/20261026-usability-queue.md) owns the 37 findings (UG-1…UG-37) of the
[usability gap review](../reviews/2026-10-26-usability-gap-review.md) in 23 rows (ug-1…ug-23):
**ug-1/2/3/4/5/6/7/8/9/10/13/14/15/16/17 are CLOSED**, 8 rows are open (none decision-blocked), so 8 rows
remain. Dispatch from the queue, not the review. The
[visual queue](handoff/20261026-ux-ui-execution-queue.md) owns uxv-0…uxv-6: uxv-0 is recorded,
**uxv-1 is eligible only with an exclusive CSS/theme-test reservation**, uxv-2…uxv-5 are
dependency-gated and uxv-6 is deferred. Next runtime rows are **ug-12 (Grid)**, **ug-20
(Panels)** and **ug-21 (Shell)**. Everything waiting on a human, a decision, or a remote operation is consolidated in the
[open-asks checklist](handoff/20261019-open-asks.md) (refreshed 2026-10-29 against this
index). The earlier G0-readiness/recorded-gap batch (gb-1…gb-5, [queue](handoff/20261019-g0-readiness-queue.md))
and repository maintenance are CLOSED; their queues carry the record. This is the current-state
index, not the execution-history archive.

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

**Verified state (2026-10-19):** slice 2 CLOSED with ptv2-8 (exit acceptance) integrated as `bce449f` after an independent reviewer approve (one request-changes round added independently-normalized refusal evidence). Forced typecheck **20**, unit **3027/191**, coverage **87.84/81.97/88.65/89.29** above floors, build **12**, browser **175 + 1 skip**, native **9**, spike **15 pins**, real-VSCode **10/10 scenarios** (full MVP-scenario-11 chain: validate 1/0/1/0 → confirmed-key diff 1/1/1 → report + copy delivery; offline JSON/JSONL opens; six staged-diff installed-CLI legs; acceptance agreement). Closure records: [slice-2 queue](handoff/20261014-ptv-slice2-queue.md) and the [G0-readiness/recorded-gap batch](handoff/20261019-g0-readiness-queue.md). **164 pending changesets at that date (live count 172 on 2026-10-29)**, doc links **107/0** at that date, ADRs **46**.

**Push / remote CI:** user-authorized normal `main` pushes verified at
`3a3a94b`/`ddd72f4`/`1f6cbb9` (remote SHA equality, 0/0 divergence), on
2026-10-28 for the UX batch: `a3f2733..0bd9866` (18 commits: ug-1/ug-2/ug-7/
ug-3/ug-8 + gd-1 + their process records), and most recently at **`dee10f8`**
on 2026-10-29 (the docs pack and UX-D1 draft; remote SHA equality at that revision).
**`ea41533`** (the follow-up docs reconciliation) is **local-only — HEAD is 1 ahead of
`origin/main`, 0 behind** and is not pushed. The current checkout still holds another agent's
uncommitted `README.md`, `docs/assets/` and `.dsh/` work; those edits are **not
pushed**, and no agent may claim otherwise. CI
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
- Worker roster: **current user-requested roster (2026-10-29)** — implementer
  **`opencode-go/deepseek-v4.1-flash`**, independent reviewer
  **`openai-codex/gpt-6-luna` at thinking high**; the same model never both implements and
  reviews. The earlier maintainer preference (2026-10-17: `zai/glm-5.3-flash` first, Luna
  reviewer; Luna implements with parent review when the GLM lane 429s) is historical.
  Serialized dispatches; briefs/logs in `/tmp`. Push authorization is episode-specific: the
  latest verified push is `dee10f8`; `ea41533` is local-only (1 ahead / 0 behind).
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

[Usability queue](handoff/20261026-usability-queue.md): **active** —
23 rows (ug-1…ug-23; **11 CLOSED: ug-1/2/3/7/8/9/10/13/14/15/16**, 12 open, none decision-blocked — 12
remaining) across three lanes (Shell / Grid / Panels) owning the
[usability gap review](../reviews/2026-10-26-usability-gap-review.md) findings UG-1…UG-37
(first-run contract, affordance visibility, failure containment, journey coherence). Read
the queue's §2 lane rules, §3 standing constraints and §5 execution clarifications before
claiming. **UX/UI pickup pack (2026-10-26, docs only):**
[implementation spec](../product/09-ux-ui-implementation-spec.md),
[visual execution queue](handoff/20261026-ux-ui-execution-queue.md) and
[next-agent prompts](handoff/20261026-ux-ui-pickup-prompts.md#1-orchestrator--paste-into-the-next-session).
Baseline **recorded 2026-10-26 at `7d8e1ca`** (clean tree; six gates, coverage, docs/ADR checks
green: 3029 unit / 175 e2e passed). **ug-1 integrated at `e92c0dd`, ug-2 at `8e5fd62`, ug-7 at
`9c29da4`** after independent review (ug-7 needed a test-only amendment for the new-dataset
recovery-reset pin); merged gates 193 unit files / 3056 tests, e2e 180 passed + 1 skipped,
coverage 87.98/82.08/88.89/89.46 at that historical checkpoint. **ug-7 evidence follow-up** landed
at `8367fbd`; **ug-3** at `5253c06`. **ug-8** is **CLOSED 2026-10-28** — code `cb64c32` was independently approved, and its merged gate was unblocked by test-only **gd-1** `b6fb78a` (dedicated `cli-integration` vitest project budget + contracts fuzz budget; the failure was a 5000 ms harness ceiling against six compiled-CLI spawns, proven by `--maxWorkers=4` green and a 5000 ms mutation drill). **Runtime baseline recorded at `385649b`** (not the current main tip — later docs-only commits follow; clean isolated worktree, free ports 4573/4579/4580): **195 unit files / 3089 tests, e2e 185 passed + 1 skipped, coverage 88.08/82.24/89.08/89.60, docs links 116/0 at that revision (current docs pack 117/0), ADR 46, 172 changesets — all gates exit 0** (`/tmp/assay-merged-48/`, `/tmp/assay-merged-ug13/`, `/tmp/assay-merged-ug9/`). **ug-13 (Shell) CLOSED 2026-10-29** at `36cead3` + test-only amendment `793ba90` after two independent reviews (R-14 purpose subtitles on all twelve collapsed section headers, Record dock closed-state hint with a pinned lifecycle, no Record rename). **ug-9 (Panels) CLOSED 2026-10-29** at `71fa03a` + Critical fix `385649b`: R-15 pipeline binding continues the journey (source/validate primaries bind from App-held state with a zero-picker-call proof; the failed-gate cross-link loads the run-start contract snapshot — the reviewer's live-binding rebind defect closed and pinned; first DCR mention expands with a purpose sentence). **ug-14 (Shell) CLOSED 2026-10-30** at `c694eca` (worker `deepseek-v4.1-flash` → independent `gpt-6-luna` xhigh reviewer, two request-changes rounds → approve; code `5439107` + fixes `edf07a5`, `00f045e`, `c694eca`): `open-error` shows a classified one-line cause with the exact `Choose a different file…` retry re-entering the guarded open chain, raw detail only in a collapsed `<details>` (synthetic corrupt fixture, component + real-picker e2e); the shared `engineErrorLine`/`engineErrorMessage`/`classifyOpenFailure` helper is adopted by open/SQL/profile/filter and the validation/diff call sites (UG-25 “edit” leak gone; DOM file-read names threaded through `Phase['error'].errorName`). Merged verification at `c694eca` (clean worktree, default ports): **199 unit files / 3121 tests, e2e 186 passed + 1 skipped on two consecutive fresh-server runs (`CI=1 --retries=0`), coverage 88.58/82.72/89.81/90.13, docs 117/0, ADR 46, 173 changesets — all gates exit 0** (`/tmp/assay-ug14-merged/`). **ug-15 (Shell) CLOSED 2026-10-30** at `8a38e0e` (worker `deepseek-v4.1-flash` → independent `gpt-6-luna` xhigh reviewer, one request-changes round → approve; code `1261bdb` + fix `8a38e0e`): a dropped `File` is consumed by the same `openDataFile` chain (same generation guard, token checks, identity resets, phase transitions, ug-14 classified error, telemetry) with no picker call; window `dragover`/`drop` preventDefault in every phase but act only on idle, with a synchronous phase mirror closing the reviewer’s same-task click-then-drop race; idle-only `Or drop a data file anywhere on this page` affordance plus a readable no-`File` notice. Merged verification at `8a38e0e` (clean worktree; the merged e2e ran on the documented alternate ports 4573/4579/4580 because an unrelated local preview server held 4173, `CI=1 --retries=0`): **200 unit files / 3127 tests, e2e 188 passed + 1 skipped, coverage 88.59/82.73/89.83/90.15, docs 117/0, ADR 46, 174 changesets — all gates exit 0** (`/tmp/assay-ug15-merged/`). **UX-D1 RESOLVED 2026-10-30 — Option C.** ug-10 is **authorized** with the amended R-16 honest-labeling contract (spec §2: byte-exact base-as-opened hint + staged-changes note; no stale/re-run banner, no auto-recompute, engine untouched); the overlay-aware profile is chartered as a separate **planning-only** engine candidate ([20261030-overlay-profile-candidate.md](handoff/20261030-overlay-profile-candidate.md)) and is not authorized for dispatch. **ug-10 (Panels) CLOSED 2026-10-30** at `f667a87` (worker `deepseek-v4.1-flash` → independent `gpt-6-luna` xhigh reviewer, approved on the first review): R-16 shipped byte-exact — base-as-opened standing hint in every expanded state, singular/plural staged-changes note at N≥1 (absent at 0 and after undo), no stale/re-run banner, no auto-recompute, `profile(handle)`/engine untouched. Merged verification at `f667a87` (clean worktree; e2e on 4573/4579/4580, `CI=1 --retries=0`): **202 unit files / 3142 tests, e2e 189 passed + 1 skipped, coverage 88.60/82.74/89.83/90.15, docs 118/0, ADR 46, 175 changesets — all gates exit 0** (`/tmp/assay-ug10-merged/`). **ug-16 (Panels) CLOSED 2026-10-31** at `3b494f5` (worker `deepseek-v4.1-flash` → independent `gpt-6-luna` xhigh reviewer, **request-changes** on two async-lifecycle Majors → fix commit → fresh-session re-review **approve**; worker `9c5310b` + fix `472be2a`, integrated as `30063f4` + `3b494f5`): profile top-k values and null counts are real buttons — a click is planned against the active ops + effective schema first (`planProfileFilter` → `resolveProfileColumn`), a resolved column compiles through the existing builder against the **effective** type and applies via `replaceColumnFilter`/`setFilters` (chips from the existing FilterBar), a renamed column applies no filter and shows the byte-exact refusal naming base+current, an unresolved column shows the byte-exact generic refusal, cast/type mismatch shows the builder's readable rejection with no coercion, and zero-row results keep the existing empty state. Round 2 closed the reviewer's two Majors: a FilterBar-style synchronous single-flight gate + disabled filter controls (no failure rollback can overwrite a later action), and attempt/model/dataset identity checks after every `await` (late rejections after undo or a new dataset are silent no-ops). R-16 copy, `profile-table-id`, `profile(handle)`/engine untouched; no re-profile, no telemetry. Merged verification at `3b494f5` (clean worktree, default ports, `CI=1 --retries=0`): **205 unit files / 3183 tests, e2e 192 passed + 1 skipped, coverage 88.72/82.77/90.39/90.31, docs 119/0, ADR 46, 176 changesets — all gates exit 0** (`/tmp/assay-ux-ug16-merged/`). **ug-17 (Shell) CLOSED 2026-10-31** at `9a31cd6` (worker `deepseek-v4.1-flash` → independent `gpt-6-luna` xhigh reviewer, **approved on the first review**): managed section toggles carry optional, value-free session summaries visible while collapsed — `Validation · N failing` (current verdict’s failing **rule** count), `Compare · N changed` (current row-diff `changed.count`) and `History · N pending` (`activeOps(history).length`), each only at N>0 and only in verdict/result states; the summary sits in the toggle’s text column above the `hidden` body, the accessible name stays `Expand/Collapse <Title>`, `aria-describedby` gains the summary id only when present (purpose first), and inner-disclosure sections keep their own idioms. One scoped `workbench-section-summary` block; the twelve R-14 purpose/name pins and heading pins unchanged and green; no DOM reorder; no engine/grid change; no telemetry. Merged verification at `9a31cd6` (clean worktree, default ports, `CI=1 --retries=0`): **206 unit files / 3190 tests, e2e 193 passed + 1 skipped, coverage 88.84/83.41/90.68/90.44, docs 119/0, ADR 46, 177 changesets — all gates exit 0** (`/tmp/assay-ux-ug17-merged/`). **ug-4 (Grid) CLOSED 2026-10-31** at `784805c` (worker `deepseek-v4.1-flash` → independent `gpt-6-luna` xhigh reviewer, **request-changes** on one Major (the interaction copy claimed edit/inspect/navigate capabilities in the read-only pipeline preview) → fix commit → fresh-session **approve**; integrated `178ffa5` + `784805c`): a persistent one-line hint — byte-exact `Double-click a cell to edit · Enter edits the focused cell · Esc cancels` — renders on editable ready grids, outside the role=grid subtree, with a per-instance `useId` id as the grid’s `aria-describedby`; the footer gained a native Keyboard `<details>` (Edit / Inspect / Navigate) with only the verified shortcuts. Every claim is capability-derived (`editingEnabled` / `onOpenRecord` / `interactive`), so the read-only pipeline preview renders no hint, no disclosure and no description; Diagnostics untouched, no new key handlers, no DOM reorder, no telemetry. Pins: `DataGrid.interaction-hints.test.tsx` 11 (editable / inspect-only / preview-shaped read-only + rerender flips) plus one e2e first-ready leg; mutations killed: unconditional hint, Edit group without editing, dropped describedby, dropped hint id, altered copy, deleted key row. Merged verification at `784805c` (clean worktree, default ports, `CI=1 --retries=0`): **207 unit files / 3201 tests, e2e 194 passed + 1 skipped, coverage 88.84/83.45/90.68/90.44, docs 119/0, ADR 46, 178 changesets — all gates exit 0** (`/tmp/assay-ux-ug4-merged/`). **ug-5 (Grid) CLOSED 2026-10-31** at `d814fdf` (worker `deepseek-v4.1-flash` → independent `gpt-6-luna` xhigh reviewer, **approved on the first review**): Ctrl/Cmd+C on a focused non-editing grid cell copies the display value composed with the same `formatCell` the cell renders with, announcing exactly `Value copied.` through the existing single polite live region; empty cells copy nothing (`Nothing to copy — this cell is empty.`) and a missing/rejected clipboard announces `Copy failed — the clipboard is unavailable.`; the handler is cell-scoped, never intercepts while an editor is open or on input/select/textarea/contenteditable, and copy mutates nothing. No telemetry/logging of values (ADR 0025). Pins: `copy-cell.test.ts` 11, `DataGrid.copy.test.tsx` 8, one real-Chromium clipboard e2e; mutations killed: dropped editor guard, `String(raw)`, dropped write/preventDefault. Merged verification at `d814fdf` (clean worktree, default ports, `CI=1 --retries=0`): **209 unit files / 3220 tests, e2e 195 passed + 1 skipped, coverage 88.88/83.53/90.73/90.48, docs 119/0, ADR 46, 179 changesets — all gates exit 0** (`/tmp/assay-ux-ug5-merged/`). **ug-6 (Shell) CLOSED 2026-10-31** at `b2c6ce1` (worker `deepseek-v4.1-flash` → independent `gpt-6-luna` xhigh reviewer, **approved on the first review**): one document-level keydown listener maps Ctrl/Cmd+Z to undo and Ctrl/Cmd+Shift+Z / Ctrl/Cmd+Y to redo through the existing handlers (ready only, one listener, cleaned up, preventDefault only when handled), never hijacking native text undo in editable targets including nested contenteditable hosts (pure `lib/history-shortcut.ts` classifier). The History section auto-expands on the first appended op only, never on undo/redo or dataset open, and never re-opens after a collapse; ug-17’s `History · N pending` summary is untouched. The single visible Undo/Redo pair is preserved (ux-3); no telemetry, no engine/overlay change. Pins: helper 11 + App 6 + one real-Chromium e2e; mutations killed: dropped editable guard, cue on every append, swapped undo/redo. Merged verification at `b2c6ce1` (clean worktree, default ports, `CI=1 --retries=0`): **211 unit files / 3237 tests, e2e 196 passed + 1 skipped, coverage 88.92/83.57/90.76/90.50, docs 119/0, ADR 46, 180 changesets — all gates exit 0** (`/tmp/assay-ux-ug6-merged/`); one known engine-side `row-diff-agreement` coverage flake passed on immediate rerun (no threshold weakened). Next Grid row **ug-12**. Next lane candidates **ug-12 (Grid)**, **ug-20 (Panels)** and **ug-21 (Shell)**; SQL sizing remains deferred design-only. Other agent's uncommitted files (README, `docs/assets/`, `.dsh/`) are preserved; verification runs use a clean isolated worktree at the exact base revision. **Ownership:** the usability queue owns R-01…R-08, R-14, R-15 and R-16; the visual queue owns R-09…R-13. The visual queue does not replace ug ownership.

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
