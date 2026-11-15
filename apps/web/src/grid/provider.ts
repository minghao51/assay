// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Adapter: `GridDataProvider` over the DuckDB engine client (m1-5; sort/filter
 * wiring m2-3; edit-overlay composition m4-3).
 *
 * Composition-root glue, engine-aware by design — the grid model itself stays
 * engine-free (`@assay/grid` knows only the provider contract). Arrow never
 * crosses this seam as a type: the engine window is reconstituted on the main
 * thread and immediately projected to row-major JS cells — a *small* UI
 * projection (visible windows are ≤1000 rows after the engine's clamp),
 * explicitly allowed by ADR 0020. The structural `ArrowTableLike` /
 * `ArrowVectorLike` shapes keep `apache-arrow` out of this app's dependency
 * tree entirely; the real engine `Table` satisfies them.
 *
 * m4-3 — the effective view is the overlay view. Every read goes through the
 * engine's overlay surface (`overlaySchema` / `overlayRowCount` /
 * `fetchOverlayRange`), so the grid shows edits, hides deleted rows, places
 * inserted rows, and uses post-rename/post-cast columns. Two deliberate
 * narrowings keep the m1-5 non-materialization guarantees intact:
 *
 * 1. **Fast base path.** While the overlay is empty *and* no sort/filter is
 *    active, the provider uses the base `schema`/`rowCount`/`fetchRange`
 *    methods — the pre-m4-2 SQL, which the million-row benchmark pins. In
 *    that state the grid's row index *is* the base ordinal, so the provider
 *    synthesizes the same logical ids the composed view would
 *    (`base:<anchor>#<index>`), and editing still gets an honest identity
 *    channel. Once an op or a sort/filter exists, the overlay path takes
 *    over.
 * 2. **Row identity channel.** The overlay window asks for `includeRowIds`
 *    and the provider strips the leading `assay_row_id` column into the
 *    grid page's opaque `rowKeys` channel (m4-3). The app's edit layer
 *    addresses rows by that key — never by viewport position (ADR 0011).
 *
 * Query state (m2-3): the provider holds the active sort/filter specs so
 * every subsequent fetch/count carries them. The mapping is field-for-field:
 * the grid's `SortSpec`/`FilterSpec` are structural mirrors of the engine
 * protocol's `EngineSortSpec`/`EngineFilterSpec`. Absent/empty means
 * "cleared", so cleared state is sent as *absent* fields and the fast path
 * composes byte-identical SQL to the pre-m2-2 query. `sort(spec)` /
 * `filter(null)` implement the contract's clear protocol.
 */
import type {
  CellRange,
  ColumnSchema,
  FilterSpec,
  GridDataPage,
  GridDataProvider,
  SortSpec,
} from '@assay/grid'
import { baseRowId } from '@assay/domain'
import type {
  EngineColumnSchema,
  EngineFilterSpec,
  EngineOverlay,
  EngineOverlayWindow,
  EngineRangeWindow,
  EngineRowCountOptions,
  EngineSortSpec,
  EngineTableHandle,
} from '@assay/engine-duckdb'

/**
 * The slice of an Arrow vector the projection needs.
 *
 * `type` / `data` are the structural slices the R2 projection-boundary guard
 * reads on real engine vectors (an Arrow `Vector` exposes both); they are
 * optional so hand-rolled test doubles without a declared type keep working
 * (their cells then always take the plain `get()` path, exactly as before).
 * Neither carries the `apache-arrow` import into this app — see below.
 */
export interface ArrowVectorLike {
  get(index: number): unknown
  /**
   * Arrow's own validity read (`Vector.isValid`): the same null check `get()`
   * performs (`wrapGet` → `data.getValid`), chunk mapping included. The
   * sentinel mapping below consults it FIRST, so a NULL cell whose backing
   * slot happens to hold sentinel bits stays exactly the null `get()`
   * returns. Optional so hand-rolled doubles without a validity concept keep
   * working (treated as all-valid); real engine vectors always carry it.
   */
  isValid?(index: number): boolean
  /** Structural slice of the Arrow logical type (`DataType.typeId`/`.unit`). */
  readonly type?: ArrowTypeLike
  /** The chunked backing storage (`Vector.data`): per-chunk raw values. */
  readonly data?: readonly ArrowChunkLike[]
}

