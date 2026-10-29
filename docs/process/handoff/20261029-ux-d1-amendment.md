# UX-D1 amendment brief — profile honesty (ug-10)

> **STATUS: DRAFT — NOT A DECISION. PENDING MAINTAINER APPROVAL.**
> This file is a decision brief, not authorization. No agent may claim ug-10, edit the
> contradictory queue wording, or start the engine variant until the maintainer records a ruling
> in §8 below. Until then the safe default in
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

## 2. Verified facts (2026-10-29, `faa3886`)

| Fact                                                                                                                                                                                                                  | Evidence                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Profiling reads the base view only. Its signature takes a table handle and nothing else.                                                                                                                              | `packages/engine-duckdb/src/client.ts` `profile(handle)`; `profile-query.ts` composes base SQL only |
| The overlay is **stateless per request** and the engine already has overlay-aware surfaces — `overlaySchema`, `overlayRowCount`, `exportView(…, overlay)`, and `validate(…, overlay)` — but no overlay-aware profile. | `overlay-query.ts` header; `client.ts` (overlay-bearing requests)                                   |
| Effective-view SQL composition already exists (base branch ∪ insert branches, tombstones, renames, casts, ordering). Reusing it for a profile is not new invention — it is a new _caller_.                            | `packages/engine-duckdb/src/overlay-query.ts`                                                       |
| User SQL (`query(sql)`) is base-only: no overlay parameter. So "just profile via SQL" is not available today either.                                                                                                  | `client.ts` `query(sql)`                                                                            |
| A base file never changes inside a session. Only staged operations (cell edits, inserts, renames, casts) can make displayed statistics diverge from the effective view.                                               | ADR 0012 (overlay model); `apps/web/src/edit/session.ts`                                            |
| The Profile panel is user-triggered, renders a running status, and receives only `handle` — it has no overlay awareness at all today.                                                                                 | `apps/web/src/profile/ProfilePanel.tsx`; `App.tsx` `<ProfilePanel handle={phase.handle} />`         |
| The staged-operation count already exists and is used for user-facing copy.                                                                                                                                           | `activeOps(history).length` (ug-8 export line)                                                      |

## 3. Options

### Option A — honest labeling, no stale/re-run claim _(recommended)_

Do not touch the engine. Make the panel state precisely what the numbers are, and what they are
not:

- a **standing hint** on every profile state (including the zero state),
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
(via `overlay-query.ts`) + domain type + `DataEngine` target update (D13 compatibility pin) +
conformance/fixture scenarios derived from the pinned DuckDB CLI + independent review. Also a
cost profile change: inserts are bounded by session activity, but the scan is still a full pass
over the composed relation on the query lane. Panels-lane successors stay blocked until it lands.

### Option C — A now, B chartered separately _(recommended packaging)_

Ship Option A immediately as the amended ug-10 (unblocks the Panels lane today), and keep Option B
as a **separate engine-track candidate** with its own queue row and fixtures — not a rider on a
copy task. If B ever lands, A's copy stays true and can be extended (the hint keeps describing the
base; the note disappears when the profile becomes overlay-aware).

**Recommendation: Option C.** It resolves the contradiction honestly today, costs nothing in the
engine, and does not foreclose the better long-term behavior.

## 4. Proposed amendment (only valid if §8 approves Option A or C)

**Queue row ug-10 is reworded to:**

> **Profile honesty pack (amended 2026-10-29, UX-D1).** The profile states that statistics describe
> the file as opened, and states — only while staged operations exist — that they are not
> reflected. No stale/re-run banner and no claim that re-running includes session edits.
> Done-when: byte-exact hint and note pins across 0/1/N operations and their 0-operation
> disappearance; no auto-recompute; engine untouched.

**Proposed requirement R-16 (activates only on approval; added to spec §2 by the orchestrator):**

- **Hint (always visible, including the zero state), byte-exact:**
  `Statistics describe the file as opened — staged edits, inserts and renames are not included.`
- **Staged note (visible only while the active history has ≥1 operation), byte-exact with singular
  grammar:**
  `N staged change is not reflected here` / `N staged changes are not reflected here`,
  followed by `— the grid and validation use the edited view.`
