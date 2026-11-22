---
'@assay/web': minor
---

feat(web): offer the failed filter's own recovery control in the profile and
validation alerts (A3 / C02 parity).

C02b centralized the failed-apply copy in `grid/filter-failure.ts`:
`filterFailureCopy()` returns `{ message, recovery }` where `recovery` is
`{kind:'retry'}`, `{kind:'clear'}` or `null`, derived from
`FilterApplyError.phase`. Only the filter bar rendered the matching control,
and its alert is scoped to the bar's **own** apply — so a profile top-k apply
or a validation "Show only failing rows" apply that failed left the user with
copy saying "Retry to reload the view." and no control at that location. This
row takes the chosen option (b): one **panel-local** recovery action beside
each panel's existing alert, reusing the bar's exact elements and classes, so
no new CSS, no new live region and no new copy (every phase sentence stays
byte-identical and no message gains a location hint).

`ProfilePanel` and `ValidationPanel` gain two additive optional props —
`filterRecovery?: FilterFailureRecovery | null` and
`onFilterRecover?: (recovery) => void` — and render `Retry`
(`className="filter-error-retry"`) or `Clear filters`
(`className="filter-error-clear"`) only when the phase names that kind; the
profile's control is disabled while its filter apply is in flight, and nothing
renders for `refused-before-change` or a non-transaction rejection (neither
offers an action). `useValidationSession` keeps `filterToFailuresError` as it
was and additionally exposes the phase-derived `filterToFailuresRecovery`
(set from the same `filterFailureCopy(cause)` value and cleared wherever the
message is cleared) plus a stable `handleFilterToFailuresRecover` that acts on
its `phase.model`. `App`'s profile path now stores the whole
`FilterFailureCopy` instead of only the message and dispatches the recovery
under `applyProfileFilter`'s existing identity guards (attempt ref,
dataset-session token, live model identity), so a superseded recovery is a
silent no-op that can never write feedback onto a replaced session.

Dispatch is the bar's semantics: `retry` → the live model's `refresh()` (the
accepted list stays in effect), `clear` → the live model's `setFilters([])`
(also what clears `filtersUnknown`). A failed recovery re-derives the honest
copy rather than guessing: a `clear` that rejects is a new transaction phase
classified by the shared mapping, and a `retry` whose reload fails again keeps
the accepted-but-not-reloaded sentence — `refresh()` carries no phase, so the
small `grid/filter-recovery.ts` helper keeps `FILTER_RELOAD_FAILURE` instead of
falling back to the `filter` framing's rollback claim. Nothing here logs or
interpolates a predicate, column, value or engine diagnostic (ADR 0025); the
desktop webview, the grid contract and `filter-failure.ts` are untouched.

**Mutation evidence:** with the App host passing `filterRecovery={null}`
unconditionally, the three new `App.profile-filter` cases fail with
`TestingLibraryElementError: Unable to find an element by:
[data-testid="profile-filter-error-retry"]` (Retry cases) and
`…[data-testid="profile-filter-error-clear"]` (Clear case); restored
byte-for-byte, the file is 15/15 green.

Tests add the three panel cases per panel (retry / clear / no control, alert
text unchanged), the hook's recovery exposure for `accepted-reload-failed`
(`{kind:'retry'}`) and `restore-failed` (`{kind:'clear'}`) with the messages
unchanged, the hook's dispatch (one `refresh()` / one `setFilters([])`), and
the App host's reload-on-Retry, keep-the-copy-on-a-rejecting-reload, and
clear-on-`Clear filters` behaviour.
