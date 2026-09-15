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
 *
 * M1-4 adds the file lifecycle: `engine/open` transports the picked `File`
 * (structured-cloneable, a cheap reference — no dataset bytes move until
 * DuckDB reads slices) and the worker registers it plus a per-format view;
 * `engine/schema` and `engine/range` address it by the returned table id;
 * `engine/dispose` drops the registrations. Range results reuse the Arrow IPC
 * transport, capped to a visible-window sized row count (`range-window.ts`).
 *
 * M1-5 adds `engine/row-count`: a metadata-only `count(*)` per table id, so a
 * virtualized grid can size its scroll area from a total without reading the
 * dataset.
 */

/** A column as reported by DuckDB, with its type string passed through as-is. */
export interface EngineColumnSchema {
  name: string
  type: string
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

/**
 * Open a picked local file inside the worker. `name` is the file's name (only
 * its extension is interpreted — never logged, ADR 0025); `file` is the
 * structured-cloneable `File` reference the client resolved from its file
 * source (`FileSystemFileHandle` or the input fallback — the client-side seam
 * is `EngineFileSource` in `client.ts`).
 */
export interface EngineOpenRequest {
  type: 'engine/open'
  requestId: number
  name: string
  file: File
}

export interface EngineSchemaRequest {
  type: 'engine/schema'
  requestId: number
  tableId: string
}

/**
 * Fetch the half-open row window `[startRow, endRow)` of a registered table,
 * optionally projected onto `columns`. The worker re-validates and clamps the
 * window (`range-window.ts`) — the main thread is untrusted.
 */
export interface EngineRangeRequest {
  type: 'engine/range'
  requestId: number
  tableId: string
  startRow: number
  endRow: number
  columns?: string[]
}

/**
 * Total row count of a registered table (M1-5): metadata-only (`count(*)`),
 * never a data read. Virtualized grids need a total to size the scroll area.
 */
export interface EngineRowCountRequest {
  type: 'engine/row-count'
  requestId: number
  tableId: string
}

/** Drop every view/file registered by this session (see `TableRegistry`). */
export interface EngineDisposeRequest {
  type: 'engine/dispose'
  requestId: number
}

export type EngineRequest =
  | EngineInitRequest
  | EngineQueryRequest
  | EngineOpenRequest
  | EngineSchemaRequest
  | EngineRangeRequest
  | EngineRowCountRequest
  | EngineDisposeRequest

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

/** The file was registered and its view created; `tableId` addresses it. */
export interface EngineOpenResultResponse {
  type: 'engine/open-result'
  requestId: number
  tableId: string
  /** The reader format chosen from the file-name extension. */
  format: 'parquet' | 'csv' | 'jsonl' | 'json'
}

/**
 * Column name/type pairs exactly as DuckDB reports them (DESCRIBE): nested
 * types arrive as their full SQL strings (e.g. `STRUCT(...)`), which feeds
 * m1-6's schema tree. No mapping layer yet — a documented M1-4 choice.
 */
export interface EngineSchemaResultResponse {
  type: 'engine/schema-result'
  requestId: number
  columns: EngineColumnSchema[]
}

/** Arrow IPC stream (schema + first batch) holding the requested window. */
export interface EngineRangeResultResponse {
  type: 'engine/range-result'
  requestId: number
  batchIpc: Uint8Array
  /** Honest truncation flag: true if DuckDB split the (capped) window. */
  hasMore: boolean
}

/** Total rows of the registered table, as a safe non-negative integer. */
export interface EngineRowCountResultResponse {
  type: 'engine/row-count-result'
  requestId: number
  rowCount: number
}

export interface EngineDisposedResponse {
  type: 'engine/disposed'
  requestId: number
}

export interface EngineErrorResponse {
  type: 'engine/error'
  requestId: number
  message: string
}

export type EngineResponse =
  | EngineReadyResponse
  | EngineQueryResultResponse
  | EngineOpenResultResponse
  | EngineSchemaResultResponse
  | EngineRangeResultResponse
  | EngineRowCountResultResponse
  | EngineDisposedResponse
  | EngineErrorResponse

/** Responses that resolve (rather than reject) a pending request. */
export type EngineSuccessResponse =
  | EngineReadyResponse
  | EngineQueryResultResponse
  | EngineOpenResultResponse
  | EngineSchemaResultResponse
  | EngineRangeResultResponse
  | EngineRowCountResultResponse
  | EngineDisposedResponse

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
  if (type === 'engine/open' && typeof data.name === 'string' && isFile(data.file)) {
    return { type, requestId, name: data.name, file: data.file }
  }
  if (type === 'engine/schema' && typeof data.tableId === 'string') {
    return { type, requestId, tableId: data.tableId }
  }
  if (type === 'engine/range' && typeof data.tableId === 'string') {
    const columns = parseOptionalColumns(data.columns)
    if (columns === null) return null
    // Well-formedness only: the bounds must be numbers. Semantic validation
    // (integer, non-negative, ordered, capped) happens in `runRange` via
    // `validateRowWindow` so bad windows get an error *reply*, not silence.
    if (typeof data.startRow === 'number' && typeof data.endRow === 'number') {
      return columns === undefined
        ? {
            type,
            requestId,
            tableId: data.tableId,
            startRow: data.startRow,
            endRow: data.endRow,
          }
        : {
            type,
            requestId,
            tableId: data.tableId,
            startRow: data.startRow,
            endRow: data.endRow,
            columns,
          }
    }
    return null
  }
  if (type === 'engine/row-count' && typeof data.tableId === 'string') {
    return { type, requestId, tableId: data.tableId }
  }
  if (type === 'engine/dispose') return { type, requestId }
  return null
}

