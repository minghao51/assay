---
'@assay/engine-duckdb': patch
'@assay/testing': patch
'@assay/cli': patch
---

test(p2c-2): conformance-depth pins — per-aspect SQL, two-gate blockedGates, mode-change, gate-handle reuse (+ diff-gate semantics line)

Test-only depth bundle closing the five PT-P2 §4 "Conformance/unit depth
(small)" carry-overs, plus one code-doc line:

- **m6-2 per-aspect SQL unit pin** — `executeDiffCore`'s factored aspect loop
  now has a focused unit pin (`engine-executor.test.ts`): each aspect runs
  exactly its own plan SQL (`added`/`removed`/`changed`) in the documented
  order and reads its documented side (added = B, removed/changed = A). The
  add/remove binding was e2e-guarded only (p2-4's recorded note).
- **Two-gate `blockedGates` conformance fixture** — new
  `pipeline-publish-two-gates` scenario: a publish requiring two gates with one
  failing lists the failed gate and only it, stops at the publish, and the
  re-run-after-fix completes.
- **Mode-change real-engine conformance scenario** — new `pipeline-mode-change`
  scenario runs the same pipeline as `table` → `view` → `table` in one session,
  asserting the replaced kind and shape (the p2-4 mode-change-safe drop path,
  previously unit/e2e-pinned but not conformance-pinned).
- **Gate-handle reuse across runs** — a client-level long-session pin: one gate
  handle per relation per run (the run-local memo), a fresh handle each run,
  and pass→pass / fail→fixed-rerun all working without stale accumulation (the
  m6-4-era `assay_tN` registry concern, for pipeline gates).
- **Diff-gate semantics line** — "succeeded = completed execution" documented
  where the gate statuses are defined (`pipeline-runner/runner.ts` and the CLI
  `report-pipeline.ts` status docs): a diff gate that executed is succeeded
  even when it found differences; success is never a "datasets matched" claim.

No product-code behavior change: tests plus the two comment lines only (the
one harness addition is the per-scenario buttons for the two new conformance
scenarios). Pipeline-runner conformance scenarios 13 → 15.
