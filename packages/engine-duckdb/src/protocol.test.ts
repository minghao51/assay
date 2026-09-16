import { describe, expect, it } from 'vitest'
import { parseEngineRequest, parseEngineResponse } from './protocol'

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
