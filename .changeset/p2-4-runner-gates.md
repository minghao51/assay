---
'@assay/engine-duckdb': minor
'@assay/testing': minor
---

feat(p2-4): pipeline runner gate execution + materialization on the engine

The reserved ADR 0035 node classes now EXECUTE (architecture §9 steps 6–7):

- **Materialization**: a data node's ADR 0033 mode is honored — `view`/
  `ephemeral` (session view), `table` (DuckDB table), `export` (Parquet
  artifact under OPFS `assay-exports/assay-pipeline-export-…` via the m4-2
  VFS→OPFS two-step). The prior relation's view **and** table are dropped
  first, so a re-run recreates and a mode change cannot leave the wrong kind.
  Additive wire op `engine/pipeline-execute` (request-type pin 19→21).
- **Validate nodes** run the existing M5 machinery over a session relation:
  the host supplies the parsed contract (C2 — the engine never resolves
  paths), a host-supplied pure compiler builds the plan, and the existing
  `engine/validate` op executes it. A failing verdict (not consumed by a
  publish) is the first-class `gated` run outcome.
- **Diff nodes** run the M6 row-diff machinery against two session relations
  via the additive `engine/pipeline-diff` op, surfacing value-free aspect
  counts. The m6-2 `runDiff` body is factored into a shared core.
- **Publish nodes** are gate evaluation: every `requires` edge must have
  succeeded, else the run is `gated` at the publish (`publish-blocked`).
  Publish-MODE materialization stays a typed refusal (the P3/DCR boundary).
- **Gated outcome**: `PipelineRunResult` gains `status:'gated'` with
  `gatedAt`, `gate`, the named partial state, and a `nextNodeId` mirror so
  existing rendered surfaces keep compiling. A re-run after a fix completes.
- **Carry-over reconciliations**: export-with-consumers is a typed refusal;
  the runner resolves the distinct `assay-pipeline-export-` destination;
  the parse/compile spelling split is documented; `validateCompilePlan` is
  tightened to check materialization/statement/statementKind presence and
  consistency.
- `@assay/testing`: the pipeline-runner conformance suite grows seven
  scenarios (validate pass/gated, publish gate + re-run-after-fix, diff node,
  table/export materialization, mode refusals) with a `relationKind` probe and
  a typed `refusalReason` classifier. No orchestration; `pipeline_run`
  telemetry stays reserved.
