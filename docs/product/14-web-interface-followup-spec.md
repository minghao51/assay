# Web interface follow-up — implementation specification

**Date:** 2026-11-10. **Status:** proposed handoff specification. **Partially executed 2026-11-10** under the dated decision record in the
[approval record](../process/handoff/20261110-web-followup-approval.md): **WF-01P** (matrix), **WF-02** (`b65e304`,
label-only) and **WF-01** (`b6b773d`, WFD-06=B exact-precision display) are delivered, **WF-05** is a verified
contract ([v5](../process/handoff/20261110-wf05-replacement-contract.md)), and **WF-10** closed the selected subset.
**Every other row in this spec stays unauthorized** — WF-06 needs explicit runtime authorization, WF-03/WF-04/WF-07
need their WFD decisions, and WF-08/WF-09/WF-O1/WF-O2 are unselected. Baseline inspected: `7fa1e78`; WF-00 preflight
green at `76c1945`.

Read the [audit and corrections](../reviews/2026-11-10-web-svg-followup-audit.md), [task/decision map](../process/handoff/20261110-web-followup-map.md) and [dispatch briefs](../process/handoff/20261110-web-followup-pickups.md). This specification preserves accepted [ADR 0044](../adr/0044-workbench-shell-two-pane.md), UI-RD-01 and the [rd decisions](../process/handoff/20261104-rd-decisions-and-runtime-scope.md). “Must” below constrains a **selected, approved** row; it does not authorize that row.

## 1. Intent and non-goals

Improve correctness/readability, recovery and selected everyday friction without rebuilding the data engine or treating every SVG drawing as a shipping requirement. The shipped stack remains React/TypeScript/Vite, DuckDB-WASM/Arrow in the existing worker, immutable source + staged overlay, logical row identity, and local-first processing.

No new input/export formats, ops, connectors, adapters, persistence/autosave, tab-close guarantee, SQL interrupt, profiler semantics, auto-validation, implicit publish, DAG editor, hosted approvals, AI, telemetry events, library/dependency, package protocol or report/DCR/export serialization change. Source filenames remain absent from shell/guidance/telemetry. Existing dataset presentation may show values locally as inert text; “value-free” guidance/feedback does **not** mean blanking the grid.

The sketches contain illustrative filenames/counts and a 1600×1120 canvas. Neither is a runtime contract. Do not copy a pictured filename, fixture or measured-looking metric into production copy. Current input: Parquet, CSV, JSONL/NDJSON, JSON; export adds Arrow IPC stream, not Arrow input. Cold-cache web opening may fetch readers from the CDN; harness-pinned extensions are not product offline support.

## 2. Stable contracts every row must preserve

| Area                 | Required invariant and regression evidence                                                                                                                                                                                                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell/task semantics | Grid is persistent center, tools left at ≥1024, Record dock; <1024 stacks and scrolls. Tasks reveal tools, not permissions. Grid/Record remain usable and edits remain available in Check after a finding jump. `tasks.test.ts`, `App.shell.test.tsx`, `App.task-switch.test.tsx`, `workbench-tasks/visibility.spec.ts`, validation journey. |
| Lifetime             | No task-keyed session/grid remount, worker reboot, new file/query/validation/profile run, B reset, draft/history/SQL result loss or request double-consumption on task change. Retain provider identity/render/window pins and late-result guards.                                                                                           |
| Focus                | Keyboard task radio group, Home/End/arrows, visible focus; section nav/reveal via existing seams, no focus theft on late completion. Stable anchors/testids/aria-controls; one accessible h2 per real panel, not a heading removed to hide duplicated visual text.                                                                           |
| View/state scope     | Current dataset view is effective base+overlay. Staged ops can include no-ops. Profile remains File as opened. SQL page != dataset total. Comparison B is separate; only A-side row jumps enter main grid. Snapshot freshness != proof of run origin.                                                                                        |
| Mutations/delivery   | Source cannot be overwritten. Undo/redo/logical IDs remain; whole effective dataset export in natural order, not filter/sort viewport. CSV injection protection; Arrow output cannot be reopened. Delivery cancellation/refusal/failure must not be called saved.                                                                            |
| Modal ownership      | Help/Export/disclosure/Settings arbitration, native Help/disclosure top layer, existing Export trap; correct opener return and no disconnected-target focus theft. No new modal library or migration disguised as styling.                                                                                                                   |
| Recovery             | Preserve known filter single-failure rollback/reseed and honest double-failure state; edit rejection rollback; stale verdict/diff readable and explicit rerun. No hidden state-meaning change through captions.                                                                                                                              |
| Accessibility/layout | Both schemes, 1024×700 minimum desktop, 1440×900, 1920×1080, 900px fallback and 200% zoom. No document horizontal clipping; internal wide-grid scrolling remains. Existing axe allowlist/thresholds/DOM/fetch/render budgets unchanged unless a separately approved contract actually replaces them.                                         |
| Evidence             | No human validation/intuitive/user-tested claim; RD-T07 is a limitation. No wall-clock budget from historical M1 or five-row rd-7 observations.                                                                                                                                                                                              |

