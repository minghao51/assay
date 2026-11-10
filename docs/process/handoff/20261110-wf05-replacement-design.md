# WF-05 — replacement-safety design (read-only successor contract, unapproved)

**Status:** design only, **no runtime authority**. WF-06 stays BLOCKED until the maintainer signs the
numbered decisions in §10 and a fresh WF-06 brief reserves real seams. Produced under row WF-05 as
approved in the [approval record](20261110-web-followup-approval.md) (WFD-01=B,
2026-11-10), satisfying the question table in
[spec §4.5](../../product/14-web-interface-followup-spec.md).

**Provenance:** the body below is the read-only design agent's verbatim deliverable at `c883b42`, with no
repository change (main checkout clean before and after; no branch, worktree, commit or push).

**Orchestrator spot-check (2026-11-10):** the four load-bearing claims were re-read in source and hold —
`beginSession()` runs at `App.tsx:1611` before the picker resolves and again at `:1592`; the ready subtree
is gated on `phase.kind === 'ready'` (`App.tsx:1965`); the Open button is disabled only while
`phase.kind === 'opening'` (`App.tsx:1856-1864`) and `openDataFile` calls `setExportOpen(false)`
(`App.tsx:1619`), which is the Open-during-Export defect reported in §7; and no `hasAppliedChanges`
helper exists yet (the §2 predicate is a proposal, not shipped code).

---

# WF-05 — replacement-safety successor design (read-only)

**Row:** WF-05 under **WFD-01 = B** ("commission WF-05 design only"). This document is a
_design artifact_. It writes no runtime code, edits no repository file, reserves no branch, and
grants **no authority to WF-06**.

**Baseline inspected:** `c883b42ac193e21adf19094bb151d6950843c5c0` (`main`), worktree clean before and
after (`git status --porcelain` = empty). Every behavioural claim below cites the source at this
revision. Doc references: spec §4.5 (`docs/product/14-web-interface-followup-spec.md:120-144`),
approval record `docs/process/handoff/20261110-web-followup-approval.md` (§1, §2 WFD-01=B),
audit §2 G4 (`docs/reviews/2026-11-10-web-svg-followup-audit.md:24`), rd decisions
`docs/process/handoff/20261104-rd-decisions-and-runtime-scope.md:280` (D-07 = "stay deferred"),
ADR 0012 (overlay + staged transaction), ADR 0011 (dataset identity), ADR 0044 (shell).

**No** wall-clock gates were run for this row; runtime was not revalidated. Read-only source and
document inspection only (see §11).

---

## 0. Executive finding (three sentences)

The defect is **ordering, not absence of a guard**: `openDataFile` performs the irreversible part of a
replacement — `beginSession()` plus the phase switch to `opening` — at `apps/web/src/App.tsx:1611` and
`App.tsx:1617`, _before_ `pickDataFile` is even called at `App.tsx:1641`, so cancellation
(`App.tsx:1649-1653`), any open failure (`App.tsx:1733-1751`) and every intermediate step throw away a
session that could have been preserved. **No engine or protocol change is required** to preserve it:
`beginSession` is a plain App-owned epoch/reset call
(`apps/web/src/sessions/session-reset.ts:59-75`), the engine client already supports a second
concurrently-registered table (precedent: comparison B-side staging,
`apps/web/src/sessions/useDiffSession.ts:107-140`), and reads are handle-scoped
(`packages/engine-duckdb/src/table-registry.ts:64-67`). The one real limitation is that the client
has **no per-table release op** — `dispose()` is terminal and drops everything
(`packages/engine-duckdb/src/client.ts:1030-1038`, already recorded in-repo at `App.tsx:1262-1267`) —
so a _retired_ table can never be freed individually; that is a disclosed carry-over class that this
design bounds to at most one table per adoption, not a reason to refuse preservation.

---

## 1. Observed baseline sequence (source-confirmed, with citations)

### 1.0 The irreversible prefix, shared by every ingress

`openDataFile` is defined at `apps/web/src/App.tsx:1596` and is the **only** dataset-entry function in
the app. It has exactly four call sites: drop (`App.tsx:1783`), header Open (`App.tsx:1862`), example
(`App.tsx:1876`), retry (`App.tsx:1951`). Everything below happens _before_ any file exists:

| Step                             | Site                                      | Effect                                                                                                            |
| -------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| read + clear one-shot sources    | `App.tsx:1601-1607`                       | `exampleFileRef` / `pendingDropFileRef` consumed before any await                                                 |
| `setDropNotice(null)`            | `App.tsx:1610`                            | idle-only notice cleared                                                                                          |
| **`beginSession()`**             | `App.tsx:1611` → `session-reset.ts:59-75` | token `+1`, then **every registered reset runs synchronously**                                                    |
| panel preload                    | `App.tsx:1616`                            | fire-and-forget chunk warm-up                                                                                     |
| **`setPhase({kind:'opening'})`** | `App.tsx:1617`                            | the live session leaves React state                                                                               |
| slot clears                      | `App.tsx:1618-1627`                       | `recordRequest`, `exportOpen`, `sqlRequest`, `actionError`, `scrollRequest`, `sourceIdentityRef`, `openSourceRef` |

`beginSession` (`apps/web/src/sessions/session-reset.ts:59-75`) bumps `tokenRef` and then runs the
registered resets in registration order. The complete registered set at this revision:

- `apps/web/src/App.tsx:636-643` — `activeTask` → default, `jumpOrigin` → null
- `apps/web/src/App.tsx:827-834` — `openSourceRef.current = null` (pipeline re-bind source)
- `apps/web/src/App.tsx:857-868` — `sqlRequestLedger.reset()`, `recoveryHiddenSections` cleared
- `apps/web/src/sessions/useEditingSession.ts:466-479` — `editError`, `viewError`,
  `castPendingColumn` cleared, `historyRevision += 1`, **`overlayRef.current = null`**,
  `historyRef.current = emptyHistory()`, `setHistory(empty)`, `overlayRevision = 0`
- `apps/web/src/sessions/useValidationSession.ts:324-331` — contract → `none`, run → `idle`,
  jump/filter errors cleared, `validationSeq += 1`
- `apps/web/src/sessions/useDiffSession.ts:277-287` — comparison → `none`, diff run → `idle`,
  `comparisonRef = null`, `comparisonSeq += 1`, `diffSeq += 1`
- `apps/web/src/pipeline/usePipelineSession.ts:286-297` — run/preview tokens, guard invalidated,
  file/bindings/run/preview/DCR state reset

Then `setPhase({kind:'opening'})` matters as much as the resets: the ready subtree is gated on
`phase.kind === 'ready'` (`App.tsx:1965`), so **the grid, FilterBar (`App.tsx:2214`), DataGrid
(`App.tsx:2331`), schema/validation/diff/pipeline/SQL/Export sections and every component-local draft
unmount**. The completion-announcement effect also clears the previous session's announcement on any
non-ready phase (`App.tsx:536-543`).

**Net effect: by the time the user has merely been shown a file chooser, the entire live session is
already gone.** The old engine table is still registered worker-side, but every App-side reference to
it (`model`, `handle`, `base`, `provider` — the `ready` phase payload, `apps/web/src/sessions/types.ts:24-43`)
has been dropped, so it is unreachable.

### 1.1 Per ingress

**(a) Header Open** — `App.tsx:1856-1868`. `disabled={phase.kind === 'opening'}` is the only guard.
With `oneShotFile === null` the flow calls `pickDataFile` (`App.tsx:1641-1647`), then:

- token re-check `App.tsx:1648`;
- `picked === null` (picker dismissed, `packages/data-sources/src/pick-file.ts:85-88` for the FSA
  abort path, `pick-file.ts:130-136` for the hidden-input `cancel` event) → `setPhase({kind:'idle'})`
  at `App.tsx:1649-1653`. **The session from step 1.0 is not restored; the app is `idle`.**

**(b) Retry** — `App.tsx:1944-1957`, inside the `phase.kind === 'error'` block. Same function, same
destroy-first prefix. Nothing live exists to lose here, but the pattern is identical and any future
"retry from ready" path would inherit it.

**(c) Example dataset** — `App.tsx:1871-1886`. Rendered only when `phase.kind === 'idle'`; it parks
`new File([nestedFixtureText], 'nested.jsonl')` in `exampleFileRef` and re-enters the same flow with a
one-shot source (`App.tsx:1661-1666`).

**(d) Idle drop** — `App.tsx:1755-1791`. The window `drop` listener returns early unless
`phaseRef.current.kind === 'idle'` (`App.tsx:1766`); a drop in `ready`/`error`/`opening` is prevented
(`event.preventDefault()` in every phase, `App.tsx:1765`) and otherwise ignored. **Drop cannot reach a
live session today** — that is already the shipped "no accidental widening" rule and must be preserved.

