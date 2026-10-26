# UX/UI Pickup Prompts — copy/paste pack

**Authored 2026-10-26.** These are dispatch templates, not claims or completion records. Re-read
live queues and the current tree every time; a prompt does not override a closed/claimed/blocked
row. The planning session changed documentation only. No clean-main baseline or runtime
implementation was completed. Prompts do not authorize publication, remote changes or discarding
work. Runtime rows require the existing worker → independent reviewer → orchestrator protocol.

## 1. Next AI: orchestrator (start here)

Paste this entire block into the next agent's session:

```text
You are the Assay UX/UI orchestrator. Pick up the execution pack; do not restart the investigation
or implement a broad redesign. The goal is a polished, understandable local-first workbench
that demonstrates its real engine strengths through visible results and a coherent workflow.

Read first, in order:
1. AGENTS.md and docs/process/handoff.md, especially §§4–6.
2. docs/process/handoff/operating-model.md, fully.
3. docs/process/handoff/20261026-usability-queue.md.
4. docs/product/08-ux-ui-engine-showcase-plan.md.
5. docs/product/09-ux-ui-implementation-spec.md, fully, including STOPs and exact gates.
6. docs/process/handoff/20261026-ux-ui-execution-queue.md and this pickup-prompts file.
7. docs/product/03-execution-roadmap.md, docs/adr/README.md, ADR0044, and task-relevant ADRs.
Review the four linked SVG reference frames; they are design targets, not runtime screenshots
or permission to add features owned by another row.

Establish current truth: branch, commit, git status, existing task owners, available toolchain.
The last planning session left a documentation pack; it ran docs checks, not the six-gate baseline.
Do not assume those files are committed in your checkout. Preserve all existing work. Integrate
only reviewed/authorized docs through normal commit discipline before a clean-main baseline;
if ownership/commit authority is unclear, ask. Never reset/stash/delete unknown work to fake clean.

Before any runtime claim, complete uxv-0: clean main, six core gates plus coverage/docs/ADR
checks from spec §6. Record command exit codes/counts/log paths and the exact starting revision.
If a gate fails, STOP runtime dispatch, record the blocker and reproduce it; do not weaken tests.
Historical green, remote CI status, dev screenshots and mockups are not current gate evidence.

Then dispatch exactly ug-1 first. Apply spec R-01/R-02 and §3: LIST Explode vs STRUCT Flatten,
collapsed-default tests, rail expansion, proper result/error/empty focus and scrollability.
After independent approval and merged verification, dispatch ug-2 and ug-7 in isolated worktrees
as parallel tasks; serialize provider sessions where the standing operating model requires it.
Use the task-specific templates below. ug-7 includes replay-safe SQL request acknowledgment and
recoverable Close for inner-disclosure sections; do not omit those requirements to keep a diff tiny.

Keep one worker per bounded row; reserve shared App/CSS/test files; use separate e2e ports.
ug-2 and ug-7 share App.tsx: worktrees do not remove integration risks. Inspect/re-run merged
behavior. Same-lane tasks serialize. Continue ug-3/ug-8 only after their lane predecessors land.
New visual work follows the uxv queue, not an improvised styling batch.

The research used GPT Luna xhigh. For additional read-only investigation, use
openai-codex/gpt-6-luna with thinking xhigh when available. Runtime implementer/reviewer roster
remains handoff §4 / operating-model §7.6: GLM-first, Luna reviewer; documented fallback only.
No implementing session may approve its own change; honor the model-separation constraint too.
If an independent eligible reviewer is unavailable, stop at review rather than self-approve.

Do not implement ug-10 until UX-D1 has a recorded brief amendment. Re-running base profiling
cannot show staged-edit statistics. uxv-6 SQL sizing is design-only/deferred, not a code task.
No DOM reorder, engine/grid API changes, new telemetry/dependencies, real collectors, new input
formats, export/report byte changes, AI/hosted work or publication. Do not infer current push
authority from an old handoff episode; workers never push.

Write briefs/logs under /tmp. Workers own runtime changes; orchestrator owns shared documentation.
Fresh independent reviewer must run required gates, inspect requirements over implementation,
perform meaningful mutations and restore/rebuild. A request-changes verdict returns to a fresh
worker brief quoting exact required fixes. Integrate only approved rows, run merged gates, and
update the owning queue immediately with evidence and carry-overs. Do not mark the whole UX
program complete because the first three tasks or visual references are done.

First response: report current checkout/queue state, baseline prerequisites, selected ug-1 scope,
and blockers. At each handoff report: integrated commits, checks, unresolved decisions, current
owner/status and the single next eligible dispatch. Do not claim checks you did not run.
```

