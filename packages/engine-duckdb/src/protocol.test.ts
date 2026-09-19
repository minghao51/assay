import { describe, expect, it } from 'vitest'
import {
  OVERLAY_REQUEST_TYPES,
  parseEngineRequest,
  parseEngineRequestEnvelope,
  parseEngineResponse,
} from './protocol'

describe('engine protocol parsers (ADR 0021: protocol owned by us)', () => {
  describe('parseEngineRequest', () => {
    it('parses a well-formed engine/init request', () => {
      expect(parseEngineRequest({ type: 'engine/init', requestId: 7 })).toEqual({
        type: 'engine/init',
        requestId: 7,
      })
    })

    it('parses a well-formed engine/query request with its sql', () => {
      expect(parseEngineRequest({ type: 'engine/query', requestId: 3, sql: 'SELECT 42' })).toEqual({
        type: 'engine/query',
        requestId: 3,
        sql: 'SELECT 42',
      })
    })

    it('rejects non-objects and null', () => {
      expect(parseEngineRequest('engine/init')).toBeNull()
      expect(parseEngineRequest(42)).toBeNull()
      expect(parseEngineRequest(null)).toBeNull()
      expect(parseEngineRequest(undefined)).toBeNull()
    })

    it('rejects unknown message types', () => {
      expect(parseEngineRequest({ type: 'engine/drop', requestId: 1 })).toBeNull()
      expect(parseEngineRequest({ requestId: 1 })).toBeNull()
    })

    it('rejects a missing or non-numeric requestId', () => {
      expect(parseEngineRequest({ type: 'engine/init' })).toBeNull()
      expect(parseEngineRequest({ type: 'engine/init', requestId: '1' })).toBeNull()
    })

    it('rejects engine/query without a string sql', () => {
      expect(parseEngineRequest({ type: 'engine/query', requestId: 1 })).toBeNull()
      expect(parseEngineRequest({ type: 'engine/query', requestId: 1, sql: 42 })).toBeNull()
    })
  })

  describe('M1-4: file lifecycle requests', () => {
    const parquetFile = new File([new Uint8Array([1, 2, 3])], 'flat.parquet')

    it('parses engine/open with its name and structured-cloned File', () => {
      expect(
        parseEngineRequest({
          type: 'engine/open',
          requestId: 5,
          name: 'flat.parquet',
          file: parquetFile,
        }),
      ).toEqual({ type: 'engine/open', requestId: 5, name: 'flat.parquet', file: parquetFile })
    })

    it('rejects engine/open without a File payload (the boundary is untrusted)', () => {
      const base = { type: 'engine/open', requestId: 5, name: 'flat.parquet' }
      expect(parseEngineRequest(base)).toBeNull()
      expect(parseEngineRequest({ ...base, file: 'flat.parquet' })).toBeNull()
      expect(parseEngineRequest({ ...base, file: new Uint8Array([1]) })).toBeNull()
      expect(parseEngineRequest({ ...base, file: {} })).toBeNull()
      expect(parseEngineRequest({ requestId: 5, file: parquetFile })).toBeNull()
    })

    it('rejects engine/open without a name', () => {
      expect(
        parseEngineRequest({ type: 'engine/open', requestId: 5, file: parquetFile }),
      ).toBeNull()
    })

    it('parses engine/schema with its table id', () => {
      expect(parseEngineRequest({ type: 'engine/schema', requestId: 6, tableId: 't1' })).toEqual({
        type: 'engine/schema',
        requestId: 6,
        tableId: 't1',
      })
      expect(parseEngineRequest({ type: 'engine/schema', requestId: 6 })).toBeNull()
      expect(parseEngineRequest({ type: 'engine/schema', requestId: 6, tableId: 1 })).toBeNull()
    })

    it('parses engine/range with integer bounds and optional columns', () => {
      expect(
        parseEngineRequest({
          type: 'engine/range',
          requestId: 7,
          tableId: 't1',
          startRow: 0,
          endRow: 50,
        }),
      ).toEqual({ type: 'engine/range', requestId: 7, tableId: 't1', startRow: 0, endRow: 50 })
      expect(
        parseEngineRequest({
          type: 'engine/range',
          requestId: 7,
          tableId: 't1',
          startRow: 10,
          endRow: 20,
          columns: ['a', 'b'],
        }),
      ).toEqual({
        type: 'engine/range',
        requestId: 7,
        tableId: 't1',
        startRow: 10,
        endRow: 20,
        columns: ['a', 'b'],
      })
    })

    it('rejects malformed engine/range projections', () => {
      const base = { type: 'engine/range', requestId: 7, tableId: 't1' }
      // Bounds only need to be numbers here — semantic validation (integer,
      // non-negative, ordered, capped) happens against `validateRowWindow` in
      // the worker's range handler, so bad windows get an error reply instead
      // of a silently ignored message.
      expect(parseEngineRequest({ ...base, startRow: 0, endRow: 5 })).not.toBeNull()
      expect(parseEngineRequest({ ...base, startRow: -1, endRow: 5 })).not.toBeNull()
      expect(parseEngineRequest({ ...base, startRow: 1.5, endRow: 5 })).not.toBeNull()
      expect(parseEngineRequest({ ...base, startRow: '0', endRow: 5 })).toBeNull()
      expect(parseEngineRequest({ ...base, startRow: 0 })).toBeNull()
      // columns: when present, a non-empty array of strings.
      expect(parseEngineRequest({ ...base, startRow: 0, endRow: 5, columns: [] })).toBeNull()
      expect(parseEngineRequest({ ...base, startRow: 0, endRow: 5, columns: 'a' })).toBeNull()
      expect(parseEngineRequest({ ...base, startRow: 0, endRow: 5, columns: ['a', 2] })).toBeNull()
    })

    it('parses engine/dispose', () => {
      expect(parseEngineRequest({ type: 'engine/dispose', requestId: 9 })).toEqual({
        type: 'engine/dispose',
        requestId: 9,
      })
    })
  })

  describe('m2-2: filter/sort fields on range and row-count requests', () => {
    const rangeBase = { type: 'engine/range', requestId: 7, tableId: 't1' }

    it('parses engine/range with filters and sort (copied plain arrays)', () => {
      const filters = [{ column: 'income', predicate: '> 50000' }]
      const sort = [{ column: 'country', direction: 'desc' }]
      const parsed = parseEngineRequest({
        ...rangeBase,
        startRow: 0,
        endRow: 5,
        filters,
        sort,
      })
      expect(parsed).toEqual({
        type: 'engine/range',
        requestId: 7,
        tableId: 't1',
        startRow: 0,
        endRow: 5,
        filters,
        sort,
      })
      // The boundary is untrusted: parsed arrays are copies, not references.
      expect(parsed).not.toBe(filters)
      if (parsed !== null && parsed.type === 'engine/range') {
        expect(parsed.filters![0]).not.toBe(filters[0])
        expect(parsed.sort![0]).not.toBe(sort[0])
      }
    })

    it('omits filters/sort properties when absent (legacy request shape unchanged)', () => {
      const parsed = parseEngineRequest({ ...rangeBase, startRow: 0, endRow: 5 })
      expect(parsed).toEqual({
        type: 'engine/range',
        requestId: 7,
        tableId: 't1',
        startRow: 0,
        endRow: 5,
      })
      expect(parsed).not.toHaveProperty('filters')
      expect(parsed).not.toHaveProperty('sort')
    })

    it('treats empty filters/sort arrays as valid (the grid null-clear protocol)', () => {
      const parsed = parseEngineRequest({
        ...rangeBase,
        startRow: 0,
        endRow: 5,
        filters: [],
        sort: [],
      })
      expect(parsed).toMatchObject({ filters: [], sort: [] })
    })

    it('rejects malformed filter lists (the request is dropped, not repaired)', () => {
      const bounds = { startRow: 0, endRow: 5 }
      expect(parseEngineRequest({ ...rangeBase, ...bounds, filters: 'x' })).toBeNull()
      expect(parseEngineRequest({ ...rangeBase, ...bounds, filters: {} })).toBeNull()
      expect(parseEngineRequest({ ...rangeBase, ...bounds, filters: [42] })).toBeNull()
      expect(parseEngineRequest({ ...rangeBase, ...bounds, filters: ['> 1'] })).toBeNull()
      expect(
        parseEngineRequest({ ...rangeBase, ...bounds, filters: [{ predicate: '> 1' }] }),
      ).toBeNull()
      expect(parseEngineRequest({ ...rangeBase, ...bounds, filters: [{ column: 'a' }] })).toBeNull()
      expect(
        parseEngineRequest({ ...rangeBase, ...bounds, filters: [{ column: 1, predicate: '> 1' }] }),
      ).toBeNull()
      // One bad spec poisons the whole list.
      expect(
        parseEngineRequest({
          ...rangeBase,
          ...bounds,
          filters: [{ column: 'a', predicate: '> 1' }, { column: 'b' }],
        }),
      ).toBeNull()
    })

    it('rejects malformed sort lists (direction must be exactly asc or desc)', () => {
      const bounds = { startRow: 0, endRow: 5 }
      expect(parseEngineRequest({ ...rangeBase, ...bounds, sort: 'asc' })).toBeNull()
      expect(parseEngineRequest({ ...rangeBase, ...bounds, sort: [{ column: 'a' }] })).toBeNull()
      expect(
        parseEngineRequest({ ...rangeBase, ...bounds, sort: [{ column: 'a', direction: 'up' }] }),
      ).toBeNull()
      expect(
        parseEngineRequest({ ...rangeBase, ...bounds, sort: [{ column: 'a', direction: 'ASC' }] }),
      ).toBeNull()
      expect(
        parseEngineRequest({ ...rangeBase, ...bounds, sort: [{ direction: 'asc' }] }),
      ).toBeNull()
    })

    it('parses engine/row-count with optional filters; sort is not part of its shape', () => {
      expect(parseEngineRequest({ type: 'engine/row-count', requestId: 8, tableId: 't1' })).toEqual(
        { type: 'engine/row-count', requestId: 8, tableId: 't1' },
      )
      const filters = [{ column: 'income', predicate: 'IS NOT NULL' }]
      expect(
        parseEngineRequest({ type: 'engine/row-count', requestId: 8, tableId: 't1', filters }),
      ).toEqual({ type: 'engine/row-count', requestId: 8, tableId: 't1', filters })
      // Malformed filters drop the row-count request too.
      expect(
        parseEngineRequest({ type: 'engine/row-count', requestId: 8, tableId: 't1', filters: 7 }),
      ).toBeNull()
    })
  })

  describe('parseEngineResponse', () => {
    it('parses engine/ready with the duckdb version', () => {
      expect(
        parseEngineResponse({ type: 'engine/ready', requestId: 1, duckdbVersion: 'v1.32.0' }),
      ).toEqual({ type: 'engine/ready', requestId: 1, duckdbVersion: 'v1.32.0' })
    })

    it('rejects engine/ready without a string version', () => {
      expect(parseEngineResponse({ type: 'engine/ready', requestId: 1 })).toBeNull()
    })

    it('parses engine/query-result with its Arrow IPC payload and hasMore flag', () => {
      const message = {
        type: 'engine/query-result',
        requestId: 2,
        batchIpc: new Uint8Array([1, 2, 3]),
        hasMore: false,
      }
      expect(parseEngineResponse(message)).toEqual(message)
    })

    it('accepts an empty Arrow IPC payload (0-row batch still carries bytes)', () => {
      const message = {
        type: 'engine/query-result',
        requestId: 2,
        batchIpc: new Uint8Array([]),
        hasMore: false,
      }
      expect(parseEngineResponse(message)).toEqual(message)
    })

    it('rejects engine/query-result with a malformed payload', () => {
      const base = { type: 'engine/query-result', requestId: 2, hasMore: false }
      // batchIpc must be a Uint8Array (what structured clone delivers).
      expect(parseEngineResponse({ ...base, batchIpc: null })).toBeNull()
      expect(parseEngineResponse({ ...base, batchIpc: 'arrow' })).toBeNull()
      expect(parseEngineResponse({ ...base, batchIpc: new ArrayBuffer(3) })).toBeNull()
      expect(parseEngineResponse({ ...base, batchIpc: [1, 2, 3] })).toBeNull()
      expect(parseEngineResponse({ ...base })).toBeNull()
      // hasMore must be a boolean.
      expect(
        parseEngineResponse({ ...base, hasMore: undefined, batchIpc: new Uint8Array([1]) }),
      ).toBeNull()
      expect(
        parseEngineResponse({
          type: 'engine/query-result',
          requestId: 2,
          batchIpc: new Uint8Array([1]),
        }),
      ).toBeNull()
    })

    it('parses engine/error with its message', () => {
      expect(parseEngineResponse({ type: 'engine/error', requestId: 4, message: 'boom' })).toEqual({
        type: 'engine/error',
        requestId: 4,
        message: 'boom',
      })
    })

    it('parses engine/open-result with its table id and reader format', () => {
      expect(
        parseEngineResponse({
          type: 'engine/open-result',
          requestId: 8,
          tableId: 't1',
          format: 'parquet',
        }),
      ).toEqual({ type: 'engine/open-result', requestId: 8, tableId: 't1', format: 'parquet' })
      expect(
        parseEngineResponse({
          type: 'engine/open-result',
          requestId: 8,
          tableId: 't1',
          format: 'execl',
        }),
      ).toBeNull()
      expect(
        parseEngineResponse({ type: 'engine/open-result', requestId: 8, format: 'csv' }),
      ).toBeNull()
    })

    it('parses engine/schema-result with its column/type pairs', () => {
      const columns = [
        { name: 'id', type: 'BIGINT' },
        { name: 'payload', type: 'STRUCT(a INTEGER)' },
      ]
      expect(parseEngineResponse({ type: 'engine/schema-result', requestId: 10, columns })).toEqual(
        { type: 'engine/schema-result', requestId: 10, columns },
      )
      // Every pair must carry both a string name and a string type.
      expect(
        parseEngineResponse({
          type: 'engine/schema-result',
          requestId: 10,
          columns: [{ name: 'id' }],
        }),
      ).toBeNull()
      expect(
        parseEngineResponse({ type: 'engine/schema-result', requestId: 10, columns: 'id' }),
      ).toBeNull()
      expect(parseEngineResponse({ type: 'engine/schema-result', requestId: 10 })).toBeNull()
    })

    it('parses engine/range-result like a query result (Arrow IPC + honest hasMore)', () => {
      const message = {
        type: 'engine/range-result',
        requestId: 11,
        batchIpc: new Uint8Array([4, 5, 6]),
        hasMore: false,
      }
      expect(parseEngineResponse(message)).toEqual(message)
      expect(
        parseEngineResponse({ type: 'engine/range-result', requestId: 11, hasMore: false }),
      ).toBeNull()
    })

    it('parses engine/disposed', () => {
      expect(parseEngineResponse({ type: 'engine/disposed', requestId: 12 })).toEqual({
        type: 'engine/disposed',
        requestId: 12,
      })
    })

    it('rejects unknown responses', () => {
      expect(parseEngineResponse({ type: 'engine/progress', requestId: 1 })).toBeNull()
      expect(parseEngineResponse('engine/ready')).toBeNull()
    })
  })
})

