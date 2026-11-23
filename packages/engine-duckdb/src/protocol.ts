// SPDX-License-Identifier: AGPL-3.0-or-later

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
 *
 * B1/ENG-2 adds `engine/repair-preview-count`: the repair preview's affected
 * count as a typed, query-lane op. It is additive (no existing request,
 * response, cap or lane changes) and exists so the definition of "the rows
 * this repair changes" is an engine-owned predicate
 * (`repair-preview-query.ts`) rather than a host-composed SQL string executed
 * through the generic `engine/query` op.
 *
 * B3 adds `engine/profile-comparison`: the same profile payload
 * (`engine/profile-result`, unchanged) addressed by the **staged comparison**
 * id (`dN`, the single comparison scratch slot) instead of a table handle.
 * It exists so the diff staging path profiles the comparison view directly
 * and no longer opens the comparison file a second time as a regular
 * `assay_tN` table. Additive: one request type, no response-shape change, no
 * lane change (query lane, like `engine/profile`), no cap and no retention.
 */

import type { EngineOverlayPayload } from './overlay-wire.js'
import { isEngineTypeExpression, parseOverlayPayload } from './overlay-wire.js'
import type { EngineRepairPlan } from './repair-preview-query.js'
import { parseEngineRepairPlan } from './repair-preview-query.js'
import {
  MAX_CSV_INFERENCE_SAMPLE_ROWS,
  MAX_CSV_OPTION_VALUE_CODE_POINTS,
  MAX_CSV_TYPE_COLUMNS,
} from './csv-options.js'
import type { EngineCsvEffectiveOptions } from './csv-options.js'
import { MAX_RANGE_ROWS } from './range-window.js'
export type { EngineCsvEffectiveOptions }
import type { EngineValidationPlan, EngineValidationResult } from './validate-plan-wire.js'
import { parseValidationPlan } from './validate-plan-wire.js'
import { validationFailCountExcess } from './validate-query.js'
import type { EngineRowDiffPlan, EngineRowDiffResult } from './diff-plan-wire.js'
import { parseRowDiffPlan } from './diff-plan-wire.js'
export type { EngineOverlayPayload, EngineValidationPlan, EngineValidationResult }
export type { EngineRowDiffPlan, EngineRowDiffResult }
export type { EngineRepairPlan }

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
/**
 * The raw CSV option set a request may carry (ADR 0049 item 1): validated
 * total-wise by `parseCsvOptions` — in the client before sending and again in
 * the worker before any engine touch (the main thread is untrusted). The
 * envelope only checks that it is a plain object; the closed-vocabulary
 * refusal happens before dispatch (never passed to DuckDB to fail opaquely).
 */
export interface EngineOpenRequest {
  type: 'engine/open'
  requestId: number
  name: string
  file: File
  /** Optional CSV options (adoption of an already-reviewed set). CSV only. */
  options?: Record<string, unknown>
}

/**
 * The non-adopting CSV preview (ADR 0049 decisions 1/4/6): registers the
 * candidate under the preview slot's OWN names, sniffs it, and optionally
 * returns a bounded sample — it never creates a session relation, never
 * adopts, and no op may address the slot afterwards (there is no
 * cancel/release/sniff-only op). `options` is the same closed vocabulary as
 * `engine/open` PLUS the preview-only `sample_size`; `sampleRows` (absent =
 * the worker cap, 0 = no sample) asks for the bounded sample, clamped
 * worker-side like every row window.
 */
