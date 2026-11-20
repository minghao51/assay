# Local tooling checks: `current-state:check` and `doctor`

**Added:** 2026-11-20 (improvement-plan rows A02 and A04). Both are small,
offline, zero-dependency Node scripts under `scripts/`. Neither is part of
`pnpm test`, neither writes to the repository, and neither claims more than the
bounded checks listed here.

## 1. `pnpm current-state:check` — narrow documentation drift checks

`scripts/check-current-state.mjs` compares a **finite, registered set** of
current-state statements with the single authoritative source for each one. It
exists because `pnpm docs:links:check` only proves that a link target exists, and
`pnpm adr:index:check` only regenerates ADR titles/statuses — neither notices a
merge that leaves the living handoff, README or a package README describing a
superseded state.

Exit codes: `0` when every assertion holds, `1` when any drifts. Findings print
as `file:line: [fact] expected … — actual …`. Normal mode writes nothing.

### Registered facts and their sources of truth

| Fact                 | Authoritative source                                                            | Statement checked                                                                                                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dev-node-policy`    | root `package.json` `engines.node`                                              | `.node-version` major agrees; `AGENTS.md`, `README.md` and the node support contract §1 quote the same `Node <major>` line and the exact engines string.                                                                                                            |
| `workspace-packages` | `pnpm-workspace.yaml` `packages:` globs                                         | every `apps/<dir>` / `packages/<dir>` holding a `package.json` is covered by a glob; every glob expands to at least one; package names are unique.                                                                                                                  |
| `supported-formats`  | `apps/cli/src/connection.ts` `SUPPORTED_FORMATS`                                | the handoff §1 sentence ("for N input formats — **…**") and the README intro parenthesis name the same set and the same count.                                                                                                                                      |
| `active-queue`       | the dated pickup tables (`docs/process/handoff/20261118-post-ew03ia-pickup.md`) | the handoff's top "Current state / next action" block keeps the sentinel "No row is selected for dispatch.", its "Recorded but unselected:" clause names exactly the rows the pickup marks "recorded, not selected", and it names no CLOSED row as the next action. |
| `package-allowlist`  | `packages/engine-duckdb/package.json` `files`                                   | when the package README claims the recursive `dist/pipeline-runner/**` allowlist, the manifest carries all four recursive globs (and the README does not fall back to "flat only").                                                                                 |

Inputs are read as **data only**: JSON is `JSON.parse`d, Markdown/YAML/TS are
pattern-matched. Nothing from a document is imported, evaluated or executed.

### Deliberate limits

- **Not semantic freshness coverage of all Markdown.** Only the blocks above are
  read; a fact can be wrong in a way these patterns cannot see, and a rewritten
  sentence can pass. Every other file — §2 verified-state narratives, closed
  queue rows, the handoff snapshot, archives — may say anything and must.
- **History cannot trip it by construction.** Checks are anchored to the living
  handoff's current-state paragraph and to `## 1. Product and scope`, not to the
  document as a whole; `scripts/check-current-state.test.mjs` appends a closed
  historical narrative and asserts zero findings.
- **Not checked:** dates, commit SHAs, gate/coverage counts, "tested <version>"
  claims, ADR statuses (`pnpm adr:index:check`), link existence
  (`pnpm docs:links:check`), the prose package total in
  [contributing](../process/contributing.md), and any runtime behavior.
- The active-queue classification is a bounded heuristic over the pickup's table
  cells (a row is CLOSED when any cell says `CLOSED`; remaining rows are those a
  cell marks "recorded, not selected"). If the pickup is restructured, the checks
  fail loudly rather than silently passing.

### Regression evidence

`scripts/check-current-state.test.mjs` (run by `pnpm test`, `node` vitest
project) mutates each registered source fact in memory — root engines,
`.node-version`, `AGENTS.md`, the node contract, the workspace glob list, a
package directory outside the globs, a duplicate package name,
`SUPPORTED_FORMATS`, the handoff §1 list, the sentinel, the unselected clause, a
closed-row "next" claim, the pickup status cell, the engine `files` array and the
package README claim — and asserts the checker fails with a located finding for
that fact. The unmutated repository must pass (the baseline test), so the suite
is also the drift alarm.

## 2. `pnpm run doctor` — safe offline contributor preflight

`scripts/doctor.mjs` reports whether this checkout has what the documented
workflow needs. It never installs, downloads, builds, formats, deletes, edits
configuration, dumps the environment, inspects datasets or launches the app or a
dev server. It runs only trusted version probes with a timeout, reads a fixed
path set, and binds a loopback socket to test whether a port is free.

```bash
pnpm run doctor            # human table
pnpm run doctor --json     # {strict, checks:[{check,status,expected,actual,help}]}
pnpm run doctor --strict   # optional e2e/desktop prerequisites become failures
```

Use `pnpm run doctor`, not bare `pnpm doctor`: **pnpm 11 ships its own built-in
`doctor` command and a built-in name wins over a same-named script**, so the
bare form runs pnpm's installation diagnostics. The root script is still named
`doctor` (`"doctor": "node scripts/doctor.mjs"`), so `pnpm run doctor` (or
`node scripts/doctor.mjs` directly) is the preflight.

Exit codes: `0` pass/warn, `1` mandatory failure, `2` usage error.

| Check               | Expected                                                         | Status                      | Documented command                        |
| ------------------- | ---------------------------------------------------------------- | --------------------------- | ----------------------------------------- |
| `node`              | root `engines.node` policy (A03: `^24.0.0`); exact version shown | mandatory                   | install Node 24, then `pnpm install`      |
| `pnpm`              | `packageManager` pin (`pnpm@11.26.0`)                            | mandatory                   | `corepack enable`                         |
| `node_modules`      | dependencies installed at the root                               | mandatory                   | `pnpm install`                            |
| `workspace-dirs`    | `apps/{cli,vscode,web}`, `packages/{domain,engine-duckdb}`       | mandatory                   | run from a full checkout root             |
| `duckdb-cli`        | pinned DuckDB CLI v1.5.x at `$DUCKDB` or `/tmp/duckdb`           | optional (`--strict`: fail) | install the pinned CLI, or set `DUCKDB`   |
| `playwright`        | a Chromium build in the Playwright cache                         | optional (`--strict`: fail) | `pnpm exec playwright install chromium`   |
| `vscode`            | `code` CLI or the offline `~/.vscode-test` cache                 | optional (`--strict`: fail) | open in VS Code; `xvfb-run` when headless |
| `build`             | `dist/` output for the three e2e servers                         | optional (`--strict`: fail) | `pnpm build`                              |
| `port-web`          | 4173 free (`ASSAY_E2E_PORT_WEB`)                                 | optional (`--strict`: fail) | stop the listener, or override the port   |
| `port-engine`       | 4179 free (`ASSAY_E2E_PORT_ENGINE`)                              | optional (`--strict`: fail) | stop the listener, or override the port   |
| `port-data-sources` | 4180 free (`ASSAY_E2E_PORT_DS`)                                  | optional (`--strict`: fail) | stop the listener, or override the port   |

A malformed port override is a configuration fault and fails in both modes. The
port environment names are the ones [the Playwright config](../../playwright.config.ts)
already reads; the setup commands are the ones in the README quickstart,
`AGENTS.md` § Commands and [handoff §4](../process/handoff.md).

Output privacy: results never contain tokens, environment values, the home
directory or user file names. A path is named only by its documented label
(`/tmp/duckdb`, `$DUCKDB`, "the Playwright browser cache"), never by its value.

A green preflight means the local prerequisites are present. It is not a test
run and does not claim the product is healthy — `pnpm test`, the browser suite
and `pnpm build` remain the gates.

`scripts/doctor.test.mjs` exercises the injected environment/fs/command seams:
a missing executable, a wrong version, a probe timeout, a path containing spaces,
an occupied port, an unavailable port probe, an invalid port override,
`--strict` promotion, the stable JSON field set, usage errors and output privacy.

## 3. `pnpm assurance-map:check` — bounded assurance-map consistency

`scripts/check-assurance-map.mjs` (improvement-plan row E03) keeps
[the assurance coverage map](11-assurance-coverage-map.md) from drifting away
from the repository without pretending to check semantics. It proves four
things:

| Fact                    | What it verifies                                                                                                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `map-exists`            | the map document exists and still carries its `\| Contract \|` table header                                                                                             |
| `assertion-paths-exist` | every backticked repo-relative path the map names resolves on disk                                                                                                      |
| `runner-classified`     | every **test** file the map names is swept by a Vitest project `include` (minus its `exclude`), a Playwright `testDir`/`testMatch`, or a declared extension-host runner |
| `runner-scripts-exist`  | the runner scripts/manifests exist and the root `package.json` declares `test`, `test:coverage`, `test:e2e` and `assurance-map:check`                                   |

The Vitest projects and Playwright discovery are **parsed from the committed
configs** (not hard-coded), so a restructured config fails the check instead of
silently classifying nothing. Exit codes: `0` clean, `1` drift; findings print
as `map:line: [fact] message`. Normal mode writes nothing.

Deliberate limits: it does **not** check that a named assertion still asserts
its contract, the map's subject/environment/command cells, coverage numbers,
dates or SHAs, and it cannot see that a test skips at runtime. Only the
registered path prefixes (`apps/`, `packages/`, `tests/`, `scripts/`, `docs/`,
`fixtures/`) plus the three root config files are path-checked; anything else in
backticks (`.changeset/` names, commands, environment variables) is ignored.

`scripts/check-assurance-map.test.mjs` mutates the real map/config text in
memory — a missing map, a removed table header, an invented path, a removed
`scripts/**/*.test.mjs` include, a renamed web include, an emptied projects
list, a Playwright `testDir` moved away from `tests/e2e`, a missing visual
config, a missing extension-host runner script, a removed root script and an
unparseable `package.json` — and asserts each produces a located finding, with
the unmutated repository passing. It runs in `pnpm test` (the `node` Vitest
project's `scripts/**/*.test.mjs` include); the check is not wired into CI as a
separate step, because its test is the gate.
