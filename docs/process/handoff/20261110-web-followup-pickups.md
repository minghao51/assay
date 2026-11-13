# Web follow-up — next-agent pickup briefs (2026-11-10)

**Planning only. Do not dispatch from this file until the living [map](20261110-web-followup-map.md) marks the chosen row READY.** The previous conversational “P0 bundle” is superseded by the [audited corrections](../../reviews/2026-11-10-web-svg-followup-audit.md). No runtime implementation, study, architectural change or remote operation was authorized by asking for this handoff.

**Consumed (2026-11-10):** the [approval record](20261110-web-followup-approval.md) authorised WF-02, WF-01P and
WF-05-design, and all three have since been executed — WF-02 merged `b65e304`, WF-01P's matrix delivered
([reviews/2026-11-10-wf01p-temporal-matrix.md](../../reviews/2026-11-10-wf01p-temporal-matrix.md)), WF-05's contract
verified ([v5](20261110-wf05-replacement-contract.md)); WF-01 followed once WFD-06 was settled as option B and merged
`b6b773d`. **The briefs below are therefore history, not a dispatch queue.** Reusable material: the WF-02 envelope and
copy table, the WF-01P read-only method, and the WF-05 question table. WF-06 still has no brief by design — it needs an
explicit runtime authorization and its own reservation, and WF-03/WF-04/WF-07 still need their WFD decisions.

**WF-06 continuation (2026-11-13):** the missing runtime selection, reservation and concrete brief now live
in the [first-wave pickup](20261113-essential-workbench-pickup.md) and
[specification](../../product/16-essential-workbench-first-wave-spec.md). Use those for WF-06; the
“no generic brief provided” and authorization-pending text below remains dated history, not its current
status. No other old WF row is selected by this continuation.

## 1. Orchestrator pickup (first session)

```text
You are the next Assay orchestrator. Current planning baseline is 7fa1e78;
verify actual HEAD and local changes before claiming work. Read AGENTS.md,
docs/process/handoff.md and operating-model.md, then:
- docs/reviews/2026-11-10-web-svg-followup-audit.md
- docs/product/14-web-interface-followup-spec.md
- docs/process/handoff/20261110-web-followup-map.md

Goal: execute only the maintainer-selected follow-up rows, not every SVG idea.
Closed rd slices stay closed. Conservative sv-* was a fallback, not a second
queue to execute. WFD recommendations and proposed strings are unapproved.
If there is no explicit selection, return the decision request and STOP.

Confirm approval names rows, changed copy, task semantics (navigation by
current default), temporal display scope, and any reopened prior deferral.
Then run WF-00 on a clean committed checkout: exact HEAD/tool versions,
full gates, file ownership, dependencies and ports. Never claim a historical
237-file/3531-test result as the current baseline. Log all failures.

Dispatch one web writer at a time. Preferred writer deepseek-v4.1-flash;
independent GPT-6 Luna reviewer, explicit xhigh. New sessions for new tasks,
isolated worktrees. Stop/request an allowed fallback if model unavailable.
Worker never approves itself. Shared docs/configs belong to the orchestrator.

Each brief must supply one READY row, concrete source paths/seams and exact
approved policy/copy, forbidden boundaries, acceptance cases, clean baseline
SHA, worker branch/worktree, free stock/configured/restored port sets, log
path, gates, negative control, report format and stop conditions. Do not send
"research then fix based on findings". Research that changes scope returns
before implementation. Check actual diff and evidence before integration.

Review -> request-changes fix -> independent re-review -> integration ->
fresh merged gates at committed revision -> close that row immediately.
No push, release, visibility/dependency/lockfile change, ADR rewrite, new
telemetry, report/DCR/export bytes change or threshold/allowlist weakening.
If WF-06 needs a session/engine seam not reserved by its approved successor
contract, stop and split; if WF-09 conflicts with ADR0044, require a new
accepted superseding ADR before any runtime work. Do not reopen deferred
SQL sizing/overlay profiling merely because a layout study mentions them.
```

## 2. Runtime-worker envelope (orchestrator must fill every field)

A blank field is a blocker, not worker discretion.

