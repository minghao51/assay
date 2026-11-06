# SVG implementation pickup prompts

**Status:** prepared 2026-11-04 for the next orchestration agent. These are templates, not active claims, approvals or commands to run all future work.

Read the [stack review and preferred redesign route](../../product/12-workbench-redesign-review.md), [map / decisions / task statuses](20261104-svg-implementation-map.md) and [conservative requirements](../../product/11-svg-implementation-spec.md) first. The user is open to larger UI changes; choose and validate a route before runtime. Conservative Phase A is a fallback, not a mandatory precursor. The [SVG README](../../../assests/svg/README.md) is the capability/source inventory. Accepted ADRs and the current handoff win over drawings and templates.

## 1. Default pickup — reconcile and report, do not implement yet

Use this when the maintainer has requested a plan/handoff but has not approved runtime work:

```text
You are the next Assay implementation orchestrator, not a worker asked to rebuild
all features in the SVGs.

Read AGENTS.md, docs/process/handoff.md §§1–6, the operating model, accepted ADRs,
assests/svg/README.md and all 17 SVGs, docs/product/11-svg-implementation-spec.md,
docs/product/12-workbench-redesign-review.md, and
 docs/process/handoff/20261104-svg-implementation-map.md.

The ask is a coherent local workbench UX with preserved data semantics. The MVP,
desktop VS Code slice 2, P1–P3 and local DCR v1 already exist; original UX runtime
queues are closed. This instruction authorizes reconciliation, not runtime code.

1. Inspect current revision/tree state and pack availability. Preserve all user
   work. Do not silently clean/stash/stage/commit it. An isolated worktree omits
   uncommitted SVG/docs; resolve integration/snapshot authority first.
2. Perform rd-0 read-only discovery, reusing sv-0's baseline/ledger contract rather
   than auditing two routes independently. Produce the board/requirement delta ledger
   with source paths, actual current observations, existing assertions, concrete
   proposed changes, task ownership and blockers. Historical evidence is not a
   fresh baseline. Do not change runtime/tests/config to invent a clean baseline.
3. Read decisions SV-D01…SV-D08. Recommend the rd-0…rd-2 design checkpoint and
   candidate IA, not automatic panel restyling. Record fallback vs redesign choice;
   optional sv-8/sv-9 and deferred/horizon sv-10…sv-12 remain separately decided.
4. If baseline integration or gate execution is authorized, record the actual
   revision, tool versions, env names/status, ports and per-command exits.
   Otherwise report what approval/tooling is missing instead of claiming green.
5. Return a concise pickup report: current truth, exact new deltas, preservation
   checks, approval questions and next eligible task. Do not dispatch runtime
   workers, push, publish, change gates, contact collectors or deploy anything.

Use GPT-6 Luna read-only scouting/planning if available as requested for this
vision exercise. Record unavailable models; do not silently change the model
roster. Do not automatically launch a large workflow without user opt-in.
```

## 2. Preferred route — design checkpoint, then first useful slice

### Design/prototype approval example (no production runtime)

```text
Prepare rd-0 through rd-2 using product/12 and the live SVG implementation map.
Compare a conservative navigation refresh with a bounded task-led redesign on the
existing React/TypeScript/Vite stack. Keep local-first/data/engine guarantees;
revisit UI structure when it improves the core journeys. Do not rebuild engines
or introduce a router/global store/UI package merely for the redesign.

Prototype Explore / Check / Change / Prepare navigation and the full
validation→row→repair→stale→explicit recheck journey, plus compare and copy-export
continuation. Keep expert SQL accessible. Help is secondary, not the primary way
users discover the next action. Use synthetic fixtures, keyboard/zoom/dark and
error/stale/unsaved states, not only happy-path static frames.

Prepare the moderated task protocol and provisional RD-R07 targets. Run human
sessions only with authorized/available participants; otherwise report the missing
evidence and a heuristic walkthrough without claiming user validation. No external
participant contact, recordings/upload, telemetry or production implementation.

Return SV-D08's proposed IA and named old→new layout/copy/test contracts, required
ADR/UI decisions, optional SV-D02/03/04/05 choices, app-local state ownership,
migration/rollback boundaries and the first rd-3/rd-4 runtime-slice proposal.
This approves design preparation only, not accepted ADR changes, runtime, push
or publication. Do not execute conservative sv-* rows as a prerequisite.
```

### First runtime-slice template, only after rd-2 approval

Fill the actual approved IA/decision references and reservations **before** sending; placeholders and reading this file grant no authority.

