# rd-3c — durable edit feedback from any task: contract

**Status: CLOSED 2026-11-04 — merged `acc8aff`, independently approved, gates in [map §6.6](20261104-svg-implementation-map.md), runtime/review record in [design record §11](../../product/13-workbench-redesign-design-record.md).** Authorized by the maintainer ("lets proceed with A") and delivered with three reviewed deviations, recorded in §8 below.

## 1. The defect this fixes (observed, not hypothetical)

rd-3b hides the inactive tasks' sections. The durable edit feedback lives in the Editing section
(Change):

| Surface                                                       | Rendered in                           | Exposed from Explore?                             |
| ------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------- |
| `grid-edit-error` (client-side typed-input rejection)         | grid footer, centre column            | **yes**                                           |
| `edit-error` (engine rejection, cast refusal, non-applied op) | `EditToolbar` inside Editing (Change) | **no**                                            |
| `pending-changes` detail                                      | same toolbar                          | **no** (the bar's `N staged operations` count is) |
| `edit-live-region`                                            | app shell, outside every section      | announced only (transient, AT)                    |

Evidence in-tree: `tests/e2e/grid-editing.spec.ts` "engine rejection…" (a DATE cell given
`not-a-date'; DROP TABLE x --`) had to gain `activateTask(page, 'change')` in the rd-3b migration
before it could assert `edit-error` — i.e. before rd-3b that message was visible from Explore, and now
a sighted user editing a temporal/typed cell from Explore gets a **silent revert**.

## 2. Required behaviour (exact)

When the **durable** edit error transitions to a non-null value (`editError` from
`useEditingSession`):

1. **Reveal the Editing section through the existing seam** — `revealSectionFromNav('editing')`,
   i.e. activate **Change**, expand the section, scroll the pane to it. No new reveal mechanism, no
   new copy, no new component.
2. **Do not move focus.** `revealSectionFromNav` does not focus; do not add a focus call. _(Corrected
   at closure: "the grid keeps focus" was inaccurate — the reveal adds no focus call, but the
   commit's own editor unmount leaves `document.activeElement` on `<body>` (pre-existing grid
   behaviour). The browser pin asserts only "focus is not moved into the pane".)_
3. **Fire once per error.** Keep a ref of the last revealed error; reset it to `null` when `editError`
   becomes `null` (a new attempt/commit clears it in the session hook). Do **not** re-reveal on
   unrelated re-renders, on mount with a pre-existing error, or while the error is unchanged — the
   user must be able to return to Explore with the error still on record without being yanked back.
4. **No-op when it would change nothing**: if Change is already active and the Editing section is
   already open, skip the reveal (no scroll jitter).
5. **Nothing else changes** (corrected at closure: one **transient app-local** `{ id, seq }` scroll
   request is required to sequence the render-then-scroll effect, and the reviewer accepted it as
   plumbing rather than durable/session state; the release note says so). Same messages, same
   sources, same clearing behaviour; the live region and
   `grid-edit-error` are untouched; there is no second copy of the message, no new test id, no new
   state field, no change to `useEditingSession`.

Out of scope by decision: the **pending-change detail stays task-local** (the context bar's staged
count is the always-visible summary); a collapsed pane rail is respected (the user chose to hide the
tools — do not auto-expand it).

## 3. Why an effect in `App.tsx` and not the hook

`useEditingSession` is a protected lane (no session changes) and already exposes `editError`. The
shell owns navigation and already owns the reveal seam, so the trigger belongs in the shell. The
effect reads `editError`, `activeTask` and the Editing section's open state only.

## 4. Files reserved

- `apps/web/src/App.tsx` — the effect (and the doc comment that currently says conditional exposure
  only hides).
- `apps/web/src/App.column-ops.test.tsx` — unit pin (it already drives real App-level engine
  rejections: "The engine rejected this edit", "No cast was applied", "already exists").
- `tests/e2e/grid-editing.spec.ts` — the engine-rejection test asserts the automatic reveal from
  Explore, and a negative control (a successful edit never switches tasks).
- One `.changeset/*.md` for `@assay/web`.