```text
ROLE: implement exactly ROW [id], selected requirements [T-WFxx].
Approval record/date: [path + section + approved selection/copy].
Baseline SHA: [clean committed SHA]; worktree/branch: [path/name].
Read first: AGENTS, handoff, operating model, audit, spec §[task], map row,
relevant accepted ADRs and approved copy/transition table.

Actual source seam and intended change: [paths/symbols + concrete description].
Reservation: [source/tests/fixtures/changeset exact paths].
Forbidden: packages/** and unreserved sessions/**; engine/protocol/report/
export/DCR bytes; task-purpose/Help copy; telemetry semantics; root config,
lockfile, dependencies, ADRs; other rows. List explicit exceptions, if any.
If a new dependency is needed, stop; don't silently add a file to the scope.

Acceptance: [all positive/negative/lifetime/safety cases from chosen T-WF].
Focused tests: [actual existing paths + new additive tests].
Mutation target: [specific branch/behavior and intended failing assertion].
Fixtures: [synthetic shape + generation/checksum procedure, or not needed].
Changeset: [@assay/web patch/minor rationale].

Full gates per product/14 §6.1, not only focused tests; configured+restored
legs §6.2 for App/header/CSS/modal/build-config changes. Config or test edits
ALWAYS require pnpm test (source-text pins). No retries, skips, force clicks,
threshold/timeout/allowlist changes. Restore mutations byte-identically,
rebuild, prove tree equals candidate commit. Missing tools/red baseline stop.
Stock ports: [web/engine/ds]; configured: [triple]; restored: [triple].
DUCKDB: [verified path/version]; logs: [absolute path]. No real collector/token.

Return: exact revision and diff, approved copy as rendered, every gate exit/
count (incl failed runs), focused proofs/mutation restoration, fixture digests,
byte/engine/telemetry invariants, approved deviations and residuals. Do not
edit shared closure docs or push. Follow orchestrator's explicit commit policy;
reviewer must receive a reproducible clean candidate, never an ambiguous dirty
tree or code mixed with user work.
```

## 3. Task-specific inserts

These are technical briefs, not dispatch authority; append the filled envelope above.

### WF-01P: read-only temporal matrix (separate authorization)

```text
You are commissioned ONLY for WF-01P after WF-00. No prior matrix approval is
needed: producing that matrix is your deliverable. Read source and observe the
existing real engine APIs with temporary synthetic /tmp probes, recording
DuckDB/Arrow/JS types, units, delivered precision, base/overlay behavior,
declared-type availability per consumer, proposed UTC scope-A policy/fallback
and limitations. Do not edit formatter/editor/source/tests/committed fixtures.
Write the scoped report/design artifact only and record exact probe commands.
Return the matrix for explicit WFD-06 approval and STOP. This assignment does
not authorize WF-01 implementation; a separate writer gets that approved
matrix and a new concrete runtime reservation.
```

### WF-01: scalar temporal presentation (only after returned matrix approval)

```text
The grid formatter treats numeric typed DATE/TIMESTAMP/TIME as generic values;
editor temporalDraft already understands delivered ms vs microseconds. Read the
completed WF-01P matrix and its explicit WFD-06 approval before any edit. If
either is absent, STOP; do not create and self-approve a matrix in this runtime
assignment. Verify observed transport still matches the approved matrix; any
mismatch returns for approval before implementation continues. No blanket Date
conversion of numeric or string cells.

For recommended scope A, implement scalar grid display + focused display-copy
only. Keep copy exactly equal to visible text. Reuse/extract temporal helper
only with unchanged editor seeds/validation. DATE UTC calendar; TIMESTAMP
UTC projection with declared-type interpretation/precision limit; TIME
microseconds-since-midnight. NULL/unknown/invalid/out-of-range raw fallback.
Do not invent timezone offsets or sub-ms precision. Add a minimal golden fixture
and regression per the explicitly reserved generation/manifest paths.

Nested previews, Record tree (currently pins raw timestamp summaries), and SQL
untyped formatCell calls remain explicit WF-O2 residuals unless a separate
contract/reservation authorizes type propagation. Do not report "all date
rendering fixed". No raw data/export/overlay/filter conversion, package change,
raw-copy feature, or incidental editor behavior fix.

Prove numeric BIGINT/DECIMAL unaffected, date/time/negative epoch/null/bad range,
copy equality, editor/undo/export roundtrip and source bytes unchanged. A wrong
ms-vs-us mutation must fail the intended boundary test.
```

### WF-02: two pipeline label corrections, one presentation boundary

```text
PipelinePanel counts unconsumed nodes as outputs, including gates/publish, and
labels recorded gated outcomes as completed. Approved WFD-08 label-only policy
must preserve those sets and each node's actual status. Apply exact approved
summary/badge/outcome-heading strings ONLY; genuine Preview output/schema/
delivery labels stay. Do not edit pipeline-model.ts/runner/packages/IR or
canonical DCR/report bytes. Cover grammar and terminal source/SQL/gate/publish,
normal/error/cancel/gated states; downstream Pending and no gated verdict/
preview remain pinned. Never equate terminal-node count with delivery count.
```

### WF-03: approved header/hierarchy/welcome subset

```text
Read the selected subparts and exact copy list; no wholesale restyling. Help
is already implemented. Move its single opener only as approved; preserve
idle/ready focus return and Help/Settings/Export/configured-disclosure ownership.
Keep current ready first-row/footer and header geometry at 1024x700. A welcome
layout is idle-only and may reuse existing copy, not a new source of promises.
Do not remove h2s to remove visible duplication: preserve accessible heading
map/section anchors or obtain the explicit replacement contract first. No task
edit gating, pane/SQL resizing, token overhaul, new theme preference or lifecycle
changes. Both telemetry legs mandatory.
```

### WF-04: action policy only after approved table