/**
 * Structural slice of an Arrow `DataType`. `typeId` is the library's
 * logical-type enum value; `unit` is the `TimeUnit` carried by timestamp
 * (and time/duration) types.
 */
export interface ArrowTypeLike {
  readonly typeId?: unknown
  readonly unit?: unknown
}

/**
 * Structural slice of one Arrow `Data` chunk: `length` logical values whose
 * physical payload starts at index 0 of `values` (the raw typed array —
 * `BigInt64Array` for timestamp vectors). Chunk `offset` is deliberately NOT
 * applied here: Arrow's own `Vector.get()` visitors index `values` by the
 * chunk-local index only, and the guard must classify exactly the cells that
 * accessor reads (engine batches are never sliced, so offset is always 0).
 *
 * `values` is deliberately `unknown`, not `ArrayLike<unknown>`: the
 * structural assignability check against the real engine `Table` makes
 * TypeScript infer this vector's type parameter from `ArrowVectorLike.type`,
 * and then `Data<T>['values']` (an indexed access on that inference) is
 * `unknown` — which only ever matches a target that also accepts `unknown`.
 * `rawInt64At` narrows it back after the type has identified the column.
 */
export interface ArrowChunkLike {
  readonly length: number
  readonly values: unknown
}

/**
 * apache-arrow's logical-type enum value for every timestamp family
 * (`Type.Timestamp`; the unit then carries the precision). Duplicated as a
 * constant because `apache-arrow` stays out of this app's dependency tree
 * (the structural shapes above are the contract).
 */
const ARROW_TYPE_TIMESTAMP = 10
/**
 * apache-arrow's `TimeUnit.NANOSECOND`. Of the four timestamp units, exactly
 * SECOND/MILLISECOND/MICROSECOND make `get()` throw on the sentinels (the
 * probe's unit control: S/MS pass the raw int64 to `bigIntToNumber`, µs
 * divides by 1000 first); NANOSECOND returns a lossy number and never throws.
 */
const TIME_UNIT_NANOSECOND = 3

/**
 * DuckDB's ±infinity TIMESTAMP sentinels, as the real engine delivers them
 * (Parquet → DuckDB-WASM → Arrow; pinned by the committed fixture round-trip
 * through DuckDB v1.5.5 and by the browser e2e):
 *
 * - `TIMESTAMP 'infinity'` delivers the int64 maximum, `9223372036854775807`;
 * - `TIMESTAMP '-infinity'` delivers its negation, `-9223372036854775807` —
 *   NOT the bare int64 minimum, because DuckDB reserves that as an internal
 *   marker (the committed fixture stores exactly 0 int64-minimum bits and 5
 *   `-9223372036854775807` bits for its `'-infinity'` row).
 */
const TIMESTAMP_INFINITY_BITS = 9223372036854775807n
const TIMESTAMP_MINUS_INFINITY_BITS = -9223372036854775807n
/**
 * The reserved int64 minimum (`-9223372036854775808`) can never carry a
 * legitimate finite instant — `get()` throws on it for the same three units —
 * so it is diverted to the same sentinel text defensively rather than
 * failing the whole window (some encodings use it for the negative sentinel).
 */
const TIMESTAMP_RESERVED_MIN_BITS = -9223372036854775808n
/**
 * DuckDB's own sentinel text, pinned for the two int64 extremes (D6
 * refinement): the raw bigint is not the value's meaning, while this text
 * invents no locale, timezone or precision. Negative control: any other
 * raw value — however close to the extremes — still follows `get()`.
 */
const INFINITY_TEXT = 'infinity'
const MINUS_INFINITY_TEXT = '-infinity'

