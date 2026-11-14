# R1 — masked engine errors: decision, investigation and fix rows

**Date:** 2026-11-14. **Status:** **R1-C CLOSED** (merged `837b638`) and **R1-A CLOSED** (merged
`b0b78bc`); the desktop row (**R1-B**) is next. Nothing pushed.

**Authority:** accepted ADRs → [EW-10 §8](20261113-ew10-first-wave-integration.md) →
[ADR 0048 (Proposed)](../../adr/0048-engine-bundle-selection-and-honest-error-text.md) → this record.
Maintainer instruction: _"lets proceed with your recommendation"_ (2026-11-14), which selects
D1 = R1 and the recommendation in this record's §2.

## 1. Decisions recorded 2026-11-14

| #   | Decision                                                                                                                                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **R1 is selected** as a defect row ("honest engine failure text"), superseding the open `_setThrew` residual for scheduling.                                                                                                                                                        |
| D2  | **Web: capability-guarded bundle selection** — `eh` when the browser validates wasm exception handling (the package's own `getPlatformFeatures()` probe), `mvp` otherwise. The current browser floor is unchanged.                                                                  |
| D3  | **Desktop: `eh` only** — Electron's Chromium is fixed at 148 and supports wasm EH; the vendored set swaps the mvp pair for the eh pair and the `wasm_eh` extension platform.                                                                                                        |
| D4  | **Visible text policy** — the engine's real first message line may reach user-initiated surfaces (SQL run, open, edit); validation/diff/overlay keep their fixed value-free classes (q-8). The opaque-glue fallback stays only as the non-EH safety net and is never file evidence. |
| D5  | **ADR 0048** records the bundle-selection and honest-text contract as Proposed.                                                                                                                                                                                                     |

## 2. Investigation result (read-only; probes and logs were session-local)

Baseline `f1be26a`, clean; own fresh gates: format/lint 0, forced typecheck 20/20 (0 cached), unit
245 files / 3629 tests, coverage 89.31 / 84.02 / 91.65 / 90.97, forced build 12/12 (0 cached), docs
154/0, ADR 47, browser 264 passed + 1 skipped, configured telemetry 7 passed (3 POSTs aborted, zero
delivered), restored stock 76 passed.

**Root cause.** The worker pins `duckdb-browser-mvp.worker.js` + `duckdb-mvp.wasm`. That published
glue is an incomplete JS-EH build: it calls `_setThrew` (371 sites) and four `__cxa_*` helpers that
the wasm module **exports**, but never binds them. Every DuckDB failure becomes a JS exception at a
wasm→JS boundary; the `invoke_*` trampolines call `_setThrew(1,0)` and throw `ReferenceError` before
the engine message exists. Both client paths are one mechanism.

**Measured.** mvp: masked text for catalog/conversion/IO failures on `query()` and `send()`; eh: real
`Catalog Error` / `Conversion Error` / `IO Error`, same engine `v1.4.3`, faster boot (473 ms vs
572 ms), feature flags 17 vs 16. A shim converges only after five bindings (proves a missing layer,
not a symbol), so it is rejected. Flat `UNION ALL` at 500/900/1000/1200 branches: mvp raises
`RangeError: Maximum call stack size exceeded` at every size, eh plans 900 and reports the real
`Parser Error: Max expression depth limit of 1000 exceeded` at 1000/1200 — the recorded
"≥1000 → `_setThrew`" citation is shape-dependent and **EW-04D U4 must re-derive it**.

**Corrections carried into the fix briefs.** EW-03D §6.1 says the wasm "contains no such export" —
wrong: the exports exist, the glue bindings are missing. The current corrupt-Parquet e2e pins the
masked text and the neutral cause; with `eh` the same fixture yields
`Invalid Input Error: No magic bytes found at end of file …` and the truthful "could not be read"
cause, so those assertions move with the fix.

## 3. Fix rows

| Row                          | Scope                                                                                                                                                                                                                         | Status / dependency                                                                                                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1-A** (web + engine core) | `packages/engine-duckdb` bundle selection + asset wiring + unit tests; e2e real-message and corrupt-open assertions; platform-paired extension fixture (commit the `wasm_eh` Parquet/JSON binaries with checksums); changeset | **CLOSED — MERGED `b0b78bc`** after two review rounds (the second fixed the circular `wasm_eh` file pin); merged gates green with two documented page-load flakes re-ran 19/19 (§3.9) |
| **R1-C** (edit-value check)  | Make a staged cell-edit value's convertibility a pre-append engine check (reuse `overlayCastCheck`; skip its provably-redundant base arm when no cast is pending) and refuse with the existing value-free framing             | **CLOSED — MERGED `837b638`** after 3 independent review rounds + a comment-only verification; merged gates green (§3.7)                                                              |
| **R1-B** (desktop)           | `apps/vscode` vendored set → eh pair + `wasm_eh` autoload paths + build checksums/docs + spike harness update; changeset                                                                                                      | **NEXT** — desktop `eh`-only vendored set; brief staged, worktree created (no dispatch until this record is current)                                                                  |

R1-B is deliberately serialized: both rows touch the pinned-asset directory and the e2e extension
route, and only one runtime writer may be claimed.

### 3.1 R1-A dispatch envelope (filled)

```text
Row / authority: R1-A — ADR 0048 §Decision 1–3, this record §1 (D1–D5), EW-10 §8.2 step 2.
Baseline: f1be26a8f7d1bfb05c62642e2fcda3bc4ebd3d7c (clean; own gates recorded in §2).
Worker: opencode-go/deepseek-v4.1-flash (high). Reviewer: opencode-go/mimo-v2.6-flash (high),
  independent session, mutation controls, verify by running.
Branch/worktree: fix/r1-a-honest-engine-errors @ ../dataworkbench-r1-a (from f1be26a).
Ports: stock 4273/4279/4280 · configured 4673/4679/4680 · restored 4773/4779/4780.
Allowed: packages/engine-duckdb/src/**, tests/e2e/support/fixture.ts,
  tests/e2e/engine-duckdb.spec.ts, tests/e2e/open-recovery.spec.ts,
  apps/vscode/assets/duckdb/*.pinned (ADD the wasm_eh Parquet/JSON binaries only),
  .changeset/*.md.
Forbidden: docs/**, apps/vscode/src/**, apps/vscode/webview/**, apps/vscode/scripts/**,
  apps/web/src/**, dependency or lockfile changes, protocol changes, other fixtures.
Done-when: capability detection (upstream probe bytes) selects eh/mvp; unit tests cover both
  branches and a throwing validator; the browser harness asserts the real DuckDB message on a
  failing query and the `send()` path; the corrupt-open spec asserts the truthful cause and the
  real engine detail; the fixture serves the platform-tagged binary; negative control (force mvp)
  makes the new message assertion fail; dist growth measured and reported.
Gates: format, lint, forced typecheck, unit, coverage, forced build, docs links, ADR index, full
  browser (ports above), configured telemetry leg, restored stock leg. Logs under /tmp, tails pasted.
Stop: any need to touch a forbidden path, change the protocol or a dependency, or make a support-
  floor/text-policy call not covered by §1. Never push; one conventional commit + one changeset.
```

### 3.2 R1-A blocker (2026-11-14, worker report `/tmp/assay-r1-a-report.md`)

Everything inside the reservation is green (format/lint; forced typecheck 20/20 0 cached; unit
246 files / 3639; coverage 89.32/84.02/91.65/90.98; forced build 12/12; docs 156/0; ADR 48; the
mutation control force-`mvp` failed the new real-message and corrupt-open assertions and restored
byte-identically). The **full browser gate fails on two specs outside the allowed paths**:

1. `tests/e2e/replace-guard.spec.ts:342` — stale `NEUTRAL_CAUSE` pin for the corrupt fixture; the
   same mechanical update the brief authorized for `open-recovery.spec.ts`.
2. `tests/e2e/grid-editing.spec.ts:221` — **a behaviour gap, not a stale assertion.** With `eh`, the
   hostile DATE edit (`not-a-date'; DROP TABLE x --`) is accepted at commit ("Edit committed."),
   and the conversion failure only appears later in the grid's window fetch, leaving every cell as
   a retryable `!` with no message. Under `mvp` the commit-time rejection + rollback happened.

Root cause of (2): the commit path's `refresh()` is `Promise.all([schema(), rowCount()])`
(`packages/grid/src/viewport-model.ts:303-321`). Both are metadata queries that do **not** evaluate
the edited value (verified: they succeed under `eh` with the bad value present), while `mvp`'s glue
turned an internally-caught DuckDB exception into a hard failure. So the old rejection was
incidental to the broken glue, not a value check; honest errors expose a pre-existing gap. The
composer already has the right machinery: `composeOverlayCastCheckSql` checks edited/insert literals
cheaply and only scans the base for the non-edited arm.

**Proposed R1-C (needs the maintainer's go/no-go):** before appending a `cell-set`/insert, run the
existing `overlayCastCheck` with the column's own effective type, refusing with the existing
value-free framing; optimize the composer to omit the base arm when the effective column has no
pending cast (provably redundant, so the check stays O(edits), not O(rows)). No protocol or
dependency change. On approval R1-A is rebased onto R1-C with `replace-guard.spec.ts` (mechanical)
and `grid-editing.spec.ts` (new refusal path) added to its reservation, and re-dispatched.

### 3.3 Granted test-only amendments

- **R1-C A1 (2026-11-14)** — `apps/web/src/sessions/useEditingSession.replace.test.tsx` joins the
  R1-C reservation. The new pre-activation `validate` adds one await before `refresh()`, so the
  WF-06 mutation-counter tests must await the check before asserting; only the waiting changes, the
  asserted counts/contract stay as written. Worker-verified in isolation, reviewer must re-verify.

### 3.4 R1-C review round (2026-11-14)

Commit `d3bf5b4` (9 files, +860/−32) passed the worker's full gate set and both mutations, then the
independent `opencode-go/mimo-v2.6-flash` reviewer re-derived every gate (all matched) and independently
confirmed the composer elision sound — but returned **request-changes** on three items:

1. **The `MAX_CELL_CHECK_ATTEMPTS` fallback is reachable and unsafe.** A three-overlapping-edit probe
   (the row's own two-edit tests plus one) invalidated both checks of the third edit, which then
   activated a hostile value with no verdict (`editError=null`) — the exact broken-grid prelude R1-A
   exposed. "Commit unchecked" must be unreachable.
2. **The bound was unpinned** (no test forced two invalidations).
3. Minor: the `grid-editing` test title still said "rolls back" for a pre-activation refusal.

Fix round (same branch, same worker): **serialize every history-changing gesture through one mutation
chain**, then delete the retry loop, the attempt parameter and the unchecked fallback; keep the
pre-activation `validate` (the reviewer's mutation proved ordering is load-bearing), the composer
elision and the session-token abort; add the three-overlap hostile pin, a two-overlap valid-edit pin and
a non-cell-mutation-during-check pin; reword the O(edits) claim to the guaranteed shape; rename the
test. A fresh reviewer re-verification follows.

### 3.5 R1-C re-review (2026-11-14)

A fresh reviewer re-verified `b8d85dc`: the unchecked-commit path is **gone** (`MAX_CELL_CHECK_ATTEMPTS`
absent), the three-burst pin is non-vacuous, two-overlap ordering and the undo-waits pins hold, the
cast append re-verifies before `setActive` and refuses a stale verdict with the existing raced-cast
copy, the composer elision is sound, and all gates/mutations were independently reproduced (unit
245/3650, coverage 89.33/84.04/91.65/90.99, browser 264+1 on the third run after two unrelated page-load
flakes, configured 7/zero delivered, restored 76). WF-06's mutation-counter contract is still pinned
per step (increment before first await, clear only in `finally`); true simultaneity is no longer
exercised because serialization removes it, and the still-reachable overlap contract (two concurrent
cast pre-checks) remains pinned by the N17 test.

It still returned **request-changes** on three small items, one of them real: (1) a value check that
_rejects_ after a table replacement bypassed the token guard and surfaced a stale, false edit error
(`editError` non-null, 0 activations) — the resolve path was guarded, the rejection path was not;
(2) the `session-errors` suite docstring still claimed the deleted re-derive pin and carried a
duplicate comment; (3) two comments still described the pre-chain model ("cell/rename ops run
synchronously", "two commits can overlap"). Fix round 2 (same branch, same worker) guards the
rejection path, adds the reject-path stale-token pin, and corrects the prose; a fresh re-review
follows.

Recorded residual risks (unchanged, not defects of this row): `mutationStateRef` now increments one
microtask after the gesture rather than synchronously; the mutation chain has no timeout (a
never-settling engine promise would wedge it — pre-existing class); undo/redo/cursor rely on
staging-time verdicts (documented).

### 3.6 R1-C final re-review (2026-11-14)

A fresh reviewer re-verified `d0e14e7` end to end: the rejection-path guard is correct on both
outcomes (reject after replacement → no message/activation/refresh; reject without replacement →
framed; resolve after replacement → abort), the new reject-path pin is non-vacuous (removing only the
guard fails only that pin), and all gates were first-run green on its host (245/3651, coverage
89.33/84.04/91.65/90.99, browser 264+1 twice, configured 7/zero delivered, restored 76). All four
mutations reproduced with byte-identical restoration. The only remaining item was **prose**: the
`session-errors` suite docstring claimed "six behaviours" against ten `it` pins, two of them
unenumerated. A comment-only amendment follows; no behavioural change.

### 3.7 R1-C closure (2026-11-14)

Merged as **`837b638`** (cherry-picked with `-x` from `9b2623a`, branch
`fix/r1-c-edit-value-check`, base `f343133`; nine files, +1254/−82). Three independent review rounds
(request-changes twice: the reachable unchecked-commit fallback; then the rejection-path staleness
guard + prose) and a comment-only verification (`approve`). Merged gates at `837b638`
(`/tmp/assay-r1-c-merged-logs/`): format/lint 0 · forced typecheck 20/20, 0 cached · unit
245 files / 3651 · coverage 89.33 / 84.04 / 91.65 / 90.99 · forced build 12/12, 0 cached · docs
156/0 · ADR 48 · browser 264 passed + 1 skipped · configured telemetry 7 passed with collector POSTs
aborted (zero delivered) · restored stock 76 passed. Probe/worker logs: `/tmp/assay-r1-c-logs*`.

Design as shipped: `composeOverlayCastCheckSql` omits the non-edited base arm only when the edit set
is non-empty, the effective type equals the base type and the target equals the base type (the
cast pre-check keeps the scan); `commitWithRollback` runs an optional `validate` before `setActive`;
`useEditingSession` serializes every history-changing gesture on one mutation chain, so a `cell-set`
verdict and its activation cannot interleave — the retry bound and unchecked fallback are deleted;
the session-token abort governs both the resolve and reject outcomes. `row-insert` remains uncovered
(v1 inserts carry empty values). Worktree/branch removed after merge.

### 3.8 R1-A review round (2026-11-14)

`7f48e85` (11 files) passed the worker's full gate set and the forced-`mvp` mutation. The independent
reviewer re-derived every gate (unit 246/3661, coverage 89.34/84.05/91.66/91.00, browser 264+1,
configured 7/zero delivered, restored 76), re-extracted the upstream EH probe bytes and confirmed the
shipped constant is the `wasmExceptions` probe (not the threads/SIMD/bulk-memory neighbours), verified
the two `.eh.pinned` hashes and that only the fixture reads them, confirmed `grid-editing` is
untouched (0-line diff) and green, and reproduced the forced-`mvp` failure across all three assertions.

It returned **request-changes** on one item: the `wasm-cache` `wasm_eh` file-identity proof is
circular (the expected pinned path is derived with the fixture's own mapping), and the
serve-the-mvp-binary control still passed (`3 passed`) because DuckDB accepts the wrong-platform
extension bytes. Fix round (same branch): absolute basenames + literal byte counts
(3,045,039 / 820,646) for both `wasm_eh` legs, the suffix-swap mutation must then fail, plus an
optional fail-closed assertion for a platform-less autoload URL. A fresh re-review follows.

### 3.9 R1-A closure (2026-11-14)

Merged as **`b0b78bc`** (cherry-picked with `-x` from `41722ac`, branch
`fix/r1-a-honest-engine-errors`, base `837b638`; 11 files, +584/−65). Two independent review rounds:
round 1 verified the probe identity (re-extracted from the package), selector, binaries, scope, all
gates and the forced-`mvp` mutation, and required an absolute `wasm_eh` file pin because the fixture's
own mapping made the proof circular (the mvp binary is API-compatible enough to load, so the control
passed); round 2 reproduced that the absolute basename/byte pins (3,045,039 / 820,646) now fail under
the suffix swap and nothing else does, verified the optional platform-less abort pin, and approved.

Merged gates at `b0b78bc` (`/tmp/assay-r1-a-merged-logs/`): format/lint 0 · forced typecheck **20/20,
0 cached** · unit **246 files / 3661 tests** · coverage **89.34 / 84.05 / 91.66 / 91.00** · forced
build **12/12, 0 cached** · docs **156/0** · ADR **48** · configured telemetry **7 passed** (POSTs
aborted, zero delivered) · restored stock **76 passed**. The merged browser run was **263 passed +
1 skipped with 2 page-load flakes** (`column-ops:61`, `diff-panel:128`: `open-status` absent after
`goto('/')`, the documented host-load class); both passed on an isolated re-run (**19/19**), and the
branch's own full run was 265+1 green. Both results are recorded, not one claimed away.

Design as shipped: `bundle-select.ts` reproduces the package's own `getPlatformFeatures()` EH probe
(frozen, injectable `validate`, a throwing validator degrades to `mvp`; not exported from
`index.ts`); `worker.ts` imports all four `?url` pairs and passes exactly one to the unchanged core;
the e2e fixture serves the extension by platform tag (`wasm_eh` → `*.eh.pinned`, fail-closed) with
absolute file pins in `wasm-cache`; user-initiated surfaces now show the engine's real first line.
Web dist carries both pairs (+35,015,345 B raw; one fetched per session) so non-EH browsers keep the
opaque fallback. Worktree/branch removed after merge. **R1-B (desktop `eh`-only) is last.**

## 4. No-push, no-claim statement

No source, dependency, lockfile, protocol or visibility change was made by the investigation. The
fix rows are runtime changes under the normal gates; design/investigation delivery is not
implementation completion, and nothing here authorizes a push, release or publication.