**(e) Programmatic** — none beyond the four sites above. No worker, panel, task, context-bar or
telemetry path calls `openDataFile`. The context bar's `export` action opens the dialog only
(`App.tsx:1214-1219`).

**(f) Cancel opening (the other destroyer)** — `cancelOpen` at `App.tsx:1591-1594` calls
`beginSession()` and `setPhase({kind:'idle'})`, i.e. it is an _honest token discard_, not an engine
interrupt (comment at `App.tsx:1585-1590`). In the current machine it is only reachable during
`opening` (`App.tsx:1899-1903`), and during `opening` there is no session left to return to.

### 1.2 Exactly what is destroyed, at which failure point

| Asset                                                                    | Where it lives now                                                                                  | Destroyed at                                          |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| session token (epoch)                                                    | `session-reset.ts:59-67`                                                                            | `App.tsx:1611` (every ingress)                        |
| grid model + provider + active **sort/filter**                           | `phase.model` / `provider` (`types.ts:24-43`), query state in `apps/web/src/grid/provider.ts:39-48` | `App.tsx:1617` (unmount) then `1611` reset            |
| base metadata (anchors, columns, row count)                              | `phase.base`                                                                                        | `App.tsx:1617`/`1611`                                 |
| **overlay history** (all staged ops + undo/redo cursor, incl. redo tail) | `useEditingSession` state/refs                                                                      | `useEditingSession.ts:472-475`                        |
| edit error / view error / cast-pending / edit announcement               | same hook                                                                                           | `useEditingSession.ts:467-475`                        |
| **validation contract + verdict + run**                                  | `useValidationSession`                                                                              | `useValidationSession.ts:325-330`                     |
| **staged B comparison + row diff + report + stale flag**                 | `useDiffSession` (comparison handle in `comparisonRef`, `useDiffSession.ts:107-140`)                | `useDiffSession.ts:279-285`                           |
| **pipeline file/bindings/run/preview/DCR export**                        | `usePipelineSession`                                                                                | `usePipelineSession.ts:288-296`                       |
| **SQL text, result page, run status**                                    | `SqlPanel` component state (`apps/web/src/sql/SqlPanel.tsx:112-113, 316`)                           | unmount at `App.tsx:1617`                             |
| SQL request claims                                                       | `sqlRequestLedger` (`App.tsx:851-868`)                                                              | `App.tsx:1611`                                        |
| **filter compose drafts + accepted filters**                             | `FilterBar` local state (`apps/web/src/grid/FilterBar.tsx:200-214`) + model                         | unmount + model drop                                  |
| **cell editor draft**                                                    | `DataGrid` local `editing` (`apps/web/src/grid/DataGrid.tsx:280`)                                   | unmount (see §3 for the blur race)                    |
| column rename/cast draft                                                 | `ColumnControls` local state (`apps/web/src/schema/SchemaPanel.tsx:149-161`)                        | unmount                                               |
| record inspector request                                                 | `recordRequest`                                                                                     | `App.tsx:1618`                                        |
| export dialog + destination choice + result line                         | `exportOpen` / `ExportDialog` state (`App.tsx:592`, `apps/web/src/export/ExportDialog.tsx:67-98`)   | `App.tsx:1619`                                        |
| **export same-source identity**                                          | `sourceIdentityRef` (`App.tsx:1616-1620` comment, `1626`, set `1677-1679`)                          | `App.tsx:1626` — even if the picker is then cancelled |
| pipeline re-bind source (`openSourceRef`)                                | `App.tsx:1722`                                                                                      | `App.tsx:1627` and `827-834`                          |
| active task / jump origin / recovery-hidden sections                     | `App.tsx:636-643`, `857-868`                                                                        | `App.tsx:1611`                                        |

Failure-point map of the acquisition chain (each of these ends in `phase = error`, old session gone):

1. `picked.source.getFile()` rejects → `App.tsx:1659` → catch `1733-1751`.
2. `engineClient.open` rejects (unsupported extension decided worker-side,
   `packages/engine-duckdb/src/engine-executor.ts:478-484`; read errors, etc.) → `App.tsx:1680-1683`.
3. `engineClient.schema` / `rowCount` reject → `App.tsx:1689-1692`.
4. `model.load()` rejects → `App.tsx:1708` (**table already registered** → orphan entry; the worker
   only rolls back a failed `engine/open` itself, `engine-executor.ts:486-494`).
5. `preloadBottomPanels()` rejects → `App.tsx:1714` (**fully loaded candidate discarded**, table orphaned).
6. Late resumption after a newer epoch → silent `return` at `1648/1660/1684/1690/1692/1709/1715/1735`;
   if this is the only chain in flight the UI can be left in `opening` with no owner.

---

## 2. Definition of "dirty"

### 2.1 Proposed predicate (pure, outcome-aware, prefix-based)

```ts
// apps/web/src/edit/session.ts — pure, Node-testable, no React/engine imports
export function hasAppliedChanges(history: TransformationHistory): boolean {
  for (let i = 0; i < history.cursor; i += 1) {
    if (history.entries[i]?.outcome.status === 'applied') return true
  }
  return false
}
```

"Active applied history" = `entries[0..cursor)` containing at least one entry whose logged outcome is
`applied`, exactly the split documented at `packages/domain/src/history.ts:60-70` and the outcome union
at `packages/domain/src/overlay.ts:161-164`. `cursor` is the applied/redo boundary
(`history.ts:66-70`); `appendOp` truncates the redo tail on a new op (`history.ts:23-32`, `95-125`).

### 2.2 Why each alternative is wrong **here**

| Candidate                                                   | Verdict            | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `history.entries.length > 0`                                | **wrong**          | Undo only moves the cursor (`history.ts:148-156`); after undoing everything, `entries.length > 0` while the effective state equals the base (`stateAtCursor` is a pure fold of the prefix, `history.ts:186-196`). Also true for logged no-ops.                                                                                                                                                                                                         |
| `history.cursor > 0`                                        | **wrong**          | No-op entries are _appended_ with cursor advance and an empty inverse (`history.ts:34-39`, `history.ts:95-125`); the reachable no-op reasons include `cell-value-unchanged`, `cell-already-base`, `rename-identity`, `cast-identity`, `row-already-deleted` (`overlay.ts:166-178`, surfaced in `apps/web/src/edit/session.ts:101-108`). A session whose only entry is an honest no-op would report dirty.                                              |
| `overlayRevision > 0` (`useEditingSession.ts:118`)          | **wrong**          | It is bumped by `activateHistory` on _every_ activation — each op **and every undo/redo/selective-cursor move** (`useEditingSession.ts:194-205`, called from `handleUndo` `268-274`, `handleRedo` `276-282`, `handleSelectCursor` `398-409`). Undo-to-zero leaves it `> 0`. It is also reset to 0 on session reset (`useEditingSession.ts:475`), so it cannot distinguish "never edited" from "reset".                                                 |
| `historyRevision > 0` (ref, `useEditingSession.ts:138-146`) | **wrong**          | Same activation bumps (`useEditingSession.ts:200`) **plus** `reset()` (`470`) — it is a _race_ tag for the cast pre-check, not a change count.                                                                                                                                                                                                                                                                                                         |
| `activeOps(history).length > 0`                             | **wrong**          | `activeOps` drops outcomes (`apps/web/src/edit/session.ts:33-35`), so it counts logged no-ops. This is not hypothetical: the shipped UI already over-reports through it — the toolbar line `pendingChangesSummary(activeOps(history))` (`App.tsx:2072`) and the export dialog's `activeOperationCount={activeOps(history).length}` (`App.tsx:2127`, rendered as "Includes N staged changes", `ExportDialog.tsx:264-271`) both count no-ops as changes. |
| "`revision > 0`" as a domain concept                        | **does not exist** | There is no revision counter in `packages/domain/src/history.ts` / `overlay.ts`; `overlayRevision` is a _freshness_ tag consumed by stale banners (`useDiffSession.ts:104-106`), never a change count.                                                                                                                                                                                                                                                 |

### 2.3 Required cases

