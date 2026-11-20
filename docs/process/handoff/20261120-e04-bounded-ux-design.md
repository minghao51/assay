# E04 design — bounded intuitive-UX successor contract (options only)

**Date:** 2026-11-20. **Status:** `PROPOSED` — design deliverable for improvement-plan row E04 (Q7
selected design-only with **WF-O1 first**; no runtime change is authorized). Everything below is a
proposal set, **not usability evidence**; each child needs a separate maintainer selection before
any implementation. Companion design: [E01 opt-out cancellation](20261120-e01-optout-cancellation-design.md).

## 1. Authority, scope and preserved decisions

- Q7 (selected policy, [20261120-improvement-plan-execution.md](20261120-improvement-plan-execution.md)
  §2): "Design-only (E04): WF-O1 filter-draft clarity first; no runtime change." Plan row E04 and its
  acceptance paragraph: [implementation-plan.md](improvement-plan-20261120/implementation-plan.md) §5
  E04.
- WF-O1 and WF-O2 remain `BLOCKED` rows in the
  [web follow-up map](20261110-web-followup-map.md) §3; this document supplies their design material
  and stops. It is not dispatch authority and grants no file reservation.
- **Preserved, not reopened:** WF-03/04/07/08/09 and their decision rows (WFD-03/04/05/07); the
  approved WF-01 scalar temporal contract (WFD-06 = B, CLOSED `b6b773d`); the WF-05 v5
  replacement-safety contract ([record](20261110-wf05-replacement-contract.md)); ADR 0044's
  grid-centric layout; the existing Help/purposes/next-action copy (map §2, WFD-05). Nothing here is
  a CSS cleanup that smuggles those redesigns in.
- **Evidence limits (binding on every section):** no participant or AT study exists (the map's
  carried RD-T07 limitation); no screenshot or prototype in this document is evidence of usability;
  narrow-screen/zoom behavior of any proposal is **unverified**. Implementation requires separate
  selection with source/test owners and its own verification.

## 2. Audit first — what current copy already covers

The named states are **not** a blanket gap: most already carry deliberate, test-pinned copy. The
findings are two honesty items (download wording, double-failure consistency) plus one draft-clarity
gap (WF-O1). Audited surfaces (all anchors verified at this baseline):

| State                                | Current copy / behavior                                                                                                                                                                                                                                                   | Anchor                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Filter draft vs accepted             | one draft per column, seeded from the accepted list and re-seeded on every accepted-list change (programmatic included); a local draft wins the displayed/submitted value                                                                                                 | `apps/web/src/grid/FilterBar.tsx:199-214`, `295-297`, `344-355`                                |
| Filter invalid (compose)             | client-side rejection, one inline value-free line, no engine call                                                                                                                                                                                                         | `FilterBar.tsx:357-365`, `525-532` (`filter-builder-error`, `role="alert"`)                    |
| Filter cleared / empty               | empty input removes that column's filter on Apply; empty list renders "No active filters"                                                                                                                                                                                 | `apps/web/src/grid/query-state.ts:27-35`, `FilterBar.tsx:663-665`                              |
| Filter busy                          | all bar controls `disabled` while pending; host combines filter+sort epochs into `aria-busy` + footer "Filtering…"/"Sorting…"                                                                                                                                             | `FilterBar.tsx:506-587` (e.g. 519, 559, 573), `apps/web/src/grid/DataGrid.tsx:906-911`, `1553` |
| Filter failure (single)              | "The filter could not be applied: …. The previous filters are still in effect."                                                                                                                                                                                           | `apps/web/src/edit/session.ts:247-248`; shown at `FilterBar.tsx:668-670` (`role="alert"`)      |
| Filter failure (double)              | "The filter could not be applied and the previous filters could not be restored. Re-apply a filter or reopen the dataset if the grid looks wrong."                                                                                                                        | `FilterBar.tsx:326-330`; identical wording in `apps/web/src/App.tsx:1737-1739` (profile top-k) |
| Filter-to-failures (validation)      | "…The previous filters are back in effect." / double: "…Clear filters manually."                                                                                                                                                                                          | `apps/web/src/sessions/useValidationSession.ts:293-301`                                        |
| Keyboard (filters)                   | Enter submits from the compose value input and from every active-row predicate input                                                                                                                                                                                      | `FilterBar.tsx:510-512`, `564-566`                                                             |
| SQL run states                       | status text Ready/Running…/Done/Cancelled/Failed; error `role="alert"`                                                                                                                                                                                                    | `apps/web/src/sql/SqlPanel.tsx:279-289`, `347-351`                                             |
| SQL Cancel                           | "Cancelled. The engine has no query interrupt, so this query may still run to completion in the background (a following run queues behind it); its result is discarded and will not be shown."                                                                            | `SqlPanel.tsx:253-256`, `353-357`                                                              |
| Export success (FSA / download)      | "Exported N rows as X (size) to a new file." / "— your browser is downloading it as a new file." + "The opened file is unchanged."                                                                                                                                        | `apps/web/src/export/messages.ts:51-58`                                                        |
| Export refusals/failure              | same-source refusal, cancelled save ("no new file was written"), failure ("No copy was written")                                                                                                                                                                          | `messages.ts:91-95`, `151-152`                                                                 |
| Edit/cast refusal and double failure | "The previous view is unchanged." / "…Restoring the previous view also failed: … Use Retry to reload the view." with `restoreFailed` driving a visible Retry                                                                                                              | `edit/session.ts:399-400`, `530-534`; `App.tsx:3106-3111`                                      |
| Stale-ness language                  | validation/diff "previous … view is unchanged" (`edit/session.ts:249-250`); RecordInspector renders an explicit stale-pending state instead of old values (`apps/web/src/record/record-state.ts:165`); repair staleness notes (`apps/web/src/edit/repair/copy.ts:98-101`) | as listed                                                                                      |

