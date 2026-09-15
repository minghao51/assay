/**
 * Adapter: `GridDataProvider` over the DuckDB engine client (m1-5).
 *
 * Composition-root glue, engine-aware by design — the grid model itself stays
 * engine-free (`@assay/grid` knows only the provider contract). Arrow never
 * crosses this seam as a type: `fetchRange` reconstitutes the engine's Arrow
 * window on the main thread and immediately projects it to row-major JS cells
 * — a *small* UI projection (visible windows are ≤1000 rows after the
 * engine's clamp), explicitly allowed by ADR 0020. The structural
 * `ArrowTableLike`/`ArrowVectorLike` shapes keep `apache-arrow` out of this
 * app's dependency tree entirely; the real engine `Table` satisfies them.
 */
import type { CellRange, ColumnSchema, GridDataPage, GridDataProvider } from '@assay/grid'
import type { EngineColumnSchema, EngineTableHandle } from '@assay/engine-duckdb'

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
  rowCount(handle: EngineTableHandle): Promise<number>
  fetchRange(
    handle: EngineTableHandle,
    window: { startRow: number; endRow: number },
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

  constructor(client: GridEngineClient, handle: EngineTableHandle) {
    this.client = client
    this.handle = handle
  }

  /** DuckDB's DESCRIBE name/type strings pass through unchanged (m1-4). */
  async schema(): Promise<ColumnSchema[]> {
    const columns = await this.client.schema(this.handle)
    return columns.map((column) => ({ name: column.name, type: column.type }))
  }

  /** Metadata-only total from the engine (`count(*)`, m1-5). */
  async rowCount(): Promise<number> {
    return this.client.rowCount(this.handle)
  }

  async fetchRange(range: CellRange): Promise<GridDataPage> {
    const result = await this.client.fetchRange(this.handle, {
      startRow: range.startRow,
      endRow: range.endRow,
    })
    return { startRow: range.startRow, rows: projectBatchToRows(result.batch) }
  }

  // Contract placeholders (m1-5 scope ruling): the grid model keeps
  // sort/filter/updateCell in the interface, but wiring them to engine SQL /
  // the edit overlay is a later task. Fail loudly instead of pretending. The
  // parameter-less declarations are interface-compatible (fewer params); the
  // contract tests call them through the `GridDataProvider` type.
  async sort(): Promise<void> {
    throw new Error('sorting is not wired to the engine yet (M1 scope: viewport + rows)')
  }

  async filter(): Promise<void> {
    throw new Error('filtering is not wired to the engine yet (M1 scope: viewport + rows)')
  }

  async updateCell(): Promise<void> {
    throw new Error('editing is not wired to the engine yet (M1 scope: viewport + rows)')
  }
}
