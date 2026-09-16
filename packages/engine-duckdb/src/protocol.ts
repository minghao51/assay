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
 *
 * m2-2 adds filtered/sorted windows: `engine/range` accepts optional
 * `filters`/`sort` and `engine/row-count` optional `filters` — structural
 * mirrors of the grid contract's v1 `FilterSpec`/`SortSpec` shapes (declared
 * here, not imported, to keep the dependency direction intact). Predicates
 * are engine-SQL text (grid contracts v1, ADR 0029); absent/empty fields
 * mean "no filters"/"natural order", so legacy requests compose
 * byte-identical SQL.
 *
 * m2-5 adds `engine/profile`: a plain-JSON dataset profile (no Arrow needed —
 * the result is one row count plus a handful of bounded stats per column),
 * addressed by table id like the other registry ops. The response mirrors
 * `@assay/engine`'s `DatasetProfile`/`ColumnProfile` structurally
 * (protocol-local types, same convention as m2-2): every number is a finite
 * JSON number or `null`, so the response survives structured clone and a
 * future non-postMessage transport unchanged.
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
 * optionally projected onto `columns`, narrowed by `filters`, and ordered by
 * `sort` (m2-2). The worker re-validates and clamps the window
 * (`range-window.ts`) — the main thread is untrusted. Absent (or empty)
 * `filters`/`sort` mean "no WHERE clause"/"natural order" — byte-identical
 * SQL to the pre-m2-2 behavior.
 */
export interface EngineRangeRequest {
  type: 'engine/range'
  requestId: number
  tableId: string
  startRow: number
  endRow: number
  columns?: string[]
  filters?: EngineFilterSpec[]
  sort?: EngineSortSpec[]
}

// ---- Filter/sort specs (m2-2) ----
//
// Structural mirrors of the grid contract's v1 shapes (`FilterSpec` /
// `SortSpec` in `@assay/grid` contracts): deliberately re-declared here
// instead of imported, so the engine protocol stays dependency-free of the
// grid package (apps → ui/core → domain; the web adapter maps between them —
// m2-3). The shapes must not drift: the grid's null-clear protocol (`sort(null)`
// = natural order, `filter(null)` = empty predicate list, AND composition,
// duplicate columns allowed) is exactly what "absent/empty `filters`/`sort`
// fields" express on this protocol.

/**
 * One filter predicate: `column` is quoted as an identifier and `predicate`
 * is engine-SQL text composed as WHERE content (`"column" <predicate>`,
 * AND-composed across the list — grid contracts v1, ADR 0029). The predicate
 * is user-authored SQL: it runs only against the registered view, locally,
 * on the user's own data, and is never executed as anything but SQL by the
 * engine or rendered as anything but text by the UI (ADR 0007 spirit).
 */
export interface EngineFilterSpec {
  column: string
  predicate: string
}

/** One sort key: `column` is quoted as an identifier; direction is explicit. */
export interface EngineSortSpec {
  column: string
  direction: 'asc' | 'desc'
}

/**
 * Total row count of a registered table (M1-5): metadata-only (`count(*)`),
 * never a data read. Virtualized grids need a total to size the scroll area.
 * m2-2: an optional `filters` list narrows the count to the matching rows.
 */
export interface EngineRowCountRequest {
  type: 'engine/row-count'
  requestId: number
  tableId: string
  filters?: EngineFilterSpec[]
}

/**
 * Full statistics profile of a registered table (m2-5): per-column
 * nullCount/distinctCount always, numeric min/max/mean/stddev/quantiles for
 * numeric columns, categorical top-k for scalar non-numeric columns. The
 * worker composes the aggregate SQL itself (see `profile-query.ts`) — the
 * request carries only the table id.
 */
