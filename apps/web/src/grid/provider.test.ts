// SPDX-License-Identifier: AGPL-3.0-or-later

import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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
import type {
  ArrowChunkLike,
  ArrowVectorLike,
  ArrowTableLike,
  GridEngineClient,
  OverlaySource,
} from './provider'

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

/**
 * R2 loads the REAL `apache-arrow` build the engine ships (17.0.0, resolved
 * through `@assay/engine-duckdb` — the exact vector semantics the web grid
 * consumes) so the probe's reproducer is pinned as a unit test: Arrow's own
 * accessor throws on the DuckDB infinity sentinels, and the projection guard
 * must not. `apache-arrow` is deliberately NOT a dependency of this app
 * (provider.ts); `createRequire` borrows the engine's copy without adding
 * one. Scoped to the R2 block so an unexpected layout change cannot break
 * the other describes' imports.
 */
interface ArrowTimestampTypeCtor {
  new (): unknown
}

/** Structural slice of the `apache-arrow` module surface the R2 tests use. */
interface ArrowModuleLike {
  TimestampSecond: ArrowTimestampTypeCtor
  TimestampMillisecond: ArrowTimestampTypeCtor
  TimestampMicrosecond: ArrowTimestampTypeCtor
  TimestampNanosecond: ArrowTimestampTypeCtor
  Data: new (
    type: unknown,
    offset: number,
    length: number,
    nullCount: number,
    buffers: unknown[],
  ) => ArrowChunkLike
  makeVector: (data: ArrowChunkLike) => ArrowVectorLike
}

let arrowModule: ArrowModuleLike | undefined
function loadArrow(): ArrowModuleLike {
  if (arrowModule === undefined) {
    const enginePackageJson = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../../packages/engine-duckdb/package.json',
    )
    arrowModule = createRequire(enginePackageJson)('apache-arrow') as ArrowModuleLike
  }
  return arrowModule
}

/** DuckDB's TIMESTAMP sentinels as the real engine delivers them: ±(int64 max). */
const INF_BITS = 9223372036854775807n
const NEG_BITS = -9223372036854775807n
/** The reserved int64 minimum is diverted to the same text defensively. */
const RESERVED_MIN_BITS = -9223372036854775808n

/** A real Arrow timestamp vector over a raw BigInt64Array (no nulls). */
function timestampVector(unit: ArrowTimestampTypeCtor, values: bigint[]): ArrowVectorLike {
  const arrow = loadArrow()
  return arrow.makeVector(
    new arrow.Data(new unit(), 0, values.length, 0, [null, BigInt64Array.from(values), null]),
  )
}

/**
 * A real Arrow timestamp vector with a NULL at `nullIndex` (validity bitmap
 * `…101`, backing bits 0 in the hole).
 */
function timestampVectorWithNull(
  unit: ArrowTimestampTypeCtor,
  values: bigint[],
  nullIndices: number[],
): ArrowVectorLike {
  const arrow = loadArrow()
  const bitmap = new Uint8Array(Math.ceil(values.length / 8))
  for (let index = 0; index < values.length; index++) {
    if (!nullIndices.includes(index)) {
      bitmap[Math.floor(index / 8)]! |= 1 << (index % 8)
    }
  }
  return arrow.makeVector(
    new arrow.Data(new unit(), 0, values.length, nullIndices.length, [
      undefined,
      BigInt64Array.from(values),
      bitmap,
    ]),
  )
}

