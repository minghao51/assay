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
 *
 * m4-2 adds the edit-overlay surface (ADR 0012) and export: requests carry an
 * `overlay` payload (immutable base metadata + the host's op list — see
 * `overlay-wire.ts` for the boundary validation) and the worker composes SQL
 * as a pure function of (base view, ops) — stateless composition, restart-
 * safe by construction. `engine/overlay-range` / `engine/overlay-row-count`
 * / `engine/overlay-schema` are grid-class registry-lane ops over the
 * *effective* view (ADR 0040 lane policy); `engine/export` is a long-running
 * user-initiated materialization and shares the query lane. Export writes a
 * NEW file in OPFS scratch space (ADR 0017 disposable-cache framing) and
 * never touches the source path; the response carries the generated path so
 * the host can re-open/verify the export through the engine (round-trip).
 */

import type { EngineOverlayPayload } from './overlay-wire'
import { isEngineTypeExpression, parseOverlayPayload } from './overlay-wire'
import type { EngineValidationPlan, EngineValidationResult } from './validate-plan-wire'
import { parseValidationPlan } from './validate-plan-wire'
import { validationFailCountExcess } from './validate-query'
export type { EngineOverlayPayload, EngineValidationPlan, EngineValidationResult }

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

// ---- Edit-overlay surface (m4-2) ----
//
// Grid-class ops over the effective view (base view + overlay ops, ADR
// 0012): registry lane per ADR 0040 (short, latency-sensitive window/meta
// traffic — exactly the class the registry lane exists for). Each request
// carries the overlay payload (base metadata + ops) statelessly; the worker
// folds and composes per request (see `overlay-query.ts`).

/** Export formats of the m4-2 export/rewrite op (COPY/IPC materialization). */
export type EngineExportFormat = 'parquet' | 'jsonl' | 'json' | 'csv' | 'arrow'

/** Effective schema of a composed overlay (renames/casts visible). */
export interface EngineOverlaySchemaRequest {
  type: 'engine/overlay-schema'
  requestId: number
  tableId: string
  overlay: EngineOverlayPayload
}

/**
 * Live row count of the composed overlay, optionally filtered (m2-2 grammar
 * over effective columns). Matches the domain's `liveRowCount` when no
 * filters are given.
 */
export interface EngineOverlayRowCountRequest {
  type: 'engine/overlay-row-count'
  requestId: number
  tableId: string
  overlay: EngineOverlayPayload
  filters?: EngineFilterSpec[]
}

/**
 * Window over the composed effective view. `includeRowIds` prepends the
 * logical row-id column (`assay_row_id`) so callers can map rows back to
 * overlay identities (m4-3's editing grid); the emitted order reproduces the
 * domain's `effectiveRowIds` exactly.
 */
export interface EngineOverlayRangeRequest {
  type: 'engine/overlay-range'
  requestId: number
  tableId: string
  overlay: EngineOverlayPayload
  startRow: number
  endRow: number
  columns?: string[]
  filters?: EngineFilterSpec[]
  sort?: EngineSortSpec[]
  includeRowIds?: boolean
}

/**
 * Export/rewrite op (ADR 0012: commit creates a new file — the source is
 * never written in place). Materializes the effective view (base + overlay;
 * absent `overlay` = the plain base view) into OPFS scratch space (ADR 0017)
 * under a generated path. v1 ships fixed deterministic per-format options
 * (documented in `overlay-query.ts`); CSV exports apply the formula-injection
 * guard. The response's `path` lets the host re-open the export through the
 * engine (round-trip) without new browser capabilities.
 */
export interface EngineExportRequest {
  type: 'engine/export'
  requestId: number
  tableId: string
  format: EngineExportFormat
  overlay?: EngineOverlayPayload
}

/**
 * Validate-before-commit cast check (m4-4b, ADR 0012): over the given
 * **pre-cast** overlay state, report whether any non-NULL value of the
 * effective `column` cannot convert to `targetType`. It runs on the query
 * lane (see `engine-executor.ts` for the ADR 0040 lane rationale: a
 * worst-case full-column `TRY_CAST` scan is query-class, like profile).
 * `targetType` is untrusted host input for a SQL type position: the boundary
 * re-validates it as one complete DuckDB type (the client already did) and
 * rejects a malformed instance with exactly one typed `engine/error`.
 */
export interface EngineOverlayCastCheckRequest {
  type: 'engine/overlay-cast-check'
  requestId: number
  tableId: string
  overlay: EngineOverlayPayload
  column: string
  targetType: string
}

