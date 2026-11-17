// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { compileRowDiffPlan } from '@assay/diff'
import {
  MAX_CSV_INFERENCE_SAMPLE_ROWS,
  MAX_CSV_OPTION_VALUE_CODE_POINTS,
  MAX_CSV_TYPE_COLUMNS,
} from './csv-options'
import { MAX_RANGE_ROWS } from './range-window'
import {
  ENGINE_REQUEST_TYPES,
  OVERLAY_REQUEST_TYPES,
  parseEngineRequest,
  parseEngineRequestEnvelope,
  parseEngineResponse,
} from './protocol'
import type { EngineRequestType } from './protocol'
import type { EngineRowDiffPlan, EngineRowDiffResult } from './diff-plan-wire'

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

    it('parses engine/pipeline-handle with its relation (p2-1 (b))', () => {
      expect(
        parseEngineRequest({ type: 'engine/pipeline-handle', requestId: 12, relation: 'out' }),
      ).toEqual({ type: 'engine/pipeline-handle', requestId: 12, relation: 'out' })
      expect(parseEngineRequest({ type: 'engine/pipeline-handle', requestId: 12 })).toBeNull()
      expect(
        parseEngineRequest({ type: 'engine/pipeline-handle', requestId: 12, relation: 1 }),
      ).toBeNull()
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

    it('parses engine/pipeline-handle-result with its relation and table id (p2-1 (b))', () => {
      const message = {
        type: 'engine/pipeline-handle-result',
        requestId: 13,
        relation: 'out',
        tableId: 't1',
      }
      expect(parseEngineResponse(message)).toEqual(message)
      expect(
        parseEngineResponse({
          type: 'engine/pipeline-handle-result',
          requestId: 13,
          tableId: 't1',
        }),
      ).toBeNull()
      expect(
        parseEngineResponse({
          type: 'engine/pipeline-handle-result',
          requestId: 13,
          relation: 'out',
        }),
      ).toBeNull()
    })

    it('parses engine/disposed', () => {
      expect(parseEngineResponse({ type: 'engine/disposed', requestId: 12 })).toEqual({
        type: 'engine/disposed',
        requestId: 12,
      })
    })

    it('parses the pipeline source and materialize results', () => {
      expect(
        parseEngineResponse({
          type: 'engine/pipeline-source-result',
          requestId: 19,
          relation: 'customers',
          rowCount: 5,
        }),
      ).toEqual({
        type: 'engine/pipeline-source-result',
        requestId: 19,
        relation: 'customers',
        rowCount: 5,
      })
      expect(
        parseEngineResponse({
          type: 'engine/pipeline-materialize-result',
          requestId: 20,
          relation: 'out',
          rowCount: 2,
        }),
      ).toEqual({
        type: 'engine/pipeline-materialize-result',
        requestId: 20,
        relation: 'out',
        rowCount: 2,
      })
      expect(
        parseEngineResponse({
          type: 'engine/pipeline-source-result',
          requestId: 19,
          relation: 'customers',
        }),
      ).toBeNull()
    })

    it('parses engine/pipeline-execute-result for relation and export modes (p2-4)', () => {
      const relationMessage = {
        type: 'engine/pipeline-execute-result',
        requestId: 21,
        relation: 'out',
        materialization: 'table',
        rowCount: 3,
      }
      expect(parseEngineResponse(relationMessage)).toEqual(relationMessage)
      const exportMessage = {
        type: 'engine/pipeline-execute-result',
        requestId: 22,
        relation: 'out',
        materialization: 'export',
        rowCount: 5,
        path: 'assay-exports/assay-pipeline-export-out.parquet',
        bytes: 128,
      }
      expect(parseEngineResponse(exportMessage)).toEqual(exportMessage)
      // An export result must carry a path and byte size; a non-export result
      // must not require them, but an unknown materialization is rejected.
      expect(
        parseEngineResponse({
          type: 'engine/pipeline-execute-result',
          requestId: 22,
          relation: 'out',
          materialization: 'export',
          rowCount: 5,
        }),
      ).toBeNull()
      expect(
        parseEngineResponse({
          type: 'engine/pipeline-execute-result',
          requestId: 21,
          relation: 'out',
          materialization: 'publish',
          rowCount: 3,
        }),
      ).toBeNull()
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
        malformed: {
          requestId: 77,
          requestType: 'engine/overlay-schema',
          field: 'overlay-schema.overlay',
        },
      })
    })

    it('covers every recognised overlay/export request type', () => {
      const expectedField: Record<(typeof OVERLAY_REQUEST_TYPES)[number], string> = {
        'engine/overlay-schema': 'overlay-schema.tableId',
        'engine/overlay-row-count': 'overlay-row-count.tableId',
        'engine/overlay-range': 'overlay-range.tableId',
        'engine/overlay-cast-check': 'overlay-cast-check.tableId',
        'engine/export': 'export.tableId',
        'engine/validate': 'validate.tableId',
        'engine/diff-stage': 'diff-stage.name',
        'engine/diff': 'diff.tableId',
      }
      for (const requestType of OVERLAY_REQUEST_TYPES) {
        expect(parseEngineRequestEnvelope({ type: requestType, requestId: 9 })).toEqual({
          status: 'malformed',
          malformed: { requestId: 9, requestType, field: expectedField[requestType] },
        })
      }
    })

    it('q-10: covers every recognised non-overlay request type too', () => {
      const expectedField = {
        'engine/query': 'query.sql',
        'engine/open': 'open.name',
        'engine/schema': 'schema.tableId',
        'engine/range': 'range.tableId',
        'engine/row-count': 'row-count.tableId',
        'engine/profile': 'profile.tableId',
      } as const
      for (const [requestType, field] of Object.entries(expectedField)) {
        expect(parseEngineRequestEnvelope({ type: requestType, requestId: 9 })).toEqual({
          status: 'malformed',
          malformed: { requestId: 9, requestType, field },
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

  // ───────────────────────────────────────────────────────────────────────
  // q-10: malformed-envelope rejection coverage. Before q-10 only the
  // OVERLAY_REQUEST_TYPES subset got a typed rejection; a malformed
  // range/row-count/schema/open/query envelope was silently dropped (a hang
  // risk for the caller). Now every recognised request kind is rejected at
  // the seam with a value-free field path.
  // ───────────────────────────────────────────────────────────────────────
  describe('q-10: every request kind rejects a malformed envelope at the seam', () => {
    interface MalformedCase {
      readonly label: string
      readonly type: EngineRequestType
      readonly payload: Record<string, unknown>
      readonly field: string
    }

    const requestId = 42
    const file = new File([new Uint8Array([1, 2, 3])], 'flat.parquet')
    // Minimal structurally valid overlay payload (base + empty op list), so
    // each case isolates exactly one malformed field.
    const overlay = {
      base: {
        baseAnchor: 'a',
        overlayAnchor: 'o',
        baseRowCount: 1,
        columns: [{ name: 'id', type: 'BIGINT' }],
      },
      ops: [],
    }
    const badOverlay = { base: 'nope' }

    const cases: MalformedCase[] = [
      // engine/query
      { label: 'engine/query missing sql', type: 'engine/query', payload: {}, field: 'query.sql' },
      {
        label: 'engine/query wrong-typed sql',
        type: 'engine/query',
        payload: { sql: 42 },
        field: 'query.sql',
      },
      // engine/open
      {
        label: 'engine/open missing name',
        type: 'engine/open',
        payload: { file },
        field: 'open.name',
      },
      {
        label: 'engine/open wrong-typed name',
        type: 'engine/open',
        payload: { name: 42, file },
        field: 'open.name',
      },
      {
        label: 'engine/open missing file',
        type: 'engine/open',
        payload: { name: 'flat.parquet' },
        field: 'open.file',
      },
      {
        label: 'engine/open wrong-typed file',
        type: 'engine/open',
        payload: { name: 'flat.parquet', file: 'not-a-file' },
        field: 'open.file',
      },
      // engine/schema
      {
        label: 'engine/schema missing tableId',
        type: 'engine/schema',
        payload: {},
        field: 'schema.tableId',
      },
      {
        label: 'engine/schema wrong-typed tableId',
        type: 'engine/schema',
        payload: { tableId: 1 },
        field: 'schema.tableId',
      },
      // engine/range
      {
        label: 'engine/range missing tableId',
        type: 'engine/range',
        payload: { startRow: 0, endRow: 5 },
        field: 'range.tableId',
      },
      {
        label: 'engine/range wrong-typed tableId',
        type: 'engine/range',
        payload: { tableId: 1, startRow: 0, endRow: 5 },
        field: 'range.tableId',
      },
      {
        label: 'engine/range missing startRow',
        type: 'engine/range',
        payload: { tableId: 't1', endRow: 5 },
        field: 'range.startRow',
      },
      {
        label: 'engine/range wrong-typed startRow',
        type: 'engine/range',
        payload: { tableId: 't1', startRow: '0', endRow: 5 },
        field: 'range.startRow',
      },
      {
        label: 'engine/range missing endRow',
        type: 'engine/range',
        payload: { tableId: 't1', startRow: 0 },
        field: 'range.endRow',
      },
      {
        label: 'engine/range wrong-typed endRow',
        type: 'engine/range',
        payload: { tableId: 't1', startRow: 0, endRow: '5' },
        field: 'range.endRow',
      },
      {
        label: 'engine/range malformed columns',
        type: 'engine/range',
        payload: { tableId: 't1', startRow: 0, endRow: 5, columns: [] },
        field: 'range.columns',
      },
      {
        label: 'engine/range malformed filters',
        type: 'engine/range',
        payload: { tableId: 't1', startRow: 0, endRow: 5, filters: 'x' },
        field: 'range.filters',
      },
      {
        label: 'engine/range malformed sort',
        type: 'engine/range',
        payload: { tableId: 't1', startRow: 0, endRow: 5, sort: [{ column: 'a' }] },
        field: 'range.sort',
      },
      // engine/row-count
      {
        label: 'engine/row-count missing tableId',
        type: 'engine/row-count',
        payload: {},
        field: 'row-count.tableId',
      },
      {
        label: 'engine/row-count wrong-typed tableId',
        type: 'engine/row-count',
        payload: { tableId: 1 },
        field: 'row-count.tableId',
      },
      {
        label: 'engine/row-count malformed filters',
        type: 'engine/row-count',
        payload: { tableId: 't1', filters: 7 },
        field: 'row-count.filters',
      },
      // engine/profile
      {
        label: 'engine/profile missing tableId',
        type: 'engine/profile',
        payload: {},
        field: 'profile.tableId',
      },
      {
        label: 'engine/profile wrong-typed tableId',
        type: 'engine/profile',
        payload: { tableId: 1 },
        field: 'profile.tableId',
      },
      // overlay group
      {
        label: 'engine/overlay-schema missing tableId',
        type: 'engine/overlay-schema',
        payload: { overlay },
        field: 'overlay-schema.tableId',
      },
      {
        label: 'engine/overlay-schema missing overlay',
        type: 'engine/overlay-schema',
        payload: { tableId: 't1' },
        field: 'overlay-schema.overlay',
      },
      {
        label: 'engine/overlay-schema malformed overlay',
        type: 'engine/overlay-schema',
        payload: { tableId: 't1', overlay: badOverlay },
        field: 'overlay-schema.overlay',
      },
      {
        label: 'engine/overlay-row-count missing overlay',
        type: 'engine/overlay-row-count',
        payload: { tableId: 't1' },
        field: 'overlay-row-count.overlay',
      },
      {
        label: 'engine/overlay-row-count malformed filters',
        type: 'engine/overlay-row-count',
        payload: { tableId: 't1', overlay, filters: 7 },
        field: 'overlay-row-count.filters',
      },
      {
        label: 'engine/overlay-range missing overlay',
        type: 'engine/overlay-range',
        payload: { tableId: 't1', startRow: 0, endRow: 5 },
        field: 'overlay-range.overlay',
      },
      {
        label: 'engine/overlay-range malformed columns',
        type: 'engine/overlay-range',
        payload: { tableId: 't1', overlay, startRow: 0, endRow: 5, columns: [] },
        field: 'overlay-range.columns',
      },
      {
        label: 'engine/overlay-range malformed sort',
        type: 'engine/overlay-range',
        payload: { tableId: 't1', overlay, startRow: 0, endRow: 5, sort: 'asc' },
        field: 'overlay-range.sort',
      },
      {
        label: 'engine/overlay-range malformed includeRowIds',
        type: 'engine/overlay-range',
        payload: { tableId: 't1', overlay, startRow: 0, endRow: 5, includeRowIds: 'yes' },
        field: 'overlay-range.includeRowIds',
      },
      {
        label: 'engine/overlay-range missing endRow',
        type: 'engine/overlay-range',
        payload: { tableId: 't1', overlay, startRow: 0 },
        field: 'overlay-range.endRow',
      },
      {
        label: 'engine/overlay-cast-check missing column',
        type: 'engine/overlay-cast-check',
        payload: { tableId: 't1', overlay, targetType: 'BIGINT' },
        field: 'overlay-cast-check.column',
      },
      {
        label: 'engine/overlay-cast-check malformed targetType',
        type: 'engine/overlay-cast-check',
        payload: { tableId: 't1', overlay, column: 'id', targetType: 'VARCHAR()' },
        field: 'overlay-cast-check.targetType',
      },
      {
        label: 'engine/export missing tableId',
        type: 'engine/export',
        payload: { format: 'csv' },
        field: 'export.tableId',
      },
      {
        label: 'engine/export missing format',
        type: 'engine/export',
        payload: { tableId: 't1' },
        field: 'export.format',
      },
      {
        label: 'engine/export wrong-typed format',
        type: 'engine/export',
        payload: { tableId: 't1', format: 'xlsx' },
        field: 'export.format',
      },
      {
        label: 'engine/export malformed overlay',
        type: 'engine/export',
        payload: { tableId: 't1', format: 'csv', overlay: badOverlay },
        field: 'export.overlay',
      },
      {
        label: 'engine/validate missing plan',
        type: 'engine/validate',
        payload: { tableId: 't1' },
        field: 'validate.plan',
      },
      {
        label: 'engine/validate malformed plan',
        type: 'engine/validate',
        payload: { tableId: 't1', plan: { planKind: 'wrong' } },
        field: 'validate.plan',
      },
      {
        label: 'engine/validate malformed overlay',
        type: 'engine/validate',
        payload: { tableId: 't1', plan: wirePlan(), overlay: badOverlay },
        field: 'validate.overlay',
      },
      {
        label: 'engine/diff-stage missing name',
        type: 'engine/diff-stage',
        payload: { file },
        field: 'diff-stage.name',
      },
      {
        label: 'engine/diff-stage wrong-typed file',
        type: 'engine/diff-stage',
        payload: { name: 'cmp.parquet', file: 'not-a-file' },
        field: 'diff-stage.file',
      },
      {
        label: 'engine/csv-preview missing name',
        type: 'engine/csv-preview',
        payload: { file },
        field: 'csv-preview.name',
      },
      {
        label: 'engine/csv-preview wrong-typed file',
        type: 'engine/csv-preview',
        payload: { name: 'cand.csv', file: 'not-a-file' },
        field: 'csv-preview.file',
      },
      {
        label: 'engine/csv-preview non-object options',
        type: 'engine/csv-preview',
        payload: { name: 'cand.csv', file, options: ['delim', ';'] },
        field: 'csv-preview.options',
      },
      {
        label: 'engine/csv-preview wrong-typed sampleRows',
        type: 'engine/csv-preview',
        payload: { name: 'cand.csv', file, sampleRows: 'all' },
        field: 'csv-preview.sampleRows',
      },
      {
        label: 'engine/open non-object options',
        type: 'engine/open',
        payload: { name: 'cand.csv', file, options: 'delim=;' },
        field: 'open.options',
      },
      {
        label: 'engine/diff missing comparisonId',
        type: 'engine/diff',
        payload: { tableId: 't1', plan: wireRowDiffPlan() },
        field: 'diff.comparisonId',
      },
      {
        label: 'engine/diff malformed plan',
        type: 'engine/diff',
        payload: { tableId: 't1', comparisonId: 'd1', plan: { planKind: 'wrong' } },
        field: 'diff.plan',
      },
      {
        label: 'engine/diff malformed overlay',
        type: 'engine/diff',
        payload: {
          tableId: 't1',
          comparisonId: 'd1',
          plan: wireRowDiffPlan(),
          overlay: badOverlay,
        },
        field: 'diff.overlay',
      },
      {
        label: 'engine/pipeline-source missing relation',
        type: 'engine/pipeline-source',
        payload: { name: 'customers.parquet', file },
        field: 'pipeline-source.relation',
      },
      {
        label: 'engine/pipeline-source wrong-typed file',
        type: 'engine/pipeline-source',
        payload: { relation: 'customers', name: 'customers.parquet', file: 'not-a-file' },
        field: 'pipeline-source.file',
      },
      {
        label: 'engine/pipeline-materialize missing relation',
        type: 'engine/pipeline-materialize',
        payload: { sql: 'SELECT 1 AS value' },
        field: 'pipeline-materialize.relation',
      },
      {
        label: 'engine/pipeline-materialize missing sql',
        type: 'engine/pipeline-materialize',
        payload: { relation: 'out' },
        field: 'pipeline-materialize.sql',
      },
      {
        label: 'engine/pipeline-handle missing relation',
        type: 'engine/pipeline-handle',
        payload: {},
        field: 'pipeline-handle.relation',
      },
      {
        label: 'engine/pipeline-execute missing materialization',
        type: 'engine/pipeline-execute',
        payload: { relation: 'out', sql: 'SELECT 1 AS value' },
        field: 'pipeline-execute.materialization',
      },
      {
        label: 'engine/pipeline-execute unknown materialization',
        type: 'engine/pipeline-execute',
        payload: { relation: 'out', materialization: 'publish', sql: 'SELECT 1 AS value' },
        field: 'pipeline-execute.materialization',
      },
      {
        label: 'engine/pipeline-execute missing sql',
        type: 'engine/pipeline-execute',
        payload: { relation: 'out', materialization: 'view' },
        field: 'pipeline-execute.sql',
      },
      {
        label: 'engine/pipeline-execute export missing path',
        type: 'engine/pipeline-execute',
        payload: { relation: 'out', materialization: 'export', sql: 'SELECT 1 AS value' },
        field: 'pipeline-execute.path',
      },
      {
        label: 'engine/pipeline-diff missing againstRelation',
        type: 'engine/pipeline-diff',
        payload: { inputRelation: 'a', plan: wireRowDiffPlan() },
        field: 'pipeline-diff.againstRelation',
      },
      {
        label: 'engine/pipeline-diff malformed plan',
        type: 'engine/pipeline-diff',
        payload: { inputRelation: 'a', againstRelation: 'b', plan: { planKind: 'wrong' } },
        field: 'pipeline-diff.plan',
      },
    ]

    it.each(cases)('$label', ({ type, payload, field }) => {
      const message = { type, requestId, ...payload }
      // The strict shape-only parser keeps its documented null contract...
      expect(parseEngineRequest(message)).toBeNull()
      // ...and the envelope recognises the request and answers it with the
      // request class plus the value-free field path (never a silent drop).
      expect(parseEngineRequestEnvelope(message)).toEqual({
        status: 'malformed',
        malformed: { requestId, requestType: type, field },
      })
    })

    it('lists exactly the 22 request types and covers every one', () => {
      expect(ENGINE_REQUEST_TYPES).toHaveLength(22)
      expect(new Set(ENGINE_REQUEST_TYPES).size).toBe(22)
      const covered = new Set(cases.map((entry) => entry.type))
      // init and dispose have no required fields (nothing can be malformed),
      // so every other request type must appear in the malformed matrix.
      for (const type of ENGINE_REQUEST_TYPES) {
        if (type === 'engine/init' || type === 'engine/dispose') continue
        expect(covered, `${type} must have a malformed-envelope case`).toContain(type)
      }
    })

    it('accepts engine/init and engine/dispose (no malformed dimension)', () => {
      for (const type of ['engine/init', 'engine/dispose'] as const) {
        expect(parseEngineRequestEnvelope({ type, requestId })).toEqual({
          status: 'request',
          request: { type, requestId },
        })
      }
    })

    it('accepts the p2-4 pipeline execute/diff requests (non-export + export)', () => {
      expect(
        parseEngineRequest({
          type: 'engine/pipeline-execute',
          requestId,
          relation: 'out',
          materialization: 'view',
          sql: 'SELECT 1 AS value',
        }),
      ).toEqual({
        type: 'engine/pipeline-execute',
        requestId,
        relation: 'out',
        materialization: 'view',
        sql: 'SELECT 1 AS value',
      })
      expect(
        parseEngineRequest({
          type: 'engine/pipeline-execute',
          requestId,
          relation: 'out',
          materialization: 'export',
          sql: 'SELECT 1 AS value',
          path: 'assay-exports/assay-pipeline-export-out.parquet',
        }),
      ).toEqual({
        type: 'engine/pipeline-execute',
        requestId,
        relation: 'out',
        materialization: 'export',
        sql: 'SELECT 1 AS value',
        path: 'assay-exports/assay-pipeline-export-out.parquet',
      })
      const plan = wireRowDiffPlan()
      expect(
        parseEngineRequest({
          type: 'engine/pipeline-diff',
          requestId,
          inputRelation: 'a',
          againstRelation: 'b',
          plan,
        }),
      ).toEqual({
        type: 'engine/pipeline-diff',
        requestId,
        inputRelation: 'a',
        againstRelation: 'b',
        plan,
      })
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
        outcome: 'row-samples',
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
      malformed: { requestId: 9, requestType: 'engine/validate', field: 'validate.plan' },
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
    // rejected at parse — the client rejects, it never hangs on it. The
    // rule is a row-samples rule, so the m5-4 refined bound is exactly the
    // old uniform one here.
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
    // m5-4 refinement: each rule's count is bounded by its OWN outcome.
    // A dataset-fact rule is a boolean fact (it holds or fails, never
    // "fails twice"), so a compiler-shaped fact reporting failCount 2 is
    // malformed even where the old uniform bound saw nothing wrong
    // (2 ≤ 120).
    expect(
      parseEngineResponse({
        ...base,
        result: {
          ...wireResult(),
          rules: [
            {
              ...wireResult().rules[0]!,
              ruleId: 'dataset.min-rows',
              outcome: 'dataset-fact',
              failCount: 2,
              sampleFailures: [],
            },
          ],
        },
      }),
    ).toBeNull()
    // …and the motivating defect is fixed at parse too: a dataset-fact
    // failCount 1 over an EMPTY dataset (1 > 0, refused by the m5-2 bound)
    // is the honest `min-rows ≥ 1` violation shape — ACCEPTED, verdict
    // invalid, no error. The outcome field is what names the bound.
    const factOverEmpty = {
      type: 'engine/validate-result',
      requestId: 9,
      result: {
        valid: false,
        rowCount: 0,
        rules: [
          {
            ruleId: 'dataset.min-rows',
            outcome: 'dataset-fact',
            failCount: 1,
            failPercent: 0,
            sampleFailures: [],
          },
        ],
      },
    }
    expect(parseEngineResponse(factOverEmpty)).toEqual(factOverEmpty)
    // The outcome is part of the shape: a missing or foreign vocabulary
    // spelling rejects (it is what selects the sanity bound).
    expect(
      parseEngineResponse({
        ...base,
        result: {
          ...wireResult(),
          rules: [{ ...wireResult().rules[0]!, outcome: 'rows' }],
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
              ruleId: 'columns[1].allowed-values',
              failCount: 0,
              failPercent: 0,
              sampleFailures: [],
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

// m6-2: engine/diff-stage + engine/diff protocol
// ─────────────────────────────────────────────────────────────────────────────

function wireRowDiffPlan(): EngineRowDiffPlan {
  const result = compileRowDiffPlan(
    [
      { name: 'id', type: 'BIGINT' },
      { name: 'val', type: 'VARCHAR' },
    ],
    [
      { name: 'id', type: 'BIGINT' },
      { name: 'val', type: 'VARCHAR' },
    ],
    ['id'],
    { relationA: 'ds_a', relationB: 'ds_b', sampleLimit: 3 },
  )
  if (!result.ok) throw new Error('wire row-diff plan failed to compile')
  return result.plan
}

function wireRowDiffResult(): EngineRowDiffResult {
  return {
    rowCountA: 4,
    rowCountB: 3,
    aspects: [
      { aspect: 'added', count: 1, samples: [{ side: 'B', rowKey: 'b:2' }] },
      { aspect: 'removed', count: 1, samples: [{ side: 'A', rowKey: 'base:v#1' }] },
      {
        aspect: 'changed',
        count: 1,
        samples: [{ side: 'A', rowKey: 'base:v#0', changedColumns: ['val'] }],
      },
    ],
  }
}

describe('m6-2: engine/diff-stage + engine/diff protocol', () => {
  it('parses a well-formed engine/diff-stage request', () => {
    const request = {
      type: 'engine/diff-stage',
      requestId: 5,
      name: 'comparison.parquet',
      file: new File([new Uint8Array([1])], 'comparison.parquet'),
    }
    expect(parseEngineRequest(request)).toEqual(request)
  })

  it('parses engine/diff with a compiler plan and optional overlay', () => {
    const base = {
      type: 'engine/diff',
      requestId: 6,
      tableId: 't1',
      comparisonId: 'd1',
      plan: wireRowDiffPlan(),
    }
    expect(parseEngineRequest(base)).toEqual(base)
    expect(
      parseEngineRequest({ ...base, overlay: { base: OVERLAY_BASE_MINIMAL(), ops: [] } }),
    ).not.toBeNull()
  })

  it('rejects engine/diff with a malformed plan, missing comparison, or bad overlay', () => {
    const base = { type: 'engine/diff', requestId: 6, tableId: 't1', comparisonId: 'd1' }
    expect(parseEngineRequest(base)).toBeNull()
    expect(
      parseEngineRequest({ ...base, plan: { ...wireRowDiffPlan(), planVersion: 2 } }),
    ).toBeNull()
    expect(parseEngineRequest({ ...base, plan: { ...wireRowDiffPlan(), keys: [] } })).toBeNull()
    expect(parseEngineRequest({ ...base, plan: wireRowDiffPlan(), comparisonId: 7 })).toBeNull()
    expect(
      parseEngineRequest({
        ...base,
        plan: wireRowDiffPlan(),
        overlay: { base: OVERLAY_BASE_MINIMAL(), ops: 'nope' },
      }),
    ).toBeNull()
  })

  it('recognises malformed diff-stage/diff requests for the typed envelope', () => {
    expect(
      parseEngineRequestEnvelope({ type: 'engine/diff-stage', requestId: 9, name: 'x' }),
    ).toEqual({
      status: 'malformed',
      malformed: { requestId: 9, requestType: 'engine/diff-stage', field: 'diff-stage.file' },
    })
    expect(
      parseEngineRequestEnvelope({ type: 'engine/diff', requestId: 10, tableId: 't1' }),
    ).toEqual({
      status: 'malformed',
      malformed: { requestId: 10, requestType: 'engine/diff', field: 'diff.comparisonId' },
    })
    expect(OVERLAY_REQUEST_TYPES).toContain('engine/diff-stage')
    expect(OVERLAY_REQUEST_TYPES).toContain('engine/diff')
  })

  it('parses diff-stage/diff result responses and rejects malformed ones', () => {
    expect(
      parseEngineResponse({
        type: 'engine/diff-stage-result',
        requestId: 5,
        comparisonId: 'd1',
        columns: [{ name: 'id', type: 'BIGINT' }],
      }),
    ).toEqual({
      type: 'engine/diff-stage-result',
      requestId: 5,
      comparisonId: 'd1',
      columns: [{ name: 'id', type: 'BIGINT' }],
    })
    expect(
      parseEngineResponse({
        type: 'engine/diff-stage-result',
        requestId: 5,
        comparisonId: 'd1',
        columns: 'nope',
      }),
    ).toBeNull()
    expect(
      parseEngineResponse({
        type: 'engine/diff-result',
        requestId: 6,
        result: wireRowDiffResult(),
      }),
    ).toEqual({ type: 'engine/diff-result', requestId: 6, result: wireRowDiffResult() })
    // A wrong aspect order is not compiler-shaped output.
    expect(
      parseEngineResponse({
        type: 'engine/diff-result',
        requestId: 6,
        result: {
          ...wireRowDiffResult(),
          aspects: [...wireRowDiffResult().aspects].reverse(),
        },
      }),
    ).toBeNull()
    // An empty B-side row key is malformed (the contract is a non-empty key).
    expect(
      parseEngineResponse({
        type: 'engine/diff-result',
        requestId: 6,
        result: {
          ...wireRowDiffResult(),
          aspects: [
            { aspect: 'added', count: 1, samples: [{ side: 'B', rowKey: '' }] },
            wireRowDiffResult().aspects[1]!,
            wireRowDiffResult().aspects[2]!,
          ],
        },
      }),
    ).toBeNull()
  })
})

// EW-03I: engine/csv-preview + options on engine/open protocol
// ─────────────────────────────────────────────────────────────────────────────

function wireSniff(): Record<string, unknown> {
  return {
    delimiter: ',',
    quote: '',
    escape: '',
    newLineDelimiter: '\n',
    comment: '',
    skipRows: 0,
    hasHeader: true,
    columns: [
      { name: 'id', type: 'VARCHAR' },
      { name: 'amount', type: 'DOUBLE' },
    ],
    dateFormat: null,
    timestampFormat: null,
    prompt: "FROM read_csv('preview_p1');",
  }
}

function wirePreviewResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'engine/csv-preview-result',
    requestId: 9,
    previewId: 'p1',
    sniff: wireSniff(),
    effectiveOptions: { delim: ';' },
    sample: { batchIpc: new Uint8Array([1, 2, 3]), hasMore: false, rowCap: 1000 },
    ...overrides,
  }
}

describe('EW-03I: engine/csv-preview + engine/open options protocol', () => {
  const requestId = 9
  const file = new File([new Uint8Array([1, 2, 3])], 'candidate.csv')

  describe('parseEngineRequest', () => {
    it('parses a well-formed engine/csv-preview request', () => {
      const request = { type: 'engine/csv-preview', requestId, name: 'candidate.csv', file }
      expect(parseEngineRequest(request)).toEqual(request)
    })

    it('parses engine/csv-preview with options and sampleRows', () => {
      const request = {
        type: 'engine/csv-preview',
        requestId,
        name: 'candidate.csv',
        file,
        options: { delim: ';', header: true },
        sampleRows: 25,
      }
      expect(parseEngineRequest(request)).toEqual(request)
    })

    it('parses engine/open with options (adoption of a reviewed set)', () => {
      const request = {
        type: 'engine/open',
        requestId,
        name: 'candidate.csv',
        file,
        options: { all_varchar: true },
      }
      expect(parseEngineRequest(request)).toEqual(request)
    })

    it('an engine/open WITHOUT options parses to the legacy shape (no options key)', () => {
      const parsed = parseEngineRequest({ type: 'engine/open', requestId, name: 'a.csv', file })
      expect(parsed).toEqual({ type: 'engine/open', requestId, name: 'a.csv', file })
      expect(parsed && 'options' in parsed).toBe(false)
    })
  })

  describe('parseEngineResponse — engine/csv-preview-result', () => {
    it('parses a well-formed preview result (sniff + effectiveOptions + sample)', () => {
      const response = wirePreviewResult()
      expect(parseEngineResponse(response)).toEqual(response)
    })

    it('parses a preview result with a null sample (the host asked for none)', () => {
      const response = wirePreviewResult({ sample: null })
      expect(parseEngineResponse(response)).toEqual(response)
    })

    it('accepts non-null dateFormat/timestampFormat/prompt evidence', () => {
      const sniff = { ...wireSniff(), dateFormat: '%Y-%m-%d', prompt: null }
      const response = wirePreviewResult({ sniff })
      expect(parseEngineResponse(response)).toMatchObject({
        sniff: { dateFormat: '%Y-%m-%d', prompt: null },
      })
    })

    it('accepts a fully-disclosed effective option set (scalar + columns)', () => {
      const response = wirePreviewResult({
        effectiveOptions: {
          header: true,
          delim: ';',
          columns: { v: 'VARCHAR' },
          all_varchar: false,
          skip: 2,
          sample_size: 100,
        },
      })
      expect(parseEngineResponse(response)).not.toBeNull()
    })

    it('rejects an empty or missing previewId', () => {
      expect(parseEngineResponse(wirePreviewResult({ previewId: '' }))).toBeNull()
      const withoutId = wirePreviewResult()
      delete (withoutId as Record<string, unknown>)['previewId']
      expect(parseEngineResponse(withoutId)).toBeNull()
    })

    it('rejects a sniff with a bad dialect shape, bad skipRows, or bad columns', () => {
      expect(
        parseEngineResponse(wirePreviewResult({ sniff: { ...wireSniff(), delimiter: 3 } })),
      ).toBeNull()
      expect(
        parseEngineResponse(wirePreviewResult({ sniff: { ...wireSniff(), skipRows: -1 } })),
      ).toBeNull()
      expect(
        parseEngineResponse(wirePreviewResult({ sniff: { ...wireSniff(), skipRows: 1.5 } })),
      ).toBeNull()
      expect(
        parseEngineResponse(wirePreviewResult({ sniff: { ...wireSniff(), hasHeader: 'yes' } })),
      ).toBeNull()
      expect(
        parseEngineResponse(
          wirePreviewResult({ sniff: { ...wireSniff(), columns: [{ name: 1, type: 2 }] } }),
        ),
      ).toBeNull()
      expect(
        parseEngineResponse(wirePreviewResult({ sniff: { ...wireSniff(), columns: 'many' } })),
      ).toBeNull()
    })

    it('rejects a sniff with missing disclosure fields', () => {
      const partial = wireSniff()
      delete (partial as Record<string, unknown>)['delimiter']
      expect(parseEngineResponse(wirePreviewResult({ sniff: partial }))).toBeNull()
      const noPrompt = wireSniff()
      delete (noPrompt as Record<string, unknown>)['prompt']
      expect(parseEngineResponse(wirePreviewResult({ sniff: noPrompt }))).toBeNull()
    })

    it('rejects a foreign key or wrong-typed value in the effective option set', () => {
      expect(
        parseEngineResponse(wirePreviewResult({ effectiveOptions: { ignore_errors: true } })),
      ).toBeNull()
      expect(
        parseEngineResponse(wirePreviewResult({ effectiveOptions: { header: 'yes' } })),
      ).toBeNull()
      expect(parseEngineResponse(wirePreviewResult({ effectiveOptions: { skip: 1.5 } }))).toBeNull()
      expect(
        parseEngineResponse(wirePreviewResult({ effectiveOptions: { columns: { v: 42 } } })),
      ).toBeNull()
      expect(parseEngineResponse(wirePreviewResult({ effectiveOptions: 'delim=;' }))).toBeNull()
    })

    it('rejects a malformed sample shape (bad bytes, cap, or hasMore)', () => {
      expect(
        parseEngineResponse(
          wirePreviewResult({ sample: { batchIpc: 'x', hasMore: false, rowCap: 5 } }),
        ),
      ).toBeNull()
      expect(
        parseEngineResponse(
          wirePreviewResult({
            sample: { batchIpc: new Uint8Array([1]), hasMore: 'no', rowCap: 5 },
          }),
        ),
      ).toBeNull()
      expect(
        parseEngineResponse(
          wirePreviewResult({
            sample: { batchIpc: new Uint8Array([1]), hasMore: false, rowCap: -1 },
          }),
        ),
      ).toBeNull()
      expect(parseEngineResponse(wirePreviewResult({ sample: {} }))).toBeNull()
    })

    it('rejects impossible sample caps: rowCap 0 or beyond the window clamp (EW-03I review fix)', () => {
      // rowCap 0 is impossible: sampleRows = 0 yields a null sample, and a
      // fetched sample's LIMIT is always ≥ 1.
      expect(
        parseEngineResponse(
          wirePreviewResult({
            sample: { batchIpc: new Uint8Array([1]), hasMore: false, rowCap: 0 },
          }),
        ),
      ).toBeNull()
      // The worker clamps to MAX_RANGE_ROWS — a cap beyond the clamp cannot
      // exist.
      expect(
        parseEngineResponse(
          wirePreviewResult({
            sample: { batchIpc: new Uint8Array([1]), hasMore: false, rowCap: MAX_RANGE_ROWS + 1 },
          }),
        ),
      ).toBeNull()
      // The clamp itself parses (boundary, not off-by-one).
      expect(
        parseEngineResponse(
          wirePreviewResult({
            sample: { batchIpc: new Uint8Array([1]), hasMore: false, rowCap: MAX_RANGE_ROWS },
          }),
        ),
      ).not.toBeNull()
    })

    it('rejects effective-option values outside their domains (EW-03I review fix)', () => {
      // sample_size outside the preview inference budget (and never negative —
      // -1 is refused at parse).
      expect(
        parseEngineResponse(wirePreviewResult({ effectiveOptions: { sample_size: -1 } })),
      ).toBeNull()
      expect(
        parseEngineResponse(
          wirePreviewResult({
            effectiveOptions: { sample_size: MAX_CSV_INFERENCE_SAMPLE_ROWS + 1 },
          }),
        ),
      ).toBeNull()
      // skip must be a non-negative safe integer.
      expect(parseEngineResponse(wirePreviewResult({ effectiveOptions: { skip: -3 } }))).toBeNull()
      // Declared types must pass the strict type-expression validator.
      expect(
        parseEngineResponse(
          wirePreviewResult({ effectiveOptions: { columns: { v: 'DECIMAL(1,2,3)' } } }),
        ),
      ).toBeNull()
      expect(
        parseEngineResponse(
          wirePreviewResult({
            effectiveOptions: { columns: { v: 'VARCHAR) AS "c" FROM (...) ); --' } },
          }),
        ),
      ).toBeNull()
      // Round-2 probes: a string option beyond the parse's 64-code-point cap
      // and an EMPTY declared-columns map are impossible payloads.
      expect(
        parseEngineResponse(
          wirePreviewResult({
            effectiveOptions: { delim: 'd'.repeat(MAX_CSV_OPTION_VALUE_CODE_POINTS + 1) },
          }),
        ),
      ).toBeNull()
      expect(
        parseEngineResponse(wirePreviewResult({ effectiveOptions: { columns: {} } })),
      ).toBeNull()
      // The declared-columns count cap mirrors the parse.
      const tooMany: Record<string, string> = {}
      for (let i = 0; i <= MAX_CSV_TYPE_COLUMNS; i += 1) tooMany[`c${i}`] = 'VARCHAR'
      expect(
        parseEngineResponse(wirePreviewResult({ effectiveOptions: { columns: tooMany } })),
      ).toBeNull()
      // The domain boundaries themselves parse.
      expect(
        parseEngineResponse(
          wirePreviewResult({
            effectiveOptions: {
              delim: 'd'.repeat(MAX_CSV_OPTION_VALUE_CODE_POINTS),
              skip: 0,
              sample_size: MAX_CSV_INFERENCE_SAMPLE_ROWS,
              columns: { v: 'VARCHAR' },
            },
          }),
        ),
      ).not.toBeNull()
    })
  })
})
