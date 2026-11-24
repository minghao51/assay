# Overlay-aware profile consistency contract (R-7) — protocol, client, consistency rule, and the escalated domain question

**Date:** 2026-11-23. **Base:** `main` at `a8b58c3`. **Status:** DRAFT — items 1, 2, 4 and 5 are
**proposed for a maintainer decision**; **item 3 is ESCALATED to the architect and is not decided
here.** This document authorises no runtime work of any kind.

It is the contract the [H1 UX runtime briefs](20261122-h1-ux-runtime-briefs.md) **§R-7** requires
before any runtime row may be reserved, drafted under the
[WFD selections](20261123-wfd-selections.md) **§6** ("draft the contract and escalate item 3 to the
architect; implement nothing"), inside the planning-only charter of the
[overlay-profile candidate](20261030-overlay-profile-candidate.md).

## 1. Scope, authority, and what this document is not

**Authority, in order.** The [candidate charter](20261030-overlay-profile-candidate.md) is the
authority for what may not happen: "no worker may claim it, no protocol, domain, `DataEngine` target
or engine source may change until a later explicit maintainer decision". The
[brief](20261122-h1-ux-runtime-briefs.md) §R-7 itemises the five contract decisions and the hard
constraints. The [selection record](20261123-wfd-selections.md) §6 records that items 1, 2, 4, 5 are
draftable and item 3 is a ruling, not an assumption. [D-09](20261121-decision-round.md) = A
(2026-11-21) stands and is **not** reopened, amended or pre-empted by anything below.

**What this document is.** The specification a later runtime dispatch must implement without
improvising — for the protocol shape (item 1), the client shape (item 2), the consistency invariant
(item 4) and the top-k re-decision (item 5) — plus a precise statement of the boundary question that
only the architect can settle (item 3), and the conformance matrix an approval would need to cover.

**What it is not.** It is not an approval, a dispatch, a reservation, or a claim that the delivered
behaviour is wrong. It does not reopen D-09, R-16's copy decision, ug-16's design, ADR 0012, ADR
0025/0037/0038, or the D13 target question it deliberately leaves open in §6.

**State of the five items.**

| Item                                  | State here                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------------- |
| 1. Protocol shape                     | **PROPOSED** (§4) — one proposal, one recorded alternative, both reasoned     |
| 2. Client shape                       | **PROPOSED** (§5)                                                             |
| 3. Domain / `DataEngine` target scope | **ESCALATED — NOT DECIDED** (§6): both branches stated, neither chosen        |
| 4. Consistency rule                   | **PROPOSED** (§7) — four numbered invariants plus the boundary table          |
| 5. UI / top-k re-decision             | **PROPOSED** (§8) — semantics kept, mapping rule re-decided, one copy retired |

**Line anchors drift.** Every `path:line` below was read at `a8b58c3`. Re-verify with a read or
`grep` before citing one in a commit; the brief says the same about its own anchors.

## 2. Constraints carried in — not reopened here

| Constraint (source)                                                                                  | Consequence for this contract                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR 0012 — immutable base + overlay, never in-place mutation                                         | The profiled relation is the composed effective relation over an immutable base. No rewrite, no materialization, no source mutation.                                                         |
| ADR 0025 / 0037 — telemetry privacy, opt-out consent                                                 | **No telemetry change.** `profile_run` keeps its exact bucket set (column-count bucket, duration bucket, outcome). No view dimension, no op count, no column names, no values, no filenames. |
| ADR 0038 — pinned-CLI fixture generation                                                             | Every effective-vs-base agreement claim is derived from the pinned DuckDB CLI (v1.5.5 here); golden fixtures regenerate through the script, never by hand.                                   |
| ADR 0040 — two op lanes                                                                              | A profile is a **query-lane** scan. The overlay payload does not move it to the registry lane: the lane follows op class (scan cost), not payload shape.                                     |
| `MAX_OVERLAY_LIVE_INSERT_BRANCHES = 500` (`overlay-query.ts:215`)                                    | The live-insert budget survives unchanged; the refusal is typed and value-free. The cap and its shipped copy are not renumbered or rewritten here (§7.4).                                    |
| Never a silent base fallback                                                                         | Neither a refusal, nor an error, nor an unparseable request may answer base-view numbers labelled as anything else (§7.2, I-2).                                                              |
| Never both profile contracts shown at once                                                           | One profile result in the panel at a time, stamped with the view it describes; the base-only hint and the effective label can never co-render (§7.3, I-3).                                   |
| R-16 copy is **replaced, not doubled** (brief §R-7; candidate §4)                                    | When the effective path ships, `STANDING_HINT` and `stagedChangesNote` go; a pin must make their reappearance fail (§7.5). The replacement ships **with** the effective path, never before.  |
| D-09 = A stands; D-02 A / RD-T07 (no usability claims)                                               | Nothing here calls any state "validated", "intuitive" or "easier", and nothing here re-decides the D-09 gate.                                                                                |
| Dependency rules (`AGENTS.md`; [repo structure](../../engineering/03-repository-structure.md) §2/§4) | Relevant only to §6, where the branch analysis lives; the contract itself touches no package.                                                                                                |

## 3. The delivered behaviour this contract must describe (not redesign)

Read at `a8b58c3`; these are the facts the contract is written against.

| #   | Fact                                                                                                                                                                                                                                                                                                                                                                               | Evidence                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| F1  | `profile(handle)` sends exactly `{type:'engine/profile', requestId, tableId}`; the worker profiles `entry.viewName` — the base view.                                                                                                                                                                                                                                               | `client.ts:727`, `protocol.ts:260`, `engine-executor.ts:489`                       |
| F2  | The result payload is `{type:'engine/profile-result', requestId, rowCount, columns}`; each column carries `name`, `type`, `kind`, `nullCount`, `distinctCount`, plus `numeric` (min/max/mean/stddev, quantiles p50/p90/p95/p99) **iff** kind is numeric, `categorical` (top-k, k = 10) **iff** categorical.                                                                        | `protocol.ts:919-943`, `profile-query.ts:30-33`                                    |
| F3  | Profile is a **query-lane** op, explicitly alongside `engine/profile-comparison`; it never blocks the registry lane's window traffic.                                                                                                                                                                                                                                              | `engine-executor.ts:380-383`, `protocol.ts:278-281`                                |
| F4  | `engine/profile-comparison` (B3) is the shipped precedent for a second profile address: **the same result payload, unchanged**, resolved through a different registry slot, with a strict unknown-field refusal at parse time.                                                                                                                                                     | `protocol.ts:266-285`, `:1160-1174`                                                |
| F5  | **Wire-compatibility facts.** (a) The `engine/profile` parser returns a fresh `{type, requestId, tableId}` object, so an extra own key on the request is **silently dropped**, not refused. (b) An unrecognised request `type` parses to `ignored` — the message gets no answer at all. (c) `engine/ready` carries `duckdbVersion` only: there is no protocol-version negotiation. | `protocol.ts:1156-1159`, `:1405-1408`, `:1505-1527`, `:103-105`                    |
| F6  | The overlay is stateless per request: `EngineOverlay = {base: OverlayBase, ops?: EditOp[]}` crosses on every call; overlay-aware ops already exist (`overlaySchema`, `overlayRowCount`, `fetchOverlayRange`/`overlayRange`, `overlayCastCheck`, `exportView`, `validate`, `diff`). None is a profile.                                                                              | `client.ts:186-197`, `protocol.ts` request union                                   |
| F7  | Effective-view SQL composition exists and is exported: base branch ∪ live-insert branches, tombstones, rename/cast projection, `assay_key` ordering.                                                                                                                                                                                                                               | `overlay-query.ts:937` (`composeSourceSql`), `:1170` (`composeEffectiveSourceSql`) |
| F8  | The live-insert cap is 500, enforced before any SQL is composed, with a value-free typed error whose copy ends "... export the edits to a new file and re-open it to continue".                                                                                                                                                                                                    | `overlay-query.ts:215`, `:292-296`                                                 |
| F9  | The profile plan is **one aggregate scan plus one grouped top-k scan per categorical column** — i.e. `1 + #categorical` scans, each over one relation.                                                                                                                                                                                                                             | `profile-query.ts:3-24`                                                            |
| F10 | R-16 honesty copy is byte-exact: `STANDING_HINT` = `Statistics describe the file as opened — staged changes are not included.` plus `stagedChangesNote(count)` with singular/plural grammar. The hint renders in **every** expanded state; the note renders only while `stagedCount > 0`.                                                                                          | `ProfilePanel.tsx:122`, `:126-130`, `:545-549`                                     |
| F11 | `stagedCount` is `activeOps(history).length` — an entry count, not a net-difference measure; a cast-then-revert history is legitimately > 0.                                                                                                                                                                                                                                       | `App.tsx:2822`, `ProfilePanel.tsx:66-76`                                           |
| F12 | The panel **never re-requests a profile when an edit is staged**: results stay, the call count stays at 1, no "stale" text and no re-run control appears. A source pin also forbids the token `re-run` in `ProfilePanel.tsx`.                                                                                                                                                      | `App.profile-honesty.test.tsx:169-186`, `ProfilePanel.honesty.test.tsx:179-190`    |
| F13 | ug-16 click-to-act is **base-derived**: `planProfileFilter(baseColumn, intent, ops, effectiveSchema)` resolves the base name against the current effective schema, then compiles against the **effective** column's type; `renamed` and `unresolved` refuse with byte-exact copy and change no filter state.                                                                       | `filter-action.ts:34-45`, `:71`, `edit/session.ts:72-90`                           |
| F14 | The panel's telemetry is `profile_run` with column-count bucket, duration bucket and outcome only.                                                                                                                                                                                                                                                                                 | `ProfilePanel.tsx:483-500`                                                         |
| F15 | Delivery is guarded three ways: App's phase machine unmounts the panel across a re-open, the `RunGuard` generation token discards a late result, and a handle-change effect resets the display. An abandoned op still occupies the FIFO — the engine has no op interrupt.                                                                                                          | `ProfilePanel.tsx:17-56`, `:461-475`                                               |

### 3.1 Where the brief's description is incomplete or wrong (recorded, not "fixed")

These are footprint/description corrections for whoever dispatches the runtime row. None changes the
contract's decisions below; all of them change what a dispatch must touch.

1. **The R-16 copy is pinned in six places, not three.** The brief names
   `ProfilePanel.honesty.test.tsx`, `App.profile-honesty.test.tsx` and
   `tests/e2e/profile-honesty.spec.ts`. The `STANDING_HINT` literal is additionally pinned in
   `ProfilePanel.filter.test.tsx:219,235`, `App.profile-filter.test.tsx:400` and
   `tests/e2e/profile-filter.spec.ts:100`. A copy replacement that touches only the three named files
   fails on the other three.
2. **A pin the brief does not mention blocks the obvious implementation.** `App.profile-honesty.test.tsx:169-186`
   asserts the profile is requested **exactly once** and that staging an edit triggers no new request,
   no state flip and no "stale"/re-run affordance. Any auto-refresh-on-edit design is therefore not an
   option to be chosen later; it is already excluded by a pin, and §7 keeps it excluded.
3. **The source pin is textual.** `ProfilePanel.honesty.test.tsx:185-189` reads the component source
   and fails on the token `re-run`/`rerun`/`re-running`. New labeling code must not contain that word
   even in a comment.
4. **The refusal copy is window-class wording.** `OverlayLiveInsertLimitError` says "more live inserts
   than the engine composes in one window". That is accurate for a window op and inaccurate for a
   profile scan (an aggregate plus top-k scans). The shipped string is byte-pinned
   (`overlay-query.test.ts:563`, `engine-executor.test.ts:1830`) and **must not be edited**; a profile
   refusal needs its own wording decision (§10 Q4).
5. **`useDiffSession.ts:132` is not the profile panel.** It calls `profile(phase.handle)` to build the
   **diff** base side. It is a legitimate call site of `engine/profile`, but its semantics belong to
   the diff contract (B3), not to R-7; §5 pins it to base behaviour and out of this change set.
6. **A conformance surface the brief's footprint omits.** The shipped profile conformance scenario
   lives in `@assay/testing` (`engineConformanceScenarioNames`, `:1374-1398`, including
   `profile-semantics` and `profile-comparison`), and the real-engine pin for the B3 precedent is a
   CLI-backed test inside `engine-duckdb` (`profile-comparison.engine.test.ts`). Whether an
   overlay-profile leg belongs in the former (a `packages/testing` surface addition) or only in the
   latter is part of §6's question, not an implementation detail.

## 4. Item 1 — Protocol shape (PROPOSED for approval)

### 4.1 The compatibility floor

The base operation stays **byte-identical**, on both directions of the wire:

- `engine/profile` keeps exactly its three fields, its parser branch and its lane;
- `engine/profile-result` keeps exactly its current fields and validator (`protocol.ts:1659`);
- a caller that passes no overlay today sends and receives the same bytes after this lands
  (the brief's compatibility pin, and the mutation drill: "pass the overlay unconditionally — the
  base-compatibility pin must fail").

### 4.2 Proposal P1 — a distinct request type and a distinct result type

```
request:  { type: 'engine/overlay-profile', requestId, tableId, overlay: EngineOverlay }
response: { type: 'engine/overlay-profile-result', requestId, view: 'effective', rowCount, columns }
```

- **`overlay` is required, not optional.** There is no in-band "no overlay" mode on this request, so
  the request cannot be satisfied by base numbers: an absent or malformed overlay is a rejected
  envelope (`overlay.…` field reason), exactly like the four existing overlay ops
  (`protocol.ts:1177-1182`). The base path stays the base op.
- **`overlay` is validated client-side before it crosses**, via the existing
  `requireValidOverlayTypes` posture (`client.ts:749-757`), so a hostile type expression is refused
  observably instead of making the worker drop the request.
- **`view: 'effective'` is a literal, not a free string.** It is a self-describing stamp that cannot
  be set to a wrong value, and it makes the response's meaning assertable in a test rather than
  implied by the caller's intent. `columns` is the **unchanged** `EngineProfileColumn` shape, so the
  payload's leaf types are shared with the base op and the existing compatibility pins still hold.
- **Lane: query lane**, exactly as `engine/profile` and `engine/profile-comparison`
  (`engine-executor.ts:380-383`). The composed relation is scanned `1 + #categorical` times (F9);
  this is a heavy scan and must never sit in the registry lane's windows.
- **Cap:** the composer's live-insert budget applies before any SQL (F8) — see §7.4.
- **Registration:** the new type joins `ENGINE_REQUEST_TYPES` (`protocol.ts:1420-1447`) so a
  malformed instance is answered with exactly one typed `engine/error` instead of being dropped
  (the q-10 contract), and joins the response validator set.

### 4.3 The recorded alternative — P2, an optional `overlay?` on `engine/profile`

Mirrors `exportView` (`client.ts:212-218`: "Absent `overlay` exports the plain base view"). It is
attractive because it is one field and no new type. It is **not** proposed, for two reasons that come
from the shipped parser, not from taste:

- **Silent-drop → silent base fallback (F5a).** `parseEngineRequestDetailed` rebuilds the
  `engine/profile` request from three fields; an own `overlay` key it does not know is **discarded
  without error**. Any skew between the two sides of the worker boundary (a stale bundle, a partially
  applied change, a future third caller) therefore produces base numbers from an overlay-bearing
  request — precisely the failure the constraints forbid, with no error to observe.
- **A view-ambiguous response.** Sharing `engine/profile-result` forces either `view` to be optional
  (so "absent" silently means base — the same defect, one layer up) or the base response to gain a
  field, which breaks the byte-compatibility floor of §4.1.

For completeness: under P1 the same skew is **not** silent-fallback-shaped — an unrecognised `type`
is `ignored` (F5b), which leaves the caller's promise pending. That is also unacceptable, and it is
why §4.4 requires the type to be registered on both sides and the _client_ to be the only thing that
can construct the request. The correct residue is a **hang, not a wrong number**: a wrong number is
the failure mode this whole candidate exists to avoid.

### 4.4 Requirements P1 inherits

1. The request type exists in `ENGINE_REQUEST_TYPES` in the same change that adds it to the request
   union, so parse → typed rejection is never skipped.
2. The client never constructs the request by hand from a partially-applied shape: one method, one
   literal request object (§5).
3. `columns` reuses `EngineProfileColumn`; `numeric`/`categorical` presence rules stay exactly
   `iff kind === 'numeric' | 'categorical'` (F2) — the effective view does not change the classifier
   contract.
4. No new SQL dialect, no new dependency, no DuckDB-WASM fork: composition is `composeSourceSql`
   (F7).

## 5. Item 2 — Client shape (PROPOSED for approval)

### 5.1 The surface

```ts
// unchanged, byte-identical bytes on the wire, no new parameter
profile(handle: EngineTableHandle): Promise<EngineDatasetProfile>

// new, explicit at every call site
overlayProfile(handle: EngineTableHandle, overlay: EngineOverlay): Promise<EngineDatasetProfile>
```

**Why a second method rather than `profile(handle, overlay?)`.** An optional parameter puts the two
contracts one keystroke apart on the single entry point every caller already has, and it makes
"accidentally forgot to pass the overlay" and "deliberately base" indistinguishable at the call site
— the exact ambiguity the mutation drill is designed to catch. A distinct name makes the choice
visible in review (`overlayProfile(...)` reads as a claim), and makes the drill ("pass the overlay
unconditionally") a compile error instead of a silent behaviour change.

Signature note: `overlayProfile` returns the **same** `EngineDatasetProfile` type. The view stamp of
§4.2 lives on the wire, not in the client's return type; the panel's state carries it (§5.2). This
keeps `ProfileData` (an alias of the engine's exported profile type, `profile-state.ts:25`) from
becoming a union that every consumer would have to narrow.

### 5.2 The state shape

- **One** run at a time, one result in state, one `ProfileState` machine
  (`profile-state.ts:31-56`) — extended so that a `done` state carries the view it describes
  (`{kind:'done', profile, view: {kind:'base'} | {kind:'effective', stagedCount: n}}`), not a second
  machine and not a parallel profile in App state.
- The panel's single-flight/generation guard (`RunGuard` + `runGuarded`, F15) is the mechanism that
  makes "never both at once" structural: a superseded run's result is discarded, not merged.
- `stagedCount` stays a prop; it stops being the _source_ of the note's truth and becomes an input to
  the run's stamp and to the replacement labeling (§7.3).

### 5.3 What the client must never become

| Forbidden                                                                 | Why it is stated explicitly                                                                                                        |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| A silent base fallback on refusal/error/protocol surprise                 | The profile would then describe the file while the user believes it describes the edited view. A refusal is shown, never bypassed. |
| A catch-and-retry without the overlay, or a "try effective then base"     | Same defect, disguised as resilience.                                                                                              |
| Two profile results rendered at once (e.g. base + effective side by side) | The brief forbids it; a user cannot tell which number belongs to which view when both are on screen.                               |
| A second, parallel profile contract in App state                          | One state machine, one result; anything else is the duplication R-16 vetoes.                                                       |
| Auto-recompute on staging, or a re-run control labelled for edits         | Already pinned against (F12, F15); the abandoned-op-with-no-interrupt semantics also make it costly.                               |
| Telemetry carrying the view, the op count or anything else new            | ADR 0025/0037: `profile_run` keeps its three buckets and nothing else (F14).                                                       |
| Any change to `useDiffSession.ts`'s call                                  | It stays base (`profile(phase.handle)`); the diff's base side is B3's contract, not R-7's.                                         |

## 6. Item 3 — Domain / `DataEngine` target scope: ESCALATED, NOT DECIDED

### 6.1 The question, precisely

**Can an overlay-aware profile be expressed as an addition entirely inside `@assay/engine-duckdb`
(its typed client protocol plus the web client), or does it necessarily widen the public
`DataEngine` target in `@assay/engine` — and with it either a new package dependency edge or a
re-declared structural mirror — such that an architect ruling is required first?**

This is a boundary question, not a design preference, and it is **not** answered here.

### 6.2 What the contract itself needs from any branch

Only this: a request that carries `{base metadata, ops}`, a scan over the composed effective
relation, and a result whose leaf types are unchanged. Nothing in §4/§5/§7/§8 requires a new
**domain** value type — `OverlayBase`, `EditOp`, `OverlayState` and `CellValue` all already exist in
`@assay/domain` and are already what `EngineOverlay` carries (F6). The escalation is therefore about
_interfaces and dependency edges_, not about inventing domain vocabulary.

### 6.3 Branch A — pure `engine-duckdb` addition (keeps the candidate in-repo)

The request type, the client method, the worker compose path and the client-side validation all live
in `@assay/engine-duckdb`, which already depends on `@assay/domain` (`overlay-query.ts` imports
`OverlayBase`, `EditOp`, `OverlayState` today). `packages/engine` is untouched; its compatibility
pins are untouched (no profile _type_ changes; `EngineProfileColumn` stays mutually assignable —
`engine-target-compat.test.ts:70-80`).

- **What this implies.** A `minor` change to `@assay/engine-duckdb` (new op) plus a web change; the
  conformance proof lives where the B3 precedent already lives
  (`profile-comparison.engine.test.ts`, CLI-backed, skipping without `DUCKDB`), so **no
  `packages/testing` surface change** is strictly required. The `DataEngine` target keeps describing
  a profile of a table handle, i.e. the target stays _narrower_ than the real engine — which is
  already true today for every overlay op (the target has no overlay surface at all).
- **What it does not imply.** It does not make the effective-view profile part of the portable engine
  contract: a future `engine-parquet` (a scaffold today) or the CLI's Node seam would not be
  expected to provide one, and the conformance suite would not assert one.

### 6.4 Branch B — the target widens (a package-boundary change)

If the ruling is that an overlay-aware profile belongs on `DataEngine`, then `packages/engine` must
name an overlay type, and it currently has **no dependency on `@assay/domain` at all** — its only
`devDependencies` are `@assay/data-sources` and `typescript`. Two sub-branches, both real:

- **B1 — `@assay/engine` depends on `@assay/domain`.** `DataEngine.profile` gains an optional overlay
  parameter or a sibling `overlayProfile`. This adds a workspace dependency edge that does not exist
  today and must be checked against the dependency rules in `AGENTS.md` /
  [repo structure](../../engineering/03-repository-structure.md) §2: the documented chain is
  `apps → ui/core → domain`, and `packages/engine` is not in it, so the edge is a new one, not an
  obvious continuation.
- **B2 — `@assay/engine` re-declares a structural overlay mirror.** No new edge, but the mirror must
  stay assignable in both directions under `engine-target-compat.test.ts`, which turns a comment into
  a compile-time obligation: the same posture `@assay/testing` already takes ("the suite never
  imports `@assay/domain`", `engine-conformance.ts:259-263`). The cost is drift: two definitions of
  the overlay wire shape, pinned but not shared.

**What B implies.** Every `DataEngine` implementor (the real
`engine-duckdb` client, `engine-parquet`'s scaffold, `@assay/testing`'s conformance subjects) gains
an obligation, the compatibility pins grow, and the change stops being an engine-internal protocol
addition — it needs a changeset on the target package and an ADR-sized record (D13 is about exactly
this target's fate).

### 6.5 What would settle it

1. **An architect ruling on the D13 question this touches**: may `@assay/engine` name a domain
   overlay type (B1), must it mirror (B2), or is the target out of scope for overlay-bearing ops at
   all (A)? The facts above (no domain dependency today; pins are type-level only; every existing
   overlay op lives outside the target) are the evidence a ruling would be made against.
2. **A decision on conformance reach**: if an effective-view profile must be asserted for _any_
   engine implementation — i.e. a new scenario in `engineConformanceScenarioNames` and a subject
   method in `packages/testing` — then the surface has already left `engine-duckdb` and Branch A's
   "no conformance surface change" claim is false. If only the real engine must be proven (the B3
   precedent), A holds. This is answerable by the architect in one sentence and is the cheapest
   falsifier available.
3. **A statement of intent for `engine-parquet`**: an effective-view profile is meaningless without
   an overlay-capable engine; if the scaffold is never expected to carry one, constraining the target
   buys nothing today.

**Not decided here.** No branch is selected; no file in `packages/domain`, `packages/engine` or
`packages/testing` is reserved by this document.

## 7. Item 4 — The consistency rule (PROPOSED for approval)

### 7.1 The invariant, stated once

**A profile number belongs to exactly one view, the panel names that view, and no other number is
ever displayed next to it as if it belonged to the same view.**

Four numbered invariants make it testable:

- **I-1 (one view per result).** Every `done` state carries the view it was computed from: `base`
  when the run sent no overlay, `effective` when it sent one. A result never mixes statistics from
  two views, and no column of a result may be sourced from a different relation than its siblings.
- **I-2 (no substitution).** If the effective run refuses or fails, the panel shows a readable error
  state and **no numbers**. It never displays base numbers, never displays a stale effective result
  as if the new attempt had succeeded, and never re-issues the request without the overlay.
- **I-3 (one contract on screen).** At most one labeling contract is rendered. The label is derived
  from the _result's own stamp_ (I-1), never from live history state — so a staged change made after
  the run cannot relabel numbers that describe the earlier view.
- **I-4 (label follows the stamp, count follows the stage).** The label names the view; when that view
  is `effective` it also states the number of staged changes the run included. It never claims
  freshness, staleness, or a re-run affordance (F12, F15).

### 7.2 Which view a run describes, and how it is chosen

**Rule:** the run sends `overlayProfile(handle, overlay)` when `stagedCount > 0`, and
`profile(handle)` when `stagedCount === 0`. The decision is made **once, at run time**, from the
history at that moment, and is frozen into the result's stamp.

Why not always send the overlay (with an empty op list when nothing is staged)? Because that would
put the base case through the overlay composer: `composeSourceSql` without live inserts is not
byte-identical to `SELECT … FROM <view>` for every op class, and the compatibility floor of §4.1
plus the mutation drill ("pass the overlay unconditionally — the base-compatibility pin must fail")
both assume the base path stays the base op. The empty-overlay equivalence is a conformance matrix
row (§9), not a justification for routing base traffic through it.

### 7.3 How the UI states it

- **Two labels retire, one labeling contract arrives.** `STANDING_HINT` and `stagedChangesNote`
  (`ProfilePanel.tsx:122-130`) are replaced by a single run-stamped labeling element rendered in
  every expanded state — the same state-independence the standing hint has today, so the honesty
  surface does not become state-dependent.
- **The base case keeps the base sentence's meaning.** When the run's stamp is `base`, the label says
  the statistics describe the file as opened; the second sentence ("staged changes are not
  included") remains true only in that case, and may be kept for it.
- **The effective case names the view and the count**, in the singular/plural grammar the current
  note already demonstrates, and states that the grid's edited view is what these numbers describe —
  the sentence today's note gets backwards ("not reflected here") becomes the true one.
- **Copy is not approved here.** Exact strings are reserved (§7.6) and need a maintainer decision
  before the runtime row; the brief's rule is byte-exact pins, which cannot be written against
  wording this document invents.
- **Test-id continuity.** The e2e suites read `profile-standing-hint`, `profile-staged-note` and
  `profile-table-id`; the replacement must keep the idle `profile-table-id` element (F10, pinned in
  two suites) and must either keep the old test ids for the new element or rename them **with** all
  six pinning files updated in the same change (§3.1 item 1).

### 7.4 Boundaries

| Boundary                                                                      | What happens                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No staged ops** (`stagedCount === 0`)                                       | The base op runs; the label describes the file as opened. The effective path is unreachable, so no view question can arise.                                                                                                                                                                                                                                          |
| **Staged ops ≤ 500 live inserts**                                             | The effective op runs over the composed relation; the label names the edited view and the staged count.                                                                                                                                                                                                                                                              |
| **Staged ops beyond the live-insert cap** (`> 500` branches, F8)              | The request is **refused** before any SQL, with the typed value-free refusal. The panel shows a readable, retryable error (`profile-state.ts` failed → retryable, never terminal) and **no numbers**. It does not fall back to base, and it does not silently drop the overlay. The cap and remedy reach the user; the shipped string is not reworded (§3.1 item 4). |
| **A staged op lands after the run**                                           | The result keeps its stamp (I-1, I-4); no new request is issued (F12); the label still names the view the numbers describe. Nothing claims the numbers are current, and nothing says "stale".                                                                                                                                                                        |
| **Undo/redo returns the history to a different state**                        | Not a session change: the result keeps its stamp. Only the _next_ run re-decides the view.                                                                                                                                                                                                                                                                           |
| **A superseded dataset session** (new file opened; `ready → opening → ready`) | The existing three-layer guard destroys the result with the component (F15); the stamp dies with it. A late effective result must never land on a new handle — that is the `RunGuard` generation token's job, unchanged and not re-implemented here.                                                                                                                 |
| **Abandoned in-flight run**                                                   | Still occupies the engine FIFO until it completes (no op interrupt exists — ADR 0052 covers queries only). The UI-level abandonment semantics are unchanged; the contract adds no cancel path.                                                                                                                                                                       |

### 7.5 The pins that must exist when this lands

1. **Copy replacement** — the old base-only hint and staged note cannot reappear alongside the new
   labeling. Today's six literals (§3.1 item 1) must be replaced, not extended, and a pin must fail
   if both contracts render at once (the brief's "replaced, not doubled").
2. **No-substitution pin** — a refused/erroring effective run renders an error and no
   `profile-rowcount`/statistics elements; the profile mock must record **one** call, with `overlay`,
   and no second call without it.
3. **Base-compatibility pin** — a caller with no staged ops sends the base request and the panel's
   output is unchanged (byte-for-byte on the wire, and the existing unit/e2e expectations unchanged).
4. **Stamp pin** — after a run and a subsequent staged edit, the label still names the run's view and
   the staged count of that run, and `h.profile`/`h.overlayProfile` call counts stay unchanged.
5. **Cap pin** — a >500-live-insert overlay renders the readable refusal and no statistics; and the
   shipped `OverlayLiveInsertLimitError` string is asserted byte-identically to prove it was not
   reworded.

### 7.6 Reserved copy slots (NOT approved; named so approval has a target)

| Slot                           | Must convey                                                                  | Must not contain                                                        |
| ------------------------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Base label                     | statistics describe the file as opened                                       | "stale", "re-run", a claim about the edited view's numbers              |
| Effective label                | statistics describe the edited view; N staged change(s) included in this run | "not reflected here", "differs", a freshness claim, a re-run affordance |
| Cap refusal (profile)          | the 500 live-insert cap and the export-and-reopen remedy                     | any table name, row count, cell value, or SQL text (ADR 0025)           |
| Zero-row / empty-column labels | unchanged from today's surface                                               | anything view-related                                                   |

## 8. Item 5 — UI / top-k re-decision (PROPOSED for approval)

### 8.1 What is decided

**The click keeps its user-visible semantics.** Clicking a top-k value filters that column to that
value; clicking the null count filters the column to NULL. The clicked column is the column the
number was computed from. No new control, no new affordance, no change to what a click means.

**The mapping rule changes, because its reason disappears.** Today it exists to bridge a
base-derived number to an effective column: `resolveProfileColumn` walks the active rename chain from
the base name (`edit/session.ts:72-90`) and `planProfileFilter` refuses when the answer is not
`resolved` (`filter-action.ts:71-…`). When the statistics describe the effective view, the profiled
column name **is** an effective name, so no bridge is walked:

| Case today (base-derived)                                    | Case under an effective-view profile                                                                                                                                                                                                                                   |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolved` — base name present in the effective schema       | Unconditional: the name came from the effective view, so it is used directly.                                                                                                                                                                                          |
| `renamed` — base name follows a rename chain                 | **Unreachable.** A rename chain starting from a name that is already effective cannot produce `renamed`; renames no longer refuse. `renamedColumnRefusal` (`filter-action.ts:39-41`) becomes dead code and must be **deleted with its pins**, not left as unreachable. |
| `unresolved` — name absent from the effective schema         | **Survives**, with a new cause: the history changed after the run (undo of the rename, a later rename, a future column-drop), so the stamped name is no longer in the current effective schema. The refusal stays value-free and names no value.                       |
| Builder rejection — the value does not bind to the cast type | **Survives unchanged**, returned verbatim in the refusal slot.                                                                                                                                                                                                         |

**The value's type binding is already correct and does not change**: `compileFilterInput` runs
against the **effective** column's type today (`filter-action.ts:8-13`), which is exactly right once
the value itself came from the effective view.

### 8.2 What would have to be re-decided if the profile described a different view

If the approved contract ever allows a run to describe a view other than the one the grid is showing
(a base run while the grid shows edits — today's state), the resolve-then-compile rule must stay
exactly as delivered, `renamed` must stay reachable with its byte-exact copy, and the two contracts
would coexist in one panel — which §7.3 forbids. That is a different contract, and it is the one
currently shipped. It is not a fallback this document permits.

### 8.3 Pins that change (and one that must not)

- Retire: the `renamed` case in `filter-action.test.ts`, its assertions in
  `ProfilePanel.filter.test.tsx` / `App.profile-filter.test.tsx`, and the renamed-refusal e2e leg in
  `tests/e2e/profile-filter.spec.ts` — **all in the same change that deletes the copy**, so no
  unreachable branch lingers.
- Add: an "effective-stamped name no longer in the schema → unresolved refusal" case, and a
  "click after a run with edits → filter binds to the same column the statistic came from" case.
- Keep: `PROFILE_TOP_K = 10`, the tie-break order (count desc, value asc), the single-line
  `role="status"` refusal slot, the `filterError`/`filterRecovery` parity, and every
  `profile-filter` e2e assertion that is not about renames.

## 9. The conformance matrix an approval would need to cover

Derived from the pinned DuckDB CLI (ADR 0038), extending the B3 precedent. One row per op class,
each asserting **effective stats equal the same aggregates over the composed relation** (the strong
form), never merely "both runs succeeded":

| Row | Overlay staged                                            | Claim                                                                                                              |
| --- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1   | none (base op)                                            | Bytes and values unchanged from today — the compatibility floor.                                                   |
| 2   | one `cell-set` on a numeric column                        | min/max/mean/stddev/quantiles move; `rowCount` unchanged; null/distinct per the new value.                         |
| 3   | one `cell-set` on a categorical column                    | top-k reorders and its tie-break stays count desc, value asc.                                                      |
| 4   | `row-insert` (one live branch)                            | `rowCount` +1; inserted values included; `assay_key` ordering does not leak into aggregates.                       |
| 5   | `row-delete` (tombstone)                                  | `rowCount` −1; the tombstoned row's values absent from every statistic and from top-k.                             |
| 6   | `row-restore`                                             | Back to row 1's numbers exactly (round trip, not "close").                                                         |
| 7   | `column-rename`                                           | Column name is the effective name; its statistics are unchanged by the rename.                                     |
| 8   | `column-cast`                                             | Values are the cast values (e.g. text `"10"` → numeric 10 in min/mean); classification follows the effective type. |
| 9   | cast-then-revert / delete-then-restore (net-zero history) | Numbers equal the base numbers while the label still reports N staged entries (F11's honesty distinction).         |
| 10  | 500 live inserts (at the cap)                             | Composes and answers; no refusal.                                                                                  |
| 11  | 501 live inserts (one past the cap)                       | Refuses before any SQL, value-free, with the cap and remedy; **no** base numbers produced.                         |
| 12  | a `column-repair` layer + an effective profile            | Statistics describe the repaired values, or the repair's own typed refusal is delivered unchanged.                 |
| 13  | hostile effective column type                             | Refused client-side (`requireValidOverlayTypes`) and worker-side; no request dropped silently.                     |

Each row needs a golden fixture only where the shape is new (rows 4–6 and 8 are the candidates); the
rest can reuse `profile-comparison.engine.test.ts`'s purpose-built dataset (numeric with a NULL, a
categorical, a nulls-only column, a tie). Fixtures regenerate through the pinned-CLI script, never by
hand.

## 10. Open questions for the maintainer / architect

1. **§6 item 3** — may `@assay/engine` name a domain overlay type, must it mirror one structurally,
   or does the target stay out of overlay-bearing ops entirely? _Answered by an architect ruling; the
   cheapest falsifier is question 2._
2. **Conformance reach** — must an effective-view profile be asserted for any engine implementation
   (a new `engineConformanceScenarioNames` entry in `packages/testing`), or only for the real engine
   in `engine-duckdb`? _Answered by an architect sentence; it decides whether Branch A's "no
   conformance surface" claim survives._
3. **Proposal P1 vs P2** (§4.2/§4.3) — is a distinct `engine/overlay-profile` + `…-result` pair
   approved over an optional `overlay?` field on `engine/profile`? _Answered by maintainer approval or
   amendment of §4._
4. **Cap refusal wording for a profile scan** — the shipped string says "in one window", which is
   window-class; is a profile-specific value-free variant approved (leaving the shipped string
   byte-identical), or should the profile surface reuse the window wording verbatim? _Answered by a
   maintainer copy decision plus a byte-exact pin._
5. **Labeling copy** (§7.6) — the base and effective label strings, and the test-id continuity choice.
   _Answered by approved byte-exact copy._
6. **Retiring `renamedColumnRefusal`** (§8.1) — is deleting that reachable-today string, and its four
   pinning files, acceptable as part of the same dispatch? _Answered by maintainer approval of §8,
   since it removes shipped copy rather than adding it._
7. **`useDiffSession.ts`'s base profile** — confirmed out of scope here; does the diff's base side
   ever need to follow the overlay, and if so under which contract? _Answered by a maintainer
   statement that the diff surface is B3's, or by a new row._
8. **Zero-op routing** (§7.2) — is "base op when nothing is staged" approved, or must every run go
   through the overlay op (requiring the empty-overlay equivalence to become a conformance claim)?
   _Answered by approving §7.2 or by adding matrix row 1a._
9. **Does the approved contract accept D-09 = B**, i.e. does "it changes what a number means" get the
   consistency contract it asked for by this document? _Answered by the maintainer's D-09 decision —
   nothing here pre-empts it._
10. **Telemetry** — confirm that no `profile_run` field may be added (not even a view enum) without a
    separate disclosure decision. _Answered by restating ADR 0025/0037, or by a separate telemetry
    decision record; this document assumes "no change"._

## 11. What this document does not authorise

- **No implementation.** No file under `apps/`, `packages/`, `tests/` or `fixtures/` may change on
  the strength of this document.
- **No protocol change** — no request type, no response type, no parser branch, no lane change.
- **No domain change** — `packages/domain` is untouched; no new domain type is even proposed (§6.2).
- **No `DataEngine` target change** — `packages/engine` is untouched, its pins untouched, D13 not
  decided (§6).
- **No engine source change** — including `overlay-query.ts`, `profile-query.ts`,
  `engine-executor.ts` and their tests.
- **No worker may claim R-7** — the row is not reserved, not dispatched and not claimable; the
  [charter](20261030-overlay-profile-candidate.md)'s prohibition stands verbatim.
- **No change to the R-16 honesty copy** — it ships as delivered until the effective path exists, and
  the replacement must ship with it, never before (§2, §7.5).
- **No telemetry change** — no new field, no new event, no view dimension (ADR 0025/0037).
- **No reopening of D-09** — the maintainer's 2026-11-21 decision (D-09 = A: "it changes what a
  number means; needs an engine/client/state consistency contract first") is the gate this document
  is written _for_, not a decision it makes.
- **No usability claim** (D-02 A / RD-T07): nothing here is "validated", "intuitive" or "easier".

## 12. Approval gate and what a runtime dispatch would then need

**Gate 1 (this document).** A maintainer decision on items 1, 2, 4, 5 and the copy slots of §7.6,
plus the D-09 disposition (Q9). **Gate 2 (item 3).** An architect ruling on §6.5, which fixes the
reserved footprint: Branch A stays inside `engine-duckdb` + web; Branch B adds `packages/engine`
and possibly `packages/testing` and needs its own record.

**Only after both**, a dispatch would (in the brief's order) add the overlay-bearing request and its
response semantics with the opt-in default-off rule; compose the effective relation through
`composeSourceSql` for the aggregate and each top-k scan while keeping the cap and its copy; pin
conformance per §9 from the pinned CLI; replace the R-16 labels with the run-stamped labeling and the
"old copy cannot reappear" pin; and apply §8's mapping rule with the retired refusal deleted rather
than left unreachable. Gates and evidence are the brief §R-7's: targeted unit + real-CLI agreement
suites with `DUCKDB` set, the web profile suites, `tests/e2e/engine-profile.spec.ts` and
`tests/e2e/profile-honesty.spec.ts`, then the full local suite; changesets on whichever packages
Gate 2 reserves; the ledger entry with the map §5 fields; and the mutation drill (pass the overlay
unconditionally → the base-compatibility pin must fail; restore byte-identically).

Until both gates exist, this contract is the only artefact, and it authorises nothing.