**Forbidden:** any `packages/**`; `sessions/**` (including `useEditingSession`); grid, record, export,
profile, SQL, schema or pipeline logic; `workbench/*` modules; telemetry; root configs/lockfiles;
ADRs; dependencies; any copy change; thresholds/timeouts/allowlists; push.

## 5. Tests (done-when)

**Unit (`App.column-ops.test.tsx`):**

1. An engine rejection switches the pane to Change (`task-change` `aria-checked="true"`,
   `.workbench-tools[data-task="change"]`) and the Editing section is expanded — asserted from the
   **Explore default**, with `edit-error` text unchanged.
2. Negative control: a **successful** edit leaves the task on Explore (no reveal), and a no-op
   re-commit does not reveal either.
3. The same error does not re-reveal: switch back to Explore while the error persists and assert the
   task stays Explore (the ref guard). Success-then-failure reveals again after the error cleared.

**Browser (`grid-editing.spec.ts`):**

1. From Explore (default, no `activateTask`): commit the hostile DATE draft → `task-change` becomes
   checked **automatically**, `edit-error` is `toBeVisible`, `grid-edit-error` stays empty, the live
   region carries the value-free class, the hostile draft is never echoed, the grid still has focus
   (`document.activeElement` is not inside the pane), and the previous view is restored.
2. Negative control in the same spec: a successful typed edit and the "Enter unchanged" no-op both
   leave `task-explore` checked.

**Gates:** the full map §6 sequence from the committed revision in a clean worktree — format, lint,
typecheck (`--force`), unit, coverage, build (`--force`), full Playwright with `DUCKDB=/tmp/duckdb`
and fresh ports, docs links, ADR index — **plus** the configured and restored telemetry legs, because
`App.tsx` changes. No threshold, timeout or allowlist change.

## 6. Review focus

The reviewer must confirm: the reveal happens **only** on a durable error transition; focus is never
moved; no copy/test id/state duplication; `useEditingSession` untouched; the pending-change detail and
the rail stay out of scope; and one mutation (e.g. remove the ref guard, or make the effect fire on
success) is shown to fail the intended test, then restored byte-identically and rebuilt.

## 7. Rollback

`git revert <one commit>` — restores rd-3b behaviour exactly (error stays in the hidden section). No
storage, URL or router state.

---

## 8. Closure record (2026-11-04)

| Item                 | Record                                                                                                                                                                                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Merged commit        | `acc8aff` — one squashed reviewed commit, one `@assay/web` **patch** changeset                                                                                                                                                                                                                                                 |
| Baseline             | `5397b9b`                                                                                                                                                                                                                                                                                                                      |
| Implementation       | one web writer, `opencode-go/deepseek-v4.1-flash`, isolated worktree; no commit to `main`, no push                                                                                                                                                                                                                             |
| Independent review   | `openai-codex/gpt-6-luna` xhigh, separate session — two **request-changes** rounds → **approve**                                                                                                                                                                                                                               |
| Round 1 finding      | **Critical:** the seam does not scroll (a programmatic reveal never gets the anchor's `href` scroll), so the message could remain off-screen. Fixed with an opt-in `{ scroll?: boolean }` (default `false`), a seq-keyed render-then-scroll effect, and a recorded-request assertion; the reviewer re-ran the mutation itself  |
| Round 2 finding      | the changeset claimed "no new state field" while `revealScroll` exists → wording corrected to "no new durable or session state"; reviewer confirmed the delta was documentation-only and approved                                                                                                                              |
| Merged gates         | [map §6.6](20261104-svg-implementation-map.md): unit **236 files / 3511 tests**, coverage **89.11/83.87/91.40/90.69**, full browser **234 passed + 1 skipped** (run 4; runs 1–3 failed only in the fixture-open phase), configured telemetry **6 passed**, restored stock **0** endpoint hits and **80** affected specs passed |
| Residual limitations | focus falls to `<body>` after the editor unmount (pre-existing); identical repeated error does not re-reveal; pending-change detail stays task-local; rail respected; **the browser gate depends on the DuckDB-WASM extension CDN** (map §6.6 follow-up, unauthorized); RD-T07 unsatisfied; no push                            |
| Rollback             | `git revert acc8aff` restores rd-3b behaviour (error stays in the hidden section); no storage/URL/router state                                                                                                                                                                                                                 |
