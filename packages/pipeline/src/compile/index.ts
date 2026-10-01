// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `@assay/pipeline` compilation surface (p-2): the transform → SQL
 * compiler and the verbatim-SQL safety classifier. See `compile.ts` for the
 * compiled vocabulary, the filter grammar, the escape-hatch contract, and
 * the purity/determinism guarantees; see `sql-safety.ts` for the classifier
 * rules.
 */
export {
  COMPILED_STATEMENT_KINDS,
  COMPILED_TRANSFORM_OPERATIONS,
  LOCAL_MATERIALIZATION_MODES,
  compilePipeline,
} from './compile.js'
export type {
  CompiledNode,
  CompiledStatementKind,
  CompiledTransformOperation,
  LocalMaterializationMode,
  PipelineCompilePlan,
  PipelineCompileResult,
} from './compile.js'
export { classifyVerbatimSql } from './sql-safety.js'
export type { VerbatimSqlClassification, VerbatimSqlRefusal } from './sql-safety.js'
