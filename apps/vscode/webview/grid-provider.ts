// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Adapter: `GridDataProvider` over the real `@assay/engine-duckdb` client for
 * the VS Code dataset webview. Composition-root glue, engine-aware by design
 * — the headless grid model stays engine-free (`@assay/grid` knows only the
 * provider contract, ADR 0022). The effective session overlay is installed
 * from the initial read, so both cell values and logical row identities are
 * engine-projected from the same immutable base version.
 *
 * Arrow never crosses this seam as a type: the engine window is projected to
 * row-major JS cells immediately — a bounded, small UI projection (visible
 * windows are ≤1000 rows after the engine's clamp), explicitly allowed by
 * ADR 0020. The structural `ArrowTableLike`/`ArrowVectorLike` shapes keep
 * `apache-arrow` out of this surface's dependency tree; the real engine
 * `Table` satisfies them.
 *
 * Row identity (ADR 0011): edited reads carry the engine's row-id column
 * through `fetchOverlayRange(includeRowIds: true)` and strip it only from
 * displayed cells. Sort/filter/window position never substitutes for logical
 * identity. The base fast path remains available to read-only spike callers.
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
  EngineOverlay,
  EngineOverlayWindow,
  EngineRangeWindow,
  EngineTableHandle,
} from '@assay/engine-duckdb'

/** Structural cell values Arrow exposes to this bounded grid projection. */
export type ArrowCellValue =
  string | number | bigint | boolean | null | undefined | Date | Uint8Array | object

