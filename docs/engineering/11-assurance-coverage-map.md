# Assurance coverage map: critical contracts to their assertion bodies

**Added:** 2026-11-20 (improvement-plan row E03). **Baseline:** `06d8e20`
(`main`). **Status:** documentation + one bounded consistency check. No product
code, test, Vitest project, coverage floor or floor-relevant config changed by
this record.

This is a **map of critical contracts**, not a test census. It answers one
question a cold reader cannot answer from a coverage percentage: _for this
contract, which assertion body proves it, against what subject, in which runner,
with which prerequisites, and by which command?_ Everything here is anchored to
committed files; where a contract has no assertion yet, it is marked
**unavailable** instead of being described as covered.

The surrounding strategy is
[04-testing-security-quality.md](04-testing-security-quality.md); the local
tooling checks are [09-local-tooling-checks.md](09-local-tooling-checks.md).

## 1. How to read a row

- **Assertion body** — the committed file and the `describe`/`it` title (or the
  named scenario) that fails when the contract regresses. A title is quoted to
  be findable with search; the checker below verifies the **file**, never the
  title.
- **Subject** — what the assertion actually executes. The label is the honest
  part of this map: a fake provider cannot prove a real engine, and a Node
  number cannot prove the desktop webview.
- **Runner** — the Vitest project, Playwright config or host harness that
  sweeps the file, and the **prerequisite** that must hold for the row to mean
  anything.
- **Regression/mutation evidence** — §5. A newly claimed assurance needs proof
  that the assertion can fail (a mutant, a pre-fix probe, or an injected fault
  that reproduces the old behaviour). Historical coverage is not that proof.

### Subject vocabulary

| Label                 | Means                                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **fake**              | In-process test double: fake `GridDataProvider`, fake engine client, fake `SaveWritable`/file handle, injected `fs` seam, fake worker.           |
| **real temp FS**      | The real Node filesystem in `mkdtemp()` — real `open`/`write`/`close`/`unlink`, no browser and no DuckDB.                                        |
| **SQL-string-only**   | Pure TypeScript that emits or validates SQL **text** (plus the real compiler that produced it). No engine executes the SQL.                      |
| **worker fake**       | An in-process `EngineWorkerLike` double, not the shipped worker bundle.                                                                          |
| **real WASM-browser** | Real DuckDB-WASM worker in Chromium, served by the package harness page.                                                                         |
| **installed host**    | The real pinned VS Code extension host (`@vscode/test-electron`), rebuilding the production webview bundle.                                      |
| **requirement-only**  | The real product model over a fake engine client / fake file source, so the _product_ path is real and only the engine is injected.              |
| **model double**      | Replaces the model, not the provider — it encodes the intended contract, it does not exercise it. Listed only where a row would be over-claimed. |

## 2. Critical-contract map