/**
 * Validation execution (m5-2, ADR 0040): execute the m5-1 `ValidationPlan`
 * against the **effective view** of the addressed table — base view plus the
 * optional overlay (absent `overlay` = the plain base view, the export
 * convention). The plan is boundary-validated strictly (see
 * `validate-plan-wire.ts`): a structurally malformed plan is answered with
 * exactly one typed `engine/error` before any SQL runs; the executor
 * additionally refuses a binding name that would shadow a registered view
 * or whose SQL does not bind the relation in the compiler's FROM shape.
 * Query lane: validation may scan whole datasets — exactly the heavy class
 * that must never head-of-line block the grid's windows.
 */
export interface EngineValidateRequest {
  type: 'engine/validate'
  requestId: number
  tableId: string
  plan: EngineValidationPlan
  overlay?: EngineOverlayPayload
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
  | EngineOverlaySchemaRequest
  | EngineOverlayRowCountRequest
  | EngineOverlayRangeRequest
  | EngineOverlayCastCheckRequest
  | EngineValidateRequest
  | EngineExportRequest
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

/** Effective columns of the composed overlay (DuckDB types post-cast). */
export interface EngineOverlaySchemaResultResponse {
  type: 'engine/overlay-schema-result'
  requestId: number
  columns: EngineColumnSchema[]
}

/** Live row count of the composed overlay (safe non-negative integer). */
export interface EngineOverlayRowCountResultResponse {
  type: 'engine/overlay-row-count-result'
  requestId: number
  rowCount: number
}

/** Arrow IPC stream (schema + first batch) of the requested overlay window. */
export interface EngineOverlayRangeResultResponse {
  type: 'engine/overlay-range-result'
  requestId: number
  batchIpc: Uint8Array
  hasMore: boolean
}

/**
 * Result of the m4-4b cast check: `true` iff at least one non-NULL effective
 * value of the tested column cannot convert. A boolean only — never dataset
 * values (ADR 0025).
 */
export interface EngineOverlayCastCheckResultResponse {
  type: 'engine/overlay-cast-check-result'
  requestId: number
  hasNonConvertibleValues: boolean
}

/**
 * Result of the export op: the generated OPFS path plus honest counts.
 */
export interface EngineExportResultResponse {
  type: 'engine/export-result'
  requestId: number
  /** OPFS-relative destination path (e.g. `assay-exports/…`); never the source. */
  path: string
  format: EngineExportFormat
  /** Rows materialized (honest feedback for the m4-5 export dialog). */
  rowCount: number
  /** Exported byte size. */
  bytes: number
}

/**
 * Result of the validate op (m5-2): per-rule `{ruleId, failCount,
 * failPercent, sampleFailures}` in plan order, the effective row count, and
 * the total verdict. Sample values are report content (bounded,
 * engine-clamped) — never logged or telemetried (ADR 0025).
 */
export interface EngineValidateResultResponse {
  type: 'engine/validate-result'
  requestId: number
  result: EngineValidationResult
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
  | EngineOverlaySchemaResultResponse
  | EngineOverlayRowCountResultResponse
  | EngineOverlayRangeResultResponse
  | EngineOverlayCastCheckResultResponse
  | EngineValidateResultResponse
  | EngineExportResultResponse
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
  | EngineOverlaySchemaResultResponse
  | EngineOverlayRowCountResultResponse
  | EngineOverlayRangeResultResponse
  | EngineOverlayCastCheckResultResponse
  | EngineValidateResultResponse
  | EngineExportResultResponse
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
  if (
    (type === 'engine/overlay-schema' ||
      type === 'engine/overlay-row-count' ||
      type === 'engine/overlay-range' ||
      type === 'engine/overlay-cast-check' ||
      type === 'engine/export') &&
    typeof data.tableId === 'string'
  ) {
    const overlay = parseOverlayPayload(data.overlay)
    // engine/export allows an absent overlay (plain base-view export);
    // the four overlay query ops require it. A present-but-malformed
    // payload rejects the request in both cases (never silently ignored).
    if (overlay === null && !(type === 'engine/export' && data.overlay === undefined)) {
      return null
    }
    if (type === 'engine/overlay-schema' && overlay !== null) {
      return { type, requestId, tableId: data.tableId, overlay }
    }
    if (type === 'engine/overlay-row-count' && overlay !== null) {
      const filters = parseOptionalFilters(data.filters)
      if (filters === null) return null
      return {
        type,
        requestId,
        tableId: data.tableId,
        overlay,
        ...(filters === undefined ? {} : { filters }),
      }
    }
    if (type === 'engine/overlay-range' && overlay !== null) {
      const columns = parseOptionalColumns(data.columns)
      if (columns === null) return null
      const filters = parseOptionalFilters(data.filters)
      if (filters === null) return null
      const sort = parseOptionalSorts(data.sort)
      if (sort === null) return null
      const includeRowIds = parseOptionalFlag(data.includeRowIds)
      if (includeRowIds === null) return null
      if (typeof data.startRow === 'number' && typeof data.endRow === 'number') {
        return {
          type,
          requestId,
          tableId: data.tableId,
          overlay,
          startRow: data.startRow,
          endRow: data.endRow,
          ...(columns === undefined ? {} : { columns }),
          ...(filters === undefined ? {} : { filters }),
          ...(sort === undefined ? {} : { sort }),
          ...(includeRowIds === undefined ? {} : { includeRowIds }),
        }
      }
      return null
    }
    if (type === 'engine/overlay-cast-check' && overlay !== null) {
      // The standalone target type is untrusted input for a SQL type
      // position: reject a malformed spelling at the boundary (the client
      // already validated it; a hostile sender is answered, never dropped).
      if (typeof data.column !== 'string' || typeof data.targetType !== 'string') return null
      if (!isEngineTypeExpression(data.targetType)) return null
      return {
        type,
        requestId,
        tableId: data.tableId,
        overlay,
        column: data.column,
        targetType: data.targetType,
      }
    }
    if (type === 'engine/export' && isExportFormat(data.format)) {
      const overlayPayload = overlay ?? undefined
      return {
        type,
        requestId,
        tableId: data.tableId,
        format: data.format,
        ...(overlayPayload === undefined ? {} : { overlay: overlayPayload }),
      }
    }
    return null
  }
  if (type === 'engine/validate' && typeof data.tableId === 'string') {
    // The plan is the request's complex payload: strictly shape-checked at
    // the boundary (validate-plan-wire.ts). `overlay` follows the export
    // convention — absent = the plain base view; a present-but-malformed
    // payload rejects the request.
    const plan = parseValidationPlan(data.plan)
    if (plan === null) return null
    const overlay = parseOverlayPayload(data.overlay)
    if (data.overlay !== undefined && overlay === null) return null
    return {
      type,
      requestId,
      tableId: data.tableId,
      plan,
      ...(overlay === null ? {} : { overlay }),
    }
  }
  if (type === 'engine/dispose') return { type, requestId }
  return null
}

/**
 * The m4-2/m5-2 request types whose complex host-supplied payloads (overlay
 * lists, compiled validation plans) get the typed-rejection treatment. These
 * carry enough structure that a malformed message is both plausible and —
 * because the client always holds a pending promise for its `requestId` — a
 * hang risk if the worker silently dropped it. Their envelope identity is
 * therefore preserved through parsing.
 */
export const OVERLAY_REQUEST_TYPES = [
  'engine/overlay-schema',
  'engine/overlay-row-count',
  'engine/overlay-range',
  'engine/overlay-cast-check',
  'engine/export',
  'engine/validate',
] as const

export type OverlayRequestType = (typeof OVERLAY_REQUEST_TYPES)[number]

function isOverlayRequestType(value: unknown): value is OverlayRequestType {
  return (OVERLAY_REQUEST_TYPES as readonly unknown[]).includes(value)
}

/** A recognisably overlay/export request whose payload failed validation. */
export interface MalformedEngineRequest {
  readonly requestId: number
  readonly requestType: OverlayRequestType
}

/**
 * The three-way result of parsing a raw worker message (m4-2 fix round 2):
 *
 * - `request` — a well-formed `EngineRequest`;
 * - `malformed` — a message that is recognisably an overlay/export request
 *   (a numeric `requestId` plus a known `engine/overlay-*`/`engine/export`
 *   type) but whose payload is structurally invalid. The worker must answer it
 *   with exactly one typed `engine/error` so the caller cannot hang; the
 *   envelope identity (`requestId`, request `type`) survives parsing for that
 *   purpose.
 * - `ignored` — anything else (unknown `type`, no correlatable `requestId`,
 *   or a non-object): the pre-existing contract, unchanged. A message with no
 *   usable `requestId` cannot be answered at all, and an unrecognised `type`
 *   is not part of the protocol.
 */
export type EngineRequestEnvelope =
  | { readonly status: 'request'; readonly request: EngineRequest }
  | { readonly status: 'malformed'; readonly malformed: MalformedEngineRequest }
  | { readonly status: 'ignored' }

/**
 * Parse a raw worker message into a request, a typed rejection, or an ignore
 * (see `EngineRequestEnvelope`). `parseEngineRequest` remains the strict
 * shape-only parser; this wrapper adds the envelope identity a malformed but
 * recognised overlay/export message needs to be answered instead of dropped.
 */
export function parseEngineRequestEnvelope(data: unknown): EngineRequestEnvelope {
  const request = parseEngineRequest(data)
  if (request !== null) return { status: 'request', request }
  if (isRecord(data)) {
    const { type, requestId } = data
    if (typeof requestId === 'number' && isOverlayRequestType(type)) {
      return { status: 'malformed', malformed: { requestId, requestType: type } }
    }
  }
  return { status: 'ignored' }
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

/** An optional boolean flag: absent, or a real boolean (nothing else). */
function parseOptionalFlag(value: unknown): boolean | undefined | null {
  if (value === undefined) return undefined
  return typeof value === 'boolean' ? value : null
}

/** A valid export format discriminant. */
function isExportFormat(value: unknown): value is EngineExportFormat {
  return (
    value === 'parquet' ||
    value === 'jsonl' ||
    value === 'json' ||
    value === 'csv' ||
    value === 'arrow'
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
 * well-formed `EngineResponse`. The client NEVER ignores such a message
 * when it claims to answer a pending request: it rejects that pending
 * promise with a typed protocol error instead (m5-2 round-3 fix, item 3 —
 * no response-shape failure, however caused, can leave an op hanging
 * forever; a misbehaving worker is a typed rejection, not a hang).
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
  if (type === 'engine/overlay-schema-result' && isColumnSchemaList(data.columns)) {
    return { type, requestId, columns: data.columns }
  }
  if (type === 'engine/overlay-row-count-result' && isRowCount(data.rowCount)) {
    return { type, requestId, rowCount: data.rowCount }
  }
  if (
    type === 'engine/overlay-range-result' &&
    isUint8Array(data.batchIpc) &&
    typeof data.hasMore === 'boolean'
  ) {
    return { type, requestId, batchIpc: data.batchIpc, hasMore: data.hasMore }
  }
  if (
    type === 'engine/overlay-cast-check-result' &&
    typeof data.hasNonConvertibleValues === 'boolean'
  ) {
    return { type, requestId, hasNonConvertibleValues: data.hasNonConvertibleValues }
  }
  if (
    type === 'engine/export-result' &&
    typeof data.path === 'string' &&
    isExportFormat(data.format) &&
    isRowCount(data.rowCount) &&
    isRowCount(data.bytes)
  ) {
    return {
      type,
      requestId,
      path: data.path,
      format: data.format,
      rowCount: data.rowCount,
      bytes: data.bytes,
    }
  }
  if (type === 'engine/validate-result' && isValidationResult(data.result)) {
    return { type, requestId, result: data.result }
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

/** An integer percent in [0, 100] (the failPercent contract). */
function isPercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 100
}

/** A wire-safe sample value: string, finite number, boolean, or null. */
function isSampleValue(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
}

/**
 * A well-formed validation result (shape only — the worker guarantees the
 * rest). Each rule's `failCount` must fit its own outcome's bound (m5-4
 * refinement of the m5-2 round-3 uniform guard, item 3): `row-samples`
 * counts are bounded by the result's `rowCount`; `dataset-fact` counts are
 * bounded by ONE (a boolean fact holds or fails — a compiler-shaped fact
 * reporting 2 is a foreign/non-compiler plan). A payload carrying an
 * out-of-bound count is malformed here, so the client REJECTS the pending
 * promise instead of resolving an impossible `failPercent > 100` (or a
 * count no compiler could produce) and never hangs on a discarded
 * response. The per-rule `outcome` (the closed v1 vocabulary) is part of
 * the shape since m5-4 — it is what names the bound.
 */
function isValidationResult(value: unknown): value is EngineValidationResult {
  if (!isRecord(value)) return false
  if (typeof value['valid'] !== 'boolean' || !isRowCount(value['rowCount'])) return false
  const rules = value['rules']
  if (!Array.isArray(rules)) return false
  const rowCount: number = value['rowCount']
  return rules.every((rule) => {
    if (!isRecord(rule)) return false
    const outcome = rule['outcome']
    if (typeof rule['ruleId'] !== 'string') return false
    if (outcome !== 'row-samples' && outcome !== 'dataset-fact') return false
    if (!isRowCount(rule['failCount'])) return false
    if (validationFailCountExcess(rule['failCount'], rowCount, outcome) !== null) return false
    if (!isPercent(rule['failPercent'])) return false
    const samples = rule['sampleFailures']
    if (!Array.isArray(samples)) return false
    return samples.every((sample) => {
      if (!isRecord(sample)) return false
      // A resolvable non-empty row key is part of the result contract (the
      // executor fails the op loudly rather than produce null/empty); a
      // payload carrying one is malformed and rejected (m5-2 fix round —
      // the type is the contract, not the hope).
      const rowKey = sample['rowKey']
      if (typeof rowKey !== 'string' || rowKey === '') return false
      return isSampleValue(sample['value'])
    })
  })
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
