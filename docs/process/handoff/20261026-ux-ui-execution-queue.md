# UX/UI Execution Queue — visual polish and engine showcase

**Authored 2026-10-26; current state refreshed 2026-10-29.** The authoring and 2026-10-28
continuation sentences below are historical. Current: **uxv-0 baseline recorded 2026-10-26 at
`7d8e1ca`**; ug-1/2/3/7/8/9/13 are CLOSED; runtime baseline recorded at `385649b` (195 unit
files / 3089 tests, e2e 185 passed + 1 skipped, coverage 88.08/82.24/89.08/89.60; docs 116/0 at
that revision). Runtime frontier: **ug-14 (Shell)** and **ug-4 (Grid)**. **uxv-1 is eligible only
with an exclusive CSS/theme-test reservation**; uxv-2…5 are dependency-gated; uxv-6 is deferred.
This queue owns **uxv-0…uxv-6**; [ug-1…ug-23](20261026-usability-queue.md) retain their feature
ownership. Requirements/copy/geometry: [implementation spec](../../product/09-ux-ui-implementation-spec.md).
Rationale: [plan](../../product/08-ux-ui-engine-showcase-plan.md). Start here:
[pickup prompts](20261026-ux-ui-pickup-prompts.md).

## 1. Dispatch rules

- First preserve/integrate the documentation pack; the authoring checkout is not a clean-main
  baseline. uxv-0 is verification-only preflight, **not** an exception allowing feature claims
  before baseline. Historical counts, source probes and mockups do not satisfy it.
- Follow [operating-model](operating-model.md): worker → independent reviewer → orchestrator;
  one bounded row per dispatch, six gates plus spec-required checks, Conventional Commit and
  changeset for runtime changes as required. Workers do not edit shared docs/root configuration.
- Closed rows are not dispatchable: ug-1/2/3/7/8/9/13 are done. The current runtime frontier is
  **ug-14**, then **ug-4**. **uxv-1** may start only after the orchestrator grants an exclusive
  reservation for `index.css` and the theme/telemetry tests; do not improvise a styling batch or
  re-run ug-7's landed recovery seams.
- Preserve the original queue's lane order. New visual work is a separate serialized Visual
  lane. No concurrent writers to `index.css`, App shell, shared test helpers or shared e2e specs.
  Isolated worktrees prevent accidental writes, not semantic conflicts: orchestrator holds the
  file reservation and inspects integration diffs. ug-6 spans Shell/Grid; ug-12/19 share CSS.
- A row is eligible only when prerequisites are integrated/green and its files are reserved.
  A design-only/decision row is not authorization for runtime code. On STOP, preserve work,
  report the scope conflict and leave the row open/blocked; do not weaken acceptance.
- No publication, remote billing changes, new dependencies, telemetry events, real collectors,
  DOM reorder, engine/grid protocols, new input formats or export/report byte changes.

## 2. Live queue

