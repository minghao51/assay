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
export type { PipelineRunRefusalReason } from './errors.js'
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