## 3. Requirement and acceptance matrix

| Requirement / task | Required positive, negative and preservation proof                                                                                                                                                                                                                         | Traceability                                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **T-WF00**         | Every board mapped to shipped/presentation/deferred/gated; current SHA clean and full gates recorded before writer claim; every approved row/copy/decision named.                                                                                                          | Audit all 17; map crosswalk; historical sv-0/SV-R01                                                                          |
| **T-WF01P**        | Read-only real-engine matrix with actual types/units/precision/consumer metadata and proposed fallback; commands/limits recorded, source/tests/fixtures unchanged. Return for explicit WFD-06 approval; no formatter edit.                                                 | WF-01P; source/engine observations only                                                                                      |
| **T-WF01**         | Type-aware temporal scalar formatting, raw-untyped fallback, NULL/non-temporal controls, time/precision/range matrix below; grid display == focused display-copy; editor validation/transport/export unchanged. Nested/Record/SQL scope explicitly reported, not inferred. | Boards 02/03/16; source `format.ts`, `typed-input.ts`, `copy-cell.ts`, `nested-preview.ts`, `record-tree.ts`, `SqlPanel.tsx` |
| **T-WF02**         | Terminal node != deliverable; recorded outcome != successful completion; real gate refusal still leaves downstream Pending without verdict/preview. Normal/error/cancel/gated sets/statuses identical before/after.                                                        | Board 08; D-13/D-14; `pipeline-model.ts`, `PipelinePanel.tsx`, rd-6 journey                                                  |
| **T-WF03**         | Every selected markup/layout subpart shown before/after; Help has same exact copy and ownership/focus idle+ready+configured; panel hierarchy/heading map, collapses, direct nav and first row/footer fit preserved.                                                        | Boards 01/06/07/11/12; rd-7 guide contract; R-14/purposes                                                                    |
| **T-WF04**         | Approved full priority/copy truth table and exhaustive selector cross-product; every render maps to exactly one allowed action; busy cancel/stale review never lost; no auto-run on task switch; no hidden extra engine calls.                                             | Boards 00/06/07/08; RD-R02/03; D-06/D-11                                                                                     |
| **T-WF05**         | Before any runtime guard: complete transitions and exact draft/export/picker/failure ownership decisions; test feasibility and explicit session seam reservations; no fictitious preservation guarantees.                                                                  | Boards 01/05/11; SV-D03/D-07                                                                                                 |
| **T-WF06**         | Every approved WF-05 transition browser-tested with real pickers or deterministic picker cancellation/refusal, busy/late outcomes, old/new session ownership; no source write/data echo and all existing delivery tests preserved.                                         | WF-05 successor contract; M4/open/recovery/modal suites                                                                      |
| **T-WF07**         | Actual visible first/last view positions, not overscan or base IDs; 0/1/many/loading/error/filtered/sorted/insert/delete states; scroll/resize without extra query/fetch. Non-live static label.                                                                           | Board 02; `DataGrid.tsx`, row-number/horizontal/busy tests                                                                   |
| **T-WF08**         | Constrained alternatives on fixed long/wide/sparse data; viewport/scheme/zoom/focus/cost comparison; exact ADR impacts; missing human evidence stated.                                                                                                                     | Boards 03/06/07/08/12; ADR 0044; UX-D2/SV-D04                                                                                |
| **T-WF09**         | A separately accepted successor ADR where needed and full runtime DOM/geometry/lifetime/copy contract **before** implementation; staged vertical journeys and reversible integration.                                                                                      | Selected WF-08 design; no runtime authorization in this spec                                                                 |
| **T-WF10**         | Every **selected** requirement traced to actual worker/reviewer/merged evidence or explicit blocked/limited status. All remaining optional/horizon items carried forward, never silently marked done.                                                                      | Map closure record; RD-T07 retained limitation                                                                               |
| **T-WFO1**         | Input changes measured against seeds, including clear/invalid/programmatic same-count replacement; no SQL equivalence claim, unchanged apply/rollback/double-failure.                                                                                                      | Board 16; SV-R06/rd draft contract                                                                                           |
| **T-WFO2**         | Separately approved nested/Record child-type and SQL-result metadata contracts; preserve totality/raw-fidelity and state actual timezone/precision limits. Not inferred from scalar success.                                                                               | Boards 02/03/16; nested preview/Record tree/SQL page                                                                         |