/**
 * True when the vector is a timestamp whose unit makes Arrow's `get()` throw
 * on the DuckDB infinity sentinels (SECOND, MILLISECOND, MICROSECOND).
 * Guarded by the logical-type id, so time/duration/interval vectors that also
 * carry a numeric `unit` can never be mistaken for timestamps.
 */
function isThrowingTimestampUnit(column: ArrowVectorLike): boolean {
  const type = column.type
  return (
    type !== undefined && type.typeId === ARROW_TYPE_TIMESTAMP && type.unit !== TIME_UNIT_NANOSECOND
  )
}

/**
 * The exact raw int64 behind cell `index` of a timestamp vector, walking the
 * chunk lengths the same way `Vector.get()` does. Allocation-free per cell;
 * `undefined` whenever the raw shape is not a bigint array (defensive — then
 * the cell simply falls through to `get()`).
 */
function rawInt64At(column: ArrowVectorLike, index: number): bigint | undefined {
  const chunks = column.data
  if (chunks === undefined) {
    return undefined
  }
  let remaining = index
  for (const chunk of chunks) {
    if (remaining < chunk.length) {
      // `type` has already identified a real timestamp column here, so the
      // payload is its BigInt64Array; the slice stays `unknown` for structural
      // assignability (see ArrowChunkLike), narrowed exactly at this read.
      const values = chunk.values as ArrayLike<unknown>
      const raw: unknown = values[remaining]
      return typeof raw === 'bigint' ? raw : undefined
    }
    remaining -= chunk.length
  }
  return undefined
}

/**
 * R2 (D6, projection-boundary guard): DuckDB's ±infinity TIMESTAMP sentinels
 * make Arrow's `get()` throw for the SECOND/MILLISECOND/MICROSECOND units
 * (its `bigIntToNumber` safety check) *before* any formatter runs — one
 * infinite timestamp would otherwise throw away the whole delivered
 * window/page (probe 2026-11-14). For those three units only, and only for
 * VALID cells — Arrow's own `isValid` is consulted first, the same null
 * check `get()` performs, so a NULL whose backing slot happens to hold
 * sentinel bits stays exactly the null `get()` returns — the exact raw
 * backing `BigInt64Array` is read per cell: the sentinel values become
 * DuckDB's own sentinel text (the pinned D6 refinement), and every other
 * cell — finite values and NULLs alike — keeps the untouched `get()` path,
 * so finite DATE/TIMESTAMP/TIME rendering stays byte-identical (WF-01
 * WFD-06 = B). `Timestamp<NANOSECOND>` does not throw and stays on `get()`
 * entirely: its raw rendering is the formatter's ns rule, untouched here.
 */
function projectCell(column: ArrowVectorLike, rowIndex: number): unknown {
  if (isThrowingTimestampUnit(column) && column.isValid?.(rowIndex) !== false) {
    const raw = rawInt64At(column, rowIndex)
    if (
      raw === TIMESTAMP_INFINITY_BITS ||
      raw === TIMESTAMP_MINUS_INFINITY_BITS ||
      raw === TIMESTAMP_RESERVED_MIN_BITS
    ) {
      return raw === TIMESTAMP_INFINITY_BITS ? INFINITY_TEXT : MINUS_INFINITY_TEXT
    }
  }
  return column.get(rowIndex)
}

/** The slice of an Arrow `Table` the projection needs (columnar access). */
export interface ArrowTableLike {
  readonly numRows: number
  readonly numCols: number
  getChildAt(index: number): ArrowVectorLike | null
}

/**
 * The slice of the engine client this adapter needs (structural, for fakes).
 * The overlay methods are required: the app's only data path is the composed
 * effective view (m4-3), with the base methods used as the empty-overlay fast
 * path.
 */