**Inconsistencies found (the actual copy work):**

1. Three parallel double-failure framings for the same event class — `FilterBar.tsx:326-330` /
   `App.tsx:1737-1739` ("Re-apply a filter or reopen the dataset…") vs
   `useValidationSession.ts:299-301` ("Clear filters manually.") — and two single-failure endings
   ("still in effect", `edit/session.ts:248`, vs "back in effect",
   `useValidationSession.ts:297`). §5 maps one canonical phrasing per recovery kind.
2. Download-strategy success reads "Exported … your browser is downloading it as a new file" — it
   does not say the delivery is **initiated** rather than durably saved. The WF-05 v5 truth
   constraint already binds the replacement flow ("initiation, not persistence"; no "saved" for an
   initiated download —
   [WF-05 contract](20261110-wf05-replacement-contract.md) truth constraints); §5 proposes the same
   honesty for the export dialog.
3. SQL Cancel copy **already** says the result stops being shown if execution continues
   (`SqlPanel.tsx:355-357`) — keep it; only align the phrasing to the map's verb (§5).

## 3. WF-O1 — filter-draft clarity (first child; PROPOSED)

### 3.1 Draft vs accepted model and exact equality rules

Existing mechanics stay: the draft map (`FilterBar.tsx:295-297`) mirrors the accepted list on every
change; `displayedPredicate` (355) is what the user sees and what Apply submits. WF-O1 adds one
visible distinction and pins its rules:

- **Accepted state** = `model.filters`, the provider-accepted list, with per-column identity
  `acceptedPredicate(column)` (`FilterBar.tsx:344-345`).
- **Dirty** (per column, per control) ⟺ the displayed draft string **differs exactly** from the
  accepted predicate string. No SQL-semantic equivalence is claimed or computed: `> 5` and `>= 6`
  stay distinct, predicates are not normalized or case-folded, and list order is part of identity
  (`filterListSignature`, `FilterBar.tsx:41-44`). This is presentation identity only — it says
  nothing about which rows match.
- **No-op on Apply** ⟺ the submitted predicate, trimmed (the storage form trims —
  `query-state.ts:29`), equals the accepted predicate **and** the produced list would be identical
  in exact identity. Then: no dispatch, no busy state, no error, marker clears. (Trimming edge: a
  draft differing only by surrounding whitespace shows dirty but applies as a no-op.)
- **Not "unsaved dataset":** a dirty marker describes only that input vs the accepted filter. It
  must never read as dataset or edit dirtiness (plan E04: no such claim).

