// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import type { FilterSpec, GridDataProvider } from '@assay/grid'
import type {
  EngineColumnSchema,
  EngineOverlay,
  EngineRangeWindow,
  EngineTableHandle,
} from '@assay/engine-duckdb'
import type { ArrowCellValue, ArrowTableLike, GridEngineClientSlice } from './grid-provider'
import { EngineGridProvider } from './grid-provider'

/**
 * C02c — the desktop provider's optional whole-list capability
 * (`GridDataProvider.replaceFilters`, C01 §5.1/§9.1 row 15, mirroring the web
 * row 12).
 *
 * The capability is one validated assignment before any state is read: order
 * is preserved verbatim (`filters` order is what the toolbar displays and what
 * the engine AND-composes), `[]` is the same internal empty state as
 * `filter(null)`, and a rejection leaves the previously accepted list in
 * effect — the model above it then reports `refused-before-change` instead of
 * guessing a rollback.
 */

const HANDLE: EngineTableHandle = { kind: 'table', id: 'table-1' }
const SCHEMA: readonly EngineColumnSchema[] = [
  { name: 'id', type: 'BIGINT' },
  { name: 'label', type: 'VARCHAR' },
]

type RecordedQuery = ReadonlyArray<{ column: string; predicate: string }> | undefined

interface RecordedWindow extends EngineRangeWindow {
  readonly filters: RecordedQuery
}

function fakeBatch(columns: ArrowCellValue[][]): ArrowTableLike {
  return {
    numRows: columns[0]?.length ?? 0,
    numCols: columns.length,
    getChildAt: (index: number) =>
      index >= 0 && index < columns.length
        ? { get: (row: number): ArrowCellValue => columns[index]?.[row] }
        : null,
  }
}

/** Records the base-route asks so the exact filters that travel are visible. */
function fakeClient(options: { readonly totalRows?: number } = {}): {
  client: GridEngineClientSlice
  windows: RecordedWindow[]
  rowCountOptions: RecordedQuery[]
} {
  const windows: RecordedWindow[] = []
  const rowCountOptions: RecordedQuery[] = []
  return {
    windows,
    rowCountOptions,
    client: {
      schema: () => Promise.resolve([...SCHEMA]),
      rowCount: (_handle, rowOptions) => {
        rowCountOptions.push(rowOptions?.filters)
        return Promise.resolve(options.totalRows ?? 2)
      },
      fetchRange: (_handle, window) => {
        windows.push({ ...window, filters: window.filters })
        return Promise.resolve({
          batch: fakeBatch([
            [10, 11],
            ['a', 'b'],
          ]),
          hasMore: false,
        })
      },
      // The base route (no overlay) must never consult the overlay methods.
      // Returning a rejected promise rather than throwing keeps the fake
      // structurally total; an accidental call fails the assertion loudly.
      overlaySchema: () => Promise.reject(new Error('unexpected overlaySchema call')),
      overlayCastCheck: () => Promise.reject(new Error('unexpected overlayCastCheck call')),
      overlayRowCount: () => Promise.reject(new Error('unexpected overlayRowCount call')),
      fetchOverlayRange: () => Promise.reject(new Error('unexpected fetchOverlayRange call')),
    },
  }
}

function baseProvider(client: GridEngineClientSlice): EngineGridProvider {
  return new EngineGridProvider(client, HANDLE)
}

/** One full read of the provider state (count + window) for comparison. */
async function readState(provider: GridDataProvider): Promise<void> {
  await provider.rowCount()
  await provider.fetchRange({ startRow: 0, endRow: 2, startCol: 0, endCol: 2 })
}

