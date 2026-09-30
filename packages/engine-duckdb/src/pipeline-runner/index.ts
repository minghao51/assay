// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The pipeline runner surface (p-3) — see `runner.ts` for the execution
 * contract and `plan.ts` for the pure boundary gates.
 */
export { executePipeline } from './runner.js'
export type {
  PipelineRunCanceled,
  PipelineRunCompleted,
  PipelineRunEngineOps,
  PipelineRunNodeResult,
  PipelineRunOptions,
  PipelineRunResult,
  PipelineRunSource,
  PipelineRunSourceFile,
} from './runner.js'
export { PipelineRunRefusalError, PipelineRunError } from './errors.js'
export type { PipelineRunRefusalReason } from './errors.js'
export { PipelineRunGuard } from './guard.js'
export {
  assertRunnableRelation,
  assertSqlAccepted,
  resolvePlan,
  validateCompilePlan,
} from './plan.js'
export type { PipelineRunInput } from './plan.js'
