# Node support contract — development policy vs product floors (A03)

**Date:** 2026-11-20. **Status:** record of selected decision **Q1** (see the
[execution record](20261120-improvement-plan-execution.md) §2) plus the constraint table required by
the improvement plan's A03. This document states policy and evidence; it does not change any
package's declared engines.

## 1. Decision (Q1, selected)

The **development** support contract is the **Node 24 line**: the root `package.json` `engines` is
`^24.0.0`, matching `.node-version` (`24`) and CI (`node-version-file: .node-version` in
`.github/workflows/ci.yml`, lines 40/120/198/268 — verified 2026-11-20, unchanged by A03).
**Product manifests keep their declared `node: ">=22"` floor**; that floor is a product statement and
is deliberately not moved by this record.

## 2. Constraint table (complete locked `engines` strings, verbatim from the manifests)

| Surface / role                        | Manifest(s)                                                                                                   | Locked `engines` (verbatim)                    | Tested runtime                         | Notes                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Root development policy (tooling)     | `package.json` (root)                                                                                         | `"node": "^24.0.0"` (set by A03; was `">=22"`) | 24.13.0                                | `.node-version`: `24`; CI selects it via `node-version-file`                                            |
| Tooling floor — ESLint (locked)       | `eslint@10.11.0` (root devDep `^10.11.0`)                                                                     | `"node": "^20.19.0 \|\| ^22.13.0 \|\| >=24"`   | 24.13.0 (`pnpm lint`)                  | Floor is `22.13.0`, not bare `22.0.0`; moot under the Node 24 development policy                        |
| Tooling floor — Vitest (locked)       | `vitest@4.1.11` (catalog `^4.1.11`)                                                                           | `"node": "^20.0.0 \|\| ^22.0.0 \|\| >=24.0.0"` | 24.13.0 (`pnpm test`)                  |                                                                                                         |
| Shipped CLI                           | `apps/cli/package.json`                                                                                       | `"node": ">=22"`                               | 24.13.0 only                           | Declared product floor; **22.x minimum not exercised in this environment**                              |
| Web app (build/dev surface)           | `apps/web/package.json`                                                                                       | `"node": ">=22"`                               | 24.13.0 only                           | Same unexercised floor                                                                                  |
| Extension host                        | `apps/vscode/package.json`                                                                                    | `"vscode": "^1.90.0", "node": ">=22"`          | host `1.130.0` (pinned, separate legs) | VS Code host is tested separately (`xvfb-run` when headless, `~/.vscode-test/vscode-linux-x64-1.130.0`) |
| Library packages (declared floor)     | `packages/{contracts,data-sources,diff,domain,engine-duckdb,grid,pipeline,telemetry,validation}/package.json` | `"node": ">=22"` (each, identical)             | 24.13.0 only                           | Product floor preserved; A03 does not touch package manifests                                           |
| Scaffold packages (no floor declared) | `packages/{ai,core,engine,engine-parquet,security,testing,transforms,ui}/package.json`                        | none                                           | n/a                                    | No `engines` block exists today; adding one is out of scope for A03                                     |

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

1. **Product floor unexercised:** `node: ">=22"` remains declared on the shipped CLI, web app,
   extension and nine library packages, but its minimum is **not exercised in this environment**.
   A packed-CLI smoke at the 22-line minimum was not run (no Node 22 runtime is available here);
   the plan's acceptance item for that run remains open, not silently satisfied.
2. **`pnpm install --frozen-lockfile` after the root `engines` change:** exit code recorded in the A03
   commit message and the execution record — see §5 of the
   [execution record](20261120-improvement-plan-execution.md).
3. Contributor documentation stating the development requirement is **not** a support commitment for
   the product floor; the two statements coexist deliberately.
