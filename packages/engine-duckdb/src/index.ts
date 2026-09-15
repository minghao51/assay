/**
 * @assay/engine-duckdb — DuckDB-WASM implementation of the DataEngine interface.
 *
 * M1-2: `query()` transports the first Apache Arrow record batch to the main
 * thread (ADR 0020) over the typed postMessage protocol owned by this package
 * (ADR 0002/0021; no RPC library — the protocol stays swappable). The full
 * DataEngine surface and result-set streaming arrive with later M1 tasks.
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
  EngineQueryResult,
  EngineStatus,
  EngineWorkerFactory,
  EngineWorkerLike,
} from './client'
export { parseEngineRequest, parseEngineResponse } from './protocol'
export type {
  EngineErrorResponse,
  EngineInitRequest,
  EngineQueryRequest,
  EngineQueryResultResponse,
  EngineReadyInfo,
  EngineReadyResponse,
  EngineRequest,
  EngineResponse,
  EngineSuccessResponse,
} from './protocol'

// The worker entry (`./worker.ts`) is intentionally not part of the
// main-thread surface: the client loads it via
// `new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })`.
