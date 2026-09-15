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

    it('rejects unknown responses', () => {
      expect(parseEngineResponse({ type: 'engine/progress', requestId: 1 })).toBeNull()
      expect(parseEngineResponse('engine/ready')).toBeNull()
    })
  })
})