## 4. Task contracts

### 4.1 WF-01P / WF-01 — read-only contract first, then separately approved scalar slice

**Two distinct dispatches, no circular approval:** after WF-00 and explicit read-only authorization, WF-01P may inspect source and run existing engine APIs with temporary synthetic `/tmp` probes to produce the type/unit/precision/consumer matrix below. It changes only its report/design document, not repository source/tests/fixtures. It does **not** need an already-approved matrix. It returns the matrix, proposed scope-A formatting/fallback policy and command evidence, then **stops**. Only after the maintainer explicitly approves that returned matrix under WFD-06 may a separate WF-01 runtime writer edit the formatter, add the golden fixture or extract helpers. Choosing a UTC direction or commissioning WF-01P alone does not authorize those edits. Any later mismatch with the approved matrix is a stop-and-report condition.

**Finding:** `grid/format.ts` formats JS Date objects but numeric typed temporal values fall through to `String(value)`. Arrow accessors deliver DATE/TIMESTAMP as epoch **milliseconds**, TIME as **microseconds** (often bigint), so no generic “number means Date” branch is valid. Existing editor `edit/typed-input.ts:temporalDraft` already has a deterministic formatting contract; profile obtains temporal text separately. Do not change the worker boundary to fix UI display.

**Mandatory WF-01P artifact (no prior matrix approval needed):** a table for each actual supported temporal type: DuckDB type, Arrow field/unit, JS value shape at base and overlay projection, declared parsed type available at each consumer, UTC/naive/zoned interpretation, delivered precision, and safe fallback. Verify with the **real engine** and synthetic fixture, not just a mocked number. Include negative epoch/pre-1970, leap-day, midnight/microseconds, NULL, naive vs zoned timestamp, unsupported/nonfinite/out-of-JS-range values and wide ordinary integers. Map type aliases and precision variants actually accepted by `parseDuckDbType`; unsupported families are explicit fallbacks, not guessed support.

**Approved policy (WFD-06=B, 2026-11-10 — exact delivered precision, raw fallback; see the [approval record](../process/handoff/20261110-web-followup-approval.md) §9):** deterministic UTC projection, no environment-local locale/timezone formatting; for a naive timestamp explain this is a UTC-based display convention for delivered wall time, not an assertion of original timezone. DATE `YYYY-MM-DD`; TIMESTAMP ISO-like `YYYY-MM-DDTHH:mm:ssZ`, `.SSSZ` or `.SSSSSSZ` according to the precision actually delivered (never truncated, never padded); TIME `HH:mm:ss[.ffffff]` from microseconds-since-midnight, not a Unix date. Zoned TIME, special dates/infinity/BC/extreme ranges and ns timestamps require verified transport before any claim. Never manufacture lost sub-ms digits, original offset, or calendar accuracy outside supported range. If the delivered epoch-ms value contains a fractional millisecond, preserve it only with a verified exact rule or retain raw fallback; do not silently truncate it through JS Date. Existing editor precision behavior is not expanded by this display slice. String/unknown/untyped temporal-looking numbers remain unchanged. Fallback is the existing raw display, no fabricated date and no throw.

**First runtime slice scope:** scalar grid cells and focused **display-value copy**. Keep `composeCellCopyText` on the same formatter, as its existing contract requires. The copy text therefore intentionally becomes readable when display does; it is not raw-data export. No new “copy raw” button is required or implicitly approved. Editor initial drafts must remain byte-equivalent to the current tested engine-parseable seeds, editor submission and validation unchanged. Reuse/extract a shared pure temporal helper from the current editor only if all existing editor cases remain identical; do not fix incidental editor edge cases in the extraction. Never feed display strings into overlay operations/filter predicates/export.