```text
Implement rd-3 and rd-4 only against the approved rd-2/SV-D08 design record:
<actual decision/evidence reference and exact changed/retained UI contracts>.
Record this bounded execution instruction under SV-D01.

First pass the authorized baseline. Extract only the app-local presentation seam
needed for validation→finding→logical row→typed repair→stale→explicit recheck,
with existing explore/history/export access. Keep authoritative session hooks,
worker/grid lifetime, drafts/overlay/history/results and cancellation ownership.
Use neutral snapshot/current-view labels; operation count is not a changed-data
signal and revision alone is not run origin. Explicitly scope any captured readonly
app-session metadata; change no engine/domain/wire/report bytes.

Use one bounded worker/file reservation at a time, independent review, the full
required gates and fresh merged verification. Run RD-T02/03/04/05/07/08 and relevant
existing SV-T safety/semantic tests; report actual usability evidence or its explicit
accepted limitation. Keep known-good rollback points; no duplicate mounted engines,
live dirty-session remount toggle or blanket App/CSS rewrite.

Do not implement rd-5…rd-7 automatically, optional features without their selected
decisions, deferred engine work or future horizons. Stop after the first slice,
report observed user/task/performance results, and request the next bounded scope.
No push/publication or collector/participant-network operations are authorized.
```

## 3. Conservative Phase A execution — explicit fallback only

Sending this prompt as an explicit maintainer instruction selects Phase A. Merely reading it in the repository does not authorize execution.

```text
Implement Phase A of the Assay SVG implementation map: sv-0 through sv-7 only,
using docs/product/11-svg-implementation-spec.md and
 docs/process/handoff/20261104-svg-implementation-map.md.

Record the explicit fallback choice under SV-D08 and this instruction as SV-D01's execution-scope approval. Reconcile the current
source and run the authorized clean baseline before any feature claim. Preserve
unknown/uncommitted work and the complete SVG/spec pack; ask if baseline integration
or commit authority is unclear. Do not reuse bba491a's historical test counts.

The concrete ask is:
- coherent headings/controls/spacing/status styling within the accepted shell;
- capability-aware global native-dialog Help, including idle/ready navigation and
  accurate setup/surface/keyboard guidance;
- neutral Current dataset view / Checked dataset snapshot captions and truthful
  freshness/page/sample/count context; operation counts and revision do not prove
  changed data or run origin. Add origin detail only from explicitly scoped,
  atomically captured readonly app-session metadata;
- draft-versus-applied filter clarity and compact context in the existing export
  dialog, with current typed editing/history/save safeguards unchanged;
- legible validation/comparison and ordered pipeline status/gate information;
- integrated real-browser, accessibility, privacy and cross-surface agreement proof.

Do not rebuild existing open/grid/schema/record/SQL/profile/edit/check/diff/pipeline
capabilities. For already-satisfied requirements, record actual current assertions
and independent verification rather than unnecessary code changes.

Use one bounded row per worker, one web writer at a time, explicit file reservations,
a different independent reviewer as required by project policy, full required gates,
changesets for runtime package changes, and fresh merged verification. Keep task
statuses/evidence in the map current. Read the map's STOP rules and ownership limits.
Do not claim completion on a failing gate, a worker summary, or screenshots alone.

Excluded: sv-8 DCR inspector, sv-9 dirty guard, sv-10 SQL sizing, sv-11 edited-view
profile, sv-12 horizon runtime work; new formats/codecs/protocols/report bytes,
CLI/VS Code runtime redesign, dependencies, AI/hosted/enterprise services, graph
authoring, adapters/schedulers and release/collector operations. No push or
publication is authorized. Follow current explicit model preferences; do not let
the same implementer/model approve its own runtime change.

Stop after Phase A closure and report actual improvements, tests, residual decisions
and next options. Do not automatically continue to optional or gated phases.
```

## 4. Orchestrator-to-worker brief template

The orchestrator fills **every field** from the live approved row. Do not send a worker unresolved placeholders or ask it to choose its own scope from the whole SVG pack. Store per-dispatch briefs/logs outside the repository, following the operating model.

