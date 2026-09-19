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
 * Ownership and dependency rules: docs/engineering/05-repository-structure.md.
 * Delivery sequencing: docs/product/10-execution-roadmap.md.
 */
export {
  DuckDbEngineClient,
  EngineDisposedError,
  EngineOperationError,
  EngineProtocolError,
  EngineQueryError,
  EngineWorkerError,
} from './client'
export type {
  DuckDbEngineClientOptions,
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
} from './client'
export { parseEngineRequest, parseEngineResponse } from './protocol'
export type {
  EngineColumnSchema,
  EngineCategoricalColumnStats,
  EngineCategoricalTopKEntry,
  EngineDisposedResponse,
  EngineDisposeRequest,
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
  EngineProfileColumn,
  EngineProfileColumnKind,
  EngineProfileRequest,
  EngineProfileResultResponse,
  EngineQueryRequest,
  EngineQueryResultResponse,
  EngineRangeRequest,
  EngineRangeResultResponse,
  EngineReadyInfo,
  EngineReadyResponse,
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
} from './protocol'
export { MAX_RANGE_ROWS, validateRowWindow } from './range-window'
export type { RowWindow, RowWindowValidation } from './range-window'
// m2-7 fold (m2-4 carry-over): the engine-generated SQL-facing view name for
// a table id (`assay_tN`) is public so consumers stop re-deriving the
// convention locally.
export { viewNameForTableId } from './table-registry'
export { detectFileFormat } from './format-view'
export type { EngineFileFormat } from './format-view'
// m3-4 fold: the engine's identifier-quoting helper is public so web-side SQL
// composers (m3-4 nested-compose) quote through the same implementation they
// execute against instead of re-deriving quoting locally.
export { quotedIdentifier } from './format-view'
export { classifyProfileColumnType } from './profile-classify'
export {
  composeProfileBaseSql,
  composeProfileTopKSql,
  PROFILE_BASE_SLOT,
  PROFILE_QUANTILE_POSITIONS,
  PROFILE_TOP_K,
} from './profile-query'
export type { ProfileBaseQueryPlan, ProfileColumnSpec } from './profile-query'
export {
  composeRowCountSql,
  composeWindowSql,
  orderByClauseSql,
  whereClauseSql,
} from './window-query'
export type { EngineWindowQuery } from './window-query'
// m4-2 fold: overlay composition (stateless SQL over base view + ops), the
// CSV formula-injection guard, and the boundary-validated overlay payload —
// public so the conformance suite, harness, and m4-3's grid all consume the
// same composed semantics instead of re-deriving them.
export {
  cellLiteralRawSql,
  cellLiteralSql,
  composeOverlayCastCheckSql,
  composeOverlayCountSql,
  composeOverlayExportSelectSql,
  composeOverlayExportSql,
  composeOverlaySchemaSql,
  composeOverlayWindowSql,
  composeSourceSql,
  exportFileExtension,
  formulaInjectionGuardSql,
  insertSortKeys,
  OVERLAY_ROW_ID_COLUMN,
  OVERLAY_SORT_KEY_COLUMN,
  RESERVED_OVERLAY_COLUMN_NAMES,
} from './overlay-query'
export type { OverlayComposition, OverlayWindowQuery } from './overlay-query'
export { parseOverlayPayload, assertValidOverlayTypes } from './overlay-wire'
export type { EngineOverlayPayload } from './overlay-wire'
// m5-2 fold: validation execution — the strict plan wire validator, the
// result contract, and the composed-view/row-key helpers, public so hosts
// (m5-3 web, m5-4 CLI agreement work) and the conformance suite consume the
// same executed semantics instead of re-deriving them.
export {
  parseValidationPlan,
  assertValidationPlanRelationBinding,
  quotedRelationToken,
} from './validate-plan-wire'
export type {
  EngineValidationPlan,
  EngineValidationResult,
  EngineValidationRule,
  EngineValidationRuleResult,
  EngineValidationSample,
} from './validate-plan-wire'
export {
  composeValidationCountSql,
  composeValidationRowKeySql,
  composeValidationRuleQuery,
  composeValidationViewDropSql,
  composeValidationViewSql,
  validationEffectiveSampleLimit,
  failPercentFromCounts,
  normalizeSampleValue,
  readValidationRowCount,
  readValidationRuleRows,
  readValidationRowKeys,
  readValidationSummaryRows,
  VALIDATION_SAMPLE_HARD_MAX,
} from './validate-query'
// m4-2 fix-round fold: the strict engine type-expression validator and the
// canonical string-family classifier the CSV formula-injection guard keys
// off. Public so hosts can validate declared cast types before submitting an
// overlay and so the guard's classification is inspectable.
export {
  EngineTypeError,
  isStringLikeEngineType,
  parseEngineTypeExpression,
  validateEngineTypeExpression,
} from './type-expr'
export type { EngineTypeFamily, EngineTypeInfo } from './type-expr'

// The worker entry (`./worker.ts`) is intentionally not part of the
// main-thread surface: the client loads it via
// `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`.
