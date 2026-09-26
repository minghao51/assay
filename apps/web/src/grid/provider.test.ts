// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import type { CellRange, ColumnSchema, FilterSpec, GridDataProvider } from '@assay/grid'
import type { OverlayBase } from '@assay/domain'
import { baseRowId, insertRowId } from '@assay/domain'
import type {
  DuckDbEngineClient,
  EngineColumnSchema,
  EngineOverlay,
  EngineOverlayWindow,
  EngineRangeWindow,
  EngineTableHandle,
} from '@assay/engine-duckdb'
import { DuckDbGridProvider, projectBatchToRows, projectOverlayPage } from './provider'
import type { ArrowTableLike, GridEngineClient, OverlaySource } from './provider'

const handle: EngineTableHandle = { kind: 'table', id: 't1' }

/** The immutable base metadata the app builds once a file opens. */
const BASE: OverlayBase = {
  baseAnchor: 'fv-5-1000',
  overlayAnchor: 'ov-1',
  columns: [
    { name: 'id', type: 'BIGINT' },
    { name: 'label', type: 'VARCHAR' },
  ],
  baseRowCount: 2,
}

/** Minimal columnar batch double satisfying the adapter's Arrow-like shape. */
function fakeBatch(columns: unknown[][]): ArrowTableLike {
  return {
    numRows: columns[0]?.length ?? 0,
    numCols: columns.length,
    getChildAt: (index: number) =>
      index >= 0 && index < columns.length ? { get: (row: number) => columns[index]?.[row] } : null,
  }
}

interface RecordedWindow {
  startRow: number
  endRow: number
  filters: ReadonlyArray<{ column: string; predicate: string }> | undefined
  sort: ReadonlyArray<{ column: string; direction: 'asc' | 'desc' }> | undefined
  includeRowIds: boolean | undefined
}

interface FakeClientOptions {
  schemaColumns?: EngineColumnSchema[]
  totalRows?: number
  batch?: ArrowTableLike
  overlayBatch?: ArrowTableLike
}

/**
 * Records the windows and rowCount options it receives so tests can assert
 * the exact asks — the m2-3 query state (filters/sort must travel
 * field-for-field) and the m4-3 route (base vs. overlay path).
 */
function fakeClient(options: FakeClientOptions = {}): {
  client: GridEngineClient
  windows: RecordedWindow[]
  baseWindows: EngineRangeWindow[]
  rowCountOptions: Array<ReadonlyArray<{ column: string; predicate: string }> | undefined>
  overlayRowCountOptions: Array<ReadonlyArray<{ column: string; predicate: string }> | undefined>
  overlaySchemas: EngineOverlay[]
} {
  const windows: RecordedWindow[] = []
  const baseWindows: EngineRangeWindow[] = []
  const rowCountOptions: Array<ReadonlyArray<{ column: string; predicate: string }> | undefined> =
    []
  const overlayRowCountOptions: Array<
    ReadonlyArray<{ column: string; predicate: string }> | undefined
  > = []
  const overlaySchemas: EngineOverlay[] = []
  return {
    windows,
    baseWindows,
    rowCountOptions,
    overlayRowCountOptions,
    overlaySchemas,
    client: {
      schema: () =>
        Promise.resolve(
          options.schemaColumns ?? [
            { name: 'id', type: 'BIGINT' },
            { name: 'label', type: 'VARCHAR' },
          ],
        ),
      rowCount: (_handle, rowCountOptions_) => {
        rowCountOptions.push(rowCountOptions_?.filters)
        return Promise.resolve(options.totalRows ?? 2)
      },
      fetchRange: (_handle, window) => {
        baseWindows.push(window)
        return Promise.resolve({
          batch:
            options.batch ??
            fakeBatch([
              [10, 11],
              ['a', 'b'],
            ]),
          hasMore: false,
        })
      },
      overlaySchema: (_handle, overlay) => {
        overlaySchemas.push(overlay)
        return Promise.resolve(
          options.schemaColumns ?? [
            { name: 'id', type: 'BIGINT' },
            { name: 'label', type: 'VARCHAR' },
          ],
        )
      },
      overlayRowCount: (_handle, _overlay, rowCountOptions_) => {
        overlayRowCountOptions.push(rowCountOptions_?.filters)
        return Promise.resolve(options.totalRows ?? 2)
      },
      fetchOverlayRange: (_handle, _overlay, window: EngineOverlayWindow) => {
        windows.push({
          startRow: window.startRow,
          endRow: window.endRow,
          filters: window.filters,
          sort: window.sort,
          includeRowIds: window.includeRowIds,
        })
        return Promise.resolve({
          batch:
            options.overlayBatch ??
            fakeBatch([
              [baseRowId(BASE.baseAnchor, 0), baseRowId(BASE.baseAnchor, 1)],
              [10, 11],
              ['a', 'b'],
            ]),
          hasMore: false,
        })
      },
    },
  }
}

