// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * @assay/pipeline — the Assay Pipeline IR (p-1; ADR 0030/0029/0032).
 *
 * A pure package: the canonical, versioned Pipeline IR AST; a total
 * (never-throwing) YAML parser with typed line/column errors; a byte-stable
 * canonical serializer; DAG validation (single-writer, resolvable references,
 * port arity/type-shape, acyclicity); and the shared identifier helper for
 * rendering port names into SQL. No React, no browser APIs, no engine
 * implementation; no dbt/SQLMesh/Dagster runtime concepts (lint-enforced).
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
