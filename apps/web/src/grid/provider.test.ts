import { describe, expect, it } from 'vitest'
import type { CellRange, ColumnSchema, FilterSpec, GridDataProvider } from '@assay/grid'
import type {
  DuckDbEngineClient,
  EngineColumnSchema,
  EngineTableHandle,
} from '@assay/engine-duckdb'
import { DuckDbGridProvider, projectBatchToRows } from './provider'
import type { ArrowTableLike, GridEngineClient } from './provider'

const handle: EngineTableHandle = { kind: 'table', id: 't1' }

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
}

interface FakeClientOptions {
  schemaColumns?: EngineColumnSchema[]
  totalRows?: number
  batch?: ArrowTableLike
}

/**
 * Records the windows and rowCount options it receives so tests can assert
 * the exact asks — including the m2-3 query state (filters/sort must travel
 * field-for-field; absent/empty = cleared).
 */
function fakeClient(options: FakeClientOptions = {}): {
  client: GridEngineClient
  windows: RecordedWindow[]
  rowCountOptions: Array<ReadonlyArray<{ column: string; predicate: string }> | undefined>
} {
  const windows: RecordedWindow[] = []
  const rowCountOptions: Array<ReadonlyArray<{ column: string; predicate: string }> | undefined> =
    []
  return {
    windows,
    rowCountOptions,
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
        windows.push({
          startRow: window.startRow,
          endRow: window.endRow,
          filters: window.filters,
          sort: window.sort,
        })
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
    },
  }
}

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

describe('DuckDbGridProvider — the GridDataProvider seam over the engine client', () => {
  it('schema() passes engine name/type pairs through unchanged', async () => {
    const { client } = fakeClient({
      schemaColumns: [
        { name: 'id', type: 'BIGINT' },
        { name: 'payload', type: 'STRUCT("name" VARCHAR)' },
      ],
    })
    const provider = new DuckDbGridProvider(client, handle)
    const schema: ColumnSchema[] = await provider.schema()
    expect(schema).toEqual([
      { name: 'id', type: 'BIGINT' },
      { name: 'payload', type: 'STRUCT("name" VARCHAR)' },
    ])
  })

  it('rowCount() resolves the metadata-only total', async () => {
    const { client } = fakeClient({ totalRows: 1_000_000 })
    const provider = new DuckDbGridProvider(client, handle)
    await expect(provider.rowCount()).resolves.toBe(1_000_000)
  })

  it('fetchRange() sends the exact row window (full projection) and returns an honest page', async () => {
    const { client, windows } = fakeClient()
    const provider = new DuckDbGridProvider(client, handle)
    const range: CellRange = { startRow: 5, endRow: 7, startCol: 0, endCol: 2 }
    const page = await provider.fetchRange(range)

    expect(windows).toEqual([{ startRow: 5, endRow: 7 }])
    expect(page).toEqual({
      startRow: 5, // page origin echoes the requested window start
      rows: [
        [10, 'a'],
        [11, 'b'],
      ],
    })
  })

  it('fetchRange() rejects when the engine batch is missing a column vector', async () => {
    const brokenBatch: ArrowTableLike = {
      numRows: 2,
      numCols: 2,
      getChildAt: (index: number) => (index === 0 ? { get: () => 1 } : null),
    }
    const { client } = fakeClient({ batch: brokenBatch })
    const provider = new DuckDbGridProvider(client, handle)
    await expect(
      provider.fetchRange({ startRow: 0, endRow: 2, startCol: 0, endCol: 2 }),
    ).rejects.toThrow('missing column 1')
  })

  it('updateCell remains a loud contract placeholder (edit overlay is a later task)', async () => {
    const { client } = fakeClient()
    // Through the contract type: proves the adapter satisfies the full
    // GridDataProvider surface, the placeholder included.
    const provider: GridDataProvider = new DuckDbGridProvider(client, handle)
    await expect(provider.updateCell(0, 'id', 1)).rejects.toThrow(/not wired to the engine yet/)
  })
})