/** A provider whose overlay has one op, forcing the composed read path. */
const withEditSource: OverlaySource = () => ({
  base: BASE,
  ops: [
    {
      kind: 'cell-set',
      rowId: baseRowId(BASE.baseAnchor, 0),
      column: 'label',
      value: { kind: 'string', value: 'edited' },
    },
  ],
})
const emptySource: OverlaySource = () => ({ base: BASE, ops: [] })

// Compile-time canary: the real engine client must keep satisfying the
// adapter's structural slice — the app hands `engineClient` straight to the
// provider (composition root). Purely type-level; compiles away.
type EngineClientSatisfiesSlice = DuckDbEngineClient extends GridEngineClient ? true : never
const engineClientSatisfiesSlice: EngineClientSatisfiesSlice = true
void engineClientSatisfiesSlice

describe('projectBatchToRows (Arrow columnar → row cells, ADR 0020 small projection)', () => {
  it('projects columnar vectors into row-major cells', () => {
    const rows = projectBatchToRows(
      fakeBatch([
        [1, 2, 3],
        ['x', null, 'z'],
        [true, false, true],
      ]),
    )
    expect(rows).toEqual([
      [1, 'x', true],
      [2, null, false],
      [3, 'z', true],
    ])
  })

  it('handles empty batches (0 rows, 0 columns)', () => {
    expect(projectBatchToRows(fakeBatch([]))).toEqual([])
    expect(projectBatchToRows(fakeBatch([[]]))).toEqual([])
  })
})

describe('projectOverlayPage (assay_row_id stripping, m4-3)', () => {
  it('strips the leading id column into the opaque key channel', () => {
    const page = projectOverlayPage(
      fakeBatch([
        ['ins:ov-1#0', baseRowId(BASE.baseAnchor, 3)],
        [7, 8],
        ['x', 'y'],
      ]),
    )
    expect(page.rows).toEqual([
      [7, 'x'],
      [8, 'y'],
    ])
    expect(page.rowKeys).toEqual(['ins:ov-1#0', baseRowId(BASE.baseAnchor, 3)])
  })

  it('throws on a non-string id rather than guessing a position', () => {
    expect(() =>
      projectOverlayPage(
        fakeBatch([
          [1, 2],
          ['x', 'y'],
        ]),
      ),
    ).toThrow('non-string row id')
  })

  it('throws when the id column is absent', () => {
    expect(() => projectOverlayPage(fakeBatch([]))).toThrow('missing the row-id column')
  })
})

