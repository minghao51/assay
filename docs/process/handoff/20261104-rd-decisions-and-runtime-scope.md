# rd decisions and runtime scope (2026-11-04, delegated)

**Authority.** The user's instruction of 2026-11-04 — “proceed with next, for the unresolved decisions, lets proceed with your best judgement” — is recorded here as the maintainer's delegated decision for the rd-0…rd-2 checkpoint outputs. It resolves **SV-D08**, records a **new UI ruling (UI-RD-01)**, approves the proposed **copy**, and authorizes **SV-D01** runtime scope for **rd-3 and rd-4 only**. It does **not** authorize rd-5…rd-7, any optional **SV-D02…SV-D05** work, conservative `sv-*` Phase A, ADR edits, new dependencies, push or publication.

Read with the [design record](../../product/13-workbench-redesign-design-record.md), the [live map](20261104-svg-implementation-map.md), the [next pickup](20261104-rd-next-pickup.md) and [AGENTS.md](../../../AGENTS.md). Accepted ADRs still win; this ruling stays inside ADR 0044. rd-3/rd-4 are implemented and independently approved but **uncommitted**; integration is the next step.

## 1. SV-D08 — route and IA selected

**Alternative B — bounded task-led redesign on the existing stack** is selected, with A retained as the fallback if the first slice fails review or the maintainer reverses.

| Decision             | Recorded choice                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tasks and membership | Explore = Schema, Filters, SQL, Profile; Check = Validation, Compare; Change = Editing, History, Export; Prepare = Pipeline. Order Explore → Check → Change → Prepare; `pipeline` stays last (q-15).                                                                                                                                                                                 |
| Task switcher        | Single-select **radio group** (`role="radiogroup"` / `role="radio"`, `aria-checked`, roving tabindex, ←/→/↑/↓/Home/End), labelled `Workbench task`, described by the purpose line. **No tab/tabpanel roles.**                                                                                                                                                                        |
| Section reachability | Every task renders its own **section link list** with the existing `section-nav-<id>` test ids, plus `Grid`/`Record` workspace anchors. Every section stays directly reachable and R-07's close-focus target is unchanged.                                                                                                                                                           |
| Visibility           | **Slice-1 amendment (see §5):** every section stays reachable and mounted at all widths. The active task's sections are **marked** (accent edge) and its shell-managed sections open when the task is chosen. Conditional hiding at ≥1024px remains the target design but is deferred to its own reviewed slice so the legacy panel-expansion journeys can be migrated deliberately. |
| Section DOM order    | **Flat DOM; no task wrappers.** One deliberate within-Change reorder only: **History before Export** (review staged operations before delivery). Every other section order is unchanged.                                                                                                                                                                                             |
| Headings             | Section `h2`s unchanged; no task heading is added. The exposed heading map is per task at desktop (real browser); the DOM keeps all 12 headings.                                                                                                                                                                                                                                     |
| Context bar          | First child of the center column. Facts: `Current dataset view` · rows · columns · `N staged operations`. **No filename** (the existing UI shows only table id/counts; ADR 0025 discipline). One next action; stale is named as a consequence.                                                                                                                                       |
| Counts               | The bar never copies the verdict's count. The panel verdict and the existing section summary keep the numbers. No per-task badge.                                                                                                                                                                                                                                                    |
| Narrow               | RC-0044 narrow contract unchanged (all sections, grid promoted, sticky jump strip). No filtering, no clipping.                                                                                                                                                                                                                                                                       |
| Default task + reset | Explore by default; a new dataset session resets the active task and clears the jump-origin marker.                                                                                                                                                                                                                                                                                  |
| Optional features    | **None selected.** SV-D02 (DCR inspector), SV-D03 (dirty replacement), SV-D04 (SQL sizing), SV-D05 (overlay profile) remain OPEN and out of scope. Help stays in rd-7.                                                                                                                                                                                                               |

## 2. Copy approved

