# WF-05 v5 — replacement-safety contract (verified sufficient for a WF-06 brief)

**Status at verification (2026-11-10): contract verified; this design alone grants no runtime authority.**

**Dated continuation (2026-11-13):** WF-06 runtime is now selected in the
[first-wave handoff](20261113-essential-workbench-pickup.md), subject to fresh baseline gates and its
[specification/reservation](../../product/16-essential-workbench-first-wave-spec.md). No implementation is
claimed here. Use that specification's IC-01…05 for the narrowly clarified reporting/test shorthand; all
other lifecycle/copy/retention requirements below remain binding. Earlier authorization-pending sentences
below are historical and are superseded only by this explicit selection.
This document is the authoritative successor contract
for replacement safety. WF-06 has **no** runtime authority from it: a runtime row needs the maintainer's explicit go,
its own brief and a fresh baseline. Read it with
[the approval record](20261110-web-followup-approval.md) (WFD-01=B, M-D1…M-D12) and
[ADR 0047](../../adr/0047-web-session-replacement-retains-retired-tables.md) (accepted: unbounded table retention,
no release primitive, and the feature must not manufacture retirements).

**Provenance.** v1 ([design](20261110-wf05-replacement-design.md), retained as history) was signed off with three
amendments — A1 candidate-overlay isolation, A2 authoritative editor state, A3 lifetime — and four source
corrections. Getting from v1 to this contract took **four independent review rounds** (`openai-codex/gpt-6-luna`,
xhigh, fresh sessions), each returning request-changes with exact items:

| Round               | Found                                                                                                                                                                                                                                               | Fixed in           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| 1 (sign-off)        | zero-orphan bound false (post-`engine.open` failures and stale-chain returns retain tables); candidate provider inherited the live overlay closure; comparison staging weaker evidence than claimed; invalid draft did not block the **clean** path | v2–v3              |
| 2                   | checklist contradicted the legacy T0 path and adoption's reset; the `DATE`-only focus target does not exist for the **boolean** editor (which has no blur handler)                                                                                  | v3                 |
| 3                   | "no writer but `adopt()`" was false (normal edits write history/overlay); `none` carried a `seq` it did not need; **G4 could miss an overlapping cast check** (single `castPendingColumn`)                                                          | v4                 |
| 4                   | K22 demanded an impossible T4 assertion; U-6 contradicted the user-copy allowance; R5 over-broad; K28 omitted N14; N17 setup under-specified                                                                                                        | v5 (this document) |
| 5 (narrow re-check) | none — **VERDICT: sufficient**                                                                                                                                                                                                                      | —                  |

**Orchestrator integration note.** The five v5 fixes were applied editorially against the reviewer's exact items
after round 4, then re-verified in a fresh narrow pass. No design decision was made by the integrator; every rule
either comes from the source, from ADR 0047, or from the adopted M-D1…M-D12 set.

---

## Contract body (v4 text, verified in v5)

**Row:** WF-05 under **WFD-01 = B**. Supersedes the _contract_ portions of
`docs/process/handoff/20261110-wf05-replacement-design.md` (v1 at `c883b42`); **v3** superseded v2 after an
independent review returned four critical items and one warning (§0.2); **v4** supersedes v3 after a second
review returned three critical items and four warnings (§0.3). v1's approved decisions, copy table and matrix
are carried forward; the three adopted amendments **A1/A2/A3** and the four v1 review corrections are
normative rules. This document grants **no runtime authority**.
**Accepted and not redesigned in v3/v4:** A1 adoption ordering (§4.3/§4.4), the §3.2.1 per-kind editor
enumeration and focus chain, the §3.5 settlement accounting, the §3.6 counter scoping, the ADR 0047 retention
treatment (§5.2), the transition table structure (§4.2), and the copy strings C1–C16.

**Status of the lifetime question:** **settled** by ADR 0047 `docs/adr/0047-web-session-replacement-retains-retired-tables.md`
(Accepted 2026-11-10): unbounded in-process table/file retention is accepted, **no release primitive will
exist**, and the feature **owns not manufacturing additional retirements**.

**Baseline inspected for this revision:** `05ae1ab` (`main`), worktree clean. Verified validity of the line
citations: `git diff --name-only c883b42..HEAD` contains **none** of the files this contract cites
(`App.tsx`, `grid/provider.ts`, `grid/DataGrid.tsx`, `edit/session.ts`, `sessions/useEditingSession.ts`,
`sessions/useDiffSession.ts`, `sessions/session-reset.ts`, `export/*`, `engine-executor.ts`,
`client.ts`, `table-registry.ts`); the same check at `7776b44` (HEAD while this revision was written) is a
**docs-only** delta, so every citation here is valid at both revisions. WF-06 must still re-run the two grep
checks of §4.7 R2/K04 at its own baseline. Read-only: no repository edit, no branch, no commit, no code.

---

## 0. Delta tables

### 0.1 What v2 changed (normative delta against v1)