Reorder caveat (fact): `replaceColumnFilter` appends the edited column's filter at the end
(`query-state.ts:29-35`), so today an unchanged re-apply of one filter in a multi-filter list
re-orders the list and runs a full apply. The exact-string no-op check above sits in `FilterBar`
before any dispatch and removes that round trip **without touching `query-state.ts`**, which is
outside WF-O1's reserved boundary (map §"File reservations": builder/query-state tests unchanged
except additive assertions).

### 3.2 State truth table (proposal; replaces nothing existing)

| Case                           | Trigger                                                                                                    | Accepted list                                         | Draft/display                                   | Busy                                   | Feedback                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------- |
| Untouched                      | mount; accepted list changed                                                                               | L                                                     | seeded from L (`FilterBar.tsx:295-297`)         | no                                     | none (marker absent)                                                  |
| Dirty (valid)                  | user types ≠ accepted                                                                                      | unchanged                                             | differs exactly                                 | no                                     | one modest marker (§3.3)                                              |
| Invalid (compose)              | `compileFilterInput` rejects (`FilterBar.tsx:359-365`)                                                     | unchanged                                             | unchanged                                       | no                                     | existing inline value-free error (`role="alert"`), unchanged          |
| Cleared                        | user empties input, Apply                                                                                  | that column's filter removed (`query-state.ts:29-35`) | re-seeded                                       | yes during apply                       | none on success; "No active filters" if list empties                  |
| No-op                          | Apply with trimmed draft == accepted                                                                       | unchanged                                             | unchanged (marker clears)                       | **no**                                 | none                                                                  |
| Programmatic                   | "Show only failing rows" (`useValidationSession.ts:287`), profile top-k (`App.tsx:1722`), any `setFilters` | replaced by caller                                    | re-seeded (draft never outlives its filter)     | caller's own                           | existing auto-open/collapse-latch (`FilterBar.tsx:245-277`) unchanged |
| Busy                           | any apply in flight (`FilterBar.tsx:300-341`)                                                              | pending                                               | inputs disabled (existing `disabled={pending}`) | yes ("Filtering…", `DataGrid.tsx:911`) | none new                                                              |
| Single failure                 | apply rejects, restore succeeds                                                                            | previous list restored                                | re-seeded from previous                         | cleared                                | existing "…The previous filters are still in effect." — keep verbatim |
| Double failure (unknown state) | apply **and** restore reject                                                                               | **unknown/partial**                                   | re-seed reflects whatever the model holds       | cleared                                | existing honesty copy (§3.6) — keep, align verb only (§5)             |

### 3.3 One modest dirty indication (PROPOSAL)

- Where: only controls whose displayed draft differs exactly from accepted — the active-row
  predicate input and the SQL-escape-hatch input (same draft map), not the compose value (which is a
  new filter, not a draft of an accepted one).
- What: one small text-styled control beside the input, rendered only while that input is dirty.
  Proposed visible copy: `Not applied`. The marker **is** the revert affordance: a native
  `<button type="button">` — the same control class as the per-row Apply/Remove buttons
  (`FilterBar.tsx:568-593`) — not a link (nothing is navigated) and not a status (it is operable).
  The input's AT description is a separate value-free sentence (§3.4),
  `This input differs from the applied filter.`, carried on a `visually-hidden` span (existing
  utility class, `index.css:249`) referenced by `aria-describedby`; neither name nor description
  carries the predicate (ADR 0025 — never echo the predicate into a name or live region). Styling
  in the scoped CSS of the WF-O1 reservation; nothing global, quiet text styling only — no banner,
  error or warning treatment, which would read as dataset dirtiness (§3.1 forbidden claim).