describe('DuckDbGridProvider — fast base path (empty overlay, no query state)', () => {
  it('schema() passes engine name/type pairs through unchanged via the base method', async () => {
    const { client, overlaySchemas } = fakeClient({
      schemaColumns: [
        { name: 'id', type: 'BIGINT' },
        { name: 'payload', type: 'STRUCT("name" VARCHAR)' },
      ],
    })
    const provider = new DuckDbGridProvider(client, handle, emptySource)
    const schema: ColumnSchema[] = await provider.schema()
    expect(schema).toEqual([
      { name: 'id', type: 'BIGINT' },
      { name: 'payload', type: 'STRUCT("name" VARCHAR)' },
    ])
    expect(overlaySchemas).toEqual([]) // base path chosen
  })

  it('rowCount() resolves the metadata-only total without an overlay ask', async () => {
    const { client, rowCountOptions, overlayRowCountOptions } = fakeClient({ totalRows: 1_000_000 })
    const provider = new DuckDbGridProvider(client, handle, emptySource)
    await expect(provider.rowCount()).resolves.toBe(1_000_000)
    expect(rowCountOptions).toEqual([undefined])
    expect(overlayRowCountOptions).toEqual([])
  })

  it('fetchRange() uses the base window and synthesizes natural-order row ids', async () => {
    const { client, baseWindows, windows } = fakeClient()
    const provider = new DuckDbGridProvider(client, handle, emptySource)
    const range: CellRange = { startRow: 5, endRow: 7, startCol: 0, endCol: 2 }
    const page = await provider.fetchRange(range)

    expect(baseWindows).toEqual([{ startRow: 5, endRow: 7 }])
    expect(windows).toEqual([]) // no overlay ask
    expect(page).toEqual({
      startRow: 5,
      rows: [
        [10, 'a'],
        [11, 'b'],
      ],
      rowKeys: [baseRowId(BASE.baseAnchor, 5), baseRowId(BASE.baseAnchor, 6)],
    })
  })

  it('rejects when the engine batch is missing a column vector', async () => {
    const brokenBatch: ArrowTableLike = {
      numRows: 2,
      numCols: 2,
      getChildAt: (index: number) => (index === 0 ? { get: () => 1 } : null),
    }
    const { client } = fakeClient({ batch: brokenBatch })
    const provider = new DuckDbGridProvider(client, handle, emptySource)
    await expect(
      provider.fetchRange({ startRow: 0, endRow: 2, startCol: 0, endCol: 2 }),
    ).rejects.toThrow('missing column 1')
  })
})

describe('DuckDbGridProvider — overlay path (ops present, m4-3)', () => {
  it('routes schema/rowCount/fetch through the overlay surface with the active ops', async () => {
    const { client, windows, overlaySchemas } = fakeClient()
    const provider: GridDataProvider = new DuckDbGridProvider(client, handle, withEditSource)
    await provider.schema()
    expect(overlaySchemas).toHaveLength(1)
    expect(overlaySchemas[0]?.ops).toHaveLength(1)
    expect(overlaySchemas[0]?.base).toEqual(BASE)

    const page = await provider.fetchRange({ startRow: 0, endRow: 2, startCol: 0, endCol: 2 })
    expect(windows).toEqual([
      {
        startRow: 0,
        endRow: 2,
        filters: undefined,
        sort: undefined,
        includeRowIds: true,
      },
    ])
    expect(page.rowKeys).toEqual([baseRowId(BASE.baseAnchor, 0), baseRowId(BASE.baseAnchor, 1)])
    expect(page.rows).toEqual([
      [10, 'a'],
      [11, 'b'],
    ])
  })

  it('keeps inserted-row ids from the engine on the key channel', async () => {
    const { client } = fakeClient({
      overlayBatch: fakeBatch([
        [insertRowId(BASE.overlayAnchor, 0), baseRowId(BASE.baseAnchor, 0)],
        [null, 10],
        ['new', 'a'],
      ]),
    })
    const provider = new DuckDbGridProvider(client, handle, withEditSource)
    const page = await provider.fetchRange({ startRow: 0, endRow: 2, startCol: 0, endCol: 2 })
    expect(page.rowKeys).toEqual([
      insertRowId(BASE.overlayAnchor, 0),
      baseRowId(BASE.baseAnchor, 0),
    ])
  })
})