| v1 location                  | v1 claim                                                                                                                          | v2 rule                                                                                                                                                                                                                                                                                                | Authority                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| §4.3 T7/T8, `adopt()` step 3 | candidate provider inherited `App.tsx:1705`'s closure, i.e. the **live** session's `overlayRef`                                   | **A1:** candidate reads use a **candidate-local empty overlay** built from the candidate's own base; only at `adopt()` — after `beginSession()` and the overlay republish — may the provider follow the live session overlay. Order and rebind point pinned (§4.4).                                    | Sign-off §12 A1 (replaces M-D3's ordering clause) |
| §3.2, §3.3                   | invalid-draft rule applied to the dirty path; editor state reported by a "post-render" callback; settle barrier described loosely | **A2:** the editor/commit gate is **synchronous**, applies to **clean and dirty**, reads an **App-owned ref**, refuses to start any intent while a draft is open or a mutation is unsettled, and evaluates dirty from **settled `historyRef.current`**. Exact seam + write points pinned (§3.3, §3.4). | Sign-off §12 A2 (replaces M-D7)                   |
| §5.2 L1/L2, M-D10            | "zero orphan per cancelled/failed candidate"; "bounded to ≤1 per adoption"                                                        | **A3 + ADR 0047:** no finite bound is claimed. Retention accounting is stated per event, including post-`engine.open` failures and stale returns.                                                                                                                                                      | ADR 0047; corrections 1-2                         |
| §5.1 evidence 2              | comparison staging as proof that candidate adoption works                                                                         | corrections 3: staging is **weaker** evidence — it opens/profiles a second table and never adopts it, never builds a provider, never isolates an overlay                                                                                                                                               | correction 3                                      |
| §9                           | matrix without amendment cases                                                                                                    | matrix extended: clean-path draft block, unsettled-commit deferral, A1 overlay isolation with distinct schemas, superseded-candidate return, post-registration failure                                                                                                                                 | §9                                                |
| §10                          | M-D1…M-D12 as _proposals_                                                                                                         | adopted verbatim (M-D1/2/4/5/6/8/9/11/12 ACCEPT; M-D3→A1; M-D7→A2; M-D10→A3+ADR 0047). **No maintainer decision remains open.**                                                                                                                                                                        | Sign-off §12                                      |
| §8 copy                      | C1–C14                                                                                                                            | unchanged, plus one settling notice (v2's **C15**; split into C15/C16 in v3, §0.2). No other string changes.                                                                                                                                                                                           | §8                                                |
| —                            | —                                                                                                                                 | new **§12 contract sufficiency checklist** and **§13 unpinned items**                                                                                                                                                                                                                                  | v2                                                |

### 0.2 What v3 changes (fixes of the independent review's four critical items + warning)

| #         | v2 defect (reviewer)                                                                                                                                                                                                       | v3 fix                                                                                                                                                                                                                                                                                                                                                                                                               | Where                        |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| **FIX 1** | K03/K04/K22 contradicted the source: the legacy T0 chain writes the session refs and calls `beginSession`, and adoption both resets and replaces history/overlay                                                           | A **writer matrix** (§4.7) states, per ref, which of three owners writes it at which transition _(superseded by §0.3/C1: four writer classes, two of them pre-existing and always legal)_; K03/K04/K22 are rewritten as scoped, falsifiable rules (three `beginSession()` sites: `cancelOpen`, T0, adopt)                                                                                                            | §4.7, K03/K04/K22            |
| **FIX 2** | G3 mandated a `grid-editor-input` focus target, but a boolean cell editor renders a `<select data-testid="grid-editor-boolean">` with **no blur handler** (`DataGrid.tsx:1203-1230`) and can stay open across a real click | G3 keeps "block any open editor" and gains a **per-kind focus table** with a fallback chain (§3.2.1); the justification is replaced with the true one — the gate reads a ref written at every transition and never relies on blur semantics                                                                                                                                                                          | §3.2, §3.2.1, §4.5, N13      |
| **FIX 3** | "settlement is bounded by one `model.refresh()`" was false; C15 was untrue for a cast pre-check and promised a short wait                                                                                                  | **No time bound**: §3.5 lists the two waits honestly (commit/rollback refresh, up to 3 `overlayCastCheck` awaits, no client timeout except dispose); C15 is split into **C15** (mutation) and **C16** (cast pre-check) with truthful, promise-free strings, and §3.7 pins the clearing rule and the never-clears behaviour                                                                                           | §3.5, §3.7, C15/C16, N14/N15 |
| **FIX 4** | C14 rendered raw engine text while K20 banned filenames/values in the replacement UI — an unstated contradiction                                                                                                           | C14 is **scoped and narrowed**: §8.1 states exactly what the technical detail may contain, what must never reach it, and the provable part (within `runOpen` the user filename is only used for extension detection; registration uses an engine-generated name) _(scope tightened by §0.3/W-B)_; K20 is scoped to "rendered replacement UI outside the collapsed detail block"; U-6 records what remains unprovable | §8.1, K20, N16, U-6          |
| **W**     | the mutation counter "detects overlapping commits but does not serialize them"                                                                                                                                             | §3.6 states what S-A2-2 claims (refuse while work is in flight, evaluated on the _actual published_ history) and what it does not (order, coalesce, abort or repair the pre-existing overlap), plus the consequence for the "settled history" guarantee                                                                                                                                                              | §3.6, K24, K39               |

### 0.3 What v4 changes (second review: three critical items + four warnings)

| #       | v3 defect (reviewer)                                                                                                                                                                                                                                                                                                                                                                                                                         | v4 fix                                                                                                                                                                                                                                                                                                                        | Where                                         |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **C1**  | R1/K03 claimed "on the ready path no code outside `adopt()` writes `historyRef`/`overlayRef`" — but **ordinary edits do**, through `activateHistory` (`useEditingSession.ts:194-205`); R3/K22's "no transition except `adopt()`" ignored that T0 (`App.tsx:1611`, reset `useEditingSession.ts:471-475`, `setExportOpen(false)` `App.tsx:1619`) and `cancelOpen` (`1592`) are destroyers; the matrix even said "any other writer: reset only" | the matrix now lists **four writer classes** (adopt / the two unchanged destroyers / `activateHistory` / registered resets); R1 is **diff-scoped** ("no code _added by this row_"), R3 is **transition-scoped** (T1–T11 only), new R5 states that normal edits remain legal and are never blocked; K03/K22 rewritten to match | §4.7, K03/K22                                 |
| **C2**  | K02 said the intent states are "each carrying `seq`", while the type gives `none` no `seq`                                                                                                                                                                                                                                                                                                                                                   | pinned: **`none` carries no sequence**, the sequence lives in `intentSeqRef` (the authority) and is copied into each in-flight intent; `adopt()` step 0 compares against the ref, not the state                                                                                                                               | §4.1, §4.3 step 0, K02                        |
| **C3**  | G4 read a **single** `castPendingColumn`, so two checks on different columns can overlap and the later `finally` clears the single value while the earlier check is still in flight → G4 would permit replacement                                                                                                                                                                                                                            | **aggregate tracking chosen** (option a): `castPendingColumns: ReadonlySet<string>` + `castPendingCount` mirror; add/remove keyed by column; per-column disable stays as today; the rejected single-flight alternative and its cost are recorded                                                                              | §3.3 S-A2-4, §3.5, §3.7, K08/K24/K42, N14/N17 |
| **W-A** | §8.1 said the failure text "can name only engine-generated identifiers" and then allowed source-derived fragments                                                                                                                                                                                                                                                                                                                            | the absolute sentence is gone; two classes stated separately (provable vs not provable)                                                                                                                                                                                                                                       | §8.1                                          |
| **W-B** | "the picked name is consumed **only** by `detectFileFormat`" overstated it                                                                                                                                                                                                                                                                                                                                                                   | scoped to **the engine's `runOpen`**; the name also derives the telemetry format enum (`App.tsx:1727-1729`)                                                                                                                                                                                                                   | §8.1                                          |
| **W-C** | the clipboard rule said raw text must "never reach" the clipboard, yet it renders in a selectable `<pre>`                                                                                                                                                                                                                                                                                                                                    | pinned: the rule forbids **app-initiated** clipboard writes (checked by a spy + source grep); a user selecting and copying the visible text is **allowed** and not suppressed — no copy-event guard is added; N16 tests both halves                                                                                           | §8.1 item 2, N16                              |
| **W-D** | K04's literal grep pin was off by one (`App.panel-boundary.test.tsx:18` is a prose hit)                                                                                                                                                                                                                                                                                                                                                      | exact numbers given for both scopes (with and without tests), and the check text carries the qualification                                                                                                                                                                                                                    | R2, K04                                       |

---

## 1. Baseline sequence (carried forward; citations unchanged)

`openDataFile` (`apps/web/src/App.tsx:1596`) is the only dataset-entry function; four call sites — drop
`1783`, header Open `1862`, example `1876`, retry `1951`. Irreversible prefix executed **before any file
exists**: one-shot refs `1601-1607` → `setDropNotice` `1610` → **`beginSession()` `1611`** → preload
`1616` → **`setPhase({opening})` `1617`** → slot clears `1618-1627` (incl. `sourceIdentityRef` `1626`,
`openSourceRef` `1627`). `beginSession` (`sessions/session-reset.ts:59-75`) bumps the token and runs every
registered reset (`App.tsx:636-643, 827-834, 857-868`; `useEditingSession.ts:466-479`;
`useValidationSession.ts:324-331`; `useDiffSession.ts:277-287`; `usePipelineSession.ts:286-297`), and
`phase.kind === 'ready'` (`App.tsx:1965`) unmounts the grid (`2331`), FilterBar (`2214`) and every panel.

Per ingress: header Open `1856-1868` (only guard `disabled={opening}`) → `pickDataFile` `1641-1647` →
cancel `1649-1653` returns to `idle` with the session already destroyed; retry `1944-1957` (same function,
nothing live); example `1871-1886` (idle-only, one-shot source `1661-1666`); idle drop `1755-1791` (returns
early unless idle `1766`; `preventDefault` in all phases `1765` — **drop cannot reach a live session and
must not be widened**); no other programmatic path. `cancelOpen` (`1591-1594`) is the second destroyer
(honest token discard, not an interrupt `1585-1590`).

Losses and failure points are unchanged from v1 §1.2: token, model/provider/sort/filter, base metadata,
overlay history + cursor + redo tail, edit/view errors, validation contract/verdict, staged B + diff,
pipeline state, SQL text/page, filter/column/cell drafts, record request, export dialog + same-source
identity, active task/jump origin — all destroyed at `1611`/`1617`, before the picker resolves. Post-open
failure points: `getFile` `1659`, `engineClient.open` `1680-1683` (unsupported extension decided
`engine-executor.ts:478-484`), schema `1689`, rowCount `1691`, `model.load()` `1708`, preload `1714`, and
the stale returns `1684/1690/1692/1709/1715/1735`.

---

## 2. "Dirty" — adopted predicate (unchanged by the amendments)

```ts
// apps/web/src/edit/session.ts (pure; next to activeOps, line 33-35)
export function hasAppliedChanges(history: TransformationHistory): boolean {
  for (let i = 0; i < history.cursor; i += 1) {
    if (history.entries[i]?.outcome.status === 'applied') return true
  }
  return false
}
```

Evaluated **only** on a settled history (`historyRef.current`, see §3.4), never on render state.
`history.ts:60-70, 66-70, 95-125, 148-156, 186-196`; outcome union `overlay.ts:161-164`; no-op reasons
`overlay.ts:166-178`; `appendOp` refusal `history.ts:127-131`; rollback `edit/session.ts:419-470`.

Wrong alternatives, with evidence: `entries.length` (undo-to-zero `history.ts:148-156`; logged no-ops
`history.ts:34-39`); `cursor > 0` (no-op-only prefix); **`overlayRevision > 0`** (bumped by every undo/redo/
cursor move `useEditingSession.ts:194-205, 268-282, 398-409`; reset `475`); `historyRevision` (race tag
`138-146`); `activeOps().length` (drops outcomes `edit/session.ts:33-35`, and the shipped UI already
over-reports through it: `App.tsx:2072`, `App.tsx:2127`). There is no domain `revision` counter;
`overlayRevision` is a staleness tag (`useDiffSession.ts:104-106`).

Case verdicts: undo-to-zero **clean**; redo branch **dirty**; redo-tail-only **clean** (buffer lost on
adoption, explicit); logged no-op **clean**; pending mutation **not evaluated** (gate, §3); rollback
**clean**; refused cast **clean**; row/column ops **dirty**; A→B→A **dirty** (accepted over-report).

---

## 3. Editor authority and draft policy — **A2 as adopted**

### 3.1 Why the v1 wording was insufficient

The only blur-commit in the app is `onBlur={commitEditDraft}` (`grid/DataGrid.tsx:1275`) — and it is attached
to **one** editor kind only (the text/number/temporal `<input>`, `1253-1276`). The boolean kind renders a
`<select data-testid="grid-editor-boolean">` (`1203-1230`) with **no blur handler at all**. So the
"editor will have closed by the time the click runs" assumption is true for exactly one kind: a real click
on the Open control blurs a text editor and runs `commitEditDraft` (`578-609`) → `commitEditValue`
(`565-576`) → `onCommitCell` → `applyOp` → `commitHistory` (`useEditingSession.ts:248-268, 224-246`) — which
publishes synchronously (`edit/session.ts:419-425`) and then awaits `model.refresh()`, i.e. the click handler
runs with a commit **in flight** (today `beginSession` then destroys it: the commit-then-destroy race) —
while the boolean select simply stays open. Focus/blur is also not portable: a browser that does not focus a
clicked `<button>` never blurs the editor at all. React state (`editing`) is unreadable at that instant, and
the only existing notification is `onEditAnnounce` → App state (`DataGrid.tsx:605`), a **post-render** path.
A2 therefore requires (a) a synchronous read of an App-owned ref written at every editor transition, (b) the
gate on **both** paths, and (c) a focus rule that is correct per editor kind (§3.2.1).

### 3.2 The authoritative gesture gate (normative, evaluate in this order, synchronously)

`beginReadyGesture(kind: 'open')` — runs **before** any dialog, picker, `await` or state write:

| #   | Condition (read synchronously)                                                                                  | Outcome                                                                                                                                                 | Copy                                          |
| --- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| G1  | `openModal !== null` (`App.tsx:604-611`)                                                                        | refuse                                                                                                                                                  | existing arbitration, no notice               |
| G2  | `intent.kind !== 'none'`                                                                                        | refuse                                                                                                                                                  | `C12`                                         |
| G3  | **`editorStateRef.current.open === true`** (any editor kind)                                                    | refuse: **no picker, no guard, no intent**; move focus per §3.2.1 (kind-specific target, then fallbacks); the editor's own rejection text stays visible | `C13`                                         |
| G4  | `mutationStateRef.current > 0` **or** `castPendingCount > 0` (aggregate, §3.3 S-A2-4 — **not** a single column) | refuse: no picker, no guard, no intent                                                                                                                  | `C15` (mutation) / `C16` (any cast pre-check) |
| G5  | `gridBusy !== null` (`App.tsx:569-575`)                                                                         | refuse                                                                                                                                                  | existing busy status                          |
| G6  | else → `dirty = hasAppliedChanges(historyRef.current)`                                                          | `dirty ? guard : choosing`                                                                                                                              | —                                             |

Rules that make G2–G4 honest and testable:

- **G3 blocks any open editor, not only an invalid one** — a deliberate superset of A2, and the rule that
  makes the focus question honest. The justification is **not** "a pointer click always blurs the editor":
  that is true for the text/number/temporal input (`onBlur`, `DataGrid.tsx:1275`) and false for the boolean
  select (`1203-1230`, no blur handler), false for a programmatic activation (no focus change, hence no
  blur), and not portable across browsers for a clicked `<button>`. The true justification is that G3 reads
  a **ref written synchronously at every editor transition** (§3.3 S-A2-1), so its verdict does not depend on
  blur semantics at all: an editor is open ⇒ refuse, whatever closed it or did not. `invalid` is still
  tracked, but only to keep the rejection text visible and to avoid re-announcing it.
- **G4 is a refusal, not an `await`.** Waiting for settlement before opening the picker would move
  `showOpenFilePicker` out of the click's transient user activation (the FSA picker requires it,
  `packages/data-sources/src/pick-file.ts:76-88`; the picker is invoked straight from the click handler, so
  moving it behind an `await` would rely on transient user activation surviving that wait), so the design
  refuses and lets the user repeat the gesture. **No time bound is claimed or implied** (§3.5): the wait is
  however long the engine takes, and the notice clears only when the underlying observable clears (§3.7).
- **Dirty is never evaluated on an unsettled history.** G3/G4 precede G6, so `historyRef.current` at G6 is
  the last history actually published — success (`setActive(next)`) or rollback (`setActive(previous)`,
  `edit/session.ts:419-470`). What that does _and does not_ guarantee when commits overlap is stated in
  §3.6.
- The gate is the **single** entry point for `guard` and `choosing`; `choosing` is also entered from the
  guard's destructive action (`T5`), which must re-run G1–G5 (the modal closed first, so G1 passes).

### 3.2.1 Editor kinds, focus targets, and the fallback chain (G3 implementation)

Enumerated from source — the complete set of _editor states_ that can be open at a ready-state gesture:

| Editor kind                                  | How it is opened                                                                  | DOM in the open state                                                               | testid                | Commits on blur?                              | Blocks G3?                                                                           | Focus target on refusal                               |
| -------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `text`, `number`, `temporal`                 | double-click / Enter on a cell (`beginEdit` `446-468` → `openEditorOn` `416-441`) | `<input class="grid-editor-input">` (`1253-1276`)                                   | `grid-editor-input`   | **yes** (`onBlur` `1275`)                     | yes                                                                                  | `[data-testid="grid-editor-input"]`                   |
| `boolean`                                    | same gesture; kind chosen by `cellEditorKind` (`edit/typed-input.ts:164-175`)     | `<select class="grid-editor-input">` (`1203-1230`)                                  | `grid-editor-boolean` | **no** (no `onBlur` anywhere in that subtree) | yes                                                                                  | `[data-testid="grid-editor-boolean"]`                 |
| NULL affordance                              | rendered _inside_ either open editor (`1231-1243`, `1277-1291`)                   | `<button class="grid-editor-null">`                                                 | `grid-editor-null`    | n/a (commits `NULL` on click)                 | covered by the parent editor                                                         | never a target: it is a commit control, not an editor |
| `unsupported` (nested/struct/list/map/union) | **cannot open** — `beginEdit` refuses with a message (`452-461`)                  | none                                                                                | —                     | —                                             | no                                                                                   | —                                                     |
| queued edit gesture (row still loading)      | `pendingEditRef` (`475-480`)                                                      | none (no draft exists yet)                                                          | —                     | —                                             | **no** (nothing to commit or lose; `inert` blocks typing during `opening-candidate`) | —                                                     |
| Schema column rename draft                   | `column-rename-open` (`schema/SchemaPanel.tsx:191-201`)                           | `<input>` `column-rename-input` (`233-234`)                                         | `column-rename-input` | no (explicit `column-rename-commit`)          | **no** (unapplied draft, preserved on Stay, lost at adoption — §3.4)                 | —                                                     |
| Schema cast draft                            | `column-cast-open` (`206-215`)                                                    | `<select>` `column-cast-select` (`276`) + optional `column-cast-custom` (`297-298`) | those                 | no (explicit `column-cast-commit`)            | **no**, unless `castPendingCount > 0` (then G4)                                      | —                                                     |
| Cast pre-check in flight                     | `handleCastColumn` (`useEditingSession.ts:341-391`)                               | `column-cast-pending` marker (`221`)                                                | —                     | —                                             | **G4**, not G3                                                                       | —                                                     |

