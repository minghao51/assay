# A3 / C02b–c follow-up — recovery parity for the profile and validation panels (spec)

**Date:** 2026-11-21. **Status:** `SELECTED` for implementation in this batch.
**Row:** A3, [successor queue](20261121-successor-queue.md) §2; C02b/c limits in the
[execution record](20261120-improvement-plan-execution.md) §6.

## 1. The gap (verified)

C02b centralized the failed-apply copy in `apps/web/src/grid/filter-failure.ts`: `filterFailureCopy()`
returns `{ message, recovery }` where `recovery` is `{ kind: 'retry' }`, `{ kind: 'clear' }` or `null`,
derived from `FilterApplyError.phase` (never from error text). The **filter bar** renders the matching
button (`Retry` → `model.refresh()`, `Clear filters` → `model.setFilters([])`) — `FilterBar.tsx:845-875`.

The other two callers consume only `.message`:

- `apps/web/src/App.tsx` profile top-k (`setProfileFilterError(filterFailureCopy(cause).message)`) →
  `ProfilePanel.filterError`;
- `apps/web/src/sessions/useValidationSession.ts` filter-to-failures
  (`setFilterToFailuresError(filterFailureCopy(cause).message)`) → `ValidationPanel.filterError`.

So the profile and validation alerts say "Retry to reload the view." / "clear the filters … to recover"
with no control at that location.

## 2. Why not "point at the filter bar" (option a rejected)

The bar's control is scoped to the **bar's own** attempt: `FilterBar` keeps `failure` in component
state (`FilterBar.tsx:276`) and sets it only in its own apply handler. A profile top-k or
filter-to-failures apply that fails therefore leaves the bar's alert — and its `Retry`/`Clear filters`
buttons — absent. Telling the user to use a control that is not there would be dishonest, and making
the bar render failures it did not initiate would need the model to publish its last apply phase (a
C01/C02 status-surface change this row must not reopen).

**Chosen: option (b)** — one panel-local recovery action beside each panel's existing alert, reusing
the bar's exact control classes and the phase-derived `recovery` value. No new status union, no new
component class, no duplicated phase logic: the action is the one `filterFailureCopy` already names.

## 3. Contract

Both panels gain two optional props (additive; existing callers and tests keep compiling):

```ts
readonly filterRecovery?: FilterFailureRecovery | null
readonly onFilterRecover?: (recovery: FilterFailureRecovery) => void
```

- When `filterRecovery?.kind === 'retry'`, render `Retry` (`className="filter-error-retry"`);
  when `'clear'`, render `Clear filters` (`className="filter-error-clear"`) — the same elements and
  classes the bar uses, so no new CSS. When `null`/absent, no button (the `refused-before-change`
  phase offers none, and neither does a non-transaction error).
- The button sits beside the existing `role="alert"` paragraph (inside the same error group region
  where the panel already renders it), is `disabled` while the panel's filter action is pending where
  such a state exists, and is a native `<button type="button">` (keyboard default).
- `onFilterRecover` receives the kind; the host dispatches exactly the bar's semantics:
  `retry` → the live model's `refresh()`; `clear` → the live model's `setFilters([])`.
- A failed recovery keeps the honest phase copy: the host re-runs `filterFailureCopy(cause)` and
  replaces the panel's copy (a retry whose reload still fails stays `FILTER_RELOAD_FAILED_MESSAGE`).
- Host-side identity rules are preserved: the profile path reuses `applyProfileFilter`'s attempt/
  session/model guards (a superseded recovery is a silent no-op and never writes feedback onto a
  replaced session); the validation path uses its `phase.model`.
- Copy: unchanged. No sentence gains a location hint, so the phase messages stay byte-identical and
  the filter bar's own assertions and `filter-failure.test.ts` are untouched.
- Value-free: the alert text and button labels carry no predicate, column, value or engine diagnostic
  (ADR 0025); nothing new is announced through a live region.

## 4. Tests

- `ProfilePanel.filter.test.tsx`: `retry` renders one `Retry` button and calls back with `'retry'`;
  `clear` renders `Clear filters` and calls back with `'clear'`; `null` renders no button; the alert
  text is unchanged in all three.
- validation panel test: the same three cases.
- `filter-to-failures.test.tsx` (hook): a `restore-failed` outcome exposes `recovery: {kind:'clear'}`,
  `accepted-reload-failed` exposes `{kind:'retry'}`; the message value is unchanged.
- `App.profile-filter.test.tsx`: reload-failed alert + click `Retry` → the live model's `refresh()` is
  called; a refresh that rejects re-renders the reload-failed copy; `restore-failed` + click
  `Clear filters` → `setFilters([])` is called.
- Mutation drill: pass `recovery: null` unconditionally from the host → the Retry/Clear tests fail.

## 5. Not in scope

- No change to `filter-failure.ts` copy or phase mapping; no change to C01's status semantics; no
  clear-all control; no bar-state change; no live-region addition; no new CSS.
