// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * @assay/engine-duckdb — DuckDB-WASM implementation of the DataEngine interface.
 *
 * M1-2: `query()` transports the first Apache Arrow record batch to the main
 * thread (ADR 0020) over the typed postMessage protocol owned by this package
 * (ADR 0002/0021; no RPC library — the protocol stays swappable).
 *
 * M1-4: `open(source)` registers a picked local file with DuckDB inside the
 * worker (structural `EngineFileSource` seam — satisfied by a
 * `FileSystemFileHandle` or `BrowserFileSource`), `schema()` reports DuckDB's
 * type strings as-is, and `fetchRange()` serves visible-window sized Arrow
 * slices over the same IPC transport, validated/clamped on both sides of the
 * boundary so full-dataset materialization is never implied. The full
 * DataEngine surface and result-set streaming arrive with later M1 tasks.
 *
 * M1-5: `rowCount(handle)` reports the table's total row count via a
 * metadata-only `SELECT count(*)` — the total a virtualized grid needs to
 * size its scroll area without touching the data.
 *
 * m2-2: filtered/sorted windows — `fetchRange` accepts optional `filters`
 * (ordered AND-composed predicates, engine-SQL text per grid contracts v1)
 * and `sort` keys, and `rowCount` accepts optional `filters` for the filtered
 * total. SQL is composed over engine-generated view names with quoted
 * identifiers (`window-query.ts`); absent/empty fields keep the SQL
 * byte-identical to the pre-m2-2 behavior.
 *
 * m2-5: `profile(handle)` — full per-column statistics (nullCount/
 * distinctCount always; numeric min/max/mean/stddev/quantiles; categorical
 * top-k) composed as aggregate SQL over the registered view with a
 * documented scan budget (`profile-query.ts`), classified from DuckDB type
 * strings (`profile-classify.ts`, exotic types degrade gracefully), and
 * returned as plain JSON-able data — no Arrow transport needed.
 *
 * Ownership and dependency rules: docs/engineering/03-repository-structure.md.
 * Delivery sequencing: docs/product/03-execution-roadmap.md.
 */