export interface GridEngineClient {
  schema(handle: EngineTableHandle): Promise<EngineColumnSchema[]>
  rowCount(handle: EngineTableHandle, options?: EngineRowCountOptions): Promise<number>
  fetchRange(
    handle: EngineTableHandle,
    window: EngineRangeWindow,
  ): Promise<{ batch: ArrowTableLike; hasMore: boolean }>
  overlaySchema(handle: EngineTableHandle, overlay: EngineOverlay): Promise<EngineColumnSchema[]>
  overlayRowCount(
    handle: EngineTableHandle,
    overlay: EngineOverlay,
    options?: EngineRowCountOptions,
  ): Promise<number>
  fetchOverlayRange(
    handle: EngineTableHandle,
    overlay: EngineOverlay,
    window: EngineOverlayWindow,
  ): Promise<{ batch: ArrowTableLike; hasMore: boolean }>
}

/**
 * Project a columnar Arrow batch to row-major cells (one `unknown[]` per
 * row, in column order). Batches here are visible-window sized, so this is
 * a bounded, small projection — never dataset materialization (ADR 0020).
 */
export function projectBatchToRows(batch: ArrowTableLike): unknown[][] {
  const columns = arrowColumns(batch)
  const rows: unknown[][] = []
  for (let rowIndex = 0; rowIndex < batch.numRows; rowIndex++) {
    rows.push(columns.map((column) => projectCell(column, rowIndex)))
  }
  return rows
}

/**
 * Project an overlay window whose first column is the engine's logical
 * `assay_row_id`. Returns the data cells (id column stripped) plus the
 * parallel opaque identity keys. A non-string id or a missing id column is a
 * provider bug and throws rather than guessing a position.
 */
export function projectOverlayPage(batch: ArrowTableLike): {
  rows: unknown[][]
  rowKeys: string[]
} {
  if (batch.numCols < 1) {
    throw new Error('overlay batch is missing the row-id column')
  }
  const allColumns = arrowColumns(batch)
  const idColumn = allColumns[0]!
  const dataColumns = allColumns.slice(1)
  const rows: unknown[][] = []
  const rowKeys: string[] = []
  for (let rowIndex = 0; rowIndex < batch.numRows; rowIndex++) {
    const key = idColumn.get(rowIndex)
    if (typeof key !== 'string') {
      throw new Error(`overlay batch row ${String(rowIndex)} has a non-string row id`)
    }
    rowKeys.push(key)
    rows.push(dataColumns.map((column) => projectCell(column, rowIndex)))
  }
  return { rows, rowKeys }
}

function arrowColumns(batch: ArrowTableLike): ArrowVectorLike[] {
  const columns: ArrowVectorLike[] = []
  for (let index = 0; index < batch.numCols; index++) {
    const vector = batch.getChildAt(index)
    if (vector === null) {
      throw new Error(`engine batch is missing column ${String(index)}`)
    }
    columns.push(vector)
  }
  return columns
}

/** Reads the effective overlay for each request (never stored per-request). */
export type OverlaySource = () => EngineOverlay

/** Opens files through the engine client and serves them to the grid model. */
export class DuckDbGridProvider implements GridDataProvider {
  private readonly client: GridEngineClient
  private readonly handle: EngineTableHandle
  /**
   * The live overlay source for each request. Rebindable **only** at session
   * adoption (WF-06 A1-3): a candidate provider starts on its own empty
   * overlay box and is rebound to the adopted session's closure after the
   * reset + republish. Never readable outside this class.
   */
  private overlaySource: OverlaySource
  /** Active sort keys; empty = natural order (the `sort(null)` clear). */
  private sortKeys: EngineSortSpec[] = []
  /** Active predicates in push order; empty = unfiltered (`filter(null)`). */
  private filterPredicates: EngineFilterSpec[] = []

  constructor(client: GridEngineClient, handle: EngineTableHandle, overlaySource: OverlaySource) {
    this.client = client
    this.handle = handle
    this.overlaySource = overlaySource
  }

  /**
   * WF-06 A1-3: adopt the live session's overlay source. Called once, by
   * `adopt()`, **after** the new dataset session has started and after the
   * adopted overlay was republished to the live ref — so these reads follow the new
   * session and never the retired one. Nothing else may call it: the candidate
   * must stay isolated (its own empty box) until then, or a candidate read
   * could resolve the live overlay over the candidate's base.
   */
  rebindOverlaySource(next: OverlaySource): void {
    this.overlaySource = next
  }