| Contract (owner)                                                                       | Assertion body                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Subject                                                                                                                         | Runner                                              | Prerequisite                                                                                                                  | Command                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Filter list accepted / refused / reload-failed** (C01 design; C02a pending)          | `packages/grid/src/viewport-model.test.ts` › "setFilters filters windows, updates the exposed total, and pushes clear-then-specs"; "a rejected setFilters keeps the previous filter state serving"; `apps/web/src/App.profile-filter.test.tsx` › "surfaces the framed filter error and rolls back when the engine rejects the apply" (the accepted-then-`rowCount`-failed case, i.e. C01 case (b))                                                                  | fake (`FakeProvider`) for the grid pins; requirement-only for the web pin (real `GridViewportModel` over a fake `engineClient`) | node + web Vitest projects                          | none (no browser, no worker, no DuckDB)                                                                                       | `pnpm exec vitest run --project node packages/grid/src/viewport-model.test.ts` and `pnpm exec vitest run --project web apps/web/src/App.profile-filter.test.tsx`                                                                                  |
| **CSV declared types: a repeated name is refused, never overwritten** (B01)            | `apps/web/src/csv/options.test.ts` › "declared types — a repeated column name is refused, never overwritten (B01)"; `apps/web/src/csv/CsvReviewDialog.test.tsx` › the refusal is surfaced; `tests/e2e/csv-preview.spec.ts` › the browser refusal leg                                                                                                                                                                                                                | fake (pure option builder) + real WASM-browser for the e2e leg                                                                  | web + node Vitest projects; Playwright (e2e leg)    | e2e leg only: `pnpm build`, Chromium, ports 4173/4179/4180                                                                    | `pnpm exec vitest run --project web apps/web/src/csv/options.test.ts apps/web/src/csv/CsvReviewDialog.test.tsx`                                                                                                                                   |
| **Export acquire → write → close, browser FSA** (B03)                                  | `apps/web/src/export/save-destination.test.ts` › "writeExportCopy — the writable failure lifecycle (B03)" (8 pins: read-first, `createWritable` failure, abort-once, abort-failure cannot replace the primary error, no-`abort` shape, close-failure abort, success closes once and never aborts, value-free reason); `apps/web/src/export/ExportDialog.test.tsx` › "B03: a writable write/close failure shows the error and no success line"                       | fake (`SaveWritable` / handle structural fakes, fake OPFS scratch reader)                                                       | web Vitest project                                  | none                                                                                                                          | `pnpm exec vitest run --project web apps/web/src/export/save-destination.test.ts apps/web/src/export/ExportDialog.test.tsx`                                                                                                                       |
| **Export create-only writer: phased acquire/write/close** (B04)                        | `apps/vscode/src/pure/create-only-writer.test.ts` › "create-only export writer" (real temp FS: refusal, cancellation, replacement inode, source alias, delivered bytes) + "create-only export writer — acquisition and cleanup fault injection" (injected `CreateOnlyWriterFs`: stat/sync/lstat/close/unlink faults, short and zero-progress writes)                                                                                                                | real temp FS + fake (`CreateOnlyWriterFs` seam)                                                                                 | node Vitest project                                 | a writable temporary directory; no VS Code, no DuckDB                                                                         | `pnpm exec vitest run --project node apps/vscode/src/pure/create-only-writer.test.ts`                                                                                                                                                             |
| **DCR new-file write: residue is explicit, never "nothing written"** (B05)             | `apps/cli/src/dcr.test.ts` › "writeDcrArtifactNew — failed-write residue (B05)"; `apps/cli/src/dcr.integration.test.ts` › "assay dcr — failed-write residue is explicit (B05)"                                                                                                                                                                                                                                                                                      | fake (`fs` seam) + real temp FS through the compiled CLI                                                                        | node + cli-integration Vitest projects              | compiled CLI (`apps/cli/dist`) — the `test`/`test:coverage` scripts build it                                                  | `pnpm exec tsc --build apps/cli/tsconfig.build.json && pnpm exec vitest run --project cli-integration apps/cli/src/dcr.integration.test.ts`                                                                                                       |
| **Replacement candidate: one token, stale candidates never adopt** (WF-06)             | `apps/web/src/replace/machine.test.ts` › "WF-06 machine — late-result identity (T10)" / "rejects a superseded sequence"; `apps/web/src/App.replace.test.tsx` › "adopts a clean replacement synchronously and retires the previous app-local request", "keeps the live session when the candidate BASE schema read fails before the provider exists (T9b)"; `apps/web/src/App.lifecycle.test.tsx` › "AR-W13 — openDataFile completion guard"                         | fake (pure machine values) + requirement-only (real `App` over fake engine client/file source)                                  | web Vitest project                                  | none                                                                                                                          | `pnpm exec vitest run --project web apps/web/src/App.replace.test.tsx apps/web/src/replace/machine.test.ts apps/web/src/App.lifecycle.test.tsx`                                                                                                   |
| **Wire refusal: untrusted engine payloads are rejected pre-execution**                 | `packages/engine-duckdb/src/overlay-wire.test.ts` › "parseOverlayPayload — hostile engine type expressions"; `validate-plan-wire.test.ts` › "assertValidationPlanRelationBinding (executor-side semantic gate)" (zero-SQL, comment, string-masked and multi-statement refusals); `diff-plan-wire.test.ts` › "refuses a comment-bearing query", "refuses a pseudo-reference hidden inside a string literal"; `protocol.test.ts` › the request/response parser matrix | SQL-string-only (real compiler output + pure parsers)                                                                           | node Vitest project                                 | none                                                                                                                          | `pnpm exec vitest run --project node packages/engine-duckdb/src/overlay-wire.test.ts packages/engine-duckdb/src/validate-plan-wire.test.ts packages/engine-duckdb/src/diff-plan-wire.test.ts packages/engine-duckdb/src/protocol.test.ts`         |
| **Wire refusal, real engine** (same contract, executed)                                | `tests/e2e/engine-conformance.spec.ts` › "conformance: overlay-hostile-types-rejected"; `tests/e2e/engine-overlay.spec.ts` › the same scenario on the harness page                                                                                                                                                                                                                                                                                                  | real WASM-browser                                                                                                               | Playwright (root config)                            | `pnpm build`, Chromium, ports 4173/4179/4180                                                                                  | `pnpm build && pnpm exec playwright test tests/e2e/engine-conformance.spec.ts --grep overlay-hostile-types-rejected`                                                                                                                              |
| **Repair undo: one history entry, one refold undo step** (ADR 0050)                    | `apps/web/src/App.repair.test.tsx` › "repair — Apply is one history entry and one undo step"; `packages/domain/src/history.test.ts` › "history — undo/redo payloads and the fold contract" and the branch-truncation ruling; `packages/engine-duckdb/src/overlay-repair-query.test.ts` › "composes multi-repair prefixes as stacked projection layers" + the pinned-CLI differential blocks                                                                         | requirement-only (web); pure domain values (node); SQL-string-only + pinned CLI agreement                                       | web + node Vitest projects                          | `DUCKDB=/tmp/duckdb` for the `describe.skipIf(!hasDuckDbCli)` agreement blocks (absent ⇒ those blocks skip, they do not fail) | `DUCKDB=/tmp/duckdb pnpm exec vitest run --project web apps/web/src/App.repair.test.tsx` and `DUCKDB=/tmp/duckdb pnpm exec vitest run --project node packages/domain/src/history.test.ts packages/engine-duckdb/src/overlay-repair-query.test.ts` |
| **Repair undo, real engine/browser**                                                   | `tests/e2e/repair-journey.spec.ts` › "maps a column: complete counts, bounded examples, one history entry, undo/redo" (undo is one step)                                                                                                                                                                                                                                                                                                                            | real WASM-browser                                                                                                               | Playwright (root config)                            | `pnpm build`, Chromium, ports                                                                                                 | `pnpm build && pnpm exec playwright test tests/e2e/repair-journey.spec.ts`                                                                                                                                                                        |
| **Diff: explicit confirmation, stale revisions stay stale**                            | `apps/vscode/src/pure/diff-controller.test.ts` › "requires explicit confirmation and validates names as an array without comma splitting", "discloses inference candidates and does not make a staged state runnable without confirmation", "correlates by id and generation, and retains old reports as stale after revision changes"                                                                                                                              | fake (pure controller over value objects; no `vscode` API)                                                                      | node Vitest project                                 | none                                                                                                                          | `pnpm exec vitest run --project node apps/vscode/src/pure/diff-controller.test.ts`                                                                                                                                                                |
| **Diff, real host (desktop) and web**                                                  | `apps/vscode/test/e2e/dataset-runner.ts` › the `stagedDiff` and `datasetDiffCommand` scenarios; `apps/web/src/diff/diff-model.test.ts` (web model) + `tests/e2e/diff-panel.spec.ts` (web browser)                                                                                                                                                                                                                                                                   | installed host; web model fake + real WASM-browser                                                                              | extension host; node/web Vitest; Playwright         | pinned VS Code 1.130.0 (`~/.vscode-test`), `DUCKDB`, `xvfb-run` when headless; web e2e: `pnpm build` + ports                  | `DUCKDB=/tmp/duckdb pnpm --filter @assay/vscode run e2e`; web assertions: `pnpm exec vitest run --project web apps/web/src/diff/diff-model.test.ts`                                                                                               |
| **Canonical DCR artifact bytes** (format v1, ADR 0046)                                 | `apps/cli/src/dcr.test.ts` › "creates a new file with the exact bytes", "returns the UTF-8 BYTE length, not the character count", "renders the gated-written human report byte-exactly"; `packages/pipeline/src/dcr-conformance.test.ts` › "p3-5 round-trip sweep: every committed fixture parses and re-serializes byte-identically"; `apps/cli/src/dcr.integration.test.ts` › "the golden gated end-to-end journey"                                               | real temp FS + the real `@assay/pipeline` compiler; cli-integration runs the compiled CLI in a fresh process                    | node + cli-integration Vitest projects              | compiled CLI for the integration project                                                                                      | `pnpm exec tsc --build apps/cli/tsconfig.build.json && pnpm exec vitest run --project cli-integration apps/cli/src/dcr.integration.test.ts`                                                                                                       |
| **Disposal completion: every `dispose()` caller awaits one teardown** (C04)            | `packages/engine-duckdb/src/client.test.ts` › "DuckDbEngineClient disposal settlement (C04)" (deferred graceful reply, no reply, terminal-while-pending, post failure, worker crash, before boot, failed boot, boot/dispose race)                                                                                                                                                                                                                                   | worker fake (`EngineWorkerLike`)                                                                                                | node Vitest project                                 | none                                                                                                                          | `pnpm exec vitest run --project node packages/engine-duckdb/src/client.test.ts`                                                                                                                                                                   |
| **Disposal completion, real engine**                                                   | `tests/e2e/engine-duckdb.spec.ts` › "every dispose() caller awaits the same real-engine teardown (C04)"                                                                                                                                                                                                                                                                                                                                                             | real WASM-browser                                                                                                               | Playwright (root config)                            | `pnpm build`, Chromium, ports 4173/4179/4180                                                                                  | `pnpm build && pnpm exec playwright test tests/e2e/engine-duckdb.spec.ts --grep "dispose() caller"`                                                                                                                                               |
| **Exact-value conformance: a count-preserving value corruption fails** (C05)           | `packages/testing/src/engine-conformance.test.ts` › "predicate-error-reuse: detects a count-preserving anchor value corruption" (the `corruptsAnchorValue` mutant of the compliant fake); the scenario body is in `packages/testing/src/engine-conformance.ts`                                                                                                                                                                                                      | fake (in-memory compliant engine + one mutated engine)                                                                          | node Vitest project                                 | none                                                                                                                          | `pnpm exec vitest run --project node packages/testing/src/engine-conformance.test.ts`                                                                                                                                                             |
| **Exact-value conformance, real engine**                                               | `tests/e2e/engine-conformance.spec.ts` › "conformance: predicate-error-reuse passes against the real DuckDB-WASM client"                                                                                                                                                                                                                                                                                                                                            | real WASM-browser                                                                                                               | Playwright (root config)                            | `pnpm build`, Chromium, ports                                                                                                 | `pnpm build && pnpm exec playwright test tests/e2e/engine-conformance.spec.ts --grep predicate-error-reuse`                                                                                                                                       |
| **File acquisition retry: a failed attempt retries, a fulfilled one never does** (B06) | `packages/data-sources/src/browser-file-source.test.ts` › "BrowserFileSource — deliberate acquisition retry semantics (B06)"; `packages/testing/src/data-source-behavior.test.ts` › the shared `acquisition-retry` scenario incl. its mutation set; `tests/e2e/data-source-behavior.spec.ts` › the same suite in the browser                                                                                                                                        | fake (source doubles) + real-WASM-browser harness leg                                                                           | node Vitest project; Playwright for the browser leg | browser leg: `pnpm build`, Chromium, ports 4180 (+4173/4179 for the shared suite)                                             | `pnpm exec vitest run --project node packages/data-sources/src/browser-file-source.test.ts packages/testing/src/data-source-behavior.test.ts`                                                                                                     |

