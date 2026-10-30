# Overlay-aware profile — engine-track candidate (UX-D1 Option C)

> **STATUS: CANDIDATE — PLANNING ONLY. NOT AUTHORIZED FOR DISPATCH OR IMPLEMENTATION.**
> Chartered by the maintainer's 2026-10-30 **UX-D1 Option C** ruling
> ([amendment brief](20261029-ux-d1-amendment.md) §7) as a **separate** engine-track candidate, not
> a rider on ug-10. Authoring this row authorizes nothing: no worker may claim it, no protocol,
> domain, `DataEngine` target or engine source may change until a later explicit maintainer
> decision. The amended ug-10 (honest labeling, R-16) ships independently and stays true until this
> candidate is implemented — at which point its base-only copy must be replaced, not duplicated.

## 1. Why this candidate exists

The profile panel reads the **base view only** (`profile(handle)`; `profile-query.ts` composes base
SQL). Staged operations — cell edits/reverts, row inserts/deletes/restores, column renames/casts —
change the overlay-effective view the grid and validation already query, so displayed statistics can
describe something other than what the user is looking at. UG-18's user-facing harm is removed today
by R-16's honest labeling; this candidate would make the statistics _follow_ the edits instead of
only disclosing that they do not.

## 2. Current engine facts (verified 2026-10-29/30 at `25f05b3`–`8a38e0e`)

| Fact                                                                                                                                                                                                                                                                     | Evidence                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `profile(handle)` sends only `{type:'engine/profile', requestId, tableId}`; the worker profiles `entry.viewName` (the base view).                                                                                                                                        | `packages/engine-duckdb/src/client.ts`, `protocol.ts`, `engine-executor.ts`, `profile-query.ts` |
| The overlay is stateless per request, and the engine already has overlay-aware surfaces: `overlaySchema`, `overlayRowCount`, `fetchOverlayRange`, `overlayCastCheck`, `exportView(handle, {…, overlay})`, `validate(…, overlay)`, `diff(…, overlay)`. None is a profile. | `client.ts`, `protocol.ts` request union                                                        |
| Effective-view SQL composition already exists and is exported: base branch ∪ live insert branches, tombstones, rename/cast projection, `assay_key` ordering.                                                                                                             | `overlay-query.ts` (`composeSourceSql` and siblings)                                            |
| The profile plan is **one aggregate scan plus one grouped top-k scan per categorical column**.                                                                                                                                                                           | `profile-query.ts` module header                                                                |
| Live inserts are capped at `MAX_OVERLAY_LIVE_INSERT_BRANCHES` (500); a larger overlay is refused with a readable engine error.                                                                                                                                           | `overlay-query.ts`                                                                              |

## 3. What it would need (cost, deliberately stated)

1. **Protocol:** an overlay-bearing profile request (either an optional `overlay` on
   `engine/profile` or a new request type) plus its response semantics (which view the numbers
   describe).
2. **Worker:** compose the effective relation via `overlay-query.ts` for the aggregate and each
   top-k scan; keep the 500-branch refusal and its copy; no new SQL dialect.
3. **Client:** `profile(handle, overlay?)` or `overlayProfile(handle, overlay)`; every existing
   call site must keep the base behavior unless it opts in.
4. **Domain / `DataEngine` target:** an open architecture question, not a mandate. A pure
   `engine-duckdb` client-protocol addition may suffice under D13 compatibility rules; the architect
   resolves whether `packages/domain` or the public `DataEngine` target must change. The existing
   diff overlay is the composition precedent.
5. **Conformance + fixtures:** pinned-CLI conformance scenarios (base vs effective stats across
   edits/inserts/deletes/renames/casts; the >500-insert refusal) derived from the pinned DuckDB CLI,
   plus minimal golden fixtures and regression pins.
6. **UI:** replace R-16's base-only hint **and** staged note with explicit effective-view labeling
   (never show both contracts), and re-decide the ug-16 top-k click semantics (values would follow
   edits; renamed/deleted-column binding still needs its disclosure/refusal/mapping rule).

## 4. Acceptance sketch (not a brief)

- Effective-view profile equals the same statistics computed over the composed relation (conformance
  and fixture-pinned), for every supported op class.
- Overlay larger than the live-insert budget refuses readably and never silently falls back to base.
- Base-profile behavior is unchanged for callers that pass no overlay (compatibility pin).
- R-16's base-only copy is replaced, with a pin that it cannot reappear alongside the effective
  labeling.
- Six gates + coverage + docs/ADR checks in a clean isolated worktree; independent review; no
  telemetry change (ADR 0025/0037); no source mutation (ADR 0012).

## 5. Non-goals / guard rails

- Not authorized by this file. Dispatch requires a new maintainer ruling after the footprint above is
  resolved (architect pass if an ADR/`DataEngine` change is warranted).
- No new dependency; no DuckDB-WASM fork; no background/auto profiling; no telemetry carrying values
  or filenames.
- ug-10 (R-16) does **not** wait for this candidate, and this candidate must not be smuggled into a
  ug-10 claim.

## 6. Record

- Chartered: 2026-10-30, UX-D1 **Option C** ([brief](20261029-ux-d1-amendment.md) §7).
- Owner: unassigned (engine track). Decision owner: maintainer.
- Related: R-16 (spec §2), ug-10 (usability queue), ug-16/ug-20 (Panels successors).
