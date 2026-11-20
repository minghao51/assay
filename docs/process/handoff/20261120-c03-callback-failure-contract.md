# C03a — reset/activation failure contract and probe evidence

**Date:** 2026-11-20. **Row:** C03a (DESIGN, W2). **Selected decision:** Q5 = fail closed — reset
callbacks stay synchronous, a fault never publishes ready, commit activation gets an explicit
unknown/restoration-failed outcome with retry (recorded in
[improvement-plan execution record](20261120-improvement-plan-execution.md) §2).
**Companion record:** [C01 filter transaction contract](20261120-c01-filter-transaction-contract.md).
**Baseline:** `0150699` in this worktree; every anchor re-checked at write time.
**Status:** design + probes delivered. No product code, test or copy changed; C03b is **not**
implemented here.

## 1. Question this row answers

The improvement plan records two source-observed seams and asks for a _honest_ contract, not a
rollback fantasy:

1. `apps/web/src/sessions/session-reset.ts:65-69` bumps the session token and then invokes every
   registered reset with no isolation.
2. `apps/web/src/edit/session.ts:505-541` calls `effects.setActive(next)` **outside** the refresh
   protection while its own documentation says "Never throws" (`apps/web/src/edit/session.ts:460-492`, the
   claim at `:479`).

Both were classified by the plan as "bounded contract/fault-injection candidates, not proven ordinary
data loss". This record classifies every callback, injects the faults, and states the strongest
contract that is defensible.

## 2. Inventory A — registered session resets

Registration order is React effect order, i.e. App-body declarations first, then hook bodies
(`useEditingSession` at `apps/web/src/App.tsx:1099`, `useValidationSession` `:1334`,
`usePipelineSession` `:1364`, `useDiffSession` `:1406`).

| #   | Registration                                                         | Callback body                                                                                                                                                                                                   | Classification |
| --- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| R1  | `apps/web/src/App.tsx:833-838`                                       | `setActiveTask(DEFAULT_WORKBENCH_TASK)`, `setJumpOrigin(null)`                                                                                                                                                  | (i)            |
| R2  | `apps/web/src/App.tsx:1025-1031`                                     | `openSourceRef.current = null`                                                                                                                                                                                  | (i)            |
| R3  | `apps/web/src/App.tsx:1053-1061`                                     | `sqlRequestLedger.reset()` (pure field writes, `App.tsx:192-195`), `setRecoveryHiddenSections(...)` returning a `Set`                                                                                           | (i)            |
| R4  | `apps/web/src/sessions/useEditingSession.ts:899`, body `:885-897`    | `setEditError(null)`, `setViewError(false)`, 2× cast-pending ref/state, `mutationStateRef = 0`, `historyRevision+1`, `overlayRef = null`, `emptyHistory()`, `historyRef`, `setHistory`, `setOverlayRevision(0)` | (i)            |
| R5  | `apps/web/src/sessions/useValidationSession.ts:331`, body `:324-330` | 4 setters + `validationSeq.current += 1`                                                                                                                                                                        | (i)            |
| R6  | `apps/web/src/pipeline/usePipelineSession.ts:295`, body `:282-293`   | 2 token refs `+= 1`, `guardRef.current?.invalidate()` (`packages/engine-duckdb/src/pipeline-runner/guard.ts:25-27`, a counter increment), `guardRef = null`, 6 setters                                          | (i)            |
| R7  | `apps/web/src/sessions/useDiffSession.ts:287`, body `:279-286`       | 3 setters, `comparisonRef = null`, 2 seq refs `+= 1`                                                                                                                                                            | (i)            |
| R8  | the registry itself — `apps/web/src/sessions/session-reset.ts:62-75` | `tokenRef += 1`, then `for (const reset of resets) reset()` with **no try/catch**                                                                                                                               | **(ii)**       |

**(i)** = synchronous, nonthrowing by contract: no `await`, no throw, no external/engine/plugin call,
no user-supplied callback. Every statement is a React state setter (a no-op after unmount, never a
throw), a ref write, a counter increment, or a pure value construction (`new Set()`,
`emptyHistory()` from `@assay/domain`). The classification is about **current source**, not a
language guarantee: a future registrant that awaits or throws is category (ii) and is exactly what
R8's missing isolation permits.

