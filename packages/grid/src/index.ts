/**
 * @assay/grid — the owned headless grid model.
 *
 * The grid is a view, never the dataset (ADR 0003/0022). The model owns
 * viewport coordinates, selection, editing state, keyboard commands,
 * clipboard, and annotations; rendering stays replaceable behind it. The
 * grid requests only visible or nearby ranges and must never materialize
 * the full dataset in UI state (docs/architecture/02-architecture.md §8).
 *
 * M1-5: the placeholder `GridDataProvider` row shape became the explicit
 * structural `GridDataPage`, the provider gained `rowCount()` (totals are
 * metadata: virtualization needs a total; the engine serves it via a
 * metadata-only `count(*)`), and the package ships the viewport model
 * (`GridViewportModel`) — visible-range → windowed fetches, LRU window
 * cache with in-flight dedup, loading/error placeholder semantics, and
 * request counters that make the non-materialization guarantee observable.
 * `sort`/`filter`/`updateCell` remain part of the contract; wiring UI for
 * them is a later task. See `contracts.ts` for why the page type is a
 * structural value rather than an Arrow table.
 */
export type {
  CellRange,
  ColumnSchema,
  FilterSpec,
  GridDataPage,
  GridDataProvider,
  GridRowSlot,
  SortSpec,
} from './contracts'
export { GridViewportModel } from './viewport-model'
export type { GridViewportOptions, GridViewportStats } from './viewport-model'
