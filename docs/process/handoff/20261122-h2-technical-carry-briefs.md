# H2 — technical carry briefs (2026-11-22)

**Date:** 2026-11-22. **Base:** `main` at `6b2c9fd`. **Status:** dispatch-ready briefs; nothing here
is selected or authorised by being written down. Companion entry point:
[remaining-work index](20261122-remaining-work-handoffs.md) (§0 verification protocol, §1 item index,
§2 dispatch envelope). **Line anchors drift:** every `path:line` in these briefs and in the records
they cite was verified at the base or earlier — re-verify before editing, and record a fresh SHA.

R-8 … R-14 cover the engineering carries left after the 2026-11-21 batches. Status vocabulary used
below: `READY` (dispatchable once the stated selection is recorded), `SPEC-READY` (a named spec
record is the contract; implement from it), `PROBE-FIRST` (the probe gates everything that follows),
`MEASUREMENT-ONLY` (no code change in this item). Authority order is the
[index](20261122-remaining-work-handoffs.md)'s: accepted ADRs first, then the living
[handoff](../handoff.md) current-state block, the [successor queue](20261121-successor-queue.md)
§8/§9, the [decision round](20261121-decision-round.md), dated design records, then these briefs.

---

### R-8 — B3 diff staging registry lifecycle

**Status:** SPEC-READY
**Row/source:** [successor queue](20261121-successor-queue.md) §3 B3 row and §8.1 ledger row
("DESIGN-CLOSED"); [B3 spec](20261121-b3-registry-lifecycle-spec.md) — ADR 0047 verdict §1, verified
leak §2, contract §3, byte-invariance §4, recorded alternative §5, verification plan §6, reserved
files §7, maintainer decisions §8.
**Why it is open:** every comparison staging attempt opens the comparison file a second time as a
regular table to obtain profile aggregates (`apps/web/src/sessions/useDiffSession.ts:129-133`:
`stageComparison` + `engineClient.open(source)` + `engineClient.profile(handleB)`), and nothing
releases that handle: one orphaned `assay_tN` view plus one file registration per attempt that
reaches a successful `open`, alive until tab unload (`engine/dispose` is the only release — B3 §2).
B3 designed the fix as PROPOSED; nothing is implemented and its §8 selections are unmade.

**Contract (already decided — do not reopen):**

- **ADR 0047 boundary (repeat, it is the guard):** widening `closeTable` to reclaim
  replacement-path retired tables is the ADR's own supersession trigger — stop and draft an ADR that
  supersedes [ADR 0047](../../adr/0047-web-session-replacement-retains-retired-tables.md) rather
  than rewriting it (B3 §1). The diff staging registry (`assay_diff_dN`, single slot) is a different
  population from the web session; this item never releases replacement-path or live-session tables.
- **Lanes are fixed:** `profileComparison` joins the query lane (profile-class scan, like
  `engine/profile`); `closeTable` joins the registry lane (like `engine/open`/`engine/dispose`) —
  [ADR 0040](../../adr/0040-two-op-lanes-in-engine-worker.md) two lanes, no third lane (B3 §3.1–3.2).
- **Byte-invariance (B3 §4):** the CSV preview payload and retention rules
  ([ADR 0049](../../adr/0049-csv-options-preview-and-retention.md)), the DCR artefact format
  ([ADR 0046](../../adr/0046-dcr-artifact-format-v1.md)), the repair composition shape
  ([ADR 0051](../../adr/0051-column-repair-composition-shape.md)), the diff result wire
  (`EngineRowDiffResult`) and `buildDiffPanelReport` output are untouched, and `engine/profile-result`
  keeps its exact shape. The only wire delta is the additive optional `transient: true` field on
  `engine/open` (absent = today's behaviour) plus the new request/response types.
- **Identity and refusals (B3 §3.3–3.4):** `assay_tN` view names stay engine-generated and are never
  accepted from the wire ([ADR 0025](../../adr/0025-telemetry-and-data-privacy-boundary.md) posture);
  comparison and preview slots are not table handles and are refused. Refusal categories are closed:
  `unknown-handle`, `already-closed` (bounded tombstone set, distinguishable from never-existed),
  `wrong-identity` (untagged handles — live session table, ADR 0047 retired table, pipeline
  `registerView` handle — and comparison/preview ids), `busy` (in-flight consumer; refuse, never
  silently defer). All refusals fire pre-execution, before any DuckDB call (`parseEngineRequestDetailed`,
  `packages/engine-duckdb/src/protocol.ts`).
- **Release pattern and lifetime:** drop the view (`DROP VIEW IF EXISTS`) and file registration
  best-effort, both halves swallowed on failure (the established `packages/engine-duckdb/src/csv-dispatch.ts`
  pattern); `engine/dispose` remains terminal. Live result pages survive a close (web-side snapshots,
  never re-query the closed handle — B3 §3.5). Recommended migration manufactures **zero** transient
  tables per comparison; the comparison slot stays ≤ 1 (B3 §3.6). No memory magnitude is claimed
  (B3 §9).

**The choice this item still needs** (B3 §8 — record the selections on the envelope's `DECISIONS`
line before implementing):

- **Op set.** (a) Both ops — B3's recommended shape (`profileComparison` removes the leak at source;
  scoped `closeTable` for any remaining transient use). (b) `profileComparison` alone — fixes the
  leak; drops the close/tombstone/identity machinery entirely. (c) The recorded alternative (B3 §5):
  keep accumulation with a bound and record it — zero code, but the carry-over stays open as
  user-triggered unbounded growth, and ADR 0047 must not be re-used as cover for it. Consequence of
  (a)/(b): the transient `useDiffSession` open is deleted either way; (c) leaves the leak and needs
  no engine change.
- **Small selections:** op naming (`profileComparison` vs `profileComparisonView`; `closeTable` vs
  `releaseTable` — ADR 0047 quotes both spellings); retention window (immediate drop recommended);
  refusal copy (engine errors stay masked per the AR-2/R1 posture — copy is a selection); cap K for
  unclosed transient handles if the transient-open variant survives (B3 §3.6); explicit scope
  confirmation that the replacement-path population stays out of scope (B3 §8).

**Files (reserved)** (B3 §7): `packages/engine-duckdb/src/protocol.ts`, `client.ts`,
`engine-executor.ts`, `table-registry.ts`, `comparison-registry.ts`;
`apps/web/src/sessions/useDiffSession.ts`; tests `packages/engine-duckdb/src/client.test.ts`,
`engine-executor.test.ts`, `protocol.test.ts`, `packages/testing/src/engine-conformance.ts`, web
session/diff tests, `tests/e2e/engine-profile.spec.ts`, `tests/e2e/diff-panel.spec.ts`; changesets
`@assay/engine-duckdb` (minor — new ops) and `@assay/web` (caller), `@assay/testing` if the
conformance surface grows. Wiring precedent for a new typed engine op: ENG-2's
`packages/engine-duckdb/src/repair-preview-query.ts` plus its client/protocol/executor wiring
(`d457eec`).

