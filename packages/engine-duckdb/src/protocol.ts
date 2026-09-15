/**
 * Message protocol between the main thread and the engine Web Worker.
 *
 * The protocol is owned by this package (ADR 0021): plain structured-clone
 * postMessage with the types defined here — deliberately no RPC library.
 * Comlink was evaluated and rejected for this surface: returning the first
 * Arrow batch needs direct control over the postMessage transfer list
 * (zero-copy ArrayBuffer transfer), which Comlink's proxy indirection does
 * not expose. Every request carries a `requestId` that its response echoes,
 * so the client can correlate concurrent calls.
 *
 * Tabular results travel as Apache Arrow (ADR 0020): the worker serializes
 * the first record batch to an Arrow IPC stream (`schema` + `record batch` +
 * end-of-stream, exactly what `tableToIPC(batch, 'stream')` produces) and the
 * client reconstitutes it with `tableFromIPC` on the main thread. Only the
 * first batch is transported for M1 (see `EngineQueryResultResponse`).
 */

/** Engine facts reported by the worker once it is ready. */
export interface EngineReadyInfo {
  duckdbVersion: string
}

// ---- Requests (main thread → worker) ----

export interface EngineInitRequest {
  type: 'engine/init'
  requestId: number
}

export interface EngineQueryRequest {
  type: 'engine/query'
  requestId: number
  sql: string
}

export type EngineRequest = EngineInitRequest | EngineQueryRequest

// ---- Responses (worker → main thread) ----

export interface EngineReadyResponse extends EngineReadyInfo {
  type: 'engine/ready'
  requestId: number
}

/**
 * First-batch result transport. `batchIpc` is an Arrow IPC *stream*
 * (`Uint8Array`) holding the result schema plus exactly the first record
 * batch; the client reconstitutes it via the Arrow API (ADR 0020). The
 * worker lists the underlying `ArrayBuffer` in its postMessage transfer
 * list, so the bytes move to the main thread without a copy.
 *
 * `hasMore` is true when DuckDB produced further record batches after this
 * one. Those batches are deliberately **not** transported: full result-set
 * streaming is out of scope for M1-2 — the worker cancels the pending query
 * and reports the truncation honestly through this flag.
 */
export interface EngineQueryResultResponse {
  type: 'engine/query-result'
  requestId: number
  batchIpc: Uint8Array
  hasMore: boolean
}

export interface EngineErrorResponse {
  type: 'engine/error'
  requestId: number
  message: string
}

export type EngineResponse = EngineReadyResponse | EngineQueryResultResponse | EngineErrorResponse

/** Responses that resolve (rather than reject) a pending request. */
export type EngineSuccessResponse = EngineReadyResponse | EngineQueryResultResponse

// ---- Runtime guards ----
//
// The worker sits behind a postMessage boundary, so both sides validate what
// they receive instead of trusting the shape.

/**
 * Parse a main-thread request. Returns `null` for anything that is not a
 * well-formed `EngineRequest` (the worker then ignores the message).
 */
export function parseEngineRequest(data: unknown): EngineRequest | null {
  if (!isRecord(data)) return null
  const { type, requestId } = data
  if (typeof requestId !== 'number') return null
  if (type === 'engine/init') return { type, requestId }
  if (type === 'engine/query' && typeof data.sql === 'string') {
    return { type, requestId, sql: data.sql }
  }
  return null
}

/**
 * Parse a worker response. Returns `null` for anything that is not a
 * well-formed `EngineResponse` (the client then ignores the message).
 */
export function parseEngineResponse(data: unknown): EngineResponse | null {
  if (!isRecord(data)) return null
  const { type, requestId } = data
  if (typeof requestId !== 'number') return null
  if (type === 'engine/ready' && typeof data.duckdbVersion === 'string') {
    return { type, requestId, duckdbVersion: data.duckdbVersion }
  }
  if (
    type === 'engine/query-result' &&
    isUint8Array(data.batchIpc) &&
    typeof data.hasMore === 'boolean'
  ) {
    return { type, requestId, batchIpc: data.batchIpc, hasMore: data.hasMore }
  }
  if (type === 'engine/error' && typeof data.message === 'string') {
    return { type, requestId, message: data.message }
  }
  return null
}

/** Structured clone delivers Arrow IPC bytes as a plain `Uint8Array`. */
function isUint8Array(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