**Explicit residual, not a false full fix:** nested grid previews use `nested-preview.ts`; Record uses `record-tree.ts` and currently **pins raw timestamps**; SQL calls `formatCell(cell)` with **no declared type**. A scalar branch does not fix them. First dispatch must choose:

- **A (recommended first):** scalar grid + display-copy only, keep existing nested/Record/SQL output with an explicit residual **WF-O2 temporal parity**; no claim “all temporal displays fixed”.
- **B:** separately approve WF-O2 type propagation/consumer contract before changing those surfaces. SQL aliases/expressions require real Arrow result metadata, not base-table column guessing; Record needs declared child types through full-depth tree traversal, including container types, without sacrificing total hostile-input handling. This is not included by approving WF-01 A.

Add a minimal golden temporal fixture and regression test per AGENTS. Prefer readable source/generation + deliberately generated Parquet via the existing script and checksummed manifest when Parquet is needed; reuse existing fixtures for already-covered shapes but don't silently regenerate the corpus. Fixture paths/generator/manifest become an explicit reservation in the brief. Stop if new units/precision require packages/engine changes.

Required tests: pure formatter family/fallback tests; `format.test.ts`, `copy-cell.test.ts`, existing `typed-input.test.ts` unchanged behavior, real-engine browser scalar and copy check, edit/undo/reopen/export fidelity negative controls (same source/output policy), non-temporal BIGINT/DECIMAL unaffected. Use fixed TZ environments to prove rendering does not vary; do not add a dependency for a timezone library. Report sub-ms/offset limitations prominently.

### 4.2 WF-02 — pipeline label honesty, not runner changes

`pipeline-model.ts` marks `isOutput = !consumed`; terminal gate/publish nodes are included. Runner outcomes can include a gate-blocked node before returning `gated`. Neither is a successful data delivery.

**Proposed exact copy, awaiting WFD-08 approval:**

| Current                           | Proposed                               | Meaning / preservation                                                              |
| --------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------- |
| `N output(s)` in the plan summary | `N terminal node` / `N terminal nodes` | Count **same** terminal set; never count successful saves.                          |
| node badge `output`               | `terminal`                             | Same `isOutput` boolean, no model rename or wire change required.                   |
| `Completed before the stop:`      | `Recorded node outcomes:`              | Same outcome collection including refused/gated nodes; status text supplies result. |

Do not globally replace every occurrence of “output”: **Preview output**, schema/materialized relations, candidate references and delivery labels describe genuine outputs and stay intact. Tests must cover a terminal source/SQL node, terminal gate/publish nodes, gated refusal without verdict/preview, and normal/error/cancel paths that actually render the collection. Verify grammar 0/1/many; scoped label references only. No runner/outcome/model/IR/report/DCR changes. Mutation restoring old misleading copy must fail the exact label assertion; do not pin a misleading count as a count of deliveries.

### 4.3 WF-03 — shell/panel presentation inside the current ADR

Select subparts explicitly; avoid a big-bang App/CSS rewrite.

1. **Header controls:** retain one Help opener and one Settings control, place Help in a consistent global-header cluster in idle/ready. Keep Open the primary ingress, idle example/drop secondary, exact Help/dialog content unchanged. Verify the opener stays connected/focusable for return, modal arbitration with Export/Settings/disclosure, and header ready top/first row/footer pins at 1024×700. No duplicate responsive Help buttons.
2. **Panel hierarchy:** remove _visual_ repeated hierarchy by style/spacing rather than deleting accessible h2s; section toggles keep names/aria descriptions and stable focus targets. If removing/replacing a heading is selected, write an old→new complete heading/reading-order contract and obtain approval first; update tests to equivalent meaningful assertions, never drop coverage.
3. **Optional welcome layout:** reuse current capability/format/privacy/engine/example strings first. Style actual controls/drop affordance, not a static walkthrough picture. No account/upload wizard. Opening/example remain available after applicable failures, and drop remains idle-only.

Additional welcome sentences are **copy proposals**, not approved strings:

| Candidate                                                                  | Gate                                                                                    |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `Session changes are not saved automatically. Export a copy to keep them.` | Only if accurate for delivered session/export behavior; no autosave promise.            |
| `Opening another dataset replaces this session.`                           | Describe current behavior, never imply a guard before WF-06.                            |
| `Arrow/Feather input is not supported.`                                    | May clarify formats; do not invent an engine capability checker or remove Arrow export. |

Do not add a mandatory guided journey or enlarge the ready-state header to fit welcome content. No new theme preference, tokens overhaul, layout breakpoint or SQL resizing. Preserve exact task purposes and rd-7 Help copy; approve any truly changed copy separately.

### 4.4 WF-04 — context actions (decision-table design is a prerequisite)

Current `deriveNextAction` is intentionally task-independent: validation-running wins, then diff-running, then contract/check states, then comparison/delivery after a current valid verdict. It has no pipeline or staged-B input. The current cross-product test and `APPROVED_COPY` set are load-bearing.

Before coding, produce and approve a complete table with inputs:

- task; contract none/unreadable/loaded; validation idle/running/cancelled/failed/binding-errors/verdict plus stale/failing-rules when valid;
- diff idle/running/cancelled/failed/binding-errors/result plus stale; **comparison staging only if D-06 explicitly reopened**;
- normalized existing pipeline file/run/binding states only if selected (no reader-owned shadow state or timer); jump origin;
- output primary action, state/tone, secondary review, destination/focus, and the behavior when two independent operations are busy.

**Required policy constraints:** global busy cancellation, stale/error review and Back to findings remain reachable across tasks; at most one primary action. A neutral Explore suggestion must not erase a current stale warning. Export does not require a validation contract; a “no contract loaded” suggestion is not an export permission gate. Changing tasks only changes presentation, never schedules a run. Pipeline `refused`, `gated`, `error`, `cancelled` are distinct from completion/delivery; do not infer saved/published from terminal count. No pipeline action label invented by a worker.

**Conservative design recommendation:** keep existing global busy/exception precedence and vary **nonurgent** fallback suggestions only. Approve every string and the complete reachable output set as a unit, then preserve exhaustive/bidirectional copy equality assertions with the extended input domain. Do not simply make `APPROVED_COPY` import new implementation constants (that would permit synchronized drift). Keep old D-06/D-11 deferrals unless the recorded WFD-03 selection explicitly replaces them; origin metadata requires atomic capture and its own session-file authorization.

Given the missing approved table, **WF-04 is not ready for a runtime worker**. Its first authorized substep may be a docs-only table proposal. Stop on any need to edit session hooks, pipeline runner or report/wire types.

### 4.5 WF-05/06 — replacement safety design before runtime

D-07/SV-D03 currently defers this. Approval to commission **WF-05 design** is not approval to implement WF-06. The source open path calls `beginSession()` and sets opening **before** the picker resolves; cancellation currently goes to idle and failure does not restore the old session, even if it was clean. A dialog at the button cannot by itself prove preservation on picker cancel/open error. Design must follow the actual sequence, not an imagined transaction API.

WF-05 must resolve the following table before any runtime reservation:

| Question                    | Required choice/proof                                                                                                                                                                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| What is dirty?              | Applied history prefix/cursor vs full history length; undo-to-zero, redo branch, logged no-op, pending operation, rejected/rolled-back edit, column/row ops. Do not equate revision>0 or any stored history with active changes.                                                                                               |
| Pending draft policy        | Cell/column editor draft invalid/valid, blur-commit race when Open is clicked, filter/SQL drafts; decide commit/cancel/Stay explicitly. Never silently commit/cancel on modal focus loss.                                                                                                                                      |
| Ingress                     | Header Open/retry/example/drop and any programmatic entry path; drop remains idle-only. Same-source re-open is still a session replacement. State whether clean replacements gain cancel/failure preservation too; no accidental widening.                                                                                     |
| Ordering                    | Acquire candidate picker handle/File without resetting live session; keep FSA user activation for a later explicit choose gesture. Define when old ownership is retired and when candidate becomes ready. No full source-JS buffering or second hidden grid/worker just to simulate atomicity.                                 |
| Stay/picker cancel          | Exact old handle/provider/schema/filter/sort/history/drafts/B/checks remain as promised; no changed token, teardown or stale async outcome applied to the wrong owner.                                                                                                                                                         |
| Candidate open failure      | Preserve old session or require a separately approved, explicit limitation. If current engine/open hooks cannot support transactional adoption within reservation, **stop and split design/engine work**, do not advertise preservation.                                                                                       |
| Busy/late results           | Export/cast/edit/filter/SQL/check/diff/pipeline in flight, multiple replacement intents, late successes/refusals, old/new modal priority. One pending intent, no unbounded queue.                                                                                                                                              |
| Export-first                | Is it export then **Stay** (recommended safer flow), or auto-continue? Browser download initiation is not verified disk persistence. Cancel/refusal/failure never advances replacement or clears overlay; successful export must not silently mark history clean if edits still live. A later discard/choose must be explicit. |
| Export completion ownership | Revision/session snapshot used by the export; edits/undo while it runs; FSA actual close vs fallback initiated download; no export-path bytes/destination regression.                                                                                                                                                          |
| Modal/focus                 | Arbitration with Help/Settings/Export/first-run disclosure; no modal stacking; Escape means Stay; focus return only to a connected appropriate opener and no theft from successor modal.                                                                                                                                       |
| Disclosure/copy             | Exact button/state/error strings, source-read-only/export-copy/session-only truth, no filenames/count duplication/dataset values in guidance. No beforeunload/autosave guarantee.                                                                                                                                              |