```text
ROLE: bounded worker for the selected route. You may write only the explicit
boundary below. Design-only rd-0…rd-2 briefs authorize docs/prototype work, not
production edits; runtime rows require actual rd-2/route and execution approval.
TASK: <exact live task ID + row text>
APPROVAL: <user instruction / SV-Dxx resolution, scope and date>
BASELINE: <actual approved revision, clean/snapshot state and passing gate evidence>
DEPENDENCIES: <integrated task IDs/revisions; do not assume background work is done>
RESERVATION: <exact source/CSS/test/helper files; no concurrent writers>

Read first:
- AGENTS.md and current handoff §§1–6; operating-model.md;
- live SVG implementation map, this task's requirement sections and SV-T cases;
- relevant SVG(s) and README boundaries;
- relevant accepted ADRs and existing source/tests.

WHAT TO CHANGE:
<Observed current behavior, exact desired delta, UI state transitions/copy/focus,
 small file-level plan and explicitly preserved behavior. Do not say “implement
 everything in the board” or “based on findings, fix it.”>

DONE WHEN:
<Requirement IDs + observable acceptance + exact focused tests/negative controls>

BOUNDARY:
Allowed: <exact files; proposed new components/tests explicitly named>.
Allowed exception: one .changeset/*.md as required for the affected package.
Forbidden: shared docs/map/status/roadmap/root configs/lockfiles, other app/package
runtime code, engine/grid protocol/serializer changes, new dependencies/formats,
telemetry content/events/collectors and unapproved future/optional features.
If the explicit task includes App/CSS, that is a reserved exception—not permission
to change unrelated shell state or execution semantics. For a selected redesign,
only the named rd-2-approved DOM/geometry/copy contracts may change; conservative
Phase A preserves them. An accepted conflicting ADR cannot be bypassed.

VERIFY:
<Per-row focused commands and assertions + map §6 complete gate commands, versions,
 stock/configured/restored telemetry protocol if affected, assigned free ports,
 log directory, exit capture and coverage floors. Browser tests require rebuilt
 output and fresh servers; source mutations/restoration each require rebuilding.>

DELIVER:
- concise changed-behavior and file list; actual requirement/test coverage;
- command exits/counts/coverage/skips/retries and log paths;
- no-scope-expansion/privacy/byte-contract claims supported by evidence;
- one Conventional Commit + changeset if commit authority is explicit;
  otherwise leave a reviewed patch and ask, never silently commit user work;
- blockers/carryovers and exact review instructions.
You do not approve or close the task and never push.

STOP if scope/ADR/decision conflicts, baseline/gates/model/tooling fail, data-scope
fields are unavailable or implementation needs forbidden files. Preserve work,
record the blocker and return it; do not lower thresholds or improvise permission.
```

### Redesign-specific instructions

| Row       | Load-bearing ask / exclusion                                                                                                                                                     |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| rd-0…rd-2 | Design/baseline/prototype evidence only. Compare alternatives and record usability limitations; no production implementation, invented participants or silently accepted ADR.    |
| rd-3      | Controlled app-local seam; retain hook/worker/grid/session lifetimes and drafts. No-op/revision-safe labels and explicit metadata boundary; no global store or backend change.   |
| rd-4      | First usable repair/recheck journey, context return and explicit rerun, not a Help-first restyle. Test task switching while busy and retest with users/walkthrough.              |
| rd-5      | Confirmed A/B comparison and whole-current-dataset copy/export with existing semantic/byte/CLI proof. No source mutation, subset export or hidden second dataset view.           |
| rd-6      | Reuse existing ordered pipeline/gates/preview/lineage/delivery. Optional inspector is sv-8 with its separate approval, not a new hosted workspace.                               |
| rd-7      | Actual usability/keyboard/AT/zoom/performance/recovery and full merged gates; record limitations. Help is concise secondary reference. Do not claim all future features shipped. |

### Conservative/optional task-specific instructions to include in each filled brief

| Row  | Load-bearing ask / exclusion                                                                                                                                                                                                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| sv-1 | Use the approved delta ledger, not a blanket restyle. Preserve Open-primary/example-drop-secondary hierarchy and guarded opening/error/retry flow, existing token layer, 28px rows, geometry/DOM, dark scheme and all purpose/accessibility copy.                        |
| sv-2 | Secondary Help uses native lifecycle plus app-local modal-intent ownership; existing Export remains a custom trap with in-flight restrictions. Preserve local Keyboard help and required disclosure; no nested active modal or focus theft.                              |
| sv-3 | Use neutral current-view/checked-snapshot labels; no-op operation count and nonzero revision do not establish changed contents/origin. Optional readonly metadata must be explicitly captured/reserved. Preserve profile copy, no extra engine query/report-byte change. |
| sv-4 | Indicate changed inputs, not SQL semantic inequality. Accepted chips reflect accepted state; preserve failed-apply rollback/reseed and uncertain double failure. Export stays whole effective dataset in the existing dialog; no new op/format/subset.                   |
| sv-5 | Separate exact totals/examples and A/B scopes; keep eligible failure-filtering and explicit key confirmation. Schema first, A-only row jumps, stale→explicit rerun, report bytes unchanged.                                                                              |
| sv-6 | Style the existing ordered plan, actual status/gate evidence and logical materialization. No graph editor, runtime state additions, automatic publication or DCR inspector.                                                                                              |
| sv-7 | Evidence/acceptance/docs only. A discovered feature defect requires a scoped follow-up row; do not silently fix everything in the acceptance dispatch.                                                                                                                   |
| sv-8 | Only after SV-D02: retain the exact generated artifact with separate generation/delivery states and run/form/session ownership. No second build, standalone import, hosted review, schema change or inferred DCR keys.                                                   |
| sv-9 | Only after SV-D03: implement its chosen pending-draft and Stay/export/discard/picker flow; preserve work on cancel/refusal/failure and do not add unload/autosave claims.                                                                                                |