export {
  DuckDbEngineClient,
  EngineDisposedError,
  EngineOperationError,
  EngineProtocolError,
  EngineQueryError,
  EngineWorkerError,
} from './client.js'
export type {
  DuckDbEngineClientOptions,
  EngineComparisonHandle,
  EngineCsvPreviewResult,
  EngineDatasetProfile,
  EngineExportResult,
  EngineFileSource,
  EngineOverlay,
  EngineOverlayCastCheck,
  EngineOverlayCastCheckResult,
  EngineOverlayWindow,
  EngineQueryResult,
  EngineRangeResult,
  EngineRangeWindow,
  EngineRowCountOptions,
  EngineStatus,
  EngineTableHandle,
  EngineWorkerFactory,
  EngineWorkerLike,
} from './client.js'
export { parseEngineRequest, parseEngineResponse } from './protocol.js'
export type {
  EngineColumnSchema,
  EngineCategoricalColumnStats,
  EngineCategoricalTopKEntry,
  EngineCsvPreviewRequest,
  EngineCsvPreviewResultResponse,
  EngineCsvPreviewSample,
  EngineCsvSniff,
  EngineCsvSniffColumn,
  EngineDisposedResponse,
  EngineDisposeRequest,
  EngineDiffRequest,
  EngineDiffResultResponse,
  EngineDiffStageRequest,
  EngineDiffStageResultResponse,
  EngineErrorResponse,
  EngineExportFormat,
  EngineExportRequest,
  EngineExportResultResponse,
  EngineFilterSpec,
  EngineInitRequest,
  EngineNumericColumnStats,
  EngineNumericQuantiles,
  EngineOpenRequest,
  EngineOpenResultResponse,
  EngineOverlayCastCheckRequest,
  EngineOverlayCastCheckResultResponse,
  EngineOverlayRangeRequest,
  EngineOverlayRangeResultResponse,
  EngineOverlayRowCountRequest,
  EngineOverlayRowCountResultResponse,
  EngineOverlaySchemaRequest,
  EngineOverlaySchemaResultResponse,
  EnginePipelineMaterializeRequest,
  EnginePipelineMaterializeResultResponse,
  EnginePipelineSourceRequest,
  EnginePipelineSourceResultResponse,
  EngineProfileColumn,
  EngineProfileColumnKind,
  EngineProfileComparisonRequest,
  EngineProfileRequest,
  EngineProfileResultResponse,
  EngineQueryRequest,
  EngineQueryResultResponse,
  EngineRangeRequest,
  EngineRangeResultResponse,
  EngineReadyInfo,
  EngineReadyResponse,
  EngineRepairPlan,
  EngineRepairPreviewCountRequest,
  EngineRepairPreviewCountResultResponse,
  EngineRequest,
  EngineResponse,
  EngineRowCountRequest,
  EngineRowCountResultResponse,
  EngineSchemaRequest,
  EngineSchemaResultResponse,
  EngineSortSpec,
  EngineSuccessResponse,
  EngineValidateRequest,
  EngineValidateResultResponse,
} from './protocol.js'
// EW-03I fold: the closed CSV option vocabulary — the total boundary parser
// and the composed scan/sniff/sample/view SQL — public so hosts (EW-03I-b's
// web panel) validate through the SAME implementation they execute against
// instead of re-deriving the vocabulary locally (ADR 0049 item 2).
export {
  csvCreateViewSql,
  csvSampleSql,
  csvScanRelationSql,
  csvSniffSql,
  effectiveCsvOptions,
  MAX_CSV_OPTION_VALUE_CODE_POINTS,
  MAX_CSV_TYPE_COLUMNS,
  parseCsvOptions,
} from './csv-options.js'
export type {
  CsvOptionsContext,
  CsvOptionsParseResult,
  EngineCsvEffectiveOptions,
  EngineCsvOptions,
  EngineCsvOptionsInput,
} from './csv-options.js'
// EW-03I fold: the single-slot preview registry bookkeeping is public so the
// slot's name shapes (`p1` / `assay_preview_p1` / `preview_p1`) are pinable by
// hosts and conformance without re-deriving them (ADR 0049 decision 4).
// D04a: the registry and its name shape moved to their own engine-local module;
// the public export surface (and these specifiers) stay unchanged.
export { PreviewRegistry, viewNameForPreviewId } from './preview-registry.js'
export type { StagedPreview } from './preview-registry.js'
export { MAX_RANGE_ROWS, validateRowWindow } from './range-window.js'
export type { RowWindow, RowWindowValidation } from './range-window.js'
// m2-7 fold (m2-4 carry-over): the engine-generated SQL-facing view name for
// a table id (`assay_tN`) is public so consumers stop re-deriving the
// convention locally.
export { viewNameForTableId } from './table-registry.js'
export { detectFileFormat } from './format-view.js'
export type { EngineFileFormat } from './format-view.js'
// m3-4 fold: the engine's identifier-quoting helper is public so web-side SQL
// composers (m3-4 nested-compose) quote through the same implementation they
// execute against instead of re-deriving quoting locally.
export { quotedIdentifier } from './format-view.js'
// p-3: the pipeline runner surface — the client method's input/outcome/error
// types and the pure generation guard, public so hosts (and the conformance
// harness) can drive and pin the runner without re-deriving its contract.
export {
  CANDIDATE_SCHEMA_FINGERPRINT_ALGORITHM,
  PipelineRunError,
  PipelineRunGuard,
  PipelineRunRefusalError,
  candidateVersionRefFromRun,
  executePipeline,
} from './pipeline-runner/index.js'
export type {
  CandidateVersionRefInput,
  PipelineRunCanceled,
  PipelineRunColumn,
  PipelineRunCompilers,
  PipelineRunCompleted,
  PipelineRunContractBinding,
  PipelineRunDiffCompilerInput,
  PipelineRunDiffKeysBinding,
  PipelineRunEngineOps,
  PipelineRunExport,
  PipelineRunGated,
  PipelineRunGateResult,
  PipelineRunInput,
  PipelineRunNodeResult,
  PipelineRunOptions,
  PipelineRunPartialNode,
  PipelineRunRefusalReason,
  PipelineRunResult,
  PipelineRunSource,
  PipelineRunSourceFile,
  PipelineRunValidationCompilerInput,
} from './pipeline-runner/index.js'
export { classifyProfileColumnType } from './profile-classify.js'
export {
  composeProfileBaseSql,
  composeProfileTopKSql,
  PROFILE_BASE_SLOT,
  PROFILE_QUANTILE_POSITIONS,
  PROFILE_TOP_K,
} from './profile-query.js'
export type { ProfileBaseQueryPlan, ProfileColumnSpec } from './profile-query.js'
export {
  composeRowCountSql,
  composeWindowSql,
  orderByClauseSql,
  whereClauseSql,
} from './window-query.js'
export type { EngineWindowQuery } from './window-query.js'
// m4-2 fold: overlay composition (stateless SQL over base view + ops), the
// CSV formula-injection guard, and the boundary-validated overlay payload —
// public so the conformance suite, harness, and m4-3's grid all consume the
// same composed semantics instead of re-deriving them.
export {
  cellLiteralRawSql,
  cellLiteralSql,
  composeOverlayCastCheckSql,
  composeOverlayCountSql,
  composeOverlaySchemaSql,
  composeOverlayWindowSql,
  composeSourceSql,
  formulaInjectionGuardSql,
  insertSortKeys,
  MAX_OVERLAY_LIVE_INSERT_BRANCHES,
  MAX_REPAIR_EXCEPTION_ARMS,
  MAX_REPAIR_EXPORT_CELL_WORK,
  OVERLAY_ROW_ID_COLUMN,
  OVERLAY_SORT_KEY_COLUMN,
  OverlayLiveInsertLimitError,
  OverlayRepairExceptionLimitError,
  OverlayRepairExportBudgetError,
  OverlayRepairInsertValueError,
  RESERVED_OVERLAY_COLUMN_NAMES,
} from './overlay-query.js'
export type { OverlayComposition, OverlayWindowQuery } from './overlay-query.js'
// D04b: the COPY/export emission group moved to its own engine-local module
// (`export-query.ts`); these specifiers are unchanged, only the module they
// are re-exported from moved.
export {
  composeOverlayExportSelectSql,
  composeOverlayExportSql,
  exportFileExtension,
  PARQUET_COPY_OPTIONS,
} from './export-query.js'
export { parseOverlayPayload, assertValidOverlayTypes } from './overlay-wire.js'
export type { EngineOverlayPayload } from './overlay-wire.js'
// m5-2 fold: validation execution — the strict plan wire validator, the
// result contract, and the composed-view/row-key helpers, public so hosts
// (m5-3 web, m5-4 CLI agreement work) and the conformance suite consume the
// same executed semantics instead of re-deriving them.
export {
  parseValidationPlan,
  assertValidationPlanRelationBinding,
  quotedRelationToken,
} from './validate-plan-wire.js'
export type {
  EngineValidationPlan,
  EngineValidationResult,
  EngineValidationRule,
  EngineValidationRuleResult,
  EngineValidationSample,
} from './validate-plan-wire.js'
export {
  composeValidationCountSql,
  composeValidationRowKeySql,
  composeValidationRuleQuery,
  composeValidationViewDropSql,
  composeValidationViewSql,
  validationEffectiveSampleLimit,
  validationFailCountExcess,
  failPercentFromCounts,
  normalizeSampleValue,
  readValidationRowCount,
  readValidationRuleRows,
  readValidationRowKeys,
  readValidationSummaryRows,
  VALIDATION_SAMPLE_HARD_MAX,
} from './validate-query.js'
// m6-2 fold: row-diff execution — the strict plan wire gate, the two-binding
// composition helpers, the result readers, the result-sanity bounds, and the
// side-qualified sample builder, public so hosts (m6-4 web, m6-3/m6-5 CLI
// agreement work) and the conformance suite consume the same executed
// semantics instead of re-deriving them.
export {
  assertRowDiffPlanBinding,
  parseRowDiffPlan,
  quotedRelationToken as quotedRowDiffRelationToken,
  ROW_DIFF_SAMPLE_HARD_MAX,
} from './diff-plan-wire.js'
export type {
  EngineRowDiffAspect,
  EngineRowDiffAspectResult,
  EngineRowDiffPlan,
  EngineRowDiffResult,
  EngineRowDiffSample,
} from './diff-plan-wire.js'
export {
  buildDiffAspectSamples,
  comparisonRowKey,
  composeDiffARowKeySql,
  composeDiffAspectQuery,
  composeDiffAViewSql,
  composeDiffComparisonViewSql,
  composeDiffCountSql,
  composeDiffViewDropSql,
  diffEffectiveSampleLimit,
  readDiffARowKeys,
  readDiffAspectRows,
  readDiffRowCount,
  readDiffTotalsRows,
  ROW_DIFF_BEGIN_SQL,
  ROW_DIFF_ROLLBACK_SQL,
  rowDiffCountExcess,
} from './diff-query.js'
export type { RowDiffAspectRows, RowDiffCountExcess, RowDiffSampleRow } from './diff-query.js'
// B1/ENG-2: the repair preview's affected-set predicate and count composition
// are public so the host's `overlay-range` examples filter and the typed count
// op consume ONE definition of "affected" (the example set and the count can
// never diverge), and so the wire parser/envelope can be pinned by hosts.
export {
  assertEngineRepairPlanWithinEnvelope,
  composeRepairPreviewCountSql,
  parseEngineRepairPlan,
  repairAffectedFilter,
  repairAffectedPredicate,
} from './repair-preview-query.js'
export type { EngineRepairPlan as EngineRepairPreviewPlan } from './repair-preview-query.js'
// m4-2 fix-round fold: the strict engine type-expression validator and the
// canonical string/BLOB family classifiers the CSV formula-injection guard
// keys off. Public so hosts can validate declared cast types before
// submitting an overlay and so the guard's classification is inspectable.
export {
  EngineTypeError,
  isBlobLikeEngineType,
  isStringLikeEngineType,
  parseEngineTypeExpression,
  validateEngineTypeExpression,
} from './type-expr.js'
export type { EngineTypeFamily, EngineTypeInfo } from './type-expr.js'

// The worker entry (`./worker.ts`) is intentionally not part of the
// main-thread surface: the client loads it via
// `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`.