**Recommended design to evaluate, not approved:** Stay; Export a copy **and remain in session**; explicit Discard and choose replacement. A cancelled or failed candidate should preserve the old session, which requires staging/adoption feasibility evidence. Leave replacement pending after initiating an unverifiable download; do not auto-replace based on a clicked anchor. If preservation requires a new engine lifetime protocol, treat that as a separate track with new authority.

WF-06 needs a signed successor contract containing explicit state names/transitions, touched hooks/seams, raw source/identity lifetime, race/reset tests, exact copy, mutation targets and rollback point. No generic “implement based on findings” brief. The runtime test matrix must cover each approved transition including clean/dirty/undo-zero/no-op, invalid draft, Stay/Esc, picker cancel, unsupported file, engine failure, stale completion, export cancel/refuse/fail/success/download-initiation, repeated intent, keyboard and all competing dialogs. Existing source-checksum/same-source guard/report/export byte tests remain unchanged.

### 4.6 WF-07 — visible range without a new grid feature

`DataGrid.tsx` owns the rendered/visible geometry; virtual items include overscan. No `packages/grid` API expansion is needed merely for a footer label. Use existing total and local scroll/viewport geometry, respecting sticky-header scroll margin, partial row intersections and dynamic resize. Never add count/fetch queries to derive the label.

Proposed text (WFD-07): `Visible rows X–Y of N`; empty `No rows`; unknown/loading `Row range unavailable`. Positions are **1-based current-view positions**, not durable base row IDs; a filtered/sorted/insertion view keeps its existing gutter/logical-ID semantics. Define X/Y as rows whose data area actually intersects the viewport, excluding sticky header and overscan; clamp to known total and allow a partly visible first/last row. If the fixture has all rows fitting, show 1–N (not the whole overscanned window).

Static text, not a new live region announcing every scroll. Existing busy/status/diagnostic/error siblings remain and footer must still fit its accepted desktop geometry. Check 0/1 rows, unknown total, page error, middle/end scroll, narrow/wide columns, filter/no-results, sort, inserted/deleted/undone rows, scroll restoration and resize; no new keyboard trap or focus target. Mutation an off-by-one/overscan implementation and ensure the intended assertion fails. Defer raw-row range navigation, paging, selection and bulk operations.

### 4.7 WF-08/09 — layout research and architectural gate

WF-08 may explore readable in-shell plan/verdict/compare cards, reduced repetition and progressive disclosure before more costly center relocation. It does not authorize changing pane width or reopening SQL sizing. Compare:

- A: current accepted shell with scoped hierarchy/density improvements;
- B: task-dominant center composition with a persistently reachable grid/record design;
- optional C only if a concrete user problem warrants it, not a framework migration.

Use fixed synthetic **long** plans, wide schemas, long contract/rule names, real failure examples, sparse/many rows, dirty session, staged B and SQL page states; not only five rows and an empty panel. Capture actual canvas bounds (whole 1600×1120 SVG or scaled fit) and same app fixture/viewport/scheme. Record layout/focus/scroll trade-offs and additional worker/query/render effects, counterbalanced human study design if selected, and uncertainty. Static screenshots are not a usability result.