## 5. Independent reviewer brief template

Use a reviewer independent of the implementation session and with the project's required model separation. Review actual outcomes, not the worker's intent. An evidence-only row still needs evidence review.

```text
ROLE: independent reviewer. No product edits, integration, push or publication.
TASK / APPROVAL / BASELINE: <exact row, authorized scope, actual revisions>
WORKER: <model/session, files/commit/changeset and claimed results>
FOCUSED CONTRACT: <SV-Rxx / SV-Txx / relevant boards / explicit preserved invariants>
RESERVED CHECKOUT / PORTS / LOGS: <isolated revision, free ports, external log path>

Read the actual diff/source and relevant full symbols, the map/spec/decisions and
accepted ADRs. Determine whether each claimed delta was authorized and necessary;
closed original UX rows and future boards cannot be redispatched implicitly.

Independently run all required gates and focused tests from map §6. Verify actual
rendered keyboard/modal/state/scope behavior through real controls, in both schemes
and required viewports. Do not treat source-pin updates, worker summaries or
screenshots as semantic proof. Rebuild for browser evidence; never reuse another
revision's server. Include configured disclosure/restored stock when affected.

Try to falsify the task's strongest claim with a meaningful negative control or
safe isolated mutation. Show the expected failing assertion, restore all changes,
rebuild restored output, and prove no review mutations remain. If unsafe, report
why and use the orchestrator-approved alternative. Do not mutate user work.

Check in particular:
- selected approved shell/record/grid contract, deliberate old→new test migration,
  logical row identity, virtualization and task-switch session continuity;
- profile file-as-opened, SQL page vs total, neutral snapshot/freshness labels,
  no-op operation and undo-to-base revision cases; no false SQL equivalence;
- no filtered/subset export, source writes, byte/MIME/CSV behavior changes;
- exact totals vs bounded examples, eligibility/confirmation and A-only jumps;
- existing pipeline statuses/gates and canonical local DCR constraints;
- session/race/focus/modal recovery and no extra computation/telemetry/remote work;
- required changeset, strict types, dependency direction and reserved file scope.

Return:
VERDICT: approve
or
VERDICT: request-changes
with precise numbered findings, command/exit/count evidence, source locations,
negative-control/restoration evidence and any coverage limitations. Do not mark
CLOSED or infer remote CI success. The orchestrator must integrate and verify.
```

## 6. Optional follow-on approval prompts

These are examples of **separate** authorizations, not additions to Phase A by default. Use only after the selected route's relevant foundation and the named decision resolve: DCR inspector after fallback sv-7 or redesign rd-6; dirty replacement after fallback sv-7 or redesign rd-3, potentially before the first repair slice. Do not require both routes.

### DCR inspector — explicit generation/delivery choice

```text
Approve SV-D02 and implement sv-8 only, per SV-R14/SV-T17. Select summary + collapsed
exact canonical YAML, retained only in the current session and bound to generation,
form selections and run identity. A successful derivation permits inspection;
save cancel/refusal/failure retains it explicitly as generated but not saved.
A new generation attempt, relevant form change or pipeline/run/session replacement
invalidates it. No import or cached-save action; no second build or schema changes.
Record approval and selected bounds in the map, run full review/integration gates,
and stop after sv-8. No push/publication or other optional/horizon work.
```

If the maintainer prefers delivered-only inspection, change the requirement and decision **before** dispatch; do not quietly ship a different lifetime.

### Dirty replacement — decision request before implementation

```text
Prepare the SV-D03 decision for sv-9. Show the exact Stay / Export current dataset /
Discard-and-choose flow, including what happens to an uncommitted cell draft and to
cancelled picker/export, refused source, failed write and late open completion.
Recommend replacement-only protection with no unload/autosave guarantee. Do not
write runtime code until I approve the flow and pending-draft treatment.
```

## 7. Orchestrator integration / session handoff checklist

- Verify worker changes actually match the brief; obtain independent approval and run fresh merged gates. Do not close rows with failing or unexecuted required checks.
- Update map status/evidence, current handoff and user-facing narrative as appropriate; changeset/commit policy still applies. Do not rewrite old queue closure records or claim a future gate passed.
- Preserve pending decisions and exact next eligible task. Describe approved improvements separately from existing foundations and still-unimplemented SVG horizons.
- Keep logs/screenshots external and synthetic; decisive results and revision/model/approval provenance must survive in the durable map record.
- On model outage, tool failure or session interruption, record completed/unfinished work, ownership, uncommitted files and failed command. Successor verifies/adopts intentionally; it must not silently discard, recreate or approve prior work.
- Push/release/registry/collector/billing/force-push actions require fresh explicit authority. A previous episode's permission is not reusable.
