# Local tooling checks: `current-state:check`

**Added:** 2026-11-20 (improvement-plan row A02). `scripts/check-current-state.mjs`
is a small, offline, zero-dependency Node script. It is not part of the gates
that prove runtime behavior, it writes nothing to the repository, and it claims
no more than the bounded checks listed here.

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