describe('DuckDbGridProvider query state (m2-3) — sort/filter carried into every ask', () => {
  it('sort(spec) forces the overlay path and carries a field-for-field sort key', async () => {
    const { client, windows } = fakeClient()
    const provider: GridDataProvider = new DuckDbGridProvider(client, handle, emptySource)
    await provider.sort({ column: 'income', direction: 'desc' })
    await provider.fetchRange({ startRow: 0, endRow: 2, startCol: 0, endCol: 2 })
    expect(windows).toEqual([
      {
        startRow: 0,
        endRow: 2,
        filters: undefined,
        sort: [{ column: 'income', direction: 'desc' }],
        includeRowIds: true,
      },
    ])
  })

  it('sort(null) clears — the base path returns and carries no sort key', async () => {
    const { client, baseWindows, windows } = fakeClient()
    const provider: GridDataProvider = new DuckDbGridProvider(client, handle, emptySource)
    await provider.sort({ column: 'id', direction: 'asc' })
    await provider.sort(null)
    await provider.fetchRange({ startRow: 0, endRow: 2, startCol: 0, endCol: 2 })
    expect(windows).toEqual([])
    expect(baseWindows).toEqual([{ startRow: 0, endRow: 2 }])
  })

  it('filter(spec) pushes ordered predicates; every later fetch carries them in order', async () => {
    const { client, windows } = fakeClient()
    const provider: GridDataProvider = new DuckDbGridProvider(client, handle, emptySource)
    const first: FilterSpec = { column: 'country', predicate: "= 'US'" }
    const second: FilterSpec = { column: 'income', predicate: '> 50000' }
    await provider.filter(first)
    await provider.filter(second)
    await provider.fetchRange({ startRow: 0, endRow: 2, startCol: 0, endCol: 2 })
    expect(windows[0]?.filters).toEqual([first, second])
  })

  it('filter(null) clears the whole list (the model’s clear-first protocol resolves to the base path)', async () => {
    const { client, baseWindows, windows } = fakeClient()
    const provider: GridDataProvider = new DuckDbGridProvider(client, handle, emptySource)
    await provider.filter({ column: 'country', predicate: "= 'US'" })
    await provider.filter(null)
    await provider.fetchRange({ startRow: 0, endRow: 2, startCol: 0, endCol: 2 })
    expect(windows).toEqual([])
    expect(baseWindows).toEqual([{ startRow: 0, endRow: 2 }])
  })

  it('rowCount carries the active filters so totals reflect them', async () => {
    const { client, rowCountOptions, overlayRowCountOptions } = fakeClient({ totalRows: 3 })
    const provider: GridDataProvider = new DuckDbGridProvider(client, handle, emptySource)
    // Unfiltered: base metadata count.
    await expect(provider.rowCount()).resolves.toBe(3)
    expect(rowCountOptions[0]).toBeUndefined()
    const spec: FilterSpec = { column: 'income', predicate: '> 50000' }
    await provider.filter(spec)
    // Filtered with an empty overlay: the overlay path handles effective-
    // column predicates and reports the narrowed total.
    await expect(provider.rowCount()).resolves.toBe(3)
    expect(overlayRowCountOptions).toEqual([[spec]])
  })

  it('sort and filter compose: one window carries both (filter + sort combined)', async () => {
    const { client, windows } = fakeClient()
    const provider: GridDataProvider = new DuckDbGridProvider(client, handle, emptySource)
    await provider.filter({ column: 'country', predicate: "= 'US'" })
    await provider.sort({ column: 'income', direction: 'desc' })
    await provider.fetchRange({ startRow: 0, endRow: 2, startCol: 0, endCol: 2 })
    expect(windows[0]).toEqual({
      startRow: 0,
      endRow: 2,
      filters: [{ column: 'country', predicate: "= 'US'" }],
      sort: [{ column: 'income', direction: 'desc' }],
      includeRowIds: true,
    })
  })
})
