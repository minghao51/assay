# Fillable execution envelopes — recommended first slice

These are **draft reservations**, not authorization. Verify current filenames, dependencies and working tree in A00. Copy only one row into a worker brief; fill approvals, SHA, branch, ports and reviewer before dispatch. `implementation-plan.md` is the full behavior/test specification. Source/test targets listed below exist at the audit baseline; proposed new paths are labelled.

## Shared envelope fields

```text
Task:
Selected by / date:
Approved decision(s) / exact option:
Current baseline SHA / dirty-tree disposition:
Authoritative current queue row:
Branch / worktree:
Worker:
Independent reviewer (different implementing session/model per runbook):
Port reservations: WEB=... ENGINE=... DS=...
Allowed source/test files:
Proposed new files explicitly reserved:
Orchestrator-only companion changes:
Forbidden files / invariants:
Exact failure to reproduce / expected unchanged paths:
Targeted commands + full gates:
Changeset package(s) / proposed bump rationale:
Stop conditions:
```

No execution approval → return this envelope unfilled with the minimum pending choices. Do not infer approval from a file being listed.

## A00 — Baseline only

- Allowed: repository reads and selected prerequisite/gate execution; logs under `/tmp/assay-maintenance/<sha>/A00/` (proposed path).
- Product/config/docs writes forbidden. Installing prerequisites, network downloads and fixture regeneration require explicit environment approval; don't hide them inside a test command.
- Deliver exact baseline results and proposed next envelope. Never reset a dirty checkout or convert missing infrastructure into a passing result.

## A01 — Documentation reconciliation (orchestrator)

- Candidate current entry points: `docs/process/handoff.md`, `docs/process/handoff/20261019-open-asks.md`, `docs/process/handoff/20261118-post-ew03ia-pickup.md`, `docs/engineering/03-repository-structure.md`, `docs/engineering/07-telemetry-collector.md`, `packages/engine-duckdb/README.md`, `SECURITY.md`, `.dsh/skills/assay-gates/SKILL.md`.
- Reserve only the subset actually addressed; no automatic right to every doc. A current clarification/errata document is a separately named new file.
- Security support policy needs maintainer decision. Changeset map correction is a separate selected intake edit after original-intent comparison.
- Forbidden: runtime source, package versions, accepted ADR decision-text rewrite, historical count/closure invention, publish/push.
- Focused gates: formatting, docs links, ADR index and state/evidence mapping. Full mandatory baseline per repository policy, not fabricated historical green.

## A03 — Development support contract (orchestrator)

- Start read-only: root/21 package engines, locked engine/peer ranges, `.node-version`, CI runtime selection.
- Reserve only chosen root `package.json`, `.node-version` (if needed), `.github/workflows/ci.yml`, README/AGENTS setup guidance. Product manifests only if their separate runtime contract actually changes.
- Decision Q1 required before editing support declarations. Preserve pinned engine/Arrow versions; @eslint/js/types version observations do not authorize upgrades.
- Deliver exact policy ranges versus exact tested versions, clean install/compatibility logs and independently reviewed boundary tests.

## B01 — Duplicate CSV declared types

- Allowed: `apps/web/src/csv/options.ts`, `options.test.ts`, `copy.ts`, `CsvReviewDialog.test.tsx`; `CsvReviewDialog.tsx` only if typed refusal display wiring is actually required.
- Optional additive browser spec: name it at reservation; any fixture/generator/manifest update requires an explicit additional path reservation and synthetic data only.
- Orchestrator companion: current behavior documentation + `.changeset/<new>.md` for `@assay/web` (proposed patch; confirm convention).
- Forbidden: engine/parser vocabulary, `App.tsx`, other packages, lockfile, new empty-string UI or case folding.
- Start with `pnpm exec vitest run apps/web/src/csv/options.test.ts --project web`; add dialog case ensuring no engine call on refusal. See full B01 acceptance matrix.

## B03 — Browser export writable cleanup

- Allowed: `apps/web/src/export/save-destination.ts`, `save-destination.test.ts`; additive assertions in `ExportDialog.test.tsx` only if required to pin no success on failure.
- Orchestrator companion: export behavior docs and `@assay/web` changeset.
- Forbidden: `App.tsx`, source identity policy, engine export SQL, download persistence claims, export cancellation UI, dependencies/lockfile.
- Focused unit suite: `pnpm exec vitest run apps/web/src/export/save-destination.test.ts --project web`. Real FSA browser test gets a separately named reservation and explicit capability prerequisite; don't substitute a fake for platform evidence.

## B04 — Desktop create-only writer acquisition

- Allowed: `apps/vscode/src/pure/create-only-writer.ts`, `create-only-writer.test.ts`; one internal writer-fs adapter/test helper if a named new file is reserved.
- Orchestrator companion: desktop export limitation docs + `@assay/vscode` changeset.
- Forbidden: CLI writer, host protocol, source canonicalization policy, unconditional path deletion, Node atomic-swap claims, dependencies/lockfile.
- Focused suite: `pnpm exec vitest run apps/vscode/src/pure/create-only-writer.test.ts --project node`; retain real filesystem cases and distinguish the injected fault seam. Run desktop/pinned-host regression through existing package scripts after build.

## C04 — Disposal await contract

- Allowed: `packages/engine-duckdb/src/client.ts`, `client.test.ts`; additive focused assertion in an explicitly reserved existing engine e2e spec.
- Orchestrator companion: lifecycle API notes + `@assay/engine-duckdb` changeset.
- Forbidden: worker protocol/status union, op lane design, table-release API, timeout changes, compiler/refactor or bundle/pin upgrades.
- Focused suite: `pnpm exec vitest run packages/engine-duckdb/src/client.test.ts --project node`. Pin equivalent settlement (not same Promise object), immediate terminal behavior and one teardown.

## C05 — Exact-value conformance anchor

- Allowed: `packages/testing/src/engine-conformance.ts`, `engine-conformance.test.ts`; `tests/e2e/engine-conformance.spec.ts` only under explicit cross-boundary test reservation, not app source.
- Orchestrator companion: assurance map + `@assay/testing` changeset if required by package-change policy.
- Forbidden: normalizer behavior changes, engine SQL/semantics, new input formats, fixture path API, unbounded result materialization.
- Focused suite: `pnpm exec vitest run packages/testing/src/engine-conformance.test.ts --project node`; after build, real browser engine conformance. Count-preserving cell corruption fake must fail; correct subject remains green.

## Reviewer prompt template

```text
Independently review selected task <ID>, baseline <SHA>, worker commits <...>,
using the task specification and filled envelope. You did not implement it.
Confirm the actual diff is inside reservation; use current ADR/queue authority.
Re-run targeted tests and required full gates in the correct worktree and ports.
Classify fakes/real temp FS/real browser/native/installed-host results honestly.
For each load-bearing claim, use a bounded mutation drill in a disposable
worktree; rebuild before e2e. Prove sensitivity, restore exactly, show clean tree.

Scrutinize error precedence, partial state, source immutability, stale-generation
fences, privacy, changeset and documentation alignment. No new policy or scope.
No destructive reset, publication, production network or sensitive fixtures.
If the task is only design/docs, review the specification; do not imply runtime
approval from this planning evidence.

Return VERDICT: approve or VERDICT: request-changes with numbered exact items,
commands/exits/log paths, unverified prerequisites and retained limitations.
```