export interface EngineProfileRequest {
  type: 'engine/profile'
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
  | EngineProfileRequest
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

// ---- Profile payload types (m2-5) ----
//
// Structural mirrors of `@assay/engine`'s `ProfileColumnKind` /
// `NumericColumnStats` / `CategoricalColumnStats` / `ColumnProfile` (declared
// here, not imported — same dependency-direction convention as the m2-2
// filter/sort specs; the web adapter maps between them). Invariants the
// worker guarantees and the parser enforces: every number is a finite JSON
// number or `null`; counts are safe non-negative integers; a present payload
// must be well-formed (which kind carries which payload is the executor's
// invariant, asserted by the conformance suite).

/** How the engine classified a column for profiling. */
export type EngineProfileColumnKind = 'numeric' | 'categorical' | 'other'

/** Exact quantiles (p50/p90/p95/p99) of a numeric column's non-null values. */
export interface EngineNumericQuantiles {
  p50: number | null
  p90: number | null
  p95: number | null
  p99: number | null
}

/** Numeric column statistics, each finite-or-null (see the block comment). */
export interface EngineNumericColumnStats {
  min: number | null
  max: number | null
  mean: number | null
  stddev: number | null
  quantiles: EngineNumericQuantiles
}

/** One categorical top-k entry: rendered text value + exact frequency. */
export interface EngineCategoricalTopKEntry {
  value: string
  count: number
}

/** Categorical column statistics: the at-most-k most frequent values. */
export interface EngineCategoricalColumnStats {
  topK: EngineCategoricalTopKEntry[]
}

/** Per-column profile payload (mirrors `@assay/engine`'s `ColumnProfile`). */
export interface EngineProfileColumn {
  name: string
  type: string
  kind: EngineProfileColumnKind
  nullCount: number
  distinctCount: number
  numeric?: EngineNumericColumnStats
  categorical?: EngineCategoricalColumnStats
}

/** Full profile result: total rows plus one payload per column. */
export interface EngineProfileResultResponse {
  type: 'engine/profile-result'
  requestId: number
  rowCount: number
  columns: EngineProfileColumn[]
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
  | EngineProfileResultResponse
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
  | EngineProfileResultResponse
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
    const filters = parseOptionalFilters(data.filters)
    if (filters === null) return null
    const sort = parseOptionalSorts(data.sort)
    if (sort === null) return null
    // Well-formedness only: the bounds must be numbers. Semantic validation
    // (integer, non-negative, ordered, capped) happens in `runRange` via
    // `validateRowWindow` so bad windows get an error *reply*, not silence.
    if (typeof data.startRow === 'number' && typeof data.endRow === 'number') {
      return {
        type,
        requestId,
        tableId: data.tableId,
        startRow: data.startRow,
        endRow: data.endRow,
        ...(columns === undefined ? {} : { columns }),
        ...(filters === undefined ? {} : { filters }),
        ...(sort === undefined ? {} : { sort }),
      }
    }
    return null
  }
  if (type === 'engine/row-count' && typeof data.tableId === 'string') {
    const filters = parseOptionalFilters(data.filters)
    if (filters === null) return null
    return filters === undefined
      ? { type, requestId, tableId: data.tableId }
      : { type, requestId, tableId: data.tableId, filters }
  }
  if (type === 'engine/profile' && typeof data.tableId === 'string') {
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

/** A structurally valid `{column, predicate}` filter (both plain strings). */
function isFilterSpec(value: unknown): value is EngineFilterSpec {
  return (
    isRecord(value) && typeof value['column'] === 'string' && typeof value['predicate'] === 'string'
  )
}

/** A structurally valid `{column, direction}` sort key. */
function isSortSpec(value: unknown): value is EngineSortSpec {
  return (
    isRecord(value) &&
    typeof value['column'] === 'string' &&
    (value['direction'] === 'asc' || value['direction'] === 'desc')
  )
}

/**
 * Optional `filters` list (m2-2): absent, or an array (possibly empty — empty
 * means the same as absent, the grid's `filter(null)` clear) of well-formed
 * filter specs. The list is copied: the boundary is untrusted, so a request
 * can never keep a reference into worker state. Returns `null` for malformed
 * input (the request is then rejected).
 */
function parseOptionalFilters(value: unknown): EngineFilterSpec[] | undefined | null {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every(isFilterSpec)) return null
  return value.map((filter) => ({ column: filter.column, predicate: filter.predicate }))
}

/**
 * Optional `sort` list (m2-2): absent, or an array (possibly empty — empty
 * means the same as absent, the grid's `sort(null)` natural order) of
 * well-formed sort keys with an explicit `asc`/`desc` direction. Copied like
 * `filters`. Returns `null` for malformed input.
 */
function parseOptionalSorts(value: unknown): EngineSortSpec[] | undefined | null {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every(isSortSpec)) return null
  return value.map((key) => ({
    column: key.column,
    direction: key.direction,
  }))
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
  if (
    type === 'engine/profile-result' &&
    isRowCount(data.rowCount) &&
    isProfileColumnList(data.columns)
  ) {
    return { type, requestId, rowCount: data.rowCount, columns: data.columns }
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

/** A statistic: a finite number (JSON-able; never NaN/±Infinity) or null. */
function isFiniteNumberOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

function isProfileColumnKind(value: unknown): value is EngineProfileColumnKind {
  return value === 'numeric' || value === 'categorical' || value === 'other'
}

function isNumericQuantiles(value: unknown): value is EngineNumericQuantiles {
  return (
    isRecord(value) &&
    isFiniteNumberOrNull(value['p50']) &&
    isFiniteNumberOrNull(value['p90']) &&
    isFiniteNumberOrNull(value['p95']) &&
    isFiniteNumberOrNull(value['p99'])
  )
}

function isNumericStats(value: unknown): value is EngineNumericColumnStats {
  return (
    isRecord(value) &&
    isFiniteNumberOrNull(value['min']) &&
    isFiniteNumberOrNull(value['max']) &&
    isFiniteNumberOrNull(value['mean']) &&
    isFiniteNumberOrNull(value['stddev']) &&
    isNumericQuantiles(value['quantiles'])
  )
}

function isCategoricalStats(value: unknown): value is EngineCategoricalColumnStats {
  return (
    isRecord(value) &&
    Array.isArray(value['topK']) &&
    value['topK'].every(
      (entry) =>
        isRecord(entry) && typeof entry['value'] === 'string' && isRowCount(entry['count']),
    )
  )
}

/** A well-formed per-column profile list (payload *shape* only — see above). */
function isProfileColumnList(value: unknown): value is EngineProfileColumn[] {
  return (
    Array.isArray(value) &&
    value.every((column) => {
      if (!isRecord(column)) return false
      if (
        typeof column['name'] !== 'string' ||
        typeof column['type'] !== 'string' ||
        !isProfileColumnKind(column['kind']) ||
        !isRowCount(column['nullCount']) ||
        !isRowCount(column['distinctCount'])
      ) {
        return false
      }
      if (column['numeric'] !== undefined && !isNumericStats(column['numeric'])) return false
      if (column['categorical'] !== undefined && !isCategoricalStats(column['categorical'])) {
        return false
      }
      return true
    })
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
