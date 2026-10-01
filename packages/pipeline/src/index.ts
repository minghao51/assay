// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * @assay/pipeline — the Assay Pipeline IR (p-1; ADR 0030/0029/0032).
 *
 * A pure package: the canonical, versioned Pipeline IR AST; a total
 * (never-throwing) YAML parser with typed line/column errors; a byte-stable
 * canonical serializer; DAG validation (single-writer, resolvable references,
 * port arity/type-shape, acyclicity); the transform → SQL compiler for the P1
 * vocabulary (select-columns/rename/cast/filter plus validated verbatim-SQL
 * nodes); and the shared identifier helper for rendering port names into SQL.
 * No React, no browser APIs, no engine implementation; no
 * dbt/SQLMesh/Dagster runtime concepts (lint-enforced).
 *
 * Compilation is pure and total, overlay-agnostic, and deliberately scoped to
 * query text (p-3 owns materialization and execution). Anything outside the
 * four compiled operations is expressible as a `sql` node — see the escape-
 * hatch contract in `compile/compile.ts`.
 *
 * The three P1-executable classes are `source`, `transform`, `sql`; `validate`
 * and `publish` are typed to architecture §5's shapes but carry no execution
 * semantics (P2), and `diff`'s body is carried opaquely because §5 does not
 * settle it.
 *
 * Export discipline mirrors `@assay/contracts`: property-test generators
 * (`property-testing.ts`) and the internal YAML node walk (`validate.ts`) stay
 * in-package.
 */
export {
  DATA_NODE_CLASSES,
  EXECUTABLE_NODE_CLASSES,
  PIPELINE_IR_VERSION,
  PIPELINE_NODE_CLASSES,
  RESERVED_NODE_CLASSES,
  canonicalNodeOrder,
  compareNodeIds,
  isExecutableNodeClass,
  isPipelineNodeClass,
  portTypeOf,
} from './ast.js'
export type {
  DiffNode,
  ExecutableNodeClass,
  OperationConfig,
  PipelineIrVersion,
  PipelineMap,
  PipelineNode,
  PipelineNodeClass,
  PipelineScalar,
  PipelineV1,
  PipelineValue,
  PortType,
  PublishNode,
  ReservedNodeClass,
  SourceConfig,
  SourceNode,
  SqlNode,
  TransformNode,
  ValidateNode,
} from './ast.js'
export { describePipelineError } from './errors.js'
export type {
  PipelineError,
  PipelineErrorCode,
  PipelineParseResult,
  PipelineValidationResult,
} from './errors.js'
export { parsePipeline } from './parse.js'
export { serializePipeline } from './serialize.js'
export { validatePipeline } from './dag.js'
export { quotePortIdentifier } from './identifiers.js'
export { sanitizePipelineText } from './sanitize.js'
export {
  COMPILED_TRANSFORM_OPERATIONS,
  classifyVerbatimSql,
  compilePipeline,
} from './compile/index.js'
export type {
  CompiledNode,
  CompiledTransformOperation,
  PipelineCompilePlan,
  PipelineCompileResult,
  VerbatimSqlClassification,
  VerbatimSqlRefusal,
} from './compile/index.js'