| Task                                               | Scope / done-when                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Status / narrative                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **uxv-0 — record baseline**                        | Verification-only; clean `main`, six core commands + coverage/docs/ADR checks from spec §6. Record commit, clean status, environment names, tool versions, ports, log paths, exit codes, counts and coverage. Baseline must correspond to the integrated docs revision before the first feature claim.                                                                                                                                                                                                                                                                               | **RECORDED 2026-10-26 at `7d8e1ca`** (clean tree; docs pack integrated in `7d8e1ca`). Node 24.22.1, pnpm 11.26.0, DuckDB 1.5.5; stock telemetry env unset. Six gates all exit 0; unit **191 files / 3029 tests passed**; e2e **175 passed, 1 skipped**; coverage **87.85% stmts / 81.98% branch / 88.63% funcs / 89.31% lines**; docs links **116/0**, ADR index **46**. Logs: `/tmp/assay-ux-uxv-0-orchestrator/`. ug-1 at `e92c0dd`, ug-2 at `8e5fd62`, ug-7 at `9c29da4`; merged gates 193f/3056t, e2e 180p+1s, coverage 87.98/82.08/88.89/89.46; next ug-3/ug-8. |
| **uxv-1 — repair theme completeness**              | R-09. `apps/web/src/index.css`, telemetry theme/component tests, `tests/e2e/theme.spec.ts`, `a11y.spec.ts`, `tests/visual/telemetry-disclosure-theme.spec.ts` and its isolated config. Fix undefined surface usage; prove real Settings/disclosure readable in both schemes; configured disclosure leg and restored stock leg per spec §6. No consent/storage/event changes. `fix(web):` + changeset.                                                                                                                                                                                | **OPEN — ELIGIBLE (2026-10-29) only with an exclusive CSS/theme-test reservation.** uxv-0 and the ug prerequisites are met; do not start without the orchestrator's reservation because ug-14/ug-23 (Shell) and ug-18 (Grid) touch App/CSS/FilterBar seams.                                                                                                                                                                                                                                                                                                          |
| **uxv-2 — unify visual tokens and named controls** | R-10 and spec §4 inventory. `index.css`, Open/example/section-toggle classes in `App.tsx`, telemetry Settings/disclosure classes, export-dialog action/input classes, related tests. Adopt spacing/type/control/radius tokens on that bounded list; primary/secondary/focus states; no global button selector or grid/schema/filter restyle. Screenshot review and computed-style pins in both schemes. `style(web):` + changeset.                                                                                                                                                   | **OPEN — dependency-gated:** after uxv-1 (ug-3/ug-8 are CLOSED). **Also owns the two unstyled classes ug-8 introduced**: `.edit-overlay-explanation` (`edit/EditToolbar.tsx`) and `.export-staged-count` (`export/ExportDialog.tsx`) currently render with default body styling — adopt tokens/typography for them here without restyling the panels broadly. Reserve all touched App/CSS/panel files.                                                                                                                                                               |
| **uxv-3 — improve desktop canvas**                 | R-11. `index.css`, scoped classes on existing header/open/status nodes in `App.tsx`, shell/geometry/theme tests. Implement spec §4 widths/header/grid-height targets; preserve 28px rows, scroll ownership, grid DOM/memo behavior and 900px fallback. No SQL resizing or section relocation. `style(web):` + changeset.                                                                                                                                                                                                                                                             | **OPEN — dependency-gated:** after uxv-2; confirm Shell/CSS/Grid seams are quiet before claiming. **Note (2026-10-29):** ug-13 landed two-line section headers (`.workbench-section-text` / `.workbench-section-purpose` in `index.css`, title above purpose) — keep the header-height targets compatible with them and do not restyle the purpose line beyond tokens.                                                                                                                                                                                               |
| **uxv-4 — explain the engine honestly**            | R-12. `App.tsx`, `lib/app.ts`, idle-copy tests and a focused smoke pin; minimal existing-class use only. Exact static idle explanation/supporting sentence from spec §2; no live badge, new metrics, transport or telemetry. `feat(web):` + changeset.                                                                                                                                                                                                                                                                                                                               | **OPEN — dependency-gated:** after uxv-3 (ug-3 is CLOSED). Reserve the idle-copy/Shell seam.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **uxv-5 — deliver and rehearse showcase pack**     | R-13. Orchestrator-owned docs deliverable at `docs/product/10-ux-ui-demo-rehearsal.md`, referencing the committed nested fixture plus M5/M6 generator/function source paths and reproducible commands (spec §5); validation/diff inputs are per-run temporary files, never newly committed data. Read-only browser/CLI rehearsal on built output; record commands, observed counts, commit and gaps. Two chapters (CLI continuity within Chapter 2), honest overlay/export/CLI distinction, privacy and performance caveats. No new data/publication. `docs:`; no runtime changeset. | **OPEN — dependency-gated:** after uxv-1…4 (ug-3/ug-7/ug-8 are CLOSED). Worker may supply a draft/evidence in `/tmp`; orchestrator writes shared docs. No broad usability-queue closure claim.                                                                                                                                                                                                                                                                                                                                                                       |
| **uxv-6 — decide SQL sizing direction**            | Design-only optional follow-up to UX-D2: specify adjustable pane limits, minimum grid width, keyboard resize/reset, below-breakpoint behavior, test plan, and exact changes to product/05 if proposing to exceed its pane bounds. No runtime edits; accepted-ADR changes require architect escalation.                                                                                                                                                                                                                                                                               | **DEFERRED / NOT DISPATCHABLE AS CODE.** Maintainer must request/approve the spec amendment; not a dependency of ug-1 or uxv-1…5.                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## 3. Requirement ownership and non-duplication

- The ug queue owns R-01…R-08, R-14 and R-15. Its remaining rows continue to own editing/clipboard/history hints,
  row identity/focus, panel purpose/state summaries, filter UX, validation on-ramp, pipeline
  continuity, open recovery/progress/drop and nav-only ordering. This queue does not reassign them.
- This uxv queue owns R-09…R-13 only. R-16 is authorized by the UX-D1 Option C ruling (2026-10-30)
  and owned by ug-10; it is not owned here. Reference mockups depict an assembled target, not
  permission for a visual worker to implement ug-13/ug-17 summaries or other unclaimed features.
- **ug-10 was blocked by UX-D1; RESOLVED 2026-10-30 (Option C).** The amended row carries R-16's
  honest-labeling contract (base-as-opened hint + staged-changes note); the overlay-aware profile
  is a separate planning-only engine candidate and must not be smuggled in as “copy only” or an
  engine change. ug-10 landed at `f667a87`, ug-16 at `3b494f5` and ug-20 at `5bad2c3`; the
  Panels lane is complete and unrelated Shell/Grid/Visual work can continue.