  /**
   * True when the read must go through the composed overlay relation: any
   * active op (edits/deletes/inserts/renames/casts) or any sort/filter. With
   * an empty overlay and no query state the base methods are used — the
   * m1-5 fast path (and the synthesized `base:<anchor>#<index>` ids are
   * exact for natural order).
   */
  private get usesOverlay(): boolean {
    return (
      (this.overlaySource().ops?.length ?? 0) > 0 ||
      this.sortKeys.length > 0 ||
      this.filterPredicates.length > 0
    )
  }

  /** DuckDB's DESCRIBE name/type strings pass through unchanged (m1-4). */
  async schema(): Promise<ColumnSchema[]> {
    const columns = this.usesOverlay
      ? await this.client.overlaySchema(this.handle, this.overlaySource())
      : await this.client.schema(this.handle)
    return columns.map((column) => ({ name: column.name, type: column.type }))
  }

  /**
   * Total from a metadata-only `count(*)`, carrying the active filters
   * (m2-2) so the model's post-filter re-read reports the filtered total.
   */
  async rowCount(): Promise<number> {
    const options =
      this.filterPredicates.length > 0 ? { filters: this.filterPredicates } : undefined
    if (this.usesOverlay) {
      return this.client.overlayRowCount(this.handle, this.overlaySource(), options)
    }
    return this.client.rowCount(this.handle, options)
  }

  async fetchRange(range: CellRange): Promise<GridDataPage> {
    // Absent/empty = cleared (m2-2): cleared state is sent as absent fields.
    const filters = this.filterPredicates.length > 0 ? this.filterPredicates : undefined
    const sort = this.sortKeys.length > 0 ? this.sortKeys : undefined
    if (this.usesOverlay) {
      const overlay = this.overlaySource()
      const result = await this.client.fetchOverlayRange(this.handle, overlay, {
        startRow: range.startRow,
        endRow: range.endRow,
        ...(filters === undefined ? {} : { filters }),
        ...(sort === undefined ? {} : { sort }),
        // The identity channel is what makes an edit target a logical row
        // (ADR 0011), not a viewport position.
        includeRowIds: true,
      })
      const page = projectOverlayPage(result.batch)
      return { startRow: range.startRow, rows: page.rows, rowKeys: page.rowKeys }
    }
    const result = await this.client.fetchRange(this.handle, {
      startRow: range.startRow,
      endRow: range.endRow,
    })
    const rows = projectBatchToRows(result.batch)
    // Natural order: grid index == base ordinal, so the synthesized ids are
    // exactly the ids the composed view would emit for these rows.
    const anchor = this.overlaySource().base.baseAnchor
    const rowKeys = rows.map((_, offset) => baseRowId(anchor, range.startRow + offset))
    return { startRow: range.startRow, rows, rowKeys }
  }

  /**
   * Replace the dataset-wide sort (m2-3): one field-for-field engine sort
   * key, or none on `null` (clear). Accepted by construction — nothing can
   * fail before the state is recorded, satisfying the contract's
   * "rejection leaves the previous sort in effect" trivially.
   */
  async sort(spec: SortSpec | null): Promise<void> {
    this.sortKeys = spec === null ? [] : [{ column: spec.column, direction: spec.direction }]
  }

  /**
   * Push one predicate (or clear the list on `null`, the model's
   * clear-first protocol — see `GridDataProvider.filter`). Ordered list,
   * AND-composed by the engine; duplicates allowed (the contract's
   * deterministic push-order rebuild). Infallible like `sort()`.
   */
  async filter(spec: FilterSpec | null): Promise<void> {
    this.filterPredicates =
      spec === null
        ? []
        : [...this.filterPredicates, { column: spec.column, predicate: spec.predicate }]
  }
}
