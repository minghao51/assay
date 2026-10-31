# ug-16 design pass — base-derived profile stats vs the edited view

> **STATUS: DESIGN DECIDED 2026-10-30** (orchestrator design pass, requested by the maintainer).
> This satisfies the dispatch prerequisite recorded on the `ug-16` queue row: _“before ug-16 is
> dispatched, the design must choose explicit disclosure, a typed refusal, or a stated mapping
> rule; no silent filter mapping.”_ The queue row and this record govern ug-16. No new R-ID: R-16
> already owns the base-only disclosure; this file owns the **click-to-act** contract. No engine,
> protocol or domain change is authorized by it.

## 1. Problem

ug-16 makes profile statistics actionable: a top-k value click applies `= 'value'`, a null-count
click applies `IS NULL`, and chips appear in the FilterBar. But the profile is **base-derived**
(R-16): `profile(handle)` reads the file as opened, while the grid and filters run on the
overlay-effective view. After staged edits:

- a base-derived top-k value may match **zero rows** (rows edited/deleted, values inserted);
- a base column may have been **renamed** (supported today: `column-rename`), so the profile's
  column name may not resolve on the effective view at all;
- a base column may have been **cast**, so the base-derived value literal may not bind to the
  effective type;
- column deletion is **not** a supported op today; if one is added it inherits this rule.

Applying a base-name filter blindly would either throw a raw engine error or silently filter on a
column that no longer exists. Silent remapping is explicitly forbidden by the queue.

## 2. Verified facts (2026-10-30, `e690267`)

| Fact                                                                                                                                                         | Evidence                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Profile statistics come from the base view only; the panel now labels that honestly (R-16).                                                                  | `packages/engine-duckdb/src/profile-query.ts`; `apps/web/src/profile/ProfilePanel.tsx` (`STANDING_HINT`, `stagedChangesNote`)                               |
| The effective schema (renames/casts applied) is available to App through the grid model slice.                                                               | `apps/web/src/App.tsx` `useModelSlice` → `modelSchema`; `packages/domain/src/overlay.ts` (`OverlayState.columns`)                                           |
| Renames are a supported op; there is **no** column-drop op.                                                                                                  | `packages/domain/src/edit-ops.ts` (`column-rename`, `column-cast`; no drop)                                                                                 |
| Active ops at the history cursor are available in App (`activeOps(history)`), and `stateAtCursor` folds the effective state.                                 | `apps/web/src/edit/session.ts`; `packages/domain/src/overlay.ts`                                                                                            |
| Filters are applied through `GridViewportModel.setFilters`, with the pure builder compiling operator+value → predicate and the existing rollback/error path. | `apps/web/src/grid/FilterBar.tsx`; `apps/web/src/grid/filter-builder.ts` (`compileFilterInput`); `apps/web/src/grid/query-state.ts` (`replaceColumnFilter`) |
| A zero-row result already has an honest empty state; no new grammar is needed.                                                                               | grid empty-state copy/spec §2                                                                                                                               |
| There is no click-to-act bridge yet — the profile table renders values as text.                                                                              | `apps/web/src/profile/ProfilePanel.tsx`                                                                                                                     |

## 3. Options considered

1. **Disclosure only** (apply the base-name filter, let the engine/zero-row result speak). Rejected:
   a renamed column produces a raw engine rejection or a confusing zero-row filter, and the user is
   not told why.
2. **Typed refusal + disclosure (chosen).** Before compiling a filter, resolve the profile's base
   column against the **current effective schema**. If it does not resolve, apply nothing and show
   a one-line refusal that names the base column and — when the active rename chain resolves it —
   the current name. If it resolves, compile against the **effective** column type and apply; a
   value that cannot bind surfaces the builder's readable rejection (never coerced, never remapped).
3. **Stated mapping rule** (auto-remap base name → current name and apply). Rejected: it is silent
   in effect, ambiguous after chained renames or undo, and more machinery than the rare case
   warrants. The queue forbids silent mapping; a _disclosed_ mapping would still surprise.

**Decision: option 2 — refuse, don't remap.** Top-k values stay base-derived; the existing empty
state stays honest; no engine work.

## 4. Contract

### 4.1 Resolution rule (pure helper, unit-pinned)

Given `baseColumn`, the active ops at the history cursor, and the effective schema:

1. If `baseColumn` is in the effective schema → resolved as itself (no rename affects it now).
2. Else follow active `column-rename` ops in order from `baseColumn`; if the chain lands on a name
   present in the effective schema → **renamed**, current name known.
