# C01 — whole-list filter transaction contract and caller map

**Date:** 2026-11-20. **Row:** C01 (DESIGN, W2). **Selected decision:** Q4 = optional atomic
`replaceFilters` capability, legacy path stays documented as non-atomic (recorded in
[improvement-plan execution record](20261120-improvement-plan-execution.md) §2).
**Companion record:** [C03a callback-failure contract](20261120-c03-callback-failure-contract.md).
**Baseline:** `0150699` (`main`; this record was written on `wp-design`, and every anchor below was
re-checked in that worktree at write time). **Status:** design delivered; no product code, test or type changed.
C02a/b/c implement from this record after review.

## 1. What this record settles, and what it does not

Settles: the provider capability shape, the model-side transaction and reconciliation rules, the
transition table C02 must implement, the value-free error shape, who owns restoration, and the
caller/symbol map for web, desktop and tests.

Does not settle: any runtime change, any copy rewrite in a shipped panel (the copy proposals below
are inputs for C02b/C02c review), WF-O1 draft-clarity UX (separate design row), or a SQL/predicate
grammar (the grid never parses predicates: `FilterSpec.predicate` is opaque engine text,
`packages/grid/src/contracts.ts:46-57`).

Constraints honoured: no ADR reopened (0040 two lanes / 0044 grid shell / 0049 retention / 0051
repair are untouched by this design); grid stays engine-neutral (no engine import, no SQL parsing);
the existing `GridDataProvider` remains implementable as-is, so C02 adds an **optional** method and
never a mandatory break.

## 2. Current contract, verified in source

| Piece                    | Anchor                                                        | Verified behaviour                                                                                                                                |
| ------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider interface       | `packages/grid/src/contracts.ts:127-151`                      | `rowCount`, `fetchRange`, `sort`, `filter`, `schema`. No whole-list verb exists.                                                                  |
| `filter()` semantics     | `packages/grid/src/contracts.ts:139-149`                      | Add one predicate, `null` clears the list; "a rejection must leave the previous list in effect" — a **per-call** promise, not a list transaction. |
| Model sequence           | `packages/grid/src/viewport-model.ts:413-431`                 | Validate every spec → `filter(null)` → `filter(spec)` per item → assign `filterState` → `refresh()`.                                              |
| Spec validation          | `packages/grid/src/viewport-model.ts:154-161`                 | Shape only (non-empty `column`, string `predicate`); throws `TypeError` before any provider call.                                                 |
| Serialization            | `packages/grid/src/viewport-model.ts:436-443`                 | One promise queue; `querySeq` (line 200) is **shared by `setSort` and `setFilters`** (`383-393`, `419`).                                          |
| Accepted-state getter    | `packages/grid/src/viewport-model.ts:254-258`                 | `filters` returns `filterState`, documented as "only changes once the provider accepted".                                                         |
| Data epoch               | `packages/grid/src/viewport-model.ts:303-318`, `453-457`      | `load()` bumps `generation`, drops cache/in-flight, re-reads schema+count; `refresh()` = `load()` + re-observe.                                   |
| Legacy retry             | `packages/grid/src/viewport-model.ts:358-368`                 | `retry()` re-requests failed spans only; a fatal provider-contract error is not retryable.                                                        |
| Provider state (web)     | `apps/web/src/grid/provider.ts:429-445`                       | `sort`/`filter` are **infallible recordings** (`this.filterPredicates = …`); nothing can reject.                                                  |
| Provider state (desktop) | `apps/vscode/webview/grid-provider.ts:278-295`                | Same infallible recording shape.                                                                                                                  |
| Engine SQL               | `packages/engine-duckdb/src/window-query.ts:71-76`, `107-114` | Predicates become `WHERE ("col" <predicate>)`; an invalid fragment fails at **execution**, i.e. in `rowCount`/`fetchRange`, not at `filter()`.    |