```text
No runtime code until full WFD-03 input/output/copy table is approved. Preserve
global busy/stale/error access and Back to findings while varying approved
nonurgent suggestions. At most one primary; no task-switch auto-run. Normalize
existing App states, don't invent a shadow session. Pipeline refused/gated/error/
cancelled != delivery. Staged-B input only if D-06 explicitly reopened. Run
origin not inferred from revision/history and D-11 stays deferred by default.
Exhaustive selector cross-product + independent bidirectional copy-set equality;
concurrent busy sources and delayed outcomes must have defined precedence.
```

### WF-05: replacement design (read-only)

```text
Write the successor lifecycle specification, not code. App currently begins a
new session and sets opening BEFORE the picker resolves: cancellation loses a
ready session even if clean; failure also has no old-session restoration.
Decide preservation scope for clean as well as dirty replacements explicitly.
Trace beginSession, token/provider/handle ownership, editor blur commits, active
history prefix/no-op/undo-zero, filter/SQL drafts, export FSA close vs anchor
initiation, late outcomes and every existing modal. Propose exact transition
and copy tables plus concrete test/reservation matrix. Recommend Export-and-
Stay, then a separate discard/choose gesture; never auto-replace after a download
starts. Original export/same-source/whole-effective-view guarantees stay intact.
If preserving old session needs unapproved engine/lifetime changes, report the
feasibility blocker; don't promise transactional adoption from a mere warning.
No permission for WF-06 follows from this design assignment.
```

### WF-06: replacement runtime (no generic brief provided)

This row **cannot yet be handed to a runtime agent**. After WF-05 is independently reviewed and the maintainer approves its final transitions, exact copy and session/file boundaries, write a concrete brief naming the actual ingress/adoption/reset/export seams and all T-WF06 cases. Refuse dispatch while the map says BLOCKED. This deliberate gate prevents implementing a confirmation that still destroys the old session on picker cancel/failure.

### WF-07: visible rows

```text
Use DataGrid's actual viewport intersection, excluding overscan/sticky header,
with current total and 1-based current-view positions. No packages/grid API,
new engine count/fetch, paging, selection, base-ID renumbering, new live region
or scroll announcements. Exact approved 0/unknown/many copy; middle/end scroll,
filter/no-results/sort/insert/delete/undo/loading/error/resize coverage. Footer
must fit current shell budgets. Mutate an overscan/off-by-one calculation.
```

### WF-08/09 and optional residuals

WF-08 is design-only: compare in-shell improvements vs selected alternative under the spec's long/wide/sparse fixtures and viewport/scheme/zoom matrix; record actual ADR conflicts/costs and human-evidence gap. WF-09 has no runtime brief until its new architecture and exact migration spec are accepted. WF-O1 filter-draft clarity and WF-O2 temporal consumer parity have no runtime authority: create explicit copy/typing/lifetime/reservation contracts first, preserving existing rollback/type/totality invariants. Other sv/SV-F features stay in the old future register.

## 4. Independent-review envelope

```text
ROLE: independent reviewer, no implementation or fixes. Worktree [path] at
candidate [SHA]; baseline [SHA], selected ROW/approval [record]. Use explicit
xhigh thinking on preferred GPT-6 Luna; do not reuse implementer/model.

Read approved decisions/spec/row and full actual changed modules/tests; verify
reservation and no disguised semantic expansion. Try to refute each claimed
fix. Compare exact copy independently, not implementation-imported constants.
Run required full gates yourself, even for config/test-only fixes; two telemetry
legs when relevant. Different free ports [triples], logs [path]. No real network
collector/data, new allowlist/timeout, retry-to-green or force click.

Mutate a load-bearing behavior so the intended assertion must fail, restore
byte-identically/rebuild and prove clean. Native modality/disabled attribute/
React suppressed synthetic click/application guard are DISTINCT claims: a
programmatic no-op on a disabled button alone doesn't prove its handler guard.
For temporal: raw transport vs display vs editor vs copy vs export distinct.
For replacement: old-session cancellation/failure preservation must be real,
not a mock promising an API that the engine doesn't provide.
For range: actual visible intersection, not overscan/base-row identity.

Return VERDICT approve or request-changes; numbered findings with file/symbol,
quote, reproduction and impact; gate exits/counts and failures; mutation and
restore evidence; unrun coverage and exact limitations. Review re-dispatches
must include pnpm test if any test/config changed. Do not approve only from
worker summary/screenshots, and don't close a row before merged verification.
```

## 5. Integration/closure pickup

The orchestrator verifies the reviewed tree, integrates the exact candidate, and runs fresh merged gates. Capture the map's integration record including all failure/review rounds, then update status/source/test/approval/merged evidence immediately. A post-merge fix requires independent review and the affected **full** gate contract again; no silent test-pin adjustments. Finish WF-10 only after every selected row is integrated and green, and carry unselected rows/RD-T07/precision and other recorded limitations forward. Report tree/branch/worktree state, not guessed remote divergence or remote CI. No push or publication.