**Focus rule (replaces v2's single-testid rule).** On a G3 refusal, focus in this order and stop at the first
element found:

1. the kind-specific testid — `grid-editor-boolean` for the boolean kind, `grid-editor-input` otherwise
   (each renders inside the container `[data-testid="grid-cell-editor"]`, `DataGrid.tsx:1198` / `1248`);
2. `[data-testid="grid-cell-editor"]` (the container) — always present while an editor renders;
3. the row that owns the edit: the roving tab stop `[data-testid="grid-viewport"] [data-testid="grid-row"][tabindex="0"]`
   (rows are focusable only when interactive, `988`);
4. the Open control itself (`open-button`) — always connected.

The rule must never call `.focus()` on a guessed selector without the chain, and must never focus `<body>`
(a miss is a bug, not a degradation). Assertion: after a G3 refusal, `document.activeElement` matches the
expected testid for each kind, and is never `document.body`.

### 3.3 Seams to add (exact, minimal, behaviour-preserving)

**S-A2-1 — synchronous editor state, App-owned ref.**
`grid/DataGrid.tsx` gains one optional prop:

```ts
readonly editorStateRef?: { current: { open: boolean; invalid: boolean } }
```

App owns the object (`useRef({ open: false, invalid: false })`). `DataGrid` **writes it synchronously
inside the existing handlers**, never in an effect and never as a state setter:

| Write point                                                                      | Line                                         | Value                         |
| -------------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------- |
| `openEditorOn` (editor opens, any kind)                                          | `416-441` (after `setEditing({…})` at `424`) | `{open:true, invalid:false}`  |
| draft `onChange` — text/number/temporal input                                    | `1262`                                       | `{open:true, invalid:false}`  |
| draft `onChange` — boolean select, "true / false…" option only                   | `1215-1217`                                  | `{open:true, invalid:false}`  |
| `commitEditValue` from the boolean select's true/false options                   | `1211-1214` (via `commitEditValue`)          | `{open:false, invalid:false}` |
| `cancelEdit`                                                                     | `560-563`                                    | `{open:false, invalid:false}` |
| `commitEditValue`                                                                | `565-576`                                    | `{open:false, invalid:false}` |
| `commitEditDraft` refusal branch                                                 | `590-606`                                    | `{open:true, invalid:true}`   |
| `commitEditDraft` → `cancelEdit()` paths (unchanged draft / missing column/type) | `581-592`                                    | via `cancelEdit`              |

**Must not change:** the unchanged-draft-is-cancel rule (`585-591`), the invalid-keeps-editor-open rule
(`598-607`), blur timing (`1275`), Enter/Escape (`1264-1274`), what is announced (`604-605`), or any
history/commit semantics. The ref is a _reporting_ channel only; it is never read by the grid.

**S-A2-2 — settlement counter.**
`sessions/useEditingSession.ts` adds `mutationStateRef: { current: number }`, incremented immediately
before the `await` inside `commitHistory` (`224-246`) and decremented in a `finally` that covers **both**
the success and the rollback resolution returned by `commitWithRollback` (`edit/session.ts:419-470`).
It must not abort, time out, reorder or re-drive a commit; it exists only so the gesture gate can read
"is any commit in flight". Counting (not a boolean) is required because `applyOp` appends on the already
published `historyRef.current` (`useEditingSession.ts:252-253`), so two commits can overlap.
The same hook additionally exposes a **render mirror** `mutationPending: boolean` (true while the counter is
`> 0`) used **only** to render and clear the notice (§3.7); the gate reads the ref, never the state. Mirror
and ref are written in the same two places so they cannot disagree on the render that follows settlement.
What this seam does **not** do is stated in §3.6.

**S-A2-3 — App-owned gesture gate.** A pure function (new `apps/web/src/replace/gate.ts`) taking
`{ openModal, intent, editorState, mutations, castPendingCount, gridBusy, history }` and returning
`{kind:'refuse', reason:'modal'|'intent'|'editor'|'settling'|'cast'|'busy'} | {kind:'proceed', dirty:boolean}`,
unit-tested without React. App calls it, then acts. No `await` before it.

**S-A2-4 — aggregate cast-check tracking (C3; chosen over single-flight).**
The source tracks **one** column: `const [castPendingColumn, setCastPendingColumn] = useState<string | null>`
(`useEditingSession.ts:177`), set at `345` and cleared by a `finally` keyed to that column (`385-387`). Each
column's controls are disabled only for _its own_ pending check (`SchemaPanel.tsx:195, 210`, wired at `597` as
`castPending={castPendingColumn === column.name}`), so **two checks on different columns can overlap**, and
when the later one finishes first its `finally` clears the single value while the earlier check is still in
flight — a single-value G4 input would then permit replacement mid-check. Replacement:

- **State:** `castPendingColumns: ReadonlySet<string>` replaces the single string. **Add point:** immediately
  before the async check loop (the line that sets `345`): `add(column)`. **Remove point:** inside the existing
  `finally` (`385-387`): delete **only** `column` and keep the rest. **Reset point:** the session reset
  (`468`) clears the set. Keying by column keeps the existing double-click-per-column guard exactly as today.
- **Render mirror:** `castPendingCount: number` (the set's size) for the C16 notice and for gate tests; the
  gate reads the count (a plain number, so it is snapshot-safe like the other gate inputs).
- **UI unchanged:** `SchemaPanel` keeps its per-column prop but takes the set —
  `castPendingColumns?: ReadonlySet<string>` and `castPending={castPendingColumns.has(column.name)}` at `597`;
  App passes `castPendingColumns` (`App.tsx:2060`). Per-column disable semantics are byte-identical to today:
  a running check disables only its own column's Rename/Cast buttons.
- **Notices:** C16's text is column-free and count-free, so it is true for 1..n concurrent checks
  ("A column type check is still running."); no per-column detail is added (ADR 0025 discipline: no dataset or
  schema identifiers in guidance).
- **Rejected alternative — single-flight (option b):** disable every column's Rename/Cast control while any
  check is pending, with a copy line such as "Wait for the running column check to finish." Cost: it blocks
  _unrelated_ column work, and because a check's wait is unbounded (§3.5: up to three `overlayCastCheck`
  awaits, no request timeout) a hung check would freeze the whole schema panel indefinitely. It also needs
  the same `SchemaPanel` edit, so it buys no boundary reduction. Recorded here, not chosen.
- **Cost of the chosen option:** one Set instead of a string in the hook (+ its reset), a `castPendingCount`
  mirror, a two-line `SchemaPanel` prop adaptation, and `SchemaPanel.tsx` must join the reservation set
  (§9.2). No behaviour change for a single check.

### 3.4 Draft policy per surface (final)

| Surface                                                     | State today                                                                                                                                                  | Rule                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cell editor, unchanged draft                                | existing cancel (`DataGrid.tsx:585-591`)                                                                                                                     | unchanged; gesture proceeds (editor closed by the blur)                                                                                                                                                                                                                          |
| Cell editor, changed + valid                                | blur-commits, `refresh()` in flight                                                                                                                          | **never committed by the replacement**; G4 refuses while unsettled; once settled, the commit is part of the history the guard describes (count not printed, §8)                                                                                                                  |
| Cell editor, changed + invalid                              | refusal, editor stays open (`598-607`)                                                                                                                       | G3 refuses the gesture; `C13`; focus returns to the input; Stay/Escape unaffected; nothing is discarded                                                                                                                                                                          |
| Cell editor, open but uncommitted (programmatic activation) | n/a                                                                                                                                                          | G3 refuses (`open === true`)                                                                                                                                                                                                                                                     |
| Cell editor, **boolean** kind                               | `<select>` `grid-editor-boolean`, no blur handler (`DataGrid.tsx:1203-1230`); picking true/false commits immediately, "true / false…" leaves the editor open | G3 refuses while it is open; focus goes to `grid-editor-boolean`; never auto-selected, never auto-cancelled                                                                                                                                                                      |
| Queued edit gesture (row still loading)                     | `pendingEditRef` (`475-480`), no draft yet                                                                                                                   | does **not** block; the gesture is not an editor and cannot commit. If it opens while `choosing`/`opening-candidate` is in flight, its draft is the untouched initial value (`openEditorOn` seeds `initialDraft`/`draft` from the cell, `416-441`), so adoption discards no edit |
| Column rename / cast draft                                  | local, explicit submit (`schema/SchemaPanel.tsx:149-182`), no blur commit                                                                                    | never auto-applied; preserved by Stay/cancel/failure; lost only at adoption                                                                                                                                                                                                      |
| Filter compose / row drafts                                 | `grid/FilterBar.tsx:209-212`, explicit apply `357-386`, no blur commit                                                                                       | same; an unapplied draft is **not** a change, so a clean session carrying only drafts shows no guard and loses them at adoption (documented limitation, §8 note)                                                                                                                 |
| SQL text                                                    | `sql/SqlPanel.tsx:316`, Run only                                                                                                                             | never auto-run, never auto-applied; preserved by Stay; lost at adoption                                                                                                                                                                                                          |
| Cast in flight (one or several columns)                     | `castPendingColumns.size > 0` (`useEditingSession.ts:177, 345, 385-387`; aggregate seam S-A2-4)                                                              | G4 refuses while **any** check is pending (`C16`, or `C15` once a commit starts); the notice is column-free                                                                                                                                                                      |

### 3.5 Settlement: what G4 waits for (no time bound)

G4 refuses while work is in flight. The waits are these, all unbounded in wall-clock time:

1. **A history commit's materialization** — `commitWithRollback` performs `setActive(next)` then **one**
   `await effects.refresh()` (`edit/session.ts:424-427`); when that rejects it restores `setActive(previous)`
   and **awaits a second refresh** (`428-435`). So one commit is one _or_ two sequential engine reads, the
   second only on the rollback path.
2. **A cast pre-check** — `handleCastColumn` may await `engineClient.overlayCastCheck` up to
   `MAX_CAST_CHECK_ATTEMPTS = 3` times **before anything is appended** (`useEditingSession.ts:38, 346-378`),
   because a concurrent history change invalidates a verdict and re-runs the check. The pending marker clears
   in a `finally` (`385-387`) that runs **before** the commit it triggers settles, so the cast marker and
   `mutationStateRef` are both required: a cast can be "done checking" while its commit is still refreshing.
   **Multiple checks can overlap** (one per column, per-column disable only, `SchemaPanel.tsx:195, 210, 597`),
   which is why the gate input is the **aggregate set size** (S-A2-4) and not a single column: with a single
   value, the later check's `finally` would clear the marker while the earlier one still runs.
3. **Both together**, when a cast's commit overlaps another commit.

**No timeout exists to bound any of this.** The engine client has exactly one timer — the `dispose()`
handshake (`client.ts:234-237, 1051-1058`) — and `send()` has no request timeout, so every
`schema`/`rowCount`/`overlayCastCheck`/refresh await can take arbitrarily long. The contract therefore claims
**no** time bound, no "briefly", no "a moment", and no auto-retry.

### 3.6 What the mutation counter does and does not establish (review warning)

**Claimed:** while `mutationStateRef.current > 0` (or a cast pre-check is pending), the replacement gesture is
**refused**; when it reaches 0, G6 evaluates `hasAppliedChanges` on the `historyRef.current` that the
interleaving actually published, i.e. the same value the grid renders. Because the guard is a native modal
(inert page) and G2 forbids a second intent, **no commit can start while the guard or the picker is open**, so
the dirty verdict cannot go stale between the gate and adoption.

**Not claimed:** the counter does not serialize, coalesce, order, abort or repair commits. The source permits
overlapping `commitHistory` calls — `applyOp` appends on the live `historyRef.current` and `void`s the commit
(`useEditingSession.ts:248-268, 224-246`), and each commit may run its own `refresh()`/rollback refresh
(`edit/session.ts:424-435`) — so two commits (and a rollback) can overlap and their refreshes can settle out
of order. That is a **pre-existing** property of the editing session, unchanged and unrepaired by this row:
`activateHistory` publishes whichever activation ran last (`useEditingSession.ts:194-205`), and a commit's
late `catch` path may re-`setActive(previous)` after a newer activation. Consequences the design accepts:

- G4's "settled" is **procedural** (nothing in flight _from the app's point of view_), not a transactional
  guarantee about the order the engine saw the reads.
- If an overlap ever published a state the user did not intend, the dirty predicate still describes exactly
  that published state — so C2 remains true, and the guard never over- or under-reports relative to the view.
- WF-06 must not cite the counter as a fix for the overlap, must not add ordering/abort logic to it, and must
  not weaken G4 on the grounds that "the counter handles it".

### 3.7 Notice lifecycle (C13 · C15 · C16): render site and clearing

| Notice               | Rendered when                                                | Render site                                                                                                            | Clears when                                                                                                                                                                                                                              | If it never clears                                                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `C13` draft          | G3 refused                                                   | open-flow status area beside the Open control, `role="status"`, `data-testid="replace-draft-notice"`; focus per §3.2.1 | the editor closes (`editorStateRef.open === false`) — i.e. the next commit/cancel, or on unmount                                                                                                                                         | the editor is still open, which is the user's own state; no timeout, no bypass. The user finishes or cancels the cell (Escape) and the notice clears                                                              |
| `C15` settling       | G4 refused on `mutationStateRef.current > 0`                 | same area, `role="status"`, `data-testid="replace-settling-notice"`                                                    | `mutationPending` flips false (counter returns to 0, same write as the ref — S-A2-2)                                                                                                                                                     | nothing auto-advances; the control stays enabled so the user may retry, but every retry is refused identically. There is **no** dismissal, **no** countdown, **no** auto-open of a guard or picker when it clears |
| `C16` cast pre-check | G4 refused on `castPendingCount > 0` and no mutation pending | same area, `role="status"`, `data-testid="replace-cast-notice"`                                                        | `castPendingCount` returns to **0**, i.e. **every** pending check has cleared (each `finally` removes only its own column, `useEditingSession.ts:385-387` + S-A2-4); if a cleared check turns into a commit the notice switches to `C15` | same as above; the existing cast surfaces (`column-cast-pending`, refusal messages) stay the system of record                                                                                                     |

Precedence when both are pending: `C15` wins (a mutation is already in flight); `C16` renders only when
`mutationStateRef.current === 0 && castPendingCount > 0`. Neither notice is an alert, neither is
dismissible, and neither blocks the grid: the user can keep working, Stay (implicitly — no intent was started)
or do nothing.

---

## 4. Target state machine

### 4.1 Structural invariant (unchanged)

`Phase` stays exactly `idle|opening|ready|error` (`sessions/types.ts:24-43`); candidate states live in a
separate App-local intent so the ready subtree never unmounts (`App.tsx:1965`) and `data-phase` pins
(`App.tsx:1884-1886`) are untouched.

