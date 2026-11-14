# R1 — masked engine errors: decision, investigation and fix rows

**Date:** 2026-11-14. **Status:** maintainer selected **R1** as a defect row and approved the
recommended fix; the web/engine fix row (**R1-A**) is dispatched, the desktop row (**R1-B**) is
queued after it. Nothing pushed.

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

| Row                                   | Scope                                                                                                                                                                                                                         | Status / dependency                                                                                                                                                     |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1-A** (web + engine core)          | `packages/engine-duckdb` bundle selection + asset wiring + unit tests; e2e real-message and corrupt-open assertions; platform-paired extension fixture (commit the `wasm_eh` Parquet/JSON binaries with checksums); changeset | **BLOCKED 2026-11-14** — implementation complete and green except two browser specs outside its reservation (§3.2); no commit, work preserved in `/tmp/assay-r1-a-wip/` |
| **R1-C** (edit-value check, proposed) | Make a staged cell-edit value's convertibility a pre-append engine check (reuse `overlayCastCheck`; skip its provably-redundant base arm when no cast is pending) and refuse with the existing value-free framing             | **AWAITING DECISION** — caused by R1-A exposing the gap (§3.2)                                                                                                          |
| **R1-B** (desktop)                    | `apps/vscode` vendored set → eh pair + `wasm_eh` autoload paths + build checksums/docs + spike harness update; changeset                                                                                                      | **PENDING** — queued after R1-A (shares the eh pinned binaries and the e2e fixture)                                                                                     |

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

## 4. No-push, no-claim statement

No source, dependency, lockfile, protocol or visibility change was made by the investigation. The
fix rows are runtime changes under the normal gates; design/investigation delivery is not
implementation completion, and nothing here authorizes a push, release or publication.
