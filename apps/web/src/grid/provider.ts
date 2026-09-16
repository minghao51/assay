/**
 * Adapter: `GridDataProvider` over the DuckDB engine client (m1-5; sort/filter
 * wiring m2-3).
 *
 * Composition-root glue, engine-aware by design — the grid model itself stays
 * engine-free (`@assay/grid` knows only the provider contract). Arrow never
 * crosses this seam as a type: `fetchRange` reconstitutes the engine's Arrow
 * window on the main thread and immediately projects it to row-major JS cells
 * — a *small* UI projection (visible windows are ≤1000 rows after the
 * engine's clamp), explicitly allowed by ADR 0020. The structural
 * `ArrowTableLike`/`ArrowVectorLike` shapes keep `apache-arrow` out of this
 * app's dependency tree entirely; the real engine `Table` satisfies them.
 *
 * Query state (m2-3): the provider holds the active sort/filter specs so
 * every subsequent `fetchRange`/`rowCount` carries them — the model mirrors
 * the same state above the contract (`GridViewportModel.sort`/`filters`).
 * The mapping is field-for-field: the grid's `SortSpec`/`FilterSpec` are
 * structural mirrors of the engine protocol's `EngineSortSpec`/
 * `EngineFilterSpec` (predicates are column-qualified engine-SQL fragments —
 * see the v1 grammar documented on `FilterSpec`). Absent/empty means
 * "cleared", so cleared state is sent as *absent* fields and the engine
 * composes byte-identical SQL to the unfiltered query. `sort(spec)`/
 * `filter(null)` implement the contract's clear protocol. The state
 * mutations are local and infallible, so the model's "rejection ⇒ no state
 * change" rule holds trivially at this seam; engine-side failures (e.g. an
 * invalid predicate fragment) reject later — when the model's refresh runs
 * the filtered `rowCount`/window fetches — and propagate to the UI caller.
 */
import type {
  CellRange,
  ColumnSchema,
  FilterSpec,
  GridDataPage,
  GridDataProvider,
  SortSpec,
} from '@assay/grid'
import type {
  EngineColumnSchema,
  EngineFilterSpec,
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

/** The slice of the engine client this adapter needs (structural, for fakes). */
export interface GridEngineClient {
  schema(handle: EngineTableHandle): Promise<EngineColumnSchema[]>
  rowCount(handle: EngineTableHandle, options?: EngineRowCountOptions): Promise<number>
  fetchRange(
    handle: EngineTableHandle,
    window: EngineRangeWindow,
  ): Promise<{ batch: ArrowTableLike; hasMore: boolean }>
}

/**
 * Project a columnar Arrow batch to row-major cells (one `unknown[]` per
 * row, in column order). Batches here are visible-window sized, so this is
 * a bounded, small projection — never dataset materialization (ADR 0020).
 */
export function projectBatchToRows(batch: ArrowTableLike): unknown[][] {
  const columns: ArrowVectorLike[] = []
  for (let index = 0; index < batch.numCols; index++) {
    const vector = batch.getChildAt(index)
    if (vector === null) {
      throw new Error(`engine batch is missing column ${String(index)}`)
    }
    columns.push(vector)
  }
  const rows: unknown[][] = []
  for (let rowIndex = 0; rowIndex < batch.numRows; rowIndex++) {
    rows.push(columns.map((column) => column.get(rowIndex)))
  }
  return rows
}

/** Opens files through the engine client and serves them to the grid model. */
export class DuckDbGridProvider implements GridDataProvider {
  private readonly client: GridEngineClient
  private readonly handle: EngineTableHandle
  /** Active sort keys; empty = natural order (the `sort(null)` clear). */
  private sortKeys: EngineSortSpec[] = []
  /** Active predicates in push order; empty = unfiltered (`filter(null)`). */
  private filterPredicates: EngineFilterSpec[] = []

  constructor(client: GridEngineClient, handle: EngineTableHandle) {
    this.client = client
    this.handle = handle
  }

  /** DuckDB's DESCRIBE name/type strings pass through unchanged (m1-4). */
  async schema(): Promise<ColumnSchema[]> {
    const columns = await this.client.schema(this.handle)
    return columns.map((column) => ({ name: column.name, type: column.type }))
  }

  /**
   * Total from the engine's metadata-only `count(*)`; carries the active
   * filters (m2-2) so the model's post-filter re-read reports the filtered
   * total.
   */
  async rowCount(): Promise<number> {
    return this.client.rowCount(
      this.handle,
      this.filterPredicates.length > 0 ? { filters: this.filterPredicates } : undefined,
    )
  }

  async fetchRange(range: CellRange): Promise<GridDataPage> {
    // Absent/empty = cleared (m2-2): cleared state is sent as absent fields,
    // so unfiltered/unsorted requests compose the pre-m2-2 SQL verbatim.
    // The arrays are copy-on-write (never mutated in place) and the client
    // copies again into the protocol request — no aliasing either way.
    const window: EngineRangeWindow = {
      startRow: range.startRow,
      endRow: range.endRow,
      ...(this.filterPredicates.length > 0 ? { filters: this.filterPredicates } : {}),
      ...(this.sortKeys.length > 0 ? { sort: this.sortKeys } : {}),
    }
    const result = await this.client.fetchRange(this.handle, window)
    return { startRow: range.startRow, rows: projectBatchToRows(result.batch) }
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

  // Contract placeholder (m1-5 scope ruling, still open): the grid model
  // keeps updateCell in the interface, but the edit overlay is a later task.
  // Fail loudly instead of pretending. The parameter-less declaration is
  // interface-compatible (fewer params); the contract tests call it through
  // the `GridDataProvider` type.
  async updateCell(): Promise<void> {
    throw new Error('editing is not wired to the engine yet (M1 scope: viewport + rows)')
  }
}