## 2. First worker: ug-1

The orchestrator supplies base commit, worktree, reserved files, ports and log directory before
using this template. A worker must not invent missing baseline evidence.

```text
Implement exactly ug-1: nested one-click actions reveal their SQL outcome.
Read AGENTS.md, current handoff/operating-model, the live ug queue, and product/09 spec §§1–3,6–7.
Confirm orchestrator-provided clean-main baseline evidence and your assigned base/worktree/ports.

Requirements: R-01/R-02. Use existing shell section/pane state; do not change engine/query/grid
contracts. A successful nested request opens SQL and a collapsed tool rail, scrolls the relevant
container and focuses the matching result/status after render. Populated, empty and execution-
error outcomes all need reachable targets. Composition rejection uses its existing alert and
must not open SQL. Leave the main grid unchanged. No unrelated rerender focus stealing.

Allowed: apps/web/src/App.tsx, sql/SqlPanel.tsx and their focused tests; tests/e2e/nested-journey.spec.ts;
shared tests/e2e/support/fixtures.ts only if essential. Add the required changeset. No docs/root
config, DataGrid or engine changes. Report any broader need as STOP before extending scope.

Tests must start with expandSections:false. Cover schema and header origins plus a header
activation when the tool pane is a rail. The fixture tags LIST Explode yields 20 rows and page
range rows 1–20; meta STRUCT Flatten yields 12. Assert visible composed statement, matching
outcome focus, relevant scrollability and unchanged main-grid identity; don't click SQL nav to
make the test pass. Include failure/empty outcomes, desktop and 900px fallback. Existing helper
expands all sections by default and otherwise masks the bug. Do not add a total-count query.

Run all gates/additional checks from spec §6 and focused nested/keyboard tests; build before
browser tests. Record exact commands/exit codes and counts, not just “green”. Leave one bounded
Conventional Commit fix(web): ... and changeset; no push or queue approval. Report commit,
files, requirements, test evidence, screenshot paths and any blockers. Reviewer is independent.
```

## 3. Next Shell worker: ug-2

```text
Implement exactly ug-2 after integrated/reverified ug-1. Read AGENTS.md, current handoff,
operating-model, live ug queue and product/09 spec R-03/R-04 plus §§1,6–7.
Use orchestrator-assigned base/worktree/Shell ports/reserved files and confirmed baseline.

Replace idle maintainer copy with exact capability/format text from R-03, close to the existing
Open control. Welcome copy is idle-only; preserve Opening…, errors, completion announcements
and focus. Remove visible roadmap/milestone/docs-path content. Do not add example data yet
(ug-3 owns it), engine explanation (uxv-4), a new layout, drag/drop, or progress/cancel.

Add matching four-extension picker hints for FSA and hidden input. Preserve a standards-valid
All files choice (excludeAcceptAllOption:false/default), cancellation and single-file behavior.
No invalid wildcard FSA MIME key or pretend file validation. Engine remains authoritative.

Allowed: apps/web/src/App.tsx, lib/app.ts, related copy/open/shell tests;
packages/data-sources/src/pick-file.ts and its tests/necessary picker option types;
tests/e2e/support/fixtures.ts before open-flow copy-pin migrations; affected open e2e tests;
changeset. No engine/client protocol, unrelated package or shared documentation edits.
Coordinate App.tsx integration with the Panels ug-7 worker; never edit their worktree.

Pin exact rendered idle copy, absence of internal tokens, both picker paths/options, cancel,
opening/error behavior and the real open-to-ready path. Run six gates + coverage/docs/ADR
checks and focused tests from spec §6. Build before e2e. One fix(web): ... commit with a
changeset including the changed data-sources package. Report evidence and STOPs; no push,
self-approval or silent scope expansion.
```