- Revert affordance (what activation does): restores the accepted predicate string into that
  column's draft — a draft-only change; no dispatch, no busy state, no network call. The accessible
  name is `Not applied — restore the applied filter in this input` (starts with the visible copy per
  WCAG 2.5.3 Label in Name; value-free), phrased as restoring, never as discarding or losing: only
  the un-applied draft text is replaced — no filter, dataset or file state is touched (§3.1 "Not
  'unsaved dataset'"). This is the whole "reset" story — no Reset/Apply-all controls.
- States: not rendered while the draft is clean (§3.2 "Untouched" — no phantom tab stop), and
  `disabled` while an apply is pending like every bar control (`FilterBar.tsx:559`, `573`, `587`),
  re-enabled on settle including failure paths.
- **Alternatives rejected:** a draft/apply workflow with Apply-all/Reset-all buttons (plan E04:
  one modest input-dirty indication is preferable to a new workflow); a banner claiming dirty
  dataset state (forbidden claim, §3.1); a status-union change (that is C01's decision —
  implementation-plan C01: "No new status union chosen silently").

### 3.4 Copy table (exact before → after; only where a change is proposed)

| Surface                    | Before (anchor)                                                                               | After (PROPOSED)                                                                                                                                                                                                  |
| -------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dirty marker               | _(absent)_                                                                                    | `Not applied` (visible) + input description text `This input differs from the applied filter.`                                                                                                                    |
| No-op Apply                | full round trip, "Filtering…", re-seeded list                                                 | no dispatch, no feedback (§3.2)                                                                                                                                                                                   |
| Double-failure filter copy | "…Re-apply a filter or reopen the dataset if the grid looks wrong." (`FilterBar.tsx:329-330`) | keep the sentence; align the recovery verb with §5's map ("Re-apply a filter, clear the filters manually, or reopen the dataset if the grid looks wrong.") — **optional**; the honesty content is already correct |
| All other filter copy      | as §2 table                                                                                   | **unchanged**                                                                                                                                                                                                     |

### 3.5 Keyboard, focus and live-region behavior (proposal)

- Keep existing Enter-submits (`FilterBar.tsx:510-512`, `564-566`) and disabled-while-pending.
- The revert marker (§3.3) is a native button: one Tab stop directly after its input, activated by
  **Enter and Space** (browser default — no custom key handling; the only custom Enter behavior is
  the input-submits above). After activation, focus returns to the input the marker belongs to: the
  marker unmounts as soon as the draft matches accepted (§3.2), so focus left on it would drop to
  the document body, and the restored value is announced by the input receiving focus.
- Keep failures in their existing `role="alert"` paragraphs (`FilterBar.tsx:525-532`, `668-670`);
  no new live region; no announcement of predicate values (ADR 0025).
- Marker and revert are not announced on every keystroke or through a live region: the marker and
  its `aria-describedby` description (§3.3) are rendered text, not `aria-live` events, and the
  marker disappearing after a revert is not announced. The app's single polite live region
  (`App.tsx:3086-3095`, `edit-live-region`) is for edit announcements and is **not** repurposed
  here; a revert itself produces no announcement — the restored value is conveyed only by the input
  receiving focus.
- Optional, needs selection: on successful apply, no announcement (status quo) vs one polite
  status via the existing grid busy footer settling on "Filters applied". Recommendation: status
  quo — the chips/summary (`FilterBar.tsx:113-117`) already show the accepted result; a new
  announcement is not needed for one marker.

### 3.6 Preserving clear-all/manual recovery after unknown state (C01/C02 boundary)

- The double-failure branch is deliberately unknown-state copy (`FilterBar.tsx:322-325` comment);
  WF-O1 must keep it and must not replace it with a rollback claim. The manual recovery directions
  it names (re-apply; reopen the dataset) and the validation bridge's "Clear filters manually."
  (`useValidationSession.ts:301`) are the recovery affordances — note the audit fact that **no
  clear-all button exists**; "clear" means per-filter `Remove` buttons (`FilterBar.tsx:570-590`)
  or re-apply. If a clear-all affordance is ever added, it belongs to C01/C02 ("Resolve where
  retry/clear is exposed", implementation-plan C01), not to WF-O1.
- WF-O1 must not decide the C01/C02 caller-visible status distinction (rejected-before-change vs
  accepted-but-refresh-failed vs legacy partial) — that contract governs the runtime; the marker
  only ever describes input-vs-accepted.

### 3.7 Owners, tests, untrusted text (acceptance inputs for a future brief)

- Candidate source/test owners, per the map's WF-O1 reservation: `apps/web/src/grid/FilterBar.tsx`,
  `FilterBar.test.tsx` (additive assertions only for `filter-builder.test.ts` /
  `query-state.test.ts`), scoped `index.css`, an additive e2e. Proposed new pure helper (e.g.
  `draftDirty(displayed, accepted)`) with its own Node test keeps the equality rules out of JSX.
- Test matrix named by the map row (T-WFO1): seed/clear/invalid/no-op/programmatic
  replace/single+double rollback failure — extended with marker-visibility and revert cases
  (keyboard activation, focus return after revert, no dispatch on revert).
- Untrusted text: predicates and engine error lines are untrusted content rendered as React text
  only (existing posture, `FilterBar.tsx:184-193`; ADR 0007/0025). No proposal changes that.

## 4. WF-O2 — nested/Record/SQL parity outline (separate design; **NOT AUTHORIZED NOW**)

WF-O2 stays `BLOCKED` (map §3: "design required"; "no runtime reservation until type propagation is
specified"). The scalar WF-01 contract is **not** authorization for this work. Outline only:

- **Declared child types into nested/Record rendering:** nested previews already decode decimal
  leaves through the declared type when it is known (`nested-preview.ts:66-77`, `276-289`) but keep
  children type-blind where types are not modeled (MAP children — `nested-preview.ts:183-187`) and
  do not decode temporal leaves (grid/record/SQL "keep raw temporals (WF-O2)",
  `apps/web/src/grid/format.ts:35-37`). Propagate the declared child types (list element type,
  struct/union field types) so nested and Record leaves decode decimals **and** temporals under the
  same rules as scalars.
- **SQL result metadata formatting:** the SQL result renders `formatCell(cell)` with **no type**
  (`SqlPanel.tsx:400`) from a page that carries column names only (`SqlPanel.tsx:386-393`,
  `apps/web/src/sql/paged-query.ts:33-36`). Propagate the result's declared column metadata into
  formatting — decimals decoded, temporals per WFD-06 = B, never a generic formatter sweep.
- **Null/hostile/deep-container bounds preserved:** the nested preview's total/deterministic/
  length-capped (120)/depth-capped (3)/distinct-null contract (`nested-preview.ts:17-34`, `45`,
  `54`) and the record tree's circular/unreadable markers (`apps/web/src/record/record-tree.ts:14-33`)
  are invariants; type-decoding must fail soft to the raw value on any payload/type mismatch.
- **Timezone/precision/raw fallback:** exactly the WF-01 rules — UTC deterministic ISO-like text at
  the exactly delivered precision, raw fallback otherwise, `TIMESTAMP_NS` always raw
  (`apps/web/src/grid/temporal-display.ts:1-50`). No tolerance widening, no fabricated instants.
- **Copy parity:** one value renders identically in the grid cell, nested preview, Record tree and
  SQL result (the record tree already reuses `formatNestedPreview` summaries —
  `record-tree.ts:32-35`).
- **Non-goals:** export/edit/filter raw fidelity unchanged; no change to the Arrow→rows projection;
  no engine/wire change.

**Explicit statement:** none of §4 is authorized to implement now. It requires its own scope/type
propagation contract, reservation and review after selection.

## 5. Recovery-copy map (PROPOSED; existing local alerts/status components only)

No global ErrorBus, no new component class (plan E04: no permission for one). Components in use:
per-panel `role="alert"` paragraphs (filter/SQL/profile/grid-command errors), `role="status"`
spans (busy/preflight), the single polite `edit-live-region` (`App.tsx:3086-3095`), and the
pure copy modules (`edit/session.ts`, `export/messages.ts`). Map columns follow E04: operation /
whether the previous result remains / stale-ness / precise recovery.

| Operation                                       | Previous result remains                                                                      | Stale-ness said today                                                                                              | Recovery offered today (anchor)                                                                          | PROPOSED alignment                                                                                                                                                                                               |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Filter apply — single failure                   | previous filters, in effect                                                                  | "The previous filters are still in effect." (`edit/session.ts:248`)                                                | fix the draft, Apply                                                                                     | keep verbatim; canonical ending for "previous state intact"                                                                                                                                                      |
| Filter apply — double failure                   | **unknown/partial** (`FilterBar.tsx:322-325`)                                                | copy claims nothing about current state                                                                            | "Re-apply a filter or reopen the dataset…" (`FilterBar.tsx:329-330`)                                     | keep honesty; optionally add "clear the filters manually" (§3.4)                                                                                                                                                 |
| Profile top-k filter                            | as filter apply                                                                              | same two framings (`App.tsx:1727-1739`)                                                                            | as above                                                                                                 | use one shared framed message (same constant as FilterBar)                                                                                                                                                       |
| Filter-to-failures                              | as filter apply                                                                              | "…back in effect." / "…Clear filters manually." (`useValidationSession.ts:297`, `301`)                             | clear/re-apply                                                                                           | adopt the canonical endings ("still in effect"; "Clear filters manually." = canonical **Clear** verb)                                                                                                            |
| SQL run failure                                 | dataset + staged changes unchanged; prior result page not shown again                        | "The dataset and its staged changes are unchanged." (`edit/session.ts:243-244`)                                    | edit + Run again                                                                                         | keep                                                                                                                                                                                                             |
| **SQL Cancel**                                  | result discarded                                                                             | "…this query may still run to completion… its result is discarded and will not be shown." (`SqlPanel.tsx:355-357`) | Run again (queues behind)                                                                                | keep content; align to "Cancel stops showing this result if execution continues" phrasing in the note's first sentence (optional, meaning unchanged)                                                             |
| Export — FSA write                              | opened file unchanged                                                                        | none needed (write awaited)                                                                                        | "Open a data file…" guidance (`messages.ts:79`)                                                          | keep; **Open-new** verb = "Open a data file…"                                                                                                                                                                    |
| **Export — download**                           | opened file unchanged                                                                        | "your browser is downloading it as a new file" (`messages.ts:57`)                                                  | reopen guidance                                                                                          | **say initiated, not durably saved**: "— your browser download has started (Assay cannot confirm it completed). The opened file is unchanged." Aligns with the WF-05 truth constraint (initiation ≠ persistence) |
| Export — same-source refusal / cancel / failure | nothing written; opened file unchanged                                                       | stated in each string (`messages.ts:91-95`, `151-152`)                                                             | choose another name/location; run again                                                                  | keep verbatim                                                                                                                                                                                                    |
| Edit/cast refusal                               | previous view unchanged                                                                      | "The previous view is unchanged." (`edit/session.ts:400`)                                                          | fix value; "try again" (`edit/session.ts:426`)                                                           | keep                                                                                                                                                                                                             |
| Edit commit — double failure                    | previous view restore **failed**                                                             | both failures named (`edit/session.ts:531-533`)                                                                    | "Use Retry to reload the view." (`edit/session.ts:533`; button "Retry loading the view", `App.tsx:3111`) | keep; canonical **Retry** verb                                                                                                                                                                                   |
| Open / CSV preview / repair preview failure     | nothing opened / nothing applied (`edit/session.ts:241-255`)                                 | named per operation                                                                                                | pick another file; re-run                                                                                | keep                                                                                                                                                                                                             |
| Validation / diff run failure                   | previous report view unchanged (`edit/session.ts:249-250`); reports can be stale by revision | stale revision computed separately                                                                                 | re-run                                                                                                   | keep; do not merge staleness into the failure alert                                                                                                                                                              |
| RecordInspector refresh gap                     | old values **not** shown                                                                     | explicit stale-pending state (`record-state.ts:165`)                                                               | reload                                                                                                   | keep (exemplar of honest stale-ness)                                                                                                                                                                             |

Canonical recovery verbs (proposal): **Retry** = "Use Retry to reload the view." /
"Retry loading the view"; **Clear** = "Clear filters manually." (per-filter `Remove` today);
**Open-new** = "use “Open a data file…” and choose the file you wrote." Any future recovery affordance
reuses these strings rather than inventing variants.

## 6. Stop rules and what is explicitly unauthorized

- These are **proposals, not usability evidence**; implementation of any child (WF-O1 copy/marker,
  §5 alignment, WF-O2) needs a **separate maintainer selection**, reservation and review. This
  document stops there (plan E04 acceptance: "Stop for maintainer selection before implementation").
- Explicitly unauthorized here: WF-03/04/07/08/09 work; any global ErrorBus or new status union
  (C01 owns status semantics); changes to raw export/edit/filter fidelity; a "dirty = unsaved
  dataset" claim; SQL engine interrupts; a clear-all control (C01/C02 decision); claims of
  participant/AT verification; narrow-screen/zoom certification (unverified — carried as a gap).
- Known evidence gaps carried forward: no human study (RD-T07), no AT pass on the proposed marker
  description, no zoom/narrow-screen measurements. Any brief must restate them, not absorb them.
