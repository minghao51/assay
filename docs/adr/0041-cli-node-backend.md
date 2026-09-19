# ADR 0041: CLI validation runs on @duckdb/node-api behind the engine's `./node` seam

## Status

Accepted (2026-09-19, checkpoint 2 of the M5 CLI milestone; spike evidence in the m5-4
worker record and handoff §6)

## Context

M5 ships dataset validation on two surfaces. The web surface executes the m5-1 validation
plan inside the browser engine (DuckDB-WASM worker, ADR 0002/0021). The CLI surface
(`assay validate <path> --contract <file>`) must execute the same compiled plan under Node.
The engine package is browser-first (ADR 0002): its worker transport and storage assumptions
(module `Worker`, OPFS) do not hold under Node. The CLI needs a Node-resident DuckDB runtime
without forking the plan-execution semantics (byte-identical SQL, clamped samples, exact
half-up `failPercent`, containment, result-sanity bounds — m5-2, refined in m5-4).
Distribution is npm-only for the pre-MVP CLI (D10, default confirmed at sign-off), and every
new dependency must be license-compatible with AGPL-3.0-or-later (ADR 0036).

Three candidates were spiked (evidence in the m5-4 record):

1. **`@duckdb/node-api`** — official Node package, MIT (package and per-platform
   `@duckdb/node-bindings-*` binaries), tracks DuckDB 1.5.5 — exactly the version pinned for
   fixture/expectation derivation (ADR 0038). In-process, transactional, typed values via
   raw `getRowObjects()` (the JS-friendly accessor is lossy for wide DECIMAL — avoided).
   Cold `validate` on a 120-row dataset measured ≈ 0.4 s with tsx.
2. **Spawning the DuckDB CLI binary** — same engine version, but batch mode continues after
   SQL errors and exits 0; output is per-statement text with no statement framing. Unusable
   for an exit-code contract without fragile stderr scraping; ~100 MB binary is not
   npm-shippable.
3. **duckdb-wasm under Node** — installable, but the repo pins engine behavior to 1.5.5
   expectations while the wasm bundle is 1.32-era (type-inference drift), and the web
   engine's boot path assumes a browser module `Worker` and OPFS/File handles — both absent
   in Node. Double runtime, wrong engine version, worse performance.

## Decision

The CLI executes validation plans on **`@duckdb/node-api`** (MIT), registered as a dependency
of `apps/cli` only. Plan-execution semantics are **not forked**: the engine package exposes a
`./node` subpath (`packages/engine-duckdb/src/node.ts`) whose contents are pure re-exports of
the browser-free validate machinery (view composition, clamp wrapper, result-sanity bounds,
`failPercentFromCounts`, wire validation, format/view helpers); the CLI contributes only a
thin Node connection adapter (dataset registration, DESCRIBE, Arrow value bridge). The web
engine (ADR 0002) remains the only product surface inside the browser; the CLI validates the
base view only (no overlay editing exists there) and labels its output accordingly
(`baseViewOnly: true`, anchor-free row keys).

## Consequences

### Positive

- One set of validation semantics: executor, protocol shape check, and CLI all call the same
  guarded helpers (equivalence by construction, pinned by tests on both surfaces).
- Engine-version alignment with the pinned 1.5.5 expectation-derivation toolchain (ADR 0038)
  removes a whole class of cross-surface drift.
- npm-only distribution holds: prebuilt per-platform bindings, no install-time build scripts.
- MIT/Apache-2.0 dependency stack, AGPL-compatible (ADR 0036).

### Negative / risks

- A second DuckDB runtime enters the dependency graph (native bindings per platform) —
  accepted for the CLI surface only; the web app does not depend on it.
- Arrow value bridging has one documented variance: a DECIMAL/HUGEINT column straddling 2⁵³
  renders as text for all values (column homogeneity) where the web mixes per value —
  observable only with decimal data spanning ±2⁵³; pinned as documented behavior.
- `pnpm exec assay` does not resolve inside the workspace (pnpm does not link a package's own
  bin); documented invocations are `pnpm dev --` / `node --import tsx src/index.ts` until D10
  packaging.

### Neutral

- The `./node` subpath convention is now the template for any future environment-neutral
  engine seam; behavioral engine changes still require the normal boundary process.
- CLI cold start is dominated by tsx module loading (~0.3 s); a prebundle can reclaim it
  later without semantic impact.

## Alternatives considered

- **Spawn the DuckDB CLI binary**: rejected (broken batch error semantics, unshippable
  binary, fragile text contract).
- **duckdb-wasm under Node**: rejected (engine-version drift vs pinned expectations;
  browser boot assumptions; double runtime).
- **Fork a minimal SQL executor inside `apps/cli`**: rejected — forks the safety-critical
  clamp/containment/bound logic that m5-2 hardened; the seam exists precisely to prevent
  this.
