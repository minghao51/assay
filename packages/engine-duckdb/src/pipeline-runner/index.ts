// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The pipeline runner surface (p-3; p2-4 gate execution) — see `runner.ts`
 * for the execution contract and `plan.ts` for the pure boundary gates.
 */
export { executePipeline, pipelineExportPath } from './runner.js'
export type {
  PipelineRunCanceled,
  PipelineRunCompilers,
  PipelineRunCompleted,
  PipelineRunDiffCompilerInput,
  PipelineRunEngineOps,
  PipelineRunExport,
  PipelineRunGated,
  PipelineRunGateResult,
  PipelineRunNodeResult,
  PipelineRunOptions,
  PipelineRunResult,
  PipelineRunSource,
  PipelineRunSourceFile,
  PipelineRunValidationCompilerInput,
} from './runner.js'
export { PipelineRunRefusalError, PipelineRunError } from './errors.js'
// p3-2: the candidate DatasetVersion reference derived from a completed/gated
// run (the D17-Q4 identity), public so p3-3/p3-4 consume the same seam the
// runner produces instead of re-deriving the mapping.
export {
  CANDIDATE_SCHEMA_FINGERPRINT_ALGORITHM,
  candidateVersionRefFromRun,
} from './candidate-ref.js'
export type { CandidateVersionRefInput } from './candidate-ref.js'
export type { PipelineRunPartialNode, PipelineRunRefusalReason } from './errors.js'
export { PipelineRunGuard } from './guard.js'
export {
  LOCAL_RUN_MATERIALIZATION_MODES,
  assertRunnableRelation,
  assertSqlAccepted,
  resolvePlan,
  validateCompilePlan,
} from './plan.js'
export type {
  LocalRunMaterializationMode,
  PipelineRunBindings,
  PipelineRunColumn,
  PipelineRunContractBinding,
  PipelineRunDataNode,
  PipelineRunDiffKeysBinding,
  PipelineRunDiffNode,
  PipelineRunInput,
  PipelineRunPlan,
  PipelineRunPlanNode,
  PipelineRunPublishNode,
  PipelineRunValidateNode,
} from './plan.js'
