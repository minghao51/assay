/**
 * @assay/engine-duckdb — DuckDB-WASM implementation of the DataEngine interface.
 *
 * M1-1: lazy engine bootstrap inside a dedicated Web Worker behind a typed
 * postMessage protocol owned by this package (ADR 0002/0021). The full
 * DataEngine surface and Arrow record-batch transport arrive with M1-2+
 * (ADR 0020); until then `query()` returns bounded scalar results.
 *
 * Ownership and dependency rules: docs/engineering/05-repository-structure.md.
 * Delivery sequencing: docs/product/10-execution-roadmap.md.
 */
export {
  DuckDbEngineClient,
  EngineDisposedError,
  EngineProtocolError,
  EngineQueryError,
  EngineWorkerError,
} from './client'
export type {
  DuckDbEngineClientOptions,
  EngineStatus,
  EngineWorkerFactory,
  EngineWorkerLike,
} from './client'
export { MAX_RESULT_ROWS, parseEngineRequest, parseEngineResponse } from './protocol'
export type {
  EngineErrorResponse,
  EngineInitRequest,
  EngineQueryRequest,
  EngineQueryResult,
  EngineQueryResultResponse,
  EngineReadyInfo,
  EngineReadyResponse,
  EngineRequest,
  EngineResponse,
  EngineSuccessResponse,
  QueryCell,
} from './protocol'

// The worker entry (`./worker.ts`) is intentionally not part of the
// main-thread surface: the client loads it via
// `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`.