/**
 * Optional `columns` projection: either absent or a non-empty array of
 * strings. Returns `null` for malformed input (the request is then rejected).
 */
function parseOptionalColumns(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0) return null
  if (!value.every((column) => typeof column === 'string')) return null
  return [...(value as string[])]
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
  if (
    type === 'engine/open-result' &&
    typeof data.tableId === 'string' &&
    isFileFormat(data.format)
  ) {
    return { type, requestId, tableId: data.tableId, format: data.format }
  }
  if (type === 'engine/schema-result' && isColumnSchemaList(data.columns)) {
    return { type, requestId, columns: data.columns }
  }
  if (type === 'engine/range-result' && isUint8Array(data.batchIpc)) {
    return typeof data.hasMore === 'boolean'
      ? { type, requestId, batchIpc: data.batchIpc, hasMore: data.hasMore }
      : null
  }
  if (type === 'engine/row-count-result' && isRowCount(data.rowCount)) {
    return { type, requestId, rowCount: data.rowCount }
  }
  if (type === 'engine/disposed') return { type, requestId }
  if (type === 'engine/error' && typeof data.message === 'string') {
    return { type, requestId, message: data.message }
  }
  return null
}

/**
 * Structured clone delivers a same-realm `File` instance. Node ≥ 20 (unit
 * tests) and worker realms alike provide the global, so the guard is an
 * honest `instanceof` rather than duck typing.
 */
function isFile(value: unknown): value is File {
  return typeof File === 'function' && value instanceof File
}

function isFileFormat(value: unknown): value is 'parquet' | 'csv' | 'jsonl' | 'json' {
  return value === 'parquet' || value === 'csv' || value === 'jsonl' || value === 'json'
}

function isColumnSchemaList(value: unknown): value is EngineColumnSchema[] {
  return (
    Array.isArray(value) &&
    value.every(
      (column) =>
        isRecord(column) &&
        typeof column['name'] === 'string' &&
        typeof column['type'] === 'string',
    )
  )
}

/** Structured clone delivers Arrow IPC bytes as a plain `Uint8Array`. */
function isUint8Array(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array
}

/** A row count must be a safe non-negative integer (never a float/string). */
function isRowCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