3. Else → **unresolved** (future column-drop, or a chain whose intermediate name is gone).

A rename chain that returns to the original name is resolved as itself. Undo/redo changes the
active ops, so the next click re-resolves.

### 4.2 Behavior

- **Resolved:** compile `= <top-k value>` or `IS NULL` with the existing builder against the
  **effective** column's type profile, then apply through
  `replaceColumnFilter(previous, column, predicate)` + `model.setFilters(next)`. Chips appear via
  the existing FilterBar (no new chip code). A builder rejection (e.g. the base value does not bind
  to a cast type) is shown single-line in the refusal slot; **no engine call**, no coercion.
  An engine rejection after a successful compile keeps the existing framed filter error and
  rollback (ug-14 copy).
- **Renamed:** apply **no** filter, change no state, show the refusal (4.3) naming the current
  name.
- **Unresolved:** apply **no** filter, show the generic refusal (4.3).
- **Zero rows after a resolved click** (edits removed the value): existing empty state; no new copy,
  no silent fallback, no re-profile.
- The refusal clears on the next click, a profile re-run, an undo/redo, or a new dataset; it never
  replaces the R-16 hint/note.

### 4.3 Byte-exact copy

Renamed (both names quoted, straight ASCII quotes, em dash U+2014):

`This column is now "<current>" in the edited view. The profile still uses the file's original name, "<base>" — use "<current>" in Filters instead.`

Unresolved:

`This column is not in the edited view. The profile describes the file as opened — undo the change or re-open the file to filter by it.`

Rendered in the profile panel as a single-line `role="status"` element
(`data-testid="profile-filter-refusal"`), text-only, value-free (column names are schema, never
cell values; ADR 0025). No filename, no engine text.

## 5. Acceptance criteria (for the ug-16 worker brief)

1. Top-k value click applies `= 'value'`; null-count click applies `IS NULL`; the FilterBar shows
   the chip; the existing pure builder is used (no grammar change, no new SQL composition).
2. Renamed column: click applies **no** filter, filters are unchanged, and the byte-exact renamed
   refusal (4.3) renders with the current name; pinned at unit + component.
3. Unresolvable column: byte-exact generic refusal; no filter.
4. Cast/type mismatch: no coercion and no remap; the builder's readable single-line rejection is
   shown in the refusal slot, or the existing framed filter error after an engine rejection.
5. Base-derived values: a resolved click that matches zero rows uses the existing empty state
   (pinned); no new grammar.
6. R-16 hint/note and `profile-table-id` unchanged; `profile(handle)`/engine untouched; no
   re-profile; no telemetry change.
7. Mutation drills: (a) remove the rename/unresolved guard → the renamed-click pin fails (a filter
   is applied under the base name); (b) drop the current-name lookup → the copy loses the current
   name and the byte-exact pin fails.

## 6. Scope

`apps/web/src/profile/**` (panel + tests), `App.tsx` (click-to-act bridge + refusal state),
`apps/web/src/edit/session.ts` (pure rename-chain resolver; no new domain dependency),
`apps/web/src/grid/filter-builder.ts` only if a signature change is genuinely unavoidable (prefer
reuse), one scoped `profile-*`/`filter-*` CSS block if needed, focused tests + one e2e journey, one
`feat(web):` changeset. **Forbidden:** `packages/**` engine/protocol/domain changes, new
dependencies, broad restyle, telemetry, `innerHTML`, push.

## 7. Known corners

- **Chained renames** (`a→b→c`): follow the active chain in order; if an intermediate name is not in
  the effective schema, treat as unresolved rather than guessing.
- **Undo/redo**: the rule is evaluated per click from the active ops, so an undone rename resolves
  the original name again; the refusal clears.
- **Rename back to the original name**: resolved as itself; no refusal.
- **Cast**: the profile's base type may differ from the effective type; compile against the
  effective type. Never silently quote/coerce the base value.
- **Row deletes/edits**: values are still valid literals; the zero-row empty state is the honest
  outcome.
- **Future column-drop op**: falls into “unresolved” with the generic refusal; no remap.
- **Filters already active**: the click replaces that column's filter via `replaceColumnFilter`
  (existing semantics); other filters are preserved. No silent replacement of the whole list.

## 8. Record

- Design pass: 2026-10-30, orchestrator, at the maintainer's request.
- Governs: `ug-16` queue row (Panels lane), which becomes dispatchable with this contract.
- Related: R-16 (spec §2), ug-10 (closed `f667a87`), ug-20 (next after ug-16), R-09…R-13 (visual
  queue, untouched).