export interface EngineCsvPreviewRequest {
  type: 'engine/csv-preview'
  requestId: number
  name: string
  file: File
  options?: Record<string, unknown>
  sampleRows?: number
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

/**
 * Full statistics profile of the STAGED comparison (B3): exactly the
 * `engine/profile-result` payload `engine/profile` returns, resolved through
 * the comparison scratch slot (`ComparisonRegistry` → `assay_diff_dN`)
 * instead of a table handle.
 *
 * Identity (B3 §3.3, ADR 0025 posture): the only accepted address is the
 * engine-generated comparison id (`d` + positive decimal). A table id, an
 * `assay_tN`/`assay_diff_dN` view name, or any other spelling is refused at
 * this boundary; an absent/unknown slot is refused before any DuckDB call.
 * The staged comparison is never released by this op — the slot keeps its own
 * single-slot lifecycle (replaced on re-stage, dropped at `engine/dispose`).
 *
 * Query lane (ADR 0040): a profile is a profile-class scan, exactly like
 * `engine/profile`; it must never block the grid's registry-lane windows.
 */
export interface EngineProfileComparisonRequest {
  type: 'engine/profile-comparison'
  requestId: number
  comparisonId: string
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
 * Repair-preview affected count (B1/ENG-2). One complete `count(*)` of the
 * rows the `plan` changes over the table's **effective** relation (base +
 * overlay, repair wrap included), so a column that already carries a repair
 * in the prefix is counted on its effective values.
 *
 * The plan is **data, never SQL**: `column` is quoted as an identifier and
 * every key, target and trim character is escaped by this package's own
 * literal escaper (`repair-preview-query.ts`). The envelope validates the
 * plan's structure; the executor refuses an unknown/non-textual column and a
 * plan outside the domain's own envelope *before* any SQL runs, with
 * value-free messages (ADR 0025).
 *
 * Query lane (ADR 0040): this is a user-initiated read scan of a whole column
 * — the same class as the generic `engine/query` call it replaces, never the
 * grid's window traffic.
 */
export interface EngineRepairPreviewCountRequest {
  type: 'engine/repair-preview-count'
  requestId: number
  tableId: string
  overlay: EngineOverlayPayload
  plan: EngineRepairPlan
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

/**
 * Stage a comparison dataset file for a row diff (m6-2, checkpoint C3): the
 * picked file is registered with DuckDB under an engine-generated name and
 * materialized as a comparison scratch view (never the source path — the
 * m4-5 OPFS-scratch precedent). The returned comparison handle addresses
 * that view for a later `engine/diff`. Query lane: staging registers and
 * creates a view over a potentially large file, exactly the heavy class
 * that must never head-of-line block the grid's windows (ADR 0040).
 * Staging replaces any previously staged comparison (single slot), so
 * re-staging the same reference cannot leak views or file registrations.
 */
export interface EngineDiffStageRequest {
  type: 'engine/diff-stage'
  requestId: number
  name: string
  file: File
}

/**
 * Row-diff execution (m6-2): execute a compiled m6-1 `RowDiffPlan` with side
 * A bound to the effective view (base + the optional overlay; absent
 * `overlay` = the plain base view) and side B bound to the staged
 * comparison view addressed by `comparisonId`. The plan is boundary-
 * validated strictly (see `diff-plan-wire.ts`): a structurally malformed
 * plan is answered with exactly one typed `engine/error` before any SQL
 * runs. Query lane: the plan may scan both full datasets.
 */
export interface EngineDiffRequest {
  type: 'engine/diff'
  requestId: number
  tableId: string
  comparisonId: string
  plan: EngineRowDiffPlan
  overlay?: EngineOverlayPayload
}

/**
 * Register a pipeline `source` node's dataset (p-3). The picked file is
 * registered with DuckDB under an engine-generated name and bound as a view
 * named by the node's `relation` — the node id, the pipeline's output port
 * (the `format-view.ts` binding, named by the caller). Idempotent per
 * relation: a second registration for the same relation replaces the previous
 * view+file rather than accumulating one, so a re-run never appends and never
 * leaks registrations. Query lane (ADR 0040): registering and viewing a
 * potentially large file is the heavy, user-initiated class.
 */
export interface EnginePipelineSourceRequest {
  type: 'engine/pipeline-source'
  requestId: number
  relation: string
  name: string
  file: File
}

/**
 * Materialize one pipeline node's output (p-3):
 * `CREATE OR REPLACE VIEW "<relation>" AS <sql>`. The SQL is re-classified at
 * the boundary with the p-2 `classifyVerbatimSql` gate — a non-read-only or
 * multi-statement body is answered with one typed `engine/error` before any
 * DDL runs — and the relation is refused if it uses the engine-reserved
 * `assay_*` namespace. Idempotent: `CREATE OR REPLACE VIEW` recreates on a
 * re-run. Query lane (ADR 0040): the view's defining query may scan whole
 * datasets.
 */
export interface EnginePipelineMaterializeRequest {
  type: 'engine/pipeline-materialize'
  requestId: number
  relation: string
  sql: string
}

/**
 * Open an EXISTING session relation as a dataset handle (p2-1). Given a
 * relation that already exists as a session view (the motivating case: a
 * pipeline node's materialized output), resolve the engine's own view name
 * into a registry table id so the grid-native registry ops (`engine/schema`,
 * `engine/range`, `engine/row-count`) and `engine/export` address it by
 * handle — no SQL-result detour through `engine/query`. Additive op.
 *
 * The relation must already exist in this session; a missing relation is a
 * typed, value-free `engine/error` (ADR 0025). The relation is still refused
 * in the engine-reserved `assay_*` namespace. Registry lane: bookkeeping plus
 * a cheap existence probe (no data scan).
 */
export interface EnginePipelineHandleRequest {
  type: 'engine/pipeline-handle'
  requestId: number
  relation: string
}

/**
 * Execute one pipeline data node with its ADR 0033 materialization mode
 * (p2-4): `view`/`ephemeral` become a session view, `table` a DuckDB table,
 * and `export` a Parquet artifact written to OPFS scratch space (the same
 * `assay-exports/` convention as `engine/export`, under the pipeline's own
 * distinct stem prefix). The SQL is re-classified with the p-2 read-only
 * classifier at this boundary and the relation is refused in the reserved
 * `assay_*` namespace. Query lane (ADR 0040): the node's query may scan whole
 * datasets. Idempotent: the relation's prior view/table is dropped first, so
 * a re-run recreates rather than appends.
 */
export interface EnginePipelineExecuteRequest {
  type: 'engine/pipeline-execute'
  requestId: number
  relation: string
  materialization: 'view' | 'ephemeral' | 'table' | 'export'
  sql: string
  /**
   * Export destination (OPFS-relative, `assay-exports/assay-pipeline-export-…`);
   * required exactly when `materialization` is `export`.
   */
  path?: string
}

/**
 * Row-diff execution against two EXISTING session relations (p2-4): side A
 * bound to `inputRelation`, side B to `againstRelation`, both pipeline node
 * relations. Reuses the m6-2 row-diff machinery (`runDiff`'s core); the plan
 * is boundary-validated exactly like `engine/diff`'s. Query lane: the plan may
 * scan both relations.
 */
export interface EnginePipelineDiffRequest {
  type: 'engine/pipeline-diff'
  requestId: number
  inputRelation: string
  againstRelation: string
  plan: EngineRowDiffPlan
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
  | EngineCsvPreviewRequest
  | EngineSchemaRequest
  | EngineRangeRequest
  | EngineRowCountRequest
  | EngineProfileRequest
  | EngineProfileComparisonRequest
  | EngineOverlaySchemaRequest
  | EngineOverlayRowCountRequest
  | EngineOverlayRangeRequest
  | EngineOverlayCastCheckRequest
  | EngineRepairPreviewCountRequest
  | EngineValidateRequest
  | EngineDiffStageRequest
  | EngineDiffRequest
  | EnginePipelineSourceRequest
  | EnginePipelineMaterializeRequest
  | EnginePipelineHandleRequest
  | EnginePipelineExecuteRequest
  | EnginePipelineDiffRequest
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

// ---- CSV preview payload types (EW-03I; ADR 0049 decision 6) ----
//
// The preview response carries three disclosures: (a) the sniff_csv payload —
// the sniffer's own evidence about the candidate; (b) the effective option
// set actually composed; (c) a bounded row sample with its cap STATED. None of
// it is a validation verdict: a failure beyond the sniff sample is expected
// and normal, and `count(*)`/sample presence is never conversion evidence.

/** One sniffed column: the sniffer's own name/type evidence. */
export interface EngineCsvSniffColumn {
  name: string
  type: string
}

/** The sniff_csv disclosure, read verbatim from the engine's single row. */
export interface EngineCsvSniff {
  delimiter: string
  quote: string
  escape: string
  newLineDelimiter: string
  comment: string
  skipRows: number
  hasHeader: boolean
  columns: EngineCsvSniffColumn[]
  dateFormat: string | null
  timestampFormat: string | null
  /**
   * The sniffer's copyable `read_csv(...)` call — DISPLAY TEXT ONLY, never
   * executed: it embeds a file name and user-influenced values, and no code
   * path composes SQL from it (ADR 0049 item 3).
   */
  prompt: string | null
}

/** The bounded sample: an Arrow IPC first batch plus the exact cap applied. */
export interface EngineCsvPreviewSample {
  batchIpc: Uint8Array
  hasMore: boolean
  /** The exact LIMIT the sample was fetched with (stated, never implied). */
  rowCap: number
}

/** Result of the non-adopting CSV preview (ADR 0049 decision 6). */
export interface EngineCsvPreviewResultResponse {
  type: 'engine/csv-preview-result'
  requestId: number
  /**
   * The preview slot that staged the candidate (`p1`, …). NOT a table handle:
   * no protocol op accepts it (the slot is released by the next preview, an
   * open, or dispose — never host-reachable).
   */
  previewId: string
  sniff: EngineCsvSniff
  effectiveOptions: EngineCsvEffectiveOptions
  /** Null when the host requested no sample (`sampleRows = 0`). */
  sample: EngineCsvPreviewSample | null
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
 * The complete affected count of one repair plan (B1/ENG-2): a safe,
 * non-negative integer. A count the engine cannot represent exactly is a typed
 * `engine/error` refusal (`count-out-of-range` semantics), never an
 * approximation — the wire cannot silently lose precision (unreachable for a
 * browser-resident table; stated so the contract is explicit).
 */
export interface EngineRepairPreviewCountResultResponse {
  type: 'engine/repair-preview-count-result'
  requestId: number
  affected: number
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

/**
 * Result of staging a comparison file: the engine-generated comparison
 * handle the later `engine/diff` addresses (never a user file name, ADR
 * 0025).
 */
export interface EngineDiffStageResultResponse {
  type: 'engine/diff-stage-result'
  requestId: number
  comparisonId: string
  /** Columns of the staged comparison view (DESCRIBE), for plan compilation. */
  columns: EngineColumnSchema[]
}

/**
 * Result of the row-diff op (m6-2): the two effective row counts plus one
 * entry per aspect (`added`/`removed`/`changed`) carrying the exact count
 * and bounded, side-qualified samples. Row keys and changed-column names
 * are report content — never logged or telemetried (ADR 0025).
 */
export interface EngineDiffResultResponse {
  type: 'engine/diff-result'
  requestId: number
  result: EngineRowDiffResult
}

/** A registered pipeline source relation (the node id) and its row count. */
export interface EnginePipelineSourceResultResponse {
  type: 'engine/pipeline-source-result'
  requestId: number
  relation: string
  rowCount: number
}

/** A materialized pipeline node relation (the node id) and its row count. */
export interface EnginePipelineMaterializeResultResponse {
  type: 'engine/pipeline-materialize-result'
  requestId: number
  relation: string
  rowCount: number
}

/**
 * The relation is now addressable by the returned grid-facing `tableId`
 * (structurally a table handle). The relation is echoed so the caller can
 * correlate the handle with the pipeline node output.
 */
export interface EnginePipelineHandleResultResponse {
  type: 'engine/pipeline-handle-result'
  requestId: number
  relation: string
  tableId: string
}

/**
 * Result of executing one pipeline node (p2-4): the relation (the node id),
 * its effective mode, and the honest row count. For `export`, `path`/`bytes`
 * name the OPFS artifact and no relation is materialized.
 */
export interface EnginePipelineExecuteResultResponse {
  type: 'engine/pipeline-execute-result'
  requestId: number
  relation: string
  materialization: 'view' | 'ephemeral' | 'table' | 'export'
  rowCount: number
  /** OPFS-relative artifact path (export only). */
  path?: string
  /** Artifact byte size (export only). */
  bytes?: number
}

/** Result of a pipeline diff between two session relations (p2-4). */
export interface EnginePipelineDiffResultResponse {
  type: 'engine/pipeline-diff-result'
  requestId: number
  result: EngineRowDiffResult
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
  | EngineCsvPreviewResultResponse
  | EngineSchemaResultResponse
  | EngineRangeResultResponse
  | EngineRowCountResultResponse
  | EngineProfileResultResponse
  | EngineOverlaySchemaResultResponse
  | EngineOverlayRowCountResultResponse
  | EngineOverlayRangeResultResponse
  | EngineOverlayCastCheckResultResponse
  | EngineRepairPreviewCountResultResponse
  | EngineValidateResultResponse
  | EngineDiffStageResultResponse
  | EngineDiffResultResponse
  | EnginePipelineSourceResultResponse
  | EnginePipelineMaterializeResultResponse
  | EnginePipelineHandleResultResponse
  | EnginePipelineExecuteResultResponse
  | EnginePipelineDiffResultResponse
  | EngineExportResultResponse
  | EngineDisposedResponse
  | EngineErrorResponse

/** Responses that resolve (rather than reject) a pending request. */
export type EngineSuccessResponse =
  | EngineReadyResponse
  | EngineQueryResultResponse
  | EngineOpenResultResponse
  | EngineCsvPreviewResultResponse
  | EngineSchemaResultResponse
  | EngineRangeResultResponse
  | EngineRowCountResultResponse
  | EngineProfileResultResponse
  | EngineOverlaySchemaResultResponse
  | EngineOverlayRowCountResultResponse
  | EngineOverlayRangeResultResponse
  | EngineOverlayCastCheckResultResponse
  | EngineRepairPreviewCountResultResponse
  | EngineValidateResultResponse
  | EngineDiffStageResultResponse
  | EngineDiffResultResponse
  | EnginePipelineSourceResultResponse
  | EnginePipelineMaterializeResultResponse
  | EnginePipelineHandleResultResponse
  | EnginePipelineExecuteResultResponse
  | EnginePipelineDiffResultResponse
  | EngineExportResultResponse
  | EngineDisposedResponse

// ---- Runtime guards ----
//
// The worker sits behind a postMessage boundary, so both sides validate what
// they receive instead of trusting the shape.

/**
 * Parse a main-thread request. Returns `null` for anything that is not a
 * well-formed `EngineRequest`; `parseEngineRequestEnvelope` additionally
 * distinguishes a *recognised* request whose payload is malformed (which the
 * worker answers with a typed `engine/error`) from a truly unrecognised
 * message (which is ignored).
 *
 * The detailed parser records a value-free **field path** naming the first
 * malformed or missing field (e.g. `range.startRow`) so every rejection can
 * name the offending field class without ever echoing payload content
 * (ADR 0025).
 */
export function parseEngineRequest(data: unknown): EngineRequest | null {
  const parsed = parseEngineRequestDetailed(data)
  return parsed.ok ? parsed.request : null
}

/** Detailed parse result: the request, or the value-free field path that failed. */
type DetailedEngineRequest =
  | { readonly ok: true; readonly request: EngineRequest }
  | { readonly ok: false; readonly reason: string }

function malformedField(field: string): DetailedEngineRequest {
  return { ok: false, reason: field }
}

/**
 * Strict shape-only request parser with a field-path reason. Every recognised
 * request type validates **all** of its required fields here — a malformed
 * envelope is rejected at this seam, never silently dropped or partially
 * defaulted (q-10). Semantic validation (integer/non-negative/ordered/capped
 * windows, plan bindings, …) stays where it is handled today: this function
 * only decides well-formedness.
 */
function parseEngineRequestDetailed(data: unknown): DetailedEngineRequest {
  if (!isRecord(data)) return malformedField('envelope')
  const { type, requestId } = data
  if (typeof requestId !== 'number') return malformedField('requestId')
  if (type === 'engine/init') return { ok: true, request: { type, requestId } }
  if (type === 'engine/query') {
    if (typeof data.sql !== 'string') return malformedField('query.sql')
    return { ok: true, request: { type, requestId, sql: data.sql } }
  }
  if (type === 'engine/open') {
    if (typeof data.name !== 'string') return malformedField('open.name')
    if (!isFile(data.file)) return malformedField('open.file')
    // CSV options (EW-03I): envelope checks shape only (a plain object — an
    // array is not); the closed vocabulary is refused before dispatch by
    // `parseCsvOptions` in the client and again in the executor.
    if (data.options !== undefined && !isPlainRecord(data.options)) {
      return malformedField('open.options')
    }
    return {
      ok: true,
      request: {
        type,
        requestId,
        name: data.name,
        file: data.file,
        ...(data.options === undefined ? {} : { options: data.options }),
      },
    }
  }
  if (type === 'engine/csv-preview') {
    if (typeof data.name !== 'string') return malformedField('csv-preview.name')
    if (!isFile(data.file)) return malformedField('csv-preview.file')
    if (data.options !== undefined && !isPlainRecord(data.options)) {
      return malformedField('csv-preview.options')
    }
    // Well-formedness only (a number); the worker clamps/validates semantics
    // like every row window (absent = the worker cap, 0 = no sample).
    if (data.sampleRows !== undefined && typeof data.sampleRows !== 'number') {
      return malformedField('csv-preview.sampleRows')
    }
    return {
      ok: true,
      request: {
        type,
        requestId,
        name: data.name,
        file: data.file,
        ...(data.options === undefined ? {} : { options: data.options }),
        ...(data.sampleRows === undefined ? {} : { sampleRows: data.sampleRows }),
      },
    }
  }
  if (type === 'engine/schema') {
    if (typeof data.tableId !== 'string') return malformedField('schema.tableId')
    return { ok: true, request: { type, requestId, tableId: data.tableId } }
  }
  if (type === 'engine/range') {
    if (typeof data.tableId !== 'string') return malformedField('range.tableId')
    const columns = parseOptionalColumns(data.columns)
    if (columns === null) return malformedField('range.columns')
    const filters = parseOptionalFilters(data.filters)
    if (filters === null) return malformedField('range.filters')
    const sort = parseOptionalSorts(data.sort)
    if (sort === null) return malformedField('range.sort')
    // Well-formedness only: the bounds must be numbers. Semantic validation
    // (integer, non-negative, ordered, capped) happens in `runRange` via
    // `validateRowWindow` so bad windows get an error *reply*, not silence.
    if (typeof data.startRow !== 'number') return malformedField('range.startRow')
    if (typeof data.endRow !== 'number') return malformedField('range.endRow')
    return {
      ok: true,
      request: {
        type,
        requestId,
        tableId: data.tableId,
        startRow: data.startRow,
        endRow: data.endRow,
        ...(columns === undefined ? {} : { columns }),
        ...(filters === undefined ? {} : { filters }),
        ...(sort === undefined ? {} : { sort }),
      },
    }
  }
  if (type === 'engine/row-count') {
    if (typeof data.tableId !== 'string') return malformedField('row-count.tableId')
    const filters = parseOptionalFilters(data.filters)
    if (filters === null) return malformedField('row-count.filters')
    return {
      ok: true,
      request:
        filters === undefined
          ? { type, requestId, tableId: data.tableId }
          : { type, requestId, tableId: data.tableId, filters },
    }
  }
  if (type === 'engine/profile') {
    if (typeof data.tableId !== 'string') return malformedField('profile.tableId')
    return { ok: true, request: { type, requestId, tableId: data.tableId } }
  }
  if (type === 'engine/profile-comparison') {
    // Strict additive op: it carries exactly one payload field, so any other
    // own key is refused by CLASS (the key is never echoed — ADR 0025) rather
    // than silently dropped like an ignorable extra.
    for (const key of Object.keys(data)) {
      if (key !== 'type' && key !== 'requestId' && key !== 'comparisonId') {
        return malformedField('profile-comparison.unknown-field')
      }
    }
    // Only the engine-generated comparison id spelling is addressable: view
    // names and table ids are engine-internal and never accepted from wire.
    if (typeof data.comparisonId !== 'string' || !isComparisonId(data.comparisonId)) {
      return malformedField('profile-comparison.comparisonId')
    }
    return { ok: true, request: { type, requestId, comparisonId: data.comparisonId } }
  }
  if (type === 'engine/overlay-schema') {
    if (typeof data.tableId !== 'string') return malformedField('overlay-schema.tableId')
    const overlay = parseOverlayPayload(data.overlay)
    // The four overlay query ops require the payload; absent or malformed is
    // a rejected envelope (never a silent base-view default).
    if (overlay === null) return malformedField('overlay-schema.overlay')
    return { ok: true, request: { type, requestId, tableId: data.tableId, overlay } }
  }
  if (type === 'engine/overlay-row-count') {
    if (typeof data.tableId !== 'string') return malformedField('overlay-row-count.tableId')
    const overlay = parseOverlayPayload(data.overlay)
    if (overlay === null) return malformedField('overlay-row-count.overlay')
    const filters = parseOptionalFilters(data.filters)
    if (filters === null) return malformedField('overlay-row-count.filters')
    return {
      ok: true,
      request: {
        type,
        requestId,
        tableId: data.tableId,
        overlay,
        ...(filters === undefined ? {} : { filters }),
      },
    }
  }
  if (type === 'engine/overlay-range') {
    if (typeof data.tableId !== 'string') return malformedField('overlay-range.tableId')
    const overlay = parseOverlayPayload(data.overlay)
    if (overlay === null) return malformedField('overlay-range.overlay')
    const columns = parseOptionalColumns(data.columns)
    if (columns === null) return malformedField('overlay-range.columns')
    const filters = parseOptionalFilters(data.filters)
    if (filters === null) return malformedField('overlay-range.filters')
    const sort = parseOptionalSorts(data.sort)
    if (sort === null) return malformedField('overlay-range.sort')
    const includeRowIds = parseOptionalFlag(data.includeRowIds)
    if (includeRowIds === null) return malformedField('overlay-range.includeRowIds')
    if (typeof data.startRow !== 'number') return malformedField('overlay-range.startRow')
    if (typeof data.endRow !== 'number') return malformedField('overlay-range.endRow')
    return {
      ok: true,
      request: {
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
      },
    }
  }
  if (type === 'engine/overlay-cast-check') {
    if (typeof data.tableId !== 'string') return malformedField('overlay-cast-check.tableId')
    const overlay = parseOverlayPayload(data.overlay)
    if (overlay === null) return malformedField('overlay-cast-check.overlay')
    // The standalone target type is untrusted input for a SQL type position:
    // reject a malformed spelling at the boundary (the client already
    // validated it; a hostile sender is answered, never dropped).
    if (typeof data.column !== 'string') return malformedField('overlay-cast-check.column')
    if (typeof data.targetType !== 'string') return malformedField('overlay-cast-check.targetType')
    if (!isEngineTypeExpression(data.targetType)) {
      return malformedField('overlay-cast-check.targetType')
    }
    return {
      ok: true,
      request: {
        type,
        requestId,
        tableId: data.tableId,
        overlay,
        column: data.column,
        targetType: data.targetType,
      },
    }
  }
  if (type === 'engine/repair-preview-count') {
    if (typeof data.tableId !== 'string') return malformedField('repair-preview-count.tableId')
    const overlay = parseOverlayPayload(data.overlay)
    // The op is defined over the effective relation, so the payload is
    // required (absent is a rejected envelope, never a silent base default).
    if (overlay === null) return malformedField('repair-preview-count.overlay')
    // The plan is the request's complex payload: shape-checked here (strings,
    // pair pairs, unit trim) and envelope-checked in the executor before any
    // SQL (see `repair-preview-query.ts`).
    const plan = parseEngineRepairPlan(data.plan)
    if (plan === null) return malformedField('repair-preview-count.plan')
    return { ok: true, request: { type, requestId, tableId: data.tableId, overlay, plan } }
  }
  if (type === 'engine/export') {
    if (typeof data.tableId !== 'string') return malformedField('export.tableId')
    const overlay = parseOverlayPayload(data.overlay)
    // engine/export allows an absent overlay (plain base-view export); a
    // present-but-malformed payload rejects the request in both cases (never
    // silently ignored or defaulted away).
    if (data.overlay !== undefined && overlay === null) return malformedField('export.overlay')
    if (!isExportFormat(data.format)) return malformedField('export.format')
    const overlayPayload = overlay ?? undefined
    return {
      ok: true,
      request: {
        type,
        requestId,
        tableId: data.tableId,
        format: data.format,
        ...(overlayPayload === undefined ? {} : { overlay: overlayPayload }),
      },
    }
  }
  if (type === 'engine/validate') {
    if (typeof data.tableId !== 'string') return malformedField('validate.tableId')
    // The plan is the request's complex payload: strictly shape-checked at
    // the boundary (validate-plan-wire.ts). `overlay` follows the export
    // convention — absent = the plain base view; a present-but-malformed
    // payload rejects the request.
    const plan = parseValidationPlan(data.plan)
    if (plan === null) return malformedField('validate.plan')
    const overlay = parseOverlayPayload(data.overlay)
    if (data.overlay !== undefined && overlay === null) return malformedField('validate.overlay')
    return {
      ok: true,
      request: {
        type,
        requestId,
        tableId: data.tableId,
        plan,
        ...(overlay === null ? {} : { overlay }),
      },
    }
  }
  if (type === 'engine/diff-stage') {
    if (typeof data.name !== 'string') return malformedField('diff-stage.name')
    if (!isFile(data.file)) return malformedField('diff-stage.file')
    return { ok: true, request: { type, requestId, name: data.name, file: data.file } }
  }
  if (type === 'engine/diff') {
    if (typeof data.tableId !== 'string') return malformedField('diff.tableId')
    // The plan is the request's complex payload: strictly shape-checked at
    // the boundary (diff-plan-wire.ts). `overlay` follows the validate
    // convention — absent = the plain base view; a present-but-malformed
    // payload rejects the request.
    if (typeof data.comparisonId !== 'string') return malformedField('diff.comparisonId')
    const plan = parseRowDiffPlan(data.plan)
    if (plan === null) return malformedField('diff.plan')
    const overlay = parseOverlayPayload(data.overlay)
    if (data.overlay !== undefined && overlay === null) return malformedField('diff.overlay')
    return {
      ok: true,
      request: {
        type,
        requestId,
        tableId: data.tableId,
        comparisonId: data.comparisonId,
        plan,
        ...(overlay === null ? {} : { overlay }),
      },
    }
  }
  if (type === 'engine/pipeline-source') {
    if (typeof data.relation !== 'string') return malformedField('pipeline-source.relation')
    if (typeof data.name !== 'string') return malformedField('pipeline-source.name')
    if (!isFile(data.file)) return malformedField('pipeline-source.file')
    return {
      ok: true,
      request: { type, requestId, relation: data.relation, name: data.name, file: data.file },
    }
  }
  if (type === 'engine/pipeline-materialize') {
    if (typeof data.relation !== 'string') return malformedField('pipeline-materialize.relation')
    if (typeof data.sql !== 'string') return malformedField('pipeline-materialize.sql')
    return { ok: true, request: { type, requestId, relation: data.relation, sql: data.sql } }
  }
  if (type === 'engine/pipeline-handle') {
    if (typeof data.relation !== 'string') return malformedField('pipeline-handle.relation')
    return { ok: true, request: { type, requestId, relation: data.relation } }
  }
  if (type === 'engine/pipeline-execute') {
    if (typeof data.relation !== 'string') return malformedField('pipeline-execute.relation')
    if (!isPipelineMaterialization(data.materialization)) {
      return malformedField('pipeline-execute.materialization')
    }
    if (typeof data.sql !== 'string') return malformedField('pipeline-execute.sql')
    if (data.materialization === 'export') {
      if (typeof data.path !== 'string') return malformedField('pipeline-execute.path')
      return {
        ok: true,
        request: {
          type,
          requestId,
          relation: data.relation,
          materialization: data.materialization,
          sql: data.sql,
          path: data.path,
        },
      }
    }
    return {
      ok: true,
      request: {
        type,
        requestId,
        relation: data.relation,
        materialization: data.materialization,
        sql: data.sql,
      },
    }
  }
  if (type === 'engine/pipeline-diff') {
    if (typeof data.inputRelation !== 'string') return malformedField('pipeline-diff.inputRelation')
    if (typeof data.againstRelation !== 'string') {
      return malformedField('pipeline-diff.againstRelation')
    }
    const plan = parseRowDiffPlan(data.plan)
    if (plan === null) return malformedField('pipeline-diff.plan')
    return {
      ok: true,
      request: {
        type,
        requestId,
        inputRelation: data.inputRelation,
        againstRelation: data.againstRelation,
        plan,
      },
    }
  }
  if (type === 'engine/dispose') return { ok: true, request: { type, requestId } }
  // Unrecognised `type`: not part of the protocol (the envelope ignores it).
  return malformedField('type')
}

/**
 * Every request `type` the protocol recognises (drives the malformed-envelope
 * rejection below). A message carrying one of these types plus a numeric
 * `requestId` is *recognised*: its payload must validate, or the worker
 * answers it with exactly one typed `engine/error` rather than silently
 * dropping it (q-10). Because the client always holds a pending promise for
 * its `requestId`, a silent drop is a hang risk regardless of which request
 * type it was.
 */
export const ENGINE_REQUEST_TYPES = [
  'engine/init',
  'engine/query',
  'engine/open',
  'engine/csv-preview',
  'engine/schema',
  'engine/range',
  'engine/row-count',
  'engine/profile',
  'engine/profile-comparison',
  'engine/overlay-schema',
  'engine/overlay-row-count',
  'engine/overlay-range',
  'engine/overlay-cast-check',
  'engine/repair-preview-count',
  'engine/validate',
  'engine/diff-stage',
  'engine/diff',
  'engine/pipeline-source',
  'engine/pipeline-materialize',
  'engine/pipeline-handle',
  'engine/pipeline-execute',
  'engine/pipeline-diff',
  'engine/export',
  'engine/dispose',
] as const

export type EngineRequestType = (typeof ENGINE_REQUEST_TYPES)[number]

function isEngineRequestType(value: unknown): value is EngineRequestType {
  return (ENGINE_REQUEST_TYPES as readonly unknown[]).includes(value)
}

/**
 * The m4-2/m5-2 subset whose complex host-supplied payloads (overlay lists,
 * compiled validation plans) first motivated the typed-rejection treatment.
 * Since q-10 every recognised request type gets that treatment (see
 * `ENGINE_REQUEST_TYPES`); this list is retained for the subset-specific
 * regression coverage and as the historical record of where the gap was
 * closed.
 */
export const OVERLAY_REQUEST_TYPES = [
  'engine/overlay-schema',
  'engine/overlay-row-count',
  'engine/overlay-range',
  'engine/overlay-cast-check',
  'engine/export',
  'engine/validate',
  'engine/diff-stage',
  'engine/diff',
] as const

export type OverlayRequestType = (typeof OVERLAY_REQUEST_TYPES)[number]

/** A recognised request whose payload failed structural validation. */
export interface MalformedEngineRequest {
  readonly requestId: number
  readonly requestType: EngineRequestType
  /**
   * Value-free field path of the first malformed/missing field (e.g.
   * `range.startRow`). Never payload content, never raw SQL (ADR 0025).
   */
  readonly field: string
}

/**
 * The three-way result of parsing a raw worker message:
 *
 * - `request` — a well-formed `EngineRequest`;
 * - `malformed` — a message that is recognisably a protocol request (a
 *   numeric `requestId` plus a known request `type`) but whose payload is
 *   structurally invalid. The worker must answer it with exactly one typed
 *   `engine/error` so the caller cannot hang; the envelope identity
 *   (`requestId`, request `type`) and the value-free `field` path survive
 *   parsing for that purpose.
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
 * recognised request needs to be answered instead of dropped.
 */
export function parseEngineRequestEnvelope(data: unknown): EngineRequestEnvelope {
  const parsed = parseEngineRequestDetailed(data)
  if (parsed.ok) return { status: 'request', request: parsed.request }
  if (isRecord(data)) {
    const { type, requestId } = data
    if (typeof requestId === 'number' && isEngineRequestType(type)) {
      return {
        status: 'malformed',
        malformed: { requestId, requestType: type, field: parsed.reason },
      }
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

/** A pipeline node's ADR 0033 mode as far as the engine materializes it (p2-4). */
function isPipelineMaterialization(
  value: unknown,
): value is 'view' | 'ephemeral' | 'table' | 'export' {
  return value === 'view' || value === 'ephemeral' || value === 'table' || value === 'export'
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
  if (type === 'engine/csv-preview-result' && isCsvPreviewResult(data)) {
    return {
      type,
      requestId,
      previewId: data.previewId,
      sniff: data.sniff,
      effectiveOptions: data.effectiveOptions,
      sample: data.sample,
    }
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
  if (type === 'engine/repair-preview-count-result' && isRowCount(data.affected)) {
    // A count outside the safe, non-negative integer domain is an impossible
    // payload: the executor refuses `count-out-of-range` rather than send an
    // approximation, so the client rejects instead of resolving a wrong count.
    return { type, requestId, affected: data.affected }
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
  if (
    type === 'engine/diff-stage-result' &&
    typeof data.comparisonId === 'string' &&
    isColumnSchemaList(data.columns)
  ) {
    return { type, requestId, comparisonId: data.comparisonId, columns: data.columns }
  }
  if (type === 'engine/diff-result' && isRowDiffResult(data.result)) {
    return { type, requestId, result: data.result }
  }
  if (
    type === 'engine/pipeline-source-result' &&
    typeof data.relation === 'string' &&
    isRowCount(data.rowCount)
  ) {
    return { type, requestId, relation: data.relation, rowCount: data.rowCount }
  }
  if (
    type === 'engine/pipeline-materialize-result' &&
    typeof data.relation === 'string' &&
    isRowCount(data.rowCount)
  ) {
    return { type, requestId, relation: data.relation, rowCount: data.rowCount }
  }
  if (
    type === 'engine/pipeline-handle-result' &&
    typeof data.relation === 'string' &&
    typeof data.tableId === 'string'
  ) {
    return { type, requestId, relation: data.relation, tableId: data.tableId }
  }
  if (
    type === 'engine/pipeline-execute-result' &&
    typeof data.relation === 'string' &&
    isPipelineMaterialization(data.materialization) &&
    isRowCount(data.rowCount)
  ) {
    if (data.materialization === 'export') {
      if (typeof data.path !== 'string' || !isRowCount(data.bytes)) return null
      return {
        type,
        requestId,
        relation: data.relation,
        materialization: data.materialization,
        rowCount: data.rowCount,
        path: data.path,
        bytes: data.bytes,
      }
    }
    return {
      type,
      requestId,
      relation: data.relation,
      materialization: data.materialization,
      rowCount: data.rowCount,
    }
  }
  if (type === 'engine/pipeline-diff-result' && isRowDiffResult(data.result)) {
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

/**
 * The comparison-slot id spelling the engine mints (`ComparisonRegistry`:
 * `d` + a positive decimal). Kept local to the boundary so a wire value can
 * never address a view name or a table id (ADR 0025 posture).
 */
function isComparisonId(value: string): boolean {
  return /^d[1-9][0-9]*$/.test(value)
}

/**
 * A well-formed CSV preview result (shape only — the worker guarantees the
 * rest): a non-empty slot id, a sniff payload with exactly the disclosure
 * fields (strings for the dialect, a safe `skipRows`, name/type pairs, and
 * string-or-null for the nullable evidence), an effective-option record whose
 * keys are all in the closed vocabulary with type-matched values, and a
 * sample that is null (the host asked for none) or a capped batch shape.
 */
function isCsvPreviewResult(data: Record<string, unknown>): data is {
  previewId: string
  sniff: EngineCsvSniff
  effectiveOptions: EngineCsvEffectiveOptions
  sample: EngineCsvPreviewSample | null
} {
  if (typeof data['previewId'] !== 'string' || data['previewId'] === '') return false
  const sniff = data['sniff']
  if (!isRecord(sniff)) return false
  const dialectStrings = ['delimiter', 'quote', 'escape', 'newLineDelimiter', 'comment']
  if (!dialectStrings.every((key) => typeof sniff[key] === 'string')) return false
  if (!isRowCount(sniff['skipRows']) || typeof sniff['hasHeader'] !== 'boolean') return false
  const columns = sniff['columns']
  if (!Array.isArray(columns) || !columns.every(isSniffColumn)) return false
  if (!isStringOrNull(sniff['dateFormat']) || !isStringOrNull(sniff['timestampFormat'])) {
    return false
  }
  if (!isStringOrNull(sniff['prompt'])) return false
  if (!isEffectiveOptions(data['effectiveOptions'])) return false
  const sample = data['sample']
  if (sample === null) return true
  // A non-null sample's cap is the composed LIMIT: always ≥ 1 (sampleRows = 0
  // yields a null sample) and never beyond the row-window clamp (the worker
  // clamps to MAX_RANGE_ROWS) — anything else is an impossible payload.
  return (
    isRecord(sample) &&
    isUint8Array(sample['batchIpc']) &&
    typeof sample['hasMore'] === 'boolean' &&
    isRowCount(sample['rowCap']) &&
    (sample['rowCap'] as number) >= 1 &&
    (sample['rowCap'] as number) <= MAX_RANGE_ROWS
  )
}

function isSniffColumn(value: unknown): value is EngineCsvSniffColumn {
  return isRecord(value) && typeof value['name'] === 'string' && typeof value['type'] === 'string'
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

/**
 * A disclosed effective-option record: every key in the closed vocabulary,
 * every value inside its parsed domain (the worker builds this canonically;
 * a payload carrying a foreign key, an out-of-domain number, or an invalid
 * type expression is an impossible payload and rejected). `skip` must be a
 * non-negative safe integer; `sample_size` must sit inside the preview
 * inference budget (and can never be negative — `-1` is refused at parse);
 * declared types must pass the strict type-expression validator.
 */
function isEffectiveOptions(value: unknown): boolean {
  if (!isPlainRecord(value)) return false
  const booleanKeys = ['header', 'all_varchar']
  const stringKeys = ['delim', 'quote', 'escape', 'nullstr', 'dateformat', 'comment']
  for (const key of Object.keys(value)) {
    const v = value[key]
    if (booleanKeys.includes(key)) {
      if (typeof v !== 'boolean') return false
    } else if (stringKeys.includes(key)) {
      if (typeof v !== 'string' || v.length > MAX_CSV_OPTION_VALUE_CODE_POINTS) return false
    } else if (key === 'skip') {
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) return false
    } else if (key === 'sample_size') {
      if (
        typeof v !== 'number' ||
        !Number.isSafeInteger(v) ||
        v < 0 ||
        v > MAX_CSV_INFERENCE_SAMPLE_ROWS
      ) {
        return false
      }
    } else if (key === 'columns') {
      // The same domain parseCsvOptions enforces: a NON-EMPTY map of at most
      // MAX_CSV_TYPE_COLUMNS entries, keys within the string cap, values that
      // pass the strict type-expression validator.
      if (!isPlainRecord(v)) return false
      const entries = Object.entries(v)
      if (entries.length === 0 || entries.length > MAX_CSV_TYPE_COLUMNS) return false
      const withinDomain = entries.every(
        ([columnName, entry]) =>
          columnName.length <= MAX_CSV_OPTION_VALUE_CODE_POINTS &&
          typeof entry === 'string' &&
          isEngineTypeExpression(entry),
      )
      if (!withinDomain) return false
    } else {
      // A foreign key in a disclosure payload is a foreign signal.
      return false
    }
  }
  return true
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

/**
 * A well-formed row-diff result (shape only — the worker guarantees the
 * rest): exactly the three aspects in the compiler's order, non-negative
 * counts, and bounded samples whose side/row-key shapes are coherent. The
 * result-sanity bounds are enforced worker-side; the client-side check keeps
 * a malformed payload from resolving a promise with an impossible shape.
 */
function isRowDiffResult(value: unknown): value is EngineRowDiffResult {
  if (!isRecord(value)) return false
  if (!isRowCount(value['rowCountA']) || !isRowCount(value['rowCountB'])) return false
  const aspects = value['aspects']
  if (!Array.isArray(aspects) || aspects.length !== 3) return false
  const order = ['added', 'removed', 'changed']
  return aspects.every((aspect, index) => {
    if (!isRecord(aspect)) return false
    if (aspect['aspect'] !== order[index]) return false
    if (!isRowCount(aspect['count'])) return false
    const samples = aspect['samples']
    if (!Array.isArray(samples)) return false
    return samples.every((sample) => {
      if (!isRecord(sample)) return false
      if (sample['side'] !== 'A' && sample['side'] !== 'B') return false
      const rowKey = sample['rowKey']
      if (typeof rowKey !== 'string' || rowKey === '') return false
      const changed = sample['changedColumns']
      if (changed !== undefined) {
        if (!Array.isArray(changed) || !changed.every((c) => typeof c === 'string')) return false
      }
      return true
    })
  })
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

/**
 * A plain (non-array) object shape for host-supplied option payloads. The
 * existing `isRecord` accepts arrays (arrays are objects); the CSV option
 * payload must be a record, so the envelope narrows with this guard instead
 * — a malformed shape is a rejected envelope, never a silently ignored field.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