describe('DuckDbGridProvider query state (m2-3) — sort/filter carried into every ask', () => {
  it('sort(spec) carries a field-for-field sort key into subsequent fetchRange windows', async () => {
    const { client, windows } = fakeClient()
    const provider: GridDataProvider = new DuckDbGridProvider(client, handle)
    await provider.sort({ column: 'income', direction: 'desc' })
    await provider.fetchRange({ startRow: 0, endRow: 2, startCol: 0, endCol: 2 })
    expect(windows).toEqual([
      {
        startRow: 0,
        endRow: 2,
        filters: undefined,
        sort: [{ column: 'income', direction: 'desc' }],
      },
    ])
  })

  it('sort(null) clears — subsequent windows carry no sort key (absent, not empty)', async () => {
    const { client, windows } = fakeClient()
    const provider: GridDataProvider = new DuckDbGridProvider(client, handle)
    await provider.sort({ column: 'id', direction: 'asc' })
    await provider.sort(null)
    await provider.fetchRange({ startRow: 0, endRow: 2, startCol: 0, endCol: 2 })
    expect(windows[0]?.sort).toBeUndefined()
    expect(windows[0]?.filters).toBeUndefined()
  })

  it('filter(spec) pushes ordered predicates; every later fetchRange carries them in order', async () => {
    const { client, windows } = fakeClient()
    const provider: GridDataProvider = new DuckDbGridProvider(client, handle)
    const first: FilterSpec = { column: 'country', predicate: "= 'US'" }
    const second: FilterSpec = { column: 'income', predicate: '> 50000' }
    await provider.filter(first)
    await provider.filter(second)
    await provider.fetchRange({ startRow: 0, endRow: 2, startCol: 0, endCol: 2 })
    expect(windows[0]?.filters).toEqual([first, second])
  })

  it('filter(null) clears the whole list (the model’s clear-first protocol resolves to absent fields)', async () => {
    const { client, windows } = fakeClient()
    const provider: GridDataProvider = new DuckDbGridProvider(client, handle)
    await provider.filter({ column: 'country', predicate: "= 'US'" })
    await provider.filter(null)
    await provider.fetchRange({ startRow: 0, endRow: 2, startCol: 0, endCol: 2 })
    expect(windows[0]?.filters).toBeUndefined()
  })

  it('rowCount carries the active filters so totals reflect them', async () => {
    const { client, rowCountOptions } = fakeClient({ totalRows: 3 })
    const provider: GridDataProvider = new DuckDbGridProvider(client, handle)
    // Unfiltered: no filters field at all (metadata count, pre-m2-2 shape).
    await expect(provider.rowCount()).resolves.toBe(3)
    expect(rowCountOptions[0]).toBeUndefined()
    const spec: FilterSpec = { column: 'income', predicate: '> 50000' }
    await provider.filter(spec)
    await expect(provider.rowCount()).resolves.toBe(3)
    expect(rowCountOptions[1]).toEqual([spec])
  })

  it('a cleared filter list also clears the rowCount narrowing', async () => {
    const { client, rowCountOptions } = fakeClient()
    const provider: GridDataProvider = new DuckDbGridProvider(client, handle)
    await provider.filter({ column: 'income', predicate: '> 50000' })
    await provider.filter(null)
    await provider.rowCount()
    expect(rowCountOptions[1]).toBeUndefined()
  })

  it('sort and filter compose: one window carries both (filter + sort combined)', async () => {
    const { client, windows } = fakeClient()
    const provider: GridDataProvider = new DuckDbGridProvider(client, handle)
    await provider.filter({ column: 'country', predicate: "= 'US'" })
    await provider.sort({ column: 'income', direction: 'desc' })
    await provider.fetchRange({ startRow: 0, endRow: 2, startCol: 0, endCol: 2 })
    expect(windows[0]).toEqual({
      startRow: 0,
      endRow: 2,
      filters: [{ column: 'country', predicate: "= 'US'" }],
      sort: [{ column: 'income', direction: 'desc' }],
    })
  })
})
