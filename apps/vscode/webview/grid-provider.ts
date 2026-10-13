// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Adapter: `GridDataProvider` over the real `@assay/engine-duckdb` client for
 * the webview dataset surface (ptv1-4). Composition-root glue, engine-aware
 * by design — the headless grid model stays engine-free (`@assay/grid` knows
 * only the provider contract, ADR 0022). This is the webview twin of the web
 * app's `apps/web/src/grid/provider.ts` with the read-only narrowing this
 * surface owns in slice 1: the BASE engine path only (no overlay —
 * edit/validate/diff in VS Code is out of slice, recorded in the queue) plus
 * the m2-1 sort/filter provider state.
 *
 * Arrow never crosses this seam as a type: the engine window is projected to
 * row-major JS cells immediately — a bounded, small UI projection (visible
 * windows are ≤1000 rows after the engine's clamp), explicitly allowed by
 * ADR 0020. The structural `ArrowTableLike`/`ArrowVectorLike` shapes keep
 * `apache-arrow` out of this surface's dependency tree; the real engine
 * `Table` satisfies them.
 *
 * Row identity (ADR 0011): the provider supplies the page's opaque `rowKeys`
 * channel via `baseRowId(anchor, ordinal)` — the same derivation the web app
 * uses in its base fast path. The anchor is the engine's table handle id (a
 * host token for the immutable base version opened this session); the
 * derivation is a function of (anchor, base ordinal), never of sort/filter/
 * window position. The read-only grid never consumes the keys; they keep the
 * identity channel honest for later slices' edit affordances (which stay
 * disabled without an overlay).
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
import type { EngineColumnSchema, EngineRangeWindow, EngineTableHandle } from '@assay/engine-duckdb'

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
 * The slice of the engine client this adapter needs (structural, so tests
 * and the spike harness can substitute fakes). The real `DuckDbEngineClient`
 * satisfies it.
 */
export interface GridEngineClientSlice {
  schema(handle: EngineTableHandle): Promise<EngineColumnSchema[]>
  rowCount(
    handle: EngineTableHandle,
    options?: { readonly filters?: readonly { column: string; predicate: string }[] },
  ): Promise<number>
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
    const column = batch.getChildAt(index)
    if (column === null) {
      throw new Error(`engine batch is missing column ${String(index)}`)
    }
    columns.push(column)
  }
  const rows: unknown[][] = []
  for (let rowIndex = 0; rowIndex < batch.numRows; rowIndex++) {
    rows.push(columns.map((column) => column.get(rowIndex)))
  }
  return rows
}

/**
 * Serve one opened dataset handle to the grid model. Sort/filter are
 * provider state exactly as in the m2-1 contract: the model mirrors every
 * accepted change here via `sort()`/`filter()`, and subsequent windows and
 * counts carry the state (field-for-field `EngineSortSpec`/
 * `EngineFilterSpec` mirrors; absent/empty means "cleared").
 */
export class EngineGridProvider implements GridDataProvider {
  private readonly client: GridEngineClientSlice
  private readonly handle: EngineTableHandle
  /** Host token anchoring base-row identity (the engine's table handle id). */
  private readonly anchor: string
  /** Active sort keys; empty = natural order (the `sort(null)` clear). */
  private sortKeys: { column: string; direction: 'asc' | 'desc' }[] = []
  /** Active predicates in push order; empty = unfiltered (`filter(null)`). */
  private filterPredicates: { column: string; predicate: string }[] = []

  constructor(client: GridEngineClientSlice, handle: EngineTableHandle) {
    this.client = client
    this.handle = handle
    this.anchor = handle.id
  }

  /** DuckDB's DESCRIBE name/type strings pass through unchanged (m1-4). */
  async schema(): Promise<ColumnSchema[]> {
    const columns = await this.client.schema(this.handle)
    return columns.map((column) => ({ name: column.name, type: column.type }))
  }

  /** Metadata-only `count(*)`, narrowed by the active filters (m2-2). */
  async rowCount(): Promise<number> {
    const options =
      this.filterPredicates.length > 0 ? { filters: this.filterPredicates } : undefined
    return this.client.rowCount(this.handle, options)
  }

  async fetchRange(range: CellRange): Promise<GridDataPage> {
    // Absent/empty = cleared (m2-2): cleared state is sent as absent fields,
    // so the composed SQL stays byte-identical to the plain base query.
    const filters = this.filterPredicates.length > 0 ? this.filterPredicates : undefined
    const sort = this.sortKeys.length > 0 ? this.sortKeys : undefined
    const result = await this.client.fetchRange(this.handle, {
      startRow: range.startRow,
      endRow: range.endRow,
      ...(filters === undefined ? {} : { filters }),
      ...(sort === undefined ? {} : { sort }),
    })
    const rows = projectBatchToRows(result.batch)
    // Provider-clamp contract: the model never asks for more than
    // `maxSpanRows` (≤ the engine's clamp), so an in-range request must be
    // served exactly; a short page is a contract violation and surfaces as
    // the model's fatal (non-retryable) error rather than a wrong row.
    if (rows.length !== range.endRow - range.startRow) {
      throw new Error(
        `engine window size mismatch: requested ${String(range.endRow - range.startRow)} rows, got ${String(rows.length)}`,
      )
    }
    const rowKeys = rows.map((_, offset) => baseRowId(this.anchor, range.startRow + offset))
    return { startRow: range.startRow, rows, rowKeys }
  }

  /** Replace the dataset-wide sort (`null` clears) — infallible recording. */
  async sort(spec: SortSpec | null): Promise<void> {
    this.sortKeys = spec === null ? [] : [{ column: spec.column, direction: spec.direction }]
  }

  /**
   * Push one predicate (or clear the list on `null`, the model's
   * clear-first protocol). Ordered list, AND-composed by the engine;
   * duplicates allowed. Infallible like `sort()` — an invalid fragment
   * rejects later, at the engine, through `rowCount`/`fetchRange`.
   */
  async filter(spec: FilterSpec | null): Promise<void> {
    this.filterPredicates =
      spec === null
        ? []
        : [...this.filterPredicates, { column: spec.column, predicate: spec.predicate }]
  }
}