WF-09 is **blocked**: center replacement contradicts ADR 0044, not a mere UI-RD-02 note. A new accepted superseding ADR (never rewriting/renumbering the old one), explicit maintainer choice, named old→new geometry/DOM/reading order/focus contracts, shared-state lifetime proof, preserved grid/provider/render/fetch pins or approved equivalent proof, and exact slice-specific specs must precede implementation. No dual hidden grids, automatic task runs, remount toggles or permanent experiment branches in production.

### 4.8 WF-O1/O2 — optional residual specifications

**WF-O1 draft indicator:** new scope/copy approval, not styling. `FilterBar` compose inputs and accepted-predicate drafts are different. Snapshot seeded inputs per editor surface; explicitly cleared or invalid input is a change. Compare input identity, not general SQL semantics. Programmatic predicate replacement (including same active count) reseeds accepted rows; applying or restoring previous list follows existing behavior. Single failure restores accepted list/draft; double failure says state is uncertain, never “previous filters remain”. Indicator does not change chips, apply semantics or auto-open latch. Candidate text `Unapplied input changes` needs approval.

**WF-O2 temporal parity:** design-only residual after WF-01 A. Before adding runtime tasks specify nested primitive type propagation through struct/list/map/union, Record full-depth tree schema ownership and hostile-input safety, and actual SQL Arrow field metadata under computed expressions/aliases; enumerate byte-exact existing raw-timestamp assertions intentionally replaced and independent raw-fidelity tests retained. No “parse any number into a date” or unsupported timezone/precision inference. Separate approved reservation and fixture/performance matrix; no engine changes implied.

## 5. Deliverables, ownership and changesets

Each selected runtime row: one bounded implementation, focused additive regression tests, synthetic fixture if dataset shape requires it, one appropriate `@assay/web` changeset, and evidence report. Worker must not edit shared root configs/ADRs/decision docs to bypass scope. Present a required amendment and stop if a new hook/type/config/package boundary is discovered. Orchestrator owns map/spec/decisions/closure updates and any expressly approved shared-config edit; reviewers inspect actual diffs, not summary intent.

Decision/copy approval must name exact replaced strings and assertions; preserve or strengthen independent literal tests, full output-set equality, and old-data safety checks. No assertion deletion, empty allowlist weakening, threshold/timeout widening, extra retries/skips or forced clicks to make a changed layout green.

## 6. Verification and evidence contract

### 6.1 Fresh baseline and full runtime gate

Run at each baseline, final worker revision, independent review and integrated revision in a **clean reserved checkout**, dependencies installed with `pnpm install --frozen-lockfile`, recorded tool versions, no stale preview servers. Use free per-checkout ports; examples below are templates, not permission to collide with another agent. Log each command/exit/count separately (or fail-fast with explicit completion evidence). A failing run stays in the record; triage it, do not hide it by retrying.

```bash
set -euo pipefail
unset ASSAY_TELEMETRY_ENDPOINT ASSAY_TELEMETRY_TOKEN ASSAY_NO_TELEMETRY
export DUCKDB=/tmp/duckdb
export ASSAY_E2E_PORT_WEB=9273 ASSAY_E2E_PORT_ENGINE=9279 ASSAY_E2E_PORT_DS=9280
pnpm format:check
pnpm lint
pnpm exec turbo run typecheck --force
pnpm test
pnpm test:coverage
pnpm exec turbo run build --force
pnpm docs:links:check
pnpm adr:index:check
CI=1 pnpm exec playwright test --retries=0
```

`--force` above is Turbo cache bypass, **not** browser `force: true`. Do not omit `pnpm test` when a config/test changes: rd-7's `telemetry-ci.test.ts` source-text pin was missed that way. Zero runtime files changed does not mean zero unit impact. Current configured `testMatch` must retain **both** theme and Help-disclosure specs; source/CI pins must require both. No broad config exception or root script rewrite under a web row.

Existing test basenames to select by actual paths at dispatch include `shell`, `a11y`, `a11y-keyboard`, `theme`, `record-keyboard`, `panel-recovery`, `grid-horizontal`, `grid-virtualization`, `grid-row-numbers`, `workbench-tasks`, `workbench-visibility`, `workbench-help`, `validation-panel`, `diff-panel`, filter/profile/history/open/export and relevant pipeline journeys. Focused runs supplement, not replace, the full suite. Preserve known pre-existing bench skip, add none. Check current names/counts; do not copy a remembered count as an assertion of fresh results.