## 4. Panels worker: ug-7

```text
Implement exactly ug-7 after integrated ug-1, eligible alongside ug-2 in an isolated worktree.
Read AGENTS.md, current handoff/operating-model, live ug queue and product/09 spec R-06/R-07,
§3 recovery seam/copy/request lifetime, §6 gates and §7 STOPs. Confirm assigned baseline,
base commit, Panels ports and file reservations before editing.

Allowed: apps/web/src/ErrorBoundary.tsx, App.tsx, sql/SqlPanel.tsx for web-local SQL acknowledgment,
focused ErrorBoundary/App/shell/SQL tests and changeset. No engine/grid protocols, DataGrid
refactor, session-hook relocation, root config or docs. Other panels must not be rewritten.

Wrap each listed tool section body in panel scope; retain root/grid boundaries. Retry remounts
only the failed child, preserving App-owned dataset and committed staged history. Grid draft,
focus/scroll and panel-local state may reset; exact static copy from §3 states the trade-off.
Grid primary Try again; separate Reload warns of session loss before clicking. Panel Try again
and Close section must be keyboard reachable; use existing shell state plus recovery-only
visibility override/nav reopen for inner disclosures. Reopen shows retained fallback, not an
implicit retry. Preserve mounted-body behavior and normal disclosure/heading contracts.

Prevent SQL replay: claim a nested request sequence synchronously in session-scoped App state
before issuing it, so remount/StrictMode cannot reissue a consumed request. Do not drop a newer
sequence when acknowledging an older one. Manual Run remains an explicit user action. Test
engine query call counts across remount and new sequences and reject stale-session requests.

Test a mounted-panel render throw with nonzero staged edits: grid, summary and History survive;
retry recovery and persistent failure are honest; managed and inner close/reopen focus works;
static fallback never interpolates thrown values. Reset/wrapper removal mutants must fail the
pins and be restored. No beginSession/reopen/reload on retry. Error boundaries don't solve
async/event errors. STOP for wider ownership or engine requirements; do not omit a requirement.

Run six gates + coverage/docs/ADR and focused tests from spec §6. Record evidence, one bounded
fix(web): ... commit and changeset. No push or self-approval. Parent coordinates App overlap.
```

## 5. Visual worker: one eligible uxv row

```text
Implement only the orchestrator-assigned uxv-N row from the live UX/UI execution queue.
Do not start if row/dependencies/files/ports/baseline are missing or the row is design-only.
Read AGENTS.md, handoff/operating-model, both live queues, product/09 spec, row requirement IDs,
all STOPs, and the reference SVGs. Queue owns status; spec owns copy/geometry/acceptance.

Copy the row's exact allowed paths, requirements, dependencies and done-when into your /tmp
brief before editing. No shared documentation/root config edits unless the orchestrator explicitly
assigns a docs-only deliverable. No token inventory growing into a whole-component rewrite.
Mockups include features owned by ug rows: do not implement those as styling riders.

Apply the spec's exact focused checks in addition to full gates/coverage/docs/ADR checks. For
uxv-1 use the isolated configured disclosure test and restore a stock build before stock gates;
never send to a real collector or alter consent logic. For uxv-2 scope styles to named controls,
not every button. For uxv-3 preserve 28px virtualizer geometry and test measured viewport widths,
footer/focus/scroll and memo identity. For uxv-4 all explanation is static, idle-only and value-free.
uxv-5 supplies a /tmp rehearsal draft/evidence to the orchestrator, not runtime edits. uxv-6 is
not a code task and cannot be used to relocate SQL or resize panes without an approved amendment.

Report one bounded commit/changeset where applicable, requirement-by-requirement results,
commands/exit codes/counts, screenshot matrix, known gaps and STOPs. Do not approve your change,
push, weaken tests, broaden the row, or claim remote CI/publication approval.
```

