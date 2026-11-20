# C01 — whole-list filter transaction contract and caller map

**Date:** 2026-11-20. **Row:** C01 (DESIGN, W2). **Selected decision:** Q4 = optional atomic
`replaceFilters` capability, legacy path stays documented as non-atomic (recorded in
[improvement-plan execution record](20261120-improvement-plan-execution.md) §2).
**Companion record:** [C03a callback-failure contract](20261120-c03-callback-failure-contract.md).
**Baseline:** `0150699` (`main`; this record was written on `wp-design`, and every anchor below was
re-checked in that worktree at write time). **Status:** design delivered; no product code, test or type changed.
C02a/b/c implement from this record after review.
**Revision 1 (2026-11-20, review round 1):** two semantics this record had left to the implementation
are now settled: the single reconciliation rule for overlapping requests (§5.2 **R-C01**, applied to
T7/T8/T8b/T9 and to every restore path) and the error/status API (§10, decisions 1–5). T1 no longer
offers a choice, and no section hands a semantic decision to C02a.

## 1. What this record settles, and what it does not

Settles: the provider capability shape, the model-side transaction and **one** reconciliation rule
for overlapping requests (R-C01), the transition table C02 must implement, the error/status API
(`FilterApplyError` + `reloadError`, §10), who owns restoration, and the caller/symbol map for web,
desktop and tests.

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
- **No metadata on the rejection.** A provider rejects with its own existing error (`Error`, or the
  engine/client error it would already surface) and adds nothing: no phase, no predicate echo, no
  wrapper type. Phase classification is the model's job (§5.2), so a provider obligation stays
  exactly what `sort`/`filter` already require (`contracts.ts:127-151`).

### 5.2 Model transaction

The model owns the transaction. It must stop treating "the promise rejected" as "nothing changed".

New additive state (all publicly readable, engine-neutral, no new union that silently re-labels the
existing `filters` getter):

| Field            | Meaning                                                                                                                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `filters`        | **Published** list — the only list UI may present as effective. Existing getter (`:254-258`), unchanged.                                                                                                 |
| `filtersUnknown` | `true` only when the provider is known **not** to hold the published list and the model could not restore it.                                                                                            |
| `reloadError`    | `string \| null` — the provider's message from a post-acceptance `refresh()` failure (case (b)), or `null`. Diagnostics only: the UI copy for that case comes from `phase`, never from this string (§7). |

Failure shape — one typed error, carrying only **value-free phase metadata** (no predicates, no
column names, no engine text beyond the existing `cause`, which callers already frame through
`engineErrorMessage`):

```ts
export type FilterFailurePhase =
  | 'refused-before-change' // (a′)/(c) the target list is in effect; published list untouched
  | 'accepted-reload-failed' // (b) provider + published list are the NEW list; refresh failed
  | 'restore-failed' // (c′) provider list is unknown; published list is not the provider's

export class FilterApplyError extends Error {
  readonly phase: FilterFailurePhase
  readonly cause: unknown
}
```

`phase` is an enum, never interpolated into copy. `cause` exists only so today's framing helpers
(`apps/web/src/edit/session.ts:248`, `:399-401`) keep working; nothing new logs or telemetries it
(ADR 0025). The class is exported from `@assay/grid` (`packages/grid/src/index.ts:31-41`), sets
`name = 'FilterApplyError'` so `instanceof` and logs stay usable, and is the **only** new exported
symbol C02a adds (`reloadError`/`filtersUnknown` are model members, not a new union). `cause` is the
provider's error **unchanged** — the class adds no values of its own (T2 asserts identity).

**`TypeError` is not a phase.** Malformed specs keep rejecting with the plain `TypeError` that
`assertFilterSpec` already throws before any provider call (`viewport-model.ts:154-161`); it is a
programming error, not a caller-recoverable outcome, so it carries no `phase` and C02a must not wrap
it (T1, §10 decision 3).

Per-run procedure — the whole of C02a's behaviour, inside the existing serialized queue:

```text
run(list):
  validate all specs            → TypeError (unchanged; NO phase, 0 pushes)
  if superseded before the first push            → settle quietly (nothing happened)
  target := published            // R-C01: read HERE, inside the queue, never at call time
  if provider.replaceFilters:
      try await provider.replaceFilters(list)
      catch c:
          if superseded …                       → settle (provider untouched; target still effective)
          else                                  → throw FilterApplyError('refused-before-change', c)
      providerList := list                      // a fact about the provider, NOT yet effective
  else:                                          // legacy sequence
      try { await provider.filter(null); await provider.filter(s) for each s }
      catch c:
          restoreOneShot(target)                 // ≤ 1 attempt, below
          throw FilterApplyError(restored ? 'refused-before-change' : 'restore-failed', c)
      providerList := list
  if superseded after the pushes:
      restoreOneShot(target)                     // R-C01 rule 1: `list` must never become effective
      settle quietly                             // no rejection, no publish, no refresh, no epoch
  published := list                              // R-C01 rule 2: effective ONLY together with refresh
  try await refresh()
  catch c:
      reloadError := message(c)                  // NO rollback, NO restore: (b)
      throw FilterApplyError('accepted-reload-failed', c)
  reloadError := null

restoreOneShot(target):                          // exactly one attempt, model-owned
  // `target` is always the published list, so it is never UNKNOWN: the model published it itself.
  try replaceFilters(target) | (filter(null) + each target spec)
      providerList := target; filtersUnknown := false; return true
  catch:
      providerList := UNKNOWN; filtersUnknown := true; return false
```

**R-C01 — the one reconciliation rule for overlapping requests.** The reconciliation target of every
run is the **published** list — `model.filters`, the list the model applied _and_ refreshed — read
when the run's provider section starts inside the serialized queue. It is never a snapshot captured
when `setFilters` was called, and never the list a superseded run merely pushed.

1. A request the provider accepted but that was superseded **before it published** (T7, T8b)
   restores the provider to `target` with one `restoreOneShot` and publishes nothing. Its
   provider-accepted list never becomes effective; nothing outside the queue can observe it. If that
   restore fails, the loser still settles **quietly** (a superseded request never rejects — nobody is
   waiting on its outcome any more) and `filtersUnknown` becomes `true`: T5's state is reachable from
   T7, and the next request's `target` is still the published list.
2. A request that completed its transaction — provider accepted, `published := list`, `refresh()`
   resolved — is authoritative. A later request refused before it changed anything restores that
   list and leaves it effective (T8, probe D).
3. If the restore itself fails, rule 2's list is still what the UI shows, but the model no longer
   knows the provider's list: `restore-failed` + `filtersUnknown === true` (T5).