describe('M1-5: engine/row-count protocol', () => {
  describe('parseEngineRequest', () => {
    it('parses engine/row-count with its table id', () => {
      expect(
        parseEngineRequest({ type: 'engine/row-count', requestId: 13, tableId: 't2' }),
      ).toEqual({ type: 'engine/row-count', requestId: 13, tableId: 't2' })
    })

    it('rejects engine/row-count without a string table id (the boundary is untrusted)', () => {
      expect(parseEngineRequest({ type: 'engine/row-count', requestId: 13 })).toBeNull()
      expect(parseEngineRequest({ type: 'engine/row-count', requestId: 13, tableId: 2 })).toBeNull()
    })
  })

  describe('parseEngineResponse', () => {
    it('parses engine/row-count-result with a safe non-negative integer', () => {
      expect(
        parseEngineResponse({ type: 'engine/row-count-result', requestId: 14, rowCount: 0 }),
      ).toEqual({ type: 'engine/row-count-result', requestId: 14, rowCount: 0 })
      expect(
        parseEngineResponse({
          type: 'engine/row-count-result',
          requestId: 14,
          rowCount: Number.MAX_SAFE_INTEGER,
        }),
      ).toEqual({
        type: 'engine/row-count-result',
        requestId: 14,
        rowCount: Number.MAX_SAFE_INTEGER,
      })
    })

    it('rejects row counts that are negative, fractional, or not numbers', () => {
      const base = { type: 'engine/row-count-result', requestId: 14 }
      expect(parseEngineResponse({ ...base, rowCount: -1 })).toBeNull()
      expect(parseEngineResponse({ ...base, rowCount: 1.5 })).toBeNull()
      expect(parseEngineResponse({ ...base, rowCount: '100' })).toBeNull()
      expect(parseEngineResponse({ ...base, rowCount: Number.NaN })).toBeNull()
      expect(parseEngineResponse({ ...base, rowCount: Infinity })).toBeNull()
      expect(parseEngineResponse({ ...base })).toBeNull()
    })
  })
})

