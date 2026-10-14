# Repository Maintenance Queue — 2026-10-14

**ACTIVE.** Maintainer authorized the recommended sequence on 2026-10-14:
documentation truth pass → packaging and VS Code CI → q-14 → author/execute
PT-V slice 2 → separate PT-Q maintenance. This queue is the first bounded batch;
it does not authorize public release, hosted/AI work, or vscode-web.

## 1. Protocol

Entry: `1c4b50f`, clean tree. Baseline 2026-10-14: format/lint/typecheck/unit/build
passed (20 typecheck tasks, 2938 tests / 180 files, 10 builds; Turbo caches used).
Worker: `openai-codex/gpt-6-luna`; parent session orchestrates and independently
reviews. The [operating model](operating-model.md) applies; serialized tasks,
briefs and logs in `/tmp`. Parent owns shared docs, root configs and workflow
integration. No push, publication, credential work or unrelated refactoring.

## 2. Task rows

| task                         | scope / done-when                                                                                                                                                                                                                                                                                                                                                                                          | status / evidence                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| rm-1 — current-state docs    | Orchestrator-owned Markdown only. Compact handoff preserving old evidence; fix false scaffold/pending labels in front-door docs and roadmap; label old pickup pack historical; record release/CI gaps honestly. Links + ADR index + format pass; no accepted ADR changed.                                                                                                                                  | DONE — orchestrator solo maintenance per §7.5. Handoff 147 KB → 8 KB with historical snapshot preserved; front-door truth repaired. Format, doc links (106 files / 0 broken) and ADR index (46 records) pass; source untouched, baseline core gates green.                                                                                                                                                                                  |
| rm-2 — packed CLI closure    | Worker: CLI smoke/build metadata + pipeline/telemetry/engine build references as needed, with an explicitly authorized package-boundary exception in the brief. Plain-node clean consumer installs the complete local runtime closure; pipeline + DCR command legs pinned. Source-checkout exports stay compatible; no runtime bundler/dependency additions. Package changesets; full gates + local smoke. | DONE — `a7dfe35` + `111121f`; parent request-changes → fix → approve. Complete 8-package runtime closure + standalone grid locally installed under plain Node; dirty validation/diff/pipeline/DCR pins, golden bytes and refusal semantics preserved. Parent export-path mutation fails; all gates green, 2938/180, e2e 172+1, coverage unchanged. Merged core gates + consumer smoke pass. Registry publication policy remains unresolved. |
| rm-3 — VS Code build/CI      | Worker: bounded `apps/vscode/**` changes and proposed workflow/config hunks; parent owns root/workflow edits. Root build includes VS Code; real-VSCode e2e + slice-1 offline exit harness are enforced in CI, with pinned runtime/cache/headless prerequisites. Vendored asset digests unchanged; local equivalents pass.                                                                                  | PENDING — after rm-2.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| q-14 — UNION projection gate | Worker: `packages/engine-duckdb/**`, minimal synthetic regression fixtures if needed and engine changeset. Every top-level UNION arm must satisfy required projection columns; literal/WHERE-only spoof and wrong arity rejected before execution, valid compiler SQL still accepted. Negative pins fail on old behavior; parent mutation drill + full gates/conformance.                                  | PENDING — after rm-3; existing PT-Q done-when applies.                                                                                                                                                                                                                                                                                                                                                                                      |

## 3. STOP boundaries and review

- Honor ADRs 0011/0012/0025/0030–0037/0041/0042/0046 and rulings D13/D17–D19.
- Packaging must not silently make private packages public or change the engine
  browser/worker distribution policy. If a durable publication/bundling decision
  is required, report it and propose an ADR; no accepted ADR rewrites.
- No telemetry behavior/consent change, dataset contents in logs, or dependency
  direction change. Treat cells as text and preserve formula-safe CSV exports.
- Workers report exact changed paths, command exit codes/counts, commit hashes,
  deviations and blockers. Parent re-runs verification rather than trusting tails.
- Relevant format/lint/typecheck/test/coverage/build/doc/ADR gates and e2e or
  harnesses must pass before a row closes. Record host-load re-runs explicitly.

## 4. Follow-on lane

Author PT-V slice 2 from [slice-1 §5](20261002-ptv-slice1-queue.md#5-closure):
edit + undo/redo, validation, staged diff/export agreement, Git context/diff
command and final real-VSCode acceptance evidence. Define narrow tasks and STOP
boundaries before dispatch; vscode-web remains RE-SCOPE. q-5b and q-7 slice 2
follow as separate tasks under [product/04 §7](../../product/04-post-mvp-track.md).

## 5. Closure

Not closed. Record per-row integration/review evidence here; do not replace
pending work with blanket claims that the repository is release-ready.