**(ii)** = may throw: `beginSession` invokes arbitrary `() => void` values in Set order with no
isolation, so one callback's throw aborts the remaining callbacks _and_ propagates to the caller.
Nothing in the type or the runtime enforces the documented "synchronous React setters and ref writes"
claim (`session-reset.ts:24-29`).

No registrant is category (iii) unknown in current source. The three `beginSession()` call sites are
outside category (i)/(ii) — they are the _consumers_ and they have no `try/catch`:

| Call site                                                              | Context                                                          | Fault consequence today (by inspection)                                                                                                                                                                                                         |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/App.tsx:1854-1857` (`cancelOpen`)                        | React `onClick` (`:3007`)                                        | token bumped, some resets ran, `setPhase({kind:'idle'})` never runs → UI stuck in `opening` with an invalidated session; the throw escapes the click handler, so no error boundary catches it (React boundaries do not cover event handlers).   |
| `apps/web/src/App.tsx:2436` (`openDataFile`)                           | async, **before** its `try` at `:2463`                           | the returned promise rejects → `void openDataFile()` call sites (`:2216`, `:2652`, `:2688`, `:2841`, `:2907`, `:3060`) drop it as an unhandled rejection; phase stays `opening`.                                                                |
| `apps/web/src/App.tsx:2281` (`adoptReplacementCandidate`, step 1 of 9) | inside the `try` of `prepareReplacementCandidate` (`:2099-2111`) | steps 2–9 never run; the throw reaches `failReplacement` (`:1982-1988`), which reports an ordinary _open failure_ while the previous session was already invalidated. The "previous session untouched" promise of WF-06 is false in that state. |

## 3. Inventory B — `CommitEffects.setActive`

| #   | Implementation                                                                                                                                              | Classification                                                       | Note                                                                                                                                                                                                                         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | `apps/web/src/sessions/useEditingSession.ts:312-326` (`activateHistory`), passed at `:409`                                                                  | (i) by body inspection; (iii) if a React-internal setter ever throws | Body: early `return` when `phase.kind !== 'ready'`, then 2 ref writes, `overlaySnapshot(...)`, 2 React setters. The early return is a **silent conditional no-op** — the commit then still refreshes and can report success. |
| A2  | `apps/web/src/edit/session.test.ts:450,464,487,505,527,545,564,584,606`                                                                                     | test doubles                                                         | `:545` is a no-op; `:564` asserts call order `validate → setActive → refresh` (`:572`).                                                                                                                                      |
| A3  | desktop analogue — `provider.setOverlay(...)` at `apps/vscode/webview/main.ts:404`, `apps/vscode/webview/dataset.ts:378` (class `grid-provider.ts:141-143`) | (i)                                                                  | Desktop has **no** `CommitEffects`/`commitWithRollback`; its activation is a plain field assignment. C03b must not invent a desktop activation contract.                                                                     |
| A4  | `CommitEffects.refresh` (`apps/web/src/edit/session.ts:435`) — the only genuinely external effect                                                           | (ii)                                                                 | `() => phase.model.refresh()` → provider/engine; may reject and may throw synchronously. Both are already contained (see §4 probe 3).                                                                                        |

## 4. Probe evidence

### 4.1 Reset registry (injected fault, real `useDatasetSession`)

Throwaway vitest file in the `web` project (deleted before committing; no suite change). Three resets
registered in order A→B→C, B throws:

```text
thrown = injected reset fault
token before/after = 0 -> 1
resets that ran = ["A-first","B-middle"]
second beginSession thrown = injected reset fault
resets after second = ["A-first","B-middle","A-first","B-middle"]
```

Confirms: (1) the token is bumped **before** any callback (the documented ordering holds and is
therefore not the bug); (2) a fault in the middle aborts the remainder (`C-last` never ran in that
epoch); (3) there is no per-callback isolation — the next `beginSession` re-runs everything and throws
again, so a deterministic fault makes every later open fail, while the callbacks that never ran keep
the _previous_ dataset's state alive inside a session that is already invalidated (fail-**open**
state, not fail-closed).

### 4.2 Commit activation (real `commitWithRollback`, injected effects)

| Probe | Injected fault                                         | Observed                                                                                                                                  |
| ----- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | `setActive(next)` throws                               | **rejects** with the raw fault: the documented "Never throws" contract (`session.ts:479`) is false.                                       |
| 2     | `setActive(previous)` (the rollback activation) throws | **rejects**: the honest double-failure message is never built, so `restoreFailed` is lost too.                                            |
| 3     | `refresh()` throws synchronously                       | resolves `{message: "…could not be applied… Restoring the previous view also failed…", restoreFailed: true}` — sync throws are contained. |
| 4     | `validate()` rejects                                   | resolves the framed refusal, `restoreFailed: false` — R1-C pre-validation is already honest.                                              |
| 5     | `refresh()` rejects both times                         | activation order `[next, previous]`, `restoreFailed: true`, retry copy.                                                                   |

**What a rejection from probe 1/2 becomes in the product** (by inspection of the only caller):
`commitHistory` (`useEditingSession.ts:395-440`) awaits it inside `try { … } finally { … }` with no
`catch`, so the rejection propagates to `enqueue`'s catch (`:351-369`), which calls
`showEditError(engineRejectionMessage(error))` — i.e. the alert reads _"The engine rejected this edit:
&lt;activation fault&gt;. The previous view is unchanged."_ while:

- `setActive(next)` may already have written `historyRef`/`overlayRef` (statements 1–4 of
  `activateHistory:314-324`) before the throw, so an uncommitted overlay can be published;
- no restore activation and no refresh ran;
- `setViewError(result.restoreFailed)` never ran, so **no retry affordance appears**.

That is the exact failure the plan forbids: a swallowed fault reported as a successful rollback.

### 4.3 What the fault descriptions show without a runnable injection

- **Fault in the first reset** (R1): the six later resets keep the old dataset's editing history,
  contract, comparison and pipeline state in a session whose token already moved. The next successful
  open is unaffected (the registry re-runs everything), but every in-flight guard has already been
  invalidated while the UI still shows the old data as ready.
- **Adoption** (`App.tsx:2281`): the invalidating step is step 1 of 9, so a fault there leaves the
  live session destroyed, the candidate engine table opened but never rebound/adopted (retained per
  ADR 0047 with no release op), and `failReplacement` reporting a per-file open failure whose copy
  names the file, not the real cause.
- **`cancelOpen`**: the throw is an uncaught exception in a click handler; React error boundaries do
  not catch it (`apps/web/src/ErrorBoundary.tsx:5-25` scopes them to render paths), so the honest
  outcome is a stuck `opening` phase with a dead session.

## 5. Selected contract (the strongest honest one)

### 5.1 Session resets

1. **Reset callbacks remain synchronous and must not throw.** The registry type stays
   `registerReset(reset: () => void)`, and the documentation (`session-reset.ts:21-29`) is upgraded
   from description to contract: _no `await`, no throw, no external call; state writes and counter
   bumps only._ Rejected alternative: making the registry `Promise<void>` — that would let a reset
   outlive the token bump it is supposed to fence, which is strictly worse.
2. **Token first, then every callback under its own isolation.** `beginSession` keeps bumping
   `tokenRef` before any callback (verified ordering) and wraps **each** invocation; a fault is
   recorded, not rethrown, and the remaining callbacks still run. This is the "attempts every reset
   after invalidating the generation" half of Q5.
3. **Fail closed.** `beginSession` returns a value-free outcome. The open/adoption/cancel flows must
   **not** publish `ready`, must not run the rest of their guarded chain, and must surface a
   recovery frame instead. No `ready` state is reachable after a faulted reset.
4. **No rollback promise.** The faulted callbacks' effects are whatever they were; the contract says
   "this session is abandoned", never "the previous session was restored". For adoption that means:
   the previous session is **already gone** by contract (its generation was invalidated) — the only
   honest recovery is a fresh session (reload).
5. **Never swallow.** A faulted reset is always reported to the user; it is never converted into
   success, and never into the generic per-file open-failure message that hides the cause.

### 5.2 Commit activation

6. **`commitWithRollback` never rejects** (its documented contract becomes true): `setActive(next)`,
   `setActive(previous)` and both `refresh()` calls are individually contained.
7. **Activation is a three-valued fact, not a boolean.** After an activation fault the code must
   distinguish _nothing activated_, _activated then restored_, and _may have activated and could not
   restore_. The last one is reported as **unknown** with retry — never as a rejection of the value
   and never as "the previous view is unchanged".
8. **`restoreFailed: true` is exactly `activation === 'unknown'`** (keeps the existing
   `viewError`/`Retry loading the view` affordance at `App.tsx:3101-3115` /
   `useEditingSession.ts:833-846`).
9. **No arbitrary rollback promise:** the restore path re-activates the previous history and
   re-materializes it; if either step fails, the contract says the view is unknown and offers retry.
   Pre-validation refusal (R1-C) still leaves history untouched, and a successful commit still
   produces exactly one history entry / one undo step (no change to those invariants).

## 6. Proposed API surface

### 6.1 Session epoch (`apps/web/src/sessions/session-reset.ts`)

```ts
/** One value-free reset fault. Never carries an error message, column or value. */
export interface SessionResetFault {
  /** Registration order within this epoch, 0-based. */
  readonly index: number
  /** Closed enum — the only fault class a reset can produce. */
  readonly kind: 'reset-callback'
}