**Consequence (the load-bearing correction to the plan's framing):** in both shipped providers the
only reachable `setFilters` rejection sources are (a) the model's own `TypeError` before any push and
(b) a **post-acceptance `refresh()` failure** (`load()` → `provider.rowCount()`/`schema()`). A
mid-sequence provider rejection — case (c) — cannot be produced by `DuckDbGridProvider` or
`EngineGridProvider` today; it is reachable for any provider that awaits inside `filter()` (the grid
test double does: `packages/grid/src/viewport-model.test.ts:34-126`, `holdQueryPushes` line 48), and
it is what the contract must bound for future providers (`packages/grid/src/contracts.ts:139-148`
only promises per-call atomicity). Caller compensation is therefore mostly compensating **case (b)**,
which is not a rollback at all.

## 3. Provider inventory

| #   | Implementation                                              | Sites                                                                                                                                                                                                          | `filter()` today                                             | Could implement `replaceFilters`?                                                                                                                                                       |
| --- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | `DuckDbGridProvider` (web local provider)                   | class `apps/web/src/grid/provider.ts:324`; constructed `apps/web/src/App.tsx:2541` (legacy open), `App.tsx:2089` (replacement candidate), `apps/web/src/pipeline/usePipelineSession.ts:226` (pipeline preview) | Infallible list recording; no await, no throw                | **Yes, trivially.** One validated array assignment before any state read; validation is "every spec is a `{column,predicate}` object" — the value is opaque and never parsed.           |
| P2  | `EngineGridProvider` (desktop / VS Code webview)            | class `apps/vscode/webview/grid-provider.ts:117`; constructed `apps/vscode/webview/main.ts:388`, `apps/vscode/webview/dataset.ts:361`                                                                          | Same infallible recording                                    | **Yes, trivially.** Same shape; must not touch the host bridge protocol (no message change needed — the capability is webview-local state).                                             |
| P3  | `FakeProvider` (grid unit test double)                      | `packages/grid/src/viewport-model.test.ts:34`, controls `rejectQueryPushes:45`, `holdQueryPushes:48`, `releaseQueryPush:129`                                                                                   | Interpretable mini-grammar; can reject before touching state | **Yes — and it should**, plus a _refusing_ variant and a _partial-apply_ variant, so C02 can test both the atomic and the legacy branches.                                              |
| P4  | Inline proof provider (desktop test-mode proof)             | `apps/vscode/webview/dataset.ts:1776-1786` (`sort: async () => undefined`, `filter: async () => undefined`)                                                                                                    | No-op                                                        | Not needed (single-row synthetic dataset, no query state). It stays valid because the capability is optional.                                                                           |
| P5  | Model doubles in web component tests                        | `apps/web/src/grid/FilterBar.test.tsx:41-53` (`fakeModel`, mocked `setFilters`), `:57-84` (`storeModel`), `:91-125` (`blockingModel`)                                                                          | Not providers at all — they replace the **model**            | N/A. These encode the _intended_ rejection contract; C02b must re-point them at the real `GridViewportModel` outcome phases or they will keep asserting a rollback the model never did. |
| P6  | Requirement-only subjects (real model + fake engine client) | `apps/web/src/App.profile-filter.test.tsx:137-165` (harness `overlayRowCount` injects the failure), `:499-518`                                                                                                 | Provider is real P1; the failure is injected one layer down  | N/A — this is the natural place to pin the new case-(b) outcome end to end.                                                                                                             |

No other `GridDataProvider` implementations exist (`grep -rn "implements GridDataProvider\|: GridDataProvider"
apps packages tests` returns only the rows above). The desktop webview has **no unit-test subject**
at all (`vitest.config.ts:20-46` includes `packages/*/src`, `apps/cli/src`, `apps/vscode/src/pure`
only), so P2's assertions must live in the extension-host proof harness or in a pure extraction —
which is C02c's call, not C01's.

## 4. Probe evidence (throwaway scripts, not committed)

Run against this worktree with `node` + type stripping on the real
`packages/grid/src/viewport-model.ts`. Reproduced outputs:

| Probe                                                                  | Result                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** malformed spec in a 1-item list, one filter already accepted     | `TypeError`, **0 provider pushes**; model and provider stay on the accepted list. → case (a) is already atomic.                                                                                                                   |
| **B** provider rejects the 3rd push of `[null, s1, s2]`                | model `filters = []`, provider list `= [s1]`, `totalRows` still the **unfiltered** count. → provider serves filtered rows while the UI claims unfiltered.                                                                         |
| **C** provider accepts the list, `rowCount()` then rejects             | `setFilters` rejects, model `filters = <new list>`, provider `= <new list>`, `totalRows = 100` (stale), `getRow(0) = loading`. → the model publishes an accepted list while the caller is told "rejected".                        |
| **D** accepted A, then B rejected on its 2nd push                      | model `filters = A`, provider `= []`, model `totalRows = 5` (A's count). → the _opposite_ divergence.                                                                                                                             |
| **D3** accepted A, then B rejected on its clear push (`filter(null)`)  | model `= A`, provider `= A`. → consistent, but the rejection does **not** mean "nothing happened", so callers cannot infer state from the promise outcome.                                                                        |
| **E** case (C) followed by the caller's compensating `setFilters([])`  | converges to `filters = []`, `totalRows = 100` on the next success. → compensation works today only because the caller guesses right.                                                                                             |
| **F** `setFilters(A)` held inside `filter(null)`, then `setSort(desc)` | model `filters = []`, model `sort = desc`, provider `filters = [A]`, provider count `= 5`, `getRow(0) = loading`. → **shared `querySeq` across verbs** silently leaves the provider filtered while the UI shows no filter at all. |

F is the sharpest finding and it is not a provider-rejection case: `setFilters` looks superseded
_after_ the provider applied the list (`viewport-model.ts:421-425`), returns without publishing, and
the `setSort` run then refreshes against the provider's filtered state. The UI shows "no filters" over
a 5-row filtered dataset. Today this needs a provider whose `filter()` awaits, which neither shipped
provider does; the contract must still forbid the state, because "no UI claim may disagree with what
`fetchRange` serves" is the invariant the module header states
(`packages/grid/src/viewport-model.ts:396-412`).

## 5. Selected contract

### 5.1 Provider capability (optional, additive)

```ts
export interface GridDataProvider {
  // …existing members unchanged…
  /**
   * Replace the whole ordered predicate list in one transaction (`[]` clears).
   * Validation of every spec happens before any state change; a rejection
   * therefore leaves the previously accepted list in effect and observable.
   * `GridDataProvider.filter`'s one-predicate protocol remains the documented
   * fallback for providers that do not implement this capability.
   */
  replaceFilters?(specs: readonly FilterSpec[]): Promise<void>
}
```

Rules:

- **Optional.** Absence is not an error; the model uses the legacy sequence.
- **All-before-commit.** Reject ⇒ previous list still in effect (no partial state), same wording as
  `sort`/`filter` (`contracts.ts:134-148`).
- **Opaque values.** Implementations validate the _shape_ only. No parsing, normalizing, sorting or
  de-duplication: `replaceFilters([a, b])` must store the list in exactly that order, because
  `filterState` order is what the UI displays and what `WHERE` composes
  (`packages/engine-duckdb/src/window-query.ts:71-76`).
- **Same config.** The engine-neutral boundary holds: the grid passes `FilterSpec[]` through; the
  web/desktop providers store them and read them in `rowCount`/`fetchRange` exactly as today.
- **Empty list.** `replaceFilters([])` == `filter(null)` (both clear). Implementations must map both
  to the same internal empty state, so an engine request's filter bytes are unchanged.

### 5.2 Model transaction

The model owns the transaction. It must stop treating "the promise rejected" as "nothing changed".

New additive state (both publicly readable, engine-neutral, no new union that silently re-labels the
existing `filters` getter):

| Field            | Meaning                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `filters`        | **Published** list — the only list UI may present as effective. Existing getter (`:254-258`), unchanged.      |
| `filtersUnknown` | `true` only when the provider is known **not** to hold the published list and the model could not restore it. |
| `reloadError`    | `string \| null` — the provider's message from a post-acceptance `refresh()` failure (case (b)), or `null`.   |

Failure shape — one typed error carrying **value-free phase metadata** (no predicates, no column
names, no engine text beyond the existing `cause`, which callers already frame through
`engineErrorMessage`):

```ts
export type FilterFailurePhase =
  | 'refused-before-change' // (a) provider list untouched, published list untouched
  | 'accepted-reload-failed' // (b) provider + published list are the NEW list; refresh failed
  | 'restore-failed' // (c) provider list is unknown; published list is not the provider's

export class FilterApplyError extends Error {
  readonly phase: FilterFailurePhase
  readonly cause: unknown
}
```

`phase` is an enum, never interpolated into copy. `cause` exists only so today's framing helpers
(`apps/web/src/edit/session.ts:248`, `:399-401`) keep working; nothing new logs or telemetries it
(ADR 0025).

Per-run procedure — the whole of C02a's behaviour, inside the existing serialized queue:

```text
run(list):
  validate all specs            → TypeError (unchanged; phase 'refused-before-change', 0 pushes)
  if superseded before the first push            → settle quietly (nothing happened)
  target := lastProviderListKnown
  if provider.replaceFilters:
      try await provider.replaceFilters(list)
      catch c:
          if superseded …                       → settle (provider untouched)
          else                                  → throw FilterApplyError('refused-before-change', c)
      lastProviderListKnown := list
  else:                                          // legacy sequence
      try { await provider.filter(null); await provider.filter(s) for each s }
      catch c:
          restoreOneShot(target)                 // ≤ 1 attempt, below
          throw FilterApplyError(restoreSucceeded ? 'refused-before-change' : 'restore-failed', c)
      lastProviderListKnown := list
  if superseded after the pushes:
      restoreOneShot(target)                     // the provider really holds `list`; undo it
      settle quietly                             // published list never disagreed with the provider
  published := list
  try await refresh()
  catch c:
      reloadError := message(c)                  // NO rollback, NO restore: (b)
      throw FilterApplyError('accepted-reload-failed', c)

restoreOneShot(target):                          // exactly one attempt, model-owned
  if target is UNKNOWN            → filtersUnknown := true; return false
  try replaceFilters(target) | (filter(null) + each target spec)
      lastProviderListKnown := target; filtersUnknown := false; return true
  catch:
      lastProviderListKnown := UNKNOWN; filtersUnknown := true; return false
```

Invariant (the thing the C02 tests must assert): **after every settled request,
`published === lastProviderListKnown` OR `filtersUnknown === true`. No state where the UI claims a
list the provider does not hold.**

`filtersUnknown` clears only on a successful `setFilters`/`replaceFilters` (a "Clear filters" click
is such a success). `retry()` (`:358-368`) does not clear it and must not be documented as clearing
it.

### 5.3 Why not "the model auto-rolls back on reload failure"

Because case (b) is not a rejection: the provider already applied the list and the engine's own
`WHERE` was accepted. Rolling back would issue a second filter sequence _and_ a second scan per
failed apply, and would report the user's list as "not applied" while the engine is happily filtering
by it. The honest report is "applied, view not reloaded, Retry".

## 6. Transition table (the C02 test matrix)

`published` = `model.filters`; `prov` = provider's effective list; `out` = what `setFilters` settles
with. "Today" values come from §4 probes.

| #   | Scenario                                                        | Today (verified)                                          | Required outcome                                                                                                                                                                                                           |
| --- | --------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | (a) malformed spec anywhere in the list                         | `TypeError`, 0 pushes                                     | Unchanged: `TypeError` (or `FilterApplyError('refused-before-change')` — C02 picks one and pins it), published/prov untouched, no epoch.                                                                                   |
| T2  | (a′) `replaceFilters` rejects, a list is already accepted       | n/a                                                       | `FilterApplyError('refused-before-change')`; published = old list; prov = old list; no `refresh()`, no epoch bump, cache intact.                                                                                           |
| T3  | (b) accepted, then `rowCount()`/`schema()` rejects              | rejects; published = new list; count stale; cache dropped | `FilterApplyError('accepted-reload-failed')`; published = new list; prov = new list; `reloadError` set; `filtersUnknown === false`; **no** restore push; UI says "applied, view not reloaded + Retry → `model.refresh()`". |
| T4  | (c) legacy mid-sequence push rejects, restore succeeds          | published = old, prov = `[s1]` (probe B)                  | Model issues **exactly one** restore of the old list; then `FilterApplyError('refused-before-change')`; published = prov = old; cache intact; callers do not restore.                                                      |
| T5  | (c′) legacy mid-sequence push rejects, restore **also** rejects | not represented                                           | `FilterApplyError('restore-failed')`; `filtersUnknown === true`; published unchanged; no claim that either list is in effect; UI offers Re-apply and Clear filters.                                                        |
| T6  | rapid: two requests in one tick                                 | second supersedes first before any push                   | Unchanged: 0 pushes for the loser, one provider sequence for the winner, one `refresh()`.                                                                                                                                  |
| T7  | superseded **after** its pushes (probe F/D2 shape)              | published = old, prov = superseded list                   | One `restoreOneShot(target)` → prov = published = old list; loser settles quietly (no rejection, no refresh); winner then applies normally.                                                                                |
| T8  | superseded accepted A, then newer B **refused before change**   | published = A, prov = `[]` (probe D)                      | B's refusal restores `target = A` (one attempt); published = prov = A; B throws `refused-before-change`; no state claims B.                                                                                                |
| T9  | shared sort/filter ordering (probe F)                           | published filters `[]`, prov filtered                     | T7 applies to the filter run (restore to `target`), then the sort run proceeds and refreshes once: published filters/sort == prov.                                                                                         |
| T10 | stale/late page delivery                                        | generation guard drops it                                 | Unchanged (`load()` bump at `:303-306`); add a case where the late page arrives **across** a T3 reload failure: it must not publish rows under the failed epoch.                                                           |
| T11 | poisoned queue entry                                            | queue never rejects (`:436-443`)                          | Unchanged: every outcome above leaves the next queued request able to run.                                                                                                                                                 |
| T12 | `replaceFilters([])` (clear)                                    | `setFilters([])` pushes `filter(null)`                    | Same effective query bytes as today (`filters` absent/empty ⇒ no `WHERE`, `window-query.ts:71-76`), one call, one epoch.                                                                                                   |
| T13 | provider without the capability (P3/P4/P5)                      | legacy sequence                                           | Unchanged behaviour + T4/T5/T7 reconciliation. The capability is never required.                                                                                                                                           |

Out of scope for the table: a hard cancel of an in-flight engine query (ADR 0040 — no client-facing
interrupt) and any engine-side predicate pre-validation (would be SQL parsing outside `grid`).

## 7. Retry and clear exposure, error shape, ownership

| Surface                   | Anchor                                                          | Behaviour after C02                                                                                                                             |
| ------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Web filter bar            | `apps/web/src/grid/FilterBar.tsx:300-341` (`applyList`)         | Maps phase → copy; **drops** the `setFilters(previous)` restore at `:318`; per-filter Remove/chip remove and re-Apply stay the manual recovery. |
| Web profile top-k click   | `apps/web/src/App.tsx:1685-1746` (`applyProfileFilter`)         | Same mapping; keeps its own `isCurrentAttempt` currency filter (`:1712-1718`) — a stale attempt must still discard its own report.              |
| Web validation "failures" | `apps/web/src/sessions/useValidationSession.ts:278-308`         | Same; keeps `filterToFailuresError` copy surface.                                                                                               |
| Desktop filter bar        | `apps/vscode/webview/data-grid.ts:477-491`, error at `:494-503` | Phase mapping replaces the raw `error.message` text (today it prints the engine diagnostic verbatim into the panel).                            |
| Grid-level retry          | `apps/web/src/grid/DataGrid.tsx:1543` (`model.retry()`)         | Unchanged (spans only). A reload failure needs `model.refresh()`, exposed as the case-(b) Retry.                                                |
| Commit-level retry        | `apps/web/src/sessions/useEditingSession.ts:833-846`            | Unchanged; unrelated to filters.                                                                                                                |

Copy requirements (values never interpolated; predicates/columns never echoed in a _reload_ failure):

- (a) refused: today's sentence stays honest — `apps/web/src/edit/session.ts:247-248`
  ("… The previous filters are still in effect.") — **only** for this phase.
- (b) accepted + reload failed: new sentence, e.g. "The filters were applied, but the grid could not
  be reloaded. Retry to reload the view." No "previous filters" claim; the accepted chips stay.
- (c) restore failed: today's double-failure sentence
  (`apps/web/src/grid/FilterBar.tsx:329-331`) becomes reachable from the model, not from a caller
  guess, and must be paired with an explicit Clear-filters affordance.

**Single owner of restoration: `GridViewportModel`.** Exactly one attempt, inside the queue, of the
pre-run accepted list; nothing above the model pushes filters for recovery. Both current restores are
removed by C02b/C02c. Nothing is restored for case (b) by anybody.

**What stays non-atomic (statement required by the row):** the legacy `filter(null)` + N×`filter()`
sequence. Each call is atomic about _itself_ only. Between calls the provider holds a prefix of the
requested list, so a mid-sequence rejection is a **partial apply**, and no compensation can promise
atomicity if the restoring sequence also fails — the model may only report `restore-failed` and mark
`filtersUnknown`. Providers that keep using the legacy path keep that limitation; the grid never
pretends otherwise.

## 8. Caller map

| Caller                             | Anchor                                                                                                                      | Owner of state                                          | C02 change                                                             |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------- |
| Web filter bar apply/list          | `apps/web/src/grid/FilterBar.tsx:300-341`; error render `:668`                                                              | `model` (`useSyncExternalStore` on `model.subscribe`)   | Drop restore; phase → copy; keep single-flight `pending` (`:306`).     |
| Web profile filter                 | `apps/web/src/App.tsx:1685-1746`                                                                                            | `phase.model` captured at attempt start (`originModel`) | Drop restore; keep `isCurrentAttempt` + attempt bump on model/session. |
| Web validation → failing rows      | `apps/web/src/sessions/useValidationSession.ts:278-308`                                                                     | `phase.model`                                           | Drop restore; phase → copy.                                            |
| Web programmatic (pipeline/proofs) | `apps/web/src/pipeline/usePipelineSession.ts:226` (own model)                                                               | its own model                                           | No change (no filters issued).                                         |
| Desktop filter bar                 | `apps/vscode/webview/data-grid.ts:477-491`                                                                                  | `this.model`                                            | Phase → copy; no restore exists today.                                 |
| Desktop test-mode proofs           | `apps/vscode/webview/dataset.ts:1020`, `:1549`, `:1682`, `:1837`, `:1848`                                                   | the proof's model                                       | No behaviour change; must keep compiling (capability optional).        |
| Grid unit tests                    | `packages/grid/src/viewport-model.test.ts:867-1043`, `:1116-1138`                                                           | `FakeProvider`                                          | Add the T1–T13 rows; keep the existing pins.                           |
| Web component/model tests          | `apps/web/src/grid/FilterBar.test.tsx:41-125`, `:1107-1170`; `apps/web/src/App.profile-filter.test.tsx:137-165`, `:499-518` | mocked model / real model                               | Re-pin the "restore happened" assertions to the new phases.            |
| Desktop proof provider             | `apps/vscode/webview/dataset.ts:1776-1786`                                                                                  | inline object                                           | Nothing to add (optional capability).                                  |

## 9. Minimum C02 scope recommended

- **C02a (grid):** `replaceFilters?` in `contracts.ts`; `setFilters` transaction per §5.2;
  `FilterApplyError` + `filtersUnknown` + `reloadError`; `restoreOneShot`; T1–T13 as unit tests on
  `FakeProvider` (which gains an atomic mode, a refusing mode and a partial-apply mode). `@assay/grid`
  is a published package, so the child carries a **minor** changeset for the additive capability.
- **C02b (web):** implement `replaceFilters` in `DuckDbGridProvider` (one assignment); delete the two
  caller restores; phase → copy; update the three test subjects; one real-engine assertion that an
  invalid predicate now reports case (b) and that the accepted chips remain.
- **C02c (desktop):** same capability in `EngineGridProvider`; `data-grid.ts` phase → copy; no bridge
  protocol change; assertions in the extension-host proof or a pure extraction (a unit subject does
  not exist today).
- Serial children, grid → web → desktop, each with its own changeset and review; old callers keep
  compiling between merges because the capability is optional and the error class is additive.

## 10. Open approvals needed before C02a starts

1. The `FilterApplyError` surface (§5.2) — a new exported error class from `@assay/grid`; alternative
   is a plain `TypeError`-style object, but then callers cannot distinguish phases structurally.
2. Whether T1 keeps `TypeError` (no phase metadata) or wraps it. Recommendation: keep `TypeError`
   (a programming error is not a user-facing phase) and make `FilterApplyError` cover only the three
   provider/refresh outcomes.
3. Copy for case (b) and the Clear-filters affordance in the double-failure alert (§7) — user-visible,
   so it needs the same copy acceptance the other web rows had.