- Changes to known dataset-shape behavior still require minimal golden fixtures/regression pins.
  These UI-only rows do not authorize regenerating all committed Parquet fixtures as a rider.

## 4. Verification and review evidence

Full command/environment protocol is spec §6; do not replace it with only focused tests. Visual
coverage includes idle, opening, open error, ready, SQL outcomes, staged edits, validation stale,
crash and export at the supported viewport/scheme matrix. Deterministic computed-style,
geometry, focus and behavior assertions gate CI; screenshots support independent visual review,
not brittle pixel-exact baselines.

For uxv-1, a mutant restoring the undefined white fallback must fail dark contrast evidence.
For uxv-2, remove token adoption on a named primary/secondary control and demonstrate the style
pin fails. For uxv-3, restore the 72rem cap and demonstrate wide-screen geometry fails; rebuild
mutated/restored source before browser checks. For uxv-4, remove the explanation and show the
copy pin fails. Reviewer verifies scope, copy/privacy, changed files, changeset and no leftover
mutants; never fixes the author's runtime code while approving it.

Append evidence to the corresponding row after each transition (claim → review → integrated):

```text
Owner/session and role/model:
Base commit / task worktree / reserved paths / ports:
Worker commit / changeset:
Requirement IDs and acceptance results:
Gate log paths + command exit codes + unit/e2e counts + coverage:
Screenshots (scheme/viewport/state) + keyboard/axe results:
Mutation and restoration evidence:
Independent reviewer session/model / verdict / required fixes:
Integrated commit / merged-main checks:
Remaining blockers / next eligible row:
```

Keep detailed logs in `/tmp`; paste concise evidence and durable commit IDs into living rows.
Do not rely on temporary files as the only completion record. For docs-only uxv-5, use doc checks
and independent claim/source review plus its required rehearsals; do not claim a new runtime
baseline merely because a doc review passed.

## 5. Decisions, integration and handoff

No UX-D1/UX-D2 decision had been recorded when this queue was authored. The spec is sufficient to
start bounded existing tasks after baseline, not sufficient to bypass those explicit decisions.

**2026-10-30 update — UX-D1 RESOLVED (Option C):** the maintainer ruled Option C in
[20261029-ux-d1-amendment.md](20261029-ux-d1-amendment.md) §7. ug-10 is authorized with the
amended R-16 honest-labeling contract (spec §2), and the overlay-aware profile is chartered as a
separate planning-only engine candidate
([20261030-overlay-profile-candidate.md](20261030-overlay-profile-candidate.md)). ug-10 landed at
`f667a87`, ug-16 at `3b494f5` and ug-20 at `5bad2c3` — the Panels lane is complete. UX-D2/uxv-6
remain design-only and unchanged.
Do not mark any row green until independent review and merged verification finish. Integration
resolves ug-2/ug-7 `App.tsx` overlaps and re-runs merged gates; update the matching queue row,
`handoff.md` index/changelog and relevant roadmap/product narrative without duplicating history.

The planning pack itself is docs-only and not a feature claim. Its status must remain distinguishable
from ug/uxv implementation, current local gates, remote CI and human launch approvals.

### Planning-pack review record (2026-10-26)

A fresh read-only `openai-codex/gpt-6-luna` reviewer at `xhigh` requested three corrections:
remove stale queue-authoring instructions, reconcile the two-chapter script, and distinguish
M5/M6 temporary generated inputs from committed fixtures. Those corrections landed in the
working docs; a fresh independent re-review returned **VERDICT: approve — docs pack only**.
The reviewer independently ran docs links (116 files, 0 broken links) and inspected the current
source/helper and queue/spec/prompt contracts. It did not claim runtime gate or rehearsal proof.

Parent verification: Prettier on all eight Markdown pack/index files; docs links **116/0**;
ADR index **46**; `git diff --check`; four SVGs parsed as XML and rendered in Chromium with no
clipped text, scripts or external references; spec §5 Node 24 generation command succeeded.
Active Markdown diagnostics reported no warnings/errors. The Node command generated only fresh
local synthetic inputs; it was not a browser/CLI rehearsal or source change. Render artifacts
are ephemeral in `/tmp/assay-ux-reference-review/` and are not required for future pickup.

**Historical authoring status (2026-10-26/28; superseded — kept only as record):** the
documentation was uncommitted when reviewed; it was integrated at `7d8e1ca`, followed by uxv-0
and ug-1/ug-2/ug-7. The 2026-10-28 continuation integrated ug-7 evidence follow-up `8367fbd` and
ug-3 `5253c06`; ug-8 `cb64c32` was then approved and merged-verified after test-only gd-1
`b6fb78a`. No uxv runtime row was claimed in that continuation. Current status lives in the
header and live rows above; the older "merged gate blocked / not closed" text described that
dated checkpoint only and is replaced by this summary. These local records imply no
remote/publication approval.