export interface SessionResetOutcome {
  /** The new session token (bumped before any callback ran). */
  readonly token: number
  /** Empty means every registered reset completed. */
  readonly faults: readonly SessionResetFault[]
}

export interface DatasetSession {
  readonly tokenRef: { current: number }
  beginSession: () => SessionResetOutcome // was `() => number`
  readonly registerReset: (reset: () => void) => () => void
}
```

`beginSession` never throws. Call sites adapt trivially (`const { token } = datasetSession.beginSession()`
where the token is needed; `openDataFile` compares `datasetSession.tokenRef.current !== token`).

### 6.2 Commit outcome (`apps/web/src/edit/session.ts`)

```ts
export type CommitActivation =
  | 'applied' // setActive(next) resolved and refresh() resolved
  | 'refused-before-activation' // validate() rejected; nothing was activated
  | 'rolled-back' // an activation or refresh fault was undone by setActive(previous) + refresh()
  | 'unknown' // activation or restoration may have partially happened; retry required

export interface CommitResult {
  readonly message: string | null
  readonly restoreFailed: boolean // === (activation === 'unknown')
  readonly activation: CommitActivation // additive; existing consumers keep compiling
}
```

Behaviour matrix (`commitWithRollback`, all rows resolve, none reject):

| Sequence                                                                   | Result                                                                                                                            |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `validate` rejects                                                         | `refused-before-activation`, today's framed refusal, `restoreFailed: false` (unchanged).                                          |
| `setActive(next)` ok, `refresh()` ok                                       | `applied`, `message: null` (unchanged).                                                                                           |
| `setActive(next)` ok, `refresh()` rejects, restore ok                      | `rolled-back`, today's single-failure message (unchanged).                                                                        |
| `setActive(next)` ok, `refresh()` rejects, restore fails                   | `unknown`, today's double-failure message, `restoreFailed: true` (unchanged).                                                     |
| `setActive(next)` **throws**, restore (`setActive(previous)` + refresh) ok | `rolled-back`, new copy: _"The change could not be applied: the view could not be updated. The previous view has been restored."_ |
| `setActive(next)` **throws**, restore throws or its refresh rejects        | `unknown`, new copy naming both steps + retry, `restoreFailed: true`.                                                             |
| `setActive(previous)` **throws** during a normal restore                   | `unknown`, same copy as above (never a silent rejection).                                                                         |

### 6.3 Recovery copy (proposals; value-free, no dataset/file/column text)

| Case                              | Copy                                                                                                                                                                               | Affordance                                                                                                                   |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| session reset fault (any flow)    | "This session could not be closed cleanly, so it was ended instead of shown. Reload the page to start a clean session."                                                            | `Reload the page` button — reuse the existing pattern `window.location.reload()` (`apps/web/src/ErrorBoundary.tsx:204-207`). |
| commit activation unknown         | Today's `view-error` line ("The grid could not be restored to a trustworthy view.") plus the retry button (`App.tsx:3101-3115`) — **reuse**, do not invent a second retry surface. | `Retry loading the view` (`retryView`).                                                                                      |
| commit activation fault, restored | "The change could not be applied: the view could not be updated. The previous view has been restored." (edit-error alert)                                                          | none (nothing to retry)                                                                                                      |

## 7. State-transition table

| #   | Injection                                             | Required state                                                                                                                                          |
| --- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | fault in the **first** reset                          | token bumped; **all 7** callbacks attempted; `faults = [{index:0,…}]`; no `ready`; recovery frame; earlier resets' effects kept.                        |
| S2  | fault in a **middle** reset                           | same, fault index = that callback; later callbacks still ran (the probe's `C-last` case is what C03b must invert).                                      |
| S3  | fault in the **last** reset                           | same; nothing left to preserve.                                                                                                                         |
| S4  | fault, then a **subsequent clean** `beginSession`     | run again from scratch (fault is per-invocation, not sticky); the earlier fault is not re-reported.                                                     |
| S5  | adoption (`adoptReplacementCandidate`) with a fault   | steps 2–9 skipped; no ready phase; the candidate is not rebound/published; outcome is the session-fault frame, **not** a per-file open-failure message. |
| S6  | `cancelOpen` with a fault                             | idle/recovery frame reached instead of a stuck `opening`; no uncaught event-handler throw.                                                              |
| S7  | `openDataFile` with a fault                           | chain abandoned before the picker result is used; no `ready`; recovery frame.                                                                           |
| S8  | commit: **next** activation throws, restore ok        | `rolled-back`; previous view on screen; alert names the activation step, not the value.                                                                 |
| S9  | commit: **previous** activation throws                | `unknown`; retry affordance; no "previous view is unchanged" claim.                                                                                     |
| S10 | commit: **second** (restore) refresh rejects          | `unknown` (unchanged today), retry affordance, both failures named — probe 5 passes today and must stay passing.                                        |
| S11 | commit: `setActive` silently no-ops (phase not ready) | must not report `applied`: either assert the precondition in the composition root or treat an unpublished activation as `unknown`.                      |
| S12 | fault while a stale async result is in flight         | the token bump already fences it (unchanged); the fault must not resurrect it, and the recovery frame must not render old-session data.                 |

## 8. Caller reservations C03b needs

| File / symbol                                                                                                                                                                             | Change                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/sessions/session-reset.ts` (`useDatasetSession`)                                                                                                                            | per-callback isolation, `SessionResetOutcome`, contract doc rewrite.                                                                      |
| `apps/web/src/App.tsx:1854-1857` (`cancelOpen`)                                                                                                                                           | declare the outcome; fault → recovery frame.                                                                                              |
| `apps/web/src/App.tsx:2436` (`openDataFile`)                                                                                                                                              | `token` from the outcome; fault → abandon before the first `await`.                                                                       |
| `apps/web/src/App.tsx:2266-2331` (`adoptReplacementCandidate`) + `:1982-1988` (`failReplacement`)                                                                                         | return a discriminated refusal so the caller can render the session-fault frame instead of the open-failure frame.                        |
| `apps/web/src/App.tsx:2963-2981` (replacement failure panel) and a new session-fault alert                                                                                                | new render branch; keep `replace-error-detail` value-free (today it prints `error.message` raw).                                          |
| `apps/web/src/edit/session.ts:495-541` (`commitWithRollback`), `:455-458` (`CommitResult`)                                                                                                | containment + `activation`; copy rows §6.3.                                                                                               |
| `apps/web/src/sessions/useEditingSession.ts:395-440` (`commitHistory`)                                                                                                                    | consume `activation`; map `unknown` → `setViewError(true)`; keep `aborted()` handling.                                                    |
| `apps/web/src/sessions/useEditingSession.ts:351-369` (`enqueue` catch)                                                                                                                    | keep as the last-resort net, but the dishonest `engineRejectionMessage` fallback must not be the _first_ reporter of an activation fault. |
| tests: `apps/web/src/sessions/session-errors*.test.tsx`, `App.replace.test.tsx:190`, `App.csv-review.test.tsx:170`, `App.panel-boundary.test.tsx:42`, `apps/web/src/edit/session.test.ts` | fake sessions/results updated for the new shapes.                                                                                         |

