# ADR 0050: Undo of a column repair is an exact refold at the history cursor

## Status

Accepted

## Date

Proposed 2026-11-15 → Accepted 2026-11-16

## Deciders

- Maintainer (product/domain owner; acceptance instruction "accept both ADRs", 2026-11-16, recorded in
  the [post-R1 acceptance record](../process/handoff/20261114-post-r1-decisions-accepted.md))

## Context

The [EW-04D bulk-repair contract](../process/handoff/20261113-ew04-bulk-contract.md) recommends one new
closed-union op, `{ kind: 'column-repair', column, trim?, mapping }` (§4.2, D11), whose effect is a value
function over a whole column — `trim∘map`, applied per §6.2. Its §6.1 records **D14** as the one open
decision that follows from the op's _shape_ rather than its SQL: the current inverse discipline has no
inverse for it. The contract names the required amendment — "repair entries carry an empty inverse +
`AppliedNote: 'undo-by-refold'`, exactness pinned by P1; ADR required before any runtime row" — and the
[post-R1 decision sheet](../process/handoff/20261114-post-r1-decision-sheet.md) §4.4 sets the deliverable:
a **Proposed ADR** before any runtime row, with the property test as a row deliverable. This is that ADR.

**What the current model already does** (read-only, at `947267b`; the contract cites `history.ts:43–48`,
the interface has since moved to `:56–60`):

1. **Every applied op derives its own inverse.** `stepOverlay` returns `OpApplication.inverse` — the ops
   that undo the op _against the state it was applied to_ (`packages/domain/src/overlay.ts`, module doc
   "Inverse derivation"). `appendOp` stores it on the entry (`history.ts:56–60`, `:95–130`), and the
   existing tests pin the two directions: `inverse.length === 0` exactly when the outcome is not
   `applied` (`history.test.ts:112–123`, and the walk invariant at `:269–271`), and inverse walks restore
   the base projection (`overlay.test.ts:660`, the `fold ∘ unfold` property).
2. **Undo/redo are pure cursor moves.** `undo`/`redo` move `cursor` and hand back the boundary entry
   (`history.ts:134–152`); the caller decides what to do with it. `stateAtCursor` is exactly
   `foldOverlay(base, entries[0..cursor))` (`:155–160`), and the fold is a pure function of
   (base, prefix) — the `overlay.ts` module doc states it as the module's contract.
3. **The shipped web path never reads `entry.inverse`.** `handleUndo`/`handleRedo`
   (`apps/web/src/sessions/useEditingSession.ts:550–567`) commit the **moved history**;
   `activateHistory` publishes `overlaySnapshot(base, next)` (`:282–294`), which is
   `activeOps(history)` — the raw active prefix, handed to the engine as a pass-through
   (`apps/web/src/edit/session.ts:33–36`) for a stateless refold per request. A grep of the shipped
   TypeScript sources (`apps/**/*.ts{,x}` and `packages/engine-duckdb/src`) for `.inverse` returns **no
   consumer** (the only hits are generated `apps/vscode/dist` bundles): undo already _is_ refold on the
   only consumer that exists. Inverses are derived, tested and never materialized.
4. **`AppliedNote` is a note about a degraded-but-applied outcome**, currently with exactly one member,
   `'position-anchor-not-live'` (`overlay.ts:152`, produced at `:386–391` for an insert whose anchor is
   not live). It is the model's existing place to record "this applied op needs a caveat".

**Why D14 is a real decision and not a formality.** No member of the `EditOp` union expresses
"un-map and un-trim" (`edit-ops.ts:114–147`), and a repair's exact inverse is not a fixed op: it is
per-row, depends on the suffix (§6.2 masking), and would have to enumerate every affected row — the
thing the representation exists to avoid. Without a decision, either the entry must break the
`applied ⇒ inverse` invariant silently, or the op cannot be undone at all. Those are the only two
honest readings of the current code, so the amendment is recorded rather than assumed.