**Implementation steps** (shape (a); where (b) or (c) diverge it is named):

1. `packages/engine-duckdb/src/protocol.ts` — additive optional `transient?: boolean` on
   `engine/open`; new `engine/profile-comparison` (`{ comparisonId }` → the existing
   `engine/profile-result` payload) and `engine/close-table` (`{ tableId }` → `engine/table-closed`)
   request/response types and parse paths; refusals parse-time.
2. `packages/engine-duckdb/src/table-registry.ts` — transient tagging of entries created by a
   transient open, bounded closed-tombstone set, and (only if a transient variant survives) cap K.
3. `packages/engine-duckdb/src/engine-executor.ts` — `profileComparison` resolves `assay_diff_dN`
   through `comparison-registry.ts` and profiles it directly (query lane); `closeTable` drops view +
   file registration then removes the entry (registry lane); `busy` tracking for in-flight consumers;
   tombstone bookkeeping.
4. `packages/engine-duckdb/src/client.ts` — `profileComparison(comparisonId)` and
   `closeTable(tableId)` methods; the profile result keeps the `EngineDatasetProfile` shape so
   `toDiffProfile` and the diff model consume it unchanged.
5. `apps/web/src/sessions/useDiffSession.ts` — in `handleComparisonFile`, delete the
   `engineClient.open(source)` / `engineClient.profile(handleB)` pair and call `profileComparison`
   after `stageComparison`; the seq-guard and failure paths (B3 §3.7) are unchanged.
6. Conformance scenarios and changesets per §6/§7 above. Shape (c) replaces steps 1–6 with a
   documentation-only record of the bound.

**Tests:**

- **Leak test (required):** stage N ≥ 3 comparisons including one failed stage and one superseded
  in-flight stage, then assert the registry size equals the pre-stage baseline
  (`TableRegistry.size`, `packages/engine-duckdb/src/table-registry.ts`) and the comparison slot
  count stays ≤ 1 — "N comparisons then registry size back to baseline" (B3 §6.3).
- **Real-engine conformance** (`packages/testing/src/engine-conformance.ts`): `profile-comparison`
  stats equal the same dataset's `profile()` output; the leak scenario as a variant, via the existing
  `registeredTableCount` probe.
- **Hostile-wire / pre-execution:** malformed `comparisonId`/`tableId`, unknown request types and
  extra fields refused at parse; `wrong-identity` close on the live session handle and on a
  comparison id refused before any DuckDB call; `busy` refused while a query-lane op holds the
  handle; `already-closed` distinguished from `unknown-handle` (B3 §6.2).
- **Mutation drill (one minimum):** make `profileComparison` fall back to open+profile (or delete the
  close-in-`finally` if the transient variant is kept) → the leak test must fail; widen the
  `transient` identity check to accept any handle → the `wrong-identity` test must fail (B3 §6.4).

**Gates:** targeted first — `pnpm exec vitest run` over the named engine/testing/web suites — then
the [index](20261122-remaining-work-handoffs.md) §0 local suite. Task-specific leg: real DuckDB CLI
conformance (the real-engine agreement suites need `DUCKDB=/tmp/duckdb`, pinned CLI v1.5.5) and the
diff-panel/engine-profile e2e journeys (`pnpm test:e2e`).

**Evidence to record:** the selected op set and §8 selections; the leak-test counts (N staged, failed
and superseded stages included, registry size before/after, comparison slot count); the conformance
scenario output; the refusal matrix exercised with pass/fail per category; the mutation drill result
(each mutation naming the test that failed); changeset list; gate command tails.

**Stop rules:** widening `closeTable` to replacement-path tables (ADR 0047 supersession — stop for an
ADR); any wire or persisted-format change beyond the additive `transient` field and the new types; a
cap/memory change (K is a selection, not an invitation to raise existing caps); a package-boundary
crossing outside the reserved files; byte drift in the §4 payloads; any claim about memory
magnitudes (none are measured).

**Done-when:** staging any number of comparisons manufactures zero `assay_tN` views (or the recorded
bound holds under (c)), the registry returns to its pre-comparison baseline after every cycle, the
diff panel behaves and renders byte-identically, and the leak test plus the refusal matrix are green
with one mutation drill recorded.

**Depends on:** none. The B3 §8 selections (or an explicit delegation on the `DECISIONS` line) must
exist before code.

---

### R-9 — B7 SQL true interrupt

**Status:** PROBE-FIRST
**Row/source:** [successor queue](20261121-successor-queue.md) §3 B7 row and §8.1 ("DESIGN-CLOSED");
[B7 decision record](20261121-b7-sql-interrupt-decision.md) — current behaviour §1, options §2,
recommendation §3, acceptance questions §4, stop conditions §5.
**Why it is open:** Cancel is UI-level abandonment only (generation token + `Cancelled` state +
`query_run{outcome:'cancelled'}`, nothing sent to the engine — B7 §1); every query-lane op serialises
on one DuckDB connection, so an abandoned query blocks follow-ups behind it. The pinned
`@duckdb/duckdb-wasm@1.32.0` exposes `cancelSent(): Promise<boolean>` → `cancelPendingQuery(conn)`
(the `CANCEL_PENDING_QUERY` task is in the bundled `dist/duckdb-browser.mjs`), and the connection
seam already carries it (`packages/engine-duckdb/src/executor-context.ts:54`) — but its
**mid-execution effect is unverified**: whether it interrupts a query still computing before the
first batch (the only in-repo use is post-first-batch tail cleanup), what error a parked `send()`
surfaces, and whether the connection is immediately reusable (B7 §1). Do not assume any of these.

**Contract (already decided — do not reopen):**

- **Probe first, then everything else.** Step 1 is an offline probe of the pinned bundle answering
  the three unverified questions above. Never implement on the assumption that `cancelPendingQuery`
  interrupts (B7 §5). The probe is read-only and runs outside the repository (the WF-01P precedent);
  its output is the evidence either way.