Explicitly **not** reserved: `apps/vscode/**` (no reset registry, no `CommitEffects`), `packages/**`
(no grid/engine change), `docs/**` outside this record and the C01 record.

## 9. Assertions C03b must implement

1. Registry: a throwing callback at index 0 / middle / last → **every** callback is still invoked
   (`invocation order` recorded), `faults` matches the injected index, and `beginSession` does not
   throw.
2. Token ordering: the token is incremented **before** the first callback, and a callback reading
   `tokenRef.current` sees the new token (the probe's `0 -> 1` must be re-pinned as an assertion).
3. No ready after a fault: `openDataFile`, `cancelOpen` and `adoptReplacementCandidate` each reach a
   non-`ready` state and render exactly one session-fault frame; assert that no `dataset_opened`
   telemetry is emitted on the faulted path (`App.tsx:2311`, step 8).
4. Adoption atomicity: with a fault in step 1, `phase` never becomes the candidate's ready phase,
   `rebindOverlaySource` is never called (`:2289`), and the failure is **not** rendered as
   `replace-error` (the per-file open-failure copy).
5. `commitWithRollback` never rejects: repeat probes 1–5 as tests (`setActive(next)` throws,
   `setActive(previous)` throws, sync `refresh` throw, `validate` rejection, double refresh failure).
6. Activation honesty: for the `setActive(next)`-throws case, the message must not contain
   `previous view is unchanged` and `restoreFailed` must reflect reality; `activation` must equal the
   table in §6.2.
7. Unknown ⇒ retry: `activation === 'unknown'` sets `viewError` true so `view-retry` exists and a
   successful `retryView()` clears it (existing behaviour, now also reachable from activation faults).
8. No silent no-op: `setActive` that does not publish (phase not ready) must not produce
   `activation: 'applied'`.
9. Preservation: R1-C pre-validation refusal still changes no history; a successful commit is still
   one history entry/one undo step; WF-06 preservation assertions (`App.replace.test.tsx`,
   `App.csv-review.test.tsx`) and ADR 0049 retention are unchanged.
10. Value-free: the fault frame, the alert text and the recorded fault contain no error message text,
    file name, column name or cell value; assert with a `VIOLENT` sentinel error message that the
    rendered DOM never contains it, and that the fault object has only the enum + index.

## 10. Narrower, documentation-only outcomes (and why)

| Case                                               | Recommendation                                                                     | Justification                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/vscode/webview/**` reset/adoption            | **Documentation-only.**                                                            | There is no session-reset registry and no `CommitEffects` there (verified: `grep registerReset`/`CommitEffects` return nothing under `apps/vscode`); a dataset change rebuilds the provider/model (`dataset.ts:361-366`). Inventing a symmetric contract would be a new abstraction, not a repair. |
| `PipelineRunGuard.invalidate()`                    | **Nothing beyond classification.**                                                 | A counter increment (`guard.ts:25-27`); cannot throw.                                                                                                                                                                                                                                              |
| `enqueue`'s catch (`useEditingSession.ts:363-368`) | **Keep**, but demote to last-resort net.                                           | It already never swallows a failure silently; the defect is that it is the _first_ reporter for activation faults, which §5.2 fixes.                                                                                                                                                               |
| `retryView` / `viewError`                          | **Reuse as-is.**                                                                   | It already re-materialises the active overlay and clears the honest error (`:833-846`); C03b only makes it reachable from activation faults.                                                                                                                                                       |
| Making reset callbacks `async`                     | **Rejected** (not documentation-only — a behaviour change that is strictly worse). | A reset that awaits cannot fence a token bump it has not yet observed; the current synchronous contract is the correct shape.                                                                                                                                                                      |
| Full rollback of arbitrary reset side effects      | **Rejected as impossible.**                                                        | Reset callbacks write React state and refs across 7 owners; no snapshot/restore exists and none can be proven. The contract states "session abandoned" instead.                                                                                                                                    |
| Desktop export/writer failures                     | **Out of scope.**                                                                  | Covered by B03/B04; no callback registry involved.                                                                                                                                                                                                                                                 |

## 11. Non-goals and preserved invariants

- No hard-cancel/interrupt of an in-flight engine op (ADR 0040). A faulted session is _abandoned_, not
  aborted.
- No table release, no retained-table cleanup, no persistence (ADR 0047/0049 untouched).
- No change to R1 validation-before-commit, WF-06 session preservation, undo/redo semantics, or the
  one-history-entry-per-commit rule.
- No new telemetry event; a reset/activation fault is not emitted with any payload.
- No dependency-direction change: the grid/engine packages are untouched; everything here is
  `apps/web`.
