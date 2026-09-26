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

/** The slice of an Arrow vector the projection needs. */
export interface ArrowVectorLike {
  get(index: number): unknown
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
    rows.push(columns.map((column) => column.get(rowIndex)))
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
    rows.push(dataColumns.map((column) => column.get(rowIndex)))
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
  private readonly overlaySource: OverlaySource
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