| Case                                                                                           | Predicate verdict                | Justification                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| undo-to-zero (all ops undone)                                                                  | **clean**                        | the effective view is the base fold again (`history.ts:186-196`); e2e "undo → clean" already pins this rendering (`DataGrid.tsx:224-231` doc block)                                                                                    |
| redo branch (cursor < length, applied prefix non-empty)                                        | **dirty**                        | applied ops are live; adopting destroys them _and_ the redo tail                                                                                                                                                                       |
| redo tail only (cursor = 0, applied ops all undone)                                            | **clean** (accepted loss)        | nothing is applied; the redo buffer is user-recoverable _work_ but not a change. See decision **M-D5**                                                                                                                                 |
| logged no-op at the cursor                                                                     | **clean**                        | outcome `no-op` with empty inverse (`history.ts:34-39`) — nothing was applied                                                                                                                                                          |
| pending operation (op appended, commit `refresh()` in flight; or `castPendingColumn !== null`) | **not evaluated**                | the predicate sees _published_ history. A pending mutation is handled by the settle rule (§4 `S1`), never by the predicate                                                                                                             |
| rejected edit rolled back (`commitWithRollback`)                                               | **clean**                        | `setActive(previous)` restores the previous history (`apps/web/src/edit/session.ts:419-470`), and a _conflict_ is never logged at all (`history.ts:127-131`; `useEditingSession.ts:250-268` only commits when `result.entry !== null`) |
| refused cast (pre-check)                                                                       | **clean**                        | nothing is appended (`useEditingSession.ts:400-421`)                                                                                                                                                                                   |
| row insert / delete / restore                                                                  | **dirty**                        | all are `EditOp`s in the same log (`apps/web/src/edit/op-summary.ts:27-36`)                                                                                                                                                            |
| column rename / cast                                                                           | **dirty**                        | same log, same `applyOp` path (`useEditingSession.ts:340-395`)                                                                                                                                                                         |
| A→B→A round trip                                                                               | **dirty** (accepted over-report) | two `applied` ops exist even though the net state equals the base. Reported because the guard question is "does replacing lose work?", and two undo steps are work. See **M-D6**                                                       |

### 2.4 What the predicate is **not**

It is **not** a "state equals base" comparison. Fold equality would silently treat A→B→A as clean and
would also have to ignore no-op entries anyway; it is strictly more code for a less honest answer. It
is also **not** a count for display: see the copy table — the guard intentionally carries **no number**
so it cannot disagree with the existing "N pending changes" line that includes no-ops.

---

## 3. Pending-draft policy, per surface

There is exactly **one** blur-commit in the application: `onBlur={commitEditDraft}` on the grid cell
editor (`apps/web/src/grid/DataGrid.tsx:1275`). Every other draft surface submits on an explicit
control. That asymmetry decides the policy.

### 3.1 The blur-commit race when Open is clicked mid-edit (source-confirmed defect, today)

Clicking the header Open control focuses a real `<button>` (`App.tsx:1857-1868`), which blurs the editor
input and runs `commitEditDraft` (`DataGrid.tsx:578-608`) **before** the click handler runs
`openDataFile`:

1. changed + valid draft → `commitEditValue` → `onCommitCell` → `applyOp` → `appendOp` →
   `commitHistory` (`useEditingSession.ts:248-268`, `224-246`). `commitWithRollback` calls
   `setActive(next)` **synchronously** (`apps/web/src/edit/session.ts:419-425`), so the edit is
   published into `history`/`overlayRef`, then `await effects.refresh()` starts.
2. the click handler then runs `beginSession()` → the reset at `useEditingSession.ts:466-479` throws that
   just-published edit away, and `setPhase({opening})` unmounts the grid.
3. the in-flight `model.refresh()` resolves into a model nobody renders.

So the current behaviour is worse than "silently commits": the draft is **committed and then discarded
by the same gesture**, with the announcement (`announceEdit('Edit committed.')`,
`useEditingSession.ts:238-241`) racing the teardown. An invalid draft is a second class: `commitEditDraft`
sets a visible error and keeps the editor open (`DataGrid.tsx:598-607`) — and then the teardown
unmounts it anyway, so the user's rejected input disappears with no acknowledgement.

### 3.2 Policy

| Surface                                             | Draft state today                                                                                                                                                       | Policy in the target machine                                                                                                                                                                                                                    | Rationale                                                                                                                                     |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cell editor — unchanged draft**                   | identical-to-initial draft on a non-NULL cell is an existing _cancel_ (`DataGrid.tsx:585-591`)                                                                          | **cancel, silently** (no new outcome)                                                                                                                                                                                                           | the only case where "commit" would manufacture a change; existing semantics already refuse it                                                 |
| **Cell editor — changed + valid**                   | blur-commits synchronously into history, then async refresh                                                                                                             | **never initiated by the replacement gesture.** The guard/choosing transition must wait for the commit to _settle_ (`S1`) and then describe the settled history. The guard must not commit, revert or re-order anything                         | the commit is the user's pre-existing gesture; the replacement's job is not to interpret it                                                   |
| **Cell editor — changed + invalid**                 | `commitEditDraft` refuses, keeps the editor open, sets `editError` + announcement (`DataGrid.tsx:598-607`)                                                              | **the destructive branch is refused while an un-settled invalid draft exists.** Open → focus returns to the offending editor + a value-free notice. Stay/Escape are unaffected                                                                  | no honest replacement decision exists over an input the user has not resolved; silently discarding it or silently committing it are both lies |
| **Column rename / cast draft**                      | local `renameDraft` / `castChoice` / `customTarget`; submitted only by `submitRename`/`submitCast` (`apps/web/src/schema/SchemaPanel.tsx:149-182`) — **no blur commit** | **not committed, not cleared on Stay.** A guard dismissal leaves the panel exactly as it was. The _destructive_ branch may proceed without it and the draft is lost at adoption                                                                 | it was never applied; committing it from a dialog is exactly the "silently commit on focus loss" the brief forbids                            |
| **Filter compose (`composeValue/Operator/Column`)** | `FilterBar.tsx:209-212`; only `applyCompose`/`applyDraft` commit (`FilterBar.tsx:357-386`) — **no blur commit**; Enter applies explicitly                               | same as above: **never auto-applied**. Stay preserves; adoption drops                                                                                                                                                                           |                                                                                                                                               |
| **Active filter-row predicate drafts**              | `drafts` map, re-seeded from the accepted list on every change (`FilterBar.tsx:281-298`)                                                                                | never auto-applied; **note the honesty gap**: an unapplied row draft is _not_ a change (§2), so a clean session carrying only drafts gets no dialog and the draft is lost on adoption. Disclosed in the guard body only when the guard is shown |                                                                                                                                               |
| **SQL text**                                        | `SqlPanel` `draft` textarea (`SqlPanel.tsx:316`)                                                                                                                        | not submitted by anything but Run; never auto-run. Lost on adoption, preserved on Stay                                                                                                                                                          | no auto-run is already a shipped invariant                                                                                                    |

### 3.3 How a modal must not silently commit or discard on focus loss

Because the grid editor commits on blur, a modal opened _from the Open control_ will always have
already blurred the editor. The design therefore splits the concern:

- **Never commit from the dialog.** The guard's handlers do not touch history. No `onCommitCell`,
  no `handleUndo`, no `setFilters` call exists on any guard path.
- **Describe only what settled.** `S1` (settle barrier, §4) makes the guard wait for
  `pendingMutation` (new seam, `useEditingSession` — nothing equivalent exists today: the hook exposes
  only `castPendingColumn` and `viewError`, `useEditingSession.ts:57-63`) before it renders a decision.
- **Refuse, don't guess, on an un-settled invalid draft.** That needs the editor's state to reach App:
  a new optional callback on `DataGrid` (`onEditorStateChange?: (state: 'none' | 'draft' | 'invalid') => void`,
  derived from `editing` + `editError` at `DataGrid.tsx:280, 578-607`). This is a _reporting_ seam; it
  changes no editing behaviour.
- **Stay restores nothing and destroys nothing.** Focus returns to the connected opener (the Open
  control); the editor stays mounted, still blurred, still showing its own error text.

---

## 4. Target state machine

### 4.1 Structural decision: the candidate is **not** a `Phase`

`Phase` describes the _live session_ (`apps/web/src/sessions/types.ts:24-43`) and is consumed as such by
every hook (`useEditingSession.ts:184-186, 224-246`; `useValidationSession`; `useDiffSession:107-140`)
and by the entire ready subtree (`App.tsx:1965`) plus the machine-readable `data-phase` attribute
(`App.tsx:1884-1886`). Adding candidate states to `Phase` would unmount the grid — the exact defect we
are removing. **Therefore:**

- `Phase` keeps exactly today's four kinds and today's transitions (`idle→opening→ready|error`,
  `ready↔…` unchanged). `data-phase` semantics are untouched, so no existing pin changes.
- A **separate App-local replacement intent** carries the candidate. It is pure state:

```ts
// apps/web/src/replace/machine.ts (new, pure/Node-testable)
type ReplacementIntent =
  | { kind: 'none' }
  | { kind: 'guard'; readonly seq: number } // live session rendered behind a native modal
  | { kind: 'choosing'; readonly seq: number } // OS picker owns focus; session untouched
  | { kind: 'opening-candidate'; readonly seq: number } // candidate chain in flight; session untouched
```

The candidate's table handle, base metadata, provider and model are **local variables inside the async
chain** (exactly as today at `App.tsx:1702-1716`) and become App state only inside `adopt()`. During
`opening-candidate` the App owns: the live session (unchanged objects) + one `File` + one parked FSA
handle + one parked source identity. The candidate owns a registered engine table that nothing in the
React tree references.

### 4.2 States and transitions

