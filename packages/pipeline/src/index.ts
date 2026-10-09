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
 * The DCR artifact core (p3-1; ADR 0046/D17) shares the discipline: a pure
 * builder (`buildDcrArtifact`), a byte-stable canonical serializer
 * (`serializeDcr`), a total parser (`parseDcr`, never throws), and typed
 * located errors — the local-derivable v1 DCR per ADR 0014's field list.
 *
 * Export discipline mirrors `@assay/contracts`: property-test generators
 * (`property-testing.ts`, `dcr-property-testing.ts`) and the internal YAML
 * node walks (`validate.ts`, `dcr-validate.ts`) stay in-package.
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
export {
  DCR_COLUMN_FAMILIES,
  DCR_FORMAT,
  DCR_PRIVACY_NOT_COMPUTED_DISCLOSURE,
  DCR_PROFILE_COLUMN_KINDS,
  DCR_RESERVED_PREFIX,
  DCR_ROW_DIFF_ASPECTS,
  DCR_SCHEMA_DRIFT_KINDS,
  DCR_VERSION,
  compareDcrAspects,
  compareDcrSchemaDriftFindings,
  compareDcrStrings,
  isAnchorFreeRowKey,
  isDcrColumnTypeFamily,
  isDcrProfileColumnKind,
  isDcrRowDiffAspect,
  isDcrSchemaDriftKind,
} from './dcr-ast.js'
export type {
  DcrArtifactV1,
  DcrCategoricalDistributionDelta,
  DcrCategoricalTopKEntry,
  DcrColumnDistributionDelta,
  DcrDeltas,
  DcrLineage,
  DcrMaterializationRef,
  DcrNumericDistributionDelta,
  DcrPrivacyFindings,
  DcrProfileColumnKind,
  DcrProvenance,
  DcrRowDiff,
  DcrRowDiffAspect,
  DcrRowDiffAspectResult,
  DcrRowDiffSample,
  DcrColumnTypeFamily,
  DcrSchemaDriftFinding,
  DcrSchemaDriftKind,
  DcrSchemaFingerprint,
  DcrValidationRuleRow,
  DcrValidationVerdict,
  DcrVersion,
  DcrVersionRef,
} from './dcr-ast.js'
export { buildDcrArtifact } from './dcr-build.js'
export type { DcrBuilderInput } from './dcr-build.js'
export { describeDcrError } from './dcr-errors.js'
export type { DcrBuildResult, DcrError, DcrErrorCode, DcrParseResult } from './dcr-errors.js'
export { parseDcr } from './dcr-parse.js'
export { serializeDcr } from './dcr-serialize.js'
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
