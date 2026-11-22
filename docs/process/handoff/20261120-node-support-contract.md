# Node support contract — development policy vs product floors (A03)

**Date:** 2026-11-20. **Status:** record of selected decision **Q1** (see the
[execution record](20261120-improvement-plan-execution.md) §2) plus the constraint table required by
the improvement plan's A03. This document states policy and evidence; it does not change any
package's declared engines.

## 1. Decision (Q1 selected 2026-11-20; floor narrowed 2026-11-21)

The **development** support contract is the **Node 24 line**: the root `package.json` `engines` is
`^24.0.0`, matching `.node-version` (`24`) and CI (`node-version-file: .node-version` in
`.github/workflows/ci.yml`, lines 40/120/198/268).

**Update — 2026-11-21: the product manifests now declare the same line (`node: "^24.0.0"`).** The
maintainer asked whether a Node 22 floor is still required; it is not. Nothing in the product needs
22-only behaviour, no consumer is known to run it, and the `>=22` claim was never exercised (Q1's own
recorded limit). Leaving an unverified product claim in twelve manifests while every gate runs on
24.13.0 was the honesty problem, so the floor was narrowed rather than kept.

The range is `^24.0.0`, not `>=24`: a bare `>=` floor would silently claim Node 25+ support that no
gate runs — the same unverified-claim shape that made `>=22` wrong. The caret admits 24.x
patches/minors (24.13.0 is the tested runtime; no individual minor is claimed) and nothing later.
Moving to a later major is a deliberate manifest change plus a gate run on it.

## 2. Constraint table (complete locked `engines` strings, verbatim from the manifests)

| Surface / role                        | Manifest(s)                                                                                                   | Locked `engines` (verbatim)                    | Tested runtime                         | Notes                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Root development policy (tooling)     | `package.json` (root)                                                                                         | `"node": "^24.0.0"` (set by A03; was `">=22"`) | 24.13.0                                | `.node-version`: `24`; CI selects it via `node-version-file`; product floor now agrees (2026-11-21)     |
| Tooling floor — ESLint (locked)       | `eslint@10.11.0` (root devDep `^10.11.0`)                                                                     | `"node": "^20.19.0 \|\| ^22.13.0 \|\| >=24"`   | 24.13.0 (`pnpm lint`)                  | Floor is `22.13.0`, not bare `22.0.0`; moot under the Node 24 development policy                        |
| Tooling floor — Vitest (locked)       | `vitest@4.1.11` (catalog `^4.1.11`)                                                                           | `"node": "^20.0.0 \|\| ^22.0.0 \|\| >=24.0.0"` | 24.13.0 (`pnpm test`)                  |                                                                                                         |
| Shipped CLI                           | `apps/cli/package.json`                                                                                       | `"node": "^24.0.0"`                            | 24.13.0 (all gates)                    | Product floor narrowed 2026-11-21; the old `>=22` minimum was never exercisable here                    |
| Web app (build/dev surface)           | `apps/web/package.json`                                                                                       | `"node": "^24.0.0"`                            | 24.13.0 (all gates)                    | Same narrowed floor; the web app is built and tested on the development line                            |
| Extension host                        | `apps/vscode/package.json`                                                                                    | `"vscode": "^1.90.0", "node": "^24.0.0"`       | host `1.130.0` (pinned, separate legs) | VS Code host is tested separately (`xvfb-run` when headless, `~/.vscode-test/vscode-linux-x64-1.130.0`) |
| Library packages (declared floor)     | `packages/{contracts,data-sources,diff,domain,engine-duckdb,grid,pipeline,telemetry,validation}/package.json` | `"node": "^24.0.0"` (each, identical)          | 24.13.0 (all gates)                    | Narrowed 2026-11-21 with the apps; unpublished (no consumer artifact exists yet)                        |
| Scaffold packages (no floor declared) | `packages/{ai,core,engine,engine-parquet,security,testing,transforms,ui}/package.json`                        | none                                           | n/a                                    | No `engines` block exists today; adding one is out of scope for A03                                     |

### What `engines.node` does and does not describe

`engines.node` is an npm/tooling field. For the **extension** (`apps/vscode`) it describes the
toolchain that builds and tests the bundle, **not** the runtime inside the extension host — that is
the Node that the user's VS Code embeds, and VS Code enforces `engines.vscode`, never
`engines.node`. The manifest therefore does not claim "your VS Code needs Node 24"; it claims the
repository builds and gates this surface on the Node 24 line. The same reading applies to the library
packages: the floor is the line the project runs, not a per-consumer runtime check (npm only warns
unless `--engine-strict` is used).

### Separately recorded tested versions

- **Minimum:** not exercisable in this environment. The `22` line (and the exact `22.13.0` ESLint
  floor) cannot be exercised here, so **no claim is made that the product floor's minimum passes any
  gate**. This is an explicit limit, not a pass.
- **Selected current development runtime:** `24.13.0` — all baseline gates were green on it (execution
  record §1) and the A03 gate run below re-checks the docs gates on the same runtime.
- A major-line policy (`^24.0.0`) permits future Node 24 patches/minors; **those are not claimed as
  individually tested**.

## 3. Intentional version differences (recorded, not defects)

- **`@eslint/js@9.39.5` (range `^9.30.0`) vs `eslint@10.11.0`:** a deliberate major difference. No
  concrete unsupported-peer or API problem was found in this session — `pnpm lint` exits 0 with the
  pair (A00 baseline; re-run below). Recorded as intentional per A03; a dependency-compatibility pass
  (plan row E02) owns any future assessment. No dependency change is made here.
- **`@types/node` catalog `^26.6.2` (locked 26.6.2) vs selected Node 24:** typings are ahead of the
  tested runtime. Observation only — no incompatibility demonstrated, and A03 does not downgrade
  types or upgrade DuckDB/Arrow.

## 4. Explicit limits of this record

1. **Product floor is now the tested line, not a second unexercised claim:** `node: "^24.0.0"` is
   declared on the shipped CLI, web app, extension and nine library packages, and every gate in this
   environment runs on 24.13.0. What remains unexercised is _other_ 24.x patches/minors (the caret
   admits them; none is individually claimed); later majors are not admitted at all. The old `>=22`
   minimum is gone, so the plan's "verify the 22 floor" acceptance item is **closed by narrowing the
   claim**, not by a Node 22 run; if a Node 22 consumer ever appears, re-widening is a manifest change
   plus a 22-line run. `pnpm current-state:check` enforces the rule (fact 6,
   `product-node-floor`): every manifest that declares `engines.node` must equal the root
   `^24.0.0`.
   No published artifact existed under `>=22` (nothing is published yet), so no released package is
   retroactively narrowed.
2. **`pnpm install --frozen-lockfile` after the root `engines` change:** exit code recorded in the A03
   commit message and the execution record — see §5 of the
   [execution record](20261120-improvement-plan-execution.md).
3. Contributor documentation stating the development requirement is **not** a support commitment for
   the product floor; the two statements coexist deliberately.