**The §6.2 semantics are cited, not re-decided.** EW-04D §6.2 already expresses a repair as a property
of the **prefix**: `final = r_m(…r_1(u))…`, where repair _k_ is included iff the row is live at `p_k`
and no applied `cell-set`/`cell-revert` on the repair column sits at a position `> p_k`, with the
forward-order induction and its probe evidence (P8 rev 4: 27 258 live-cell checks, 0 failures over
8 006 seeded cases; controls at 893 / 530 / 2 939 failures; scope limits stated). A prefix-defined
effect is exactly what a refold reproduces; an inverse op list would be a **second implementation** of
a rule the composer is already required to implement. This ADR takes §6.2 as given and decides only
_how undo represents a repair_.

**Evidence limits.** Nothing in this ADR is implemented. No probe, build or test was run to write it;
every source fact above is a read-only observation at `947267b`, and P1 is a _row deliverable_, not
existing evidence. The §6.2 equivalence claim keeps its own boundary (U5 — the P8 model is not the
composer code) and this ADR inherits it rather than extending it.

## Decision

1. **The amendment.** A `column-repair` history entry carries an **empty inverse** — `inverse: []` — and
   its `applied` outcome carries `AppliedNote: 'undo-by-refold'`, a second member of the `AppliedNote`
   union. The note is the durable marker that this entry's undo is _not_ expressible as an inverse op
   list and is performed by refolding. It is additive and typed: no field is removed from
   `HistoryEntry`, `OpOutcome` or `OpApplication`.
2. **Undo/redo of a repair entry is exact refold at the cursor.** Undo and redo stay pure cursor moves
   (unchanged signatures in `history.ts:134–152`); the engine statelessly re-folds the active prefix
   for the request; no inverse SQL is composed, stored, cached or sent for a repair. Concretely: the
   moved history is what `activateHistory` publishes (`useEditingSession.ts:282–294`), and that path is
   already the only one. No `column-repair` inverse primitive is introduced anywhere.
3. **Why this is exact, and the boundary of that claim.** Exactness rests on three statements, each of
   which is checkable in code:
   - `stateAtCursor` is invariant under cursor moves, because the fold is a pure function of
     (base, prefix) and a cursor move selects a different prefix — nothing else (`history.ts:155–160`).
     This is already pinned: `stateAtCursor ≡ foldOverlay(active prefix)` after every append and every
     cursor move (`history.test.ts:160–179` at `:247–292`), undo-all returns to the initial state and
     redo-all to the final state (`:294–318`), and undo visits the active prefix in exact reverse
     (`:320`).
   - The empty inverse is **sound** under that invariant: the only reason a repair needs no inverse is
     that the prefix no longer contains it after an undo, so the refolded state is the state before it.
     The existing walk invariant asserts the _converse_ direction (`applied ⇒ inverse` non-empty,
     `history.test.ts:269–271`); the amendment makes this entry the recorded exception, so **P1 must
     narrow that assertion** rather than quietly break it: `inverse.length > 0 ⇒ applied`, and
     `inverse.length === 0 && applied ⇒` the outcome's notes include `'undo-by-refold'`.
   - **P1 (prefix replay)** is the proof obligation: the existing refold property tests are extended to
     repair ops — a `column-repair` arm in the shared generator (`genOp`,
     `packages/domain/src/property-testing.ts:135`) so the history walks and the
     `fold ∘ unfold` property exercise repairs, plus the two assertions above. Because `genOp` derives
     its op from a fixed roll range, adding an arm changes what existing seeds generate; the properties
     assert invariants, not goldens, so that is a corpus change, not a regression.
   - **Boundary.** The proof of this decision is that property test over the real domain fold. It is
     **not** a claim that arbitrary future op kinds are refoldable, not a claim about the composer's
     emitted SQL, and not an algebraic proof beyond §6.2's three stated assumptions (absolute value-ops,
     logged no-ops are not maskers, conflicts are never logged).
4. **What stays out.** This decision does **not**:
   - add a materialized-inverse primitive, inverse registry, or per-op inverse SQL anywhere;
   - add a protocol op, request/response shape, worker message or wire field (undo/redo crosses no
     boundary: it is a history cursor move plus a normal refold request);
   - change row identity ([ADR 0011](0011-dataset-identity-and-versioning.md)) or overlay semantics
     ([ADR 0012](0012-edit-overlay-and-transaction-semantics.md)) — the repair is still an op in the same
     append-only log over an immutable base;
   - re-decide the §6.2 composition rule, the D1/D3/D5 trim and equality rules, D9 staleness, D15's
     exception cap, D16/D17's composition shapes, or §6.3's no-op/dirty treatment;
   - touch the engine's retention accounting ([ADR 0047](0047-web-session-replacement-retains-retired-tables.md)):
     undo materializes nothing, so it registers no table and retains nothing new.
