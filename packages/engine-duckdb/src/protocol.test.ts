import { describe, expect, it } from 'vitest'
import { MAX_RESULT_ROWS, parseEngineRequest, parseEngineResponse } from './protocol'

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

  describe('parseEngineResponse', () => {
    it('parses engine/ready with the duckdb version', () => {
      expect(
        parseEngineResponse({ type: 'engine/ready', requestId: 1, duckdbVersion: 'v1.32.0' }),
      ).toEqual({ type: 'engine/ready', requestId: 1, duckdbVersion: 'v1.32.0' })
    })

    it('rejects engine/ready without a string version', () => {
      expect(parseEngineResponse({ type: 'engine/ready', requestId: 1 })).toBeNull()
    })

    it('parses engine/query-result including scalar cells', () => {
      const message = {
        type: 'engine/query-result',
        requestId: 2,
        result: { columns: ['42'], rowCount: 1, rows: [[42]], truncated: false },
      }
      expect(parseEngineResponse(message)).toEqual(message)
    })

    it('accepts every documented scalar cell kind', () => {
      const cells = [null, true, 1, 10n, 'x']
      const message = {
        type: 'engine/query-result',
        requestId: 2,
        result: {
          columns: ['a', 'b', 'c', 'd', 'e'],
          rowCount: 1,
          rows: [cells],
          truncated: false,
        },
      }
      expect(parseEngineResponse(message)).toEqual(message)
    })

    it('rejects engine/query-result with a malformed result body', () => {
      const base = { type: 'engine/query-result', requestId: 2 }
      expect(parseEngineResponse({ ...base, result: null })).toBeNull()
      expect(
        parseEngineResponse({
          ...base,
          result: { columns: ['a'], rowCount: '1', rows: [], truncated: false },
        }),
      ).toBeNull()
      expect(
        parseEngineResponse({
          ...base,
          result: { columns: [1], rowCount: 1, rows: [], truncated: false },
        }),
      ).toBeNull()
      expect(
        parseEngineResponse({
          ...base,
          result: { columns: ['a'], rowCount: 1, rows: [['ok', {}]], truncated: false },
        }),
      ).toBeNull()
      expect(
        parseEngineResponse({
          ...base,
          result: { columns: ['a'], rowCount: 1, rows: [{ a: 1 }], truncated: false },
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

    it('rejects unknown responses', () => {
      expect(parseEngineResponse({ type: 'engine/progress', requestId: 1 })).toBeNull()
      expect(parseEngineResponse('engine/ready')).toBeNull()
    })
  })

  it('documents the scalar transport cap used to guard the main thread', () => {
    expect(MAX_RESULT_ROWS).toBeGreaterThan(0)
  })
})