```ts
// apps/web/src/replace/machine.ts (pure)
type ReplacementIntent =
  | { kind: 'none' } // no seq: nothing is in flight to supersede
  | { kind: 'guard'; readonly seq: number }
  | { kind: 'choosing'; readonly seq: number }
  | { kind: 'opening-candidate'; readonly seq: number }
// refusals are not states: G2–G5 render a notice and leave intent 'none'
```

**Sequence ownership (C2).** `seq` exists only to invalidate the late completions **of an in-flight intent**,
so `none` has none. The authority is a monotonic `intentSeqRef` (App-owned, like `comparisonSeq`,
`useDiffSession.ts:85, 121`): it is incremented when an intent is entered, the new value is copied into the
intent object (for render/debug), and every completion compares against **`intentSeqRef.current`** — never
against the intent object, which is `none` once the intent ends. Panel/reducer code therefore reads
`intent.kind` for the machine and `intentSeqRef` for supersession.

### 4.2 Transitions (authoritative; supersedes v1 §4.2/§4.3)

| ID    | From → To                                                          | Trigger                                                                          | Live session owner                                                 | Candidate owns                                                                                        | Cancel / Escape                                  | Repeat                            |
| ----- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------- |
| T0    | `idle` → `opening`                                                 | Open / example / drop (unchanged legacy path)                                    | nobody                                                             | the chain                                                                                             | `Cancel opening` (`App.tsx:1887-1903`) unchanged | Open disabled `1864`              |
| **G** | any ready gesture                                                  | Open                                                                             | live session untouched                                             | —                                                                                                     | —                                                | gate §3.2 must return `proceed`   |
| T1    | `ready(clean)` → `choosing`                                        | G → `proceed(dirty:false)`                                                       | App, untouched                                                     | nothing yet                                                                                           | picker cancel → T6                               | Open disabled while intent ≠ none |
| T2    | `ready(dirty)` → `guard`                                           | G → `proceed(dirty:true)`                                                        | App, untouched; rendered behind a **native modal**                 | nothing                                                                                               | Escape = Stay = T3                               | modal arbitration                 |
| T3    | `guard` → `none`                                                   | Stay / Escape                                                                    | unchanged byte-for-byte                                            | —                                                                                                     | —                                                | —                                 |
| T4    | `guard` → `none` + ExportDialog                                    | Export a copy…                                                                   | export path (read-only `useEditingSession.ts:432-445`)             | —                                                                                                     | export cancel/refuse/error changes nothing       | —                                 |
| T5    | `guard` → `choosing`                                               | `Choose a replacement file…`                                                     | unchanged; gate re-run                                             | nothing                                                                                               | as T1                                            | —                                 |
| T6    | `choosing` → `none`                                                | picker cancel (`pick-file.ts:85-88, 130-136`)                                    | **unchanged**                                                      | nothing                                                                                               | —                                                | notice `C8`                       |
| T7    | `choosing` → `opening-candidate`                                   | File acquired; **`getFile()` failed → `none` + `C10`**                           | unchanged; **never** `historyRef`/`overlayRef`/`sourceIdentityRef` | `File`, parked FSA handle, parked identity, **candidate-local overlay box**, candidate provider+model | **none offered** (M-D8 / ADR 0047)               | —                                 |
| T8    | `opening-candidate` → `adopt()`                                    | candidate loaded                                                                 | swapped atomically (one sync block)                                | published                                                                                             | —                                                | —                                 |
| T9    | `opening-candidate` → `none` + `C10`                               | any failure before `engine.open` succeeds                                        | unchanged                                                          | nothing (**registration rolled back** in `runOpen`'s own catch, `engine-executor.ts:495-499`)         | —                                                | —                                 |
| T9b   | `opening-candidate` → `none` + `C10`                               | failure **after** `engine.open` succeeded (schema/rowCount/`model.load`/preload) | unchanged                                                          | **one retained candidate table** (ADR 0047)                                                           | —                                                | —                                 |
| T10   | any await resuming late (seq ≠ current, or `phase !== startPhase`) | —                                                                                | —                                                                  | dropped silently; candidate table retained if already registered (ADR 0047)                           | —                                                | —                                 |
| T11   | unmount / `beforeunload`/`pagehide`                                | —                                                                                | `engineClient.dispose()` unchanged (`App.tsx:1262-1280`)           | —                                                                                                     | —                                                | —                                 |

Invariants across T7–T10: the live session's `historyRef`, `overlayRef`, `sourceIdentityRef`,
`openSourceRef`, `panelModules` and `phase` are **not written** until `adopt()`. Only the parked candidate
values change.

### 4.3 `adopt()` — the only irreversible step (A1 ordering pinned)

```text
adopt(candidate, parked):
  0. guard: intent.kind === 'opening-candidate' && intent.seq === intentSeqRef.current
            && phase === startPhase                       // intent.seq is a copy; the ref is the authority
  1. datasetSession.beginSession()                       // token bump + every registered reset, exactly once
  2. adoptedBase      = candidate.base                    // already built from the candidate's own handle
     adoptedHistory   = emptyHistory()
     adoptedOverlay   = overlaySnapshot(adoptedBase, adoptedHistory)
  3. historyRef.current = adoptedHistory                  // republish AFTER the reset (reset nulls both:
     overlayRef.current = adoptedOverlay                   // useEditingSession.ts:470-475)
  4. candidateProvider.rebindOverlaySource(               // A1: only now may reads follow the live session
       () => overlayRef.current ?? adoptedOverlay)
  5. sourceIdentityRef.current = parked.identity          // live session identity becomes the candidate's
     openSourceRef.current     = parked.openSource
  6. setPanelModules(candidate.panels)
  7. setPhase({ kind: 'ready', model: candidate.model, tableId: candidate.handle.id,
                handle: candidate.handle, base: adoptedBase, provider: candidateProvider })
  8. telemetry.emit('dataset_opened', …)                  // exactly as App.tsx:1726-1732
  9. intent = none
```

Steps 1–9 are synchronous (no `await`), so React commits a single frame. **`model.refresh()` must not be
called** — the candidate model is already loaded against the same handle and the same (empty) overlay, so
its cached pages and synthesized `baseRowId`s (`provider.ts:228-240`) remain valid; a refresh would add
queries and a loading frame (assertable by the provider query-count instrumentation that already exists in
`GridViewportModel` stats, `viewport-model.ts:66`).

### 4.4 Candidate read path — **A1 rule (normative)**

**Rule A1-1.** During `opening-candidate`, every candidate read (`provider.schema`, `provider.rowCount`,
`provider.fetchRange`, i.e. `viewport-model.ts:303-320, 553`) resolves its overlay from a
**candidate-local box created inside the candidate function**:

```ts
const candidateOverlayBox = { current: overlaySnapshot(candidateBase, emptyHistory()) }
const candidateProvider = new DuckDbGridProvider(
  engineClient,
  candidateHandle,
  () => candidateOverlayBox.current,
) // never overlayRef, never historyRef
```

**Rule A1-2.** The candidate closure must NOT reference `overlayRef`, `historyRef`, `phase`, or any value
captured from the live session. With an empty overlay and no sort/filter the provider takes the base fast
path (`provider.ts:182-186, 190-207, 228-240`), reading the candidate handle only and synthesizing row ids
from `overlaySource().base.baseAnchor` (`provider.ts:236`) — i.e. from the **candidate's own** anchor.

**Rule A1-3.** Only at `adopt()` step 4 — after `beginSession()` (step 1) and after the overlay republish
(step 3) — is the provider's overlay source rebound to the live-session closure. Implementation: add
`rebindOverlaySource(next: OverlaySource): void` to `DuckDbGridProvider` (`apps/web/src/grid/provider.ts`;
`overlaySource` is currently `private readonly`, `163`/`169-172`, and the type `OverlaySource` already
exists at `156`). App-owned file, no package change.
_Fallback if the maintainer refuses that API:_ construct the final provider at adoption **and** a new
`GridViewportModel` and `await model.load()` inside `adopt()` — which makes `adopt()` async and requires a
post-await re-check of step 0; discarded as the default because it adds a query round-trip and a loading
frame to the act of replacement.

**Why the rebind cannot race a late read (argued, then asserted by test):**

1. `adopt()` has no `await`; every mutation of the closure (steps 3–4) and `setPhase` (step 7) happen in one
   task, and React reads state only after the handler returns.
2. During `opening-candidate` the ready subtree is `inert` + `aria-busy` (§4.6), so no new grid gesture,
   edit or filter can start; the gate (§3.2 G4) additionally refuses while a commit is unsettled.
3. A candidate span fetch issued before adoption is computed against the candidate handle with an **empty**
   overlay — identical to the adopted session's initial view — so even a result landing after adoption
   cannot display a wrong view.
4. The only dangerous read is one that resolves its overlay from the **old** session; A1-2 makes that
   unreachable by construction (the closure has no route to `overlayRef`), and A1-3 rebuilds the closure
   from the _adopted_ base rather than inheriting the live one.

**Stop rule (A1, verbatim requirement).** If the candidate cannot be given an overlay source independent
of the live session's refs — or if any candidate read can reach `overlayRef` — **stop: do not ship the
guard and do not claim candidate-readiness preservation.** Return to the maintainer with the split
(engine-free ordering work vs. an overlay-isolation design), or ship the explicit limitation of §5.4.
A partial implementation that inherits the live closure is a data-correctness defect, not a cosmetic gap.

### 4.5 Refusals and notices (no state)

`G1` modal, `G2` repeated intent, `G3` open editor (any kind), `G4` unsettled mutation or cast pre-check,
`G5` grid busy — each renders one value-free notice (§8, lifecycle in §3.7) and leaves `intent === 'none'`.
`G3` additionally moves focus using the per-kind chain of §3.2.1 (`grid-editor-boolean` for the boolean kind,
`grid-editor-input` otherwise, then the editor container, then the roving row, then the Open control; never
`<body>`). None of the refusal handlers commits, cancels, rolls back, clears, selects or types anything; where
a text/number/temporal editor already committed on its own blur (a pre-existing gesture, §3.1/§3.3), that is
the user's action, not the refusal's.

### 4.6 Busy / `inert` rules (unchanged, restated as normative)

- One pending intent; entered only via §3.2; while `intent !== 'none'` the Open control is disabled and
  Help/Export/Settings/Open are blocked the way `helpBlocked` already blocks Help (`App.tsx:616`); drop and
  example remain idle-only (`App.tsx:1766, 1871`).
- During `opening-candidate` the region containing the grid and panels is `inert` + `aria-busy`; **the
  open-flow controls are outside that region**. If `document.activeElement` is inside the region when it
  becomes inert, focus must be moved explicitly to the candidate progress element (`C9`) — the
  implementation must not rely on the browser blurring an inert subtree (see §13 U-3).
- No Cancel is rendered or accepted during `opening-candidate` (M-D8 + ADR 0047: no interrupt exists and
  abandonment would manufacture a retirement).
- Late resumption is dropped by `seq` (the `comparisonSeq` pattern, `useDiffSession.ts:121, 133-135`) plus
  the captured `phase` identity. The session token is **not** usable for this: nothing bumps it until
  `adopt()`.

### 4.7 Writer matrix — who writes which session state, at which transition (FIX 1)

**Four writer classes exist** — two unchanged, one always legal, one new. Every cell below is falsifiable by
reading the cited line, and each rule states its scope explicitly.

| Class                                                                                                                                                                                            | What it writes                                                                                                                                                                                                                                                        | When                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(c) `activateHistory`** — normal editing                                                                                                                                                       | `historyRef.current`, `overlayRef.current`, `history` state, `overlayRevision` (`useEditingSession.ts:194-205`)                                                                                                                                                       | on every edit, undo, redo, cursor move, **and only while `phase.kind === 'ready'`** (the guard at `196`) — always legal, never blocked by this contract |
| **(d) registered resets** (`useEditingSession.ts:466-479`; `useValidationSession.ts:324-331`; `useDiffSession.ts:277-287`; `usePipelineSession.ts:286-297`; `App.tsx:636-643, 827-834, 857-868`) | clears history (`472-473`), `overlayRef` (`471`), validation, diff, pipeline, task, ledger, `openSourceRef`                                                                                                                                                           | only when **`beginSession()`** runs (below)                                                                                                             |
| **(b) unchanged destroyers: legacy T0 (`App.tsx:1611`…) and `cancelOpen` (`1592`)**                                                                                                              | call `beginSession()` (thus (d)); T0 also writes `historyRef`/`overlayRef` (`1699-1701`), `panelModules` (`1716`), `phase` (`1617/1651/1717/1743`), `sourceIdentityRef` (`1626`, `1678`), `openSourceRef` (`1627`, `1722`), and **closes the Export dialog** (`1619`) | idle-path open / explicit cancel only                                                                                                                   |
| **(a) `adopt()`** — new                                                                                                                                                                          | `beginSession()` (step 1 → (d)); `historyRef`/`overlayRef` republish (step 3); `sourceIdentityRef`/`openSourceRef` (step 5); `panelModules` (step 6); `phase` (step 7); intent (step 9)                                                                               | once, on a successful candidate                                                                                                                         |

Per-ref view of the **interesting** refs (T0/cancelOpen columns are today's code, unchanged):

| Session state / ref         | (b) Legacy T0                   | (b) `cancelOpen`               | (a) `adopt()` | (c) `activateHistory`                 | (d) resets        |
| --------------------------- | ------------------------------- | ------------------------------ | ------------- | ------------------------------------- | ----------------- |
| session token               | `App.tsx:1611`                  | `1592`                         | step 1        | —                                     | —                 |
| `historyRef.current`        | `1699`                          | —                              | step 3        | **yes, every activation** (`194-205`) | `472-473`         |
| `overlayRef.current`        | `1700-1701`                     | —                              | step 3        | **yes, every activation** (`202`)     | `471` (`null`)    |
| `sourceIdentityRef.current` | cleared `1626`, set `1677-1679` | **no** (no reset registration) | step 5        | —                                     | —                 |
| `openSourceRef.current`     | cleared `1627`, set `1722`      | —                              | step 5        | —                                     | `App.tsx:827-834` |
| `panelModules`              | `1716`                          | —                              | step 6        | —                                     | —                 |
| `phase`                     | `1617`, `1651`, `1717`, `1743`  | `1593`                         | step 7        | —                                     | —                 |
| `exportOpen`                | `1619` (`false`)                | —                              | not written   | —                                     | —                 |
| intent                      | —                               | —                              | step 9        | —                                     | —                 |

Reading rules that make the table checkable:

- **R1 (diff-scoped, falsifiable).** **No code added by this row** writes `historyRef`, `overlayRef`,
  `sourceIdentityRef`, `openSourceRef`, `panelModules` or `phase` **except inside `adopt()`**. Formally: in the
  row's diff, the only new occurrences of `historyRef.current =`, `overlayRef.current =`,
  `sourceIdentityRef.current =`, `openSourceRef.current =`, `setPanelModules(` and `setPhase(` are inside the
  `adopt()` function. Candidate preparation writes only local variables and the parked candidate record.
  Pre-existing writers keep writing exactly as today and are **out of scope**: `activateHistory` on every
  normal edit (`useEditingSession.ts:194-205`), the legacy T0 chain, `cancelOpen`, and the registered resets.
  Falsify with a diff grep; a rule that claimed "nothing but `adopt()` ever writes these refs" would be false,
  because editing writes them constantly.
- **R2.** `beginSession` has exactly **three call expressions** after this row: `App.tsx:1592`
  (`cancelOpen`), `App.tsx:1611` (legacy T0), and adopt step 1 (new). Verified baseline at `05ae1ab`:
  `grep -rn 'beginSession(' apps/web/src | grep -v '\.test\.'` returns exactly **4** lines (the two calls plus
  two prose comments, `sessions/session-reset.ts:18` and `ErrorBoundary.tsx:22`), and the same grep **without**
  the test filter returns **5** (the extra hit is the prose comment `App.panel-boundary.test.tsx:18`). The
  interface member and the implementation spell it `readonly beginSession:` / `beginSession:` with no call
  parens, so they do not match. WF-06 must run both forms at its own baseline and expect each count to grow by
  exactly **1** (the adopt call), and no more.
- **R3 (transition-scoped).** Among the **new** transitions T1–T11, only `adopt()` resets or replaces
  `history`/`overlay`, and only `adopt()` writes `phase`; **T3, T4, T6, T9, T9b and T10 must leave every one
  of them byte-identical**. `adopt()`'s order is reset (step 1) → republish (step 3) → rebind (step 4) — that
  is its purpose. Explicitly **out of scope and unchanged**: the legacy T0 chain resets through `beginSession`
  (`App.tsx:1611` → `useEditingSession.ts:471-475`) and **closes the Export dialog** (`App.tsx:1619`), and
  `cancelOpen` resets through `beginSession` (`App.tsx:1592`). "The replacement path never clears history" is
  therefore true only of T1–T11 minus adoption, never as an absolute statement about the repository.
- **R4.** `cancelOpen` writes no ref directly; its effect on history/overlay comes solely from the registered
  resets it triggers, and it does **not** clear `sourceIdentityRef` (a pre-existing asymmetry, unchanged).
- **R5 (edits are never blocked).** `activateHistory` (`useEditingSession.ts:194-205`) is a legal writer whenever the session is ready — the existing guard at `196` is unchanged, and this row neither blocks, reorders nor instruments it on that path or any other. The contract gates **gesture entry**
  (§3.2 G4), not edits. Observation, not a new guarantee: while an intent is active no activation can
  _start_ — the guard/disclosure modal makes the page inert, the OS picker owns focus during `choosing`, and
  `opening-candidate` sets `inert` (§4.6) — and G4 already refuses entry while a commit is pending. So the
  dirty verdict taken at G6 stays valid until adoption without the contract having to constrain editing.

---

## 5. Feasibility and lifetime — corrected (A3 + ADR 0047)

### 5.1 Verdict (unchanged in substance, corrected in evidence)

Preservation of the live session across picker cancel and candidate failure is achievable **without an
engine, protocol or `session-reset.ts` change**: `beginSession` is App-owned, and this row only _moves_ when
it is called (three call expressions after adoption: `App.tsx:1611`, `1592`, adopt step 1 — §4.7 R2),
`open()` allocates a fresh monotonic table id and leaves other entries alone
(`client.ts:392-407`, `table-registry.ts:45-60`), reads are `tableId`-scoped (`table-registry.ts:64-67`),
registration is lazy (`engine-executor.ts:486-490`), and the commit point is a React state swap.

**Corrected evidence weights (normative):**

1. **Strong:** the destroyer is a plain App-owned call that only needs to move.
2. **Weaker than v1 claimed:** comparison staging (`useDiffSession.ts:107-140, 126-131`) proves only that a
   _second table can be registered and read while a session is ready_ — it **opens and profiles** handle B
   and never adopts it, never constructs a provider/model and never isolates an overlay. It is precedent for
   co-residency and for `seq`-guarded supersession, **not** for candidate readiness. Candidate readiness
   rests on A1 (§4.4), which WF-06 must implement and test.
3. **Strong:** handle-scoped reads, lazy registration.
4. **Corrected:** `runOpen` rolls back **only failures inside registration/view creation**
   (`engine-executor.ts:476-499`). It does **not** roll back failures after a handle has been returned.
5. **Unchanged:** no engine-side transaction is needed or permitted.

### 5.2 Retention accounting (A3; replaces v1 §5.2 L1/L2 and M-D10)

ADR 0047 accepts unbounded retention; **no release primitive exists or will be added** (`dispose()` is
terminal, `client.ts:1030-1038`; recorded in-repo at `App.tsx:1262-1267` and
`usePipelineSession.ts:277-283`). Normative accounting per event, in one worker lifetime:

| Event                                                                                            | Registered tables retained                                                                                 |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| picker opened and cancelled, or `getFile()` fails                                                | **0**                                                                                                      |
| candidate `engine.open` rejects (unsupported/corrupt/read)                                       | **0** (`engine-executor.ts:495-499`)                                                                       |
| candidate `engine.open` succeeds, then schema/rowCount/`model.load`/preload fails                | **+1** (T9b)                                                                                               |
| candidate superseded by a newer intent or a late return (seq/phase mismatch) after `engine.open` | **+1** (T10)                                                                                               |
| successful adoption                                                                              | **+1** retired live table; the candidate becomes the live one                                              |
| N-th dataset in one worker lifetime                                                              | N−1 retired + 1 live                                                                                       |
| legacy idle path (`T0`) failure/retry/stale return after `engine.open`                           | **+1 per occurrence** (pre-existing; reachable today via `cancelOpen`, `App.tsx:1684/1690/1692/1709/1715`) |

**What ADR 0047 permits:** shipping this feature with that retention, and deleting no release code.
**What ADR 0047 forbids** — binding rules on this design, not aspirations:
(i) **one pending intent at a time** (G2/§4.6) — no queued or parallel candidates;
(ii) **no Cancel and no abandonment during `opening-candidate`**, and no declinable `candidate-ready` state
(M-D8, T7/T8) — every candidate that reaches `engine.open` is either adopted or failed, never parked and
dropped by choice;
(iii) **no adoption without an isolated candidate overlay** (A1) — an adoption that required re-opening the
candidate would manufacture an extra retirement;
(iv) no claim of a finite bound anywhere in code, copy, changeset or docs.
**Not fixable here:** the pre-existing per-failure/per-stale-return leaks above. The design neither adds to
them nor repairs them; WF-06 must not describe the feature as leak-free.

### 5.3 Preserved constraints

No engine transaction, no prepare/commit op, no second worker, no hidden grid, no source-JS buffering
(`engine-executor.ts:486-490` satisfies "no buffering" by construction), no per-table release.

### 5.4 The honest fallback if A1 cannot be guaranteed

If overlay isolation (A1-1…A1-3) turns out unimplementable within the reserved files, the only honest
alternative is a guard whose copy says replacement begins immediately and cancelling the chooser still ends
the session (an explicit limitation, §8 note). It must never be presented as preservation, and WF-06 must
stop and request that decision rather than ship it silently.

### 5.5 `session-reset.ts` (explicit non-change)

`useDatasetSession` (`session-reset.ts:52-78`) needs **no** edit; its contract ("bump the token first, then
run every registered reset", `22-32`) is correct — it is called at the wrong moment today.

---

## 6. Export-first flow (carried forward, unchanged)

Guard actions: `Stay` (`C5`) | `Export a copy…` (`C6`) | `Choose a replacement file…` (`C7`). Export ends
the intent (M-D11); a later replacement is a fresh gesture re-entering the gate.

- Snapshot: `overlayRef.current ?? overlaySnapshot(base, historyRef.current)` at the moment `runExport` is
  called (`useEditingSession.ts:432-445`); row count `liveRowCount(base, overlayState)`
  (`App.tsx:2123-2126`, `overlay.ts:702-706`) — whole effective dataset, natural order, no view
  filters/sort (`ExportDialog.tsx:30-38, 297-303`, `messages.ts:108-125`).
- **Edits made after the export starts are not in the copy**; `.export-dialog` is an inline box
  (`index.css:2432-2439`), so the grid stays clickable and the dialog's trap (`ExportDialog.tsx:123-186`)
  confines keyboard focus only. Copy must not imply a live copy.
- FSA leg awaits `createWritable → write → close` (`save-destination.ts:212-216`) = a real close;
  fallback leg only _initiates_ an anchor download (`218-222, 230-243`) = **initiation, not persistence**;
  neither is described as "saved" (`messages.ts:45-60`).
- No outcome (`result|cancelled|refused|error`, `ExportDialog.tsx:67-98`) advances, cancels or resolves the
  intent, clears the overlay, or marks the session clean; nothing auto-replaces after a download starts.

Guarantees that must remain byte-identical: source never overwritten (`save-destination.ts:174-186`,
`ExportDialog.tsx:220-226`), whole effective dataset, natural order, CSV formula-injection guard
(`overlay-query.ts:448+`, `protocol.ts:244`), Arrow not reopenable (`messages.ts:66-83`),
cancelled/refused/failed ≠ saved (`messages.ts:88-96, 148-154`).

---

## 7. Modal and focus arbitration (carried forward, unchanged)

- `openModal` priority becomes `help > disclosure > replace > export > settings` (today
  `help > disclosure > export > settings`, `App.tsx:604-611`); `helpBlocked` (`616`) generalizes to all
  openers, including the context-bar export path (`App.tsx:1214-1219`).
- The guard is a **native `<dialog>` opened with `showModal()`** (Help-shaped,
  `help/WorkbenchHelp.tsx:92-141`): genuinely inert background, UA focus scope, Escape = native `cancel` =
  **Stay**. No new modal library, no trap rewrite.
- **Open must be disabled while any owned modal is open** — today it is not (`App.tsx:1864` guards only
  `opening`), so Open during an in-flight export unmounts the dialog through `setExportOpen(false)`
  (`App.tsx:1619`) and bypasses the Escape/Close guard (`ExportDialog.tsx:145-152`) while `run()` keeps
  writing. This is a required fix in the same row, not an optional extra.
- Focus returns only to a **connected** opener (`183-186`); after the guard→export chain the guard button is
  gone, so the fallback target is the Open control (never `<body>`). No focus theft from a successor modal;
  successful adoption announces through the existing polite region and moves focus to `schema-toggle`
  (`App.tsx:536-546`) unchanged.

---

## 8. Copy table (adopted C1–C14 + new C15/C16) and truth constraints

| #       | Surface / when                                                                                     | Exact string                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1      | Guard title                                                                                        | `Replace this session?`                                                                                                                                                                                                                                                                                                                                                                                         |
| C2      | Guard body ¶1 (dirty)                                                                              | `This session has staged changes that are not saved. Opening another dataset replaces the session, its staged edits, its undo history, and any validation or comparison results.`                                                                                                                                                                                                                               |
| C3      | Guard body ¶2                                                                                      | `Session changes are not saved automatically. Export a copy to keep them.`                                                                                                                                                                                                                                                                                                                                      |
| C4      | Guard body ¶3 (structural promise)                                                                 | `If you cancel the file chooser, or the file cannot be opened, this session stays as it is.`                                                                                                                                                                                                                                                                                                                    |
| C5      | `replace-stay`                                                                                     | `Stay`                                                                                                                                                                                                                                                                                                                                                                                                          |
| C6      | `replace-export`                                                                                   | `Export a copy…`                                                                                                                                                                                                                                                                                                                                                                                                |
| C7      | `replace-choose`                                                                                   | `Choose a replacement file…`                                                                                                                                                                                                                                                                                                                                                                                    |
| C8      | `replace-notice` (picker cancel)                                                                   | `Nothing was opened. This session is unchanged.`                                                                                                                                                                                                                                                                                                                                                                |
| C9      | `replace-progress` (+ `<progress>` labelled `Opening progress`)                                    | `Opening the new file… The current session stays open until it is ready.`                                                                                                                                                                                                                                                                                                                                       |
| C10     | `replace-error`                                                                                    | `The file could not be opened. ` + cause + ` Nothing in this session changed.` where cause is `openFailureMessage`'s sentence (`edit/session.ts:304-333`): unsupported → `This file type is not supported — open a .parquet, .csv, .jsonl or .json file.`; unreadable → `The file could not be read. It may be corrupt, truncated, or not the format its name suggests.`; unknown → `You can try another file.` |
| C11     | `replace-retry`                                                                                    | `Choose a different file…` (re-enters `choosing`, not the destroy-first flow)                                                                                                                                                                                                                                                                                                                                   |
| C12     | `replace-busy` (repeated intent)                                                                   | `Finish the current opening first.`                                                                                                                                                                                                                                                                                                                                                                             |
| C13     | `replace-draft-notice` (G3, clean **and** dirty)                                                   | `Finish or cancel the cell you are editing first.`                                                                                                                                                                                                                                                                                                                                                              |
| C14     | technical detail (open-failure and candidate-failure alerts only)                                  | summary `Technical detail`; body = raw engine diagnostic, scoped by **§8.1** (not "any raw text anywhere")                                                                                                                                                                                                                                                                                                      |
| **C15** | `replace-settling-notice` — G4 while a mutation is in flight (`mutationStateRef > 0`)              | `This session is still finishing a change. Replacement stays unavailable until it finishes.`                                                                                                                                                                                                                                                                                                                    |
| **C16** | `replace-cast-notice` — G4 while any cast pre-check is pending (`castPendingCount > 0`, aggregate) | `A column type check is still running. Replacement stays unavailable until it finishes.`                                                                                                                                                                                                                                                                                                                        |

Truth constraints (binding): no autosave / `beforeunload` / persistence promise; no "saved" for an initiated
download; no filenames, paths, dataset values, row/column counts **in rendered replacement UI outside the
collapsed C14 detail block (§8.1)**; no dirty-guard claim before it ships; the idle screen keeps **no**
"Opening another dataset replaces this session." (spec §4.3 gate); C2/C3 appear only inside the dirty guard
where they are true; C4 is backed by T6/T9/T9b/T10, not by wording; C13/C15/C16 are `role="status"`,
value-free and never name a cell, column or file.
C15/C16 are the **two new strings** introduced by this row (A2 required a value-free notice but not its
words): both are carried here so they are reviewable as a unit with C1–C14, and a WF-06 brief must copy them
byte-for-byte. They are **deliberately two** strings, because one string cannot be true for both waits: in the
cast case nothing has been applied yet (there is no "change being applied"), and in neither case may the copy
promise a short wait ("in a moment") that the source cannot bound (§3.5). Neither string says a change was
saved, committed, applied or protected. Note for C2: no number of changes is printed anywhere in the guard
(the shipped "N pending changes" line counts no-ops, `App.tsx:2072`).

### 8.1 C14 — what the technical-detail affordance may contain (FIX 4)

**Class 1 — provable from source: what _our_ layer supplies.** The picked name is passed to the engine
(`App.tsx:1680-1683` → `client.ts:392-403` → protocol `name`), and **within the engine's `runOpen`** it is
consulted by `detectFileFormat(name)` and nothing else (`engine-executor.ts:476-477`); after that call the
name is unused, registration proceeds under an **engine-generated** name — `entry.registeredFileName`, the
table id (`table-registry.ts:45-63`), handed to `registerFileHandle` (`engine-executor.ts:492`) — and
`createViewSql` composes from `entry.viewName` (`assay_t1`) and that same generated name (`493`). The
unsupported-extension refusal is a fixed sentence containing no name at all (`engine-executor.ts:478-483`,
with the in-source rule at `479`: _"No file names in messages (ADR 0025) — the extension kind is enough"_).
Scope correction: the name is **not** used by `runOpen` alone across the app — the same string also derives
the telemetry format enum after a successful open (`formatKindFromName(file.name)`, `App.tsx:1727-1729`),
which is a coarse closed enum, not the name. So: the identifiers _our_ layer can put into a diagnostic are
engine-generated (`tN`, `assay_tN`) plus that fixed sentence — nothing else.

**Class 2 — not provable from source: what the engine may echo.** The worker forwards `error.message`
verbatim (`engine-executor.ts:460-467`, `errorMessage` `2022-2024`), and the client/engine internals are not in
this repository: DuckDB-WASM is handed the actual `File` (which carries the user's `File.name`) and its reader
may echo that name and/or a fragment of the bytes it failed on (a CSV/JSON reader error can quote the
offending line). Rendered raw at `App.tsx:1956-1959`. **Class 2 is not covered by Class 1's argument**, and the
rules below are written to be correct whatever Class 2 turns out to contain (U-6 records how it could be
observed).

**Rule (narrowed, not hand-waved).** The C14 block is allowed to contain: the engine error class, engine
diagnostics, engine-generated identifiers (`tN`, `assay_tN`), composed SQL over those identifiers, and — as a
**possibility that must be assumed** — source-derived fragments echoing the picked file or its bytes. It is
never allowed to contain anything the app _adds_: no filename interpolation, no counts, no path, no dataset
value **that our code selects or interpolates**, no user-entered text from our own code. Therefore:

1. C14 renders **only** inside the open-failure / candidate-failure alert, in a `<details>` that is **closed
   by default**, as inert text in a `<pre>` — never in the guard, never in a notice, never in a live region.
2. The raw string must never reach telemetry (the shipped `dataset_open_failed` carries a closed
   `reason_code` enum only, `App.tsx:1736-1742`), logs, the DOM title, the changeset or docs. **Clipboard,
   pinned (W-C):** the rule forbids **app-initiated** clipboard writes — no `navigator.clipboard.writeText`,
   no `document.execCommand('copy')`, no programmatic selection — from the replacement flow (the app's only
   clipboard use remains the user-initiated cell copy, `DataGrid.tsx:624-645`). It does **not** forbid the user
   selecting and copying the visible `<pre>` text: that is the user's own action on their own screen, it is
   **allowed**, and no `copy`-event guard, `user-select: none` or `preventDefault` may be added to suppress it
   (suppressing it would be new behaviour and would break the ordinary "copy the error" affordance).
3. No replacement-module constant may interpolate the raw text (`replace/messages.ts` stays constant-only;
   the C10 notice uses the _classified_ cause from `openFailureMessage`, `edit/session.ts:304-333`).

**How a reviewer falsifies the clipboard half (W-C):** spy on `navigator.clipboard.writeText` and on
`document.execCommand` for the whole failure flow and assert **zero** calls; grep the row's diff for
`clipboard`, `execCommand`, `select(` and `copy` listeners — zero hits outside the pre-existing cell-copy path;
dispatch a `copy` event on the `<pre>` and assert `event.defaultPrevented === false` and that computed
`user-select` is not `none`; assert no `onCopy` handler is present on the `<pre>` (N16).

**How a reviewer falsifies it:** (a) grep `apps/web/src/replace/**` for `phase.message`, `String(error)`,
`error.message` — zero hits; (b) assert the alert's `<details>` has no `open` attribute on first render and
its only child is the `<pre>`; (c) assert the C10 notice text contains none of the raw diagnostic (compare
against the known engine string for a corrupt fixture); (d) assert no telemetry event payload contains the
raw message; (e) assert `document.title` and every `aria-live` region never carry it, and that **no app-initiated clipboard write** happens (the clipboard half above; the user may still copy the visible text).

---

## 9. Test and reservation matrix

### 9.1 Rows (browser-observable unless marked)

Rows 1–25 are v1's adopted matrix (clean cancel/failure/unsupported/corrupt; dirty guard + Stay + Escape +
export cancel/success; choose+cancel; choose+valid; undo-to-zero clean; logged no-op clean; refused cast;
rolled-back commit; redo branch dirty; repeated intent; gated late completion; Open-during-export; modal
arbitration; focus return; no-autosave pin; legacy idle cancel; source never written). **New rows required by
A1/A2 and the corrections (N1–N12), and by the v3 fixes (N13–N16):**

| #   | Case                                                                                    | Assertion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Layer                                                                                                                                                                                                                           | Harness note                                                                                                                                                                                                                                                                                                                                                                   |
| --- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| N1  | **clean** path, open cell editor with an invalid draft (blur refused)                   | no picker opens, no `replace-guard`, `replace-draft-notice` = C13, `document.activeElement` is `grid-editor-input`, history unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | RTL + e2e                                                                                                                                                                                                                       | e2e: click a cell, type an invalid value, click Open; assert **no** `filechooser` event fired                                                                                                                                                                                                                                                                                  |
| N2  | **dirty** path, same invalid draft                                                      | identical to N1 (gate precedes the guard)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | e2e                                                                                                                                                                                                                             |                                                                                                                                                                                                                                                                                                                                                                                |
| N3  | open editor without a blur (programmatic activation: `open-button.click()` from script) | G3 refuses, C13, focus to the editor, no picker, no commit of the draft                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | RTL (jsdom `.click()` does not blur)                                                                                                                                                                                            | proves the `open===true` superset rule                                                                                                                                                                                                                                                                                                                                         |
| N4  | **unsettled commit defers the gesture**                                                 | with `model.refresh()` held: click Open → no picker, no guard, `replace-settling-notice` = C15; release the refresh → next click proceeds normally                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | RTL (deferred `refresh` promise on the model mock) + e2e (held `engine/overlay-*`/worker gate as `open-cancel.spec.ts:53-77`)                                                                                                   | a synchronously-resolving mock will _not_ reproduce this; the mock must hold                                                                                                                                                                                                                                                                                                   |
| N5  | settlement then dirty                                                                   | edit a cell (commit settles) → Open → guard appears; the edit is counted once in `pending-changes` and once only after the settle                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | e2e                                                                                                                                                                                                                             |                                                                                                                                                                                                                                                                                                                                                                                |
| N6  | **A1 overlay isolation**                                                                | with a _dirty_ live session (an applied rename/cast whose columns differ from the candidate's), open a candidate: candidate `model.load()` must succeed and the live session must keep rendering its own edited view; assert the candidate's schema/rowcount came from the base path (query-stats: no `overlay-*` request for the candidate handle)                                                                                                                                                                                                                                                                                                                                      | e2e with **distinct-schema fixtures** (e.g. the renamed column exists only in the candidate, or the live overlay references a column absent from the candidate so an inherited overlay would error or return the wrong columns) | if the candidate inherited the live overlay, the read either rejects (overlay composed over the wrong base) or returns the live column names — assert both negatively                                                                                                                                                                                                          |
| N7  | A1 rebind at adoption                                                                   | after adoption the grid reflects the _new_ dataset and the first live edit applies through `overlayRef`; assert no `overlay-*` request is issued between `beginSession` and the first post-adoption edit, and that `model.refresh()` is **not** called by adoption                                                                                                                                                                                                                                                                                                                                                                                                                       | e2e (query counters via `GridViewportModel` stats)                                                                                                                                                                              |                                                                                                                                                                                                                                                                                                                                                                                |
| N8  | **superseded candidate returns** — _not user-reachable by design_                       | unit: `canAdopt({seq:1,current:2,…}) === false` and `canAdopt({…, phase: other}) === false`, and a rejected adopt writes **no** ref; e2e: **must not be faked** — with one intent and no Cancel (M-D8/ADR 0047) no user gesture can supersede a candidate, so the stale-return guard is defensive only                                                                                                                                                                                                                                                                                                                                                                                   | machine unit test (RTL/Node)                                                                                                                                                                                                    | declare the e2e leg unreachable in the test file header; do not synthesize a second intent, and do not add a Cancel to reach it                                                                                                                                                                                                                                                |
| N9  | **post-registration failure**                                                           | candidate whose `model.load()` fails (fixture that opens but whose view cannot be materialized, or a mock provider rejection): live session intact, `replace-error` = C10, and retention accounting recorded (one retained table — assert worker registry size if instrumentation exists, otherwise assert behaviour only and record the retention as unasserted)                                                                                                                                                                                                                                                                                                                        | RTL (provider rejection) + e2e if a real failing fixture exists                                                                                                                                                                 | do **not** claim a release                                                                                                                                                                                                                                                                                                                                                     |
| N10 | legacy-path leaks unchanged                                                             | `cancelOpen` during schema work leaves the session at `idle` (today's behaviour) and retains a table; assert only the observable `idle` phase, not the retention                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | e2e (existing `open-cancel.spec.ts` must stay unmodified and green)                                                                                                                                                             |                                                                                                                                                                                                                                                                                                                                                                                |
| N11 | adoption atomicity                                                                      | no intermediate frame shows the old grid with the new model: assert exactly one `ready` announcement and that the old dataset's first row is never observable after the new one's                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | e2e                                                                                                                                                                                                                             |                                                                                                                                                                                                                                                                                                                                                                                |
| N12 | `inert` focus safety                                                                    | on entering `opening-candidate` with focus inside the inert region, `document.activeElement` is the progress element (never `<body>`), and no edit can be committed during the window                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | e2e                                                                                                                                                                                                                             | browsers differ on inert-blur; assert the explicit move, not the UA behaviour                                                                                                                                                                                                                                                                                                  |
| N13 | **boolean editor blocks with the right focus target** (FIX 2)                           | double-click a BOOLEAN column (fixture must contain one), pick nothing (the `true / false…` placeholder), then a **real pointer click** on Open: no picker event, no guard, `replace-draft-notice` = C13, `document.activeElement` is `[data-testid="grid-editor-boolean"]`, the select is still rendered, history unchanged                                                                                                                                                                                                                                                                                                                                                             | e2e (real pointer) + RTL                                                                                                                                                                                                        | proves G3 does not rely on blur; an implementation that focuses `grid-editor-input` unconditionally leaves focus on `<body>` here and fails, while still passing N1. For a boolean editor there is no `grid-editor-input` in the DOM, so the assertion must name `grid-editor-boolean`                                                                                         |
| N14 | **cast pre-check blocks with C16, then clears**                                         | with `overlayCastCheck` held (worker gate or client mock), trigger a cast → click Open: no picker/guard, `replace-cast-notice` = C16 present, `column-cast-pending` still visible; release the check → C16 disappears without any further user action, and the next Open proceeds (C15 may appear first if the cast's commit is still refreshing — assert the transition order C16 → C15 → none)                                                                                                                                                                                                                                                                                         | RTL (held promise) + e2e (worker gate)                                                                                                                                                                                          | requires holding a _cast_ request, not a refresh; assert the notice id, not a timeout; the copy is column-free, so assert the string, not a column name                                                                                                                                                                                                                        |
| N17 | **two overlapping cast checks keep G4 blocked** (C3)                                    | hold `overlayCastCheck` for columns A and B; start A, start B (both must be startable — per-column disable only); resolve **B first**: `castPendingCount` is still 1, `replace-cast-notice` still present, and an Open gesture is still refused; resolve A: count 0, notice gone, Open proceeds                                                                                                                                                                                                                                                                                                                                                                                          | RTL (two held promises, resolve out of order)                                                                                                                                                                                   | this is the exact defect a single `castPendingColumn` value cannot pass: with the old state B's `finally` cleared the marker while A was in flight. Setup note: B's check must be **non-committing** — a successful cast would start a mutation and C15 would then take precedence over C16 — so this pins the aggregate, not the commit path. Assert count/notice, not timers |
| N15 | **settling notice never self-advances**                                                 | hold the commit's `refresh()`; click Open → C15; call `open` repeatedly while held → still C15, still no picker/guard, `intent` status unchanged; release → C15 clears and **no** guard/picker opens by itself (the user must click again)                                                                                                                                                                                                                                                                                                                                                                                                                                               | RTL                                                                                                                                                                                                                             | also assert there is no dismiss control and no countdown text                                                                                                                                                                                                                                                                                                                  |
| N16 | **technical detail is scoped (FIX 4 / W-C)**                                            | after a candidate failure: (i) `[data-testid="replace-error-details"]` is a closed `<details>` whose only child is the `<pre>`, and the marker string appears **only** there; (ii) the C10 notice text contains no engine diagnostic; (iii) no telemetry payload, `document.title` or live region carries the raw text; (iv) **no app-initiated clipboard write happens** — `navigator.clipboard.writeText` and `document.execCommand` spies record **0** calls for the whole flow; (v) a **user**-initiated copy of the visible `<pre>` is _not_ suppressed: a dispatched `copy` event is not `defaultPrevented`, the `<pre>` has no `onCopy`, and computed `user-select` is not `none` | RTL (mocked rejection with a distinctive marker string) + source grep                                                                                                                                                           | the marker string makes leakage observable; (iv) and (v) are separate assertions — a guard that suppresses the copy would pass (iv) and fail (v)                                                                                                                                                                                                                               |

**RTL-only (cannot be driven natively):** picker **cancellation** and picker **refusal** — Playwright can
`setFiles()` but cannot dismiss a chooser; the app's cancel path depends on the hidden-input `cancel` event
(`pick-file.ts:130-136`) or the FSA `AbortError` (`85-88`). These cases (T6, T1/T5 cancel legs, N1/N3's
"no picker" claim in a real browser) are covered in RTL with the picker module mocked to `null`
(`App.tsx:28` import seam; pattern `App.lifecycle.test.tsx:51`). Adding a production hook to force
cancellation is refused. Also unassertable: whether a download was actually written or refused by the user
(`save-destination.ts:230-243` initiates only), and whether a retired table was freed (nothing frees it).

### 9.2 Reservations (unchanged set + A1/A2 additions)

| File                                                                                    | Change                                                                                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/App.tsx`                                                                  | split `openDataFile` into `gate → acquire → prepare → adopt`; intent state; gesture gate call; disable Open under any modal/intent; `inert`/`aria-busy` for `opening-candidate`; adoption block (§4.3)                                                              |
| `apps/web/src/replace/machine.ts` _(new)_                                               | pure intent reducer + adoption precondition                                                                                                                                                                                                                         |
| `apps/web/src/replace/gate.ts` _(new)_                                                  | pure G1–G6 gate (S-A2-3)                                                                                                                                                                                                                                            |
| `apps/web/src/replace/ReplaceGuard.tsx` _(new)_                                         | native `<dialog>` guard                                                                                                                                                                                                                                             |
| `apps/web/src/replace/messages.ts` _(new)_                                              | C1–C16 as pure constants                                                                                                                                                                                                                                            |
| `apps/web/src/replace/{machine,gate,messages}.test.ts`, `ReplaceGuard.test.tsx` _(new)_ | independent assertions (do not import implementation constants as expected copy — `export/messages.test.ts` precedent)                                                                                                                                              |
| `apps/web/src/edit/session.ts`                                                          | add `hasAppliedChanges` (§2)                                                                                                                                                                                                                                        |
| `apps/web/src/edit/session.test.ts`                                                     | predicate cases (§2 verdicts)                                                                                                                                                                                                                                       |
| `apps/web/src/sessions/useEditingSession.ts`                                            | add `mutationStateRef` + `mutationPending` (S-A2-2/§3.7) and replace `castPendingColumn` with `castPendingColumns: ReadonlySet<string>` + `castPendingCount` (S-A2-4); no behaviour change for a single check                                                       |
| `apps/web/src/grid/provider.ts`                                                         | add `rebindOverlaySource` (A1-3); no other change                                                                                                                                                                                                                   |
| `apps/web/src/grid/provider.test.ts`                                                    | candidate-local vs rebound overlay source cases                                                                                                                                                                                                                     |
| `apps/web/src/grid/DataGrid.tsx`                                                        | add `editorStateRef` prop + the synchronous writes of S-A2-1 (text input, boolean select, enter/commit/cancel/refusal); no editing change                                                                                                                           |
| `apps/web/src/schema/SchemaPanel.tsx`                                                   | **newly reserved in v4** (C3): the per-column `castPendingColumn` prop (typed `string` or `null`) becomes `castPendingColumns?: ReadonlySet<string>`, and `castPending={castPendingColumns.has(column.name)}` at `597`; per-column disable semantics byte-identical |
| `apps/web/src/schema/SchemaPanel.test.tsx`                                              | adapt any prop usage (none references `castPending` at `05ae1ab`; keep the file green and unweakened)                                                                                                                                                               |
| `apps/web/src/index.css`                                                                | guard dialog styling → **triggers configured/restored telemetry legs** (spec §6.2)                                                                                                                                                                                  |
| `apps/web/src/App.replace.test.tsx` _(new)_                                             | RTL: N1–N5, N9, N13–N17, gate unit coverage                                                                                                                                                                                                                         |
| `tests/e2e/replace-guard.spec.ts` _(new)_                                               | N1, N2, N5, N6, N7, N11, N12, N13, N14 (N8/N15/N16/N17 unit-first) + v1 e2e rows                                                                                                                                                                                    |
| `.changeset/<row>.md` _(new)_                                                           | one `@assay/web` changeset, stating the ADR 0047 retention limitation                                                                                                                                                                                               |

**Not reserved:** `sessions/session-reset.ts`, `packages/**`, `export/**`, `sessions/types.ts`,
`telemetry/**`, playwright configs, root configs, ADRs, `docs/**`. Existing assertions may be strengthened,
never relaxed, skipped, retried or `force: true`d.

---

## 10. Decisions — all adopted; none open

M-D1 clean sessions preserved with no guard · M-D2 dirty-only guard whose action initiates selection ·
**M-D3 → A1** (candidate-local empty overlay, rebind only at adoption) · M-D4 `hasAppliedChanges` after
settlement · M-D5 redo-tail-only clean · M-D6 A→B→A dirty · **M-D7 → A2** (synchronous editor gate on both
paths, settled `historyRef.current`) · M-D8 no Cancel during candidate open · M-D9 `Choose a replacement
file…` · **M-D10 → A3 + ADR 0047** (unbounded retention accepted; feature must not manufacture retirements) ·
M-D11 export ends the intent · M-D12 native `<dialog>`.

Two string ids are new in v3 and carried by §8 as a reviewable unit (not new decisions): **C15** (mutation
settling) and **C16** (cast pre-check), split because a single string cannot be true for both waits (§3.5).
v4 records one **design choice, not a maintainer decision**: aggregate cast tracking (S-A2-4) over
single-flight. It is chosen because it keeps today's per-column disable semantics, blocks nothing unrelated,
and — with an unbounded check wait (§3.5) — single-flight could freeze the whole schema panel. The rejected
option and its cost are written down in §3.3 so a later brief cannot silently switch to it.

No decision is outstanding for WF-06. If WF-06 discovers a case these rules do not settle, it **stops and
reports**; it does not choose.

---

## 11. What this contract does not authorize

No runtime work, branch, worktree, commit or push from WF-05. WF-06 remains BLOCKED until its own brief is
written against this document. No engine/protocol/package change, no release primitive, no second worker, no
hidden grid, no autosave/persistence/`beforeunload` promise, no "saved" claim, no copy outside §8, no
assertion relaxation, and no reopening of WFD-02, ADR 0044/WF-08/09, D-06, D-11, SQL sizing (SV-D04),
overlay profiling (SV-D05), WF-01/01P/02/03/04/07, WF-O1 or WF-O2.

---

## 12. Contract sufficiency checklist (WF-06 must be able to implement each line mechanically)

**States and owners**

- [ ] K01 `Phase` gains no new kinds; `data-phase` values remain `idle|opening|ready|error`.
- [ ] K02 Intent is exactly `none|guard|choosing|opening-candidate`; **`none` carries no `seq`** (nothing in flight to supersede) and the three in-flight states each carry the `seq` they were created with. The **authority** is the monotonic `intentSeqRef`; every completion compares against `intentSeqRef.current` (and the captured `phase` identity), never against an intent object that may already be `none`. Refusals are notices, not states.
- [ ] K03 **Diff-scoped writer rule (R1, §4.7):** in _this row's diff_, the only new occurrences of `historyRef.current =`, `overlayRef.current =`, `sourceIdentityRef.current =`, `openSourceRef.current =`, `setPanelModules(` or `setPhase(` are inside `adopt()`. The matrix names the four writer classes: (a) `adopt()`, (b) the unchanged destroyers (T0, `cancelOpen`), (c) **`activateHistory` — normal edits, always legal, out of scope**, (d) the registered resets. Falsify: diff grep (only class (a) may be added) **plus** the `opening-candidate` live-session-intact assertions (v1 rows + N6). A rule claiming that nothing but `adopt()` writes those refs is false and must not be used.
- [ ] K04 **`beginSession` has exactly three call expressions** (R2, §4.7): `App.tsx:1592` (`cancelOpen`), `App.tsx:1611` (legacy T0), adopt step 1. Falsify with **both** greps at the worker's own baseline: `grep -rn 'beginSession(' apps/web/src | grep -v '\.test\.'` must return exactly **4** lines at `05ae1ab` (two calls + prose comments `session-reset.ts:18`, `ErrorBoundary.tsx:22`), and without the test filter **5** (the extra hit is the prose comment `App.panel-boundary.test.tsx:18`). After this row each count grows by exactly **1** (the adopt call).
- [ ] K05 T0 (idle path incl. example/drop/retry/cancelOpen) is byte-identical to today.

**Ordering constraints**

- [ ] K06 Gate G1–G6 runs synchronously before any dialog, picker or `await`.
- [ ] K07 G3 blocks on `editorStateRef.current.open === true` **for every editor kind**; focus follows the §3.2.1 chain — `grid-editor-boolean` (boolean kind) or `grid-editor-input`, then `grid-cell-editor`, then the roving `grid-row[tabindex="0"]`, then `open-button`; never `<body>`.
- [ ] K08 G4 blocks while `mutationStateRef.current > 0` or **`castPendingCount > 0`** (the aggregate set size, S-A2-4 — never a single column); notice C15 when a mutation is in flight, C16 when only cast pre-checks are pending (C15 wins). No time bound is claimed.
- [ ] K09 Dirty is computed only after K06–K08 pass, from `historyRef.current`.
- [ ] K10 Candidate provider's overlay source is a local box over `overlaySnapshot(candidateBase, emptyHistory())`; it references no App ref.
- [ ] K11 `rebindOverlaySource` is called after `beginSession()` **and** after `overlayRef` republish, before `setPhase`.
- [ ] K12 `adopt()` is fully synchronous and calls no `model.refresh()`.
- [ ] K13 Late resumption is dropped by `seq` + captured `phase` identity, not by the session token.

**Per-transition behaviour**

- [ ] K14 T3/T6/T9/T9b/T10 leave the live session's rendered state byte-identical (no reset, no phase write).
- [ ] K15 T4 closes the guard before ExportDialog opens; no stacking; intent ends.
- [ ] K16 T7 offers no Cancel; the ready region is `inert` + `aria-busy`; a focused descendant moves to `replace-progress`.
- [ ] K17 Open (and Help/Export/Settings) are disabled while `intent !== 'none'` **and** while any owned modal is open.
- [ ] K18 The guard is a native `<dialog>` via `showModal()`; Escape = Stay; focus returns only to a connected opener, else the Open control.

**Copy and truth**

- [ ] K19 Every string comes from `replace/messages.ts` and equals C1–C16 exactly; the module has no interpolation of engine text (C10 uses only the classified cause from `openFailureMessage`).
- [ ] K20 **Scoped (FIX 4 / W-C):** no filename, path, dataset value or count is rendered anywhere in the replacement UI **outside** the collapsed C14 detail block inside the failure alert; C14's permitted/forbidden content is exactly §8.1; and no raw diagnostic reaches telemetry, logs, titles or live regions, while the **only** clipboard rule is the W-C one (no app-initiated write; a user copy of the visible text is allowed).
- [ ] K21 No "saved", no autosave, no `beforeunload` save listener added by this row.
- [ ] K22 **Transition-scoped (R3, §4.7):** among the **new** transitions **T1–T11**, only `adopt()` resets or replaces `history`/`overlay` and only `adopt()` writes `phase`; **T3/T4/T6/T9/T9b/T10 leave all of them byte-identical**; `adopt()`'s order is reset (step 1) → republish (step 3) → rebind (step 4). **Out of scope and unchanged:** the legacy T0 chain resets through `beginSession` (`App.tsx:1611`) and closes the Export dialog (`1619`); `cancelOpen` resets through `beginSession` (`1592`). Falsify by asserting the live session's history text and rendered state are byte-identical after each of T3/T4/T6/T9/T9b/T10 — **except** the export-dialog state, which K15 requires to change on T4 (guard closes, ExportDialog opens, intent ends): T4 asserts that expected dialog transition plus unchanged session state, while the other five assert the dialog is unchanged too. Do not assert any of it about T0.

**Seams to add (and nothing more)**

- [ ] K23 `DataGrid`: optional `editorStateRef` written synchronously at every write point listed in §3.3 (text input, boolean select, enter/commit/cancel/refusal); no editing/history change.
- [ ] K24 `useEditingSession`: `mutationStateRef` counter + `mutationPending` mirror (increment before, decrement in `finally` around the commit's `await`; no abort/timeout/reorder/serialization — §3.6) **and** `castPendingColumns: ReadonlySet<string>` + `castPendingCount` replacing `castPendingColumn`, with the add before the check loop (`345`), a per-column delete in the existing `finally` (`385-387`) and a full clear on session reset (`468`).
- [ ] K25 `provider.ts`: `rebindOverlaySource`; `overlaySource` remains unreadable outside the class.
- [ ] K26 `edit/session.ts`: `hasAppliedChanges` only.
- [ ] K27 No `packages/**`, `session-reset.ts`, `export/**`, `types.ts`, telemetry or config change.

**Tests to write**

- [ ] K28 RTL: G1–G6 gate unit tests; N1/N2/N3/N4/N5/N9/N13/N14/N15/N16 (N13 and N14 are also e2e; N16 needs a distinctive marker string).
- [ ] K29 e2e: v1 rows + N1/N2/N5/N6/N7/N11/N12/N13/N14 with real fixtures and the worker gate; N8 is a unit-only stale-return guard and must be declared unreachable in e2e.
- [ ] K30 N6 uses distinct-schema fixtures and asserts negatively (a wrong inherited overlay errors or yields wrong columns).
- [ ] K31 RTL-only legs (picker cancel/refusal) are labelled as such in the test file and not faked in e2e.
- [ ] K32 Existing `open-cancel.spec.ts`, `open-recovery.spec.ts`, open/export/history/validation journeys stay unmodified and green.

**Honesty gates**

- [ ] K33 The changeset states the ADR 0047 retention limitation and claims no bound.
- [ ] K34 No retirement is manufactured: one intent, no Cancel in `opening-candidate`, no declinable candidate state.
- [ ] K35 If K10/K11 cannot be met, the row stops and reports (§4.4 stop rule) instead of shipping.

**v3 additions (the four fixes + the warning)**

- [ ] K36 **Writer matrix exists and holds** (§4.7): four writer classes (a) adopt, (b) T0/`cancelOpen`, (c) `activateHistory`, (d) resets; R1 = **diff-scoped** (only class (a) is new, K03), R2 = three `beginSession` call expressions (K04), R3 = **transition-scoped** to T1–T11 (K22), R4 = `cancelOpen` writes no ref directly, R5 = edits are never blocked. This line adds no rule beyond K03/K04/K22; it is the index that keeps them consistent (no duplicate wording to drift).
- [ ] K37 **G3 focus is per kind** (§3.2.1): boolean → `grid-editor-boolean`; text/number/temporal → `grid-editor-input`; then container → roving row → `open-button`; the refusal never focuses `<body>` and never commits the draft. Covered by N13 (real pointer, boolean).
- [ ] K38 **No settlement time bound** (§3.5): the contract lists up to two sequential refreshes and up to three `overlayCastCheck` awaits and states that the client has no request timeout; **no string in C1–C16 promises a duration** (in this document "in a moment" appears only where the rejected v2 wording is quoted). `castPendingCount` and `mutationStateRef` are both gate inputs.
- [ ] K39 **Counter claims are scoped** (§3.6): the counter refuses gestures while work is in flight and evaluates dirty on the actually-published history; it does not serialize, order, coalesce or abort commits, and nothing in code, copy or changeset says it does.
- [ ] K40 **Notice lifecycle pinned** (§3.7): C13 on editor close; C15 on `mutationPending === false`; C16 when **`castPendingCount` returns to 0** (the last pending check finished — never on the first `finally`) or hands over to C15; no notice has a dismiss control, a countdown, a timeout or an auto-resume of the gesture.
- [ ] K41 **C14 scoped** (§8.1): the detail block is a closed `<details>` inside the failure alert only; content is stated as two classes — **Class 1 (provable):** our layer supplies only engine-generated identifiers (`tN`, `assay_tN`) and the fixed unsupported-format sentence, and within `runOpen` the picked name is used only for `detectFileFormat`; **Class 2 (not provable):** whatever the WASM reader echoes, including possibly the file name or source fragments, assumed present. Forbidden = anything the app _adds_. Reviewer checks (a)–(e) pass and N16's marker string appears in the `<pre>` and nowhere else.
- [ ] K42 **Aggregate cast tracking** (§3.3 S-A2-4): one Set keyed by column, per-column disable preserved, `castPendingCount` mirror, reset clears the set; two concurrent checks are possible by design and G4 must stay blocked until the **last** one clears (N17). Single-flight is rejected and must not be implemented (it needs the same `SchemaPanel` edit and would freeze unrelated column work).
- [ ] K43 **Writer classes named, never 'only adopt'** (§4.7): the matrix lists (a) adopt, (b) T0/`cancelOpen`, (c) `activateHistory`, (d) resets; R5 states edits are never blocked; no rule anywhere claims that nothing but `adopt()` writes session refs.

---

## 13. Rules I could not pin down from source (and what would settle them)

**U-1 — Whether any in-flight engine await settles at all (FIX 3 follow-through).** Three unbounded waits
feed G4: the commit's `await effects.refresh()` and, on the rollback path, a second one
(`edit/session.ts:424-435`); and a cast pre-check's up to `MAX_CAST_CHECK_ATTEMPTS = 3` sequential
`overlayCastCheck` awaits before anything is appended (`useEditingSession.ts:38, 346-378`, cleared in
`finally` at `385-387`). The client installs exactly one timer — the `dispose()` handshake
(`client.ts:234-237, 1051-1058`) — and `send()` has none, so none of these is bounded. G4 is therefore
fail-closed but potentially indefinite: replacement stays refused with C15/C16 while the engine does not
answer. _Pinned as rules:_ no timeout, no bypass, no auto-resume, notice clears only on its observable
(§3.7); the existing recovery surfaces remain the way out (`viewError` + "Retry loading the view",
`App.tsx:1992-2002`; cast refusal messages). _Left open as a product question:_ whether a hung engine should
get an explicit "the view is unresponsive, replacement unavailable" state beyond C15/C16 — that is a new
behaviour and needs its own decision.

**U-2 — Whether a candidate `model.load()` can be made to fail observably with a committed fixture.**
N9 needs a file that `engine.open` accepts but whose view/row count cannot be materialized. No such fixture
exists in `fixtures/` today (only `invalid/corrupt.parquet`, which fails _inside_ `runOpen`). _Pinned as:_
test N9 may use an injected provider rejection (RTL) and must record the real-engine case as unasserted.
_Would need:_ a new fixture or a documented real-engine repro — a fixture reservation, not a design gap.

**U-3 — How each browser treats `inert` applied to an ancestor of the focused element.** Source cannot
say whether focus blurs to `<body>`, stays, or moves. _Pinned as:_ the implementation must move focus
explicitly when `document.activeElement` is inside the region (K16/N12), so behaviour never depends on the
UA. _Would need:_ browser-matrix evidence if anyone wants to drop the explicit move.

**U-4 — Whether `engineClient.open` can complete while the worker is mid-dispose.** `dispose()` is terminal
and fails pending work (`client.ts:1030-1098`), and `App.tsx:1262-1280` fires it on
`beforeunload`/`pagehide`. A candidate open racing page teardown is therefore unobservable in a test.
_Pinned as:_ T11 wins; a candidate that resolves after disposal is discarded by the existing client guard,
and no test asserts it. _Would need:_ a synthetic unmount test only if the maintainer wants the race covered.

**U-5 — The exact registry size after N replacements.** `TableRegistry` exposes `size`
(`table-registry.ts:102-104`) but there is no protocol op to read it from the app, so N8/N9's retention accounting
is asserted only behaviourally. _Would need:_ a test-only engine introspection seam (refused under the
no-package-change rule) or acceptance that retention is unasserted and only documented (the current state).

**U-6 — Whether DuckDB-WASM echoes the user's `File.name` or source bytes in an error message.** The worker
forwards `error.message` verbatim (`engine-executor.ts:460-467, 2022-2024`), and the WASM reader is handed the
real `File` (whose `name` is the user's filename) even though our registration name is engine-generated
(`engine-executor.ts:492`). Nothing in this repository can say whether a read/CSV/JSON failure quotes that
name or a fragment of the bytes. _Pinned as a rule:_ C14 is treated as possibly containing source-derived text
and is therefore confined to a collapsed detail block, never reaching telemetry, logs, titles or live regions, with no **app-initiated** clipboard write — while a user selecting and copying the visible `<pre>` remains allowed and must not be suppressed (§8.1 W-C). K20 is scoped to match. _Would need:_ a real-engine probe with a deliberately malformed file containing a unique marker (name
and a cell value) to observe what an error string actually contains; that is a read-only probe like WF-01P,
not authorized by this row.

**U-7 — Whether two concurrent `overlayCastCheck` requests can interfere engine-side.** The client assigns a
monotonic `requestId` per op (`takeRequestId`, `client.ts:1154`) and `send()` multiplexes by it
(`client.ts:1110-1113`); `overlayCastCheck` is an ordinary request (`client.ts:678-690`) and the executor replies
per request (`engine-executor.ts:460-467`), so the _protocol_ permits concurrent ops. Whether two cast checks on
the same table produce independent verdicts is an engine-executor property, not something this repository states.
_Pinned as:_ G4 blocks on the aggregate, so replacement is safe either way; the UI already permits the overlap
(`SchemaPanel.tsx:195, 210, 597`) and this row neither adds nor removes that capability. _Would need:_ a probe of
two simultaneous `overlayCastCheck` calls on one handle if anyone wants to claim the verdicts are independent;
the design does not depend on it.