describe('R2 projection-boundary guard (D6): DuckDB ±infinity timestamps', () => {
  it('maps the sentinels to their text instead of throwing, for all three throwing units (real Arrow vectors)', () => {
    const arrow = loadArrow()
    // The probe's reproducer: `get()` throws on the sentinel for
    // SECOND/MILLISECOND (raw int64 to bigIntToNumber) and MICROSECOND
    // (÷1000 first) — while the backing BigInt64Array stays exact. The
    // delivered sentinel pair is ±(int64 max): DuckDB reserves the bare
    // int64 minimum as an internal marker, so `TIMESTAMP '-infinity'`
    // arrives as -9223372036854775807 (pinned by the fixture e2e); the
    // reserved minimum is diverted to the same text defensively.
    for (const unit of [
      arrow.TimestampSecond,
      arrow.TimestampMillisecond,
      arrow.TimestampMicrosecond,
    ]) {
      const vector = timestampVector(unit, [INF_BITS, 0n, NEG_BITS, RESERVED_MIN_BITS])
      expect(() => vector.get(0)).toThrow()
      expect(() => vector.get(2)).toThrow()
      expect(() => vector.get(3)).toThrow()

      const rows = projectBatchToRows({ numRows: 4, numCols: 1, getChildAt: () => vector })
      expect(rows).toEqual([['infinity'], [0], ['-infinity'], ['-infinity']])
    }
  })

  it('applies the same sentinel guard on the overlay path (projectOverlayPage)', () => {
    const arrow = loadArrow()
    const vector = timestampVector(arrow.TimestampMicrosecond, [NEG_BITS, INF_BITS])
    const page = projectOverlayPage({
      numRows: 2,
      numCols: 2,
      getChildAt: (index: number) =>
        index === 0 ? { get: (row: number) => `ins:ov-1#${String(row)}` } : vector,
    })
    expect(page.rows).toEqual([['-infinity'], ['infinity']])
    expect(page.rowKeys).toEqual(['ins:ov-1#0', 'ins:ov-1#1'])
  })

  it('never mislabels finite values near the int64 extremes (negative control)', () => {
    const arrow = loadArrow()
    // TIMESTAMP '280000-01-01 00:00:00' — a real finite instant whose µs raw
    // value (8773779340800000000) sits close to the int64 maximum but is not
    // a sentinel; and a far-from-extreme finite instant for the same point.
    const vector = timestampVector(arrow.TimestampMicrosecond, [
      8773779340800000000n,
      13569465600000000n,
    ])
    const rows = projectBatchToRows({ numRows: 2, numCols: 1, getChildAt: () => vector })
    expect(rows).toEqual([[8773779340800000], [13569465600000]])
    expect(rows[0]).not.toContain('infinity')
    // The finite cells stay exactly what the plain accessor delivers — the
    // guard only diverts the two extremes, never the neighbours.
    expect(rows[0]?.[0]).toBe(vector.get(0))
    expect(rows[1]?.[0]).toBe(vector.get(1))
  })

  it('keeps NULL cells NULL through the guard (the hole is never read as a sentinel)', () => {
    const arrow = loadArrow()
    const vector = timestampVectorWithNull(
      arrow.TimestampMicrosecond,
      [INF_BITS, 0n, NEG_BITS],
      [1],
    )
    const rows = projectBatchToRows({ numRows: 3, numCols: 1, getChildAt: () => vector })
    expect(rows).toEqual([['infinity'], [null], ['-infinity']])
  })

  it('renders NULL cells whose backing slots hold sentinel bits as null — validity is honored first (review repro)', () => {
    const arrow = loadArrow()
    // The reviewer's falsification: the validity bitmap marks the cells NULL
    // while their raw backing slots carry the ±infinity sentinels (and the
    // reserved minimum). The guard must consult Arrow's validity FIRST — the
    // same null check `get()` performs — and let those cells stay exactly
    // the null `get()` returns; only valid cells map to sentinel text.
    const vector = timestampVectorWithNull(
      arrow.TimestampMicrosecond,
      [INF_BITS, NEG_BITS, RESERVED_MIN_BITS],
      [1, 2],
    )
    expect(vector.isValid?.(1)).toBe(false)
    expect(vector.isValid?.(2)).toBe(false)
    expect(vector.isValid?.(0)).toBe(true)

    const rows = projectBatchToRows({ numRows: 3, numCols: 1, getChildAt: () => vector })
    expect(rows).toEqual([['infinity'], [null], [null]])

    // The same falsification through the overlay projection (row-id column
    // stripped first, data cells guarded identically).
    const page = projectOverlayPage({
      numRows: 3,
      numCols: 2,
      getChildAt: (index: number) =>
        index === 0 ? { get: (row: number) => `ins:ov-1#${String(row)}` } : vector,
    })
    expect(page.rows).toEqual([['infinity'], [null], [null]])
    expect(page.rowKeys).toEqual(['ins:ov-1#0', 'ins:ov-1#1', 'ins:ov-1#2'])
  })

  it('leaves Timestamp<NANOSECOND> entirely on the raw path — sentinel bits stay lossy numbers (WF-01)', () => {
    const arrow = loadArrow()
    // ns get() does NOT throw for the sentinel bits (÷1e6 lands inside the
    // safe range), so the guard must not divert them: today's path returns
    // the lossy number, which the ns raw-rendering rule consumes as-is.
    const vector = timestampVector(arrow.TimestampNanosecond, [INF_BITS, NEG_BITS])
    expect(vector.get(0)).toBe(9223372036854.775)
    expect(vector.get(1)).toBe(-9223372036854.775)
    const rows = projectBatchToRows({ numRows: 2, numCols: 1, getChildAt: () => vector })
    expect(rows).toEqual([[9223372036854.775], [-9223372036854.775]])
    expect(rows.flat()).not.toContain('infinity')
    expect(rows.flat()).not.toContain('-infinity')
  })

  it('keeps finite SECOND/MILLISECOND cells byte-identical to the plain path', () => {
    const arrow = loadArrow()
    // Within the safe range both units return plain numbers through get().
    const seconds = timestampVector(arrow.TimestampSecond, [8773779340800n])
    const millis = timestampVector(arrow.TimestampMillisecond, [8773779340800000n])
    expect(projectBatchToRows({ numRows: 1, numCols: 1, getChildAt: () => seconds })).toEqual([
      [8773779340800000],
    ])
    expect(projectBatchToRows({ numRows: 1, numCols: 1, getChildAt: () => millis })).toEqual([
      [8773779340800000],
    ])
    expect(seconds.get(0)).toBe(8773779340800000)
    expect(millis.get(0)).toBe(8773779340800000)
  })

  it('projects mixed batches (fake + real Arrow columns) through the same row shape', () => {
    const arrow = loadArrow()
    const vector = timestampVector(arrow.TimestampMicrosecond, [INF_BITS, 1709214312123456n])
    const rows = projectBatchToRows({
      numRows: 2,
      numCols: 2,
      getChildAt: (index: number) => (index === 0 ? { get: (row: number) => row + 1 } : vector),
    })
    expect(rows).toEqual([
      [1, 'infinity'],
      [2, 1709214312123.456],
    ])
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

/**
 * WF-06 A1-3 — `rebindOverlaySource`. A replacement candidate is constructed
 * against its OWN empty overlay box (so a candidate read can never resolve the
 * live session's overlay over the candidate's base), and only `adopt()` may
 * rebind the provider to the live session's closure, after the reset and the
 * adopted overlay republish.
 */
describe('DuckDbGridProvider.rebindOverlaySource (WF-06 A1-3)', () => {
  const CANDIDATE_BASE: OverlayBase = {
    baseAnchor: 'fv-9-2000',
    overlayAnchor: 'ov-candidate',
    columns: [
      { name: 'id', type: 'BIGINT' },
      { name: 'label', type: 'VARCHAR' },
    ],
    baseRowCount: 2,
  }

  it('starts on the candidate-local empty box and never reads a live overlay', async () => {
    const fake = fakeClient()
    const candidateBox: { current: EngineOverlay } = {
      current: { base: CANDIDATE_BASE, ops: [] },
    }
    const provider = new DuckDbGridProvider(fake.client, handle, () => candidateBox.current)

    await expect(provider.schema()).resolves.toEqual([
      { name: 'id', type: 'BIGINT' },
      { name: 'label', type: 'VARCHAR' },
    ])
    await provider.rowCount()
    // The empty-overlay fast path: the BASE methods, no overlay composition.
    expect(fake.overlaySchemas).toHaveLength(0)
    expect(fake.windows).toHaveLength(0)
    expect(fake.baseWindows).toHaveLength(0)
  })

  it('follows the rebound source (the adopted session) after adoption', async () => {
    const fake = fakeClient()
    const candidateBox: { current: EngineOverlay } = {
      current: { base: CANDIDATE_BASE, ops: [] },
    }
    const provider = new DuckDbGridProvider(fake.client, handle, () => candidateBox.current)

    // adopt() step 4: rebind to the live session's closure, after the reset and
    // the adopted overlay republish. The adopted session starts empty too.
    const adopted: { current: EngineOverlay } = { current: { base: BASE, ops: [] } }
    provider.rebindOverlaySource(() => adopted.current)

    // The first post-adoption edit publishes an op through the same closure;
    // the very next read takes the composed overlay path with THAT overlay.
    adopted.current = withEditSource()
    await provider.schema()
    expect(fake.overlaySchemas).toHaveLength(1)
    expect(fake.overlaySchemas[0]).toEqual(withEditSource())

    await provider.rowCount()
    await provider.fetchRange({ startRow: 0, endRow: 2, startCol: 0, endCol: 2 })
    expect(fake.windows).toHaveLength(1)
    // Row identity comes from the ADOPTED base anchor, not the candidate's.
    const page = await provider.fetchRange({ startRow: 0, endRow: 2, startCol: 0, endCol: 2 })
    expect(page.rowKeys?.[0]).toBe(baseRowId(BASE.baseAnchor, 0))
  })
})
