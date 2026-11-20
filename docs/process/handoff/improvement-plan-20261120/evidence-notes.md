# Planning evidence and boundaries

Baseline: `e68bde91d32b38a854c9fa573819a34ee418135f`; planning only, repository unchanged. Accepted Phase 1 artifacts live at `/tmp/assay-audit-phase1/`. This is a successor proposal, not a retroactive severity report or implementation.

## Directly inspected planning sources

- `AGENTS.md` (provided project instructions): privacy, immutable overlays, dependency direction, fixture and changeset rules.
- `docs/process/handoff/operating-model.md:1-129`: one scoped worker, independent reviewer, gates, integration, orchestrator ownership of shared files. A proposed task is not a completed or authorized row.
- `docs/product/03-execution-roadmap.md:1-253`: gate and sequencing constraints; historical first-wave wording is not authority to redispatch closed work.
- `docs/adr/README.md:1-75`: accepted/proposed distinctions. ADR 0043 remains Proposed; do not infer publication from changesets.
- `docs/product/02-mvp-scope-and-acceptance.md:1-141`: excluded enterprise/hosted work, local workflows, source immutability, cross-surface agreement.
- `docs/engineering/03-repository-structure.md:160-255`: package responsibilities and stale desktop summary; actual enforced rules in AGENTS/eslint prevail over the aspirational diagram.
- `docs/process/handoff.md:1-240`: later closures supersede stale introductory remaining-work language; ENG-3 CSV dialect display is already an identified candidate, not a new duplicate workstream.
- `/tmp/assay-audit-phase1/discovery-report.md:1-349`: inventories and source-based observations; accepted partition parent-verification records additionally reviewed for all 11 source partitions and dependencies. Historical provisional status paragraphs in those records describe review-time checkpoints, not the final dispatch status.
- `/tmp/assay-audit-phase1/semantic/parent-dispatch.json`: all 15 queues accepted as inspection, runtime unverified.

## Specific mechanisms re-read while planning

- `apps/vscode/src/pure/create-only-writer.ts:1-90`: exclusive open then stat before returning cleanup; no surrounding acquisition cleanup. Check-then-unlink is non-atomic. A fallback must close an owned descriptor but must not unlink an unproven path.
- `apps/web/src/export/save-destination.ts:1-243`: identity gate fails closed; no identity selects download. SaveWritable only declares write/close; writeExportCopy has no failure abort. Add best-effort abort as a proposal without claiming platform rollback.
- `apps/cli/src/dcr.ts:205-269`: writeDcrArtifactNew uses writeFile wx; no partial-file cleanup; creation exclusivity is not completed-content atomicity.
- `apps/web/src/csv/options.ts:1-160`: repeated parsed names overwrite; empty-string affordance intentionally absent. Duplicate rejection is a proposed policy improvement, not a prior declared invariant.
- `packages/data-sources/src/browser-file-source.ts:1-88`: rejection cached along with fulfilled File snapshot. Retrying on same instance changes exactly-once acquisition semantics; requires a small contract decision, must preserve fulfilled snapshot.
- `packages/grid/src/viewport-model.ts:365-459`; `packages/grid/src/contracts.ts:120-163`: list mutation consists of clear + sequential adds; per-call provider rejection guarantees do not supply whole-list transactionality; queue recovers from rejection. Prefer a designed atomic list seam over stacked caller rollback.
- `apps/web/src/sessions/session-reset.ts:1-79`: token increment then synchronous callback loop. Callback failure interrupts loop. This is a fault-boundary candidate, not demonstrated ordinary replacement failure.
- `apps/web/src/edit/session.ts:450-537`: setActive lies outside refresh protection; restore setActive may also throw; documentation's never-throws needs explicit contract clarification and controlled probes.
- `packages/engine-duckdb/src/client.ts:1125-1269`: second dispose call may return before existing disposal completes; shared completion semantics is a proposed strengthened contract, not an observed resource leak.
- `apps/web/src/telemetry/transport.ts:1-99`: per-attempt timeout abort and retry loop lack caller cancellation; default buffer fits one batch per accepted audit. Opt-out abort is an enhancement, not proof of egress incident.
- `packages/testing/src/engine-conformance.ts:1550-1581`: normalizer enumerates general objects; typed views refused; no explicit Date/Map branch. Do not silently expand/constrain normalization without supported-shape tests.
- `packages/testing/src/engine-conformance.ts:2090-2193` (read expanded to enclosing scenario): predicate-error-reuse checks counts/readiness/registry, not exact anchor cells, despite exact-values comment. Proposed test strengthening must preserve distinction between helper fakes and real browser adapter.
- `apps/web/src/validation/contract-import.ts:1-58`: parsed tag contains decoded text; callers parse. Rename for developer clarity without adding a new format feature.
- `package.json:1-46`; `vitest.config.ts:1-77`: scripts, root >=22 policy, actual coverage denominator and test projects. Webview instrumentation coverage requires explicit project design, not one include-glob change.
- `apps/web/src/App.tsx:2048-2117,2266-2322` through read_symbol: preparation uses candidate-local overlay, currency checks after awaits; adoption bumps token/resets before publish, then telemetry and intent clear. Refactor must preserve this ordering and not add early release.

## Existing ownership reconciliation

Independent read-only search by agent bcb72bef-1b4a-4fc, followed by parent primary reads:

- `docs/process/handoff/20261118-post-ew03ia-pickup.md:1-90,245-280`: latest header says no row selected; ENG-2/ENG-3 recorded but unselected. TB-2 is CLOSED (8-spawn equality pin, 45 s ceiling unchanged), ENG-1 is CLOSED (option C ADR amendment); old embedded prompts and dispatch paragraphs remain stale. New plan must not repeat those closed implementations.
- `docs/adr/0049-csv-options-preview-and-retention.md:207-271` (read expanded to enclosing section): dated option-C amendment intentionally retains one preview slot after abandonment until next preview/open/dispose; no release op. Stop still drops late UI results. Do not follow the superseded release-on-cancel prompt.
- `docs/adr/0051-column-repair-composition-shape.md:110-169`: accepted linear-size stacked composition; wide mask memory unmeasured; schema/cast bounds excluded; hygiene/memory extensions not selected.
- `docs/process/handoff/20261110-web-followup-map.md:87-118` (expanded to bounded task section): WF-O1 filter-draft clarity and WF-O2 temporal consumer parity remain separate design/selection scopes; WF-03/04/07/08/09 blocked. Do not fold them into aesthetic cleanups.

## Metrics used only for planning

`complexity.csv` reports physical file lengths (not maintainability scores): App.tsx 3,569; engine-executor.ts 2,605; overlay-query.ts 1,936; desktop host dataset.ts 965; desktop webview dataset.ts 2,329; engine-conformance.ts 3,892. Recount at implementation baseline; reduction is not itself an acceptance criterion.

## Important rejected inferences

No unused dependency or verified <20-line replacement; no bundle attribution from installed bytes; no demonstrated browser destination corruption, filesystem attack or telemetry incident; no automatic requirement for picker fallback, hard SQL interrupt, retired-table release, new JSON Schema UI, or broad per-test census. New plans must not reopen ADR 0047/0051 decisions or mark scaffolds as missing MVP functionality.