## 6. Independent reviewer (runtime rows)

```text
Independently review assigned ROW and worker COMMIT against its live queue done-when and
product/09 requirement IDs, not against the worker's chosen implementation. Read AGENTS.md,
operating-model §7.3/7.6, both queues, spec and worker brief/report. Verify that you are a distinct
eligible reviewer session/model and your assigned worktree/ports match the reviewed commit.

Run git show/diff and scope checks. Run six core gates plus coverage/docs/ADR checks yourself,
and affected focused tests. Rebuild before browser evidence. Verify counts, new test assertions,
no vacuous mocks, same input/view for agreement claims, and screenshot light/dark/viewport/state
coverage. No new axe allowlist, changed coverage thresholds or unexplained skipped scenarios.
No source/engine/DOM direction changes, dynamic error text, telemetry leakage, extra Undo/Redo,
changed output bytes or format overclaims. Check Conventional Commit and changeset scope.

ug-1: default-collapsed SQL, both origins, rail reveal, correct sequence focus and keyboard-scroll,
empty/error outcomes. A nav click or expand-all helper before the action invalidates the proof.
ug-2: exact idle copy, no internal tokens, correct FSA/input hints and All files/cancel behavior.
ug-7: staged state survives a true mounted-panel crash/retry; inner Close has a keyboard reopen
path; no consumed SQL replay; no session restart. Query-call counts must catch remount replay.
Visual rows: verify each deterministic style/geometry/copy claim and actual rendered contrast.

Perform temporary mutations for load-bearing requirements: e.g. remove reveal/reset/wrapper,
restore white surface or 72rem cap, remove adopted token or engine explanation. The appropriate
test must fail. Revert only your mutants and rebuild restored source before final verification;
never destroy pre-existing work, commit fixes or leave source dirty. Report failures to author;
do not implement and approve the fix yourself. Keep a distinct role/model if fallback was used.

Return: files reviewed; numbered must-fix findings with file:line evidence; exact executed checks
and mutation failures/restoration; remaining risks; final line exactly VERDICT: approve or
VERDICT: request-changes. Approval means this row only, not the entire program or a release.
```

## 7. Reviewer: docs-only showcase deliverable

```text
Review uxv-5's rehearsal document/evidence independently. Require exactly two chapters, with CLI
continuity inside Chapter 2. M5/M6 inputs are generated in temporary directories: validate cited
generator/function source paths and reproducible commands, not invented committed fixture paths.
Keep the M6 pair distinct from the repaired M5 export unless separately proven. Validate every
capability/format/privacy and web/CLI claim against current source and exact journeys; inspect required built
rehearsals, observed counts and command evidence. Confirm no new real dataset, benchmark promise,
publication, collector or runtime change was bundled. Check docs links/format, requirement R-13,
current commit references and unresolved gaps. No new six-gate baseline claim from docs alone.
Return specific corrections or VERDICT: approve for this bounded docs deliverable only.
```

## 8. Request-changes and interrupted-session continuation

```text
Continue assigned ROW only. Re-read live status; original brief is ORIGINAL_BRIEF_PATH; independent
review required these exact fixes: PASTE_NUMBERED_ITEMS. Existing work/commits are LIST_AND_SHA.
Do not discard/adopt artifacts blindly. Independently verify them, fix only requested items within
the original boundary, and re-run required gates/focused checks. STOP if scope must grow. Report
changed commit and item-by-item evidence to a fresh independent reviewer. No self-approval,
publication, push, unrecorded skip or queue closure. If interrupted, preserve artifacts and state
precisely what is committed, uncommitted, verified and still blocked.
```