5. **Consequences for the op's surface.** A repair is **one history entry and one undo step** — an
   applied repair is undone by one `undo`, exactly like a `cell-set`, with the value effect disappearing
   because the entry left the active prefix. **Branching is unchanged**: appending after an undo
   truncates the redo tail (`history.ts` appendOp + its ruling test), and a truncated repair is dropped
   like any other entry — no special case, because no inverse was ever held. And a **future op whose
   effect is not a function of the prefix would need its own decision**: this ADR licenses exactly one
   refoldable op kind and names the note that marks it, so the absence of that note stays a meaningful
   signal rather than a default.

## Consequences

### Positive

- Undo of a repair is correct by the same mechanism that already makes undo of everything else correct,
  and the mechanism is already the shipped one — no new runtime concept, no second source of truth for
  what a prefix means.
- The amendment is **visible in types and tests**, not a comment: `AppliedNote` grows a member and the
  walk invariant is narrowed deliberately, so a later reader cannot mistake it for a bug.
- The op stays one entry and one undo step, which is what the contract's `History` row (§4.2) assumed.
- Nothing is added to the wire, so the repair op's undo/redo cost is exactly the cost of a refold —
  the request shape is a normal overlay request, not a repair-specific one.
- The decision is bounded: it says what the note means and what would need a new ADR, so a future "this
  op needs a real inverse" case has an obvious home instead of an ad-hoc exception.

### Negative / risks

- **The `applied ⇒ inverse` invariant is weakened by one recorded case.** Anyone reading
  `HistoryEntry.inverse` expecting "empty means nothing happened" must now also read `outcome.notes`.
  The mitigation is that P1's narrowed assertion is the only code that may assume either direction.
- **The marker is descriptive, not enforcing.** Nothing stops a future applied op from claiming
  `'undo-by-refold'` without being refoldable; a wrong note would pass the narrowed assertion. Only
  review and the op's own fold rule keep that honest (the same class of risk as any typed status).
- **P1 is not yet written.** This ADR's exactness is a property obligation across a generator, an
  assertion and a walk; until the property tests carry a `column-repair` arm, the claim rests on the
  model's existing purity, not on evidence about the op.
- **The op does not exist.** Nothing here can run: `EditOp` has no `column-repair` member, so the
  amendment is a design commitment that a runtime row must implement in domain, composer and wire
  together — and D14 does not close any of the other six EW-04D conditions.
- **§6.2's own boundary is inherited.** Refold-undo is exact for the semantics §6.2 defines; if the
  composer's implementation of that rule is wrong (U5 open), undo will faithfully reproduce the wrong
  state. This ADR cannot detect that class of failure and does not claim to.

### Neutral

- `HistoryEntry`, `OpOutcome`, `undo`, `redo`, `appendOp` and `stateAtCursor` keep their shapes except
  for the added note member; `packages/domain` remains pure (no engine import, no I/O).
- No dependency, bundle, engine, extension-platform, protocol or lockfile change; no telemetry event,
  field or counter (ADR [0025](0025-telemetry-and-data-privacy-boundary.md)/[0037](0037-telemetry-opt-out-consent.md)).
- No change to no-op entries (`inverse: []`, not applied, no note) or to the "conflicted ops never
  enter the log" rule — both stay exactly as they are.
- The commit boundary is untouched: undo of a repair still goes through the existing
  `commitWithRollback` path (§5, D12/D13), so a failed refold keeps today's rollback and `Retry`.

## Acceptance resolutions (2026-11-16)

The maintainer accepted this ADR and the recommended resolution of every question below; these are now
ADR decisions rather than open asks (the original questions remain in git history).

1. **Note placement.** `AppliedNote: 'undo-by-refold'` lives on the `applied` outcome, where the model
   already records caveats; `HistoryEntry` keeps `inverse: []` and gains no `undoMode` field.