### 6.2 Configured and restored telemetry legs

Required for App/header/CSS/modal edits and any build/config change affecting disclosure. Baseline stock build above supplies harness outputs. The existing config isolates configured specs and blocks service workers; collector requests must be aborted **before first navigation**, including in any new test. No real endpoint/token. Follow [existing telemetry verification contract](09-ux-ui-implementation-spec.md#6-verification-contract).

```bash
# In a reserved checkout, after stock build; record only presence/absence, no secrets.
env -u ASSAY_TELEMETRY_TOKEN -u ASSAY_NO_TELEMETRY \
  ASSAY_TELEMETRY_ENDPOINT=https://collector.example.invalid/ingest \
  pnpm --filter @assay/web build
# Fail if the configured endpoint is absent from generated web bundle assets.
grep -rl 'collector.example.invalid/ingest' apps/web/dist/assets >/dev/null
export ASSAY_E2E_PORT_WEB=9373 ASSAY_E2E_PORT_ENGINE=9379 ASSAY_E2E_PORT_DS=9380
CI=1 pnpm exec playwright test -c tests/visual/playwright.telemetry.config.ts --retries=0

unset ASSAY_TELEMETRY_ENDPOINT ASSAY_TELEMETRY_TOKEN ASSAY_NO_TELEMETRY
# Remove ONLY generated web output in this checkout, never source/untracked user work.
rm -rf apps/web/dist
pnpm --filter @assay/web build
if grep -rl 'collector.example.invalid/ingest' apps/web/dist/assets; then
  echo 'Configured endpoint remained in stock output' >&2
  exit 1
fi
export ASSAY_E2E_PORT_WEB=9473 ASSAY_E2E_PORT_ENGINE=9479 ASSAY_E2E_PORT_DS=9480
CI=1 pnpm exec playwright test \
  tests/e2e/telemetry.spec.ts tests/e2e/theme.spec.ts tests/e2e/a11y.spec.ts \
  tests/e2e/workbench-help.spec.ts tests/e2e/workbench-tasks.spec.ts \
  tests/e2e/workbench-visibility.spec.ts tests/e2e/shell.spec.ts --retries=0
# Add the row's own affected journeys to this restored-stock run.
```

Record endpoint presence then absence, configured discovered test names and pass counts, aborted-attempt evidence/zero delivered requests, and restored-stock counts. Never test stock-only expectations against configured output or accept a cached stock artifact as a configured build. Rebuild after every mutation/restoration; frozen prior outputs are not evidence for changed source.

### 6.3 Review and proof standards

Independent reviewer, different session/model, explicit xhigh for the preferred Luna reviewer; verify actual implementation and exact committed revision with commands. Kill at least one load-bearing mutation per new behavior, record failed assertion, restore byte-identically and prove clean tree. For complex replacement this supplements real browser failure/race cases, not a mocked guarantee of state preservation.

First try to refute each finding: a screenshot with a horizontal scrollbar is not proof of clipping, a text span is not a button, a bound type label is not proof of preserved timestamp precision. Distinguish native user interaction from synthetic `dispatchEvent` probes: React suppresses some disabled-control click handlers, so a synthetic no-op alone does **not** isolate an explicit handler guard. If claiming guard coverage, mutate that guard independently while keeping other guards constant and show the assertion fails. Native modality, disabled attributes and the application guard are separate claims.

Documentation-only rows: format, links and ADR index; inspect all links/tables/statuses and gate/decision claims. Do not launch a full runtime suite for pure prose, but explicitly state runtime was not revalidated. If a supposedly docs-only fix edits a test/config, it is not docs-only for gates.

## 7. Completion and remaining work

WF-10 closes only the approved subset with source/test/review/merged-SHA links and results. A row remains BLOCKED if tests fail, authorization/copy/ADR prerequisites are absent, or implementation is partial. Required residuals: RD-T07 (no participants/AT), unselected WF rows, any deferred temporal consumer/precision coverage, D-06/D-11 unless reopened, pipeline labels until WF-02 ships, SV-D02/03/04/05 as applicable, and SV-F01…F07 horizon gates. No next agent may turn this planning pack into “validated with users” or “all SVG features shipped”.
