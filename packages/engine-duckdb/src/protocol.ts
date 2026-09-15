/**
 * Message protocol between the main thread and the engine Web Worker.
 *
 * The protocol is owned by this package (ADR 0021): plain structured-clone
 * postMessage with the types defined here — deliberately no RPC library.
 * Every request carries a `requestId` that its response echoes, so the client
 * can correlate concurrent calls. Arrow record-batch transport is out of
 * scope for M1-1 and lands with task M1-2 (ADR 0020).
 */

/** Scalar cell values that survive structured clone unchanged. */
export type QueryCell = null | boolean | number | bigint | string

/**
 * Cap for the temporary scalar result transport. Keeps a runaway smoke query
 * from cloning an unbounded payload onto the main thread (ADR 0021); real
 * result streaming is Arrow batches in M1-2 (ADR 0020).
 */
export const MAX_RESULT_ROWS = 1000

/**
 * Result of a smoke-level query: deliberately small and JSON-safe for M1-1.
 * The scalar `rows` are replaced by an Arrow record-batch transport in M1-2
 * (ADR 0020).
 */
export interface EngineQueryResult {
  /** Output column names, in order. */
  columns: string[]
  /** Total rows the query produced (before any truncation). */
  rowCount: number
  /** At most `MAX_RESULT_ROWS` rows of scalar cells, ordered as `columns`. */
  rows: QueryCell[][]
  /** True when `rows` was truncated to `MAX_RESULT_ROWS`. */
  truncated: boolean
}

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

export interface EngineQueryResultResponse {
  type: 'engine/query-result'
  requestId: number
  result: EngineQueryResult
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
  if (type === 'engine/query-result') {
    const result = parseEngineQueryResult(data.result)
    if (result === null) return null
    return { type, requestId, result }
  }
  if (type === 'engine/error' && typeof data.message === 'string') {
    return { type, requestId, message: data.message }
  }
  return null
}

function parseEngineQueryResult(data: unknown): EngineQueryResult | null {
  if (!isRecord(data)) return null
  const { columns, rowCount, rows, truncated } = data
  if (!Array.isArray(columns) || columns.some((name) => typeof name !== 'string')) return null
  if (typeof rowCount !== 'number' || typeof truncated !== 'boolean') return null
  if (!Array.isArray(rows)) return null
  for (const row of rows) {
    if (!Array.isArray(row) || row.some((cell) => !isQueryCell(cell))) return null
  }
  return { columns, rowCount, rows, truncated }
}

function isQueryCell(value: unknown): value is QueryCell {
  return (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'string'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