Why not "retain the accepted list instead of restoring" (the alternative reading of T8)? Because the
model's totals and cache belong to a data **epoch**, and an epoch only exists after `refresh()`
(`load()` bumps `generation` and re-reads `rowCount`/`schema`, `viewport-model.ts:303-318`, `453-457`).
A superseded run must not start a refresh — that is the existing pin (`setFilters` doc,
`viewport-model.ts:404-412`: "a superseded call neither assigns `filterState` nor starts a
refresh"). Publishing `list` without refreshing would leave `totalRows`/cache computed under the
previous list while `fetchRange` serves rows filtered by the new one — the provider's own `rowCount`
follows its list (`packages/grid/src/viewport-model.test.ts:73-81`), so row indices would shift under
the renderer. That is exactly the divergence probe F describes and the invariant below forbids.
Retaining `list` is not an option with a refresh either: it would open a second epoch for a request
the user had already replaced, and if the winning request is then refused nothing would ever publish
the retained list's counts. The single rule is therefore: **converge on the published list; a
provider-accepted list becomes effective only together with its refresh.**

Invariant (the thing the C02 tests must assert): **after every settled request,
`published === providerList` OR `filtersUnknown === true`, and `totalRows`/cache continue to belong
to the epoch of the published list. No state where the UI claims a list the provider does not hold,
and no state where the provider serves rows of a list whose epoch was never loaded.** The one
documented exception is the case (b) state, where `reloadError !== null` records that the epoch could
not be rebuilt (T3).

`filtersUnknown` clears only on a successful `setFilters`/`replaceFilters` (a "Clear filters" click
is such a success). `retry()` (`:358-368`) does not clear it and must not be documented as clearing
it. `reloadError` is set only by case (b) and is cleared by the next successful `refresh()`/`load()`
(including the user's Retry), never by a filter restore.

### 5.3 Why not "the model auto-rolls back on reload failure"

Because case (b) is not a rejection: the provider already applied the list and the engine's own
`WHERE` was accepted. Rolling back would issue a second filter sequence _and_ a second scan per
failed apply, and would report the user's list as "not applied" while the engine is happily filtering
by it. The honest report is "applied, view not reloaded, Retry".

## 6. Transition table (the C02 test matrix)

`published` = `model.filters`; `prov` = provider's effective list; `out` = what `setFilters` settles
with; `target` = the published list that run reconciles to (R-C01 — read inside the queue, never at
call time); `A`/`B` = two successive requested lists; `P` = the list published **before** `A`.
"Today" values come from §4 probes.

| #   | Scenario                                                                                                         | Today (verified)                                          | Required outcome                                                                                                                                                                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | (a) malformed spec anywhere in the list                                                                          | `TypeError`, 0 pushes                                     | **Settled, no choice left:** the rejection is the plain `TypeError` from `assertFilterSpec` (identical to today), **not** a `FilterApplyError`, and it carries no `phase`; 0 pushes; published/prov untouched; no epoch. C02a asserts `instanceof TypeError` **and** `!(… instanceof FilterApplyError)`. |
| T2  | (a′) `replaceFilters` rejects, a list is already accepted                                                        | n/a                                                       | `FilterApplyError('refused-before-change')` whose `cause` is the provider's rejection **unchanged** (`toBe`); no grid-added fields; published = prov = old list (= `target`); no `refresh()`, no epoch bump, cache intact.                                                                               |
| T3  | (b) accepted, then `rowCount()`/`schema()` rejects                                                               | rejects; published = new list; count stale; cache dropped | `FilterApplyError('accepted-reload-failed')`; published = new list; prov = new list; `reloadError` set (diagnostics only — never rendered raw); `filtersUnknown === false`; **no** restore push; UI says "applied, view not reloaded + Retry → `model.refresh()`".                                       |
| T4  | (c) legacy mid-sequence push rejects, restore succeeds                                                           | published = old, prov = `[s1]` (probe B)                  | Model issues **exactly one** restore, to `target` = the published old list; then `FilterApplyError('refused-before-change')`; published = prov = old; cache intact; callers do not restore.                                                                                                              |
| T5  | (c′) legacy mid-sequence push rejects, restore **also** rejects                                                  | not represented                                           | `FilterApplyError('restore-failed')`; `filtersUnknown === true`; published unchanged; no claim that either list is in effect; UI offers Re-apply and Clear filters. Also reachable from T7 (a superseded run's restore may fail; it still settles quietly).                                              |
| T6  | rapid: two requests in one tick                                                                                  | second supersedes first before any push                   | Unchanged: 0 pushes for the loser, one provider sequence for the winner, one `refresh()`.                                                                                                                                                                                                                |
| T7  | superseded **after** its pushes (probe F/D2 shape)                                                               | published = old, prov = superseded list                   | **R-C01 rule 1:** one `restoreOneShot(target)` → prov = published = old list; the loser publishes **nothing** (no `filterState` assignment, no `refresh()`, no epoch bump, no rejection); winner then applies normally.                                                                                  |
| T8  | **published** `A`, then newer `B` **refused before change**                                                      | published = `A`, prov = `[]` (probe D)                    | **R-C01 rule 2:** `B`'s refusal restores `target = A` (one attempt); published = prov = `A`; `B` throws `FilterApplyError('refused-before-change')`; no state claims `B`.                                                                                                                                |
| T8b | `A` **accepted by the provider but superseded before publish**, then `B` refused before change (the overlap row) | not represented in probes                                 | **R-C01 rule 1, then rule 2:** `A` restores `target = P` and publishes nothing, so `B`'s `target` is `P` and its refusal leaves published = prov = `P`. **`A` never becomes effective** — no assertion may expect `A` here, and the transition table and §9.1 agree on that.                             |
| T9  | shared sort/filter ordering (probe F)                                                                            | published filters `[]`, prov filtered                     | R-C01 rule 1 applies to the filter run (restore to `target` = the published list, no refresh, no epoch), then the sort run proceeds and refreshes once: published filters/sort == prov, and `totalRows`/`getRow` belong to the restored list's epoch.                                                    |
| T10 | stale/late page delivery                                                                                         | generation guard drops it                                 | Unchanged (`load()` bump at `:303-306`); add a case where the late page arrives **across** a T3 reload failure: it must not publish rows under the failed epoch.                                                                                                                                         |
| T11 | poisoned queue entry                                                                                             | queue never rejects (`:436-443`)                          | Unchanged: every outcome above leaves the next queued request able to run.                                                                                                                                                                                                                               |
| T12 | `replaceFilters([])` (clear)                                                                                     | `setFilters([])` pushes `filter(null)`                    | Same effective query bytes as today (`filters` absent/empty ⇒ no `WHERE`, `window-query.ts:71-76`), one call, one epoch.                                                                                                                                                                                 |
| T13 | provider without the capability (P3/P4/P5)                                                                       | legacy sequence                                           | Unchanged behaviour + T4/T5/T7 reconciliation. The capability is never required.                                                                                                                                                                                                                         |

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

**Single owner of restoration: `GridViewportModel`.** Exactly one attempt, inside the queue, **to the
published list** (R-C01 `target`) and only for a run that actually changed the provider; nothing
above the model pushes filters for recovery. Both current restores are removed by C02b/C02c. Nothing
is restored for case (b) by anybody.

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

## 9. Minimum C02 scope and the assertions each child implements

- **C02a (grid):** `replaceFilters?` in `contracts.ts`; `setFilters` transaction per §5.2;
  `FilterApplyError` + `filtersUnknown` + `reloadError`; `restoreOneShot`; T1–T13 as unit tests on
  `FakeProvider` (which gains an atomic mode, a refusing mode and a partial-apply mode; the refusing
  mode must also be able to refuse `replaceFilters` without touching its list). `@assay/grid` is a
  published package, so the child carries a **minor** changeset for the additive capability.
- **C02b (web):** implement `replaceFilters` in `DuckDbGridProvider` (one assignment); delete the two
  caller restores; phase → copy; update the three test subjects; one real-engine assertion that an
  invalid predicate now reports case (b) and that the accepted chips remain.
- **C02c (desktop):** same capability in `EngineGridProvider`; `data-grid.ts` phase → copy; no bridge
  protocol change; assertions in the extension-host proof or a pure extraction (a unit subject does
  not exist today).
- Serial children, grid → web → desktop, each with its own changeset and review; old callers keep
  compiling between merges because the capability is optional and the error class is additive.

### 9.1 Assertions that pin the settled semantics

C02a (grid, on `FakeProvider`; row labels are §6):

1. **T1/§10-3:** a malformed spec rejects with `TypeError`, `!(err instanceof FilterApplyError)`,
   `filterCalls` empty, `stats` unchanged.
2. **T2:** atomic refusal → `phase === 'refused-before-change'`, `err.cause` is the provider's own
   error object (`toBe`), `model.filters`/provider list unchanged, zero `load()` calls.
3. **T3:** post-accept refresh failure → `phase === 'accepted-reload-failed'`, `reloadError !== null`,
   `filtersUnknown === false`, provider list = the new list, and the provider push log ends at the new
   list (no restore push after it).
4. **T4/T5:** legacy mid-sequence refusal → exactly **one** restore sequence in the provider log; its
   target is the published list, not the refused list; `restore-failed` sets `filtersUnknown === true`
   and leaves `model.filters` at the published list.
5. **T7 (R-C01 rule 1):** publish P, hold the pushes, request A, supersede A, release → A restores P,
   A publishes nothing (`model.filters` never reads A: assert via a `subscribe` version that no
   intermediate snapshot carries A), and no epoch is opened by A (fetch-log length and `load()` count
   unchanged until the winner runs).
6. **T8 (R-C01 rule 2):** publish A, then refuse B → `model.filters` = A, provider list = A,
   `phase === 'refused-before-change'`, exactly one restore, no `load()`.
7. **T8b (the overlap):** publish P, hold, request A, request B, release A (accepted), refuse B →
   `model.filters` = P and provider list = P; assert the provider log order is
   `P-apply … A-pushes, A-restore-to-P, then B's (refused) pushes`, and assert nothing ever publishes A.
   A test that expects A here is a **contract violation**, not a variant.
8. **Ordering of `target`:** a request whose run starts _after_ an earlier request published uses the
   newly published list as its target — in a publish-A-then-refuse-B sequence over the same queue,
   B's single restore must push A, not the list that preceded A (assert the provider log order).
9. **`filtersUnknown` / `reloadError` lifecycle:** cleared only by a successful `setFilters`
   (`filtersUnknown`) or a successful `refresh()` (`reloadError`); `retry()` clears neither.
10. **Value-free metadata:** `phase` is always one of the three enum values and carries no values;
    the class adds exactly `phase` + `cause` (plus `name`) — never a predicate, column list or
    snapshot — and the copy built from `phase` contains no predicate/column/cell text (assert with a
    `VIOLENT` sentinel in the predicate).
11. **Export surface:** `FilterApplyError`/`FilterFailurePhase` importable from `@assay/grid`
    (`index.ts`), `instanceof` works across the module boundary, `name === 'FilterApplyError'`.

C02b (web):

12. `DuckDbGridProvider.replaceFilters` stores the list in order and cannot reject; `replaceFilters([])`
    and `filter(null)` produce byte-identical engine requests (existing query-text assertion).
13. Each caller (`FilterBar.applyList`, `App.applyProfileFilter`, `useValidationSession`) calls
    `setFilters` **exactly once** per attempt — a spy asserts no compensating `setFilters(previous)` —
    and maps the three phases to the §7 sentences, including that case (b) never renders "previous
    filters are still in effect".
14. `model.reloadError` is never rendered: a `VIOLENT` sentinel in the injected reload error must not
    appear in the DOM (copy comes from `phase`).

C02c (desktop):

15. `EngineGridProvider.replaceFilters` mirrors row 12; `data-grid.ts` maps phases and drops the raw
    `error.message` text; the bridge protocol module is untouched (same message kinds).
16. Same 14-sentinel assertion for the webview error region.

## 10. Settled decisions (was: open approvals)

These were open in revision 0. They are **decided here** so C02a implements semantics instead of
choosing them; only the copy item (5) still needs review, and it blocks C02b, not C02a.

| #   | Question                                                           | Decision                                                                                                                                                                                                                                                                                                                | Why (source)                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Is the caller-visible distinction a **new** error shape?           | **Yes — one additive exported class**, `FilterApplyError` (`phase` + `cause`), exported from `@assay/grid` (`packages/grid/src/index.ts:31-41` is the existing export block). No new status union, no `GridRowSlot` change, no message parsing.                                                                         | The three outcomes are a caller-visible decision (retry vs re-apply vs clear) and must be readable without parsing text; the class is additive, so old callers keep compiling and `@assay/grid` ships a **minor** changeset.                                          |
| 2   | Does the optional `replaceFilters` rejection carry phase metadata? | **No.** A provider rejects with its own existing error (`Error` or the engine/client error it already surfaces); the grid adds no field, wraps nothing, and no provider may invent a phase. The **model** classifies and wraps (T2 asserts `cause` identity).                                                           | `contracts.ts:127-151` treats `sort`/`filter` rejections as plain rejections; adding provider-side metadata would be a second, unenforceable obligation on every implementation (P1–P6), and phase is a model concept.                                                |
| 3   | Does T1 keep `TypeError`, or is it wrapped?                        | **Keep `TypeError`, with no `phase`.** `FilterApplyError` covers only the three provider/refresh outcomes (`refused-before-change`, `accepted-reload-failed`, `restore-failed`).                                                                                                                                        | `assertFilterSpec` (`viewport-model.ts:154-161`) throws before any provider call and before the sequence bump; a malformed list is a programming error, not a user-recoverable phase, and today's tests already pin `TypeError` (`viewport-model.test.ts:1057-1070`). |
| 4   | How is the post-accept reload failure exposed?                     | **Model status in the existing shape:** `readonly reloadError: string \| null` (same shape as `stats.fatalError`, `viewport-model.ts:70-86`, `:277`), set only in case (b), cleared by the next successful `refresh()`/`load()`. UI copy comes from `phase`; this string is diagnostics only and is never rendered raw. | The model already exposes string diagnostics (`fatalError`) and a `string \| null` needs no new union; a boolean would lose the engine's framing input, and a new status union would re-label existing getters (§5.2 forbids that).                                   |
| 5   | Copy for case (b) + the Clear-filters affordance                   | **Proposal recorded in §7** ("The filters were applied, but the grid could not be reloaded. Retry to reload the view." + Clear filters in the double-failure alert) — needs copy acceptance **before C02b merges**.                                                                                                     | User-visible copy gets the same acceptance gate as the other web rows; it is not a C02a dependency.                                                                                                                                                                   |

Nothing above is handed to C02a as a choice: C02a implements decisions 1–4 and the §9.1 assertions
verbatim; C02b/C02c consume the phase mapping and decision 5's copy.