describe('EngineGridProvider.replaceFilters (C02c) — atomic whole-list capability', () => {
  const FIRST: FilterSpec = { column: 'country', predicate: "= 'US'" }
  const SECOND: FilterSpec = { column: 'income', predicate: '> 50000' }

  it('implements the optional capability and still supports the legacy filter path', () => {
    const { client } = fakeClient()
    const provider: GridDataProvider = baseProvider(client)
    expect(typeof provider.replaceFilters).toBe('function')
    expect(typeof provider.filter).toBe('function')
  })

  it('stores the list in exactly the given order and every later ask carries it', async () => {
    const { client, windows, rowCountOptions } = fakeClient()
    const provider = baseProvider(client)
    // Pushed in this order even though the columns sort differently: the
    // provider neither sorts nor de-duplicates (opaque predicate text).
    await provider.replaceFilters([SECOND, FIRST])
    await readState(provider)
    expect(rowCountOptions).toEqual([[SECOND, FIRST]])
    expect(windows[0]?.filters).toEqual([SECOND, FIRST])
  })

  it('does the engine work of one list change, not one per spec (no extra scans)', async () => {
    const { client, windows, rowCountOptions } = fakeClient()
    const provider = baseProvider(client)
    await provider.replaceFilters([FIRST, SECOND])
    // The capability itself touches no engine surface: the list is state, and
    // the model's single refresh is what re-reads totals/windows.
    expect({ windows, rowCountOptions }).toEqual({ windows: [], rowCountOptions: [] })
    await readState(provider)
    expect(rowCountOptions).toHaveLength(1)
    expect(windows).toHaveLength(1)
  })

  it('maps `replaceFilters([])` and `filter(null)` to the same engine asks', async () => {
    const legacy = fakeClient()
    const legacyProvider: GridDataProvider = baseProvider(legacy.client)
    await legacyProvider.filter(FIRST)
    await legacyProvider.filter(null)

    const atomic = fakeClient()
    const atomicProvider = baseProvider(atomic.client)
    await atomicProvider.replaceFilters([FIRST])
    await atomicProvider.replaceFilters([])

    for (const provider of [legacyProvider, atomicProvider]) await readState(provider)

    // Cleared state is "absent fields" on both paths: the same window shape
    // and the same count options — no `WHERE` for either.
    expect(atomic.windows).toEqual(legacy.windows)
    expect(atomic.rowCountOptions).toEqual(legacy.rowCountOptions)
    expect(atomic.windows).toEqual([{ startRow: 0, endRow: 2, filters: undefined }])
  })

  it('validates every spec before the one assignment (all-before-commit)', async () => {
    const { client, windows } = fakeClient()
    const provider = baseProvider(client)
    await provider.replaceFilters([FIRST])

    // Two ways a list can be malformed mid-way: the rejected list must never
    // be partially stored — the previously accepted list stays in effect.
    await expect(
      provider.replaceFilters([SECOND, { column: '', predicate: '> 1' }]),
    ).rejects.toBeInstanceOf(TypeError)
    await expect(
      provider.replaceFilters([SECOND, { column: 'income', predicate: 7 as unknown as string }]),
    ).rejects.toBeInstanceOf(TypeError)

    await provider.fetchRange({ startRow: 0, endRow: 2, startCol: 0, endCol: 2 })
    expect(windows[0]?.filters).toEqual([FIRST])
  })

  it('keeps a clear effective when a later malformed list is refused', async () => {
    const { client, windows } = fakeClient()
    const provider = baseProvider(client)
    await provider.replaceFilters([FIRST])
    await provider.replaceFilters([])
    await expect(
      provider.replaceFilters([{ column: 'id', predicate: 1 as unknown as string }]),
    ).rejects.toBeInstanceOf(TypeError)
    await provider.fetchRange({ startRow: 0, endRow: 2, startCol: 0, endCol: 2 })
    expect(windows[0]?.filters).toBeUndefined()
  })

  it('carries the list through the overlay route unchanged (same capability, same order)', async () => {
    const { client } = fakeClient()
    const overlay: EngineOverlay = {
      base: {
        baseAnchor: 'fv-1',
        overlayAnchor: 'ov-1',
        columns: [...SCHEMA],
        baseRowCount: 2,
      },
      ops: [],
    }
    const overlayCalls: RecordedQuery[] = []
    const overlayClient: GridEngineClientSlice = {
      ...client,
      overlayRowCount: (_handle, _overlay, rowOptions) => {
        overlayCalls.push(rowOptions?.filters)
        return Promise.resolve(2)
      },
    }
    const provider = new EngineGridProvider(overlayClient, HANDLE, overlay)
    expect(provider.editingEnabled).toBe(true)
    await provider.replaceFilters([SECOND, FIRST])
    await provider.rowCount()
    expect(overlayCalls).toEqual([[SECOND, FIRST]])
  })
})