2. **Assertion shape.** Narrow the walk invariant with an **explicit per-kind table** — every `EditOp`
   kind declares refoldable-or-inverse, so a new kind cannot skip the declaration. P1 adds the
   `column-repair` arm and the narrowed assertion.
3. **Other ops.** Only prefix-function ops may join the note; any other op needs its own ADR/decision.
4. **Dataset replacement.** Session reset drops the history as today; no repair-specific anchor-staleness
   wording is added. P1 covers cursor moves within a session.

## Known implementation boundary (2026-11-17)

The U5 slice's implementation surfaced one boundary this decision does not remove: per-row repair masking
is a function of the **prefix**, not of a local transition, so an inverse-materializing walk over a
same-column value-op under a repair prefix can retain a stale mask. The shared `fold ∘ unfold` property
therefore skips exactly that class (same column, value-op kinds, repair prefix) and asserts at least one
applied repair in its corpus; the shipped undo path never materializes inverses, and refold is the undo
authority (decision 2). This is a property of the semantics, not a defect to fix by threading prefix
state into every inverse; a future op that needs materialized inverses over repair prefixes would need
its own decision.

## What this ADR does not decide

- **No implementation by this ADR.** It authorizes the **U5-first UI-free domain+engine slice** under
  its terms (op/fold/wire parser/P1 tests), not EW-04I, not any web UI, and not a protocol change.
- **No closure of the EW-04D verdict conditions.** Of (i)–(vii): (i) U4 is measured; (ii) D16 and (iii)
  D17 are probed and pinned; (iv) D15's x ≤ 500 cap is accepted; (v) D14 is this ADR; (vi) U1–U3 close
  inside EW-04I; (vii) U5 is the slice this ADR unblocks.
- **No evidence for the composer or the op.** P8's model, P1's property test and U5's implementation
  equivalence are three different claims; this ADR asserts only the middle one as its proof obligation
  and claims no measurement of its own.

## Alternatives considered

- **Materialize an inverse for the repair** (derive a per-row `cell-set`/`cell-revert` list, or a second
  `column-repair` that reverses the mapping and re-applies the trim). **Rejected:** it duplicates the
  repair as SQL — the inverse is not a fixed function (`r⁻¹` is undefined for a non-injective mapping,
  and "un-trim" cannot restore trimmed code points), so the honest form is a per-row value list, which
  is exactly the row-enumerating representation §4.2 exists to avoid. It also **multiplies arms**: any
  emitted inverse adds arms on top of `m + x + 1`, against the U4-measured export budget, and it would
  create a second, inverse-flavoured implementation of §6.2's masking rule that could disagree with the
  forward one. The web path does not read inverses at all, so the whole thing would be dead weight.
- **Keep the empty inverse + note as convention, with no ADR.** **Rejected:** it is a **durable model
  decision** that amends an invariant the property tests enforce
  (`history.test.ts:269–271`) and adds a member to a closed union. Leaving it as a convention means the
  next reader sees an applied entry with no inverse and must guess whether the model is broken; the
  §6.1/§4.4 requirement of an ADR before runtime exists precisely to prevent that. A decision with no
  record is not a decision.
- **Cursor-only undo that skips the repair's value effect** (leave the last refolded repair applied
  while the cursor moves past it). **Rejected:** it would not undo the value — the user would see a
  "undone" entry whose effect persists, and `stateAtCursor` would no longer equal the fold of the active
  prefix, breaking the one invariant every consumer relies on. It also cannot be reconciled with
  branching: a truncated repair that still applies is unfalsifiable state.
- **A dedicated inverse op kind (e.g. `column-repair-revert`) with its own wire and fold rule.**
  **Rejected:** a new kind needs its own step rule, wire parser, compose path and staleness rules to
  express "undo what a prefix-derived function did" — strictly more surface than a refold, and it
  re-introduces the arm-multiplication above. It is the materializable-inverse alternative under
  another name.
- **Reuse the blanket "no-op entry" treatment** (log the repair as a non-applied entry so the existing
  empty-inverse rule covers it). **Rejected:** a repair that changed values **is** applied — dirty
  (WF-06 §2), counted, previewed, published. Reclassifying it as a no-op to dodge the invariant would
  corrupt the dirty predicate, the history panel's wording and the zero-affected refusal (D8).