/** The slice of an Arrow vector the projection needs. */
export interface ArrowVectorLike {
  get(index: number): ArrowCellValue
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
  overlaySchema(handle: EngineTableHandle, overlay: EngineOverlay): Promise<EngineColumnSchema[]>
  overlayCastCheck(
    handle: EngineTableHandle,
    overlay: EngineOverlay,
    check: { readonly column: string; readonly targetType: string },
  ): Promise<{ readonly hasNonConvertibleValues: boolean }>
  overlayRowCount(
    handle: EngineTableHandle,
    overlay: EngineOverlay,
    options?: { readonly filters?: readonly { column: string; predicate: string }[] },
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
  private overlay: EngineOverlay | null = null

  constructor(client: GridEngineClientSlice, handle: EngineTableHandle, overlay?: EngineOverlay) {
    this.client = client
    this.handle = handle
    this.anchor = handle.id
    this.overlay = overlay ?? null
  }

  /** Whether the production grid is using the logical-id overlay path. */
  get editingEnabled(): boolean {
    return this.overlay !== null
  }

  /** Install only a preflighted overlay; row identities always come from engine output. */
  setOverlay(overlay: EngineOverlay): void {
    this.overlay = overlay
  }

  /** Check schema and engine-side whole-view castability before publishing a candidate. */
  async preflight(overlay: EngineOverlay): Promise<void> {
    const schema = await this.client.overlaySchema(this.handle, overlay)
    for (const column of schema) {
      const cast = await this.client.overlayCastCheck(this.handle, overlay, {
        column: column.name,
        targetType: column.type,
      })
      if (cast.hasNonConvertibleValues) {
        throw new Error('The effective view contains values that cannot be represented safely.')
      }
    }
    const filters = this.filterPredicates.length > 0 ? this.filterPredicates : undefined
    const sort = this.sortKeys.length > 0 ? this.sortKeys : undefined
    const count = await this.client.overlayRowCount(
      this.handle,
      overlay,
      filters ? { filters } : undefined,
    )
    if (count > 0) {
      await this.client.fetchOverlayRange(this.handle, overlay, {
        startRow: 0,
        endRow: Math.min(count, 32),
        filters,
        sort,
        includeRowIds: true,
      })
    }
    if (schema.length === 0) throw new Error('The effective view has no columns.')
  }

  /** Test-mode parity assertion for the identity carried by an effective engine row. */
  async verifyRowId(
    overlay: EngineOverlay,
    rowIndex: number,
    expectedId: string,
  ): Promise<boolean> {
    const filters = this.filterPredicates.length > 0 ? this.filterPredicates : undefined
    const sort = this.sortKeys.length > 0 ? this.sortKeys : undefined
    const result = await this.client.fetchOverlayRange(this.handle, overlay, {
      startRow: rowIndex,
      endRow: rowIndex + 1,
      ...(filters === undefined ? {} : { filters }),
      ...(sort === undefined ? {} : { sort }),
      includeRowIds: true,
    })
    const row = projectBatchToRows(result.batch)[0]
    return row?.[0] === expectedId
  }

  /** Small synthetic-fixture probe used only by the extension test-mode assertion. */
  async verifyCellValue(
    overlay: EngineOverlay,
    rowId: string,
    columnIndex: number,
    expectedText: string,
  ): Promise<boolean> {
    const filters = this.filterPredicates.length > 0 ? this.filterPredicates : undefined
    const sort = this.sortKeys.length > 0 ? this.sortKeys : undefined
    const count = await this.client.overlayRowCount(
      this.handle,
      overlay,
      filters === undefined ? undefined : { filters },
    )
    if (count < 1 || count > 32) return false
    const result = await this.client.fetchOverlayRange(this.handle, overlay, {
      startRow: 0,
      endRow: count,
      ...(filters === undefined ? {} : { filters }),
      ...(sort === undefined ? {} : { sort }),
      includeRowIds: true,
    })
    return projectBatchToRows(result.batch).some(
      (row) => row[0] === rowId && String(row[columnIndex + 1]) === expectedText,
    )
  }

  /** DuckDB's DESCRIBE name/type strings pass through unchanged (m1-4). */
  async schema(): Promise<ColumnSchema[]> {
    const columns =
      this.overlay === null
        ? await this.client.schema(this.handle)
        : await this.client.overlaySchema(this.handle, this.overlay)
    return columns.map((column) => ({ name: column.name, type: column.type }))
  }

  /** Metadata-only effective count, narrowed by active filters. */
  async rowCount(): Promise<number> {
    const options =
      this.filterPredicates.length > 0 ? { filters: this.filterPredicates } : undefined
    return this.overlay === null
      ? this.client.rowCount(this.handle, options)
      : this.client.overlayRowCount(this.handle, this.overlay, options)
  }

  async fetchRange(range: CellRange): Promise<GridDataPage> {
    const filters = this.filterPredicates.length > 0 ? this.filterPredicates : undefined
    const sort = this.sortKeys.length > 0 ? this.sortKeys : undefined
    const result =
      this.overlay === null
        ? await this.client.fetchRange(this.handle, {
            startRow: range.startRow,
            endRow: range.endRow,
            ...(filters === undefined ? {} : { filters }),
            ...(sort === undefined ? {} : { sort }),
          })
        : await this.client.fetchOverlayRange(this.handle, this.overlay, {
            startRow: range.startRow,
            endRow: range.endRow,
            ...(filters === undefined ? {} : { filters }),
            ...(sort === undefined ? {} : { sort }),
            includeRowIds: true,
          })
    const projected = projectBatchToRows(result.batch)
    const rows = this.overlay === null ? projected : projected.map((row) => row.slice(1))
    if (rows.length !== range.endRow - range.startRow) {
      throw new Error(
        `engine window size mismatch: requested ${String(range.endRow - range.startRow)} rows, got ${String(rows.length)}`,
      )
    }
    const rowKeys =
      this.overlay === null
        ? rows.map((_, offset) => baseRowId(this.anchor, range.startRow + offset))
        : projected.map((row) => {
            const key = row[0]
            if (typeof key !== 'string')
              throw new Error('engine returned an invalid logical row id')
            return key
          })
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

  /**
   * C02c — replace the whole ordered filter list in **one transaction**
   * (`[]` clears, exactly like `filter(null)`).
   *
   * All-before-commit: every spec is shape-checked into a local array first,
   * and only a fully valid list is assigned, so a rejection leaves the
   * previously accepted list in effect and observable (no partial state) —
   * the same promise `sort`/`filter` make per call, but for the whole list at
   * once. Shape is the *only* thing inspected: `predicate` stays opaque
   * engine text, and the list keeps exactly the given order — no parsing,
   * normalizing, sorting or de-duplication, because that order is what the UI
   * displays and what the engine AND-composes into `WHERE`. The rejection is
   * this adapter's own `TypeError`; it carries no phase, because the model
   * classifies the outcome (`FilterApplyError.phase`, C01 §5.1/§10).
   *
   * The capability is webview-local state only: it adds no host-bridge
   * message, no engine op and no extra scan (the model's single `refresh()`
   * is what re-reads totals/windows). `filter(null)` and `replaceFilters([])`
   * both leave `filterPredicates` empty, so the engine request bytes are
   * unchanged.
   */
  async replaceFilters(specs: readonly FilterSpec[]): Promise<void> {
    if (!Array.isArray(specs)) {
      throw new TypeError(`filters must be an array, got ${typeof specs}`)
    }
    const next: { column: string; predicate: string }[] = []
    for (const spec of specs) {
      if (typeof spec?.column !== 'string' || spec.column.length === 0) {
        throw new TypeError('filter spec must name a column')
      }
      if (typeof spec.predicate !== 'string') {
        throw new TypeError('filter spec predicate must be a string')
      }
      next.push({ column: spec.column, predicate: spec.predicate })
    }
    this.filterPredicates = next
  }
}