// ---- m2-5: engine/profile protocol ----

/** A well-formed profile column, as the worker assembles it. */
function profileColumn(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'income',
    type: 'BIGINT',
    kind: 'numeric',
    nullCount: 1,
    distinctCount: 4,
    numeric: {
      min: 48000,
      max: 75000,
      mean: 59000,
      stddev: 11972.19,
      quantiles: { p50: 56500, p90: 70800, p95: 72900, p99: 74580 },
    },
    ...overrides,
  }
}

function profileResultResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'engine/profile-result',
    requestId: 8,
    rowCount: 5,
    columns: [profileColumn()],
    ...overrides,
  }
}

describe('m2-5: engine/profile protocol', () => {
  describe('parseEngineRequest', () => {
    it('parses engine/profile with its table id', () => {
      expect(parseEngineRequest({ type: 'engine/profile', requestId: 10, tableId: 't1' })).toEqual({
        type: 'engine/profile',
        requestId: 10,
        tableId: 't1',
      })
    })

    it('rejects engine/profile without a string table id (the boundary is untrusted)', () => {
      expect(parseEngineRequest({ type: 'engine/profile', requestId: 10 })).toBeNull()
      expect(parseEngineRequest({ type: 'engine/profile', requestId: 10, tableId: 1 })).toBeNull()
    })
  })

  describe('parseEngineResponse', () => {
    it('parses a well-formed engine/profile-result with numeric and categorical payloads', () => {
      expect(
        parseEngineResponse({
          type: 'engine/profile-result',
          requestId: 8,
          rowCount: 5,
          columns: [
            profileColumn(),
            profileColumn({
              name: 'country',
              type: 'VARCHAR',
              kind: 'categorical',
              nullCount: 0,
              numeric: undefined,
              categorical: {
                topK: [
                  { value: 'SG', count: 2 },
                  { value: 'US', count: 2 },
                ],
              },
            }),
            profileColumn({
              name: 'payload',
              type: 'STRUCT("name" VARCHAR)',
              kind: 'other',
              numeric: undefined,
            }),
          ],
        }),
      ).toEqual({
        type: 'engine/profile-result',
        requestId: 8,
        rowCount: 5,
        columns: [
          profileColumn(),
          {
            name: 'country',
            type: 'VARCHAR',
            kind: 'categorical',
            nullCount: 0,
            distinctCount: 4,
            categorical: {
              topK: [
                { value: 'SG', count: 2 },
                { value: 'US', count: 2 },
              ],
            },
          },
          {
            name: 'payload',
            type: 'STRUCT("name" VARCHAR)',
            kind: 'other',
            nullCount: 1,
            distinctCount: 4,
          },
        ],
      })
    })

    it('accepts null statistics (all-null columns / undefined stats)', () => {
      const response = profileResultResponse({
        columns: [
          profileColumn({
            numeric: {
              min: null,
              max: null,
              mean: null,
              stddev: null,
              quantiles: { p50: null, p90: null, p95: null, p99: null },
            },
          }),
        ],
      })
      expect(parseEngineResponse(response)).not.toBeNull()
    })

    it('rejects bad row counts and non-array column lists', () => {
      expect(parseEngineResponse(profileResultResponse({ rowCount: -1 }))).toBeNull()
      expect(parseEngineResponse(profileResultResponse({ rowCount: 1.5 }))).toBeNull()
      expect(parseEngineResponse(profileResultResponse({ rowCount: '5' }))).toBeNull()
      expect(parseEngineResponse(profileResultResponse({ columns: {} }))).toBeNull()
      expect(parseEngineResponse(profileResultResponse({ columns: undefined }))).toBeNull()
    })

    it('rejects malformed column entries (the boundary is untrusted)', () => {
      expect(parseEngineResponse(profileResultResponse({ columns: [42] }))).toBeNull()
      expect(parseEngineResponse(profileResultResponse({ columns: [{ name: 'a' }] }))).toBeNull()
      expect(
        parseEngineResponse(profileResultResponse({ columns: [profileColumn({ kind: 'bogus' })] })),
      ).toBeNull()
      expect(
        parseEngineResponse(profileResultResponse({ columns: [profileColumn({ nullCount: -1 })] })),
      ).toBeNull()
      expect(
        parseEngineResponse(
          profileResultResponse({ columns: [profileColumn({ distinctCount: '4' })] }),
        ),
      ).toBeNull()
    })

    it('rejects malformed numeric payloads (non-finite numbers are not JSON-able)', () => {
      // The payload is otherwise-valid; the NaN in `min` is the ONLY violation,
      // so this pin bites the finite-number guard itself (an otherwise-masked
      // assertion would stay green if the guard were mutated to accept NaN).
      expect(
        parseEngineResponse(
          profileResultResponse({
            columns: [
              profileColumn({
                numeric: {
                  min: Number.NaN,
                  max: 2,
                  mean: 3,
                  stddev: 4,
                  quantiles: { p50: 1, p90: 2, p95: 3, p99: 4 },
                },
              }),
            ],
          }),
        ),
      ).toBeNull()
      expect(
        parseEngineResponse(
          profileResultResponse({
            columns: [
              profileColumn({
                numeric: { min: 1, max: 2, mean: 3, stddev: 4, quantiles: { p50: 'x' } },
              }),
            ],
          }),
        ),
      ).toBeNull()
      expect(
        parseEngineResponse(
          profileResultResponse({
            columns: [profileColumn({ numeric: { min: 1, max: 2, mean: 3, stddev: 4 } })],
          }),
        ),
      ).toBeNull()
    })

    it('rejects malformed categorical payloads', () => {
      expect(
        parseEngineResponse(
          profileResultResponse({
            columns: [profileColumn({ kind: 'categorical', categorical: { topK: 'nope' } })],
          }),
        ),
      ).toBeNull()
      expect(
        parseEngineResponse(
          profileResultResponse({
            columns: [
              profileColumn({
                kind: 'categorical',
                categorical: { topK: [{ value: 'SG', count: -1 }] },
              }),
            ],
          }),
        ),
      ).toBeNull()
      expect(
        parseEngineResponse(
          profileResultResponse({
            columns: [
              profileColumn({ kind: 'categorical', categorical: { topK: [{ value: 5 }] } }),
            ],
          }),
        ),
      ).toBeNull()
    })
  })
})

