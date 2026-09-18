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
 * m2-1: `sort`/`filter` became real provider state (the `null`-clear
 * protocol) with epoch-rebuild semantics in the model (`setSort`/
 * `setFilters` + the `sort`/`filters` getters); m2-3 wires them to the
 * engine through the web provider and the column-header/filter UI.
 * m4-3: the page gained an optional opaque `rowKeys` identity channel and
 * ready slots expose `key` — how the host addresses edits by logical row id
 * (ADR 0011/0012) instead of viewport position; the positional `updateCell`
 * stub was removed (see `contracts.ts` for the ruling). In-flight spans are
 * epoch-tagged so a late old-epoch completion cannot delete a newer
 * epoch's dedup marker. See `contracts.ts` for why the page type is a
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