- **Option (c) is the standing floor.** The Cancel copy is already honest and pinned
  (`apps/web/src/sql/SqlPanel.tsx`: "The engine has no query interrupt… may still run to completion…
  a following run queues behind it… result is discarded"), and no string may change unless acceptance
  question Q4 is explicitly selected (B7 §5 copy freeze).
- **Lanes fixed:** an interrupt is out-of-band dispatch to the query-lane connection — it must not
  queue behind the query it cancels, and the OpChannel single-pending rule cannot apply to the cancel
  itself (B7 §2b). [ADR 0040](../../adr/0040-two-op-lanes-in-engine-worker.md) stands; the amendment
  ("a third lane / connection-level cancellation — deliberately not decided here") needs its own ADR.
- **Cancelled outcome honesty:** a cancelled op settles as a typed `cancelled` outcome (the
  `query_run` enum already has it —
  [06-telemetry-design.md](../../engineering/06-telemetry-design.md) §3.9), never a masked engine
  error (AR-2/R1 posture). Delivered rows are never retracted; the RunGuard discards only late
  results (`apps/web/src/sql/guarded-run.ts`).
- **Unverified and deliberately labelled (B7 §6):** mid-execution `cancelPendingQuery` behaviour; the
  error shape a cancelled `send()` surfaces; connection reusability. No memory, latency or CPU
  numbers exist for any option.

**The choice this item still needs** (B7 §4 — record on `DECISIONS`; question 1 gates the rest):

- **Q1 goal:** stopping the compute (→ option (b), cooperative cancel) or unblocking other work
  (→ option (a), second connection — isolation, not interruption; needs an ADR and adds a
  concurrent-scan memory risk, magnitude unmeasured). Option (d) (dispose + reboot the worker) is
  recorded as rejected: it destroys the working session and re-binds `assay_tN` ids (page-mixture
  hazard).
- **If (b):** cancel scope (`engine/query` only, or every query-lane op — an interrupted export or
  pipeline write has different failure semantics than a discarded SELECT); additive wire op
  acceptance (protocol tests + `@assay/engine-duckdb` changeset); cancelled-op outcome (typed
  `cancelled` preferred); copy — keep the current copy (default) or re-select only once an interrupt
  demonstrably lands. **An ADR precedes implementation** (engine contract + ADR 0040's undecided
  clause — B7 §2b/§5).
- **If the probe fails or is ambiguous:** fall back to (c) — no code, no copy change; record the
  probe output and close the row with the limit recorded, exactly as the ledger closes measured
  limits.

**Files (reserved):** probe only (scratch under `/tmp`, nothing committed). If (b) is selected after
a passing probe and its ADR: `packages/engine-duckdb/src/protocol.ts`, `client.ts`,
`engine-executor.ts` (out-of-band dispatch), `executor-context.ts`, `packages/testing/src/engine-conformance.ts`,
`apps/web/src/sql/SqlPanel.tsx` (outcome handling only; copy untouched by default) and a changeset
`@assay/engine-duckdb`. (new) the ADR itself (`docs/adr/`) and the probe record
(`docs/process/handoff/`).

**Implementation steps:**

1. **Probe (this is the item's first deliverable):** a scratch script against the pinned
   `@duckdb/duckdb-wasm@1.32.0` bundle that starts a long-running query, calls `cancelSent()` while
   it is still computing (before the first batch), and records: does the parked `send()` settle and
   with what error; is the compute actually interrupted (not merely abandoned); is the connection
   immediately reusable. Run offline; delete the script; keep the output.
2. **Branch on the probe.** Fail/ambiguous → (c): stop, record. Pass → draft the ADR (cancel op,
   out-of-band dispatch, lane amendment, scope per Q2) and get it accepted before code.
3. `packages/engine-duckdb/src/protocol.ts` — additive cancel request/response types with
   parse-time refusals; `engine-executor.ts` — out-of-band dispatch to the query connection; the
   parked op settles as typed `cancelled`.
4. `client.ts` / `apps/web/src/sql/` — wire the cancel button to the op; the RunGuard semantics and
   the default copy stay byte-identical.

**Tests:**

- **Probe evidence** stands as the real-engine leg; then, if (b) ships: conformance case (cancel
  settles the parked op as `cancelled`, connection reusable), wire-refusal cases (malformed ids,
  unknown types refused pre-execution), and a mutation drill on the out-of-band dispatch path (route
  the cancel through the normal queue → the "cancel queues behind the running query" test must fail).
- The existing pinned copy tests stay green unchanged (copy freeze).

**Gates:** targeted engine suites, then the [index](20261122-remaining-work-handoffs.md) §0 local
suite. Task-specific leg: the offline probe itself on the pinned bundle (record node and bundle
versions), plus `tests/e2e/engine-head-of-line.spec.ts` extended if (b) ships.

**Evidence to record:** the probe script's shape and full output (three answers, explicitly);
the ADR number if (b) is selected; if the probe fails, the exact observed behaviour that falsified
interruption and the (c) fallback statement. No performance claims — none are measured.

**Stop rules:** implementing (b) without a passing probe and an accepted ADR; any engine contract or
lane change without that ADR; changing the Cancel copy without Q4 selection; any claim that the
mid-execution effect is verified before the probe says so; wire/persisted changes beyond the
additive types; a benchmark claim without the stated repeats.

**Done-when:** the repository holds either (i) a probe record proving interruption works plus an
accepted ADR (implementation may then proceed as its own dispatch), or (ii) a probe record showing it
does not, with the honest-copy floor confirmed unchanged.

**Depends on:** none for the probe. Implementation depends on the probe result and, for (b), on an
accepted ADR. R-14 depends on this item's interrupt.

---

### R-10 — C2 TEST-PROOF removal from the production webview bundle

**Status:** READY
**Row/source:** [successor queue](20261121-successor-queue.md) §8.1 C2 row
("MEASURED (decision input)") and §8.2 D6 (recorded, not decided);
[measurement record](20261121-measurement-rows-b6-c3-c2.md) §3.1–§3.5 (presence, attribution, stub
experiment, gate mechanism, decision input).
**Why it is open:** the D03b proof orchestration (`apps/vscode/webview/test-proof/`, six modules)
reaches the shipped webview entry through one unconditional call site
(`apps/vscode/webview/dataset.ts:416`, `runOpenProofs`) and is therefore **shipped and parseable but
unreachable in production** — the gate is verified at three layers (host predicate
`apps/vscode/src/dataset.ts:174-177`, `ExtensionMode.Test && ASSAY_E2E_EDIT_PROOF === '1'`;
webview pass-through `webview/dataset.ts:417`; module refusal `webview/test-proof/index.ts:74`,
`!== true`). Measured cost: **44,655 B** by metafile `bytesInOutput` and **−44,729 B raw /
−8,246 B gzip** by a stubbed rebuild (two methods agree to 74 B / 0.17 %), 4.14 % raw / 3.72 % gzip
of `webview/dataset.js` (measurement §3.2–§3.3). C2 deliberately recorded the cost without deciding
(§3.5); the removal is unimplemented.

**Contract (already decided — do not reopen):**

- **Gate integrity is non-negotiable.** The pinned host e2e must keep exercising the acceptance
  proofs: `apps/vscode/scripts/run-e2e.mjs` sets `ASSAY_E2E_EDIT_PROOF: '1'`, and the three-layer
  predicate (measurement §3.4) is the verified mechanism. Any removal shape that can silently ship
  the no-op to the test host is a defect, not a trade-off.
- **Bytes, not behaviour:** the cost is static (shipped bytes; parse/compile cost is **not measured
  and not claimed** — §3.5). The proof code never executes in production today; removal must not
  change production behaviour, copy or the host predicate.
- **Measurement discipline:** the shipped build emits no sourcemap and no metafile
  (`apps/vscode/scripts/build.mjs`), and `apps/vscode/dist` bytes depend on the build's working
  directory (esbuild source-path comments — measurement §2.1). Only the documented invocation
  (`pnpm build` with `cwd` `apps/vscode`) produces comparable numbers.
- **Coverage posture unchanged:** `apps/vscode/webview/test-proof/**` is excluded from the coverage
  denominator as test infrastructure (`vitest.config.ts`), and the floors 83/76/80/84 are fixed —
  never lower a floor to pass (C1, successor queue §9).

**The choice this item still needs** (the maintainer's stub-vs-split judgement — index §1 R-10;
record the selection on `DECISIONS`):

- **(i) Build-config stub:** alias `./test-proof` to a no-op in the production build (or gate the
  call site on a compile-time define). One build-file change, no runtime behaviour change, and the
  delta is exactly the measured stub experiment (−44,729 B raw / −8,246 B gzip). **Consequence /
  gate-integrity risk:** a stub must be provably wired to the same predicate that gates the real
  proofs, or a future refactor can ship the no-op in test mode and silently stop exercising the
  acceptance suite (measurement §3.5). The test host must also receive a build that includes the real
  proofs — the build becomes predicate-sensitive.
- **(ii) Structural split:** move the proofs to a test-only entry (the shape `dist/e2e-test.cjs`
  already has), loaded only from the test host. Larger change (webview entry split + host wiring);
  the gate becomes structural and dead-code elimination then drops everything, as §3.3 shows.
  **Consequence:** more files move, but correctness no longer depends on a build-config convention.
- **Recommendation (a recommendation, not a decision): prefer (ii).** The alternative (i) is rejected
  on gate-integrity grounds — its correctness is a convention that must stay aligned with the runtime
  predicate, while (ii) makes the production bundle structurally unable to reach the proofs. If the
  maintainer selects (i), the build must gain a test-mode build whose wiring to the exact §3.4
  predicate is itself tested (a build-config mutation drill).

**Files (reserved):** `apps/vscode/scripts/build.mjs` (entries / aliasing),
`apps/vscode/webview/dataset.ts` (the `:416` call site and the other `testHarness` branches),
`apps/vscode/webview/test-proof/**` (move under (ii)), `apps/vscode/src/dataset.ts` (host wiring
under (ii)), `apps/vscode/scripts/run-e2e.mjs`, `apps/vscode/package.json` (scripts if a test-mode
build is introduced), `vitest.config.ts` (mechanical include/exclude update if file locations move;
thresholds untouched). (new) the test-only entry module under shape (ii).

**Implementation steps:**

1. Record the selection (or take the recommendation) and rebuild the pre-change baseline with the
   documented invocation; capture `dist/webview/dataset.js` raw/gzip bytes and marker counts
   (`validation-proof`, `runOpenProofs`, `exercise*`).
2. Shape (ii): split the proofs into a test-only entry and wire the test host to it; delete the
   production call site's import so DCE removes the modules. Shape (i): add the build-config alias /
   define, and add a test that pins the alias to the exact §3.4 predicate.
3. Rebuild with the same invocation; verify the byte delta and marker migration (see Evidence).
4. Run the pinned host e2e and confirm the proofs still execute (gate-integrity check).
5. Changeset `@assay/vscode` (or the manifest's package name — use whatever the changeset ledger
   uses for `apps/vscode`) stating the bytes removed and the gate shape.

**Tests:**

- **Byte verification (acceptance measurement):** `dist/webview/dataset.js` shrinks by
  **−44,729 B raw / −8,246 B gzip** against the pre-change build of the same base (the C2 stub
  measurement; re-derive at the implementing base — the magnitude holds while
  `webview/test-proof/**` is unchanged). Marker strings appear 0 times in `dataset.js`; under (ii)
  they appear in the test-only entry. Every other bucket is 0 Δ (`main.js`, `worker.js`,
  `extension.cjs`, test bundles, DuckDB pins).
- **Gate integrity (real-host):** `node apps/vscode/scripts/run-e2e.mjs` passes and demonstrably
  exercises the proofs (the harness's own proof outcomes, not merely a green run).
- **Unit:** `apps/vscode/webview/test-proof/index.test.ts` keeps passing wherever the module lands;
  under (i) a new build-config test fails if the alias points at the real module in production or at
  the stub in test mode.
- **Mutation drill:** under (ii), re-point the test host at the production entry → the host e2e must
  fail (proofs missing); under (i), flip the alias's predicate → the build-config test must fail.

**Gates:** targeted `apps/vscode` suites (`pnpm exec vitest run apps/vscode`), `pnpm build`, then the
[index](20261122-remaining-work-handoffs.md) §0 local suite. Task-specific legs: the bundle
measurement (`pnpm measure:bundle` before/after) and the pinned VS Code host run.

**Evidence to record:** the selection; before/after `dataset.js` raw and gzip bytes with the delta
against the −44,729 B / −8,246 B measurement; marker counts per file before/after; the gate-integrity
observation (what proves the proofs ran); the mutation drill; changeset.

**Stop rules:** a shape that can ship the no-op to the test host without a failing test; any coverage
floor change (83/76/80/84 fixed); claiming parse/compile savings (unmeasured); comparing bytes across
different build invocations; wire/persisted changes (none exist here — stop if one appears).

**Done-when:** the production webview bundle contains zero TEST-PROOF code (markers at 0 in
`dataset.js`), the measured byte delta is recorded against the stated figures, and the pinned host
e2e still exercises the acceptance proofs.

**Depends on:** the stub-vs-split selection (maintainer, unless delegated on `DECISIONS`).

---

### R-11 — E02 bundle budgets

**Status:** MEASUREMENT-ONLY
**Row/source:** [successor queue](20261121-successor-queue.md) §8.1 C3 row and §8.5 (budgets unset);
[measurement record](20261121-measurement-rows-b6-c3-c2.md) §2 (second baseline, determinism,
attribution) and §2.5 (the stable-baseline definition);
[doc 10](../../engineering/10-dependency-and-bundle-measurements.md) §12 (budget candidates) and §13
(reproduce / fail-safe).
**Why it is open:** two measurement passes now exist (2026-11-20 baseline `06d8e20`, second pass
`129e3ef`) and `measure:bundle` is byte-deterministic for a fixed build and install — but one more
stable round is required before a budget candidate can be proposed, and the two known
non-reproducible rows need their tolerance stated first (§2.5). No budget is set; the passes differ
by named feature work (+10,279 B raw web, +443 B CLI payload, +39,301 B desktop), which is
encouraging, not a budget.

**Contract (already decided — do not reopen):**

- **A stable second baseline** (measurement §2.5, verbatim conditions): (1) same invocation and
  artefacts — `pnpm build --force` then `pnpm measure:bundle` at the package-script `cwd` (never a
  root-level `node <script>` call — the numbers differ, §2.1), same host class and OS,
  lockfile-identical tree; (2) reproduced buckets — every section reproduces its predecessor
  byte-for-byte except deltas attributable to named commits; untouched pins (DuckDB worker/wasm,
  vendored extensions) at **0 Δ**; (3) a stated tolerance for the two known non-reproducible rows —
  the CLI tarball (a `pnpm pack` one-off) and the install-size table (12/31 names move ±56–400 B
  across installs of the same lockfile): either re-normalise the install-size section or exclude it
  from budgeting, and either re-pack both sides or drop the tarball row; (4) two consecutive rounds
  and no free-floating number.
- **Budget candidates** (doc 10 §12): only buckets a change can move without touching the engine —
  `static-entry` (boot cost), `lazy-chunk` (panel code), `host-bundle` + `webview-script` (extension
  code), the CLI `files` payload. Wasm/worker bytes are pinned artefacts tracked as pin drift, never
  as a budget. A candidate is set from observed movement across the rounds, not from a single sample;
  it becomes a budget only on maintainer adoption.
- **Known noise sources that define what "stable" can mean** (§2.1/§4): the install-size cross-install
  swing; `dist/spike-artifacts.json` embeds a timestamp (size stable at 879 B; a byte-level dist diff
  always shows it); esbuild source-path comments make `apps/vscode/dist` bytes `cwd`-dependent;
  `pnpm measure:bundle --json` is banner-prefixed through pnpm — call
  `node scripts/measure-bundle.mjs --json` directly for mechanical consumption.
- **Expected, attributable movement in the next round:** ENG-2 (`d457eec`) landed after `129e3ef`
  and should move `lazy-worker` and the CLI payload (measurement §2.3 note i); the A3/C02 parity work
  enters as named commits (§2.4). Attribute commit-by-commit; unattributed movement fails the round.

**The choice this item still needs:** none — the protocol is decided in
[measurement record](20261121-measurement-rows-b6-c3-c2.md) §2.5 and doc 10 §12. The only later
decision is the maintainer's adoption of any budget candidate the rounds produce.

**Files (reserved):** (new) dated measurement records under `docs/process/handoff/`;
`docs/engineering/10-dependency-and-bundle-measurements.md` §12 (append the next data point /
candidate table when one exists). **No code, no config** — `scripts/measure-bundle.mjs` and the
bucket definitions are fixed by the stable-baseline definition; changing them invalidates
comparability.

**Implementation steps:**

1. Clean tree at a named SHA, `pnpm install --frozen-lockfile`, record tool versions
   (`node -v && pnpm -v`).
2. `pnpm build --force`, then `pnpm measure:bundle`; run `node scripts/measure-bundle.mjs --json`
   twice and `cmp` the outputs (must be byte-identical).
3. Diff against the predecessor's tables bucket-by-bucket; attribute every source-derived delta to
   named commits (§2.3 style); pins must be 0 Δ.
4. State the tolerance for the tarball and install-size rows per §2.5(3).
5. Repeat as a second consecutive round under the same conditions.
6. Write the dated record: bucket tables with Δ and attribution, the two-run determinism verdict,
   the tolerance statement, and — only if both rounds hold — the budget-candidate table from the doc
   10 §12 names, labelled "candidate, pending maintainer adoption". Extend doc 10 §12 with the next
   data point.

**Tests:** none (no code). The self-check is the two-run `cmp` and the pin 0-Δ assertion above;
`scripts/measure-bundle.test.mjs` runs in the `node` vitest project and must stay green untouched.

**Gates:** `pnpm build --force`, `pnpm measure:bundle` (exit 0), the two-run byte-identity `cmp`,
`pnpm docs:links:check` for the new record. Task-specific leg: the bundle measurement itself. If any
code or config changed, stop — this item changes none.

**Evidence to record:** SHA and tool versions; sha256 of both `--json` runs; the bucket tables with
per-commit attribution; the tolerance statement (exact wording) for the two non-reproducible rows;
either the budget-candidate table (bucket, observed movement, proposed ceiling/band, "candidate — not
adopted") or an explicit "rounds not yet stable" verdict naming the failing condition.

**Stop rules:** a budget number without two consecutive stable rounds; a threshold wired into any
gate; a bucket-definition or script change (breaks comparability); comparing `dist/` across
invocations or commits without rebuilding; a performance claim from these bytes (none are timings).

**Done-when:** two consecutive stable rounds are on file with their attribution and tolerance, and a
budget-candidate table (or the honest not-yet verdict) is recorded for the maintainer.

**Depends on:** two consecutive stable rounds (this item _is_ the protocol). Nothing blocks starting.

---

### R-12 — validator tighter bounds

**Status:** READY
**Row/source:** [successor queue](20261121-successor-queue.md) §8.1 B2 row ("Carried limits") and
§8.5 (the gap is unfixed); `packages/engine-duckdb/src/type-expr.ts` carried-limitation note
(`TIMESTAMP(n)` accepts only `0..9` at the engine; the validator models only `0..2147483647`);
`tests/e2e/column-ops.spec.ts` (the `TIME(3)` pin, lines ~213–222).
**Why it is open:** B2 bounded the optional integer modifier to `0..2147483647` but left the
per-type tighter bounds unencoded, so `TIMESTAMP(10)` and `TIME(3)` pass validation and are refused
by the DuckDB binder — the binder, not the validator, is the refusing layer. The e2e pin
"a structurally valid but engine-rejected cast rolls back and alerts recoverably" deliberately uses
that gap (`TIME(3)`) as its example.

**Contract (already decided — do not reopen):**

- `type-expr.ts` is the single total validator for untrusted type strings (`OverlayBase.columns[].type`,
  `column-cast.targetType`); every rejection is a typed `EngineTypeError`, never SQL injection
  (module doc; the m4-2 history). This item tightens bounds; it changes no grammar, no lexer
  allowlist and no family classification.
- The engine rules being encoded are measured, not invented: `TIMESTAMP(n)` accepts only `n` in
  `0..9`, and `TIME` takes no type parameter at all (B2; the e2e comment quotes the binder error
  "Type 'TIME' does not take any type parameters"). `TIME WITH TIME ZONE` / `WITHOUT` suffixes and
  every other base keep their current rules.
- The `0..2147483647` expressibility bound stays for the remaining modifier types (B2 pinned both
  ends at the CLI; no cap is raised or lowered). DECIMAL's `[1,38]`/`[0,precision]` bounds are
  untouched.
- Client copy paths are unchanged: validator refusals surface as "not a valid column type"
  (`column-op-error`), engine rejections through the m4-3 rollback+alert path (`edit-error`) — the
  two e2e tests in `tests/e2e/column-ops.spec.ts` pin those surfaces.

**The choice this item still needs:** none — decided in B2 (the bounds are the engine's). The one
judgement inside the work is the e2e re-grounding candidate (Implementation step 3), which must be
verified against the pinned CLI, not assumed.

**Files (reserved):** `packages/engine-duckdb/src/type-expr.ts`, `packages/engine-duckdb/src/type-expr.test.ts`,
`tests/e2e/column-ops.spec.ts`. Plus the ledger note in
[successor queue](20261121-successor-queue.md) §8.1 (its B2 "Carried limits" wording becomes stale
when this lands — record the supersession in the same change).

**Implementation steps:**

1. `packages/engine-duckdb/src/type-expr.ts` — remove `TIME` from the optional-integer-modifier
   bases (it takes none) and give `TIMESTAMP` a `0..9` precision bound (mirror the DECIMAL
   precision/scale shape and its typed messages); update the module doc's grammar note and replace
   the carried-limitation paragraph with what remains unmodelled.
2. `packages/engine-duckdb/src/type-expr.test.ts` — move `TIME(3)` (currently in the accept battery,
   line ~98) to the reject battery; accept `TIMESTAMP(0)`/`TIMESTAMP(9)`, reject `TIMESTAMP(10)`;
   extend `describe('parseEngineTypeExpression — modifier bounds (defect 1)')`; extend the
   `describe.skipIf(!hasDuckDbCli)` CLI-agreement suite to pin **both ends** (`TIME(3)` and
   `TIMESTAMP(10)` binder-rejected; `TIME` and `TIMESTAMP(9)` accepted) with `DUCKDB=/tmp/duckdb`.
3. `tests/e2e/column-ops.spec.ts` — re-ground the "structurally valid but engine-rejected" pin
   honestly: after this item `TIME(3)` is validator-refused and behaves like `MAP(INTEGER)`, so pick
   a spelling the tightened validator still accepts and the pinned engine binder still rejects
   (candidates come from the permissive identifier path — verify each against the pinned CLI; do not
   assume one works), and rewrite the comment that cites the b2 carried limitation. If no honest
   spelling exists, reframe the test to drive the m4-3 rollback+alert path through a rejection the
   validator cannot pre-empt and say so in the comment — never keep a pin whose premise is false.

**Tests:**

- **Unit:** the cases named in step 2 (reject `TIME(3)`, `TIME(0)`, `TIMESTAMP(10)`;
  accept `TIME`, `TIMESTAMP(0..9)`), inside the existing modifier-bounds / accept / reject batteries.
- **Real-engine:** the pinned-CLI agreement suite at both ends (a CLI-verified pin, like B2's
  `0..2147483647`).
- **e2e:** `tests/e2e/column-ops.spec.ts` — "an invalid cast spelling is refused before composing an
  op" (unchanged) and the re-grounded "a structurally valid but engine-rejected cast rolls back and
  alerts recoverably" (new honest example, same assertions).
- **Mutation drill:** widen the `TIMESTAMP` bound back to `0..2147483647` (or re-admit `TIME(3)` to
  the modifier set) → the new reject battery and the CLI-agreement case must fail.

**Gates:** targeted `pnpm exec vitest run packages/engine-duckdb/src/type-expr.test.ts` with
`DUCKDB=/tmp/duckdb`, then the [index](20261122-remaining-work-handoffs.md) §0 local suite.
Task-specific legs: the pinned DuckDB CLI agreement (v1.5.5) and Playwright
`pnpm test:e2e tests/e2e/column-ops.spec.ts`.

**Evidence to record:** the exact before/after accept/reject batteries for `TIME`/`TIMESTAMP`
spellings; the CLI-agreement output pinning both ends; the chosen e2e re-grounding spelling and the
CLI evidence that it is engine-rejected; the mutation drill; the ledger note.

**Stop rules:** changing any other type's bounds or the lexer/grammar beyond the two rules; touching
the `0..2147483647` bound; weakening an existing assertion; a wire/persisted change (the validator
is client/engine-internal — stop if any caller contract shifts); an e2e re-grounding whose premise is
not CLI-verified.

**Done-when:** `TIME(3)` and `TIMESTAMP(10)` are refused by `parseEngineTypeExpression` with typed
errors before any SQL composition, `TIMESTAMP(0..9)` and bare `TIME` still pass, the CLI-agreement
suite pins both ends, and the e2e pin is re-grounded with a verified honest example.

**Depends on:** none.

---

### R-13 — nested `UHUGEINT` leaves

**Status:** READY
**Row/source:** [successor queue](20261121-successor-queue.md) §8.1 B2 row ("Nested `UHUGEINT`
leaves and BLOB summaries deliberately unchanged") and §8.5; `apps/web/src/grid/uhugeint.ts` (the
scalar exact render, `617ea11`); `apps/web/src/grid/nested-preview.ts` (the m4-5 decimal channel);
`apps/web/src/record/record-tree.ts` (type-blind summaries).
**Why it is open:** scalar `UHUGEINT` cells render their exact unsigned 128-bit value (B2), but a
`UHUGEINT` leaf nested inside a struct/list still renders as `<16 bytes>` — the nested preview's
binary branch decodes only the m4-5 decimal channel
(`formatDecimalForParsedType`, `nested-preview.ts` `renderValue`), and the Record tree calls
`formatNestedPreview` without a type at all (`record-tree.ts`).

**Contract (already decided — do not reopen):**

- **Reuse, never fork:** the decoder is `apps/web/src/grid/uhugeint.ts` — `decodeUHUGEINT` /
  `formatUHUGEINTForParsedType`, byte order verified against the shipped transport (module doc; the
  m4-5 mirror shape is `formatDecimalForParsedType`).
- **Fail-soft rule (carry from `uhugeint.ts`):** never mis-decode — a payload of the wrong width for
  a `UHUGEINT` position, or an absent/unknown declared type, keeps the honest `<N bytes>` summary;
  BLOB of any width keeps its summary, `HUGEINT`/`DECIMAL` keep their signed decimal decoding. Both
  renderers stay total and throw-free into the render path (`nested-preview.ts`'s catch + marker;
  `record-tree.ts`'s per-node `(unreadable)` guard) and never log values
  ([ADR 0025](../../adr/0025-telemetry-and-data-privacy-boundary.md)).
- **Bounds unchanged:** nested-preview's length/depth caps and the record tree's AR-W8 caps apply to
  the new render exactly as to the decimal channel; text-only output for React text nodes.
- **SQL results are out of scope for this item.** `apps/web/src/sql/SqlPanel.tsx:400` renders
  `formatCell(cell)` with **no declared type**, and the module contract pins untyped SQL results to
  raw values (`apps/web/src/grid/format.ts` doc, WF-O2). Without a declared type a 16-byte payload
  cannot be told from `BLOB(16)` — the fail-soft rule keeps `<16 bytes>`. If untyped results ever
  gain a type channel, that is the type-propagation contract the index reserves for
  [R-5](20261122-remaining-work-handoffs.md), not this item.

**The choice this item still needs:** none — decided in B2's boundary note (exact render, reused
decoder) and the fail-soft rule above. The Record-tree type threading follows the existing m4-5
pattern (per-column parsed type), not a new design.

**Files (reserved):** `apps/web/src/grid/nested-preview.ts` (the `ArrayBuffer.isView` branch of
`renderValue`), `apps/web/src/record/record-tree.ts` (optional column types on `RecordRowInput`,
threaded into `formatNestedPreview`), `apps/web/src/record/RecordInspector.tsx` (the three
`buildRecordTree` call sites pass `model.schema` types), tests `apps/web/src/grid/nested-preview.test.ts`,
`apps/web/src/record/record-tree.test.ts`. `apps/web/src/grid/uhugeint.ts` is imported, not modified
(stop if a change there seems necessary).

**Implementation steps:**

1. `apps/web/src/grid/nested-preview.ts` — in `renderValue`'s binary-view branch, run
   `formatUHUGEINTForParsedType(container, type)` before the `<N bytes>` summary, mirroring the m4-5
   decimal channel; unknown/wrong-width payloads fall through to the summary.
2. `apps/web/src/record/record-tree.ts` — accept optional per-column types in `RecordRowInput` and
   pass each root child's type as `columnType` to `formatNestedPreview`; nested field/list element
   types resolve through the existing `fieldType`/`listElementType` plumbing in the preview module.
3. `apps/web/src/record/RecordInspector.tsx` — pass the parsed schema types at the three
   `buildRecordTree` call sites (the per-column parse cache in `schema/parseType.ts` keeps this off
   the render path).
4. Confirm the scalar path (`format.ts` / `uhugeint.ts`) and the SQL panel are byte-unchanged.

**Tests:**

- **Unit** (`apps/web/src/grid/nested-preview.test.ts`): a new suite beside "formatNestedPreview —
  nested decimals via the parsed type tree (m4-5)" — a `UHUGEINT` leaf inside a struct and inside a
  list renders its exact value given the field/element type; a `BLOB(16)` leaf keeps `<16 bytes>`;
  a wrong-width payload at a `UHUGEINT` position keeps the summary; a type-blind call is unchanged.
- **Unit** (`apps/web/src/record/record-tree.test.ts`): summaries show the exact value when column
  types are supplied; type-blind input keeps today's `<N bytes>`; the hostile-input and cap suites
  ("buildRecordTree — totality under hostile input", "AR-W8 length and depth caps") pass unchanged.
- **Unit** (`apps/web/src/grid/uhugeint.test.ts`): untouched — reuse is proved by it staying green.
- **Mutation drill:** delete the `formatUHUGEINTForParsedType` call from the binary branch → the new
  nested suite must fail; widen `decodeUHUGEINT` to accept any width → the wrong-width case must fail.

**Gates:** targeted `pnpm exec vitest run apps/web/src/grid apps/web/src/record`, then the
[index](20261122-remaining-work-handoffs.md) §0 local suite. Task-specific leg: the web suites are
the leg (no engine, wire or bundle surface); `pnpm test:e2e` grid journeys stay green unchanged.

**Evidence to record:** the new suite outputs (exact-render and fail-soft cases); proof the scalar
path and SQL panel are unchanged (test diff showing no touched assertions); the mutation drill;
confirmation that no file outside the reserved list changed.

**Stop rules:** modifying `uhugeint.ts`'s decoder or the scalar path; decoding without a declared
type (the BLOB/UHUGEINT ambiguity); any cap/limit change in either renderer; SQL-result scope creep
(see Contract); a package-boundary crossing (this stays in `apps/web`).

**Done-when:** a `UHUGEINT` leaf nested in a struct/list renders its exact unsigned 128-bit value
wherever a declared type is available (nested preview and Record tree), every fail-soft case keeps
its honest summary, and untyped SQL results are explicitly unchanged.

**Depends on:** none.

---

### R-14 — U-1 revisit with R-9

**Status:** SPEC-READY
**Row/source:** [decision round](20261121-decision-round.md) U-1 row ("No timeout; keep fail-closed";
reopen with B7 only after a probe shows the interrupt works);
[WF-05 replacement contract](20261110-wf05-replacement-contract.md) §13 U-1 (the three unbounded
waits and the pinned rules) and §3.5/§3.7 (settlement, notice lifecycle);
[successor queue](20261121-successor-queue.md) §9 (U-1 keeps fail-closed, reopen with B7).
**Why it is open:** three unbounded waits feed the G4 replacement gate — the commit's
`await effects.refresh()` and its rollback-path second call (`apps/web/src/edit/session.ts`), and up
to `MAX_CAST_CHECK_ATTEMPTS = 3` sequential `overlayCastCheck` awaits
(`apps/web/src/sessions/useEditingSession.ts:61`) — and the client installs exactly one timer (the
dispose handshake), so G4 is fail-closed but potentially indefinite (WF-05 §13 U-1). The decision
round kept "no timeout" precisely because a UI timer cannot interrupt a DuckDB-WASM call and an
"unavailable" state without a real interrupt would be a claim the engine cannot keep. Once R-9
delivers a real interrupt, the timer can act instead of lie — that is this item.

**Contract (already decided — do not reopen):**

- **Until R-9's interrupt exists, the invariant stands:** no timeout, no bypass, no auto-resume;
  notices clear only on their observable (C15 on `mutationPending` flipping false, C16 when
  `castPendingCount` returns to 0); the existing recovery surfaces remain the way out ("Retry loading
  the view", cast refusal messages) — WF-05 §13 U-1 pinned rules. A fake timeout is a defect.
- **G4 stays fail-closed:** replacement is refused while `mutationStateRef.current > 0` or
  `castPendingCount > 0` (WF-05 §3.3); C15/C16 semantics and precedence are unchanged until a new
  state is adopted.
- **Copy truth (WF-05 K38):** no string may promise a duration; the copy freeze holds until the new
  state's copy is explicitly selected. No "validated"/"intuitive" wording anywhere (D-02 A).
- **ADR 0040 stands**; the interrupt capability and its ADR belong to R-9 — this item consumes them,
  it does not extend lanes.

**The choice this item still needs** (product decisions WF-05 §13 U-1 left open; record on
`DECISIONS`):

- **Which waits are bounded:** all three unbounded awaits, or only the replacement-path waits.
- **The bound's definition:** a wall-clock deadline after which the client sends the R-9 interrupt and
  enters the unavailable state (honest now — the timer acts); the deadline value and whether it is a
  constant or a maintainer setting.
- **The unavailable state:** the explicit "the view is unresponsive, replacement unavailable" state
  beyond C15/C16 — shape, copy selection, and whether it supersedes or accompanies the notices.
- **Recovery semantics:** what re-enables replacement (a retry action after the interrupt settles;
  whether a wedged engine needs the recovery surfaces or a reload) — bounded by R-9's interrupt
  scope.

**Files (reserved):** `apps/web/src/edit/session.ts`, `apps/web/src/sessions/useEditingSession.ts`,
the WF-05 notice/recovery surfaces they feed (`apps/web/src/App.tsx` recovery surface only),
plus R-9's client interrupt surface; (new) copy strings in the WF-05 C-string lineage and the
contract's gate list (K38 gains its bounded-wait successor). No engine changes beyond R-9's.

**Implementation steps:**

1. Verify R-9 delivered a real interrupt (probe record + accepted ADR + shipped op) — otherwise stop
   and report BLOCKED (the invariant above).
2. Record the maintainer's selections (bound, scope, state, copy, recovery).
3. Implement the deadline → interrupt → unavailable state at the three wait sites, keeping G4's
   fail-closed rule and the C15/C16 clearing observables intact.
4. Update the WF-05 contract record's K38/§13 U-1 entries in the same change (the pinned rules are
   superseded only here, only now), and the ledger.

**Tests:**

- **Unit (per wait site):** with a stalled engine promise and a fake timer, the deadline fires, the
  interrupt is sent, and the unavailable state renders; the pre-deadline path is byte-unchanged.
- **Fail-closed:** the unavailable state never auto-resumes; retry is explicit; a late result is
  discarded by the existing guards (WF-05 stale-return posture).
- **Copy:** no string promises a duration (K38's assertion, re-targeted at the new state).
- **Mutation drill:** make the deadline show the unavailable state **without** sending the interrupt
  (the old lie) → the test asserting the interrupt was sent must fail; or clear a notice off its
  observable → the C15/C16 clearing tests must fail.

**Gates:** targeted web suites for the touched modules, then the
[index](20261122-remaining-work-handoffs.md) §0 local suite. Task-specific leg: `pnpm test:e2e`
replacement journeys (`open-cancel`/`open-recovery` lineage) plus the R-9 interrupt conformance
cases.

**Evidence to record:** the R-9 dependency's probe/ADR references; the selected bound and state; the
per-site tests' before/after behaviour; the copy diff (duration-free); the mutation drill; the
contract-record update.

**Stop rules:** any work before R-9's interrupt is real (a UI-only timeout is forbidden by the
decision round); a copy change without selection; an ADR 0040 change (that is R-9's ADR); G4's gate
weakening; cap/timeout/floor changes beyond the sanctioned bounded wait itself.

**Done-when:** after a bounded wait backed by a real interrupt, the UI reaches an explicit
"replacement unavailable" state with the engine no longer computing behind it (or the state states
honestly what remains), notices still clear only on their observables, and no fake timeout exists.

**Depends on:** **R-9** (a real interrupt must exist — probe passed, ADR accepted, op shipped).

---

## Verification protocol

Local-only gates. **Remote GitHub Actions is billing-blocked, not code-blocked:** every push shows
four jobs completing as `failure` in seconds with no steps and no logs — an account refusal, **not
code signal**. Do not retry a push to "fix" it; record it in the closing message. The full command
list, the contention-sensitive tests and the push policy live in the
[index](20261122-remaining-work-handoffs.md) §0 (read it first) — this section is the summary:

- Clean tree, `corepack pnpm install --frozen-lockfile`, `pnpm run doctor`, pinned CLI
  `export DUCKDB=/tmp/duckdb PATH=/tmp:$PATH` (v1.5.5).
- Targeted suites first (each item names them), then `pnpm format:check`,
  `NODE_OPTIONS=--max-old-space-size=4096 pnpm lint`, `pnpm typecheck`, `pnpm test`, the coverage run
  (floors 83/76/80/84 — never lowered), `pnpm build`, `pnpm docs:links:check`, `pnpm adr:index:check`,
  `pnpm current-state:check`, `pnpm assurance-map:check`,
  `node scripts/dependency-report.mjs --check`, `pnpm measure:bundle`.
- Task legs: `pnpm test:e2e` (Playwright), `node apps/vscode/scripts/run-e2e.mjs` (pinned host
  1.130.0, offline), `node apps/cli/scripts/pack-consumer-smoke.mjs` — these substitute for the
  remote legs.
- A contention-sensitive failure at default workers is environmental: re-run solo before declaring a
  failure, and never raise a ceiling.
- A row closes only with merged commits, changesets where a package changed, the full local suite
  green on the merged tree, an independent reviewer verdict (an implementer never approves its own
  change), and the ledger updated in the same change
  ([operating-model.md](operating-model.md)).

## Paste-ready prompt

```text
You are continuing Assay maintenance from the 2026-11-22 technical carry briefs (H2). The repository
is local; remote GitHub Actions is billing-blocked (four job-start failures per push are NOT code
signal — record them, never "fix" them).

Read, in order: AGENTS.md; docs/process/handoff.md (current-state block);
docs/process/handoff/20261122-remaining-work-handoffs.md (§0 verification protocol, §1 index);
docs/process/handoff/20261122-h2-technical-carry-briefs.md (this file's selected brief); then every
record the brief cites (B3 spec, B7 decision, measurement record, successor queue §8/§9, decision
round, WF-05 contract, the named ADRs) and the code anchors it names. Treat every path:line as
drift-prone; re-verify at your base SHA.

SELECTED_ITEM = <R-n>        # exactly one of R-8 … R-14
DECISIONS = <the options chosen, if the brief asks for any; state "recommendation accepted" or the override>

Reserve one item only, on a scoped branch, and follow worker → independent reviewer → integration per
docs/process/handoff/operating-model.md. An implementer never approves its own change.

Before code: record your own base SHA; re-run the brief's targeted gates and capture the pre-change
behaviour (for R-9 this means the offline probe FIRST — nothing else until it answers). Perform at
least one load-bearing mutation and show the named test failing without it. Record evidence exactly
as the brief's "Evidence to record" demands — probe output, byte deltas, counts, command tails — and
record the billing-blocked CI caveat instead of waiting for Actions.

Never weaken an assertion, floor, cap, timeout or privacy rule; ADR 0051's composition shape and
ADR 0040's two lanes are fixed; no wire or persisted change without an ADR; no package-boundary
crossing; no benchmark or budget claim without the stated repeats; keep refactors and behaviour
changes separate. If a stop rule fires, report BLOCKED (not CLOSED) with the exact conflict.

Report: item id, diagnosis, files/commits, gates with exits, reviewer verdict, mutation drill,
unchanged invariants, remaining limits, and the ledger entry.
```
