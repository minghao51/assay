# G0-Readiness and Recorded-Gap Batch — 2026-10-19

Bounded agent lane closing the agent-doable PT-0 tail and the three gaps
recorded in the slice-2 queue (§ ptv2-6 "Discovered gaps"). Human items are
listed in §5 and are NOT agent work. Nothing here authorizes publication,
registry changes, billing/visibility changes, hosted infrastructure, or CI
changes; normal `main` pushes after verified rows remain user-authorized.

## 1. Protocol

Entry: `116b8fb`, clean tree. Baseline 2026-10-19: types **20** forced, unit
**3021/191**, coverage **87.84/81.97/88.65/89.29** (floors 83/76/80/84),
build **12**, browser **172 + 1 skip**, native **9**, spike **15 pins**,
doc links **107/0**, ADRs **46**, 163 pending changesets. Serialized rows:
one worker dispatch each ([operating model](operating-model.md)); GLM worker
lane is **down (401, key renewal is human)** so the fallback roster applies
(Luna implements, parent session — or a fresh session — independently
reviews; never the same model both roles). Worktrees `/tmp/assay-gb-*`,
briefs/logs in `/tmp`. Known pre-existing flakes (CLI diff/validate
usage-error, contracts fuzz under parallel load): isolated rerun protocol;
never edit timeouts/thresholds. Rebuild `@assay/vscode` before real-host
e2e. Installed CLI = packed consumer; repo-root dist invocation is NOT a
supported surface (gb-5 makes that honest, it does not add support).

## 2. Task rows

| row                                                        | scope / done-when                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | status / evidence |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| gb-1 — telemetry public disclosure doc                     | PT-0 item 1 agent tail (ADR 0037/0045). Docs only: a public-facing telemetry disclosure (what is collected — the implemented allowlist; what is NEVER collected per ADR 0025; opt-out via `ASSAY_NO_TELEMETRY` + first-run disclosure UX; self-hosted collector operator contract link). Linked from the README front door. Done-when: every claim verified against code by the reviewer (an unverifiable claim = request-changes); links/format/ADR gates green; no new telemetry behavior.                                                                                                       | PENDING           |
| gb-2 — PT-Q carry-over hygiene pack                        | Land or explicitly re-record the §7 carry-overs: q-1 cache-eviction LRU note + `format.ts` null-JSDoc sharpening; q-2 two value-duplicate token pairs (merge or document) + pin all 4 theme probes; q-3 Escape during export `working` phase; q-4 help-copy hint trim + entry-module error handler through `CliIo`; q-6 commit the perf probe harness. Done-when: behavior items pinned by tests (Escape, CliIo); doc/note items grep-provable; full gates green. Re-record any item NOT landed with a reason (no silent drops).                                                                   | PENDING           |
| gb-3 — desktop JSON/JSONL open (vendored `json` extension) | Slice-2 gap 1: desktop open of JSON/JSONL needs DuckDB's `json` extension, refused offline. Vendor it per the slice-1 parquet precedent: `apps/vscode/assets/duckdb/json.duckdb_extension.wasm` + `.pinned` digest companion, registered in the vendored-assets manifest, digest-verified at build (no mutable fetch). Done-when: real-host e2e opens JSON + JSONL fixtures in VS Code offline (extends the runner scenarios); digests pinned; gap closed in docs. **STOP:** if the vendored `json` build requires a DuckDB/WASM version change, report — no engine upgrade in this row.           | PENDING           |
| gb-4 — external-parquet DOUBLE row-diff quirk              | Slice-2 gap 2: externally written parquet (DuckDB 1.5.x CLI) with DOUBLE columns reports equal values as changed (both surfaces agree, so agreement holds). Reproduce with a MINIMAL golden fixture (fixtures rule: no real/sensitive data; regenerate deliberately); root-cause the engine row-diff read path; fix with regression test, or document as an upstream read-side limitation with evidence if that is the finding. Done-when: byte-exact CLI/web report contracts unchanged; fixture + regression test shipped (or documented evidence); six-leg installed-CLI agreement stays green. | PENDING           |
| gb-5 — honest repo-root CLI dev error                      | Slice-2 gap 3: `node apps/cli/dist/index.js` from repo root fails opaquely ("internal error (no details)") because workspace exports resolve to src TS. Detect that condition at CLI entry and print an actionable, value-free dev error pointing to the packed-consumer flow (pack-consumer-smoke pattern). Done-when: unit pin simulating the workspace-exports condition; real repo-root invocation shows the friendly error; packed-consumer smoke unchanged and green.                                                                                                                        | PENDING           |

## 3. STOP boundaries

- ADRs 0025/0037/0045 govern gb-1: the disclosure must state implemented
  truth only; no disclosure of dataset contents, sensitive filenames, raw
  SQL results, cell values, or PII anywhere in the doc.
- gb-2 must not change pinned bytes (theme token VALUES stay
  declaration-exact; merging duplicate pairs means both names alias one
  token or a documented note — not new colors).
- gb-3 adds a vendored binary asset: digest-pinned at rest, verified at
  build; the offline netblock stays (no runtime fetch); vendored parquet
  digests unchanged.
- gb-4: never weaken an assertion to make a quirk pass; if DuckDB itself
  misreads, document with a reproducer, don't paper over it.
- No telemetry behavior, dependency-direction, CSP, or export-safety
  changes. Workers report exact paths, exit codes, commit hashes,
  deviations; parent re-runs verification rather than trusting tails.

## 4. Closure

**Not closed.** Rows land serialized; slice-2 queue closure remains the
model. Remote CI status remains unclaimed until M6 (billing) is restored.

## 5. Human inputs (not agent work)

- **M1** npm `@assay` org claim; **M4** trademark/domain clearance; **M6**
  GitHub Actions billing/limit restore (remote CI unclaimed until then).
- Telemetry collector deployment (D2b G0 tail — hosting decision) — the
  gb-1 disclosure describes the contract, not a live endpoint.
- **O5 demo dataset**: hybrid decision (real open data + injected flaws,
  2026-09-16) needs the maintainer's open-data source pick before curation
  starts (licensing + taste); agent curation follows that pick.
- Dependabot branch triage (4 remote branches, force-updated, pending) and
  GLM worker-lane API key renewal (401).