| Key                         | Approved string                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task purposes               | Explore: “Understand what is in the file: fields, filters, query and statistics.” Check: “Find quality issues or explain differences between two versions.” Change: “Make a reversible repair, review staged operations and deliver a copy.” Prepare: “Run deterministic steps and inspect gate and delivery evidence.”                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Context facts               | `Current dataset view` · `N rows × M columns` · `No staged operations` / `1 staged operation` / `N staged operations`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Next-action states (bar)    | `No contract loaded` → `Open a contract…`; `The contract could not be loaded` → `Review contract`; `Contract loaded — not checked yet` → `Validate`; `Validating the current dataset view…` → `Cancel`; `Check cancelled — the previous result is unchanged` → `Validate`; `The last check failed` → `Retry check`; `The contract does not bind to the current schema` → `Review findings`; `The current check found failures` → `Review findings`; `Verdict stale — the session's staged state changed after it was computed` → `Recheck` (+ `Review findings`); `Verdict is current — no violations` → `Export a copy…`; `Comparison stale — the session's staged state changed after it ran` → `Review comparison` (reveals/focuses the panel's existing run control); `The last comparison failed` → `Review comparison`; **`The comparison needs attention` → `Review comparison` (added at integration — see the amendment below)**; `Comparing datasets…` → `Cancel` |
| Stale sentence (validation) | “This verdict is **stale** — the session's staged state changed after it was computed, so it may no longer reflect the current dataset view. Re-validate for a fresh result.”                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Stale sentence (diff)       | “This row diff is **stale** — the session's staged state changed after it ran, so it may no longer reflect the current dataset view. Re-run for a fresh comparison.”                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Jump return                 | `Back to findings` (app-local chip shown only after a validation/diff `Show row`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

These replace the previous wording only where the table says so; every other string (R-03, R-05, R-08, R-12, R-14 purposes, R-15, R-16, export dialog, profile hints) is unchanged.

**Copy amendment at integration (2026-11-04, recorded — not a re-decision).** One truth-table state was not enumerated when the copy was approved: the comparison's `binding-errors` state (the comparison cannot bind its keys to the current schema). The implemented derivation needs a truthful sentence for it, and the independent reviewer approved the implementation. The integration orchestrator therefore records the missing string explicitly rather than absorbing it silently: `The comparison needs attention` → `Review comparison` (neutral tone, no count, no filename, no auto-run; it reveals and focuses the panel's existing run control). No other string was added or changed.

**Enforcement (so this cannot recur).** The approved table above is now mirrored by a machine-checked list, `APPROVED_COPY` in `apps/web/src/workbench/next-action.test.ts`, which drives the **full input cross-product** and asserts set equality in both directions: every derived state/action must be in the approved list (no unenumerated copy can ship) and every approved entry must be produced by a reachable state (no dead copy). Adding a state, an action or a sentence now requires updating this table **and** that list in the same change. A full audit at integration found this one unenumerated row and nothing else: all 14 reachable state/action pairs in the code are accounted for here, and the four task purposes, the context facts, the staged-operation variants, `Back to findings` and every panel stale sentence match the approved strings byte-for-byte.

## 3. UI-RD-01 — UI ruling recorded

Authorized under the delegated decision, limited to this redesign:

1. Group the twelve sections under four task choices with the membership in §1; nav order is the task reading order, not the construction order.
2. Task framing at ≥1024px via the pane `data-task` attribute (active-task marking + opening its manageable sections); **no section is hidden in this slice**; <1024px unchanged. Conditional visibility is deferred (§5).
3. Radio-group semantics and roving tabindex for the task switcher; no tab/tabpanel claim.
4. Task-scoped section links + workspace anchors; `section-nav-<id>` remains the R-07 focus target.
5. Flat DOM with the single within-Change `History` before `Export` reorder; no other DOM reorder.
6. Per-task heading exposure in the real browser; the DOM retains the complete 12-heading map.
7. R-14 purposes, summaries, q-15 `pipeline`-last, and ADR 0044 geometry are retained.
8. The dataset context bar adds no filename and no copied count.

No ADR is superseded: the shell remains tools-left, persistent grid, record dock, 1024×700.

## 4. SV-D01 — runtime scope (rd-3 + rd-4 only)

**Rows authorized:** `rd-3` (presentation seam + structure) and `rd-4` (repair → stale → explicit recheck journey), executed as one bounded change in this episode because rd-4 depends on the same seam and test migration; each still gets independent review.

**Reserved files**

- New: `apps/web/src/workbench/tasks.ts`, `next-action.ts`, `TaskNav.tsx`, `DatasetContextBar.tsx` and their focused tests.
- `apps/web/src/App.tsx` (integration, app-local state, task-aware reveal, context bar wiring, copy).
- `apps/web/src/index.css` (scoped classes only; no token changes).
- `apps/web/src/validation/ValidationPanel.tsx`, `apps/web/src/diff/DiffPanel.tsx` — **copy strings only** for the approved stale sentences.
- Tests: deliberate migrations of `App.shell.test.tsx`, `App.headings.test.tsx`, `App.section-purposes.test.tsx`, `App.section-summaries.test.tsx`, `App.memo-probe.test.tsx` (only if the seam changes render identity — otherwise untouched), `shell-geometry.test.ts`, `tests/e2e/shell.spec.ts`; new `tests/e2e/workbench-tasks.spec.ts`; locator-only updates to affected e2e specs.
- One `.changeset/*.md` for `@assay/web`.

**Forbidden:** any `packages/**`, sessions hooks, pipeline session, grid/record/export/profile/SQL/schema logic, telemetry content/events, CLI/VS Code, root configs/lockfiles, ADRs, docs owned by the orchestrator outside the records named here, new dependencies/formats, and any optional/horizon feature.

**Rollback:** revert the one bounded change (no data, URL, router or storage migration exists). Baseline: this tree at `bba491a` plus the untracked docs (no production code changed by rd-0…rd-2).

**Gates:** `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, coverage floors unchanged, `docs:links:check`, `adr:index:check`, affected Playwright specs (shell, a11y, a11y-keyboard, record-keyboard, nested, pipeline journeys) on rebuilt output, plus the configured/restored telemetry protocol when App/CSS changed. Independent reviewer on a different model/session; no push.

**STOP conditions:** a gate/tooling failure, an ADR conflict, an unapproved file, a state-preservation failure, or a data/byte semantic change. Preserve work; do not lower thresholds or improvise permission.

## 5. Slice-1 amendment — best judgement (2026-11-04)

Three implementation facts changed the mechanics, not the goal. They are recorded here rather than silently absorbed:

1. **Conditional task visibility is deferred.** Hiding inactive sections at ≥1024px would have required rewriting the panel-expansion helper and a large set of legacy journey assertions (the helper opens every managed section; hidden toggles are not clickable) in the same change that introduces the IA. That would make the test migration the dominant risk of the first runtime slice. The accepted slice therefore **marks** the active task's sections and opens its shell-managed sections when chosen, while every section stays reachable (ADR 0044). The target design in the prototypes is unchanged; conditional visibility is the next reviewed slice (`rd-3b`, blocked on its own explicit scope) with a planned helper/migration.
2. **Flat DOM, one reorder.** No task wrappers were added. The only DOM order change is `History` before `Export` inside Change, so staged operations are reviewed before delivery.
3. **Grid viewport reserve.** The context bar is real chrome above the grid inside the center column. The `.grid-viewport` reserve moves from 280px to 360px so the 1024×700 first-paint contract (whole footer in frame) holds; the clamp floor/ceiling (280/640) and pane/center geometry are unchanged. `shell-geometry.test.ts` and `shell.spec.ts` pins were migrated deliberately.

Also recorded: the context bar shows **no filename** (the shell exposes only table id/counts), and its Export action opens the Export section before the existing dialog (the dialog renders inside that section body). The diff action is labelled **Review comparison**, because the comparison's key state lives in the panel and the bar must not duplicate it.

## 6. Integration record (2026-11-04, integration orchestrator)

**Commit authority.** The maintainer's instruction at the end of the implementation episode — the
paste of §5 of the [next pickup](20261104-rd-next-pickup.md) — directs the orchestrator to inspect
the working tree, obtain commit authority, commit with a Conventional Commit and **not push**. That
instruction is the authority recorded here; it is bounded to integrating the already approved
rd-3/rd-4 slice and its design records. No push, publication, visibility change, dependency, ADR
rewrite or new runtime scope was authorized, and none happened.

**What was integrated**

| Commit    | Content                                                                                                                                                                                                              |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `d441fc3` | `docs(redesign)`: the SVG board pack (`assests/`), product/11–13 and the five 2026-11-04 handoff records. Additive docs only — no runtime file in this commit.                                                       |
| `51ff36e` | `feat(web)`: the rd-3/rd-4 slice — `workbench/*`, `App.tsx`, `index.css`, the two stale-copy panel edits, the migrated pins, the new e2e spec, one changeset (`@assay/web` minor) and the handoff active paragraphs. |

**Tree check before committing.** Every touched path was inside the §4 reservation. Rejected as
_not_ part of the slice: nothing — the untracked `assests/` pack, the product/11–13 records and the
2026-11-04 handoff records are the rd-0…rd-2 checkpoint's own deliverables, and they are referenced
by the map/design record, so they were committed as the docs commit rather than left untracked
(leaving them out would break `docs:links:check` in a clean checkout). No `packages/**`, root
config, lockfile, ADR, dependency or CLI/VS Code file changed.

**Merged verification** was re-run from a clean worktree at `51ff36e`, not reused from the
implementation episode: see [map §6.4](20261104-svg-implementation-map.md) for the per-gate table
(including the configured-telemetry and restored-stock legs).

**Still not done / not authorized:** rd-3b (contract prepared, awaiting explicit scope approval),
rd-5…rd-7, optional SV-D02…SV-D05, run-origin metadata, any human usability study (RD-T07 remains
unsatisfied), and any push/publication.

## 7. rd-3b authorization (2026-11-04, maintainer)

**Instruction.** The maintainer approved the prepared slice: _"approve on the rd-3b, lets proceed
with that."_ That is the explicit scope approval the [rd-3b contract](20261104-rd3b-conditional-visibility-contract.md)
§11 asks for, and it is bounded to exactly that document.

**Authorized scope (no widening without a new instruction):**

1. The two `@media (min-width: 1024px)` rules in §2.1 — hide sections outside the active task and
   hide inactive nav groups, both `display: none`, both keeping every section mounted.
2. The single focus guard in §2.3 (focus the checked radio when focus would otherwise sit inside a
   newly hidden section).
3. The task-aware e2e helper rewrite (§4.2) and the measured migration of the 9 single-task and 10
   cross-task specs (§4.3), plus the unit/CSS pins (§5) and the new `workbench-visibility` browser
   spec with its three negative controls (§6).
4. The file reservations in §7 and one `.changeset/*.md` for `@assay/web`.

**Still forbidden:** the §3 invariants (no `packages/**`, sessions hooks, engine/grid/export bytes,
copy, telemetry semantics, thresholds), the §10 stop conditions, any push/publication, and any
rd-5/rd-6/rd-7 or SV-D02…SV-D05 work.

**Baseline:** `d85c995` (clean tree; rd-3/rd-4 CLOSED, merged-verified, copy table enforced).
**Dispatch model:** one web writer (`deepseek-v4.1-flash`), then an independent reviewer
(`openai-codex/gpt-6-luna` xhigh) who did not implement it. Workers do not commit to `main` and do
not push.

**Delivered and CLOSED (2026-11-04) — merged `0b22024`.** One squashed reviewed commit plus one
`@assay/web` minor changeset; independent `gpt-6-luna` xhigh review returned **approve** after its own
full gate run and its own mutation-and-restore falsification. Gates: [map §6.5](20261104-svg-implementation-map.md);
runtime and review record: [design record §10](../../product/13-workbench-redesign-design-record.md).
Two things about the delivery are recorded rather than glossed: the focus guard's browser negative
control proved impossible (every browser-reachable task change already moves focus), so the branch is
proved by a layout-stubbed unit test with a visible-section control instead; and four task labels in
the contract's migration table were wrong (Corrected in the contract §4.3). The review's one
user-facing consequence — persistent grid-edit feedback lives in the hidden Editing section while
Explore is active — is recorded as **rd-3c**, PROPOSED and **not authorized**.

## 8. rd-3c authorization (2026-11-04, maintainer)

**Instruction.** The maintainer selected option A for the feedback gap recorded from the rd-3b
review: _"lets proceed with A"_.

**Authorized scope — exactly the [rd-3c contract](20261104-rd3c-edit-feedback.md):** when the durable
edit error becomes non-null, reveal the Editing section through the existing `revealSectionFromNav`
seam (activate Change, expand, scroll) **once per error**, **without moving focus**, skipping the
no-op case, plus the unit pin, the browser assertion and its negative control, and one changeset.

**Explicitly out of scope:** the pending-change detail stays task-local (the context bar's staged
count is the always-visible summary); a collapsed pane rail is respected; no copy, test id, state
field or `useEditingSession` change; no `packages/**`, grid/session/engine/export bytes, telemetry,
dependency or threshold change; no push. **Baseline:** `5397b9b`.

**Delivered and CLOSED (2026-11-04) — merged `acc8aff`.** The first implementation did not actually
scroll (the reviewer's Critical: a programmatic reveal never gets a link's `href` scroll), fixed with
an opt-in `{ scroll?: true }` seam option plus a seq-keyed render-then-scroll effect; the second round
was the release-note accuracy. Independent `gpt-6-luna` xhigh review: two request-changes → **approve**.
Gates and the CDN finding: [map §6.6](20261104-svg-implementation-map.md); runtime record:
[design record §11](../../product/13-workbench-redesign-design-record.md).

**Why A was chosen:** it uses an existing seam, adds no copy and no second surface, and cannot
duplicate the message; the rejected alternatives were a grid-footer mirror (two render locations) and
a context-bar sentence (would need a copy decision and break the one-action rule).

## 9. hf-1 authorization — deterministic e2e extensions (2026-11-04, maintainer)

**Instruction.** _"We should also fix the wasm issues."_ Scoped to the finding in
[map §6.6](20261104-svg-implementation-map.md): the web e2e open path autoloads the DuckDB-WASM
Parquet/JSON extensions from `extensions.duckdb.org`, so browser gates inherit an external dependency.

**Measured before authorizing** (probe spec, fresh context, CDN blocked): Parquet and JSONL opens
fail; CSV is unaffected; serving the **already-committed, checksum-pinned** binaries from
`apps/vscode/assets/duckdb/*.pinned` through a Playwright route makes both open `ready` with the CDN
blocked. The desktop surface already vendors exactly these files and blocks the host, so this reuses
an existing vetted asset rather than introducing one.

**Authorized scope (test harness only):**

1. A shared e2e fixture that intercepts `https://extensions.duckdb.org/**` before any navigation and
   fulfils it from the pinned binaries (`application/wasm`), aborting unknown paths loudly so a future
   extension dependency fails visibly instead of silently reaching the network.
2. Migrating the e2e specs to that fixture so **every** browser context gets it (the interception is
   per-context; a helper-only route would miss the specs that `goto` directly).
3. A spec that proves Parquet **and** JSONL open with the real host unreachable, so the determinism
   claim is pinned rather than assumed.

**Forbidden:** any product/runtime change (no engine, web, bundle, CSP or config change); changing
what production does; vendoring new binaries (reuse the committed ones, do not "refresh" them);
touching `packages/**`, `apps/**` non-test source, thresholds, timeouts or allowlists; push.
**Out of scope by decision:** bundling the extensions into the web build for offline parity — that is
a product decision (bundle size ≈ 3.6 MB, CSP/supply-chain review) and is NOT authorized here.

**Baseline:** `9c947a4`. **Rollback:** revert the one commit (tests only).

**Delivered and CLOSED (2026-11-04) — merged `ea38938`.** Tests-only; one squashed reviewed commit, no
changeset (no package behaviour changes). Independent `gpt-6-luna` xhigh review: **approve**, with its
own mutation (same-length zero bytes → real-open tests failed; restored byte-identically). Merged gates
([map §6.6](20261104-svg-implementation-map.md)): unit 236/3511, coverage unchanged, **two consecutive
full browser runs at 237 passed + 1 skipped, 0 failed** — the browser gate is deterministic for the
first time in this programme. Production behaviour is untouched: the web app still autoloads from the
CDN, and web bundling for offline parity remains an unauthorized product decision.

## 10. rd-5 authorization — scope-first (2026-11-04, maintainer)

**Instruction.** _"on the current block, I think we can proceed with your recommendations"_ — the
recommendation was to take **rd-5** next and scope it before any code, as with rd-3b/rd-3c.

**Scope being authorized:** `rd-5 — compare and reviewed export`, bounded to confirmed-key A/B
context before row findings, A-only navigation, and whole-current-dataset delivery continuity with
the existing diff/export semantic, report-byte and CLI-agreement tests preserved. No subset export,
no second dataset view, no engine/domain/protocol change.

**Decision to make inside the scope (record the choice before dispatch):** whether the context bar's
diff action stays `Review comparison` (focuses the panel's existing run control, because key state
lives in the panel) or becomes a one-click rerun, which would require a scoped panel/session change.
**Default recommendation:** keep `Review comparison` and close the gap only if the journey test shows
it is a real friction — that avoids widening a session-hook lane the invariants protect.

**Sequencing:** hf-1 (§9) is executed first so rd-5's gate evidence is not polluted by the CDN
flake. rd-6/rd-7 and SV-D02…SV-D05 remain unauthorized.
