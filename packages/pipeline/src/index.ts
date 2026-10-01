// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * @assay/pipeline — the Assay Pipeline IR (p-1; ADR 0030/0029/0032).
 *
 * A pure package: the canonical, versioned Pipeline IR AST; a total
 * (never-throwing) YAML parser with typed line/column errors; a byte-stable
 * canonical serializer; DAG validation (single-writer, resolvable references,
 * port arity/type-shape, acyclicity); the transform → SQL compiler for the
 * compiled vocabulary (select-columns/rename/cast/filter/join/aggregate/window
 * plus validated verbatim-SQL nodes); and the shared identifier helper for
 * rendering port names into SQL.
 * No React, no browser APIs, no engine implementation; no
 * dbt/SQLMesh/Dagster runtime concepts (lint-enforced).
 *
 * Compilation is pure and total, overlay-agnostic, and carries the ADR 0033
 * mode → local statement mapping (p2-3) while keeping `sql`/`relation`
 * semantics unchanged. Anything outside the seven compiled operations is
 * expressible as a `sql` node — see the escape-hatch contract in
 * `compile/compile.ts`.
 *
 * The three P1-executable classes are `source`, `transform`, `sql`; each
 * accepts an optional `materialization` mode (ADR 0033; p2-2, absent = `view`).
 * `validate` and `publish` are typed to architecture §5's shapes but carry no
 * execution semantics (P2), and `diff`'s p2-2 shape is the typed
 * `{ input, against }` pair of table references.
 *
 * Export discipline mirrors `@assay/contracts`: property-test generators
 * (`property-testing.ts`) and the internal YAML node walk (`validate.ts`) stay
 * in-package.
 */
export {
  DATA_NODE_CLASSES,
  DEFAULT_MATERIALIZATION,
  EXECUTABLE_NODE_CLASSES,
  MATERIALIZATION_MODES,
  PIPELINE_IR_VERSION,
  PIPELINE_NODE_CLASSES,
  RESERVED_NODE_CLASSES,
  canonicalNodeOrder,
  compareNodeIds,
  isExecutableNodeClass,
  isDataNode,
  isMaterializationMode,
  isPipelineNodeClass,
  materializationOf,
  portTypeOf,
} from './ast.js'
export type {
  DataNode,
  DiffNode,
  ExecutableNodeClass,
  MaterializationMode,
  MaterializedNode,
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
  COMPILED_STATEMENT_KINDS,
  COMPILED_TRANSFORM_OPERATIONS,
  LOCAL_MATERIALIZATION_MODES,
  classifyVerbatimSql,
  compilePipeline,
} from './compile/index.js'
export type {
  CompiledNode,
  CompiledStatementKind,
  CompiledTransformOperation,
  LocalMaterializationMode,
  PipelineCompilePlan,
  PipelineCompileResult,
  VerbatimSqlClassification,
  VerbatimSqlRefusal,
} from './compile/index.js'
