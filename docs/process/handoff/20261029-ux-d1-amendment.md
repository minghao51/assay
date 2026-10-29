# UX-D1 amendment brief — profile honesty (ug-10)

> **STATUS: DRAFT — NOT A DECISION. PENDING MAINTAINER APPROVAL.**
> This file is a decision brief, not authorization. No agent may claim ug-10, edit the
> contradictory queue wording, or start the engine variant until the maintainer records a ruling
> in §7 below. Until then the safe default in
> [spec §7](../../product/09-ux-ui-implementation-spec.md#7-explicit-stopdecision-register) stands:
> do not implement ug-10.
>
> Owner of this brief: orchestrator. Decision owner: maintainer (UX-D1 is not delegable to an
> implementing agent — the deciding party must not also implement it). Authored 2026-10-29.

## 1. Why this exists

Queue row **ug-10** ("Profile honesty pack") promises, verbatim:

> Hint states the profile is computed over the file as opened; an overlay-revision change after
> computing flips the panel to a "Profile is stale — re-run" state mirroring the validation banner
> until re-run.

That done-when cannot be satisfied by the current engine: **re-running cannot reflect staged
edits**, so a "Profile is stale — re-run" banner would promise a refresh that provably changes
nothing. [Spec §7](../../product/09-ux-ui-implementation-spec.md#7-explicit-stopdecision-register)
recorded this as **UX-D1** and blocked the row. Panels-lane successors `ug-16` and `ug-20` sit
behind it, so the whole lane is out of runway without this decision.

## 2. Verified facts (2026-10-29, re-verified at `ea41533`)

| Fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Evidence                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Profiling reads the base view only. Its signature takes a table handle and nothing else.                                                                                                                                                                                                                                                                                                                                                                                                         | `packages/engine-duckdb/src/client.ts` `profile(handle)`; `profile-query.ts` composes base SQL only    |
| The overlay is **stateless per request** and the engine already has overlay-aware surfaces — `overlaySchema`, `overlayRowCount`, `fetchOverlayRange`, `overlayCastCheck`, `exportView(handle, {…, overlay})` (overlay is a request field, not a positional argument), `validate(…, overlay)` and `diff(…, overlay)` — but no overlay-aware profile.                                                                                                                                              | `overlay-query.ts` header; `client.ts`; `protocol.ts` request union                                    |
| Effective-view SQL composition already exists (base branch ∪ insert branches, tombstones, renames, casts, ordering). Reusing it for a profile is not new invention — it is a new _caller_.                                                                                                                                                                                                                                                                                                       | `packages/engine-duckdb/src/overlay-query.ts`                                                          |
| User SQL (`query(sql)`) is base-only: no overlay parameter. So "just profile via SQL" is not available today either.                                                                                                                                                                                                                                                                                                                                                                             | `client.ts` `query(sql)`                                                                               |
| A base file never changes inside a session: the base is swapped only by opening or replacing a dataset, which starts a new session and resets history, so the panel's table handle cannot move under a displayed profile. Only staged ops can make statistics diverge from the overlay-effective view: `cell-set`/`cell-revert`, `row-insert`/`row-uninsert`, `row-delete`/`row-restore`, `column-rename`, `column-cast`. Grid filters are not overlay ops and the profile does not follow them. | ADR 0012; `packages/domain/src/edit-ops.ts`; `apps/web/src/edit/session.ts`; `App.tsx` open path       |
| The Profile panel is user-triggered, renders a running status, and receives only `handle` — it has no overlay awareness at all today.                                                                                                                                                                                                                                                                                                                                                            | `apps/web/src/profile/ProfilePanel.tsx`; `App.tsx` `<ProfilePanel handle={phase.handle} />`            |
| The staged-operation count already exists and is used for user-facing copy. It counts active history **entries**, not a net difference: a cast-then-revert or delete-then-restore leaves N>0 while the effective view may equal base.                                                                                                                                                                                                                                                            | `activeOps(history).length` (ug-8 export line); `apps/web/src/edit/session.ts`; `useEditingSession.ts` |
| The panel body renders only while its inner disclosure is open (`{open && …}`), and first paint is collapsed; the R-14 subtitle already occupies the collapsed affordance. A “standing” hint can therefore mean “in every expanded state”, not “visible on first paint”.                                                                                                                                                                                                                         | `apps/web/src/profile/ProfilePanel.tsx`; `App.tsx` (R-14 subtitle); `tests/e2e/shell.spec.ts`          |

**Second-pass audit (2026-10-29).** An independent worker and an adversarial reviewer re-ran these
rows at `ea41533`; `faa3886..ea41533` touches only `docs/**`, so no runtime drift. The pass
corrected the overlay-surface list (three more surfaces, and `exportView`'s overlay is a request
field), the staged-op enumeration (row deletes/restores and cell reverts, and that grid filters are
not overlay ops), the “standing hint” scope (the panel body is behind its own disclosure), the
`activeOps` meaning (history entries, not net divergence), the Option B scan/insert budget, and the
acceptance criteria (all four states, full note strings, App-level wiring and mutation proof). No
row changed the conclusion: there is still no overlay-aware profile and no re-run path that could
include staged edits.

## 3. Options

### Option A — honest labeling, no stale/re-run claim _(recommended)_

Do not touch the engine. Make the panel state precisely what the numbers are, and what they are
not:

- a **standing hint** in every expanded profile state (including the zero state),
- a **staged-changes note** that appears only while the active history has ≥1 operation,
- **no** "Profile is stale — re-run" banner, because the file as opened is immutable and a re-run
  cannot include session edits.

Payoff: the actual user-facing harm in UG-18 (statistics silently describing something other than
what the user is looking at) is removed, with copy that stays true after any future engine work.
Cost: `apps/web` only — one new prop (operation count), copy, one scoped CSS block, pins.

### Option B — profile the effective view (engine track)

Add an overlay-aware profile (`overlayProfile(handle, overlay)` or an optional `overlay` on
`profile`), composed over the same effective relation the grid/validation already query.

Payoff: statistics follow staged edits, renames and inserts; ug-10's original wording becomes
implementable as written.
Cost (deliberately stated so the decision is informed): protocol field + worker composition
(via `overlay-query.ts`) + conformance/fixture scenarios derived from the pinned DuckDB CLI +
independent review. Whether domain types or the public `DataEngine` target must change is an open
design question, not an established requirement: a pure `engine-duckdb` client protocol addition
may suffice under D13 compatibility rules, the architect resolves the actual footprint, and the
existing diff overlay is the precedent for composing an effective view. Also a
cost profile change: the profile plan is one aggregate scan plus one grouped top-k scan per
categorical column, and every scan would run over the composed relation on the query lane; live
inserts are capped at `MAX_OVERLAY_LIVE_INSERT_BRANCHES` (500) and a larger overlay is refused,
so “statistics follow inserts” is bounded by that budget. Panels-lane successors stay blocked
until it lands.

### Option C — A now, B chartered separately _(recommended packaging)_

Ship Option A immediately as the amended ug-10 (unblocks the Panels lane today), and keep Option B
as a **separate engine-track candidate** with its own queue row and fixtures — not a rider on a
copy task. If B ever lands, A's copy is no longer true for effective-view statistics: B must
replace **both** base-only messages (the hint and the staged note — “not reflected here” would be
false) with explicit effective-view labeling rather than keep either. This is
candidate planning only; no engine implementation is authorized by this brief.

**Recommendation: Option C.** It resolves the contradiction honestly today, costs nothing in the
engine, and does not foreclose the better long-term behavior.

## 4. Proposed amendment (only valid if §7 approves Option A or C)

**Status note:** the original ug-10 done-when in the queue stays untouched until the ruling is
recorded. This section is proposed copy, not a ruling. R-16 is not in spec §2 today; it appears
only in the spec §8 index as proposed/unauthorized and in this brief.

**Queue row ug-10 is reworded to:**

> **Profile honesty pack (amended 2026-10-29, UX-D1).** The profile states that statistics describe
> the file as opened, and states — only while staged operations exist — that they are not
> reflected. No stale/re-run banner and no claim that re-running includes session edits.
> Done-when: byte-exact hint and note pins across 0/1/N operations and their 0-operation
> disappearance; no auto-recompute; engine untouched.

**Proposed requirement R-16 (activates only on approval; added to spec §2 by the orchestrator):**

- **Hint (visible whenever the panel body is expanded — idle/zero, running, error and results),
  byte-exact:**
  `Statistics describe the file as opened — staged changes are not included.` This covers row
  deletes/restores and column renames/casts as well as cell edits and inserts; it does not claim
  the profile follows grid filters. The collapsed affordance is unchanged (the R-14 subtitle), and
  the hint must not displace the idle `profile-table-id` element that existing e2e reads. If
  Option B later makes the profile effective-view aware, this base hint must be replaced by
  explicit effective-view labeling — never shown alongside it.
- **Staged note (visible only while the active history has ≥1 operation), byte-exact with singular
  grammar:**
  `1 staged change is not reflected here — the grid uses the edited view. Validation must be run explicitly against the edited view.`
  `N staged changes are not reflected here — the grid uses the edited view. Validation must be run explicitly against the edited view.`
  A “re-run validation to include it/them” promise is not proposed: nothing here may imply that a
  previously displayed validation verdict already reflects the edits, or that validation refreshes
  automatically.
- **No stale banner, no re-run-implies-edits copy.** There is no re-run control in the results
  state today — the only controls are `Compute profile` (idle) and `Retry` (error). Neither is
  relabeled and no new control is added; nothing in the panel may promise that re-running
  includes session edits.
- **Nothing else changes:** `profile(handle)` stays as-is, no protocol/engine/domain change, no
  new telemetry (the queue's no-telemetry rule; ADR 0025/0037 govern privacy and consent),
  value-free copy, no auto-recompute.

**Acceptance criteria (worker brief + reviewer checklist):**

1. Hint renders byte-exact (em dash included) in **all four** states — idle/zero, running, error
   and results — and the idle `profile-table-id` element that `tests/e2e/profile-panel.spec.ts`
   reads is still present and visible.
2. Note renders the **full** byte-exact strings at N=1 and N>1 (both sentences, em dash included),
   where N = `activeOps(history).length`; **no note** at N=0 (the hint still renders per
   criterion 1); undo/redo back to 0 removes it. Net-zero histories still count as N>0 and the
   copy stays truthful — it says “not reflected here”, never “differs”.
3. No stale/re-run banner and no edit-aware re-run copy in the panel (source grep pin plus a
   rendered-text pin); an overlay-revision change while results are displayed neither flips the
   panel state nor issues an `engine/profile` request (App-level spy); the request stays base-only
   (existing engine conformance covers the request shape).
4. Pins: unit tests for the hint in each state, the note at 0/1/N, and the undo-back-to-0
   disappearance; an **App-level** test that stages and undoes an edit through the real wiring;
   mutation drills — dropping the count prop at the `App.tsx` call site must fail the App-level
   note test, and removing the note's `N>0` gate must fail the note pins.
5. Scope: `apps/web/src/profile/**` + `App.tsx` prop wiring + one scoped CSS block (existing
   `profile-*` classes preferred; token restyling stays with uxv-2) + the
   `tests/e2e/profile-panel.spec.ts` assertions that the copy move touches; `feat(web):`/`fix(web):`
   - `@assay/web` changeset; no `packages/**` change. This bounded scope is proposed only and does
     not authorize an unruled workaround (for example, an effective-view profile or silent column
     remapping) inside the ug-10 claim.

**If §7 approves Option B instead:** ug-10 stays blocked until an engine row lands. Its original
done-when stands, with the added requirement that the panel distinguishes base vs effective
statistics per R-16's spirit (never a bare "stale" that implies the wrong thing). The engine row
would need: protocol field, `overlay-query.ts`-based composition, pinned-CLI conformance
scenarios, fixtures, and an independent reviewer. Whether domain types or the public `DataEngine`
target must change is an open architecture question, not a mandate; a pure `engine-duckdb` client
protocol addition may suffice under D13 compatibility rules, and the architect resolves the actual
footprint. The existing diff overlay is the precedent for an effective-view composition.

## 5. What approval changes in the documents

On approval, the orchestrator makes exactly these edits (nothing else is pre-authorized):

1. [spec §2](../../product/09-ux-ui-implementation-spec.md): add **R-16** with the approved copy and
   acceptance wording.
2. [spec §7](../../product/09-ux-ui-implementation-spec.md#7-explicit-stopdecision-register): mark
   UX-D1 **resolved (option A/C/B, date)**, pointing at this file.
3. [spec §8 index](../../product/09-ux-ui-implementation-spec.md#8-requirement-status-living-index):
   move R-16 from proposed/unauthorized to authorized, with the owner row and record, and update
   the §8 ownership paragraph that currently says R-16 is proposed only.
4. [spec header + §1](../../product/09-ux-ui-implementation-spec.md): update the status line
   (“proposed R-16 is not authorized”) and the §1 sentence “ug-10 remains decision-blocked (§7)” —
   under A/C to “resolved, pending implementation”; under B to “blocked on the engine row”.
5. [usability queue](20261026-usability-queue.md) — not only the ug-10 row: apply the §4 rewording
   (A/C) or record the engine dependency (B) in the row, and update every live-status passage that
   repeats the block (frontier/lane text, §5 continuation record, the “original done-when
   preserved” notes). Historical entries are marked historical, never rewritten.
6. [visual queue](20261026-ux-ui-execution-queue.md): update its R-09…R-13 ownership/next-task
   note, plus the two passages that say ug-10 is blocked / no copy-only route (the second becomes
   “blocked pending the amended ug-10 landing”, not “blocked pending a ruling”).
7. [pickup prompts](20261026-ux-ui-pickup-prompts.md): replace every current ug-10/ug-16 blocked
   claim **and** the ownership line in the ready-to-paste pack.
8. [product/08](../../product/08-ux-ui-engine-showcase-plan.md): update the ug-10 honesty bullet so
   it records the ruling instead of “brief amendment required before dispatch”.
9. Panels-lane ordering: after the amended ug-10 is implemented, independently reviewed and
   merged-green, **ug-16 then ug-20** become eligible in that order (A/C); otherwise both stay
   blocked (B). No “ug-16 eligible immediately” on the ruling alone.
10. [handoff](../handoff.md) header + §6 + changelog, [open-threads](20260926-open-threads.md), and
    [open-asks](20261019-open-asks.md) §2 + its intro counts updated to drop/move the UX-D1 item.
11. **Option C only:** author the separate engine-track candidate row for Option B — planning only;
    it does not authorize dispatch or implementation — with the fixtures/conformance scope from §3.

Everything not listed stays as-is; historical changelog entries are never rewritten.

## 6. Effects, risks and known corners

- **ug-16 corner (applies to both options):** top-k values come from whichever profile source is
  authoritative. With Option A they are base-derived, so clicking a value after edits may filter to
  zero rows on the effective view — the existing "no rows match" empty state must keep that honest
  (no new grammar, no silent fallback). With Option B the values follow edits.
- **Renamed columns (and any future column-drop op):** with Option A the panel keeps base column
  names; the proposed hint's generic “staged changes” includes schema changes. A base profile
  column can be renamed today (`column-rename`; the domain has no column-drop op), so a click
  cannot silently bind the base name on the effective view. Before ug-16 is dispatched, the
  design must choose explicit disclosure, a typed refusal, or a stated mapping rule; no silent
  filter mapping and no assumption that the base name still resolves. If a column-drop op is
  added later it inherits the same rule. This is a design prerequisite for the ruling, not
  authorization to widen ug-10's scope.
- **Export/report bytes:** untouched by either option (ADR byte-stability).
- **Privacy:** all new copy is value-free; no counts of dataset values, no filenames (ADR 0025).
- **Not decided here:** whether the profile should ever become overlay-aware is a product call
  about cost/freshness, not a bug fix. Option A is defensible indefinitely on its own.

## 7. Decision

Tick exactly one, then record the date and initial. An agent may transcribe an explicit maintainer
ruling into this block and spec §7; it may not choose the option, self-approve, or tick a decision
without that instruction.

- [ ] **Option A** — amend ug-10 to honest labeling only (no engine work). Panels lane unblocks.
- [ ] **Option C (recommended)** — Option A now **plus** Option B chartered as a separate
      engine-track candidate row (author it as a new queue row, not as a rider).
- [ ] **Option B** — keep ug-10 blocked pending a separate overlay-aware profiling track.
      Authorize architecture investigation and a bounded engine brief with fixtures/conformance;
      resolve its actual client/protocol and compatibility footprint before implementation.
      A `DataEngine` target change or ADR is required only if that design warrants it, not by
      selecting this option.
- [ ] **Other** — record the ruling text below; the orchestrator writes the matching docs amendment.

Decision / notes:

```text
(maintainer ruling text)
```

Decided by: ____________________ Date: __________

## 8. Handoff for whoever implements the approved option

- Claim the row in the queue before touching code; the queue owns dispatch status, this file owns
  rationale only.
- Record the ruling in this file's §7 **and** in [spec §7](../../product/09-ux-ui-implementation-spec.md)
  in the same change; a ruling that exists only in chat is not a decision.
- Follow the standard roster: worker (implementation) → independent reviewer → orchestrator
  integration + merged verification; never implement and approve the same change.
- Verification for the amended ug-10 is the repo's six gates + coverage + docs/ADR checks in a
  clean isolated worktree; UI copy pins live in `apps/web/src/**` tests and one e2e journey.
