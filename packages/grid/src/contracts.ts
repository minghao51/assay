/**
 * @assay/grid — public contracts.
 *
 * The grid is a view, never the dataset (ADR 0003/0022). It communicates with
 * any data backend through `GridDataProvider` and must never materialize the
 * full dataset in UI state (docs/architecture/02-architecture.md §8): the
 * provider serves schema, the total row count, and visible-window sized row
 * pages — nothing more.
 *
 * Contract shape (M1-5 ruling): `fetchRange` returns a **neutral structural
 * page** (`GridDataPage`), not an Arrow table. Rationale:
 *
 * - Zero dependencies, in both senses: the grid package has no runtime
 *   dependency on `apache-arrow` — not even a type-only one, which would pin
 *   Arrow's types (the engine pins 17.0.0) into this package's API surface.
 * - The model needs row-shaped cells for placeholders and DOM projection, so
 *   an Arrow return value would be projected to rows immediately anyway.
 *   Per ADR 0020, "small UI projections may still become ordinary JS
 *   values" — visible windows are bounded (the engine clamps them at ≤1000
 *   rows), so the projection happens once, at the boundary where Arrow is
 *   real: in the host adapter (e.g. `apps/web` over the engine client).
 * - The model stays Node-testable against plain arrays.
 *
 * A future renderer that wants columnar access can grow an Arrow-aware path
 * without breaking this contract (renderers are replaceable, ADR 0022).
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
 * One materialized page of rows: `rows[i]` holds the cells of grid row
 * `startRow + i`, in schema column order. Pages are small by construction —
 * sized to a viewport plus overscan, never the dataset.
 */
export interface GridDataPage {
  /** Grid row index of `rows[0]` (an echo of the requested `CellRange.startRow`). */
  readonly startRow: number
  /** One entry per requested row; each entry holds that row's cells. */
  readonly rows: readonly (readonly unknown[])[]
}

/**
 * The single contract between the grid model and any data backend
 * (local engine or, later, remote gateway). The M1 placeholder return shape
 * (`unknown[][]`) became the explicit `GridDataPage` once the first real
 * consumer (m1-5) needed the page origin to place rows honestly.
 */
/**
 * Renderer-facing state of one grid row. `loading` covers uncached, in-flight
 * and not-yet-requested rows (placeholders); `error` carries the provider's
 * message for failed spans (and out-of-range indices).
 */
export type GridRowSlot =
  | { readonly status: 'ready'; readonly row: readonly unknown[] }
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }

export interface GridDataProvider {
  /** Total number of rows in the dataset (metadata, not data). */
  rowCount(): Promise<number>
  fetchRange(range: CellRange): Promise<GridDataPage>
  sort(spec: SortSpec): Promise<void>
  filter(spec: FilterSpec): Promise<void>
  updateCell(row: number, column: string, value: unknown): Promise<void>
  schema(): Promise<ColumnSchema[]>
}