```text
                         (unchanged legacy path)
  idle ──Open/example/drop──▶ opening ──ok──▶ ready
    ▲                            └──fail────▶ error ──"Choose a different file…"──▶ opening

  ready ──Open──┬─ clean ─────────────────────────────▶ choosing
                └─ dirty ──▶ guard ──Stay/Esc─────────▶ ready            (nothing touched)
                              guard ──Export a copy…──▶ (ExportDialog) ─▶ ready + intent none
                              guard ──Choose a replacement file…──────▶ choosing

  choosing ──picker cancel────▶ ready + notice "Nothing was opened…"    (nothing touched)
  choosing ──getFile() fails──▶ ready + alert  (nothing touched)
  choosing ──File acquired────▶ opening-candidate

  opening-candidate ──success──▶ adopt() ──▶ ready(new session) + intent none
  opening-candidate ──fail────▶ ready + alert (nothing touched; candidate may orphan a table)
```

### 4.3 Per-transition ownership

| ID      | Transition                                                   | Live session owner                                                                  | Candidate owns                                   | Cancel / Escape                                                                | Repeated intent                    |
| ------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------ | ---------------------------------- |
| **T0**  | idle → `opening`                                             | nobody                                                                              | the chain                                        | `Cancel opening` (`App.tsx:1887-1903`) stays exactly as shipped: token discard | Open disabled (`1864`)             |
| **T1**  | ready(**clean**) + Open → `choosing`                         | App, untouched                                                                      | nothing yet                                      | picker cancel → `T6`                                                           | Open disabled while intent ≠ none  |
| **T2**  | ready(**dirty**) + Open → `guard`                            | App, untouched, rendered behind a **native modal**                                  | nothing                                          | Escape = **Stay** = `T3`                                                       | Open/Help/Export/Settings disabled |
| **T3**  | `guard` + Stay/Escape → `none`                               | unchanged, byte-for-byte                                                            | n/a                                              | —                                                                              | —                                  |
| **T4**  | `guard` + Export a copy… → intent `none`, ExportDialog opens | the export path (read-only, `useEditingSession.ts:432-445`)                         | n/a                                              | export cancel/refuse/error → **no** intent change                              | —                                  |
| **T5**  | `guard` + Choose a replacement file… → `choosing`            | unchanged                                                                           | nothing                                          | as T1                                                                          | —                                  |
| **T6**  | `choosing` + picker cancel → `none` + notice                 | **unchanged**                                                                       | nothing                                          | —                                                                              | —                                  |
| **T7**  | `choosing` + File → `opening-candidate`                      | unchanged; candidate chain runs in parallel (precedent `useDiffSession.ts:126-131`) | one `File`, parked handle, parked identity       | **no cancel offered** (see M-D8)                                               | —                                  |
| **T8**  | `opening-candidate` + success → `adopt()`                    | swapped atomically in one React batch                                               | everything, then published                       | —                                                                              | —                                  |
| **T9**  | `opening-candidate` + failure → `none` + `replace-error`     | **unchanged**                                                                       | possibly one orphan registered table (see §5 B1) | —                                                                              | —                                  |
| **T10** | any await resuming late                                      | —                                                                                   | dropped silently, no phase change                | —                                                                              | —                                  |
| **T11** | unmount / `beforeunload`/`pagehide`                          | `engineClient.dispose()` unchanged (`App.tsx:1262-1280`)                            | —                                                | —                                                                              | —                                  |

`adopt()` — the only irreversible step, and it is a pure state swap:

```text
adopt(candidate, parked):
  1. seq === currentSeq && phase === startPhase      // identity + epoch, see T10
  2. datasetSession.beginSession()                   // resets run HERE, exactly once
  3. historyRef.current = emptyHistory()
     overlayRef.current  = overlaySnapshot(candidate.base, emptyHistory())
                                                     // republish AFTER the reset; the reset nulls it
                                                     // (useEditingSession.ts:471-473)
  4. sourceIdentityRef.current = parked.identity
     openSourceRef.current     = parked.openSource
  5. setPanelModules(panels)
  6. setPhase({ kind:'ready', ...candidate })
  7. emit telemetry 'dataset_opened' (as today, App.tsx:1726-1732)
  8. intent = none
```

Steps 2-6 are all synchronous inside one handler, so React commits one frame: the old session is never
rendered in a half-adopted state. Step 3 is a hard requirement — the reset nulls `overlayRef`
(`useEditingSession.ts:471`) and the provider closure reads it per request
(`App.tsx:1705`), so forgetting it makes the adopted grid fall back to the captured
`overlaySnapshot(base, initialHistory)` only by luck of the closure.

### 4.4 Ownership of the destructive decision

The rule the brief demands: **no dialog promises preservation it does not implement.** In this machine
the promise is structural rather than verbal:

- The guard exists only for dirty sessions, and its destructive action does **not** discard anything —
  it opens a picker. Discard happens at `adopt()`, after a candidate has been proven openable.
- Therefore picker cancel, picker refusal, unsupported format, engine-open failure, schema/row-count
  failure and `model.load` failure all leave the session untouched **by construction**, not by promise.