describe('m4-2: overlay + export protocol', () => {
  const OVERLAY = {
    base: {
      baseAnchor: 'b1',
      overlayAnchor: 'o1',
      columns: [
        { name: 'id', type: 'BIGINT' },
        { name: 'label', type: 'VARCHAR' },
      ],
      baseRowCount: 3,
    },
    ops: [
      {
        kind: 'cell-set',
        rowId: 'base:b1#0',
        column: 'label',
        value: { kind: 'string', value: 'x' },
      },
    ],
  }

  describe('parseEngineRequest', () => {
    it('parses engine/overlay-schema with its overlay payload', () => {
      expect(
        parseEngineRequest({
          type: 'engine/overlay-schema',
          requestId: 4,
          tableId: 't1',
          overlay: OVERLAY,
        }),
      ).toEqual({ type: 'engine/overlay-schema', requestId: 4, tableId: 't1', overlay: OVERLAY })
    })

    it('rejects engine/overlay-schema without a well-formed overlay payload', () => {
      expect(
        parseEngineRequest({ type: 'engine/overlay-schema', requestId: 4, tableId: 't1' }),
      ).toBeNull()
      expect(
        parseEngineRequest({
          type: 'engine/overlay-schema',
          requestId: 4,
          tableId: 't1',
          overlay: { base: { ...OVERLAY.base, baseRowCount: -1 }, ops: [] },
        }),
      ).toBeNull()
      expect(
        parseEngineRequest({
          type: 'engine/overlay-schema',
          requestId: 4,
          tableId: 't1',
          overlay: { base: OVERLAY.base, ops: [{ kind: 'wat' }] },
        }),
      ).toBeNull()
    })

    it('parses engine/overlay-row-count with optional filters', () => {
      expect(
        parseEngineRequest({
          type: 'engine/overlay-row-count',
          requestId: 5,
          tableId: 't1',
          overlay: OVERLAY,
          filters: [{ column: 'label', predicate: "> 'a'" }],
        }),
      ).toEqual({
        type: 'engine/overlay-row-count',
        requestId: 5,
        tableId: 't1',
        overlay: OVERLAY,
        filters: [{ column: 'label', predicate: "> 'a'" }],
      })
      expect(
        parseEngineRequest({
          type: 'engine/overlay-row-count',
          requestId: 5,
          tableId: 't1',
          overlay: OVERLAY,
        }),
      ).toEqual({ type: 'engine/overlay-row-count', requestId: 5, tableId: 't1', overlay: OVERLAY })
    })

    it('parses engine/overlay-range with window/sort/filter/id flags', () => {
      expect(
        parseEngineRequest({
          type: 'engine/overlay-range',
          requestId: 6,
          tableId: 't1',
          overlay: OVERLAY,
          startRow: 0,
          endRow: 5,
          columns: ['id'],
          filters: [{ column: 'id', predicate: '> 1' }],
          sort: [{ column: 'id', direction: 'asc' }],
          includeRowIds: true,
        }),
      ).toEqual({
        type: 'engine/overlay-range',
        requestId: 6,
        tableId: 't1',
        overlay: OVERLAY,
        startRow: 0,
        endRow: 5,
        columns: ['id'],
        filters: [{ column: 'id', predicate: '> 1' }],
        sort: [{ column: 'id', direction: 'asc' }],
        includeRowIds: true,
      })
      // Malformed optional fields reject (the boundary is untrusted).
      expect(
        parseEngineRequest({
          type: 'engine/overlay-range',
          requestId: 6,
          tableId: 't1',
          overlay: OVERLAY,
          startRow: 0,
          endRow: 5,
          columns: [],
        }),
      ).toBeNull()
      expect(
        parseEngineRequest({
          type: 'engine/overlay-range',
          requestId: 6,
          tableId: 't1',
          overlay: OVERLAY,
          startRow: 0,
          endRow: 5,
          includeRowIds: 'yes',
        }),
      ).toBeNull()
    })

    it('parses engine/overlay-cast-check and rejects malformed instances', () => {
      expect(
        parseEngineRequest({
          type: 'engine/overlay-cast-check',
          requestId: 8,
          tableId: 't1',
          overlay: OVERLAY,
          column: 'label',
          targetType: 'BIGINT',
        }),
      ).toEqual({
        type: 'engine/overlay-cast-check',
        requestId: 8,
        tableId: 't1',
        overlay: OVERLAY,
        column: 'label',
        targetType: 'BIGINT',
      })
      // A malformed or injection-shaped target type rejects the request (the
      // boundary never interpolates an unvalidated string into a type slot).
      for (const targetType of ['VARCHAR()', 'DECIMAL(1,2,3)', 'BIGINT; DROP TABLE t']) {
        expect(
          parseEngineRequest({
            type: 'engine/overlay-cast-check',
            requestId: 8,
            tableId: 't1',
            overlay: OVERLAY,
            column: 'label',
            targetType,
          }),
        ).toBeNull()
      }
      expect(
        parseEngineRequest({
          type: 'engine/overlay-cast-check',
          requestId: 8,
          tableId: 't1',
          overlay: OVERLAY,
          column: 'label',
        }),
      ).toBeNull()
      // A present-but-malformed overlay rejects too.
      expect(
        parseEngineRequest({
          type: 'engine/overlay-cast-check',
          requestId: 8,
          tableId: 't1',
          overlay: { base: OVERLAY.base, ops: 42 },
          column: 'label',
          targetType: 'BIGINT',
        }),
      ).toBeNull()
    })

    it('parses engine/export with or without an overlay, and rejects bad formats', () => {
      expect(
        parseEngineRequest({
          type: 'engine/export',
          requestId: 7,
          tableId: 't1',
          format: 'parquet',
        }),
      ).toEqual({ type: 'engine/export', requestId: 7, tableId: 't1', format: 'parquet' })
      expect(
        parseEngineRequest({
          type: 'engine/export',
          requestId: 7,
          tableId: 't1',
          format: 'csv',
          overlay: OVERLAY,
        }),
      ).toEqual({
        type: 'engine/export',
        requestId: 7,
        tableId: 't1',
        format: 'csv',
        overlay: OVERLAY,
      })
      // A present-but-malformed overlay rejects even for export.
      expect(
        parseEngineRequest({
          type: 'engine/export',
          requestId: 7,
          tableId: 't1',
          format: 'csv',
          overlay: { base: OVERLAY.base, ops: 42 },
        }),
      ).toBeNull()
      expect(
        parseEngineRequest({ type: 'engine/export', requestId: 7, tableId: 't1', format: 'xlsx' }),
      ).toBeNull()
    })
  })

  describe('parseEngineRequestEnvelope (m4-2 fix round 2)', () => {
    it('returns the request for a well-formed message', () => {
      expect(parseEngineRequestEnvelope({ type: 'engine/init', requestId: 1 })).toEqual({
        status: 'request',
        request: { type: 'engine/init', requestId: 1 },
      })
    })

    it('preserves requestId for a malformed recognised overlay request (reviewer repro 77)', () => {
      // The reviewer posted directly to the worker protocol: the client's
      // pending promise for request 77 hung because the parser returned null
      // and the executor silently returned. The envelope keeps the id.
      expect(
        parseEngineRequestEnvelope({
          type: 'engine/overlay-schema',
          requestId: 77,
          tableId: 't1',
        }),
      ).toEqual({
        status: 'malformed',
        malformed: { requestId: 77, requestType: 'engine/overlay-schema' },
      })
    })

    it('covers every recognised overlay/export request type', () => {
      for (const requestType of OVERLAY_REQUEST_TYPES) {
        expect(parseEngineRequestEnvelope({ type: requestType, requestId: 9 })).toEqual({
          status: 'malformed',
          malformed: { requestId: 9, requestType },
        })
      }
    })

    it('ignores unrecognised types and uncorrelatable messages (unchanged contract)', () => {
      for (const data of [
        { type: 'engine/drop', requestId: 1 },
        { type: 'engine/overlay-schema', tableId: 't1' },
        { type: 'engine/overlay-schema', requestId: '77' },
        'engine/overlay-schema',
        42,
        null,
      ]) {
        expect(parseEngineRequestEnvelope(data)).toEqual({ status: 'ignored' })
      }
    })
  })

  describe('parseEngineResponse', () => {
    it('parses the overlay schema/row-count/range results', () => {
      expect(
        parseEngineResponse({
          type: 'engine/overlay-schema-result',
          requestId: 4,
          columns: [{ name: 'id', type: 'BIGINT' }],
        }),
      ).toEqual({
        type: 'engine/overlay-schema-result',
        requestId: 4,
        columns: [{ name: 'id', type: 'BIGINT' }],
      })
      expect(
        parseEngineResponse({ type: 'engine/overlay-row-count-result', requestId: 5, rowCount: 3 }),
      ).toEqual({ type: 'engine/overlay-row-count-result', requestId: 5, rowCount: 3 })
      expect(
        parseEngineResponse({
          type: 'engine/overlay-range-result',
          requestId: 6,
          batchIpc: new Uint8Array([1, 2]),
          hasMore: false,
        }),
      ).toEqual({
        type: 'engine/overlay-range-result',
        requestId: 6,
        batchIpc: new Uint8Array([1, 2]),
        hasMore: false,
      })
      expect(
        parseEngineResponse({
          type: 'engine/overlay-cast-check-result',
          requestId: 9,
          hasNonConvertibleValues: true,
        }),
      ).toEqual({
        type: 'engine/overlay-cast-check-result',
        requestId: 9,
        hasNonConvertibleValues: true,
      })
    })

    it('rejects malformed overlay results', () => {
      expect(
        parseEngineResponse({ type: 'engine/overlay-schema-result', requestId: 4, columns: 'no' }),
      ).toBeNull()
      expect(
        parseEngineResponse({
          type: 'engine/overlay-row-count-result',
          requestId: 5,
          rowCount: -1,
        }),
      ).toBeNull()
      expect(
        parseEngineResponse({ type: 'engine/overlay-row-count-result', requestId: 5 }),
      ).toBeNull()
      expect(
        parseEngineResponse({
          type: 'engine/overlay-range-result',
          requestId: 6,
          batchIpc: new Uint8Array([1]),
        }),
      ).toBeNull()
      // The cast-check result must be a boolean — never a string/1/0.
      expect(
        parseEngineResponse({
          type: 'engine/overlay-cast-check-result',
          requestId: 9,
          hasNonConvertibleValues: 'yes',
        }),
      ).toBeNull()
      expect(
        parseEngineResponse({ type: 'engine/overlay-cast-check-result', requestId: 9 }),
      ).toBeNull()
    })

    it('parses the export result with honest counts', () => {
      expect(
        parseEngineResponse({
          type: 'engine/export-result',
          requestId: 7,
          path: 'assay-exports/assay-export-1.parquet',
          format: 'parquet',
          rowCount: 8,
          bytes: 1234,
        }),
      ).toEqual({
        type: 'engine/export-result',
        requestId: 7,
        path: 'assay-exports/assay-export-1.parquet',
        format: 'parquet',
        rowCount: 8,
        bytes: 1234,
      })
      expect(
        parseEngineResponse({
          type: 'engine/export-result',
          requestId: 7,
          path: 'p',
          format: 'parquet',
          rowCount: 1,
          bytes: -1,
        }),
      ).toBeNull()
      expect(
        parseEngineResponse({
          type: 'engine/export-result',
          requestId: 7,
          path: 'p',
          format: 'xlsx',
          rowCount: 1,
          bytes: 1,
        }),
      ).toBeNull()
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// m5-2: engine/validate protocol
// ─────────────────────────────────────────────────────────────────────────────

import type { EngineValidationPlan, EngineValidationResult } from './validate-plan-wire'

function wirePlan(): EngineValidationPlan {
  return {
    planKind: 'assay-validation-plan',
    planVersion: 1,
    contractName: 'conf',
    contractVersion: 1,
    relation: 'assay_conf_validate_src',
    sampleLimit: 20,
    rules: [
      {
        ruleId: 'columns[0].required',
        path: 'columns[0].required',
        kind: 'required',
        column: 'id',
        outcome: 'row-samples',
        sql: 'SELECT (SELECT count(*) FROM "assay_conf_validate_src") AS "total_rows" FROM "assay_conf_validate_src" AS "src" LIMIT 20',
      },
    ],
    summarySql:
      'SELECT \'columns[0].required\' AS "rule_id" FROM "assay_conf_validate_src" AS "src"',
  }
}

function wireResult(): EngineValidationResult {
  return {
    valid: false,
    rowCount: 120,
    rules: [
      {
        ruleId: 'columns[1].allowed-values',
        failCount: 24,
        failPercent: 20,
        sampleFailures: [
          { rowKey: 'base:v#4', value: 'XX' },
          { rowKey: 'base:v#24', value: 'x1' },
        ],
      },
    ],
  }
}

describe('m5-2: engine/validate protocol', () => {
  it('parses a well-formed engine/validate request with plan + optional overlay', () => {
    const base = { type: 'engine/validate', requestId: 9, tableId: 't1', plan: wirePlan() }
    expect(parseEngineRequest(base)).toEqual(base)
    const withOverlay = { ...base, overlay: { base: OVERLAY_BASE_MINIMAL(), ops: [] } }
    expect(parseEngineRequest(withOverlay)).not.toBeNull()
  })

  it('rejects engine/validate with a malformed plan (the boundary is untrusted)', () => {
    const base = { type: 'engine/validate', requestId: 9, tableId: 't1' }
    expect(parseEngineRequest(base)).toBeNull()
    expect(parseEngineRequest({ ...base, plan: { ...wirePlan(), planVersion: 2 } })).toBeNull()
    expect(parseEngineRequest({ ...base, plan: { ...wirePlan(), sampleLimit: 0 } })).toBeNull()
    // Any safe K ≥ 1 parses (m5-2 round-3 fix: over-max K is CLAMPED by the
    // executor, not refused) — but a non-safe-integer K is still malformed.
    expect(
      parseEngineRequest({ ...base, plan: { ...wirePlan(), sampleLimit: 101 } }),
    ).not.toBeNull()
    expect(
      parseEngineRequest({ ...base, plan: { ...wirePlan(), sampleLimit: 2 ** 53 - 1 } }),
    ).not.toBeNull()
    expect(parseEngineRequest({ ...base, plan: { ...wirePlan(), sampleLimit: 1.5 } })).toBeNull()
    // The ruleId grammar (W1): only m5-0 error-path spellings parse.
    const hostile = {
      ...wirePlan(),
      rules: [{ ...wirePlan().rules[0]!, ruleId: 'hostile' }],
    }
    expect(parseEngineRequest({ ...base, plan: hostile })).toBeNull()
    expect(
      parseEngineRequest({ ...base, plan: { ...wirePlan(), relation: 'a\u0000b' } }),
    ).toBeNull()
    const duplicate = { ...wirePlan(), rules: [wirePlan().rules[0], wirePlan().rules[0]] }
    expect(parseEngineRequest({ ...base, plan: duplicate })).toBeNull()
  })

  it('rejects engine/validate with a present-but-malformed overlay', () => {
    const base = { type: 'engine/validate', requestId: 9, tableId: 't1', plan: wirePlan() }
    expect(parseEngineRequest({ ...base, overlay: { base: 'nope' } })).toBeNull()
  })

  it('answers malformed but recognised engine/validate requests with the typed envelope', () => {
    expect(OVERLAY_REQUEST_TYPES).toContain('engine/validate')
    const envelope = parseEngineRequestEnvelope({
      type: 'engine/validate',
      requestId: 9,
      tableId: 't1',
      plan: { planKind: 'wrong' },
    })
    expect(envelope).toEqual({
      status: 'malformed',
      malformed: { requestId: 9, requestType: 'engine/validate' },
    })
  })

  it('parses engine/validate-result with the full result payload', () => {
    const response = { type: 'engine/validate-result', requestId: 9, result: wireResult() }
    expect(parseEngineResponse(response)).toEqual(response)
  })

  it('rejects malformed engine/validate-result payloads', () => {
    const base = { type: 'engine/validate-result', requestId: 9 }
    expect(parseEngineResponse(base)).toBeNull()
    expect(parseEngineResponse({ ...base, result: { ...wireResult(), valid: 'yes' } })).toBeNull()
    expect(parseEngineResponse({ ...base, result: { ...wireResult(), rowCount: -1 } })).toBeNull()
    expect(
      parseEngineResponse({ ...base, result: { ...wireResult(), rules: [{ ruleId: 'r' }] } }),
    ).toBeNull()
    expect(
      parseEngineResponse({
        ...base,
        result: { ...wireResult(), rules: [{ ...wireResult().rules[0]!, failPercent: 101 }] },
      }),
    ).toBeNull()
    // The reviewer's two-row probe shape (m5-2 round-3, item 3): a per-rule
    // count larger than the result's own rowCount is out of contract and
    // rejected at parse — the client rejects, it never hangs on it.
    expect(
      parseEngineResponse({
        ...base,
        result: {
          ...wireResult(),
          rowCount: 2,
          rules: [{ ...wireResult().rules[0]!, failCount: 3 }],
        },
      }),
    ).toBeNull()
    expect(
      parseEngineResponse({
        ...base,
        result: {
          ...wireResult(),
          rules: [{ ...wireResult().rules[0]!, sampleFailures: [{ rowKey: 'k', value: {} }] }],
        },
      }),
    ).toBeNull()
    // A resolvable non-empty row key is part of the result contract: null
    // (the legacy spelling) and empty strings are rejected (m5-2 fix round).
    expect(
      parseEngineResponse({
        ...base,
        result: {
          ...wireResult(),
          rules: [
            {
              ...wireResult().rules[0]!,
              sampleFailures: [{ rowKey: null, value: 'XX' }],
            },
          ],
        },
      }),
    ).toBeNull()
    expect(
      parseEngineResponse({
        ...base,
        result: {
          ...wireResult(),
          rules: [
            {
              ...wireResult().rules[0]!,
              sampleFailures: [{ rowKey: '', value: 'XX' }],
            },
          ],
        },
      }),
    ).toBeNull()
  })
})

/** Minimal valid overlay base for request parsing (unique names, safe count). */
function OVERLAY_BASE_MINIMAL(): Record<string, unknown> {
  return {
    baseAnchor: 'a',
    overlayAnchor: 'o',
    baseRowCount: 1,
    columns: [{ name: 'id', type: 'BIGINT' }],
  }
}
