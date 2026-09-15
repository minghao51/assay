import { describe, expect, it } from 'vitest'
import type { CellRange, ColumnSchema, GridDataProvider } from '@assay/grid'
import type { EngineColumnSchema, EngineTableHandle } from '@assay/engine-duckdb'
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

interface FakeClientOptions {
  schemaColumns?: EngineColumnSchema[]
  totalRows?: number
  batch?: ArrowTableLike
}

/** Records the windows it receives so tests can assert the exact asks. */
function fakeClient(options: FakeClientOptions = {}): {
  client: GridEngineClient
  windows: Array<{ startRow: number; endRow: number }>
} {
  const windows: Array<{ startRow: number; endRow: number }> = []
  return {
    windows,
    client: {
      schema: () =>
        Promise.resolve(
          options.schemaColumns ?? [
            { name: 'id', type: 'BIGINT' },
            { name: 'label', type: 'VARCHAR' },
          ],
        ),
      rowCount: () => Promise.resolve(options.totalRows ?? 2),
      fetchRange: (_handle, window) => {
        windows.push({ startRow: window.startRow, endRow: window.endRow })
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

  it('sort/filter/updateCell are loud contract placeholders (not wired in M1)', async () => {
    const { client } = fakeClient()
    // Through the contract type: proves the adapter satisfies the full
    // GridDataProvider surface, placeholders included.
    const provider: GridDataProvider = new DuckDbGridProvider(client, handle)
    await expect(provider.sort({ column: 'id', direction: 'asc' })).rejects.toThrow(
      /not wired to the engine yet/,
    )
    await expect(provider.filter({ column: 'id', predicate: 'x' })).rejects.toThrow(
      /not wired to the engine yet/,
    )
    await expect(provider.updateCell(0, 'id', 1)).rejects.toThrow(/not wired to the engine yet/)
  })
})