- **No stale banner, no re-run-implies-edits copy.** The existing run/refresh control keeps its
  current label and semantics (refresh of the immutable base statistics).
- **Nothing else changes:** `profile(handle)` stays as-is, no protocol/engine/domain change, no new
  telemetry (ADR 0037), value-free copy (ADR 0025), no auto-recompute.

**Acceptance criteria (worker brief + reviewer checklist):**

1. Hint renders in the zero state and above/alongside results — byte-exact, including the em dash.
2. Note renders with the exact copy at N=1 (`1 staged change is not reflected here …`) and N>1
   (`N staged changes are not reflected here …`); it disappears when the history returns to 0
   operations (undo path pinned); nothing renders at N=0.
3. No stale banner, no edit-aware re-run claim; re-running performs exactly the same base profile;
   no auto-recompute on overlay revision change.
4. Pins: unit tests for hint (zero state + results), note at 0/1/N, and the undo-back-to-0
   disappearance; a mutation drill that removes the count prop must fail the note pins.
5. Scope: `apps/web/src/profile/**` + `App.tsx` prop wiring + one scoped CSS block (existing
   `profile-*` classes preferred; token restyling stays with uxv-2); `feat(web):`/`fix(web):`
   - `@assay/web` changeset; no `packages/**` change.

**If §8 approves Option B instead:** ug-10 stays blocked until an engine row lands. Its original
done-when stands, with the added requirement that the panel distinguishes base vs effective
statistics per R-16's spirit (never a bare "stale" that implies the wrong thing). The engine row
would need: protocol field, `overlay-query.ts`-based composition, domain + `DataEngine` target
update, pinned-CLI conformance scenarios, fixtures, and an independent reviewer — plus a recorded
decision that the target interface changes.

## 5. What approval changes in the documents

On approval, the orchestrator makes exactly these edits (nothing else is pre-authorized):

1. [spec §2](../../product/09-ux-ui-implementation-spec.md): add **R-16** with the approved copy and
   acceptance wording.
2. [spec §7](../../product/09-ux-ui-implementation-spec.md#7-explicit-stopdecision-register): mark
   UX-D1 **resolved (option A/C/B, date)**, pointing at this file.
3. [usability queue](20261026-usability-queue.md) ug-10 row: apply the §4 rewording (Option A/C) or
   record the engine dependency (Option B); record the claim.
4. Panels-lane ordering: **ug-16 → ug-20** become eligible again in that order (Option A/C), or stay
   blocked (Option B).
5. [handoff](../handoff.md) §6 + changelog, [open-threads](20260926-open-threads.md), and
   [open-asks](20261019-open-asks.md) §2 updated to drop/move the UX-D1 item.

## 6. Effects, risks and known corners

- **ug-16 corner (applies to both options):** top-k values come from whichever profile source is
  authoritative. With Option A they are base-derived, so clicking a value after edits may filter to
  zero rows on the effective view — the existing "no rows match" empty state must keep that honest
  (no new grammar, no silent fallback). With Option B the values follow edits.
- **Renamed columns:** with Option A the panel keeps base column names; the hint names "renames"
  explicitly so this is disclosed rather than surprising.
- **Export/report bytes:** untouched by either option (ADR byte-stability).
- **Privacy:** all new copy is value-free; no counts of dataset values, no filenames (ADR 0025).
- **Not decided here:** whether the profile should ever become overlay-aware is a product call
  about cost/freshness, not a bug fix. Option A is defensible indefinitely on its own.

## 7. Decision

Tick exactly one, then record the date and initial. Agents must not self-approve.

- [ ] **Option A** — amend ug-10 to honest labeling only (no engine work). Panels lane unblocks.
- [ ] **Option C (recommended)** — Option A now **plus** Option B chartered as a separate
      engine-track candidate row (author it as a new queue row, not as a rider).
- [ ] **Option B** — block ug-10 until an overlay-aware profile lands; authorize the engine work
      as its own row with fixtures/conformance and an ADR/decision record for the `DataEngine`
      target change.
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