### 2.1 Rows that must not be read as assurance

- **C01/C02a filters.** The whole-list transaction contract (T1–T13, optional
  `replaceFilters`, `FilterApplyError`, `filtersUnknown`/`reloadError`) is
  **[design only](../process/handoff/20261120-c01-filter-transaction-contract.md)**;
  `replaceFilters` and `FilterApplyError` do not exist in this checkout, so the
  C02a assertion set is **unavailable**, not "covered by the rows above". What
  the rows above prove is the legacy per-call protocol plus the caller-side
  rollback that C02b is chartered to delete. `apps/web/src/grid/FilterBar.test.tsx`
  asserts against a **model double** (`fakeModel`/`storeModel`/`blockingModel`),
  so it cannot prove a provider rejection path.
- **C03a callback-failure contract** is likewise design-only; reset/activation
  fault assertions are not claimed anywhere in this map.
- **Desktop webview controllers.** Only the extracted pure modules
  (`apps/vscode/src/pure/**`) have Node subjects; the webview itself has none
  (§4.2).

## 3. Runner matrix

| Runner                      | Sweeps                                                                                                                                                      | Command                                                                                                                     | Prerequisites                                                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Vitest `web` (happy-dom)    | `apps/web/src/**/*.test.{ts,tsx}`                                                                                                                           | `pnpm exec vitest run --project web <paths>`                                                                                | none                                                                                                                              |
| Vitest `node`               | `packages/*/src/**/*.test.ts`, `apps/cli/src/**/*.test.{ts,tsx}` (integration files excluded), `apps/vscode/src/pure/**/*.test.ts`, `scripts/**/*.test.mjs` | `pnpm exec vitest run --project node <paths>`                                                                               | `DUCKDB=/tmp/duckdb` for the `skipIf` CLI-agreement blocks                                                                        |
| Vitest `cli-integration`    | `apps/cli/src/**/*.integration.test.ts`                                                                                                                     | `pnpm exec tsc --build apps/cli/tsconfig.build.json && pnpm exec vitest run --project cli-integration <paths>`              | compiled CLI; a real temp dir; 20 s per-test budget (contention, not a relaxed assertion)                                         |
| All Vitest projects         | the three above                                                                                                                                             | `pnpm test` (and `DUCKDB=/tmp/duckdb pnpm test:coverage` for the recorded coverage artifact)                                | `DUCKDB` for CLI agreement; nothing else                                                                                          |
| Playwright (root config)    | `tests/e2e/**/*.spec.ts`                                                                                                                                    | `pnpm build && pnpm test:e2e` (or `pnpm exec playwright test <spec>`)                                                       | `pnpm build`; Chromium cache; ports 4173/4179/4180 free (override with `ASSAY_E2E_PORT_WEB/ENGINE/DS`)                            |
| Playwright (visual configs) | `tests/visual/panel-recovery.spec.ts`; `tests/visual/telemetry-disclosure-theme.spec.ts` + `tests/visual/workbench-help-disclosure.spec.ts`                 | `pnpm exec playwright test --config tests/visual/playwright.panel-recovery.config.ts` (telemetry leg: the telemetry config) | `pnpm build`; ports 4473/4479/4480; the telemetry leg needs a build with `ASSAY_TELEMETRY_ENDPOINT` and blocks collector requests |
| Extension host              | `apps/vscode/test/e2e/dataset-runner.ts`                                                                                                                    | `pnpm --filter @assay/vscode run e2e`                                                                                       | pinned VS Code `1.130.0` in `~/.vscode-test`, `DUCKDB=/tmp/duckdb`, `xvfb-run` on a headless box, `CI=1` selects the pinned cache |
| Node test (not Vitest)      | `apps/vscode/test/vscode-runtime.test.mjs` (runtime-selection policy)                                                                                       | `pnpm --filter @assay/vscode run test:runtime`                                                                              | none                                                                                                                              |

