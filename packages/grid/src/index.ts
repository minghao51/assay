/**
 * @assay/grid — the owned headless grid model.
 *
 * The grid is a view, never the dataset (ADR 0003/0022). The model owns
 * viewport coordinates, selection, editing state, keyboard commands,
 * clipboard, and annotations; rendering stays replaceable behind it. The
 * grid requests only visible or nearby ranges and must never materialize
 * the full dataset in UI state (docs/architecture/02-architecture.md §8).
 */

export interface CellRange {
  startRow: number
  endRow: number
  startCol: number
  endCol: number
}

export interface SortSpec {
  column: string
  direction: 'asc' | 'desc'
}

/** Predicate string is engine-defined SQL text in v1 (ADR 0029). */
export interface FilterSpec {
  column: string
  predicate: string
}

export interface ColumnSchema {
  name: string
  type: string
  nullable?: boolean
}

/**
 * The single contract between the grid model and any data backend
 * (local engine or, later, remote gateway). Row shape placeholder becomes
 * Arrow-backed in M1.
 */
export interface GridDataProvider {
  fetchRange(range: CellRange): Promise<unknown[][]>
  sort(spec: SortSpec): Promise<void>
  filter(spec: FilterSpec): Promise<void>
  updateCell(row: number, column: string, value: unknown): Promise<void>
  schema(): Promise<ColumnSchema[]>
}