- The guard body may state that outcome ("If you cancel the file chooser or the file cannot be opened,
  this session stays as it is") because the machine enforces it.

### 4.5 Busy rules (one pending intent)

- Entering `guard`/`choosing` requires a settled session (**S1**): `gridBusy === null`
  (App owns it, `App.tsx:555-575`), `castPendingColumn === null`
  (`useEditingSession.ts:57-63`), `pendingMutation === false` (new seam) and no export in flight
  (`exportOpen` closed).
- If S1 fails, the Open gesture does not open the guard; it renders a value-free busy notice and does
  nothing else. No queue, no retry loop.
- While intent ≠ `none`, the Open control is disabled (today's `disabled={phase.kind === 'opening'}`,
  `App.tsx:1864`, generalizes), Help/Export/Settings/Open are blocked the way `helpBlocked` already
  blocks Help (`App.tsx:616`), and drop/example stay idle-only (`App.tsx:1766`, `1871`).
- **During `opening-candidate` the ready subtree is `inert` + `aria-busy`** (React 19 supports `inert`;
  this repo is on React 19, `pnpm-workspace.yaml:13`). Rationale: with no Cancel offered and no
  re-guard, an edit committed in that window would be destroyed at adoption _after_ the user was told
  the session was staying. `inert` closes that race; it is bounded to the length of one engine open.
- A late completion is dropped by (a) an incrementing `seq` compared after **every** await — the
  existing `comparisonSeq` pattern (`useDiffSession.ts:121, 133-135`) — and (b) the captured
  `phase` object identity at adoption. The session token is _not_ sufficient, because nothing bumps it
  until `adopt()`.

---

## 5. Feasibility: can the old session stay live while a candidate is picked and opened?

### 5.1 Verdict: **YES — with no engine, protocol or `session-reset` change.** Three limitations, none of which blocks preservation.

**Evidence, in order of load-bearing weight:**

1. **The destroyer is a plain App-owned call.** `beginSession` is defined in
   `apps/web/src/sessions/session-reset.ts:59-75` and is invoked from exactly two places:
   `openDataFile` (`App.tsx:1611`) and `cancelOpen` (`App.tsx:1592`). Nothing in the engine, hooks or
   providers calls it. Preservation therefore only requires **moving** that call, not changing it. The
   token/reset registry needs **zero** edits.
2. **The engine already holds a second table for another file while a session is live.** Comparison
   staging picks a `File` and calls `engineClient.open(source)` in the middle of a ready session,
   guarded by a `seq` rather than a session reset (`apps/web/src/sessions/useDiffSession.ts:107-140`,
   especially `127-131`, with the doc comment at `107-113`). This is the exact shape the candidate flow
   needs, already shipped and tested.
3. **`open()` is handle-scoped and non-destructive.** It allocates a fresh monotonic table id and
   leaves existing registry entries alone (`packages/engine-duckdb/src/client.ts:392-407`;
   `table-registry.ts:45-60`); every read resolves its own `tableId` (`table-registry.ts:64-67`), so
   the live grid keeps querying `t1` while the candidate becomes `t2`.
4. **Registration is lazy.** The file is registered as a handle; bytes are read on demand
   (`engine-executor.ts:486-490`), so two live tables do **not** duplicate dataset bytes in JS. The
   spec's "no full source-JS buffering" constraint is satisfied by construction.
5. **A failed `engine/open` cleans up after itself.** `runOpen` removes its registry entry and drops
   the registered file on failure (`engine-executor.ts:492-495`) — so an unsupported/corrupt candidate
   leaves nothing behind.
6. **The commit point is a state swap, not a transaction.** `Adopt()` (§4.3) assigns refs and calls
   one setter; there is no engine-side rollback to design, and none should be invented.

### 5.2 Limitations that must be reported, not papered over

**B1 — no per-table release op (blocker for cleanliness, not for preservation).**
`engine/dispose` is the only release and is terminal: it drops every view/file and fails all pending
work (`packages/engine-duckdb/src/client.ts:1030-1038`; worker side
`engine-executor.ts:1904-1918`). The client exposes no `closeTable`; this is already recorded in-repo
twice:

- `App.tsx:1262-1267`: *"`dispose()` is the only release op the current client exposes and is terminal
  - idempotent … the client has no `closeTable`/`profileComparison` op, so it cannot be released
    per-action without an engine change (boundary rule §7.4)."*
- `usePipelineSession.ts:277-283`: _"its materialized views remain in the engine session —
  session-scoped state, disclosed in the panel, never auto-cleaned: the client exposes no per-view
  release op."_

Consequences, stated plainly:

- **L1 (pre-existing, not introduced):** any failure _after_ a successful `engine/open` orphans one
  registered table (`App.tsx:1708` / `1714` → catch `1733`). Today that happens on `model.load` or
  panel-preload failure; it will still happen, and now it happens while the old session survives, so it
  is _visible_ as a surviving session plus one orphaned table instead of as an error screen.
- **L2 (bounded by design):** a successfully opened candidate is **never abandoned**. That is why the
  machine has no Cancel during `opening-candidate` and no `candidate-ready` state that can be declined:
  both would create a live-but-unreachable table. If the maintainer insists on a decline path
  (decision **M-D3** alternative), the cost is exactly one orphaned table + registered file per
  decline.
- **L3:** after N replacements the worker holds N registered files for the app lifetime. This is the
  same class already accepted for pipeline materialized views and the comparison profile handle. The
  smallest real fix is a new `engine/release-table` op executed on adoption's predecessor — that is an
  **engine protocol change**, explicitly outside every present authorization (approval §4 "no package
  payload, engine protocol change"; spec §2 "no new … package protocol"). Treat as a separate track.

**B2 — adoption ordering.** `overlayRef`/`historyRef` must be republished after `beginSession()`
(`useEditingSession.ts:466-479` vs `App.tsx:1700-1701`). Not a blocker; a mandatory step in `adopt()`.

**B3 — the export same-source guard must not be weakened while a candidate is in flight.** Today
`sourceIdentityRef` is cleared at `App.tsx:1626` and set (before `engineClient.open`) at `1677-1679`.
If the candidate flow cleared it at acquisition time, a cancelled/failed candidate would leave the
_live_ session without a stored handle identity, silently routing its exports to the anchor-download
path only (`apps/web/src/export/save-destination.ts:174-177` — fail-closed, but a behaviour change).
**Rule: the live session's identity is never touched until `adopt()`; the candidate's identity is
parked and becomes authoritative only at step 4 of `adopt()`.**

**B4 — memory.** Two live tables, one old + one candidate, no byte duplication (§5.1.4).

### 5.3 What is explicitly **not** feasible / not to be invented

- No engine transaction, no "prepare then commit" engine op, no second hidden worker, no full
  source-JS buffering, no dual grid model. None of these are needed; all are forbidden by spec §4.5.
- A dialog at the button that promises preservation **without** the ordering change is a false claim:
  with `beginSession()` at `App.tsx:1611` the promise would be broken on the first picker cancel.
- **If the maintainer rejects candidate staging** (i.e. keeps guard-then-destroy), the only honest
  alternative is a guard whose copy says _replacement begins immediately; cancelling the chooser still
  ends this session_ — i.e. an explicit limitation, not a preservation claim. That is the "smallest
  honest split" and it should be labelled as such, never as a fix.

### 5.4 Note on `session-reset.ts` (explicit non-change)

`useDatasetSession` (`session-reset.ts:52-78`) needs **no** modification: its contract ("bump the
token first, then run every registered reset", `session-reset.ts:22-32`) is exactly right — it is simply
being called at the wrong moment today. Any WF-06 brief that proposes editing `session-reset.ts` has
misread the defect.

---

## 6. Export-first flow

### 6.1 Recommended shape

```text
dirty session + Open
   → guard
        [Stay]                         → session unchanged, intent ends
        [Export a copy…]                → ExportDialog (existing, untouched)
                                            → any outcome → session unchanged, intent ends
                                            → a *fresh* Open gesture re-enters the guard
        [Choose a replacement file…]   → picker → candidate → adopt
```

Export-first is **export then Stay**, never export-then-auto-replace. Rationale: the download leg's
success is unverifiable (§6.3), so an automatic replacement after `deliver()` would be an action taken
on a guess.

### 6.2 What the export actually snapshots

- Engine export uses `overlayRef.current ?? overlaySnapshot(base, historyRef.current)`
  (`useEditingSession.ts:432-445`), i.e. **the active prefix at the history cursor**, the same value the
  grid renders (`App.tsx:1705`).
- The dialog's row count is `liveRowCount(base, overlayState)` (`App.tsx:2123-2126`;
  `packages/domain/src/overlay.ts:702-706`) — the **whole effective dataset**, never `model.totalRows`.
- Filters and sorting are excluded and the dialog says so per state
  (`ExportDialog.tsx:297-303`, `apps/web/src/export/messages.ts:108-125`).
- **Edits during the export are not in the copy.** The snapshot is captured when `runExport` is called;
  a later commit changes `overlayRef` but not the bytes already materialized. Note also that
  `.export-dialog` is an inline box, not a native modal (`apps/web/src/index.css:2432-2439`), so the
  grid behind it is _clickable_ while an export runs — the dialog's `aria-modal="true"` and document
  keydown trap (`ExportDialog.tsx:123-186`) confine keyboard focus only. The export key must therefore
  **not** claim to include later edits, and the guard flow must not imply the copy is live.
- Undo during an export: same rule — the copy holds the state at activation.

### 6.3 FSA actual close vs fallback anchor initiation

`writeExportCopy` (`apps/web/src/export/save-destination.ts:205-223`):

- FSA leg: `createWritable()` → `write(bytes)` → **`await writable.close()`** → strategy
  `'file-system-access'` (lines 212-216). The close is awaited; that is the strongest persistence
  evidence the platform offers.
- Fallback leg: `downloadBlob(blob, 'assay-export.<ext>')` → hidden anchor `click()` → element removed
  (lines 218-222, 230-243) → strategy `'download'`. **`anchor.click()` is an initiation, not a
  persistence proof**: the spec/test harness cannot observe whether the browser wrote the file, and the
  user may cancel a download. Existing copy already distinguishes the two
  (`messages.ts:45-60`: "to a new file." vs "your browser is downloading it as a new file."), and
  neither says "saved".

**Rules for the replacement flow:**

1. No export outcome — `result`, `cancelled`, `refused`, `error` (`ExportDialog.tsx:67-98`) — may
   advance, cancel or resolve the replacement intent. In the recommended machine the intent is already
   `none` while the export is open, so this is structural.
2. No outcome may clear or reset the overlay/history: nothing on the export path writes history
   (`useEditingSession.ts:432-445` is read-only; `ExportDialog.run()` touches only its own phase).
3. **A started download must never auto-replace.** `deliver()` returning is not a user confirmation;
   the replacement still requires an explicit new Open gesture and (for a dirty session) the guard.
4. A successful export must **not** mark the session clean. There is no "exported" flag anywhere in the
   editing session, and none may be added: an export is a copy, not a commit (`EditToolbar` copy:
   "Edits are staged in this session; the opened file is never modified. Export writes a copy.",
   `apps/web/src/edit/EditToolbar.tsx:42-44`; ADR 0012).
5. The guard's export action must not open the ExportDialog _on top of_ the guard (no stacking); the
   guard closes first (§7).

### 6.4 Guarantees to preserve verbatim

| Guarantee                           | Where it is enforced today                                                                                                              |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| source is never overwritten         | same-entry refusal before any engine work: `save-destination.ts:174-186`, `ExportDialog.tsx:220-226`; identity from `App.tsx:1677-1679` |
| whole effective dataset             | `runExport` overlay snapshot + `liveRowCount` (`App.tsx:2123-2126`)                                                                     |
| natural order, no view filters/sort | `ExportDialog.tsx:30-38, 297-303`; engine `exportView` composition                                                                      |
| CSV formula-injection protection    | engine-side SQL guard (`packages/engine-duckdb/src/overlay-query.ts:448+`, `protocol.ts:244`)                                           |
| Arrow is not reopenable             | `messages.ts:66-83` (`REOPENABLE_FORMATS` = parquet/csv/jsonl/json)                                                                     |
| cancelled/refused/failed ≠ saved    | `messages.ts:88-96`, `exportFailureMessage` `messages.ts:148-154`                                                                       |

None of these may change in WF-06. In particular the export path is _not_ rewritten by this design.

---

## 7. Modal and focus arbitration

### 7.1 Existing owners

`openModal` is a priority chain (`App.tsx:604-611`): `help` > `disclosure` > `export` > `settings`.
`helpBlocked` disables the Help opener while a _different_ surface owns the modal (`App.tsx:616`).
Ownership styles differ:

- **native `<dialog>` + `showModal()`** → genuinely inert background, UA focus scope, Escape = native
  `cancel`: Help (`apps/web/src/help/WorkbenchHelp.tsx:92-141`, focus return at `136-142`) and the
  first-run disclosure (`apps/web/src/telemetry/TelemetryDisclosure.tsx:14-29`, where Escape is a
  deliberate no-op).
- **inline `role="dialog"` + hand-rolled trap**: Export (`ExportDialog.tsx:123-186`) — background is
  _not_ inert (see §6.2), Escape ignored while working (`145-152`).

### 7.2 The guard's placement

- The guard is a **native `<dialog>` opened with `showModal()`**, modelled on Help. Reasons: (a) the
  decision is about the whole session, so a click-through to the grid must be impossible — the exact
  problem Export has; (b) Escape ⇒ `cancel` ⇒ **Stay** for free; (c) it needs no new trap or modal
  library (spec §2 modal-ownership row).
- It joins `openModal` at **priority between `disclosure` and `export`**:
  `help > disclosure > replace > export > settings`. `disclosure` and `help` are native and can never
  coexist with it (the disclosure appears at boot; Help's opener is blocked), so the practical order is
  _replace outranks export and settings_.
- While `replace` is open: the Open control, Help opener, Export opener and Settings control are
  disabled exactly as `helpBlocked` already does for Help; the context bar's export path
  (`App.tsx:1214-1219`) must check the same flag.
- While Export/Settings/Help/disclosure is open: the **Open control must be disabled too.** This is
  _not_ today's behaviour (`disabled={phase.kind === 'opening'}` only, `App.tsx:1864`) and it is a
  source-confirmed defect in its own right: clicking Open during an in-flight export runs
  `setExportOpen(false)` (`App.tsx:1619`), unmounting the dialog mid-`working` — bypassing the
  Escape/Close guard that exists precisely to prevent that (`ExportDialog.tsx:145-152`) — while `run()`
  keeps writing bytes and its result line is lost.
- **Escape = Stay.** In the guard, `cancel` is _not_ prevented (unlike the disclosure); it closes the
  guard with intent `none` and touches nothing.
- **Focus return only to a connected opener**, never to `<body>`: capture `document.activeElement` at
  mount and restore it on cleanup only when `isConnected` — the existing pattern
  (`WorkbenchHelp.tsx:136-142`, `ExportDialog.tsx:183-186`). Because the guard's _export_ action closes
  the guard and opens ExportDialog, the ExportDialog's captured opener is the (now unmounted) guard
  button; its cleanup correctly declines. **WF-06 must add the fallback: focus the Open control** (a
  connected, appropriate target) instead of leaving focus on `body`.
- No focus theft from a successor modal: the guard never focuses anything after unmount, and the
  natural `adopt()` path announces readiness through the existing polite region and moves focus to
  `schema-toggle` (`App.tsx:536-546`) — unchanged.

---

## 8. Copy table (exact proposed strings)

Truth constraints applied to every row: **no** "saved"/"autosave"/"beforeunload" promise; **no**
"saved" for an initiated download; **no** filenames, paths, dataset values, row/column counts or
per-file details; **no** claim that a dirty guard has shipped before WF-06; nothing that implies the
source file is modified or the session persists.

| #   | Surface / when                                                                                                                                   | Exact string                                                                                                                                                                      | Notes                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1  | Guard dialog title (native `<dialog>`, `role`=dialog, `aria-labelledby`)                                                                         | `Replace this session?`                                                                                                                                                           | question form; no "unsaved data" alarm                                                                                                                                                                                                                                                                             |
| C2  | Guard body, paragraph 1 (dirty only)                                                                                                             | `This session has staged changes that are not saved. Opening another dataset replaces the session, its staged edits, its undo history, and any validation or comparison results.` | states what the replacement costs; "not saved" = accurate (no autosave)                                                                                                                                                                                                                                            |
| C3  | Guard body, paragraph 2                                                                                                                          | `Session changes are not saved automatically. Export a copy to keep them.`                                                                                                        | the spec §4.3 candidate sentence, used where it is _true_ (inside a dirty guard), not on the idle screen                                                                                                                                                                                                           |
| C4  | Guard body, paragraph 3 (the structural promise)                                                                                                 | `If you cancel the file chooser, or the file cannot be opened, this session stays as it is.`                                                                                      | guaranteed by §4 (`choosing`/`opening-candidate` never touch the session)                                                                                                                                                                                                                                          |
| C5  | Guard primary-safe action (`data-testid="replace-stay"`)                                                                                         | `Stay`                                                                                                                                                                            | first in DOM order; Escape is equivalent                                                                                                                                                                                                                                                                           |
| C6  | Guard export action (`data-testid="replace-export"`)                                                                                             | `Export a copy…`                                                                                                                                                                  | reuses the shipped export wording (`ExportDialog.tsx:349`) so it is obviously the same operation                                                                                                                                                                                                                   |
| C7  | Guard destructive-intent action (`data-testid="replace-choose"`)                                                                                 | `Choose a replacement file…`                                                                                                                                                      | deliberately **not** "Discard": nothing is discarded until a candidate is proven openable (C4). See M-D9                                                                                                                                                                                                           |
| C8  | `choosing` + picker cancelled (`role="status"`, `data-testid="replace-notice"`)                                                                  | `Nothing was opened. This session is unchanged.`                                                                                                                                  | no "cancelled" alarm, no filename                                                                                                                                                                                                                                                                                  |
| C9  | `opening-candidate` progress (`role="status"`, `data-testid="replace-progress"`, plus an indeterminate `<progress>` labelled `Opening progress`) | `Opening the new file… The current session stays open until it is ready.`                                                                                                         | reuses `OPEN_PROGRESS_LABEL` (`apps/web/src/lib/app.ts:75`); no percentage, no filename                                                                                                                                                                                                                            |
| C10 | candidate failure — outer frame (`role="alert"`, `data-testid="replace-error"`)                                                                  | `The file could not be opened. ` + `openFailureMessage()`'s cause sentence (`apps/web/src/edit/session.ts:304-333`) + ` Nothing in this session changed.`                         | cause sentences are existing approved=False, value-free copy: unsupported → `This file type is not supported — open a .parquet, .csv, .jsonl or .json file.`; unreadable → `The file could not be read. It may be corrupt, truncated, or not the format its name suggests.`; unknown → `You can try another file.` |
| C11 | candidate failure retry (`data-testid="replace-retry"`)                                                                                          | `Choose a different file…`                                                                                                                                                        | same label as the shipped retry (`App.tsx:1955`), but it re-enters **`choosing`**, not the destroy-first flow                                                                                                                                                                                                      |
| C12 | busy / second intent (`role="status"`, `data-testid="replace-busy"`)                                                                             | `Finish the current opening first.`                                                                                                                                               | one intent at a time; no queue (shown only if a second activation is possible at all)                                                                                                                                                                                                                              |
| C13 | un-settled invalid editor (§3.2) (`role="status"`, `data-testid="replace-draft-notice"`)                                                         | `Finish or cancel the cell you are editing first.`                                                                                                                                | value-free; focus moves to the offending editor, not to a dialog                                                                                                                                                                                                                                                   |
| C14 | technical detail disclosure for a candidate failure                                                                                              | summary `Technical detail`, content = raw engine text                                                                                                                             | reuses `App.tsx:1952-1957` shape; single-line summary + `<pre>`                                                                                                                                                                                                                                                    |

**Forbidden in WF-06 copy:** `Discard` as the primary label while cancel preserves the session
(contradictory); `saved`/`Saved`/`Auto-saved`; `Your changes will be lost` as the only sentence (it
would be false on cancel/failure); any file name, size, row/column count or dataset value;
`Sessions are saved in this browser`; `The download is complete`; `Reopen the file to restore`;
`We recommend exporting` phrased as a guarantee of persistence; and the idle-screen sentence
`Opening another dataset replaces this session.` (spec §4.3 gate: it must not imply a guard that has
not shipped). WF-06 may not introduce any string outside this table without a copy approval.

---

## 9. Test and reservation matrix for a future WF-06 row

### 9.1 Browser-observable assertions per transition

| #   | Case                                                    | Assertion (browser/DOM observable)                                                                                                                                                                                                    | Layer                                                           | Harness                                                                                  |
| --- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1   | ready(clean) + Open + picker cancel                     | `data-phase` stays `ready`; grid still renders row 1's known cell; `replace-notice` has C8; no `edit-live-region` announcement about a new dataset                                                                                    | RTL (deterministic)                                             | `vi.mock('@assay/data-sources/browser')` → `null` (pattern: `App.lifecycle.test.tsx:51`) |
| 2   | ready(clean) + Open + unsupported file                  | phase stays `ready`; `replace-error` shows the unsupported-format cause + "Nothing in this session changed."; staged history count unchanged (`pending-changes` text byte-identical)                                                  | RTL + e2e                                                       | e2e: `filechooser.setFiles(<.txt fixture>)`                                              |
| 3   | ready(clean) + Open + corrupt file                      | same as #2 with the neutral cause; `technical-detail` present; session still shows the old rows                                                                                                                                       | e2e                                                             | `fixtures/invalid/corrupt.parquet` (existing, used by `open-recovery.spec.ts`)           |
| 4   | ready(dirty: 1 cell edit) + Open                        | `replace-guard` dialog open, `aria-modal`, non-empty title C1, C2 present; grid rows still in the DOM behind it; Escape closes → same history text                                                                                    | e2e + RTL                                                       | real picker not needed                                                                   |
| 5   | ready(dirty) + Open + Stay                              | `pending-changes` text unchanged; overlay still applied (edited cell still shows the staged value); focus on `open-button`                                                                                                            | e2e                                                             |
| 6   | ready(dirty) + Open + Escape                            | identical to #5                                                                                                                                                                                                                       | e2e                                                             |
| 7   | ready(dirty) + Open + Export a copy… → export cancelled | `replace-guard` gone, `export-cancelled` present, session intact, history unchanged, focus on `open-button`                                                                                                                           | e2e (reuses `export-rewrite.spec.ts` fixtures)                  |
| 8   | ready(dirty) + Open + Export a copy… → export succeeds  | result line present, session intact, history unchanged, no new-opened announcement                                                                                                                                                    | e2e                                                             |
| 9   | ready(dirty) + Open + Choose… + picker cancel           | session intact (rows + staged cell), `replace-notice` C8                                                                                                                                                                              | RTL (deterministic `null`)                                      |
| 10  | ready(dirty) + Open + Choose… + valid file              | new dataset ready, `pending-changes` = `No pending changes.`, old rows gone, exactly one `dataset_opened` telemetry event, `data-phase="ready"`                                                                                       | e2e                                                             |
| 11  | **undo-to-zero is clean**                               | edit a cell → undo → Open → **no** `replace-guard`; picker cancel → session intact with the undone history still redoable                                                                                                             | e2e                                                             |
| 12  | logged no-op is clean                                   | reachable identity op (cast a `VARCHAR` column to `VARCHAR` — `COMMON_CAST_TARGETS` offers it, `apps/web/src/edit/column-ops.ts:43-52` → domain logs `cast-identity`, `packages/domain/src/overlay.ts:177-178`) → Open → **no** guard | RTL + e2e                                                       |
| 13  | refused cast is clean                                   | cast invalid values → refusal alert → Open → no guard                                                                                                                                                                                 | e2e (`column-ops.spec.ts` patterns)                             |
| 14  | rejected engine commit rolled back is clean             | commit a value the engine rejects (`grid-editing.spec.ts` patterns) → rollback message → Open → no guard                                                                                                                              | e2e                                                             |
| 15  | redo branch is dirty                                    | edit, edit, undo → Open → guard present                                                                                                                                                                                               | e2e                                                             |
| 16  | repeated intent                                         | during `choosing`/`opening-candidate`, `open-button` is disabled and a second activation changes nothing (`data-phase` and intent status unchanged)                                                                                   | e2e + RTL                                                       |
| 17  | late completion                                         | gate `engine/open` (the `open-cancel.spec.ts` `Worker.prototype.postMessage` gate) → release after the intent was superseded → no phase change, no session change                                                                     | e2e (gate technique already proven)                             |
| 18  | Open during an in-flight export                         | `open-button` disabled while `exportOpen` (`ExportDialog` still mounted, `export-progress` still present)                                                                                                                             | e2e                                                             |
| 19  | modal arbitration                                       | Help open ⇒ Open disabled; guard open ⇒ Help/Export/Settings disabled; guard closed ⇒ each re-enabled                                                                                                                                 | e2e (`workbench-help.spec.ts` patterns)                         |
| 20  | focus return                                            | after Escape/Stay focus is `open-button`; after the guard→export→close chain focus is `open-button` (not `<body>`)                                                                                                                    | e2e                                                             |
| 21  | no autosave added                                       | no `beforeunload` save listener; `localStorage`/`sessionStorage` untouched by the replacement path                                                                                                                                    | RTL + source pin                                                |
| 22  | invalid editor draft blocks the destructive branch      | edit a cell to an invalid value, click Open (blur rejects, editor stays open) → no guard; `replace-draft-notice` C13; focus in the editor input                                                                                       | RTL + e2e                                                       |
| 23  | valid draft settles before the guard                    | single-click Open from a changed valid editor → guard (or clean path) reflects the committed edit exactly once (`pending-changes` = 1, not 2, not 0)                                                                                  | e2e                                                             |
| 24  | picker cancel in the **legacy idle** path               | unchanged: `data-phase` `idle`, `open-status` = `No file open`                                                                                                                                                                        | e2e (existing `open-cancel.spec.ts` must stay green unmodified) |
| 25  | source never written                                    | byte/sha compare of the fixture after every replacement and export leg                                                                                                                                                                | e2e (`tests/e2e/support/hash.ts` exists)                        |

Every row above is _browser observable_ — no assertion depends on internal React state, and none
asserts a preservation claim that the machine does not implement.

### 9.2 Real picker vs deterministic cancellation

- **Real picker in the harness = the hidden-input fallback.** Every spec deletes
  `window.showOpenFilePicker` in `beforeEach` (`tests/e2e/open-cancel.spec.ts:44-52`) so
  `pickDataFile` (`packages/data-sources/src/pick-file.ts:73-101`) takes the hidden-`<input>` path and
  Playwright can drive `filechooser.setFiles(...)`.
- **Picker _cancellation_ cannot be produced honestly in this harness.** Playwright cannot dismiss an
  OS file chooser: `setFiles()` selects, and there is no API to cancel. The app's cancel path depends on
  the input's native `cancel` event (`pick-file.ts:130-136`) or the FSA `AbortError`
  (`pick-file.ts:85-88`) — both are browser/OS events, not test events.
  **Therefore rows #1 and #9 are unit/RTL only**, with the module mocked to resolve `null` — exactly
  the seam the app already exposes (the picker is a module import, `App.tsx:28`, and the existing
  suites mock it). Adding a production test hook to force cancellation would be a semantic change and
  is refused here.
- **Flagged as not honestly testable today:** (a) native picker _refusal_ (permission denied / no
  chooser), (b) the difference between an FSA `AbortError` cancel and `handles[0] === undefined`
  (`pick-file.ts:89-91`) — both are only reachable through unified picker behaviour, (c) actual disk
  persistence of the download leg (the anchor `click()` is unobservable; only the _initiation_ is, cf.
  §6.3), (d) that a _download was refused by the user_.
- Race determinism: use the held-`postMessage` gate technique from `open-cancel.spec.ts:53-77` to hold
  the **candidate** `engine/open` and prove that (i) the old session is still rendered and interactive-
  blocked (`inert`) during it, (ii) releasing it adopts exactly once, (iii) superseding it drops it.

### 9.3 Files a WF-06 row would need reserved (and why)

| File                                                                                                                                  | Change                                                                                                                                                                                      | Why reserved                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/App.tsx`                                                                                                                | split `openDataFile` into `acquire → prepare → adopt`; add `replacement` intent state, the settle barrier, the guard/choosing/opening wiring, disable Open while any modal/intent is active | the defect lives here (`1596-1753`, `1856-1957`, `2117-2139`)                                                             |
| `apps/web/src/replace/ReplaceGuard.tsx` _(new)_                                                                                       | native `<dialog>` guard component (Help-shaped)                                                                                                                                             | keeps `App.tsx` from growing a second modal implementation                                                                |
| `apps/web/src/replace/messages.ts` _(new)_                                                                                            | the exact strings C1-C14 as pure constants/functions                                                                                                                                        | mirrors `export/messages.ts` so copy is Node-tested independently of JSX                                                  |
| `apps/web/src/replace/machine.ts` _(new)_                                                                                             | pure intent reducer + `canAdopt`/settle predicate                                                                                                                                           | makes the state machine unit-testable without React                                                                       |
| `apps/web/src/replace/ReplaceGuard.test.tsx`, `apps/web/src/replace/messages.test.ts`, `apps/web/src/replace/machine.test.ts` _(new)_ | guard render, copy and machine tests                                                                                                                                                        | independent assertions, no import of implementation constants for the expected copy (`export/messages.test.ts` precedent) |
| `apps/web/src/edit/session.ts`                                                                                                        | add `hasAppliedChanges` (§2.1)                                                                                                                                                              | the pure module already owns history/outcome rules (`edit/session.ts:1-40`)                                               |
| `apps/web/src/edit/session.test.ts`                                                                                                   | cases for §2.3                                                                                                                                                                              | existing test file for that module                                                                                        |
| `apps/web/src/sessions/useEditingSession.ts`                                                                                          | expose `pendingMutation` (commit-in-flight)                                                                                                                                                 | nothing equivalent exists (`useEditingSession.ts:57-63`)                                                                  |
| `apps/web/src/grid/DataGrid.tsx`                                                                                                      | optional `onEditorStateChange` reporting seam                                                                                                                                               | §3.2 invalid-draft rule; no editing behaviour change                                                                      |
| `apps/web/src/index.css`                                                                                                              | guard dialog styling                                                                                                                                                                        | **triggers the configured/restored telemetry legs** (spec §6.2)                                                           |
| `apps/web/src/App.replace.test.tsx` _(new)_                                                                                           | RTL coverage of deterministic cases                                                                                                                                                         | keeps existing `App.open-status.test.tsx` pins untouched                                                                  |
| `tests/e2e/replace-guard.spec.ts` _(new)_                                                                                             | real-picker legs #2-#20                                                                                                                                                                     | new file so `open-cancel.spec.ts` / `open-recovery.spec.ts` stay byte-identical                                           |
| `.changeset/<row>.md` _(new)_                                                                                                         | one `@assay/web` changeset                                                                                                                                                                  | repo convention                                                                                                           |

**Explicitly NOT reserved** (and why, so WF-06 cannot widen silently):

- `apps/web/src/sessions/session-reset.ts` — **no change needed** (§5.4).
- `packages/**` — no engine/protocol change; `engine/release-table` is a separate, unauthorized track (§5.2 B1).
- `apps/web/src/export/**` — the export dialog, its messages and delivery are reused unchanged (§6.4).
- `apps/web/src/sessions/types.ts` — `Phase` stays four kinds (§4.1).
- `apps/web/src/telemetry/**`, `tests/**/playwright*.config.ts`, root configs, ADRs, `docs/**`.
- Any existing test assertion may be **strengthened**, never relaxed, retried, skipped or `force: true`d
  (spec §5, §6.3).

---

## 10. Maintainer decisions (numbered; recommendation + consequence of choosing otherwise)

**M-D1 — Preservation scope: does a _clean_ session get cancel/failure preservation?**
Recommend: **yes, unconditionally.** Cancel, picker refusal, unsupported format, engine failure and
post-open failure must leave a clean session byte-identical — with **no dialog at all** (nothing to
confirm). Consequence otherwise: the commonest real-world case (open a file, click Open again by
mistake, cancel) keeps destroying a working session; that is the audit's G4 and the row's whole point.

**M-D2 — Where is the confirmation?**
Recommend: **dirty-only guard, and the destructive action is "Choose a replacement file…", not
"Replace now".** Consequence otherwise: an always-on guard makes the clean path modal (friction and a
second failure surface) while still not proving preservation, which is the trap in the current design.

**M-D3 — Ordering: guard-before-pick (recommended) vs pick-then-guard (stage the candidate, confirm
afterwards).**
Recommend: **guard-before-pick for dirty sessions; no confirmation for clean ones.** Every candidate is
therefore adopted only after it is proven openable, and no successfully opened candidate is ever
declined — which removes the only _new_ orphaned-table class (§5.2 L2). Consequence otherwise: a
`candidate-ready` state that the user can decline needs explicit copy and costs one orphaned table +
registered file per decline, because the client cannot release a table (`client.ts:1030-1038`).

**M-D4 — The dirty predicate.**
Recommend: **`hasAppliedChanges(history)` = an `applied` entry in `entries[0..cursor)`** (§2.1).
Consequence otherwise: `entries.length`, `cursor`, `overlayRevision` and `activeOps().length` are each
provably wrong for undo-to-zero and/or logged no-ops (§2.2) — a guard that appears after the user undid
everything, or fails to appear after a rename, is worse than no guard.

**M-D5 — A session with only a redo tail (undone but redoable).**
Recommend: **not dirty — no guard, and the redo buffer is lost on adoption.** Consequence otherwise:
every undo-to-zero session would show a dirty guard, contradicting M-D4 and making the guard
unpredictable. If the maintainer prefers to protect the redo buffer, it must be a _separate_ guard
state with its own copy, not a redefinition of dirty.

**M-D6 — A→B→A round trip is reported dirty.**
Recommend: **accept the over-report.** Consequence otherwise: the predicate must fold and compare
states, which is more code for a less honest answer, and it would also have to explain why a session
with two logged edits is "clean".

**M-D7 — Draft policy.**
Recommend: **(a) the replacement never commits anything; (b) the guard waits for the blur-commit to
settle before it renders; (c) while an editor holds an un-settled _invalid_ draft, the destructive
branch is refused and focus returns to the editor (needs the `onEditorStateChange` seam); (d) filter/
SQL/column drafts are never auto-applied and are lost only at adoption.** Consequence otherwise:
today's race (commit-then-destroy, §3.1) ships as-is, and an invalid draft vanishes with no
acknowledgement.

**M-D8 — Cancel during candidate opening.**
Recommend: **no Cancel is offered during `opening-candidate`** (progress only, grid `inert`), mirroring
how Export ignores Escape while working (`ExportDialog.tsx:145-152`) and how `cancelOpen` cannot abort
the engine (`App.tsx:1585-1590`). Consequence otherwise: the Cancel either lies (no interrupt exists —
`cancelOpen` is a token discard) or abandons a table that can never be released (§5.2 B1).

**M-D9 — The destructive action's label.**
Recommend: **`Choose a replacement file…`** with the body sentence "If you cancel the file chooser, or
the file cannot be opened, this session stays as it is." Consequence otherwise: `Discard this session
and choose…` contradicts the preserved-on-cancel behaviour and re-creates the exact false promise this
row exists to remove.

**M-D10 — Engine lifetime: accept the known carry-over, or open a new track?**
Recommend: **accept and record it.** Retired tables cannot be released (`App.tsx:1262-1267`,
`client.ts:1030-1038`); the design bounds it to one retired table per adoption and zero per cancelled/
failed candidate. Consequence otherwise: WF-06 is blocked on an `engine/release-table` protocol change
that no present authorization permits (approval §4); the honest alternative is to record the limitation
in the changeset and Help/limitations doc, not to pretend it does not exist.

**M-D11 — After an export, does the replacement intent persist?**
Recommend: **no. Export ⇒ Stay ⇒ intent ends; a later replacement needs a fresh Open gesture**, which
re-enters the guard. Consequence otherwise: auto-reopening the guard after an export is focus theft,
and any auto-advance after a _download_ would act on an unverifiable initiation (§6.3).

**M-D12 — Guard modality.**
Recommend: **native `<dialog>` + `showModal()`** (Help-shaped), joining `openModal` between
`disclosure` and `export`. Consequence otherwise: an inline `role="dialog"` like Export leaves the grid
clickable during the decision — a session could be edited _after_ the user answered "stay", and the
guard would be a visual modal only.

**Cross-cutting consequence to accept with all of the above:** the fix is ordering + one new intent
state. It requires **no** engine, protocol, `session-reset` or export change, and it must not widen to
task semantics (WFD-02=A), filter-draft indicator (WF-O1), staged-B/running-state (D-06/D-11),
SQL sizing (SV-D04), overlay profiling (SV-D05) or ADR 0044.

---

## 11. What this design does NOT authorize

- **No WF-06 runtime work**, no branch, no worktree, no commit, no push. WF-06 stays BLOCKED until the
  maintainer signs M-D1…M-D12 and a concrete successor brief is written.
- No edit to `apps/web/src/**`, `packages/**`, `tests/**`, fixtures, configs, ADRs, changesets or root
  scripts. The main checkout is byte-identical (`c883b42`, `git status --porcelain` empty).
- No new engine capability, no `engine/release-table`, no transaction/adoption API, no second worker,
  no hidden grid, no source-JS buffering.
- No reopening of: SQL sizing (SV-D04), overlay profiling (SV-D05), ADR 0044 / WF-08 / WF-09, D-06
  (staged B), D-11 (origin metadata), D-13/D-14 (already closed by WF-02), WF-01/01P temporal display,
  WF-02, WF-03, WF-04, WF-07, WF-O1, WF-O2, or any other WF row.
- No autosave, no `beforeunload` save guarantee, no session persistence, no "saved" claim for any
  export — and no claim that the guard exists until it ships.
- No copy outside §8, and no relaxation of any existing assertion.

---

## 12. Artifact / log paths

- This design: `/tmp/assay-wf-05/replacement-design.md`
- Repository artifacts: **none** (read-only row; no branch, no worktree, no logs beyond this file).
- Baseline: `c883b42ac193e21adf19094bb151d6950843c5c0`, clean before and after. No gates were run;
  this row asserts no test result.

**Stop point: the maintainer decisions M-D1…M-D12 above. WF-06 is not started.**