`pnpm test:e2e` and `pnpm test:coverage` do **not** imply each other: the
coverage artifact comes from Vitest only, and the browser/desktop rows above are
outside it.

## 4. What the Node coverage number measures — and what it does not

### 4.1 The measured artifact

| Fact               | Value                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Commit             | `06d8e20c918ce488c4c359158358e630941cae3e` (HEAD at measurement; only this record's `docs/` and `scripts/` files differed from it, and neither is inside the coverage include) |
| Coverage config    | `vitest.config.ts`, sha256 `87e3bc78cc2f980c344def5b222a6519d386f9a8e27df3ce8a9503b8b9352e85`                                                                                  |
| Command            | `DUCKDB=/tmp/duckdb pnpm test:coverage` (i.e. `tsc --build apps/cli/tsconfig.build.json` then `vitest run --coverage --testTimeout=20000`)                                     |
| Measured at (UTC)  | 2026-11-20T16:01:35Z (`coverage/coverage-summary.json` written)                                                                                                                |
| Runtime            | Node `v24.13.0`, pnpm `11.26.0`, Linux x86_64, 16 CPUs, `coverage` v8 provider                                                                                                 |
| Exit               | 0 — 270 test files / 4 221 tests passed, thresholds held, no test failed                                                                                                       |
| Wall time          | 42.6 s (Vitest reports 41.2 s)                                                                                                                                                 |
| Statements         | **89.71 %** (19 462 / 21 693)                                                                                                                                                  |
| Branches           | **84.45 %** (13 003 / 15 397)                                                                                                                                                  |
| Functions          | **91.79 %** (3 166 / 3 449)                                                                                                                                                    |
| Lines              | **91.39 %** (17 592 / 19 249)                                                                                                                                                  |
| Denominator        | **277 non-test source modules** (every `apps/*/src` + `packages/*/src` module; test files are excluded by Vitest)                                                              |
| Floors (unchanged) | statements 83, branches 76, functions 80, lines 84                                                                                                                             |

The artifact is `coverage/coverage-summary.json` + the text table; **neither is
committed** (`.gitignore` carries `coverage/`). Regenerate it with the command
above; a docs-only commit like this record cannot change it, because nothing
under `apps/*/src` or `packages/*/src` changed.

Scope honesty: `vitest.config.ts` pins a broad `include`
(`apps/*/src/**/*.{ts,tsx}`, `packages/*/src/**/*.{ts,tsx}`) so untested modules
stay in the denominator at 0 %. Fifteen modules currently sit at 0 %
statements; the desktop host modules are among them (§4.2). The numbers above
are **not** comparable to a report produced with a narrower include.

### 4.2 The desktop webview has no Node instrumentation coverage

- The desktop webview lives in `apps/vscode/webview/**` (8 modules, 5 112 lines:
  `main.ts`, `dataset.ts`, `data-grid.ts`, `engine-boot.ts`, `engine-session.ts`,
  `grid-provider.ts`, `worker.ts`, `grid-audit.ts`) — **outside** the
  `apps/*/src/**` include. It appears in the coverage report **at no line**, not
  at 0 %: there is no Node instrumentation for it at all, and adding a webview
  glob would report 0 % "execution" for code that only ever runs in a webview.
  This map deliberately does not add one.
- The host-side desktop modules that **are** inside the include are measured at
  **0 %** by the Node run — `apps/vscode/src/extension.ts`, `dataset.ts`,
  `assets.ts`, `git-adapter.ts`, `webview-html.ts` and
  `apps/vscode/src/pure/overlay-snapshot.ts`. Their only real execution is the
  extension-host e2e (§4.3); 0 % here is a boundary marker, not proof the code
  is untested, and a non-zero number there would not be proof either.
- The extracted pure modules (`apps/vscode/src/pure/**`) **are** meaningfully
  measured: `create-only-writer.ts` 97.61 %, `diff-controller.ts` 100 %,
  `validation-controller.ts` 90.47 %, `edit-controller.ts` 91.35 % statements in
  this artifact. That is the payoff of the pure extraction, and exactly why a
  webview glob is the wrong fix.
- A browser coverage collector for the webview, or a floor for a new scope, is a
  **separate config decision with its own floor decision** — not implied here.

### 4.3 Desktop contracts covered by the extension-host e2e instead

`pnpm --filter @assay/vscode run e2e` rebuilds the production bundle and asserts
these through the real host + webview + vendored engine (scenarios in
`apps/vscode/test/e2e/dataset-runner.ts`):

| Desktop contract                                                      | Scenario fact asserted                                                                     |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Command open, byte bridge, engine boot, grid render, a11y             | `commandOpen`: outcome/format/columns/rows, `gridRendered`, `gridAuditOk`                  |
| Contributed custom editor                                             | `customEditor`: same file through `assay.datasetViewer`                                    |
| Real DOM cell edit, undo/redo, branch truncation                      | `editProof`: cell identity, Escape cancel, undo/redo, insert/delete, query state preserved |
| Effective validation + stale-after-edit + logical nav                 | `effectiveValidation`: baseline/edited/inserted/deleted failures, stale flag               |
| Staged diff confirmation and command-diff refusal                     | `stagedDiff`, `datasetDiffCommand`                                                         |
| Create-only export then reopen through the real engine                | `safeExport`: created, reopened, rows/columns/bytes agree                                  |
| Hostile type refusal / missing file / unsupported format / empty file | `fullViewCastRefusal`, `missingFile`, `unsupportedFormat`, `emptyFile`                     |
| Git context                                                           | `gitContext`                                                                               |
| MVP acceptance chain (scenario 11)                                    | `acceptance`                                                                               |
| Offline JSON/JSONL open                                               | `offlineJsonJsonl`                                                                         |

None of these appear in the Node coverage artifact, and none of them are claimed
as unit coverage.

## 5. Regression / mutation evidence for claimed assurance

A row in §2 claims only what §5 can back. The rule for **new** assurance (a new
contract, a new scenario, a new "covered" claim): the author must show the
assertion _fails_ without the fix — a killed mutant, a pre-fix probe output, or
an injected fault that reproduces the old behaviour. A green suite alone is not
evidence, and "it was covered before" is not evidence.

Evidence already recorded in this repository (links are the changesets and
commit bodies that made the claim; nothing below is a new measurement):

| Contract | Evidence recorded                                                                                                                                                                                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B01      | Refusal assertions added with the fix (`41850c2`, `.changeset/b01-csv-duplicate-columns.md`); no separate mutant drill is recorded — the pins are the repeated-name, case-sensitivity, blank-line-numbering, `__proto__` and byte-identity cases.                                                |
| B03      | Failure-boundary assertions added with the fix (`0cf8044`, `.changeset/b03-writable-failure-cleanup.md`); each is an injected fault (read, `createWritable`, write, abort, close). No pre-fix probe is claimed.                                                                                  |
| B04      | `.changeset/b04-create-only-writer-cleanup.md` records the pre-fix probes (post-close cleanup deleted a delivered file → ENOENT; a write after close leaked a raw `file closed` instead of `write-failed`) plus the injected `fs`-seam fault matrix (`170177c`).                                 |
| B05      | `.changeset/b05-dcr-write-residue.md` records the injected `fs` seam (write/close/cleanup faults, short and zero-progress writes, concurrent creation, replacement before the identity check, unverifiable identity) and the real temp-FS integration legs (`ee0b841`).                          |
| B06      | `.changeset/b06-identity-guarded-retirement.md` records the reviewer's killed mutation (`this.#file = null` identity-blind clear) and the re-entrant acquisition test that catches it (`a93460d`); `.changeset/b06-file-acquisition-retry.md` carries the retry semantics + the shared scenario. |
| C02a     | **Unavailable.** No implementation, test or mutation evidence exists in this checkout; the C01 record is a design.                                                                                                                                                                               |
| C04      | `.changeset/c04-shared-engine-disposal.md` records the regression (second/racing `dispose()` resolving before teardown) fixed in `c32a0e9`, with the worker-fake settlement pins plus the real-engine e2e (`tests/e2e/engine-duckdb.spec.ts`).                                                   |
| C05      | `.changeset/c05-conformance-exact-values.md` records the `corruptsAnchorValue` mutant that passed the old count-only anchor and now fails (`f83fd96`).                                                                                                                                           |
| C01/C03a | Design records only ([filter](../process/handoff/20261120-c01-filter-transaction-contract.md), [callbacks](../process/handoff/20261120-c03-callback-failure-contract.md)); no assertion is claimed here.                                                                                         |

## 6. The consistency check: `pnpm assurance-map:check`

`scripts/check-assurance-map.mjs` is a bounded, offline, zero-dependency check
(regression-tested by `scripts/check-assurance-map.test.mjs`, which the `node`
Vitest project already sweeps via its `scripts/**/*.test.mjs` include). It
verifies four facts and nothing else:

1. `map-exists` — this document exists and still carries its `| Contract |`
   table header.
2. `assertion-paths-exist` — every backticked repo-relative path it names
   (`apps/…`, `packages/…`, `tests/…`, `scripts/…`, `docs/…`, `fixtures/…` plus
   the root configs) resolves on disk.
3. `runner-classified` — every **test** file it names is swept by a Vitest
   project `include` (minus that project's `exclude`), a Playwright
   `testDir`/`testMatch`, or a declared extension-host runner.
4. `runner-scripts-exist` — the runner scripts/manifests it depends on exist and
   the root `package.json` declares `test`, `test:coverage`, `test:e2e` and
   `assurance-map:check`.

```bash
pnpm assurance-map:check        # exit 0 clean, 1 drift (prints map:line findings)
```

**It does not claim semantic freshness.** It cannot see whether a named
`it` still asserts the contract, whether the subject/environment/command cells
are right, or whether a row's coverage number is current. It catches the two
drifts that are cheap and real: a renamed/deleted assertion file, and a test file
that no runner sweeps any more (the config restructured under the map).

## 7. Limits of this map

- **Not exhaustive.** Rows are the contracts the improvement plan and the
  ADRs name as critical; the remaining suites are covered by their own package
  documentation and by the gates, not listed here.
- **Titles, not line numbers,** identify assertions, so a title edit makes a
  quoted title stale without failing anything. The file-level check above is the
  only automated guard.
- **Freshness is timestamped, not live.** The §4.1 numbers describe
  `06d8e20` with the recorded config hash. Re-measure; do not carry them
  forward.
- **Prerequisites are marked, not enforced.** A `DUCKDB`-less machine makes the
  pinned-CLI agreement blocks skip; the extension-host row needs the pinned VS
  Code cache. Skipped blocks are not passing evidence.
- **No test-census duplication.** The map intentionally omits the ~270 Vitest
  files, the ~65 Playwright specs and the visual configs' individual tests;
  `pnpm test`, `pnpm test:e2e` and the extension-host harness are the census.
